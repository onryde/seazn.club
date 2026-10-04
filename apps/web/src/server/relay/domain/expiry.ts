// server/relay/domain/expiry.ts — the expiry policy (design §6.4; recommendation
// B). PURE: evaluated lazily on every read, heartbeat, poll and admission by the
// usecases, and once a day by the sweep's backstop. Order matters and is
// tested: wall clock outranks a stale beat, so an over-long session ENDS and is
// never retried into overtime.
import { ENDING_TIMEOUT_SECONDS, MAX_ANCHOR_DRIFT_SECONDS, MAX_DURATION_MINUTES, PROVISION_TIMEOUT_SECONDS, REQUESTED_TIMEOUT_SECONDS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, STALE_HEARTBEAT_SECONDS, WARMING_TIMEOUT_MINUTES } from "../config";
import type { Session } from "./session";

// EVERY non-terminal state owns a kind here, and the sweep in expiry.test.ts walks ACTIVE_STATES to prove it.
export type Expiry =
  | { kind: "none" } | { kind: "requested_timeout" } | { kind: "provision_timeout" } | { kind: "warming_timeout" }
  | { kind: "wall_clock" } | { kind: "stale_beat" } | { kind: "grace_expired" } | { kind: "ending_timeout" };

export interface ExpiryLimits {
  warmingTimeoutMinutes: number; staleHeartbeatSeconds: number; stopGraceSeconds: number;
  provisionTimeoutSeconds: number; requestedTimeoutSeconds: number; endingTimeoutSeconds: number;
}
export const DEFAULT_LIMITS: ExpiryLimits = {
  warmingTimeoutMinutes: WARMING_TIMEOUT_MINUTES, staleHeartbeatSeconds: STALE_HEARTBEAT_SECONDS,
  stopGraceSeconds: RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS,
  provisionTimeoutSeconds: PROVISION_TIMEOUT_SECONDS, requestedTimeoutSeconds: REQUESTED_TIMEOUT_SECONDS,
  endingTimeoutSeconds: ENDING_TIMEOUT_SECONDS,
};

/** The SESSION's own wall clock: the instant `evaluate` calls `wall_clock` below.
 *  Whole-branch review I1: this is NOT the Machine-side hard stop — see `runnerDeadlineOf`. */
export function deadlineOf(s: Pick<Session, "createdAt" | "startedAt" | "maxDurationMinutes">): Date {
  const from = s.startedAt ?? s.createdAt;
  return new Date(from.getTime() + (s.maxDurationMinutes || MAX_DURATION_MINUTES) * 60_000);
}

/** The MACHINE-side hard stop (`RunnerSpec.deadlineAt` → the guest's `RELAY_DEADLINE_AT`), which is a BACKSTOP and
 *  must never be the first of the two to fire.
 *
 *  Whole-branch review I1 (money + product). `deadlineOf` anchors on `startedAt ?? createdAt`, but the runner spec is
 *  built at CREATE time, when `startedAt` is still null — so the Machine's hard stop was computed from `createdAt`
 *  while the session's own wall clock would later be read from `startedAt`, up to `MAX_ANCHOR_DRIFT_SECONDS` later.
 *  The supervisor therefore exited FIRST on every composed session that went live: the next lazy read saw
 *  `playing × observed destroyed`, spent the session's ONE retry booting a replacement for the last minutes of a
 *  broadcast that was running perfectly — or, with the retry already gone, failed it `machine_crash`, and `fail()`
 *  emits no `fill_replay`, so a match that DID air lost its replay link.
 *
 *  The slack goes HERE and never on the wall clock: re-anchoring `deadlineOf` on `createdAt` would shorten every
 *  paid session by its own warm-up, which is worse for the customer and for us. `tokens.ts`'s `relayTokenExpiry`
 *  reasoned this identical anchor drift for `TOKEN_GRACE_MINUTES`; this is the same margin for the same reason.
 *  ORDER is the property — the session's wall clock first, the Machine second — not the arithmetic.
 *
 *  What it costs: a Machine may outlive by up to `MAX_ANCHOR_DRIFT_SECONDS` a session that somehow never has its
 *  expiry evaluated. That is bounded, it is the state the daily orphan sweep exists for, and it is reversible; the
 *  defect it replaces fired on every composed broadcast. */
export function runnerDeadlineOf(s: Pick<Session, "createdAt" | "startedAt" | "maxDurationMinutes">): Date {
  return new Date(deadlineOf(s).getTime() + MAX_ANCHOR_DRIFT_SECONDS * 1000);
}

