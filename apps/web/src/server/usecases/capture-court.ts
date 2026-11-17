import "server-only";
// Court stream, the phone's calls on a COURT code (spec seazn.club.capture docs/specs/2026-11-14-court-stream-design.md
// §5.3–§5.4, §6.1; plan Task 7): the descriptor (`getCourtCode`), the beat (`postCourtBeat`), the volunteer's start
// (`postCourtStart`, Automatic off) and the claim gate for builds without court support (`courtClaimRefusal`, O13).
// capture-phone.ts resolves the code and hands a court's here; a court's beat runs the SAME beat (`runBeat`) on the
// court link's sessions, so the claim, storage, stops, tick and answer rows are a fixture code's own.
//
// What a court code answers, and about which match (`courtFocusOf`, Task 6):
//  - the shape follows the court's CURRENT session only (its link's newest ACTIVE session, whichever match): the session
//    shape while it is warming, live or ending; otherwise the waiting shape. Never completed or failed: the phone learns a
//    match's end from the beat's `over`, and its next read is the next match;
//  - the waiting fields describe the current session's match while one is open, else the match to start or the next one
//    (`focusFixtureId`), else the court itself (its name, no stage, no scheduled start);
//  - `court: {name}` on every descriptor, and `next` on every beat answer while a streamed match waits.
// The destination is always the LINK's (O9), and `autoAllowed` is always true: on a court the organiser's Stream switch is
// the decision (§5.3), and the phone's own Automatic switch is the other half (A4).
//
// Every read is on the non-tenant `sql` (the V430/V525 tables are FORCE RLS with no policy); the org is the code row's. The
// tok is never logged, and `cred` goes only to the current session's own phone, as on a fixture code.
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DEVICE_LINK_MINT_LIMIT, rateLimit } from "@/lib/rate-limit";
import { CaptureRefusalError, codeEnded } from "@/server/api-v1/capture-http";
import { CAPTURE_COURT_NAME_MAX, CaptureScoringLinkOk, type CaptureCourt, type CaptureNext, type CaptureStartBody, type CaptureStartedBy, type CaptureStartOk } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { courtMinAppVersion, POLL_FAR_SECONDS, POLL_NEAR_SECONDS } from "@/server/relay/config";
import { deferred } from "@/lib/deferred";
import type { CourtFocus, CourtMatchFacts } from "@/server/relay/domain/court-stream";
import { ACTIVE_STATES, isActive, type SessionState } from "@/server/relay/domain/session";
import {
  alreadyLive, captureCommon, captureOrigin, DEST_MAX, fitText, holderOf, HTTPS_ORIGIN, isForeignKeyViolation, LABEL_MAX, latestSession,
  phoneStartRefusal, runBeat, sessionDescriptor, waitingFieldsOf,
  type Beat, type BeatAnswer, type BeatScope, type CaptureCommon, type Descriptor, type Exec, type LatestSession, type NamedRow,
  type OpenRow,
} from "./capture-phone";
import { provideDeviceLinkForPhone, type HolderVerifiedCode, type PhoneScoringLink } from "./device-links";
import { captureStageOf } from "./capture-stage";
import { asFixtureCode, courtFocusOf, linkOpenAt, matchLabelOf, type ResolvedCourtCode } from "./court-stream-codes";
import { endOtherCourtSessions } from "./court-stream-sessions";
import { claimCourtAutoStart } from "./stream-auto-court";
import { markAutoStartBlocked, startModeFor } from "./stream-codes";
import { startBroadcast, type SessionDeps } from "./stream-sessions";
import { COURT_STREAM_OFF } from "./stream-sessions/start";

type CourtView = { facts: CourtMatchFacts[]; focus: CourtFocus };
export type CourtCommon = CaptureCommon & { court: CaptureCourt; next: CaptureNext | null };

// ---------------------------------------------------------------------------------------------------------------------
// O13 — builds without court support never pair to a court
// ---------------------------------------------------------------------------------------------------------------------

/** The build count of an `appVersion` (`1.0.14-1200` → 1200, capture AGENTS.md §11), or null when it carries none. */
const buildCountOf = (v: string): number | null => {
  const m = /-(\d+)$/.exec(v.trim());
  return m ? Number(m[1]) : null;
};

