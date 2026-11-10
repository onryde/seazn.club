import "server-only";
// THE seam: apply (lock, decide, persist, consume) and the post-commit effects it feeds back into (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { RUNNER_DEFAULT_GUEST, RUNNER_DEFAULT_REGION, relayEnvironment } from "@/server/relay/config";
import {
  InvalidTransition,
  decide,
  eventRowsOf,
  isTerminal,
  type Command,
  type Decision,
  type Effect,
  type Session,
} from "@/server/relay/domain/session";
import { InvalidRunnerTransition, machineNameFor, type RunnerEffect } from "@/server/relay/domain/runner";
import { runnerDeadlineOf } from "@/server/relay/domain/expiry";
import { createFailureOf, createRefusedBeforeCall, type RunnerSpec } from "@/server/relay/ports";
import { readFirstInput } from "@/server/relay/secret-columns";
import { recordEvent } from "@/server/relay/telemetry";
import { mintRelayToken, relayTokenExpiry } from "@/server/relay/tokens";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import {
  NoCreditsError,
  consumeForSession,
  lockOrg,
  refundConsumeForSession,
  streamMonthlyRate,
} from "../stream-credits";
import { toSession, lockRow, readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { destinationRowOf, readSessionDestination, fillReplayUrl } from "./destination";
import { persist, persistFacts } from "./persist";
import { recordEffect, forceDestroy, releaseOutput, disablePhoneInput } from "./port-effects";

/** M6: the states a session can still CONSUME from, i.e. not yet live — `apply` reads the org's monthly rate (a pooled
 *  read) for these alone. The domain decides a consume only from `warming`, and states only move forward. */
const CAN_STILL_CONSUME: readonly Session["state"][] = ["requested", "provisioning", "warming"];

function logDecision(before: Session, dec: Decision, now: Date): void {
  for (const ev of dec.events) {
    log.info(
      { sid: before.id, fixtureId: before.fixtureId, orgId: before.orgId, state: dec.next.state, transition: `${before.state}->${dec.next.state}`,
        reason: ev.type === "SessionEnded" ? ev.reason : null, machineId: dec.next.runner.machineId, runnerState: dec.next.runner.state, event: ev.type, at: now.toISOString() },
      "stream session event",
    );
  }
}

/** Who asked (ruling 13; PII decision: a user id already in the system, never an IP). `phone` (capture QR v2 §6.7.1):
 *  the phone's own call, attributed to its stream code's `issued_by`. */
export interface Actor { userId: string | null; source: "client" | "admin" | "phone" }

// ---------------------------------------------------------------------------
// apply — THE seam. Effects that need the transaction run inside it
// (consume_credit); effects that need a port run after commit. The HISTORY
// rows (ruling 13) land in the same transaction as the state: a failure
// writing them rolls the state change back (the atomicity test).
// ---------------------------------------------------------------------------
export async function apply(
  sessionId: string,
  command: Command | ((s: Session, tx: Tx) => Command | null | Promise<Command | null>),
  deps: SessionDeps,
  actor?: Actor,
): Promise<Session | null> {
  const now = deps.now();
  // M6 (Task 14b review): the go-live consume rolls the org's free month over under the money lock it already holds, so
  // it needs the org's rate — a POOLED read (orgPlanKey) that must never run inside the transaction below (lib/db.ts's
  // nesting guard: a second connection per open transaction is a self-deadlock under load). So it is read HERE, and only
  // for a session that can still consume: states only move forward (domain/session.ts), and a consume is decided only
  // from `warming`, so a session seen live, ending or terminal now can never consume in this apply. The row is peeked
  // unlocked — `org_id` never changes, and `state` is only the gate for this read; the decision reads the LOCKED row.
  const [peek] = await sql<{ org_id: string; state: Session["state"] }[]>`select org_id, state from fixture_stream_sessions where id = ${sessionId}`;
  if (!peek) return null;
  // N4 (Task 14b re-review): a FAILED read must not block the apply. Most decisions from these states (Stop, every expiry)
  // never consume, so a pooled-read outage is reported and `monthly` stays unresolved: the consume guard below refuses the
  // one decision that needs the rate, by name, and the next apply retries the read.
  let monthly: { rate: number; now: Date } | undefined;
  if (CAN_STILL_CONSUME.includes(peek.state)) {
    try {
      monthly = { rate: await streamMonthlyRate(peek.org_id), now: new Date() };
    } catch (err) {
      log.error({ err: String(err), sessionId, orgId: peek.org_id, state: peek.state }, "stream session: the monthly credit rate read failed — reported; this apply decides without it and refuses a go-live consume");
      captureError(err, { orgId: peek.org_id, route: "relay.credits.apply_rate_read", extra: { sessionId, state: peek.state } });
    }
  }
  const outcome = (await sql.begin(async (tx) => {
    // A7 — LOCK ORDER. stream-credits.ts's rule is that every writer takes the org's money lock FIRST (`lockOrg`, before
    // any read), and its staff paths then take this session row (`staffRow`: lockOrg, then FOR KEY SHARE on the linked
    // session). `consumeForSession` below takes lockOrg itself, so locking the row first and consuming second is the
    // OPPOSITE order: an apply that goes live while a staff refund names this session deadlocks against it (Postgres
    // aborts one). So the org lock comes first here too, on every apply — which decisions consume is only known after
    // `decide`, and that needs the locked row. `org_id` is read without a lock because nothing ever changes it; it is
    // only the lock's key. consumeForSession's own lockOrg is then re-entrant. `recordEffect` and the projection's
    // writes take the row alone and never the org lock, so no cycle can form through them.
    // Witness: "A7 lock order: … the row stays free for a FOR UPDATE NOWAIT". (M6: the unlocked `org_id` read is the peek
    // above, before the transaction.)
    await lockOrg(tx, peek.org_id);
    const row = await lockRow(tx, sessionId);
    if (!row) return null;
    const before = toSession(row);
    // T7: a command function may READ on this transaction (never the pool — lib/db.ts's nesting guard) to re-take a
    // decision whose inputs live outside the Session (the tick's phone-lost ends: a beat, a pairing, a sample).
    const cmd = typeof command === "function" ? await command(before, tx) : command;
    // T5-a: a command function that returns null read the LOCKED row and found nothing to decide (the row moved on) —
    // write nothing, run nothing. The caller that returned null knows why and acts outside the transaction.
    if (cmd === null) return { session: before, effects: [] };
    let dec = decide(before, cmd, now);
    let applied: Command = cmd;
    if (dec.effects.some((e) => e.type === "consume_credit")) {
      // Two ways to arrive here with no rate: the read above FAILED (N4, already reported), or — "cannot happen" as a
      // guard — the peek saw a state that can no longer consume yet the LOCKED row decided a consume, which only a state
      // moved BACKWARDS between the two can do. Either way refused by name: consuming without the rollover would silently
      // draw a bought credit over this month's free one. Nothing is written; the next apply peeks and reads again.
      if (!monthly) {
        throw new HttpError(500, `Session ${sessionId} went live (${peek.state} at the rate read, ${before.state} under the lock) with no monthly credit rate resolved; refusing to consume without the monthly rollover`, "monthly_rate_unresolved");
      }
      if (before.mode === "composed" && before.outputUid === null) {
        // R2004, PR #981 review I3 — "cannot happen" as a guard: a composed session going live with NO destination output
        // (the add failed and the fail-closed path did not land, or a row seeded without one). The broadcast reaches
        // nobody, so it is never charged: refused by name, logged and reported, and the decision goes on unconsumed.
        log.error({ sid: sessionId, orgId: before.orgId, code: "composed_live_without_output" }, "stream session: a composed session went live with no destination output — the credit is NOT consumed");
        captureError(new Error(`stream session ${sessionId}: a composed session went live with no destination output — credit not consumed`),
          { orgId: before.orgId, route: "relay.credits.went_live_without_output", extra: { sessionId, code: "composed_live_without_output" } });
      } else {
        try {
          const c = await consumeForSession(tx, { orgId: before.orgId, fixtureId: before.fixtureId, sessionId, monthly }, now);
          if (c.ledgerId) await tx`update fixture_stream_sessions set credit_ledger_id = ${c.ledgerId} where id = ${sessionId}`;
        } catch (e) {
          if (!(e instanceof NoCreditsError)) throw e;
          applied = { type: "credit_refused" };
          dec = decide(before, applied, now);   // same transaction, the refusal is the state
        }
      }
    }
    await persist(tx, dec.next);
    await persistFacts(tx, before, dec.next, applied, now);
    if (actor) {
      await recordEvent(tx, { sessionId, orgId: before.orgId, source: actor.source, kind: "action", type: cmd.type, actorUserId: actor.userId, occurredAt: now, payload: { state: before.state } });
    }
    for (const r of eventRowsOf(before, dec, applied)) {
      await recordEvent(tx, { sessionId, orgId: before.orgId, source: r.source, kind: r.kind, type: r.type, from: r.from, to: r.to, payload: r.payload, occurredAt: now });
    }
    if (dec.effects.some((e) => e.type === "refund_credit")) {
      // R2008 (owner ruling 2026-10-19): the never-live cancellation returns the go-live consume, in THIS transaction — the
      // failure and the refund commit together or neither does, so a session is never failed with its credit still taken
      // nor refunded while still live. The ledger decides whether anything is owed (a free restart consumed nothing; a staff
      // refund may have returned it already), so the effect never assumes a consume; the event row records which it was (delta 0 and no ledger id: nothing was owed).
      // BOUNDED (free-gaps, owner ruling 2026-10-20): one never-live refund per fixture per reuse window — a refund the window
      // has no room for is withheld, and the event says so (`reason`), where delta 0 alone would read as "nothing was owed".
      const r = await refundConsumeForSession(tx, { orgId: before.orgId, sessionId, fixtureId: before.fixtureId, note: "R2008: the stream went live and its camera never appeared — credit returned" }, now);
      // `result` is 'ok' | 'failed' | null (V410's check): a refund the window had no room for succeeded at nothing and failed at
      // nothing — it was declined — so it claims neither (null), and the payload's `reason` says why (review m2).
      await recordEvent(tx, { sessionId, orgId: before.orgId, source: "domain", kind: "effect", type: "refund_credit", result: r.withheld ? null : "ok", occurredAt: now,
        payload: { delta: r.delta, balanceAfter: r.balance, ledgerId: r.ledgerId, ...(r.withheld ? { reason: "refund_capped" } : {}) } });
    }
    logDecision(before, dec, now);
    return { session: dec.next, effects: dec.effects.filter((e) => e.type !== "consume_credit" && e.type !== "refund_credit") };
  })) as { session: Session; effects: Effect[] } | null;
  if (!outcome) return null;
  return runEffects(outcome.session, outcome.effects, deps);
}

/** R2004, PR #981 review I3 (coordinator ruling, money): the destination output could not be added. Reported, then the
 *  session is FAILED on the locked row (`output_failed`) — which for composed also tears its Machine down (the runner's
 *  stop, then destroy: the credit refusal's teardown) — and, when it never went live, both of its inputs are deleted:
 *  nothing has broadcast into them, so they hold no recording for the delete to leak (C2), exactly the refused programme
 *  create's cleanup. A failed cleanup is reported with the uid and left to the retention sweep (the rows keep the uids).
 *  No credit: the session is terminal before anything can go live, and the went_live guard (apply) backs that. */
async function failClosedOnOutput(s: Session, inputUid: string, err: unknown, deps: SessionDeps): Promise<void> {
  captureError(err, { orgId: s.orgId, route: "relay.add_output", extra: { sessionId: s.id, mode: s.mode, inputUid } });
  log.error({ sid: s.id, mode: s.mode, inputUid, err }, "stream session: the destination output could not be added — the session fails closed");
  const failed = await apply(s.id, (cur) => (cur.state === "warming" || cur.state === "live" ? { type: "output_failed" } : null), deps);
  if (!failed || failed.startedAt !== null) return;
  const uids = (await sql<{ uid: string }[]>`
    select ingest_input_id as uid from fixture_stream_inputs where session_id = ${s.id} and ingest_input_id is not null order by role, slot`).map((r) => r.uid);
  for (const uid of uids) {
    await deps.drivers.ingest.deleteInput(uid).catch((cleanup: unknown) => {
      captureError(cleanup, { orgId: s.orgId, route: "relay.provision_cleanup", extra: { sessionId: s.id, inputUid: uid } });
      log.error({ sid: s.id, inputUid: uid, err: cleanup }, "stream session: an input of a session that failed closed was NOT deleted — the retention sweep retries it");
    });
  }
}

async function runEffects(session: Session, effects: Effect[], deps: SessionDeps): Promise<Session> {
  let current = session;
  for (const e of effects) {
    switch (e.type) {
      case "add_output": {
        const { inputId, target } = (await sql.begin(async (tx) => {
          // R2004: the session's OUTPUT input — passthrough's camera (the phone's input), composed's programme (Input B,
          // the compositor's), so a composed destination key reaches Cloudflare and never the Machine (spec §5.3).
          const input = await readFirstInput(tx, current.id, current.mode === "composed" ? "programme" : "camera");
          // T11: the pasted destination's key, or the pooled key of the broadcast an API-backed session streams into.
          return { inputId: input?.ingestInputId ?? null, target: await readSessionDestination(tx, await destinationRowOf(tx, current.id)) };
        })) as { inputId: string | null; target: { url: string; streamKey: string } };
        if (inputId) {
          let outputUid: string;
          try {
            outputUid = await recordEffect(current, "add_output", "output", () => deps.drivers.ingest.addOutput(inputId, target, { sessionId: current.id }), { inputUid: inputId });   // C9: exactly one, on the session's output input
          } catch (err) {
            // R2004, PR #981 review I3: a session with no destination fails CLOSED — never warming on, booting a Machine
            // and going live to nobody, which would consume a credit (went_live) for a broadcast no one can see.
            await failClosedOnOutput(current, inputId, err, deps);
            throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
          }
          // Dg: the slot-0 destination output's uid, beside ingest_input_uid (not a secret). The port
          // RETURNS it (Tasks 3/4); throwing that return away is what would leave the column inert.
          // coalesce so a re-run of an idempotent effect cannot move a recorded uid.
          const [after] = await sql<{ state: Session["state"] }[]>`
            update fixture_stream_sessions set output_uid = coalesce(output_uid, ${outputUid}) where id = ${current.id} returning state`;
          // C1: the session ENDED while this call was out (a Stop tapped during the add): its terminal decision read no
          // output and released nothing, so the output just made would simulcast for a session that is over. Released now.
          if (after && isTerminal(after.state)) await releaseOutput(current.id, "late_add", deps);
        }
        break;
      }
      case "release_output":
        await releaseOutput(current.id, "decision", deps);   // C1: never throws — a failure is reported and retried
        break;
      case "disable_phone_input":
        await disablePhoneInput(current.id, deps);           // never throws — a failure is reported; the Stop and the effects after it stand
        break;
      case "runner":
        current = await runRunnerEffect(current, e.effect, deps);
        break;
      case "retry_runner":
        current = await retryRunner(current, deps);
        break;
      case "complete_now":
        current = (await apply(current.id, { type: "complete" }, deps)) ?? current;
        break;
      case "fill_replay":
        await recordEffect(current, "fill_replay", "domain", () => fillReplayUrl(current.id));
        break;
      case "consume_credit":
      case "refund_credit":
        break; // ran inside apply's transaction
    }
  }
  return current;
}

/** The ONE retry: the next attempt's intent is persisted by apply (creating + name) BEFORE its create_machine effect runs.
 *  M1 (Task 2C re-review 2): the retry DECISION committed, but this effect runs after commit, and a concurrent request may
 *  have moved the row since — a late create_ok took the runner destroyed → lost (`lost × create_started` is not a cell), another
 *  reader already ran this retry (the attempt moved on), or the session ended. `decide` refuses under the row lock with
 *  InvalidRunnerTransition / InvalidTransition, and that refusal IS the answer: the retry is still owed by `lost × destroy_ok`,
 *  was already taken, or is no longer wanted. So it is a no-op that returns the row as it now stands — never a 500 out of the
 *  organiser's poll. The attempt is `current`'s (the decision's), never re-read, so a moved row cannot be re-retried here.
 *  Exported for the race witness only ("M1: a retry_runner effect whose runner moved on …"). */
export async function retryRunner(current: Session, deps: SessionDeps): Promise<Session> {
  const attempt = current.runner.attempt + 1;
  try {
    const next = (await apply(current.id, { type: "runner", trigger: { type: "create_started", name: machineNameFor(current.id, attempt), attempt } }, deps)) ?? current;
    log.warn({ sid: current.id, attempt, transition: "retry", reason: "runner_lost" }, "stream session: replacement Machine requested inline");
    return next;
  } catch (err) {
    if (!(err instanceof InvalidRunnerTransition) && !(err instanceof InvalidTransition)) throw err;
    log.info({ sid: current.id, attempt, transition: "retry_skipped", err: String(err) }, "stream session: retry refused under the row lock — the row moved on");
    const row = await readRow(current.id);
    return row ? toSession(row) : current;
  }
}

/** Runner effects run AFTER the row's transaction committed and feed their
 *  outcome back through `apply` — each is idempotent (desired vs observed). */
async function runRunnerEffect(s: Session, e: RunnerEffect, deps: SessionDeps): Promise<Session> {
  switch (e.type) {
    case "persist_intent":
      return s;   // apply already persisted `creating` + name + attempt in its transaction (invariant 4)
    case "create_machine": {
      // T5-a (Task 2C review concern 3, M5): the trigger carries no attempt, so the OUTCOME is fed to the row only while the
      // LOCKED row still names the Machine this call asked for. A create is slow; while it is out, C1 can lose the runner, the
      // destroy confirm and the retry persist attempt + 1 — and `creating × create_ok` would then adopt THIS attempt's Machine as
      // the next one's (or `booting × create_ok` would throw). Names carry the attempt (machineNameFor), so name equality is
      // attempt equality. Same name: every cell is designed for it (lost/destroyed × create_ok destroy the returned id).
      const stillOurs = (cur: Session) => cur.runner.name === s.runner.name;
      let handle: Awaited<ReturnType<typeof createRunner>>;
      try {
        handle = await recordEffect(s, "create_machine", "runner", () => createRunner(s, deps), { attempt: s.runner.attempt, machineName: s.runner.name });
      } catch (err) {
        // A3 (lane-b carry 2, owner-confirmed 2026-09-28) + A23: the PROOF is decided by the adapter, which alone knows
        // its provider's evidence, and crosses the PORT as a provider-neutral `RunnerCreateError` — this layer imports no
        // adapter. Made nothing (a refusal, a confirmed absence, a create refused before any call) or unknown; anything
        // that is not a RunnerCreateError is unknown, which the table answers with a by-name teardown before any retry.
        const trigger = { type: "create_failed" as const, ...createFailureOf(err) };
        log.error({ sid: s.id, attempt: s.runner.attempt, retryable: trigger.retryable, outcomeUnknown: trigger.outcomeUnknown, err: String(err) }, "stream session: Machine create failed");
        // A stale attempt's failure is not the current attempt's: dropped.
        return (await apply(s.id, (cur) => (stillOurs(cur) ? { type: "runner", trigger } : null), deps)) ?? s;
      }
      let foreign = false;
      const next = await apply(s.id, (cur) => {
        if (stillOurs(cur)) return { type: "runner", trigger: { type: "create_ok", machineId: handle.runnerId } };
        foreign = true;
        return null;
      }, deps);
      if (foreign) {
        // Nobody's Machine: the row never learned it, so no cell will ever destroy it — do it here, recorded like any effect.
        // A failed DELETE is recorded and ALARMED (forceDestroy) rather than thrown at the organiser's create or poll. On a
        // LIVE session it leaves a second Machine on the destination's key with no retry owner — Task 12's sweep rule
        // (destroy any listed Machine whose name's attempt is not the session's current one), routed; the alarm is what
        // tells a person meanwhile.
        log.warn({ sid: s.id, attempt: s.runner.attempt, machineId: handle.runnerId, transition: "stale_create" }, "stream session: a create returned after its attempt moved on — destroyed");
        await forceDestroy(s, handle.runnerId, "stale_create", { machineId: handle.runnerId, staleAttempt: s.runner.attempt }, deps);
      }
      return next ?? s;
    }
    case "stop_machine": {
      const id = s.runner.machineId;
      if (id) await recordEffect(s, "stop_machine", "runner", () => deps.drivers.runner.stop(id, { signal: e.signal, timeoutSeconds: e.timeoutSeconds }), { machineId: id, signal: e.signal, timeoutSeconds: e.timeoutSeconds });   // SIGINT (R0 :279); idempotent
      return s;
    }
    case "force_destroy": {
      // F15/P1-F-a: the teardown of a stop-marked `creating` session emits force_destroy with a NULL
      // machineId — the id was never learned. `if (id)` alone therefore SKIPS the destroy, the effect
      // still reports success, and the Machine leaks to the daily orphan sweep. Resolve it by NAME
      // (invariant 4 persisted `runner_name` before the create call) exactly as the crash-safe
      // reconcile does, and only then give up.
      let id = s.runner.machineId;
      if (!id && s.runner.name) {
        const mine = (await deps.drivers.runner.list()).find((m) => m.sessionId === s.id && m.name === s.runner.name);   // T5-a: THIS attempt's, by name
        id = mine?.runnerId ?? null;
      }
      // Task 11 review m5: a DELETE that fails is not the READER's error — the table owns the retry (a LOST runner's
      // teardown is re-issued on the next stale beat; a TERMINAL session's orphan is destroyed by the next admission on its
      // fixture or destination, tearDownPriorMachines, and by Task 12's daily orphan sweep once it lands). Throwing it on
      // re-issued nothing: it 500-ed the organiser's poll (or the Machine's facts read) with the provider's text at the
      // moment a stream ended, and skipped every effect after this one in the same decision (a completion's fill_replay).
      // No destroy_ok when it failed: nothing was confirmed.
      if (id && !(await forceDestroy(s, id, "force_destroy", { machineId: id }, deps))) return s;   // 404 = success (C7)
      // F-B (orchestrator ruling, post-2C-post plan sync): this effect runs after commit, and while the DELETE was out another
      // request may have confirmed this attempt's Machine gone (an observed `destroyed`) and run the ONE retry — the row now names
      // attempt + 1 in `creating` or `booting`, where `destroy_ok` is ✗ (InvalidRunnerTransition: a 500 out of the organiser's
      // poll). So the confirmation is fed only while the LOCKED row still names the Machine this effect was issued for — the
      // T5-a null-command form. Name equality is exact: names carry the attempt, every force_destroy-issuing cell leaves the
      // runner `lost`/`destroyed` at the SAME attempt and name, and only `destroyed × create_started` leaves those states, with
      // the next attempt's name. Otherwise the provider call above is already a recorded effect row and the confirmation is dropped.
      const stillOurs = (cur: Session) => cur.runner.name === s.runner.name;
      return (await apply(s.id, (cur) => (stillOurs(cur) ? { type: "runner", trigger: { type: "destroy_ok" } } : null), deps)) ?? s;
    }
  }
}

/** The job token is minted here and travels ONLY in the create call's env (invariant 5). */
async function createRunner(s: Session, deps: SessionDeps) {
  // Task 12 n1: everything the port call needs is built FIRST, and a throw while building it provably sent nothing — so it
  // is the port's made-nothing failure (`createRefusedBeforeCall`), never a plain Error the create catch must read as
  // outcome UNKNOWN (which ran lost → force_destroy → retry → the same refusal, alarming on every attempt).
  let spec: RunnerSpec;
  try {
    // #983 review r1: the token names THIS attempt (`att`), so a beat this Machine sends after a retry superseded it is
    // told from the replacement's. Each create mints its own: the retry's create_machine runs this again with attempt + 1.
    const jobToken = await mintRelayToken({ sid: s.id, scope: "relay-job", expiresAt: relayTokenExpiry(s), attempt: s.runner.attempt });
    // A2 (lane-b carry 1): the Machine's hard stop is `runnerDeadlineOf` — the session's wall clock PLUS
    // MAX_ANCHOR_DRIFT_SECONDS (whole-branch review I1). `deadlineOf` would let the Machine's own clock, which can run
    // ahead of ours, cut the broadcast before the session's wall-clock expiry ends it cleanly. Witness: "A2: …".
    // I1: the deployment's identity rides on the Machine — the daily sweep's only licence to destroy it later. In live
    // mode `relayEnvironment` REFUSES an unset ENV_NAME, so an untagged Machine is never created.
    spec = { sessionId: s.id, attempt: s.runner.attempt, environment: relayEnvironment(), jobToken, appUrl: deps.appUrl, guest: RUNNER_DEFAULT_GUEST, region: RUNNER_DEFAULT_REGION, deadlineAt: runnerDeadlineOf(s) };
  } catch (err) {
    throw createRefusedBeforeCall(err);
  }
  return deps.drivers.runner.create(spec);
}
