import "server-only";
// Who advances a session: tickSession and the stream-tick pass over every open session (see ./index.ts).
import { sql } from "@/lib/db";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";
import { ACTIVE_STATES, isTerminal, type Session } from "@/server/relay/domain/session";
import type { IngestState, OutputState } from "@/server/relay/ports";
import { readFirstInput } from "@/server/relay/secret-columns";
import { recordEvent, recordSample } from "@/server/relay/telemetry";
import { log } from "@/server/logger";
import { toSession, lockRow, readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { apply } from "./apply";
import {
  latestPollSample,
  latestPollSampleWithSince,
  claimIngestPoll,
  COALESCED_SAMPLE_MAX_AGE_MS,
  sampledOutput,
  sampledProtocol,
  carriedIngest,
  reportIngestReadFailure,
  connectIfWarming,
} from "./ingest-poll";
import { reconcileSession } from "./expiry";
import { type CameraFacts, endIfPhoneLost } from "./phone-lost";
import { endIfAutoStopDue } from "./auto-stop";

/** T7 (§6.11): what one tick observed. currentSession builds its projection from this, so the projection stays
 *  byte-identical to the pre-extraction code (A10). The three observation fields are the block's own locals, moved
 *  verbatim; `coalescedSince`'s three states (Date, null, undefined = not served) all mean something. */
export type TickObservation = {
  session: Session | null;
  ingestState: StreamSessionCurrent["ingest"];
  outputObserved: OutputState | null;            // D3: what THIS poll read of the destination; null = read nothing
  coalescedSince: Date | null | undefined;       // I-1 (B0): a served sample's own since; undefined = not served
  /** T8b (§6.5, A14 conjunct 2): THIS tick's fresh read of the phone — the word W19 judges on (a claimed read's own
   *  word, or a coalesced sample younger than COALESCED_SAMPLE_MAX_AGE_MS); undefined = no fresh read. */
  freshIngest: IngestState | undefined;
  /** W24 (controller ruling 2026-10-04): THIS tick's STATUS read threw (N1). The warming timeout's own observation is
   *  held by exactly that (`heldByUnknownIngest`), so the warming countdown reads it. An outputs read that threw is not
   *  it: the timeout's observation never reads the outputs. A coalesced tick answers as the claimed read it defers to
   *  (`ingest_read_failed`, B7 re-review's outage gap). False when no read was made or deferred to (no input). */
  phoneReadFailed: boolean;
  /** R2008 (review I1): the compositor's evidence about a COMPOSED session's camera, as THIS tick judged it — null when no rule
   *  could fire (`cameraEvidenceMatters`: not composed, not live, or the latest phase is not an outage's or a wait's). The
   *  organiser's countdown is built from it, so it names the deadline the tick judges. For a composed session `freshIngest`
   *  is the CAMERA's input word (read once the camera is gone and the phone silent past the quiet hold), not a phone's. */
  camera: CameraFacts | null;
};

/** T7 (§6.11): who advances a session. The organiser poll's reconcile-and-ingest block, extracted so a phone beat and the
 *  stream-tick job (W22) advance a session nobody is watching. In order: 1. lazy expiry; 2. the coalesced ingest read
 *  (`claimIngestPoll`; the sample and its event in ONE tx, B0 R-1); 3. warming → live (the credit); 4. target_rejected;
 *  5. m-5, then ask 10 (§6.8.3); 6. W19 (§6.8.5); 7. the automatic stop after the result (§7.3) — LAST, so a phone-lost
 *  end that the same tick makes is the session's reason (the first reason wins). `cause` names the caller in the log line
 *  of an end it makes. */
export async function tickSession(sessionId: string, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<TickObservation> {
  let row = await readRow(sessionId);
  if (!row) return { session: null, ingestState: null, outputObserved: null, coalescedSince: undefined, freshIngest: undefined, phoneReadFailed: false, camera: null };

  if (!isTerminal(row.state)) await reconcileSession(row.id, deps);      // expiry + one Machine observation
  row = (await readRow(sessionId))!;

  // The server-side ingest poll (design §6.4): passthrough warming → live on
  // connected; a rejected destination fails it. The client never decides.
  let ingestState: StreamSessionCurrent["ingest"] = null;
  let outputObserved: OutputState | null = null;   // D3: what THIS poll read of the destination; null when it read nothing
  let coalescedSince: Date | null | undefined;      // I-1 (B0 fix round 1): a served sample's own since; undefined = not served
  // W19 (§6.8.5 clause 2): THIS tick's fresh read of the phone — a claimed read's own word, or (FP17) a coalesced sample
  // younger than COALESCED_SAMPLE_MAX_AGE_MS. Undefined = no fresh read to judge on (no input, a failed or no-evidence
  // read, an older sample): W19 skips this tick and never guesses.
  let freshIngest: IngestState | undefined;
  let phoneReadFailed = false;
  if (row.mode === "passthrough" && (row.state === "warming" || row.state === "live")) {
    const input = (await sql.begin((tx) => readFirstInput(tx, row!.id))) as Awaited<ReturnType<typeof readFirstInput>>;
    const inputId = input?.ingestInputId ?? null;
    // N1: a provider read that throws is reported once and the projection answers without it (`ingest: null`) — never a
    // 500 on every organiser poll through an outage. Nothing is decided on an unknown; the next poll reads again.
    let read: { status: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["inputStatus"]>>; output: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["outputState"]>> } | null = null;
    let coalesced = false;   // I-1: another poll claimed this interval's read
    if (inputId) {
      if (!(await claimIngestPoll(row.id, deps.now()))) coalesced = true;
      else {
        phoneReadFailed = true;   // until the status read answers
        try {
          const status = await deps.drivers.ingest.inputStatus(inputId, { sessionId: row.id });
          phoneReadFailed = false;
          read = { status, output: await deps.drivers.ingest.outputState(inputId, { sessionId: row.id }) };
        } catch (err) {
          reportIngestReadFailure(err, { sessionId: row.id, orgId: row.org_id, inputUid: inputId, site: "poll" });
        }
        // The outage gap (B7 re-review): whether this claimed STATUS read threw, for the polls that coalesce onto it.
        // Written only when it changes, so a healthy session's polls add no write.
        if (phoneReadFailed !== row.ingest_read_failed) {
          await sql`update fixture_stream_sessions set ingest_read_failed = ${phoneReadFailed} where id = ${row.id}`;
        }
      }
    }
    if (coalesced && row.ingest_read_failed) {
      // The outage gap (B7 re-review): the claimed read this poll defers to THREW. It answers as that read did, nothing
      // served and nothing fresh, so the warming countdown is held here exactly as on the claimer's own poll (N1).
      phoneReadFailed = true;
    } else if (coalesced) {
      // I-1: no provider call — the view is the latest poll sample's, when it is recent enough to be this interval's
      // reading. Nothing is recorded and nothing is decided: the poll that read decided on what it read. D3's `since`
      // is computed exactly as for a read (events, clamps, this response's clock), from the sampled word — and, B0 fix
      // round 1 (I-1), in the SAME statement as the sample (`latestPollSampleWithSince`): read apart, a reading poll's
      // commit could land between them and serve the old word timed by the new event.
      const sample = await latestPollSampleWithSince(row.id);
      if (sample && deps.now().getTime() - new Date(sample.sampled_at).getTime() < COALESCED_SAMPLE_MAX_AGE_MS) {
        const phone = carriedIngest(sample);
        ingestState = phone === null ? null : { state: phone, protocol: sampledProtocol(sample.protocol) };
        outputObserved = sampledOutput(sample.output_state);
        coalescedSince = sample.since;
        freshIngest = phone ?? undefined;
      }
    }
    if (read) {
      const { status, output } = read;
      // One read of the latest poll sample serves both the change check below and G-a's carry.
      const prev = output !== null || status.state === null ? await latestPollSample(row.id) : undefined;
      // G-a (controller ruling 2026-10-01): a read with NO evidence about video (`null`, ports.ts) carries the previous
      // poll's word forward — never `unknown`, which read as No signal, and never a hold on go-live. With nothing to
      // carry (no poll has read the phone yet) the phone is unseen on this poll: `ingest: null`, as for a failed read.
      const phone: IngestState | null = status.state ?? carriedIngest(prev);
      freshIngest = status.state ?? undefined;   // a no-evidence read (G-a) is not a fresh word: its carry decides nothing
      ingestState = phone === null ? null : { state: phone, protocol: status.protocol };
      outputObserved = output;
      // Ruling 13: the poll is a SAMPLE every time and an OBSERVED event only when the state word changed — for a poll
      // that READ. m-2 (B5 re-review 2): an outputs read that failed (`null`, ports.ts) is not evidence, so that poll
      // records neither; as `unknown` it was a non-ok word that moved the D3 hold toward the key box. The phone's read
      // still answers the projection and still drives warming → live below. G-a: a carried word is recorded as the
      // reading it carries (the raw status keeps the no-evidence read itself); an unseen phone records nothing.
      if (output !== null && phone !== null) {
        // R-1 (re-review): the sample and its event commit in ONE transaction. A coalesced poll serves the latest poll
        // sample's word and computes D3's `since` from these events; as two commits, a reader landing between them was
        // served the NEW word with no event behind it, `since` fell back to live_at, and the stream-key box flashed for
        // one poll. Both Cloudflare reads are already done above: this transaction holds a connection for the row lock
        // and the two inserts only, never across a provider call. Inside it the order is invisible to a reader; neither
        // half alone is safe to serve (an event without its sample moves `since` under the previous word), so they must
        // never be split — stream-sessions.test.ts "R-1" holds a poll mid-write and refuses each write in turn.
        const changed = !prev || prev.ingest_state !== phone || prev.output_state !== output;
        const sid = row.id, orgId = row.org_id;
        await sql.begin(async (tx) => {
          if (changed) {
            await lockRow(tx, sid);
            await recordEvent(tx, { sessionId: sid, orgId, source: "ingest", kind: "observed", type: "ingest_status", from: prev?.ingest_state ?? null, to: phone, occurredAt: deps.now(),
              payload: { protocol: status.protocol, outputState: output, connected: phone === "connected" } });
          }
          // Dh: `ingest_reason` is Cloudflare's own `status.current.reason`, verbatim (Task 4 exposes it
          // on the status read). It is the one field that says WHY an input is disconnected, so a poll
          // sample without it records that something was wrong and drops the only explanation.
          await recordSample(tx, { sessionId: sid, source: "poll", ingestState: phone, outputState: output,
            ingestReason: status.reason, sampledAt: deps.now(), raw: status });
        });
      }
      if (phone === "connected") {
        await sql`update fixture_stream_sessions set first_ingest_at = coalesce(first_ingest_at, ${deps.now()}), ingest_protocol = coalesce(ingest_protocol, ${status.protocol}) where id = ${row.id}`;
      }
      // m1 (lane C final review): both re-decided on the LOCKED row (T5-a) — a Stop or an expiry that landed after the
      // unlocked read above leaves a row these no longer apply to, and a plain apply of either was InvalidTransition, a 500.
      if (output === "rejected") await apply(row.id, (s) => (s.state === "warming" || s.state === "live" ? { type: "target_rejected" } : null), deps);
      else if (row.state === "warming" && phone === "connected") await apply(row.id, connectIfWarming, deps);
      row = (await readRow(sessionId))!;
    }
  }

  // 5–6: the phone-lost ends, judged on what this tick read and re-taken on the LOCKED row.
  let camera: CameraFacts | null = null;
  if (!isTerminal(row.state)) {
    const ended = await endIfPhoneLost(row, freshIngest, deps, cause);
    row = ended.row;
    camera = ended.camera;
    if (ended.cameraWord !== undefined) freshIngest = ended.cameraWord;   // a composed session's fresh word is its CAMERA's (R2008)
  }
  // 7: the automatic stop after the result (PR-2 T5, FP7: here once, so every caller of the tick reaches it). It returns an
  // ending or terminal row untouched on its own.
  row = await endIfAutoStopDue(row, deps, cause);
  return { session: toSession(row), ingestState, outputObserved, coalescedSince, freshIngest, phoneReadFailed, camera };
}

/** T7b (§6.11, W22): one stream-tick pass's answer. Written out LITERALLY, never inferred: the cron Worker reads
 *  `data.failed` as its failure counter (R3), and apps/cron-worker/test/drift.test.ts finds that field by reading this
 *  module's CODE (comments stripped) for its numeric declaration. `deferred` (the budget ran out) is NOT a failure: the
 *  next firing — a minute on in production, five on stg — reaches those sessions. */
export type StreamTickResult = { ticked: number; ended: number; failed: number; deferred: number };

/** T7b: the pass stops STARTING ticks once this much wall-clock time has gone (T15: the whole tick's figure — the route gives the
 *  session pass this minus what the YouTube end step spent). The cron Worker abandons a job at 60 s
 *  (JOB_TIMEOUT_MS, apps/cron-worker/src/call.ts) and records a timeout; stopping here leaves the tick in flight 15 s to
 *  finish, so an overrun usually reads `deferred` instead. stream-tick/route.test.ts pins it below the Worker's figure.
 *  RESIDUAL (B5 review m-2), a flat figure because no derived one exists: one tick's worst case is unbounded — a Fly
 *  observation can take ~43.5 s across its attempts (config.ts), and the Cloudflare calls set no request timeout
 *  (ingest-cf.ts) — so a tick started just inside the budget can still outlive the Worker's 60 s. That reads as a Worker
 *  timeout (status error, one Sentry event an hour under R2), never as silence, and the next firing ticks the rest. */
export const STREAM_TICK_BUDGET_MS = 45_000;

/** T7b (§6.11, W22): the stream-tick job's pass — `tickSession` on every OPEN session (ACTIVE_STATES, the one definition
 *  `openStreamStates` and the sweep use), across every org, oldest first, so a phone that dies with no panel open is still
 *  ended (ask 10, W19, m-5) within one firing. Each session is ticked inside its own try/catch: a throw adds 1 to `failed`
 *  and is logged, and never stops the next. A terminal result adds 1 to `ended` — "open when selected, terminal after its
 *  tick", so with two firings overlapping both may count one end; the END itself happens once (the locked re-check).
 *  Sessions not started before the wall-clock budget are counted in `deferred`.
 *  `budgetMs` (YouTube Connect T15) is that budget, `STREAM_TICK_BUDGET_MS` unless given: the cron route runs the YouTube end
 *  step FIRST and hands the pass what is left of the tick's 45 s. It must be a finite number of at least 0 (anything else is
 *  refused by name — a NaN would make the comparison below never true, i.e. no budget at all); 0 defers every open session.
 *  TEST-ONLY options: `orgIds` scopes the selection (an empty list is refused — `org_id in ()` silently read as "no
 *  filter" would tick every org) and `wallClock` scripts the budget's clock. The cron route passes neither. */
export async function tickOpenSessions(
  deps: SessionDeps,
  opts: { orgIds?: readonly string[]; wallClock?: () => number; budgetMs?: number } = {},
): Promise<StreamTickResult> {
  const orgIds = opts.orgIds === undefined ? undefined : [...opts.orgIds];
  if (orgIds !== undefined && orgIds.length === 0) {
    throw new Error("stream tick: orgIds is empty — omit it to tick every organisation, or name at least one");
  }
  const budgetMs = opts.budgetMs ?? STREAM_TICK_BUDGET_MS;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error(`stream tick: budgetMs must be a finite number of milliseconds, 0 or more, got ${budgetMs}`);
  }
  const wallClock = opts.wallClock ?? Date.now;
  const started = wallClock();
  const open = await sql<{ id: string }[]>`
    select id from fixture_stream_sessions
     where state in ${sql([...ACTIVE_STATES])} ${orgIds ? sql`and org_id in ${sql(orgIds)}` : sql``}
     order by created_at, id`;
  const out: StreamTickResult = { ticked: 0, ended: 0, failed: 0, deferred: 0 };
  for (let i = 0; i < open.length; i++) {
    if (wallClock() - started >= budgetMs) {
      out.deferred = open.length - i;
      break;
    }
    const sid = open[i]!.id;
    try {
      const t = await tickSession(sid, deps, "sweep");
      out.ticked++;
      if (t.session && isTerminal(t.session.state)) out.ended++;
    } catch (err) {
      // Logged, not reported to Sentry per session: the Worker raises the job's one event from `failed` (R3), throttled
      // to one an hour (R2); an event per session per firing would be twelve an hour for one stuck row.
      out.failed++;
      log.error({ sid, err: err instanceof Error ? err.message : String(err) }, "stream tick: a session's tick threw");
    }
  }
  log.info({ ...out, open: open.length, scoped: orgIds !== undefined }, "stream tick");
  return out;
}
