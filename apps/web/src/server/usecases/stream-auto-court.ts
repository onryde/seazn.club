import "server-only";
// server/usecases/stream-auto-court.ts — a court's automatic start and handover (spec seazn.club.capture
// docs/specs/2026-11-14-court-stream-design.md §5.3–§5.4; plan Task 8). A court code's beat (capture-court.ts) calls
// `maybeCourtAutoStart` on the CURRENT phone's beat. Which match to start is `courtFocus`'s `start` (Task 5, read by
// `courtFocusOf`); whether it is due is the SAME `autoStartVerdict` a fixture code's automatic start asks (stream-auto.ts),
// on the match's facts with its court Stream switch in place of `auto_stream`; the claim that makes "once" atomic is the
// same compare-and-set on `fixture_stream_settings`. The start goes through `startBroadcast` — the ONE start path — on the
// LINK's target (O9), with the court-link guard, cause `automatic`, attributed to the court code's issuer.
//
// START FIRST, THEN STOP (§5.4): the old match's session ends only once the new one exists (`endOtherCourtSessions`, Task 7,
// which ends only sessions OLDER than the new one). A YouTube-connection destination has no holder exclusivity, so the new
// start is never refused for the old one; and a refused start leaves the old match's tail running.
//
// R1 (§17.1): the V430/V431/V525 tables are FORCE RLS with no policy, so every read and write here is on the non-tenant `sql`.
import { sql } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { AUTO_START_RETRY_SECONDS, PHONE_SILENT_FLOOR_SECONDS, tunable } from "@/server/relay/config";
import { autoStartVerdict, type AutoStartRefusal, type PhoneMode } from "@/server/relay/domain/auto-stream";
import { isPresent } from "@/server/relay/domain/pairing";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { courtFocusOf, linkOpenAt, type ResolvedCourtCode } from "./court-stream-codes";
import { endOtherCourtSessions } from "./court-stream-sessions";
import { autoStartRefusalOf } from "./stream-auto";
import { startModeFor } from "./stream-codes";
import { startBroadcast, type SessionDeps } from "./stream-sessions";

export type CourtAutoStartResult =
  | { fired: true; sessionId: string; endedSids: string[] }
  | { fired: false; why: "not_due" | "claim_lost" | "already_running" | "link_closed" }
  | { fired: false; why: "refused"; refusal: AutoStartRefusal };

type StartFacts = {
  court_stream: boolean; auto_started_at: Date | null; auto_start_blocked_at: Date | null; auto_start_attempted_at: Date | null;
  fixture_status: string; open_session: boolean; any_ingest: boolean; last_beat_at: Date; answered_poll_seconds: number;
};

/** `maybeAutoStart`'s one-statement read for a court: the match's switch row (`court_stream`), its status, whether a session
 *  of the MATCH is open or ever received ingest, and the court pairing's own beat clock — the pairing joined through its
 *  code's `court_link_id`, so a pairing of another code reads nothing. */
async function startFactsOf(fixtureId: string, pairingId: string, linkId: string): Promise<StartFacts | null> {
  const [facts] = await sql<StartFacts[]>`
    select coalesce(st.court_stream, false) as court_stream, st.auto_started_at, st.auto_start_blocked_at, st.auto_start_attempted_at,
           f.status as fixture_status,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.state in ${sql([...ACTIVE_STATES])}) as open_session,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.first_ingest_at is not null) as any_ingest,
           p.last_beat_at, p.answered_poll_seconds
      from fixtures f
      join fixture_stream_pairings p on p.id = ${pairingId}
      join fixture_stream_codes c on c.id = p.code_id and c.court_link_id = ${linkId}
      left join fixture_stream_settings st on st.fixture_id = f.id
     where f.id = ${fixtureId}`;
  return facts ?? null;
}

/** The claim: `maybeAutoStart`'s compare-and-set with `court_stream` in place of `auto_stream` — once, not blocked, and
 *  outside the retry spacing — so two beats (or a beat and a sweep) cannot both go on. */
async function claimCourtStart(fixtureId: string, now: Date, retrySeconds: number): Promise<boolean> {
  const cutoff = new Date(now.getTime() - retrySeconds * 1000);
  const claimed = await sql<{ fixture_id: string }[]>`update fixture_stream_settings set auto_start_attempted_at = ${now}
     where fixture_id = ${fixtureId} and court_stream and auto_started_at is null and auto_start_blocked_at is null
       and (auto_start_attempted_at is null or auto_start_attempted_at <= ${cutoff})
    returning fixture_id`;
  return claimed.length > 0;
}