/**
 * O13 (owner, 2026-11-15): a court code's claim (`new` or `resume`) from a build older than `COURT_MIN_APP_VERSION` is
 * refused exactly as an unknown code is — `404 not_a_stream_code`, which every shipped build shows as "Not valid for
 * streaming" — so an old phone never pairs to a court and then unpairs it with its Stop. Builds compare by the `-<count>`
 * suffix only. With no minimum configured (unset or malformed), or a build that carries no count, nothing can prove court
 * support, so the claim is refused (fail closed); `linkCourtStream` refuses to mint a court QR in that state anyway.
 */
export function courtClaimRefusal(appVersion: string): CaptureRefusalError | null {
  const min = courtMinAppVersion();
  const need = min === null ? null : buildCountOf(min);
  const have = buildCountOf(appVersion);
  if (need !== null && have !== null && have >= need) return null;
  return new CaptureRefusalError(404, "not_a_stream_code", "not a stream code");
}

// ---------------------------------------------------------------------------------------------------------------------
// The court's sessions and common fields
// ---------------------------------------------------------------------------------------------------------------------

/** The court's current session: its link's newest ACTIVE session, whichever match (`courtFocus`'s `current`). */
async function courtOpenSession(exec: Exec, linkId: string): Promise<OpenRow | null> {
  const [row] = await exec<OpenRow[]>`
    select id, state, first_ingest_at, start_cause, pairing_id from fixture_stream_sessions
     where court_link_id = ${linkId} and state in ${sql([...ACTIVE_STATES])}
     order by created_at desc, id desc limit 1`;
  return row ?? null;
}

/** One session, as the descriptor reads it (capture-phone's `latestSession` columns), its pairing's phone while current. */
async function sessionById(sid: string): Promise<(LatestSession & { fixture_id: string }) | null> {
  const [row] = await sql<(LatestSession & { fixture_id: string })[]>`
    select s.id, s.fixture_id, s.state, s.end_reason, s.fail_reason, s.theme_id, s.warming_at, s.created_at, s.max_duration_minutes,
           p.phone, p.slot as phone_slot
      from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id and p.ended_at is null
     where s.id = ${sid}`;
  return row ?? null;
}

/**
 * Web batch A1 (2026-11-17): while the court's link is live — not withdrawn, and its day open now — the court phone never
 * beats slower than the near cadence, whatever its match: the court's automatic start is decided on a beat, so a slower beat
 * is a later start (a 60 s idle cadence made starts take up to two minutes). A withdrawn link, or one outside its day, keeps
 * the fixture's rules. The 5 s rows (a session requested or provisioning, a start just claimed) stay 5 s.
 */
const courtLinkLive = (court: ResolvedCourtCode, now: Date): boolean => court.link.withdrawnAt === null && linkOpenAt(court.link, now);
const courtCadence = (court: ResolvedCourtCode, now: Date, seconds: number): number =>
  courtLinkLive(court, now) ? Math.min(seconds, POLL_NEAR_SECONDS) : seconds;

/** The match the court's waiting fields describe: the current session's while one is open, else start ?? next. */
const subjectOf = (focus: CourtFocus): string | null => focus.current?.fixtureId ?? focus.focusFixtureId;

/**
 * The court's waiting fields (§6.4 on a court code). With a subject match, that match's `captureCommon` with the LINK's
 * destination and `autoAllowed: true`; with none, the idle court: its name as the label, its link's zone, no scheduled
 * start, no overlay, the far cadence. Either way capped at the near cadence while the link is live (`courtCadence`).
 * `court` is the court's name; `next` the next streamed match not yet started.
 */
