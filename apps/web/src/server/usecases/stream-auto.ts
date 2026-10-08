import "server-only";
// server/usecases/stream-auto.ts — automatic start (capture QR v2 PR-2, spec §7.2; W7, A4, A12, A16). `postBeat` calls
// `maybeAutoStart` on the CURRENT phone's beat; the decision is `autoStartVerdict` (domain/auto-stream.ts), this file reads
// its facts, takes the claim that makes "once" atomic, and starts through `startBroadcast` — the ONE start path — with cause
// `automatic` and the pairing's own stream-code issuer as the actor. It never goes through `createSession`: that writes the
// organiser's destination pick (`target_chosen`), and an automatic start must neither set nor clear it (plan R-1).
//
// R1 (§17.1): the V430/V431 tables are FORCE RLS with no policy, so every read and write here is on the non-tenant `sql`.
import { sql } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { DESTINATION_NOT_ALLOWED, TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { log } from "@/server/logger";
import { AUTO_START_RETRY_SECONDS, PHONE_SILENT_FLOOR_SECONDS, tunable } from "@/server/relay/config";
import { autoStartVerdict, type AutoStartRefusal, type PhoneMode } from "@/server/relay/domain/auto-stream";
import { isPresent } from "@/server/relay/domain/pairing";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { fixtureStreamTarget } from "./stream-codes";
import { startBroadcast, type SessionDeps } from "./stream-sessions";

export type AutoStartResult =
  | { fired: false; why: "not_due" | "claim_lost" | "already_running" }
  | { fired: true; sessionId: string }
  | { fired: false; why: "refused"; refusal: AutoStartRefusal };

/**
 * `startBroadcast`'s refusals → the code `auto_start_refusal` stores (§7.2). The phone's own start maps the same errors
 * (`phoneStartRefusal`, §6.7.2) to ITS wire words; this column keeps the spec's, so a destination held by another match is
 * `destination_in_use` here and `no_destination` on the phone. `"already_running"` is a session that opened first (an
 * organiser's Go live racing the beat): not a refusal, nothing is stored. `null` is a bug — the caller rethrows it.
 */
export function autoStartRefusalOf(err: unknown): AutoStartRefusal | "already_running" | null {
  if (err instanceof PaymentRequiredError) return "not_entitled";
  if (!(err instanceof HttpError)) return null;
  switch (err.code) {
    case "overlay_required": return "not_entitled";
    case "no_credits": return "no_credit";
    case "target_in_use": return "destination_in_use";
    case DESTINATION_NOT_ALLOWED:
    case TARGET_UNREADABLE: return "no_destination";
    case "storage_exhausted":
    case "ingest_unavailable": return "unavailable";
    case "active_session": return "already_running";
    // An assumption made a guard: an automatic start passes phonePresent: true because the arriving beat IS the current
    // phone's, so W5 cannot answer it. Refused by name, never mapped to a refusal the panel would show.
    case "phone_not_paired":
      throw new Error("maybeAutoStart: startBroadcast answered phone_not_paired to an automatic start, which passes phonePresent: true");
  }
  // admit's target_not_found (the destination vanished between the read and the row lock) has no code.
  if (err.status === 404 && err.code === undefined && err.message === "stream target not found") return "no_destination";
  return null;
}

type Facts = {
  auto_stream: boolean; auto_started_at: Date | null; auto_start_blocked_at: Date | null; auto_start_attempted_at: Date | null;
  fixture_status: string; open_session: boolean; any_ingest: boolean;
  last_beat_at: Date; answered_poll_seconds: number; issued_by: string;
};

/**
 * Starts the match's broadcast when `autoStartDue` holds for the phone whose beat just arrived. In order:
 *  1. ONE statement reads the facts: the switch row (a fixture with no row is not due), the fixture's status, whether a
 *     session is open or ever received ingest, and the pairing's own beat clock and its code's issuer;
 *  2. the verdict (`autoStartVerdict`) — the arriving beat's `phoneMode` is read, never a stored one;
 *  3. the CLAIM: `auto_start_attempted_at` is stamped by a compare-and-set that repeats the once / not-blocked / retry
 *     conditions, so two beats, or a beat and a sweep, cannot both go on — the loser is `claim_lost`;
 *  4. `startBroadcast` on the fixture's resolved destination, attributed to the pairing's code issuer (the guard in
 *     `startBroadcast` refuses anyone else);
 *  5. success stamps `auto_started_at` / `auto_start_session_id` and clears the refusal; a mapped refusal stores its code and
 *     NEVER `auto_started_at` (it is retried after AUTO_START_RETRY_SECONDS); `already_running` writes nothing; anything
 *     unmapped rethrows (the beat reports it and answers regardless — the claim already spaces the retry).
 */
export async function maybeAutoStart(
  a: { orgId: string; fixtureId: string; pairingId: string; phoneMode: PhoneMode },
  deps: SessionDeps, now: Date,
): Promise<AutoStartResult> {
  const [facts] = await sql<Facts[]>`
    select coalesce(st.auto_stream, false) as auto_stream, st.auto_started_at, st.auto_start_blocked_at, st.auto_start_attempted_at,
           f.status as fixture_status,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.state in ${sql([...ACTIVE_STATES])}) as open_session,
           exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.first_ingest_at is not null) as any_ingest,
           p.last_beat_at, p.answered_poll_seconds, c.issued_by
      from fixtures f
      join fixture_stream_pairings p on p.id = ${a.pairingId}
      join fixture_stream_codes c on c.id = p.code_id and c.fixture_id = f.id
      left join fixture_stream_settings st on st.fixture_id = f.id
     where f.id = ${a.fixtureId}`;
  if (!facts) return { fired: false, why: "not_due" };
  const retrySeconds = tunable("AUTO_START_RETRY_SECONDS", AUTO_START_RETRY_SECONDS);
  const verdict = autoStartVerdict({
    autoStream: facts.auto_stream,
    phoneMode: a.phoneMode,
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

  const cutoff = new Date(now.getTime() - retrySeconds * 1000);
  const claimed = await sql<{ fixture_id: string }[]>`update fixture_stream_settings set auto_start_attempted_at = ${now}
     where fixture_id = ${a.fixtureId} and auto_stream and auto_started_at is null and auto_start_blocked_at is null
       and (auto_start_attempted_at is null or auto_start_attempted_at <= ${cutoff})
    returning fixture_id`;
  if (claimed.length === 0) return { fired: false, why: "claim_lost" };

  const refuse = async (refusal: AutoStartRefusal): Promise<AutoStartResult> => {
    await sql`update fixture_stream_settings set auto_start_refusal = ${refusal} where fixture_id = ${a.fixtureId}`;
    log.info({ orgId: a.orgId, fixtureId: a.fixtureId, refusal }, "capture auto start: refused — retried after the spacing");
    return { fired: false, why: "refused", refusal };
  };
  const pick = await fixtureStreamTarget(sql, { orgId: a.orgId, fixtureId: a.fixtureId });
  if (pick === null) return refuse("no_destination");
  try {
    const { sessionId } = await startBroadcast(
      { userId: facts.issued_by, orgId: a.orgId, source: "auto", pairingId: a.pairingId },
      a.fixtureId,
      { targetId: pick.id, startCause: "automatic", phonePresent: true },
      deps,
    );
    await sql`update fixture_stream_settings set auto_started_at = ${now}, auto_start_session_id = ${sessionId}, auto_start_refusal = null
               where fixture_id = ${a.fixtureId}`;
    return { fired: true, sessionId };
  } catch (err) {
    const mapped = autoStartRefusalOf(err);
    if (mapped === null) throw err;
    if (mapped === "already_running") return { fired: false, why: "already_running" };
    return refuse(mapped);
  }
}
