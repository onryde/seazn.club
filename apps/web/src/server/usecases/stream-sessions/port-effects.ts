import "server-only";
// Port effects that never re-enter apply: recorded outcome, forced destroy, output release, phone-input off (see ./index.ts).
import { sql } from "@/lib/db";
import type { Session } from "@/server/relay/domain/session";
import { recordEvent } from "@/server/relay/telemetry";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { type Row, cols, toSession, lockRow, readRow } from "./session-row";
import type { SessionDeps } from "./deps";

/** Ruling 13: every port effect's OUTCOME is a row — ok/failed, latency, the
 *  provider's status/code when it threw one — written under a short row lock
 *  after the effect (effects run post-commit by design; their result is a
 *  fact about the world, not about the row). Never throws past the effect's
 *  own error. */
export async function recordEffect<T>(s: Session, type: string, source: "ingest" | "runner" | "output" | "domain" | "sweep", fn: () => Promise<T>, payload: Record<string, unknown> = {}): Promise<T> {
  const started = Date.now();
  const write = (result: "ok" | "failed", extra: Record<string, unknown>) =>
    sql.begin(async (tx) => {
      await lockRow(tx, s.id);
      await recordEvent(tx, { sessionId: s.id, orgId: s.orgId, source, kind: "effect", type, result, latencyMs: Date.now() - started,
        httpStatus: typeof extra.httpStatus === "number" ? extra.httpStatus : null, attempt: s.runner.attempt || null, payload: { ...payload, ...extra } });
    });
  try {
    const out = await fn();
    await write("ok", {});
    return out;
  } catch (err) {
    const e = err as { status?: number; code?: string; requestId?: string };
    await write("failed", { httpStatus: e.status ?? null, errorCode: e.code ?? null, requestId: e.requestId ?? null });
    throw err;
  }
}

/** A forced Machine destroy (both sites: the runner table's `force_destroy` effect, and a stale create's Machine). The
 *  PROVIDER call failing is recorded (recordEffect's `failed` row), REPORTED to Sentry and logged — and returned as
 *  `false`, never thrown at the reader (Task 11 review m5). The report is the alarm: a Machine whose destroy failed may
 *  still be running, billing and pushing to a public destination, and since m5 no route wrapper sees the error to report
 *  it (re-review N1). It names the session and the Machine — never the destination, its key or any URL.
 *
 *  Narrowed to the provider call (re-review N3): if the LEDGER write fails — recordEffect's own `write`, before or after
 *  the DELETE — nothing recorded the outcome, and that database fault is thrown on (the route wrapper reports it), carrying
 *  the provider's failure as its `cause` when the DELETE had failed first (r2-m1). Told apart by identity: only the exact
 *  error the provider call threw is caught here.
 *
 *  THIRD site, `sweep` (Task 12, A22(b)): the daily sweep's orphan pass destroys a listed Machine its session no longer
 *  owns through THIS helper — the retry owner of every forced destroy that failed at the other two sites — so its row is
 *  the same `force_destroy` effect (source `sweep`) and its failure the same alarm. The alarm names the LISTED Machine
 *  (`payload.machineName`) when the caller knows it: the row's own `runner.name` is a different attempt's there.
 *
 *  A FAILED destroy also CLEARS the session's `runner_gone_confirmed_at` (V422, A22(c)): that mark lets admission skip
 *  the provider for this session, and a Machine that survived a DELETE is exactly what admission must find again. */
type ForceDestroySite = "force_destroy" | "stale_create" | "sweep";

/** r2-m2 (Task 11 re-review): WHO retries a failed forced destroy, per site — the log line names the owner that really
 *  exists. A lost runner's teardown is re-issued by the table on its next stale beat, and a terminal session's orphan by
 *  the next admission on its fixture or destination (tearDownPriorMachines) and the daily sweep. A stale create's Machine
 *  is named by no row, so no cell ever re-issues it: the daily sweep's orphan pass (A22(b)) owns it. */
const DESTROY_RETRY_OWNER: Record<ForceDestroySite, string> = {
  force_destroy: "the runner table re-issues it while the session lives, then admission and the daily sweep",
  stale_create: "no row names this Machine, so the daily sweep's orphan pass retries it",
  sweep: "the next daily sweep retries it",
};