export async function courtCommon(
  court: ResolvedCourtCode, code: string, view: CourtView, s: { open: SessionState | null; themeId: string | null },
  deps: SessionDeps, now: Date,
): Promise<CourtCommon> {
  const [link] = await sql<{ tz: string; target_label: string }[]>`
    select l.tz, t.label as target_label from court_stream_links l join org_stream_targets t on t.id = l.target_id
     where l.id = ${court.link.id}`;
  // The code row cascades with its link, so a resolved court code has one.
  if (!link) throw new RangeError(`courtCommon: court link ${court.link.id} is gone`);
  const destinationName = fitText(link.target_label, DEST_MAX);
  const subject = subjectOf(view.focus);
  const origin = captureOrigin(deps);
  const subjectCommon = subject === null ? null : await captureCommon({ orgId: court.orgId, fixtureId: subject, code }, s, deps, now);
  const base: CaptureCommon = subjectCommon !== null
    ? { ...subjectCommon, pollSeconds: courtCadence(court, now, subjectCommon.pollSeconds), autoAllowed: true, destinationName }
    : {
        code, label: fitText(court.link.courtName, LABEL_MAX), venueTimezone: link.tz, scheduledStart: null,
        pollSeconds: courtCadence(court, now, POLL_FAR_SECONDS), autoAllowed: true, destinationName, overlayUrl: null, scoreUpdates: "polled",
        heartbeatUrl: `${origin}/api/v1/capture/codes/${code}/beats`, startUrl: `${origin}/api/v1/capture/codes/${code}/start`,
      };
  return { ...base, court: { name: fitText(court.link.courtName, CAPTURE_COURT_NAME_MAX) }, next: await nextOf(court, view) };
}