const setRefusal = (fixtureId: string, refusal: AutoStartRefusal | null) =>
  sql`update fixture_stream_settings set auto_start_refusal = ${refusal} where fixture_id = ${fixtureId}`;

/**
 * The court's automatic start, for the current court phone's beat. In order:
 *  1. the link is open: its code active (not finishing or ended), the link not withdrawn, `now` inside the day (`opens_at <= now`
 *     < the day's end; final review m-1: a code minted for a later day starts nothing today) —
 *     else `link_closed`, nothing read or claimed;
 *  2. the court's match to start (`courtFocus`'s `start`: a streamed in-play match with no session of its own, while the
 *     court is idle or its current session is due for handover) — none → `not_due`;
 *  3. that match's facts and `autoStartVerdict` with the arriving beat's `phoneMode` — not due → `not_due`;
 *  4. the claim (`claimCourtStart`) — lost → `claim_lost`;
 *  5. `startBroadcast` on the link's target with the court-link guard; on success every OLDER session of the court ends
 *     (`endOtherCourtSessions`). A refusal is stored on the match exactly as `maybeAutoStart` stores it, retried only
 *     after the spacing (R7), and ends NOTHING; `already_running` stores no code and clears the earlier one; an unmapped
 *     error clears it and is rethrown (the beat reports it and answers).
 */
export async function maybeCourtAutoStart(
  a: { court: ResolvedCourtCode; pairingId: string; phoneMode: PhoneMode },
  deps: SessionDeps, now: Date,
): Promise<CourtAutoStartResult> {
  const { court, pairingId, phoneMode } = a;
  const { link } = court;
  if (court.status !== "active" || link.withdrawnAt !== null || !linkOpenAt(link, now)) {
    return { fired: false, why: "link_closed" };
  }
  const { focus } = await courtFocusOf(link);
  const fixtureId = focus.start;
  if (fixtureId === null) return { fired: false, why: "not_due" };
  const facts = await startFactsOf(fixtureId, pairingId, link.id);
  if (facts === null) return { fired: false, why: "not_due" };
  const retrySeconds = tunable("AUTO_START_RETRY_SECONDS", AUTO_START_RETRY_SECONDS);
  const verdict = autoStartVerdict({
    autoStream: facts.court_stream,
    phoneMode,
    phonePresent: isPresent(
      { current: true, lastBeatAt: new Date(facts.last_beat_at), answeredPoll: facts.answered_poll_seconds },
      now, tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS),
    ),
    fixtureStatus: facts.fixture_status,
    openSession: facts.open_session,
    autoStartedAt: facts.auto_started_at,
    autoStartBlockedAt: facts.auto_start_blocked_at,
    anySessionHadIngest: facts.any_ingest,
    autoStartAttemptedAt: facts.auto_start_attempted_at,
  }, now, retrySeconds);
  if (!verdict.due) return { fired: false, why: "not_due" };
  if (!(await claimCourtStart(fixtureId, now, retrySeconds))) return { fired: false, why: "claim_lost" };

  let sessionId: string;
  try {
    ({ sessionId } = await startBroadcast(
      { userId: court.issuedBy, orgId: court.orgId, source: "auto", pairingId },
      fixtureId,
      {
        targetId: link.targetId, startCause: "automatic", phone: "present", autoStartedAt: now,
        mode: await startModeFor(sql, fixtureId), courtLinkId: link.id,
      },
      deps,
    ));
  } catch (err) {
    const mapped = autoStartRefusalOf(err);
    if (mapped === null) {
      await setRefusal(fixtureId, null).catch((clearErr) =>
        log.error({ err: String(clearErr), orgId: court.orgId, fixtureId }, "court auto start: clearing the earlier refusal failed — the original error is rethrown"));
      throw err;
    }
    if (mapped === "already_running") {
      await setRefusal(fixtureId, null);
      return { fired: false, why: "already_running" };
    }
    await setRefusal(fixtureId, mapped);
    log.info({ orgId: court.orgId, fixtureId, linkId: link.id, refusal: mapped }, "court auto start: refused — retried after the spacing; the court's open session runs on");
    return { fired: false, why: "refused", refusal: mapped };
  }
  let endedSids: string[] = [];
  try {
    endedSids = await endOtherCourtSessions({ linkId: link.id, keepSid: sessionId, actorUserId: court.issuedBy }, deps);
  } catch (err) {
    // The start has committed: the phone streams it. An older session left open is the next court start's, or the tick's.
    log.error({ err: String(err), sid: sessionId, orgId: court.orgId }, "court auto start: ending the court's other sessions failed — the start stands");
    captureError(err, { orgId: court.orgId, route: "capture.court.auto_end_others", extra: { sid: sessionId } });
  }
  return { fired: true, sessionId, endedSids };
}
