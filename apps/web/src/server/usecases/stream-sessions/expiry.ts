import "server-only";
// The lazy expiry path: observe before expiring, applyExpiry, reconcileSession (see ./index.ts).
import { sql } from "@/lib/db";
import { isTerminal, type Session } from "@/server/relay/domain/session";
import { evaluate, type Expiry } from "@/server/relay/domain/expiry";
import { readFirstInput } from "@/server/relay/secret-columns";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { type Row, toSession, readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { apply } from "./apply";
import { latestPollSample, carriedIngest, reportIngestReadFailure, connectIfWarming } from "./ingest-poll";

/** I1 (lane C final review). A passthrough session leaves `warming` only when something OBSERVES its ingest connected —
 *  the organiser's poll in `currentSession`. That poll ran AFTER this expiry, and another court's create (targetHolderFor)
 *  and the daily backstop never observed at all, so a phone that connected at +1 min and was read by nobody was failed
 *  `no_inbound_timeout` at the timeout WHILE it streamed: no consume row, a false reason, the destination handed on. So
 *  before any expiry of a passthrough `warming` session, the ingest is read ONCE and a connected one goes live through
 *  the ordinary `ingest_connected` decision (which consumes the credit, or refuses it) — the expiry then finds nothing due.
 *
 *  Only when an expiry is DUE: a read with nothing to expire still asks no provider anything (G-T1's zero-call refusal).
 *  A session with no input row has nothing to observe and falls through to the expiry as before. Same input reader as
 *  the poll (one authority for which input a session has).
 *
 *  N1 (lane C re-review; orchestrator ruling): a read that THROWS — a 5xx, the network, a revoked token's 401 — is
 *  reported once and answered `true` ("the ingest is unknown"), never thrown: before N1 it escaped ahead of the expiry,
 *  so during an outage a warming session past its WALL CLOCK was never ended, kept its destination (V421), and every
 *  organiser poll and another court's start 500'd. What an unknown blocks is `heldByUnknownIngest`'s to say. */
async function observeIngestBeforeExpiry(sessionId: string, row: Row | null, deps: SessionDeps): Promise<boolean> {
  if (!row || row.mode !== "passthrough" || row.state !== "warming") return false;
  if (evaluate(toSession(row), deps.now()).kind === "none") return false;
  const input = (await sql.begin((tx) => readFirstInput(tx, sessionId))) as Awaited<ReturnType<typeof readFirstInput>>;
  const inputId = input?.ingestInputId ?? null;
  if (!inputId) return false;
  let status: Awaited<ReturnType<SessionDeps["drivers"]["ingest"]["inputStatus"]>>;
  try {
    status = await deps.drivers.ingest.inputStatus(inputId, { sessionId });
  } catch (err) {
    reportIngestReadFailure(err, { sessionId, orgId: row.org_id, inputUid: inputId, site: "expiry" });
    return true;
  }
  // G-a: a read with no evidence carries the previous poll's word. M-4 (final review; controller ruling): with NOTHING
  // to carry it reads as `unknown`, so the warming timeout runs normally. It was held like a failed read (N1), and since
  // a no-evidence read records nothing there was never anything to carry: a session whose every read said
  // `new_configuration_accepted` held its destination and fixture to the wall clock (5 h), not the 10-min warming window.
  const phone = status.state ?? carriedIngest(await latestPollSample(sessionId)) ?? "unknown";
  if (phone !== "connected") return false;
  await sql`update fixture_stream_sessions set first_ingest_at = coalesce(first_ingest_at, ${deps.now()}), ingest_protocol = coalesce(ingest_protocol, ${status.protocol}) where id = ${sessionId}`;
  await apply(sessionId, connectIfWarming, deps);
  return false;
}

/** N1: the ONE rule for what an unobservable ingest holds back — `warming_timeout` and nothing else. That expiry's claim
 *  is "no inbound video", which an unknown cannot support: the phone may be connected. `wall_clock` and every other
 *  expiry are claims about time or about the runner, true whatever the ingest is doing, so they still apply. */
function heldByUnknownIngest(expiry: Expiry, ingestUnknown: boolean): boolean {
  return ingestUnknown && expiry.kind === "warming_timeout";
}

/** One provider reading of a composed Machine, fed to the lifecycle table as the `observed` trigger — what `reconcileSession`
 *  does after the expiry and `observeRunnerBeforeGraceExpiry` does before a stop grace's. */
function applyObservation(sessionId: string, observed: Awaited<ReturnType<SessionDeps["drivers"]["runner"]["observe"]>>, deps: SessionDeps): Promise<Session | null> {
  return apply(sessionId, { type: "runner", trigger: { type: "observed", state: observed.state, exit: observed.exit, restarting: observed.restarting, restartingSince: observed.restartingSince,
    // R2003b: the exit's identity, the provider's restart count and the exit's own restart record — what the crash cap
    // counts an observed crash by
    exitAt: observed.exitAt, restartCount: observed.restartCount, exitRestarted: observed.exitRestarted } }, deps);
}

/** Measured on stg (2026-10-27, session 509ffe06): a stopped composed session's Machine exited 0 inside its grace and Fly
 *  destroyed it, but no read touched the session until the grace had run out. That read ran the expiry FIRST, so
 *  `grace_expired` force-destroyed a Machine that was already gone and the `observed` trigger that records "destroyed, exit 0"
 *  never ran — a clean stop read in the ledger exactly like a hang, and the teardown effects fired late. The table forces a
 *  destroy only "with no destroyed seen" (plan 2026-09-13 streaming-r1 §"Fly machine lifecycle"), so before a due
 *  `grace_expired` on a `stopping`/`exited` runner the Machine is read ONCE and fed to the table: a destroyed one completes
 *  the session through the ordinary observed path and the expiry then finds nothing due.
 *
 *  Only when that expiry is DUE: a read with nothing to expire asks the provider nothing extra. A read that THROWS is
 *  reported once (Sentry + a log line; the session, its Machine id and the attempt — never a URL or key) and the expiry runs
 *  as it always did — a provider outage must not leave a session in `ending`. */
async function observeRunnerBeforeGraceExpiry(sessionId: string, row: Row | null, deps: SessionDeps): Promise<void> {
  if (!row) return;
  const s = toSession(row);
  // `grace_expired` is only ever a COMPOSED stopping, exited or creating runner's, and a `creating` one holds no Machine id
  // yet (reconcileSession lists it by name) — so a runner with an id here is stopping or exited.
  const machineId = s.runner.machineId;
  if (!machineId || evaluate(s, deps.now()).kind !== "grace_expired") return;
  let observed: Awaited<ReturnType<SessionDeps["drivers"]["runner"]["observe"]>>;
  try {
    observed = await deps.drivers.runner.observe(machineId);
  } catch (err) {
    const extra = { sessionId, machineId, attempt: s.runner.attempt };
    captureError(err, { orgId: s.orgId, route: "relay.runner_observe_pre_grace", extra });
    log.warn({ ...extra, err: String(err) }, "stream session: the Machine could not be observed before its stop grace expired — reported; the expiry force-destroys it as before");
    return;
  }
  await applyObservation(sessionId, observed, deps);
}

/** The lazy expiry path (recommendation B). I1: a passthrough warming session's ingest is observed first; likewise a composed
 *  runner whose stop grace has run out has its Machine observed before the expiry may force-destroy it. */
export async function applyExpiry(sessionId: string, deps: SessionDeps): Promise<Session | null> {
  const row = await readRow(sessionId);                    // ONE read for both pre-observers (a passthrough warming row and a composed machine-holding row never overlap)
  const ingestUnknown = await observeIngestBeforeExpiry(sessionId, row, deps);
  await observeRunnerBeforeGraceExpiry(sessionId, row, deps);
  // `none` is the T5-a null command — write nothing, run nothing (post-2C-post plan sync). The committed domain REFUSES
  // `expire none` on a TERMINAL session (C27's negative pair: only `grace_expired` passes its guard), and `reconcileSession`
  // runs this on terminal rows by design — the sweep's backstop selects every terminal row whose runner is still alive, and
  // "the late create" reconciles a completed and a failed row. Handing `none` to those threw InvalidTransition out of the
  // reconcile and the whole daily sweep. On a non-terminal row `none` is `identity`, so dropping it moves nothing.
  return apply(sessionId, (s) => {
    const expiry = evaluate(s, deps.now());
    return expiry.kind === "none" || heldByUnknownIngest(expiry, ingestUnknown) ? null : { type: "expire", expiry };
  }, deps);
}

/** Expiry, then ONE observation of the Machine fed to the lifecycle table
 *  (plan §"Fly machine lifecycle" — the `observed` trigger). Every read,
 *  heartbeat, poll and admission calls this; the daily backstop too. */
export async function reconcileSession(sessionId: string, deps: SessionDeps): Promise<Session | null> {
  // M10 (Task 14b review): a deployment with NO relay (R5) cannot observe, expire on evidence, or stop anything through
  // a provider — every port of the disabled pair refuses. A session still up from before (the old fake default, or a
  // live deployment switched off) is ENDED, failed(relay_disabled), on the locked row; a terminal one is left alone.
  // Before this, a composed session's observation threw on every poll and the relay sweep skips a disabled deployment,
  // so nothing ever ended it. Money follows the domain's rules (session.ts `relay_disabled`).
  if (deps.drivers.disabled) return apply(sessionId, (s) => (isTerminal(s.state) ? null : { type: "relay_disabled" }), deps);
  const s = await applyExpiry(sessionId, deps);
  if (!s || s.mode !== "composed") return s;
  const r = s.runner;
  if (r.state === "none" || r.state === "destroyed") return s;
  // C27: a TERMINAL session whose runner is still creating/booting/playing/stopping/exited/lost
  // STILL owes one observation. `RUNNER_CLEANUP_TRIGGERS` are accepted on a terminal session — the
  // runner sub-machine advances, the session state does not. Skipping terminal rows here is what
  // left a FAILED session's Machine running until the daily orphan pass, i.e. up to 24 h of paid
  // compute for a session that ended minutes ago (and, on a stop-marked `creating` row, a Machine
  // nobody is holding the id of). The terminal guard belongs in `decide`, not in the caller.
  if (r.state === "creating") {
    // invariant 4: a process died mid-create → find OUR Machine and adopt it. T5-a: by NAME as well as session — an EARLIER
    // attempt's Machine is listed under the same session, and adopting it as this attempt's is the late cross-attempt adopt.
    const mine = (await deps.drivers.runner.list()).find((m) => m.sessionId === s.id && m.name === r.name);
    return mine ? apply(sessionId, { type: "runner", trigger: { type: "create_ok", machineId: mine.runnerId } }, deps) : s;
  }
  if (!r.machineId) return s;
  return applyObservation(sessionId, await deps.drivers.runner.observe(r.machineId), deps);
}
