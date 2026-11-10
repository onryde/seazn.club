import "server-only";
// The phone-lost ends: the facts they judge on, the camera evidence, endIfPhoneLost (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import {
  PHONE_LOST_LIVE_MINUTES,
  PHONE_SILENT_FLOOR_SECONDS,
  RECONNECT_QUIET_SECONDS,
  tunable,
} from "@/server/relay/config";
import { isTerminal, type Command, type Session } from "@/server/relay/domain/session";
import { warmingTimedOut } from "@/server/relay/domain/expiry";
import {
  type Ask10Phone,
  cameraEvidenceMatters,
  composedCameraLost,
  composedCameraWatched,
  composedNeverLive,
  livePhoneLost,
  warmingPhoneLost,
} from "@/server/relay/domain/phone-lost";
import type { IngestState } from "@/server/relay/ports";
import { readFirstInput } from "@/server/relay/secret-columns";
import { CAMERA_LIVE_PHASE, PROGRAMME_PHASE_EVENT } from "@/server/relay/telemetry";
import { log } from "@/server/logger";
import { type Row, toSession, readRow, storedPhaseOf } from "./session-row";
import type { SessionDeps } from "./deps";
import { apply } from "./apply";
import { claimIngestPoll, reportIngestReadFailure } from "./ingest-poll";

/** The facts ask 10, W19 and m-5 judge, in ONE statement (one snapshot). The session's phone is its `pairing_id`
 *  (§6.5: a takeover moves it).
 *  - `has_phone` (C-1, controller ruling): the session HAS a phone at all. `pairing_id` is null for every session open
 *    when V430 deploys and for one whose fixture was deleted (T35: the pairings cascade, `on delete set null`). Such a
 *    session keeps TODAY's rules: the phone rules never judge it (`phoneLostEnd`).
 *  - `has_current`: that pairing has not ended. Its CODE's state is deliberately not read (C-2, controller ruling, spec
 *    C1b/C3): a Revoke & reissue ends the code, and the old code still serves the open session's phone until the
 *    session ends. The code-active filter belongs to NEW claims and the Go-live lookup (`currentPhoneOf`), never here.
 *  - `heard_go_live`: the phone has beaten since the session was created, so it is answered at an open session's
 *    cadence (§6.8.3).
 *  `exec` is apply's tx when re-taken under the row lock. */
type PhoneFacts = {
  first_ingest_at: Date | null; phone_beat_at: Date | null; has_phone: boolean; has_current: boolean; last_beat_at: Date | null;
  answered_poll_seconds: number | null; heard_go_live: boolean; last_connected_at: Date | null;
};
export async function phoneFactsOf(exec: Tx | typeof sql, sessionId: string): Promise<PhoneFacts | null> {
  const [f] = await exec<PhoneFacts[]>`
    select s.first_ingest_at, s.phone_beat_at, s.pairing_id is not null as has_phone, p.id is not null as has_current,
           p.last_beat_at, p.answered_poll_seconds,
           coalesce(p.id is not null and p.last_beat_at > s.created_at, false) as heard_go_live,
           (select max(x.sampled_at) from fixture_stream_samples x
             where x.session_id = s.id and x.source = 'poll' and x.ingest_state = 'connected') as last_connected_at
      from fixture_stream_sessions s
      left join fixture_stream_pairings p on p.id = s.pairing_id and p.ended_at is null
     where s.id = ${sessionId}`;
  return f ?? null;
}

/** T8b (§6.5, A14 conjunct 3): when a poll sample last read the input connected — null when none ever has. The beat's
 *  dead-phone takeover reads it on its own transaction (`exec`), through this module because only the samples' writers
 *  may name that table (enc-boundary claim 4). The same measure W19 judges on (`phoneFactsOf`). */