/** The later of two optional instants; null only when both are. */
const laterOf = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null ? a : a.getTime() >= b.getTime() ? a : b);

/** ORDER (tested): wall clock > stop grace > warming timeout > stale beat. The
 *  policy names WHAT expired; the runner table (./runner) decides retry vs fail. */
export function evaluate(s: Session, now: Date, limits: ExpiryLimits = DEFAULT_LIMITS): Expiry {
  if (s.state === "live" || s.state === "warming") {
    if (now.getTime() >= deadlineOf(s).getTime()) return { kind: "wall_clock" };
  }
  // stopping/exited: our SIGINT is inside its grace window. creating (F15): a stop or a deadline was MARKED
  // while the create call was in flight and nothing came back — this LAZY read is the witness, never the
  // daily sweep (recommendation B: no safety rule waits for a daily tick).
  if (s.mode === "composed" && (s.runner.state === "stopping" || s.runner.state === "exited" || s.runner.state === "creating") && s.runner.stopRequestedAt) {
    if (now.getTime() - s.runner.stopRequestedAt.getTime() >= limits.stopGraceSeconds * 1000) return { kind: "grace_expired" };
  }
  // F18 — a row that was inserted and never admitted. Nothing has been asked of any provider, so the exit
  // is a plain failure.
  if (s.state === "requested") {
    if (now.getTime() - s.createdAt.getTime() >= limits.requestedTimeoutSeconds * 1000) return { kind: "requested_timeout" };
    return { kind: "none" };
  }
  // F19 — an ending session whose completion was LOST: a passthrough whose `complete_now` never ran, or a
  // composed one whose runner carries no stop mark (the grace clause above only times a MARKED runner, which
  // is why this sits below it). F22: measured from `endingAt` — when ending BEGAN — never from the wall
  // clock, or a session stopped at minute 5 of a 300-minute booking would wait out its original deadline.
  // `deadlineOf` is the fallback for a row whose ending_at never landed, so the state stays bounded either way.
  if (s.state === "ending") {
    const since = s.endingAt ?? deadlineOf(s);
    if (now.getTime() - since.getTime() >= limits.endingTimeoutSeconds * 1000) return { kind: "ending_timeout" };
    return { kind: "none" };
  }
  // Every non-terminal state owes a timed exit (F16): a session stranded in `provisioning` — the create
  // returned but `provisioned` was never applied — has no other way out, and the Machine it did make
  // retries the internal heartbeat route forever. Below the grace clause on purpose: a stop already
  // MARKED on a creating runner (F15) is the stronger claim and keeps its own end reason.
  if (s.state === "provisioning") {
    if (now.getTime() - s.createdAt.getTime() >= limits.provisionTimeoutSeconds * 1000) return { kind: "provision_timeout" };
    return { kind: "none" };
  }
  if (s.state === "warming") {
    // A8 (capture QR v2 §5.3): from warming ENTRY, so provisioning time never eats the phone's pre-flight window. The
    // createdAt fallback is load-bearing: a session opened before V430 has no warming_at.
    if (now.getTime() - (s.warmingAt ?? s.createdAt).getTime() >= limits.warmingTimeoutMinutes * 60_000) return { kind: "warming_timeout" };
    return { kind: "none" };
  }
  // A playing runner owes a beat; so does a REPLACEMENT that is still booting
  // (the retry restarted the window through beatWindowAt — a replacement that never plays is lost too).
  // I2 (Task 2B review, orchestrator ruling — money/safety): so does every OTHER runner state in a live composed
  // session that still wants to be live and carries NO stop mark — destroyed awaiting its one retry (the process
  // died before `retry_runner` ran), a replacement stuck in `creating`, a `lost` one. Without this the stream is
  // dead but the session reads live, holding its credit and reservation, until the wall clock. A MARKED runner
  // stays the grace clause's; what `stale_beat` does to each runner state is the runner table's (Task 2C).
  const owesBeat = s.runner.state === "playing" || s.runner.state === "booting"
    || (s.desiredState === "live" && s.runner.stopRequestedAt === null);
  if (s.state === "live" && s.mode === "composed" && owesBeat) {
    // I4 (Task 2C ruling A): the window runs from the LATER of the last beat received and the window anchor a stale-beat
    // decision or a retry set — a null on either side ignored — then the started_at ?? created_at fallback as before.
    const beatAt = laterOf(s.heartbeatAt, s.beatWindowAt) ?? s.startedAt ?? s.createdAt;
    if (now.getTime() - beatAt.getTime() >= limits.staleHeartbeatSeconds * 1000) return { kind: "stale_beat" };
  }
  return { kind: "none" };
}
