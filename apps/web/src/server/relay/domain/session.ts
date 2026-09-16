// server/relay/domain/session.ts — the session aggregate, PURE (owner
// instruction 2026-09-14: domain-driven, test-driven; precedent
// packages/engine/src/core/events.ts). `decide` is the ONLY thing in the
// wave that changes a session's state; the usecases load a row, call it,
// persist `next`, log `events`, run `effects` through the ports. No I/O, no
// clock: `now` is an argument. Domain events are records in an array — there
// is no bus, because nothing present subscribes.
import type { Expiry } from "./expiry";
import {
  stepRunner, type Runner, type RunnerEffect, type RunnerFailReason, type RunnerState, type RunnerTrigger,
} from "./runner";

export type SessionState = "requested" | "provisioning" | "warming" | "live" | "ending" | "completed" | "failed";
export type FailReason = "no_inbound_timeout" | "provision_timeout" | "admission_timeout" | "target_rejected" | "no_credits" | RunnerFailReason;
export type Mode = "passthrough" | "composed";

export const ACTIVE_STATES: readonly SessionState[] = ["requested", "provisioning", "warming", "live", "ending"];
export const TERMINAL_STATES: readonly SessionState[] = ["completed", "failed"];
export const isTerminal = (s: SessionState): boolean => TERMINAL_STATES.includes(s);
export const isActive = (s: SessionState): boolean => ACTIVE_STATES.includes(s);

export interface Session {
  // fixtureId is NULL once the fixture is deleted (V408: `on delete set null`) — the session, its money and
  // its history outlive the fixture and it ends through the normal commands. Nothing in this file reads it.
  id: string; fixtureId: string | null; orgId: string; mode: Mode; state: SessionState;
  desiredState: "live" | "ending"; failReason: FailReason | null; endReason: "stopped" | "max_duration" | null;
  runner: Runner;
  runnerRetries: number; createdAt: Date; startedAt: Date | null; endedAt: Date | null;
  heartbeatAt: Date | null; endingAt: Date | null; maxDurationMinutes: number;   // endingAt: when ending BEGAN — the ending backstop's anchor (F22), persisted as ending_at
}

// ---- admission (§6.3 order; E5: storage_exhausted is a refusal, never a state)
export type AdmitRefusal = "plan_lacks_overlay" | "overlay_required" | "plan_lacks_relay" | "no_credits" | "target_not_found" | "storage_exhausted" | "active_session";
export interface AdmitInput {
  overlay: boolean; relay: boolean; balance: number; targetBelongsToOrg: boolean;
  headroomMinutes: number; maxDurationMinutes: number; activeSessionId: string | null;
}
export function admit(i: AdmitInput): { ok: true } | { ok: false; refusal: AdmitRefusal; activeSessionId?: string } {
  if (i.relay && !i.overlay) return { ok: false, refusal: "overlay_required" };  // r5: the implication check
  if (!i.overlay) return { ok: false, refusal: "plan_lacks_overlay" };
  if (!i.relay) return { ok: false, refusal: "plan_lacks_relay" };
  if (i.balance < 1) return { ok: false, refusal: "no_credits" };
  if (!i.targetBelongsToOrg) return { ok: false, refusal: "target_not_found" };
  if (i.headroomMinutes < i.maxDurationMinutes) return { ok: false, refusal: "storage_exhausted" };
  if (i.activeSessionId) return { ok: false, refusal: "active_session", activeSessionId: i.activeSessionId };
  return { ok: true };
}

// ---- transitions
export type Command =
  | { type: "provision" } | { type: "provisioned" }
  | { type: "ingest_connected" } | { type: "credit_refused" }
  | { type: "target_rejected" } | { type: "stop" } | { type: "complete" }
  | { type: "expire"; expiry: Expiry }
  | { type: "runner"; trigger: RunnerTrigger };

export type DomainEvent =
  | { type: "SessionProvisioning" } | { type: "SessionWarming" }
  | { type: "SessionWentLive" } | { type: "SessionEnding"; endReason: "stopped" | "max_duration" } | { type: "RunnerRetried"; attempt: number }
  | { type: "RunnerChanged"; from: RunnerState; to: RunnerState; trigger: RunnerTrigger["type"] }
  | { type: "SessionEnded"; reason: "completed" | FailReason };