export async function forceDestroy(
  s: Session, machineId: string, site: ForceDestroySite, payload: Record<string, unknown>, deps: SessionDeps,
): Promise<boolean> {
  const provider: { failure?: unknown } = {};
  try {
    await recordEffect(s, "force_destroy", site === "sweep" ? "sweep" : "runner", async () => {
      try {
        return await deps.drivers.runner.destroy(machineId);
      } catch (err) {
        provider.failure = err;
        throw err;
      }
    }, payload);
    return true;
  } catch (err) {
    if (!("failure" in provider) || err !== provider.failure) {
      // The ledger failed, not the provider (N3): thrown on. r2-m1: when the DELETE had failed first, its error rides as
      // `cause`, so the wrapper's one report still says a Machine may be running — the alarm below is never reached.
      if ("failure" in provider && err instanceof Error) err.cause ??= provider.failure;
      throw err;
    }
    await sql`update fixture_stream_sessions set runner_gone_confirmed_at = null where id = ${s.id} and runner_gone_confirmed_at is not null`;
    const machineName = typeof payload.machineName === "string" ? payload.machineName : s.runner.name;
    const extra = { sessionId: s.id, machineId, machineName, attempt: s.runner.attempt, site };
    captureError(err, { orgId: s.orgId, route: "relay.force_destroy", extra });
    log.error({ ...extra, err: String(err) }, `stream session: forced Machine destroy failed — recorded and reported; ${DESTROY_RETRY_OWNER[site]}`);
    return false;
  }
}

/** C1 (lane C final review; orchestrator ruling): WHERE a passthrough output release runs. `decision` is the terminal
 *  decision's own `release_output` effect; `late_add` an output whose add returned after the session ended; `admission`
 *  and `sweep` are the two retry owners of a release that failed. */
type ReleaseSite = "decision" | "late_add" | "admission" | "sweep";

/** C1: takes a passthrough session's Cloudflare OUTPUT off its input — the one thing that stops the simulcast — and marks
 *  the row `output_released_at` (V423). Never the input: it carries the recording (C2). `true` when there is nothing left
 *  to release (no output was ever recorded, or it is already released) or the removal was confirmed (a 404 counts).
 *
 *  A failure NEVER throws (orchestrator ruling): the terminal transition that asked for it has committed and stays, and
 *  the reader whose Stop or poll ran it gets its answer, not a 500. It is recorded (the `release_output` effect row, like
 *  every port effect), REPORTED to Sentry — a broadcast that may still be running is an alarm, the forceDestroy precedent
 *  — and left unmarked, which is exactly what the two retry owners select: the next admission on the same fixture or
 *  destination (`releasePriorOutputs`) and the daily sweep. The alarm names the session and the output uid (not a
 *  secret, Dg) — never the destination, its key or any URL. */
export async function releaseOutput(sessionId: string, site: ReleaseSite, deps: SessionDeps): Promise<boolean> {
  const [row] = await sql<(Row & { output_released_at: string | null; ingest_input_uid: string | null })[]>`
    select ${cols()}, output_released_at, ingest_input_uid from fixture_stream_sessions where id = ${sessionId}`;
  if (!row || row.output_uid === null || row.output_released_at !== null) return true;
  const s = toSession(row);
  const outputUid = row.output_uid;
  const extra = { sessionId, outputUid, inputUid: row.ingest_input_uid, site };
  try {
    // An output recorded with no input is not a state any writer produces (both are written by the provision/add pair);
    // a guard, not an assumption — it is reported like any failed removal rather than silently marked released.
    const inputId = row.ingest_input_uid;
    if (!inputId) throw new Error("stream session: an output is recorded with no live input to remove it from");
    await recordEffect(s, "release_output", site === "sweep" ? "sweep" : "output", () => deps.drivers.ingest.removeOutput(inputId, outputUid, { sessionId }),
      { inputUid: inputId, outputUid, reason: site });
    await sql`update fixture_stream_sessions set output_released_at = coalesce(output_released_at, ${deps.now()}) where id = ${sessionId}`;
    return true;
  } catch (err) {
    captureError(err, { orgId: s.orgId, route: "relay.release_output", extra });
    log.error({ ...extra, err: String(err) }, "stream session: passthrough output release failed — the broadcast may still be running; recorded and reported; the next admission on this fixture or destination and the daily sweep retry it");
    return false;
  }
}