export async function lastConnectedSampleAt(exec: Tx | typeof sql, sessionId: string): Promise<Date | null> {
  const [r] = await exec<{ at: Date | null }[]>`
    select max(sampled_at) as at from fixture_stream_samples
     where session_id = ${sessionId} and source = 'poll' and ingest_state = 'connected'`;
  return r?.at ?? null;
}

/** Which phone-lost end, if any, a session owes now. `fresh` = this tick's fresh read (undefined: W19 cannot judge).
 *  - C-1 (controller ruling): a session with no phone (`has_phone` false) is judged by none of the rules below.
 *  - m-5 (controller ruling): a PASSTHROUGH session live with no first ingest recorded is judged by the warming rule —
 *    expire warming_timeout at warming_at + WARMING_TIMEOUT_MINUTES (`warmingTimedOut`, evaluate's own clock). Composed
 *    is excluded by name: a composed session never records first ingest (only the passthrough poll writes it), so the
 *    rule would end every composed broadcast at its warming deadline — and the domain refuses that cell anyway.
 *  - ask 10 (§6.8.3) and W19 (§6.8.5): the domain's own predicates, with the tunable timings (§6.15).
 *  - R2008: a COMPOSED live session is judged on `camera`, the compositor's own evidence (`cameraFactsOf`):
 *    - never live (owner ruling 2026-10-19): no camera ever appeared for PHONE_LOST_LIVE_MINUTES from go-live — an `expire`
 *      with `camera_never_live`, which fails the session and RETURNS its credit (the viewer never saw video). Reads nothing.
 *    - the camera lost after it was in: the composed W19 (`composedCameraLost`) with `fresh`, this tick's read of the camera's
 *      input (`readCameraWord`) — the same `stop phone_lost` as W19's: the organiser's copy, the credit (kept) and the
 *      reservation are the ones any composed end gets. */
function phoneLostEnd(s: Session, f: PhoneFacts, fresh: IngestState | undefined, now: Date, camera: CameraFacts | null = null): { command: Command; rule: "m-5" | "ask-10" | "w19" | "w19-composed" | "never-live-composed" } | null {
  if (isTerminal(s.state)) return null;
  if (!f.has_phone) return null;   // C-1: no phone, no phone rules — the session keeps today's expiry and runner ends
  if (s.mode === "passthrough" && s.state === "live" && f.first_ingest_at === null && warmingTimedOut(s, now)) {
    return { command: { type: "expire", expiry: { kind: "warming_timeout" } }, rule: "m-5" };
  }
  const silentFloor = tunable("PHONE_SILENT_FLOOR_SECONDS", PHONE_SILENT_FLOOR_SECONDS);
  if (warmingPhoneLost({ state: s.state, firstIngestAt: f.first_ingest_at, ...ask10PhoneOf(f) }, now, silentFloor)) {
    return { command: { type: "stop", reason: "phone_lost" }, rule: "ask-10" };
  }
  // m-3 (controller ruling): an `unknown` read — claimed or coalesced — never advances a phone-lost end. A Cloudflare
  // read blip must not end a paid broadcast as phone_lost; the next fresh word decides, and max_duration still bounds it.
  if (fresh !== undefined && fresh !== "unknown" && livePhoneLost({
    state: s.state, firstIngestAt: f.first_ingest_at, phoneBeatAt: f.phone_beat_at,
    freshReadConnected: fresh === "connected", lastConnectedSampleAt: f.last_connected_at,
  }, now, tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES))) return { command: { type: "stop", reason: "phone_lost" }, rule: "w19" };
  if (s.mode === "composed" && camera !== null && composedNeverLive({
    state: s.state, startedAt: s.startedAt, liveOnceAt: camera.live_once_at, waitedOnly: camera.waited_only, logBeganAt: camera.log_began_at,
  }, now, tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES))) return { command: { type: "expire", expiry: { kind: "camera_never_live" } }, rule: "never-live-composed" };
  if (s.mode === "composed" && camera !== null && fresh !== undefined && fresh !== "unknown" && composedCameraLost({
    state: s.state, phoneBeatAt: f.phone_beat_at, liveOnceAt: camera.live_once_at, reconnectingSince: camera.reconnecting_since,
    freshReadConnected: fresh === "connected",
  }, now, tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES))) return { command: { type: "stop", reason: "phone_lost" }, rule: "w19-composed" };
  return null;
}