export type Effect =
  | { type: "consume_credit" } | { type: "add_output" }
  | { type: "runner"; effect: RunnerEffect } | { type: "retry_runner" }
  | { type: "complete_now" } | { type: "fill_replay" };

export interface Decision { next: Session; events: DomainEvent[]; effects: Effect[] }

// ---- ruling 13: the capture shape of a decision (pure; Task 10 persists it verbatim)
export interface EventRow {
  source: "domain" | "runner";
  kind: "transition" | "runner_transition" | "event";
  type: string;
  from: string | null;
  to: string | null;
  payload: Record<string, unknown>;
}

/** Exactly one `transition` row when the session state changed (type = the
 *  command that changed it), exactly one `runner_transition` per RunnerChanged
 *  (type = the trigger), and one `event` row per remaining DomainEvent. A
 *  decision that changed nothing yields []. The payload carries the command's
 *  own data (expiry kind, trigger payload) — allowlisted again in telemetry.ts. */
export function eventRowsOf(before: Session, d: Decision, command: Command): EventRow[] {
  const rows: EventRow[] = [];
  if (d.next.state !== before.state) {
    rows.push({
      source: "domain", kind: "transition", type: command.type, from: before.state, to: d.next.state,
      payload: {
        ...(command.type === "expire" ? { expiry: command.expiry.kind } : {}),
        ...(d.next.failReason ? { failReason: d.next.failReason } : {}),
        ...(d.next.endReason && d.next.endReason !== before.endReason ? { endReason: d.next.endReason } : {}),
      },
    });
  }
  for (const e of d.events) {
    if (e.type === "RunnerChanged") {
      rows.push({ source: "runner", kind: "runner_transition", type: e.trigger, from: e.from, to: e.to,
        payload: { attempt: d.next.runner.attempt, machineId: d.next.runner.machineId, machineName: d.next.runner.name, ...(command.type === "runner" && command.trigger.type === "observed" ? { observed: command.trigger.state, exit: command.trigger.exit ?? null } : {}) } });
    } else if (e.type === "RunnerRetried") {
      rows.push({ source: "runner", kind: "event", type: e.type, from: null, to: null, payload: { attempt: e.attempt } });
    } else if (e.type === "SessionEnding") {
      rows.push({ source: "domain", kind: "event", type: e.type, from: null, to: null, payload: { endReason: e.endReason } });
    } else if (e.type === "SessionEnded") {
      rows.push({ source: "domain", kind: "event", type: e.type, from: null, to: null, payload: { reason: e.reason } });
    } else {
      rows.push({ source: "domain", kind: "event", type: e.type, from: null, to: null, payload: {} });
    }
  }
  return rows;
}

export class InvalidTransition extends Error {
  constructor(readonly from: SessionState, readonly command: Command["type"]) {
    super(`stream session: ${command} is not legal from ${from}`);
  }
}

const identity = (s: Session): Decision => ({ next: s, events: [], effects: [] });

/** P1-F-b: a FAILED session carries its cause in failReason and NO endReason —
 *  end_reason belongs to completed sessions (the DDL's stopped | max_duration). */
function fail(s: Session, reason: FailReason, now: Date): Decision {
  return { next: { ...s, state: "failed", failReason: reason, endReason: null, endedAt: now }, events: [{ type: "SessionEnded", reason }], effects: [] };
}

/** P1-F-b + C6 (Task 2C): a Machine teardown on the way to `failed` keeps its runner events and drops the teardown's
 *  own ENDINGS — the stop step's SessionEnding, and the SessionEnded a LOST runner's session_stop emits (F17 completes
 *  the session there) — so a failed session reports exactly one SessionEnded: its own, with its fail reason. */
const keptBeforeFailure = (e: DomainEvent): boolean => e.type !== "SessionEnding" && e.type !== "SessionEnded";

/** I3 (Task 2A review, orchestrator ruling): the replay fill belongs ONLY to a session that actually went live.
 *  A session stopped before it ever broadcast (organiser stop while warming, a composed stop before any create)
 *  has no replay, and filling one would publish a link for a match that never aired. The ONE authority for both
 *  completion paths — `complete()` and the runner's `completed` signal — so Task 10 persists the effect as given. */