/** The session has ENDED: the phone's own inputs — EVERY `camera` input of the session (Input A, and any further camera slot) —
 *  are switched OFF, so Cloudflare rejects any further push. A phone left sending after a Stop, a failure or the live limit
 *  otherwise keeps a connection open to Cloudflare for nothing. Found by role from `fixture_stream_inputs` — never
 *  `ingest_input_uid`, which is the OUTPUT input (Input B, the compositor's programme, on a composed session), and never a
 *  `programme` row — and switched OFF, never deleted: the input carries the recording (C2). A session with no camera input
 *  at the provider (it ended before it was provisioned, or the retention sweep has reclaimed it) has nothing to disable and
 *  records nothing.
 *
 *  BEST EFFORT, and it NEVER throws (the `releaseOutput` precedent), not for a provider fault and not for a database one:
 *  the terminal transition that asked for it has committed and stays, so nothing here blocks or fails the Stop, or skips the
 *  effects after it (the Machine's teardown, the replay fill). Three faults, told apart, each reported once:
 *   - the PROVIDER refused (`relay.disable_phone_input`): the input may still accept a phone. Recorded as the effect row
 *     (`failed`) and the adapter's own provider-call row with the HTTP status and Cloudflare's code;
 *   - the LEDGER failed after the provider said yes (`relay.disable_phone_input_db`, stage `ledger`): the input IS off, only
 *     its effect row is missing — never reported as a failed disable (the N3 identity test of `forceDestroy`, without its
 *     rethrow: this effect must not fail the reader);
 *   - a READ failed before any call (`relay.disable_phone_input_db`, stage `read`): nothing was attempted.
 *  A provider fault whose own ledger row then also failed is still the provider alarm — the input may still be on.
 *  One camera failing does not stop the next. No retry owner: each input belongs to ONE session (`provisionSession` makes a
 *  fresh pair per session), so nothing starts on it again, and it is reclaimed with the session's recordings by the
 *  retention sweep.
 *
 *  Idempotent at the provider (a disable of a disabled or gone input is success), and the domain emits the effect once per
 *  session — on ENTERING a terminal state — so a second Stop of an ended session decides nothing and calls nothing.
 *  `true` when no input was left on by a provider fault (and none was missed by a read fault). */
export async function disablePhoneInput(sessionId: string, deps: SessionDeps): Promise<boolean> {
  let s: Session;
  let cameras: { uid: string; slot: number }[];
  try {
    const row = await readRow(sessionId);
    if (!row) return true;
    s = toSession(row);
    cameras = await sql<{ uid: string; slot: number }[]>`
      select ingest_input_id as uid, slot from fixture_stream_inputs
       where session_id = ${sessionId} and role = 'camera' and ingest_input_id is not null order by slot asc`;
  } catch (err) {
    captureError(err, { route: "relay.disable_phone_input_db", extra: { sessionId, stage: "read" } });
    log.error({ sessionId, err: String(err) }, "stream session: the phone's input was NOT disabled — the session's rows could not be read; reported");
    return false;
  }
  let allOff = true;
  for (const { uid, slot } of cameras) {
    const extra = { sessionId, inputUid: uid, slot };
    const provider: { failure?: unknown } = {};
    try {
      await recordEffect(s, "disable_phone_input", "ingest", async () => {
        try {
          return await deps.drivers.ingest.setInputEnabled(uid, false, { sessionId, slot, role: "camera" });
        } catch (err) {
          provider.failure = err;
          throw err;
        }
      }, { inputUid: uid, slot });
    } catch (err) {
      if ("failure" in provider) {
        allOff = false;
        captureError(provider.failure, { orgId: s.orgId, route: "relay.disable_phone_input", extra: err === provider.failure ? extra : { ...extra, ledger: "unwritten" } });
        log.error({ ...extra, err: String(provider.failure) }, "stream session: the phone's input was NOT disabled — the session has ended, a phone still pushing keeps its connection until the input is reclaimed; recorded and reported");
      } else {
        captureError(err, { orgId: s.orgId, route: "relay.disable_phone_input_db", extra: { ...extra, stage: "ledger" } });
        log.error({ ...extra, err: String(err) }, "stream session: the phone's input was disabled, but its ledger row could not be written; reported");
      }
    }
  }
  return allOff;
}

/** Task 12's orphan pass (A22(b)): destroy a Machine the provider LISTS under `sessionId` that its row does not own,
 *  through the shared forceDestroy above (site `sweep`) — recorded on that session's own ledger and alarmed on failure,
 *  never duplicated here. The row is read fresh for the ledger's attempt. `null` when the row no longer exists: a
 *  sessionless Machine has no ledger to write, and the caller destroys it directly. */
export async function destroyListedMachine(
  sessionId: string, machine: { runnerId: string; name: string | null }, deps: SessionDeps,
): Promise<boolean | null> {
  const row = await readRow(sessionId);
  if (!row) return null;
  return forceDestroy(toSession(row), machine.runnerId, "sweep", { machineId: machine.runnerId, machineName: machine.name, reason: "sweep" }, deps);
}