/** R2008: what the compositor's beats say about the camera, from the `programme_phase` log (`logProgrammePhase`) — the
 *  composed stream's own evidence, as `first_ingest_at` and the connected samples are the passthrough stream's. One
 *  statement (one snapshot); `exec` is apply's tx when re-taken under the row lock, where it reads every beat stored before
 *  the lock was granted. Only called when a rule could fire (`cameraEvidenceMatters`).
 *  - `live_once_at`: the first beat, of any attempt, that reported `live` (null: the camera was never in).
 *  - `log_began_at`: the first phase row of any kind (null: the compositor never reported a phase).
 *  - `waited_only`: the log holds `waiting` and nothing else — no `live`, no `reconnecting`, no beat that reported none.
 *  - `reconnecting_since`: when the camera's OUTAGE began — the first row of the unbroken run of `reconnecting`/`waiting` rows
 *    that ends at the latest row (review I2: a compositor restarted during an outage opens on `waiting`, and the camera is
 *    exactly as gone). Null unless that latest row is a `reconnecting`/`waiting` of the CURRENT attempt: a run another
 *    attempt wrote last is another Machine's, and the current one has said nothing yet. A `live`, a `frozen` that followed a
 *    run, or a beat with no phase breaks the run — the camera came back, or the compositor stopped saying. */
export type CameraFacts = { live_once_at: Date | null; log_began_at: Date | null; waited_only: boolean; reconnecting_since: Date | null };
async function cameraFactsOf(exec: Tx | typeof sql, sessionId: string): Promise<CameraFacts> {
  const [f] = await exec<CameraFacts[]>`
    with ev as (
      select seq, to_state, attempt, occurred_at from fixture_stream_events
       where session_id = ${sessionId} and type = ${PROGRAMME_PHASE_EVENT}
    ), last as (
      select to_state, attempt from ev order by seq desc limit 1
    ), brk as (
      select coalesce(max(seq), 0) as seq from ev where to_state is distinct from 'reconnecting' and to_state is distinct from 'waiting'
    )
    select (select min(occurred_at) from ev where to_state = ${CAMERA_LIVE_PHASE}) as live_once_at,
           (select min(occurred_at) from ev) as log_began_at,
           coalesce((select bool_and(coalesce(to_state = 'waiting', false)) from ev), false) as waited_only,
           case when l.to_state in ('reconnecting', 'waiting') and l.attempt = s.runner_attempts
                then (select min(occurred_at) from ev where seq > (select seq from brk)) end as reconnecting_since
      from fixture_stream_sessions s left join last l on true
     where s.id = ${sessionId}`;
  return f ?? { live_once_at: null, log_began_at: null, waited_only: false, reconnecting_since: null };
}

/** R2008: the composed W19's third clause — one fresh read of the CAMERA's input (A; the programme, B, is the compositor's
 *  own output and says nothing of the phone). Made only once the camera is gone and the phone silent past the quiet hold
 *  (`composedCameraWatched` — where the organiser's countdown arms, which shows on this word), so a healthy stream costs no
 *  Cloudflare call, and through the same claim window as the organiser's passthrough poll (`claimIngestPoll`: a tick that
 *  does not hold the claim reads nothing and decides nothing — and shows no countdown).
 *  Undefined = no fresh word: no input row, no claim, a read that threw (reported once, N1) or one with no evidence. The
 *  read records no sample and no event and never writes first ingest — a composed session never has one. */