const replayFill = (s: Session): Effect[] => (s.startedAt !== null ? [{ type: "fill_replay" }] : []);

function complete(s: Session, now: Date): Decision {
  return { next: { ...s, state: "completed", desiredState: "ending", endedAt: now }, events: [{ type: "SessionEnded", reason: "completed" }], effects: replayFill(s) };
}

/** Passthrough only: nothing to flush, so ending completes NOW. A composed
 *  session's ending is the RUNNER's (the stop sequence in ./runner). */
function ending(s: Session, endReason: "stopped" | "max_duration", now: Date): Decision {
  return { next: { ...s, state: "ending", desiredState: "ending", endReason, endingAt: now }, events: [{ type: "SessionEnding", endReason }], effects: [{ type: "complete_now" }] };
}

/** Every Machine event: the lifecycle table steps the runner, its signal steps the session. */
function runner(s: Session, trigger: RunnerTrigger, now: Date, illegal: () => InvalidTransition): Decision {
  if (s.mode !== "composed") throw illegal();
  const step = stepRunner(s.runner, trigger, now);
  const events: DomainEvent[] = [{ type: "RunnerChanged", from: s.runner.state, to: step.next.state, trigger: trigger.type }];
  const effects: Effect[] = step.effects.map((e) => ({ type: "runner" as const, effect: e }));
  const next: Session = { ...s, runner: step.next };
  // C27: on a terminal session the runner advances and the session does not — the step's
  // signal is ignored (no retry, no second SessionEnded, no fill_replay).
  if (isTerminal(s.state)) return { next, events, effects };
  switch (step.signal?.type) {
    case undefined:
      return { next, events, effects };
    case "went_live":
      if (s.state === "live") return { next, events, effects };                                   // a replacement reporting playing: the session is already live, no second consume
      // F16: the beat can land BEFORE `provisioned` (a process dying between create_ok and provisioned
      // strands the session in provisioning, and `evaluate` has no timer for that state). The carrier is an
      // INTERNAL route the Machine retries, so a throw would 500-loop: record the sample (Task 10 does, before
      // this call) and IGNORE the trigger. The runner still advances, and `playing`'s own callback_playing
      // re-signals went_live, so the next beat takes the session live with exactly one consume.
      if (s.state !== "warming") return { next, events, effects };
      return { next: { ...next, state: "live", startedAt: now }, events: [...events, { type: "SessionWentLive" }], effects: [...effects, { type: "consume_credit" }] };
    case "ending":
      // provisioning: a stop while the FIRST create is in flight (P1-F-a); already ending: idempotent
      if (s.state !== "live" && s.state !== "warming" && s.state !== "provisioning") return { next, events, effects };
      return { next: { ...next, state: "ending", desiredState: "ending", endReason: step.signal.endReason, endingAt: now }, events: [...events, { type: "SessionEnding", endReason: step.signal.endReason }], effects };
    case "completed": {
      if (s.state !== "ending" && s.state !== "live" && s.state !== "warming") return { next, events, effects };
      // F17: when the completion IS the ending, the signal carries the reason; P1-F-a's mid-create teardown
      // leaves it out and the session keeps the one its `ending` step already stored.
      const endReason = step.signal.endReason ?? s.endReason;
      return { next: { ...next, state: "completed", desiredState: "ending", endReason, endedAt: now }, events: [...events, { type: "SessionEnded", reason: "completed" }], effects: [...effects, ...replayFill(s)] };
    }
    case "retry": {
      // F17: a retry belongs ONLY to a session that still wants to be live. Once the session is ending — its
      // deadline or the organiser's stop reached the runner first — the Machine just destroyed is the LAST
      // one: complete instead of booting a replacement into overtime. A TERMINAL session never reaches here
      // (C27's early return is above), and the wall-clock arm is the TABLE's: `lost`'s `deadline` and
      // `session_stop` cells complete the session themselves rather than leaving a retryable runner behind.
      if (s.state === "ending" || s.desiredState === "ending") {
        const c = complete(next, now);
        return { next: c.next, events: [...events, ...c.events], effects: [...effects, ...c.effects] };
      }
      // heartbeatAt restarts: the replacement owes its first beat within STALE_HEARTBEAT_SECONDS of NOW, not of the crash.
      return { next: { ...next, runnerRetries: next.runnerRetries + 1, heartbeatAt: now }, events: [...events, { type: "RunnerRetried", attempt: next.runner.attempt + 1 }], effects: [...effects, { type: "retry_runner" }] };
    }
    case "failed": {
      const f = fail(next, step.signal.reason, now);
      return { next: f.next, events: [...events, ...f.events], effects: [...effects, ...f.effects] };
    }
  }
}