async function nextOf(court: ResolvedCourtCode, view: CourtView): Promise<CaptureNext | null> {
  const id = view.focus.nextFixtureId;
  if (id === null) return null;
  const at = view.facts.find((f) => f.fixtureId === id)?.scheduledAt ?? null;
  return { label: await matchLabelOf(court.orgId, id), scheduledStart: at === null ? null : Math.floor(new Date(at).getTime() / 1000) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `GET /capture/codes/{code}` on a court code. The court's CURRENT session decides the shape: warming, live or ending → the
 * session shape (with `cred` only to that session's own phone, as on a fixture code); anything else — no open session, or
 * one still requested or provisioning — the waiting shape on the subject match (with its `stage`), or the idle court (no
 * `stage`). Never completed or failed. Without a `phone`, always the waiting shape.
 */
export async function getCourtCode(
  court: ResolvedCourtCode, code: string, q: { slot: number; phone: string | null }, deps: SessionDeps, now: Date,
): Promise<Descriptor> {
  const view = await courtFocusOf(court.link);
  const current = view.focus.current === null ? null : await sessionById(view.focus.current.sid);
  const subject = subjectOf(view.focus);
  const themeId = current?.theme_id ?? (subject === null ? null : (await latestSession(subject))?.theme_id ?? null);
  const common = await courtCommon(court, code, view, { open: current !== null && isActive(current.state) ? current.state : null, themeId }, deps, now);
  const stage = subject === null ? null : await captureStageOf(court.orgId, subject);
  const sessionShape = q.phone !== null && current !== null
    && (current.state === "warming" || current.state === "live" || current.state === "ending");
  if (!sessionShape) return { state: "waiting", ...waitingFieldsOf(common, stage, common.court) };
  return sessionDescriptor(asFixtureCode(court, current.fixture_id), current, q, common, stage, deps, now, common.court);
}

// ---------------------------------------------------------------------------------------------------------------------
// The beat
// ---------------------------------------------------------------------------------------------------------------------

/** A court code's beat scope: the link's sessions, the court phone's Stop latch, the court's automatic start and handover
 *  (`claimCourtAutoStart`, Task 8), and the court's answer fields.
 *  Web batch A2 (2026-11-17): the beat CLAIMS the start on its own path and hands the start itself (YouTube, Cloudflare,
 *  Fly) to `deferred`, answering `waiting` with `starting`; the phone's next beat, 5 s later, finds the session. A beat that
 *  awaited the start timed out on the phone (8 s) and the start then waited for the next beat. The claim keeps a second beat
 *  arriving while the start runs from starting again. A refusal is stored by the start as before; an unmapped error is
 *  reported as the beat reported it. */
function courtBeatScope(court: ResolvedCourtCode, code: string, deps: SessionDeps, now: Date): BeatScope {
  return {
    orgId: court.orgId, codeId: court.codeId, issuedBy: court.issuedBy,
    openSession: (exec) => courtOpenSession(exec, court.link.id),
    namedSession: async (exec, sid) => (await exec<NamedRow[]>`
      select id, state, pairing_id, fixture_id, end_reason, fail_reason from fixture_stream_sessions
       where id = ${sid} and court_link_id = ${court.link.id}`)[0] ?? null,
    // §5.4 "Phone Stop hold": the match the court phone stopped is latched, in the beat's own transaction, so the court
    // never offers its sid again (the phone refuses it) and the desk restarts it by hand.
    onStopApplied: (tx: Tx, x: NamedRow) => markAutoStartBlocked(court.orgId, x.fixture_id, now, court.issuedBy, tx),
    autoStart: async (pairingId, phoneMode) => {
      const check = await claimCourtAutoStart({ court, pairingId, phoneMode }, deps, now);
      // Fix round 1 (finding 8): a start claimed by an earlier beat and still running answers `starting` too.
      if (!check.claimed) return { starting: check.inFlight };
      deferred(async () => {
        try {
          await check.run();
        } catch (err) {
          log.error({ err: String(err), orgId: court.orgId, fixtureId: check.fixtureId }, "capture court beat: the deferred auto start failed");
          captureError(err, { orgId: court.orgId, route: "capture.beat.auto_start", extra: { fixtureId: check.fixtureId } });
        }
      });
      return { starting: true };
    },
    claimPollSeconds: courtCadence(court, now, POLL_FAR_SECONDS),
    // §5.4: the beat naming the match the court just moved on from is handed to the new, armed session.
    handsOver: true,
    answerCommon: async (open) => {
      // Read AFTER step 6, so a start the beat made is the answer's subject.
      const view = await courtFocusOf(court.link);
      const subject = subjectOf(view.focus);
      const latest = subject === null ? null : await latestSession(subject);
      return courtCommon(court, code, view, { open: open?.state ?? null, themeId: latest?.theme_id ?? null }, deps, now);
    },
  };
}

/** `POST /capture/codes/{code}/beats` on a court code: O13's claim gate, then the beat on the court's scope. */
export async function postCourtBeat(court: ResolvedCourtCode, body: Beat, deps: SessionDeps, now: Date): Promise<BeatAnswer> {
  if (body.claim !== null) {
    const refused = courtClaimRefusal(body.appVersion);
    if (refused !== null) {
      log.info({ codeId: court.codeId, appVersion: body.appVersion }, "capture court: a claim from a build without court support was refused (O13)");
      throw refused;
    }
  }
  return runBeat(courtBeatScope(court, body.code, deps, now), body, deps, now);
}

// ---------------------------------------------------------------------------------------------------------------------
// The volunteer's start (Automatic off)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `POST /capture/codes/{code}/start` on a court code: the current phone starts the court's in-play streamed match, never a
 * match not yet started (§5.4). In order: the holder check (409 `replaced`); a court session already open → 409
 * `already_live` naming it; the link's day not open now → 409 `no_match`; no match to start → 409 `no_match`; else `startBroadcast` on the LINK's target with the court
 * link guard, then every other session of the link ends (`endOtherCourtSessions`). Refusals map as a fixture code's start.
 */
export async function postCourtStart(court: ResolvedCourtCode, body: CaptureStartBody, deps: SessionDeps): Promise<CaptureStartOk> {
  const open = await courtOpenSession(sql, court.link.id);
  const current = await holderOf(sql, court.codeId, open);
  if (!current || current.phone !== body.phone) throw new CaptureRefusalError(409, "replaced", "this phone is not the slot's current phone");
  if (open) throw alreadyLive(open);
  // Final review m-1: a code for a later day (or one past its day) has no match to stream today — the existing `no_match`, the
  // contract being pinned. Read before the focus, so a closed window costs no match read.
  if (!linkOpenAt(court.link, deps.now())) throw new CaptureRefusalError(409, "no_match", "this court's day is not open");
  const { focus } = await courtFocusOf(court.link);
  if (focus.start === null) throw new CaptureRefusalError(409, "no_match", "this court has no match in play to stream");
  const fixtureId = focus.start;
  const mode = await startModeFor(sql, fixtureId);
  let sessionId: string;
  try {
    ({ sessionId } = await startBroadcast(
      { userId: court.issuedBy, orgId: court.orgId, source: "phone", pairingId: current.id },
      fixtureId,
      { targetId: court.link.targetId, startCause: "operator", phone: "present", mode, courtLinkId: court.link.id },
      deps,
    ));
  } catch (err) {
    // O17 fix round 1: the match was switched off while this start was prepared — the court has nothing to start.
    if (err instanceof HttpError && err.code === COURT_STREAM_OFF) throw new CaptureRefusalError(409, "no_match", "this match's Stream switch was turned off");
    const mapped = phoneStartRefusal(err);
    if (mapped === null) throw err;
    if (mapped instanceof CaptureRefusalError) throw mapped;
    const [named] = mapped.alreadyLive === null ? [] : await sql<{ id: string; start_cause: CaptureStartedBy }[]>`
      select id, start_cause from fixture_stream_sessions where id = ${mapped.alreadyLive}`;
    const running = named ?? await courtOpenSession(sql, court.link.id);
    if (running) throw alreadyLive(running);
    throw new CaptureRefusalError(503, "unavailable", "a session was running and has just ended; try again");
  }
  try {
    await endOtherCourtSessions({ linkId: court.link.id, keepSid: sessionId, actorUserId: court.issuedBy }, deps);
  } catch (err) {
    // The start has committed: the phone streams it. An older session left open is the next start's, or the tick's.
    log.error({ err: String(err), sid: sessionId, orgId: court.orgId }, "capture court: ending the court's other sessions failed — the start stands");
    captureError(err, { orgId: court.orgId, route: "capture.court.end_others", extra: { sid: sessionId } });
  }
  return { sid: sessionId };
}

// ---------------------------------------------------------------------------------------------------------------------
// The scoring link (§5.6)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `POST /capture/codes/{code}/scoring-link` on a court code: the link of the court's NEXT unstarted match in queue order,
 * streamed or not (O10), with that match's label. In order: the holder check (409 `replaced`, the court's session or
 * pairing); no match queued → 409 `no_match`; a non-https origin → 503; only then the console's mint budget (so a refusal
 * never spends it); then the fixture code's own `provideDeviceLinkForPhone` on that match, never revoking. The secret is
 * a credential: never logged, never in an error.
 */
export async function postCourtScoringLink(
  court: ResolvedCourtCode, body: CaptureStartBody, deps: SessionDeps, now: Date, clientIp: string,
): Promise<CaptureScoringLinkOk> {
  void now;
  const open = await courtOpenSession(sql, court.link.id);
  const current = await holderOf(sql, court.codeId, open);
  if (!current || current.phone !== body.phone) throw new CaptureRefusalError(409, "replaced", "this phone is not the slot's current phone");
  const { focus } = await courtFocusOf(court.link);
  const fixtureId = focus.scoringFixtureId;
  if (fixtureId === null) throw new CaptureRefusalError(409, "no_match", "this court has no match to score");
  const origin = captureOrigin(deps);
  if (!HTTPS_ORIGIN.test(origin)) {
    log.error({ codeId: court.codeId, origin }, "capture court scoring link: the server's origin is not https; no link is served");
    throw new CaptureRefusalError(503, "unavailable", "scoring links need https, and this server's origin is not https (origin_not_https)");
  }
  await rateLimit(`dlmint:${clientIp}`, DEVICE_LINK_MINT_LIMIT);
  const checked = asFixtureCode(court, fixtureId) as HolderVerifiedCode; // the holder check above is this code's
  let got: PhoneScoringLink;
  try {
    got = await provideDeviceLinkForPhone(checked);
  } catch (err) {
    if (err instanceof HttpError && err.code === "DEVICE_LINK_KEK_MISSING") {
      throw new CaptureRefusalError(503, "unavailable", "scoring links are not configured on this server");
    }
    if (isForeignKeyViolation(err)) {
      log.warn({ codeId: court.codeId }, "capture court scoring link: the link insert broke a foreign key (the code's issuer is gone); answered code_ended");
      throw codeEnded();
    }
    throw err;
  }
  // The match finished between the read and the lock: the same "no match" the queue gives, nothing written.
  if (got.kind === "finished") throw new CaptureRefusalError(409, "no_match", `the match is ${got.status}; this court has no match to score`);
  const answer = CaptureScoringLinkOk.safeParse({ url: `${origin}/score/${got.secret}`, label: await matchLabelOf(court.orgId, fixtureId) });
  if (!answer.success) throw new Error("postCourtScoringLink: the scoring link does not match the contract's url pattern");
  return answer.data;
}