async function readCameraWord(row: Row, deps: SessionDeps): Promise<IngestState | undefined> {
  const input = (await sql.begin((tx) => readFirstInput(tx, row.id))) as Awaited<ReturnType<typeof readFirstInput>>;
  const inputId = input?.ingestInputId ?? null;
  if (!inputId) return undefined;
  if (!(await claimIngestPoll(row.id, deps.now()))) return undefined;
  try {
    return (await deps.drivers.ingest.inputStatus(inputId, { sessionId: row.id })).state ?? undefined;
  } catch (err) {
    reportIngestReadFailure(err, { sessionId: row.id, orgId: row.org_id, inputUid: inputId, site: "poll" });
    return undefined;
  }
}

/** Ask 10's phone, from the facts: ONE mapping for the tick's end and the W24 countdown, so the countdown names the
 *  deadline the tick judges. With no current pairing the cadence is never read (both answer before it). */
export function ask10PhoneOf(f: PhoneFacts): Ask10Phone {
  return {
    hasCurrentPairing: f.has_current, lastBeatAt: f.has_current ? f.last_beat_at : null,
    answeredPollSeconds: f.answered_poll_seconds ?? 0, heardGoLive: f.heard_go_live,
  };
}

/** Steps 5–6 of the tick. Judged first on an UNLOCKED read (the common answer is "nothing", and `apply` takes the org's
 *  money lock), then RE-TAKEN on the locked row inside `apply`: a beat, a Stop or another tick may have landed between
 *  the two, and the locked answer is the only one that may end a session (witnesses: "a tick racing a phone BEAT" and
 *  "two ticks AT ONCE"). A row that moved on answers null and nothing is written. */
export async function endIfPhoneLost(row: Row, fresh: IngestState | undefined, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<{ row: Row; camera: CameraFacts | null; cameraWord: IngestState | undefined }> {
  const facts = await phoneFactsOf(sql, row.id);
  if (!facts) return { row, camera: null, cameraWord: undefined };
  // R2008: a composed session with a phone is judged on the compositor's evidence — read ONLY when a rule could fire (a live
  // session whose latest phase is `waiting` or `reconnecting`: `cameraEvidenceMatters`, the one gate), so a healthy stream
  // costs neither the query nor a Cloudflare call. Its camera's input is read once the camera is gone and the phone silent
  // past the quiet hold (`composedCameraWatched`): the end's third clause, and the word the organiser's countdown shows on.
  let camera: CameraFacts | null = null;
  let cameraWord: IngestState | undefined;
  if (row.mode === "composed" && facts.has_phone && cameraEvidenceMatters({ state: row.state, storedPhase: storedPhaseOf(row) })) {
    camera = await cameraFactsOf(sql, row.id);
    if (composedCameraWatched({ state: row.state, phoneBeatAt: facts.phone_beat_at, liveOnceAt: camera.live_once_at, reconnectingSince: camera.reconnecting_since },
      deps.now(), RECONNECT_QUIET_SECONDS)) {
      cameraWord = await readCameraWord(row, deps);
      fresh = cameraWord;
    }
  }
  if (phoneLostEnd(toSession(row), facts, fresh, deps.now(), camera) === null) return { row, camera, cameraWord };
  let rule: string | null = null;
  await apply(row.id, async (s, tx) => {
    const locked = await phoneFactsOf(tx, s.id);
    const lockedCamera = s.mode === "composed" && camera !== null ? await cameraFactsOf(tx, s.id) : null;
    const end = locked ? phoneLostEnd(s, locked, fresh, deps.now(), lockedCamera) : null;
    rule = end?.rule ?? null;
    return end?.command ?? null;
  }, deps);
  const after = (await readRow(row.id)) ?? row;
  if (rule !== null && isTerminal(after.state)) log.info({ sid: row.id, orgId: row.org_id, cause, rule, state: after.state }, "stream session: ended by the tick");
  return { row: after, camera, cameraWord };
}