/** C27: the runner triggers that only TEAR DOWN — the stop confirmed, the Machine
 *  observed, destroyed, or forced by the grace window, or (P1-F-a) the create call
 *  returning after a stop was marked mid-create (a warming timeout can fail the
 *  session first). A terminal session still owns its Machine until one of these lands. */
export const RUNNER_CLEANUP_TRIGGERS: readonly RunnerTrigger["type"][] = ["create_ok", "create_failed", "callback_stopped", "observed", "destroy_ok", "grace_expired"];

export function decide(s: Session, c: Command, now: Date): Decision {
  const illegal = () => new InvalidTransition(s.state, c.type);
  if (isTerminal(s.state)) {
    const cleanup =
      (c.type === "runner" && RUNNER_CLEANUP_TRIGGERS.includes(c.trigger.type)) ||
      (c.type === "expire" && c.expiry.kind === "grace_expired");
    if (!cleanup) throw illegal();
  }
  switch (c.type) {
    case "provision":
      if (s.state !== "requested") throw illegal();
      return { next: { ...s, state: "provisioning" }, events: [{ type: "SessionProvisioning" }], effects: [] };
    case "provisioned":
      if (s.state !== "provisioning") throw illegal();
      return {
        next: { ...s, state: "warming" },
        events: [{ type: "SessionWarming" }],
        effects: s.mode === "passthrough" ? [{ type: "add_output" }] : [],   // C9: exactly one output, passthrough only
      };
    case "ingest_connected":
      if (s.state !== "warming" || s.mode !== "passthrough") throw illegal();
      return { next: { ...s, state: "live", startedAt: now }, events: [{ type: "SessionWentLive" }], effects: [{ type: "consume_credit" }] };
    case "credit_refused":
      if (s.state !== "warming") throw illegal();
      // I2 (Task 2A review, orchestrator ruling — money/safety): Task 10 re-decides `credit_refused` after
      // NoCreditsError. A COMPOSED session's Machine is already up and broadcasting, so failing the row alone
      // would leave it pushing to the destination, unpaid, until the 5 h deadline. Tear it down exactly as the
      // composed `warming_timeout` does — the runner's `session_stop` step (its stop effect), then fail, dropping
      // the stop step's SessionEnding (P1-F-b) — and mark desiredState `ending` so nothing re-wants it live.
      // Passthrough is unchanged. Killer (Task 2C carry C3): session.test.ts "C3 (I2): a COMPOSED credit refusal…".
      if (s.mode === "composed" && s.runner.state !== "none") {
        const torn = runner(s, { type: "session_stop" }, now, illegal);
        const f = fail({ ...torn.next, desiredState: "ending" }, "no_credits", now);
        return { next: f.next, events: [...torn.events.filter(keptBeforeFailure), ...f.events], effects: [...torn.effects, ...f.effects] };
      }
      return fail(s, "no_credits", now);
    case "target_rejected":
      if (s.state !== "warming" && s.state !== "live") throw illegal();
      return fail(s, "target_rejected", now);
    case "stop":
      if (s.state === "ending") return identity(s);
      if (s.mode === "passthrough") return ending(s, "stopped", now);
      // P1-F-a — composed with NO live Machine (none: never asked for; destroyed: between attempts): nothing to flush, complete NOW.
      if (s.runner.state === "none" || s.runner.state === "destroyed") return complete({ ...s, endReason: "stopped" }, now);
      // creating: the table marks the stop and the session goes ending; booting/playing: SIGINT; stopping/exited/lost: the table.
      return runner(s, { type: "session_stop" }, now, illegal);
    case "complete":
      if (s.state !== "ending" && s.state !== "live") throw illegal();
      return complete(s, now);
    case "expire":
      return expire(s, c.expiry, now, illegal);
    case "runner":
      return runner(s, c.trigger, now, illegal);
  }
}

function expire(s: Session, e: Expiry, now: Date, illegal: () => InvalidTransition): Decision {
  switch (e.kind) {
    case "none": return identity(s);
    case "warming_timeout":
      if (s.state !== "warming") throw illegal();
      // A composed session that never reported playing: tear the Machine down, then fail with the boot reason.
      if (s.mode === "composed" && s.runner.state !== "none") {
        const torn = runner(s, { type: "session_stop" }, now, illegal);
        const f = fail(torn.next, "machine_boot_timeout", now);   // fail() nulls the endReason the stop step set (P1-F-b)
        // P1-F-b: the stop step's SessionEnding is dropped — a failed session never reports an end reason, in its row or its events.
        return { next: f.next, events: [...torn.events.filter(keptBeforeFailure), ...f.events], effects: [...torn.effects, ...f.effects] };
      }
      return fail(s, "no_inbound_timeout", now);
    case "requested_timeout":
      if (s.state !== "requested") throw illegal();
      // F18: admitted by nobody. No provider was ever called, so there is nothing to tear down.
      return fail(s, "admission_timeout", now);
    case "provision_timeout":
      if (s.state !== "provisioning") throw illegal();
      // Every non-terminal state owes a timed exit — F16 found `provisioning` with none, and a session
      // stranded there 500-loops the internal route its own Machine calls. Same shape as the warming
      // timeout: if the create got as far as a Machine, tear it down first, then fail — and drop the stop
      // step's SessionEnding, because a failed session reports no end reason (P1-F-b).
      if (s.mode === "composed" && s.runner.state !== "none") {
        const torn = runner(s, { type: "session_stop" }, now, illegal);
        const f = fail(torn.next, "provision_timeout", now);
        return { next: f.next, events: [...torn.events.filter(keptBeforeFailure), ...f.events], effects: [...torn.effects, ...f.effects] };
      }
      return fail(s, "provision_timeout", now);
    case "wall_clock":
      if (s.state !== "live" && s.state !== "warming") throw illegal();
      if (s.mode === "passthrough") return ending(s, "max_duration", now);
      // F14 — the deadline takes the stop's shape (P1-F-a): no live Machine completes NOW; a create in
      // flight is marked and the session ends; booting/playing take the SIGINT stop. It never throws.
      if (s.runner.state === "none" || s.runner.state === "destroyed") return complete({ ...s, endReason: "max_duration" }, now);
      return runner(s, { type: "deadline" }, now, illegal);
    case "stale_beat": {
      if (s.state !== "live" || s.mode !== "composed") throw illegal();
      // C1 (Task 2C): a stale beat that was ACTED ON restarts the beat window. Every stale_beat cell with an effect or a
      // signal — lost's re-issued force_destroy, destroyed's re-signalled retry, the entry into lost — would otherwise
      // fire again on the very next lazy read (a 5 s poll), because nothing else moves heartbeatAt. The runner has no
      // clock of its own to bound it with, and the retry arm already restarts this same window for a replacement.
      const d = runner(s, { type: "stale_beat" }, now, illegal);
      return { ...d, next: { ...d.next, heartbeatAt: now } };
    }
    case "grace_expired":
      if (s.mode !== "composed") throw illegal();
      return runner(s, { type: "grace_expired" }, now, illegal);
    case "ending_timeout":
      if (s.state !== "ending") throw illegal();
      // F19: the completion was lost. If a Machine is still stoppable, send the stop — that marks the runner
      // and the grace finishes it; otherwise there is nothing left to flush and the session completes.
      // C5 (M6, Task 2C): a create still IN FLIGHT counts — completing over an unmarked `creating` runner left the
      // Machine that call later made to the daily orphan sweep. The stop marks it: a late create_ok is destroyed, and
      // if nothing ever returns the grace clock the mark started ends the session on a lazy read (F15).
      if (s.mode === "composed" && (s.runner.state === "booting" || s.runner.state === "playing" || s.runner.state === "creating")) return runner(s, { type: "session_stop" }, now, illegal);
      return complete(s, now);
  }
}
