// The expiry policy (design §6.4 timeouts; recommendation B: it runs lazily
// on every read, so it must be pure and cheap). Thresholds from config.ts;
// each asserted at T−1 s (none) and T (fires). Mutants: `>=`→`>` on any rule
// → that rule's boundary row red; ADD a retries check (`runnerRetries < 1`) →
// the "regardless of attempt" row red (the retry cap is the runner table's, Task 2C).
import { describe, expect, it } from "vitest";
import { ENDING_TIMEOUT_SECONDS, MAX_DURATION_MINUTES, PROVISION_TIMEOUT_SECONDS, REQUESTED_TIMEOUT_SECONDS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS, STALE_HEARTBEAT_SECONDS, WARMING_TIMEOUT_MINUTES } from "../../config";
import { ACTIVE_STATES } from "../session";
import { DEFAULT_LIMITS, deadlineOf, evaluate, type Expiry } from "../expiry";
import { RUNNER_NONE, RUNNER_STATES, type Runner, type RunnerState } from "../runner";
import { decide, type Session } from "../session";

const T0 = new Date("2026-09-14T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const PLAYING: Runner = { state: "playing", attempt: 1, name: "relay-s1-r1", machineId: "m1", stopRequestedAt: null, lastExit: null };
const S = (over: Partial<Session> = {}): Session => ({
  id: "s1", fixtureId: "f1", orgId: "o1", mode: "passthrough", state: "warming", desiredState: "live",
  failReason: null, endReason: null, runner: RUNNER_NONE, runnerRetries: 0, createdAt: T0, startedAt: null, endedAt: null,
  heartbeatAt: null, beatWindowAt: null, endingAt: null, maxDurationMinutes: MAX_DURATION_MINUTES, ...over,
});

describe("evaluate", () => {
  // Fix round 1 (M3): the rows are PASSTHROUGH with RUNNER_NONE, and the title now says so — a COMPOSED terminal row
  // with a marked runner is not covered here (C27; Task 2C's rows).
  it("terminal PASSTHROUGH → none: a finished passthrough session owns no timer, completed and failed alike", () => {
    expect(evaluate(S({ state: "completed" }), at(1e6))).toEqual({ kind: "none" });
    expect(evaluate(S({ state: "failed" }), at(1e6))).toEqual({ kind: "none" });
  });
  it("every NON-terminal state owns a timed exit — walked from ACTIVE_STATES, never a typed list (F16 / F18 / F19)", () => {
    const far = at(MAX_DURATION_MINUTES * 60 + ENDING_TIMEOUT_SECONDS + 1);
    for (const state of ACTIVE_STATES) {
      const early = state === "requested" || state === "provisioning";
      const s = S({ state, startedAt: early ? null : T0, endReason: state === "ending" ? "stopped" : null });
      expect(evaluate(s, far).kind, state).not.toBe("none");
    }
    expect(ACTIVE_STATES.length).toBeGreaterThanOrEqual(5);   // requested, provisioning, warming, live, ending — not vacuous
  });
  it("requested ≥ REQUESTED_TIMEOUT_SECONDS → requested_timeout at the threshold, none one second before; it feeds decide as failed(admission_timeout) with no end reason (F18)", () => {
    const r = S({ state: "requested" });
    expect(evaluate(r, at(REQUESTED_TIMEOUT_SECONDS - 1))).toEqual({ kind: "none" });
    expect(evaluate(r, at(REQUESTED_TIMEOUT_SECONDS))).toEqual({ kind: "requested_timeout" });
    const d = decide(r, { type: "expire", expiry: { kind: "requested_timeout" } }, at(REQUESTED_TIMEOUT_SECONDS));
    expect(d.next).toMatchObject({ state: "failed", failReason: "admission_timeout", endReason: null });
    expect(d.effects).toEqual([]);                            // no provider was ever called
    // it is THAT state's rule, not a clock on every session: a warming one of the same age is untouched
    expect(evaluate(S({ state: "warming" }), at(REQUESTED_TIMEOUT_SECONDS))).toEqual({ kind: "none" });
  });
  it("the ending timer runs from ending_at, NOT the wall clock — a session stopped EARLY is swept ENDING_TIMEOUT_SECONDS after ending began (F22)", () => {
    // Stopped at minute 5 of a 300-minute booking: the original deadline is hours away.
    const early = S({ state: "ending", desiredState: "ending", endReason: "stopped", startedAt: T0, endingAt: at(300) });
    expect(evaluate(early, at(300 + ENDING_TIMEOUT_SECONDS - 1))).toEqual({ kind: "none" });
    expect(evaluate(early, at(300 + ENDING_TIMEOUT_SECONDS))).toEqual({ kind: "ending_timeout" });
    // …and that instant is FAR before the wall clock the rule must not be reading.
    expect(at(300 + ENDING_TIMEOUT_SECONDS).getTime()).toBeLessThan(deadlineOf(early).getTime());
    // the stop mark still outranks it
    const marked = S({ state: "ending", mode: "composed", startedAt: T0, endingAt: at(300), runner: { ...PLAYING, state: "stopping", stopRequestedAt: at(300) } });
    expect(evaluate(marked, at(300 + ENDING_TIMEOUT_SECONDS))).toEqual({ kind: "grace_expired" });
  });
  it("ending past deadlineOf + ENDING_TIMEOUT_SECONDS → ending_timeout, and decide COMPLETES it — a lost complete_now cannot strand a passthrough session (F19)", () => {
    // These rows carry NO ending_at (a row whose transition write lost it): the deadlineOf fallback bounds them.
    const bound = MAX_DURATION_MINUTES * 60 + ENDING_TIMEOUT_SECONDS;
    const e = S({ state: "ending", desiredState: "ending", endReason: "stopped", startedAt: T0 });
    expect(evaluate(e, at(bound - 1))).toEqual({ kind: "none" });
    expect(evaluate(e, at(bound))).toEqual({ kind: "ending_timeout" });
    const d = decide(e, { type: "expire", expiry: { kind: "ending_timeout" } }, at(bound));
    expect(d.next).toMatchObject({ state: "completed", endReason: "stopped", endedAt: at(bound) });
    expect(d.effects).toEqual([{ type: "fill_replay" }]);
    // a MARKED runner stays the stop grace's business, and that fires first
    const marked = S({ state: "ending", mode: "composed", runner: { ...PLAYING, state: "stopping", stopRequestedAt: T0 }, startedAt: T0 });
    expect(evaluate(marked, at(bound))).toEqual({ kind: "grace_expired" });
    // and a composed session still holding a stoppable Machine sends the stop rather than completing blind
    const stoppable = S({ state: "ending", desiredState: "ending", endReason: "stopped", mode: "composed", runner: PLAYING, startedAt: T0 });
    const t = decide(stoppable, { type: "expire", expiry: { kind: "ending_timeout" } }, at(bound));
    expect(t.next).toMatchObject({ state: "ending", runner: { state: "stopping", stopRequestedAt: at(bound) } });
    expect(t.effects).toEqual([{ type: "runner", effect: { type: "stop_machine", signal: "SIGINT", timeoutSeconds: RUNNER_STOP_GRACE_SECONDS } }]);
  });
  it("provisioning ≥ PROVISION_TIMEOUT_SECONDS → provision_timeout at the threshold, none one second before; it feeds decide as failed(provision_timeout) with NO end reason (P1-F-b)", () => {
    const p = S({ state: "provisioning" });
    expect(evaluate(p, at(PROVISION_TIMEOUT_SECONDS - 1))).toEqual({ kind: "none" });
    expect(evaluate(p, at(PROVISION_TIMEOUT_SECONDS))).toEqual({ kind: "provision_timeout" });
    // a MARKED create outranks it — F15's grace keeps its own end reason. (Task 2B: moved ABOVE the composed
    // decide below, which reaches Task 2A's throwing stepRunner stub until Task 2C — behind it, this row was
    // unreachable and the "provisioning block above the grace clause" mutant survived.)
    const marked = S({ state: "provisioning", mode: "composed", runner: { ...PLAYING, state: "creating", machineId: null, stopRequestedAt: T0 } });
    expect(evaluate(marked, at(PROVISION_TIMEOUT_SECONDS))).toEqual({ kind: "grace_expired" });
    // a passthrough session in provisioning has no Machine to tear down (fix round 1, M1: moved ABOVE the composed decide
    // for the same reason as `marked` — it needs no runner, and behind the stub call it could not run until Task 2C)
    expect(decide(p, { type: "expire", expiry: { kind: "provision_timeout" } }, at(PROVISION_TIMEOUT_SECONDS)).effects).toEqual([]);
    // F16's stranded session: the create returned, `provisioned` never landed, and the Machine beats forever.
    const c = S({ state: "provisioning", mode: "composed", runner: { ...PLAYING, state: "booting" } });
    const d = decide(c, { type: "expire", expiry: evaluate(c, at(PROVISION_TIMEOUT_SECONDS)) }, at(PROVISION_TIMEOUT_SECONDS));
    expect(d.next).toMatchObject({ state: "failed", failReason: "provision_timeout", endReason: null });
    expect(d.effects).toEqual([{ type: "runner", effect: { type: "stop_machine", signal: "SIGINT", timeoutSeconds: RUNNER_STOP_GRACE_SECONDS } }]);
  });
  it("warming ≥ 10 min → warming_timeout at the threshold, none one second before", () => {
    expect(evaluate(S(), at(WARMING_TIMEOUT_MINUTES * 60 - 1))).toEqual({ kind: "none" });
    expect(evaluate(S(), at(WARMING_TIMEOUT_MINUTES * 60))).toEqual({ kind: "warming_timeout" });
  });
  it("live: wall clock from started_at ≥ max_duration → wall_clock (boundary both sides); warming measures from created_at", () => {
    const live = S({ state: "live", startedAt: at(60) });
    expect(evaluate(live, at(60 + MAX_DURATION_MINUTES * 60 - 1))).toEqual({ kind: "none" });
    expect(evaluate(live, at(60 + MAX_DURATION_MINUTES * 60))).toEqual({ kind: "wall_clock" });
    // Fix round 1 (M3): the warming half of the title had no row. A warming session has no started_at, so the wall clock
    // runs from created_at. Under the default 10-minute warming timeout it can only be seen OUTRANKING that timeout;
    // with a long injected warming timeout its own boundary shows on both sides.
    const warming = S({ state: "warming" });
    expect(evaluate(warming, at(MAX_DURATION_MINUTES * 60))).toEqual({ kind: "wall_clock" });
    const LONG_WARMING = { ...DEFAULT_LIMITS, warmingTimeoutMinutes: MAX_DURATION_MINUTES * 2 };
    expect(evaluate(warming, at(MAX_DURATION_MINUTES * 60 - 1), LONG_WARMING)).toEqual({ kind: "none" });
    expect(evaluate(warming, at(MAX_DURATION_MINUTES * 60), LONG_WARMING)).toEqual({ kind: "wall_clock" });
  });
  it("live composed with a PLAYING runner and a stale beat → stale_beat regardless of attempt (the table decides retry vs fail); passthrough never (no Machine)", () => {
    const c = S({ state: "live", mode: "composed", runner: PLAYING, startedAt: T0, heartbeatAt: T0 });
    expect(evaluate(c, at(STALE_HEARTBEAT_SECONDS - 1))).toEqual({ kind: "none" });
    expect(evaluate(c, at(STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
    expect(evaluate({ ...c, runnerRetries: 1, runner: { ...PLAYING, attempt: 2 } }, at(STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
    expect(evaluate(S({ state: "live", startedAt: T0, heartbeatAt: null }), at(STALE_HEARTBEAT_SECONDS * 10))).toEqual({ kind: "none" });
    // …and it is the MODE that rules, not the runner state: the same playing runner on a passthrough row owes no beat
    // (Task 2B: the row above carries RUNNER_NONE, so dropping the mode check survived it)
    expect(evaluate({ ...c, mode: "passthrough" }, at(STALE_HEARTBEAT_SECONDS * 10))).toEqual({ kind: "none" });
    // a REPLACEMENT still booting in a live session owes a beat too (a replacement that never plays is lost)
    expect(evaluate({ ...c, runner: { ...PLAYING, state: "booting", attempt: 2 } }, at(STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
    // Fix round 1 (I2 ruling): the brief's row here — "a runner in creating/stopping owes none", an UNMARKED creating
    // runner in a live session reading `none` at 900 s — froze the defect I2 closes. It is REMOVED, not loosened: the
    // idle runner states (creating included) now have their own test below, marked and unmarked.
  });
  it("a live composed session with NO beat yet measures staleness from started_at", () => {
    const c = S({ state: "live", mode: "composed", runner: PLAYING, startedAt: T0, heartbeatAt: null });
    expect(evaluate(c, at(STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
    // The differential (Task 2B: with startedAt === createdAt, measuring from created_at survived): a Machine that
    // took 60 s to boot is NOT stale one beat-window after it was created, only one beat-window after it went live.
    const booted = S({ state: "live", mode: "composed", runner: PLAYING, startedAt: at(60), heartbeatAt: null });
    expect(evaluate(booted, at(60 + STALE_HEARTBEAT_SECONDS - 1))).toEqual({ kind: "none" });
    expect(evaluate(booted, at(60 + STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
  });
  // Fix round 1 (M3): retitled to what the rows witness. The brief's title also claimed "ordered below wall clock",
  // which no row pins (review M2, DEFERRED by the orchestrator) — the claim is dropped here, not tested.
  it("grace_expired: a MARKED stopping/exited runner — and a MARKED creating one (F15) — past grace + observation slack, at the threshold and not one second before; it outranks the warming timeout", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    // `creating` is the F15 case: the process died between marking the stop and the Fly call returning.
    for (const state of ["stopping", "exited", "creating"] as const) {
      const s = S({ state: "ending", mode: "composed", runner: { ...PLAYING, state, stopRequestedAt: T0 }, startedAt: T0 });
      expect(evaluate(s, at(grace - 1)), state).toEqual({ kind: "none" });
      expect(evaluate(s, at(grace)), state).toEqual({ kind: "grace_expired" });
    }
    const w = S({ state: "warming", mode: "composed", runner: { ...PLAYING, state: "stopping", stopRequestedAt: T0 } });
    expect(evaluate(w, at(WARMING_TIMEOUT_MINUTES * 60))).toEqual({ kind: "grace_expired" });
  });
  // Fix round 1 (M3): split out of the grace test above, whose title did not describe these rows.
  it("grace_expired needs a COMPOSED session AND a stop MARK: a passthrough twin reads none, and an UNMARKED creating runner never reads grace_expired — none inside ending's window, the F19 ending_timeout past it", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    // The grace is a COMPOSED rule: `decide` refuses grace_expired on a passthrough session, so naming it there would
    // throw on every lazy read. Same marked runner, passthrough row, same instant → none (Task 2B: dropping the mode check survived).
    const passthrough = S({ state: "ending", runner: { ...PLAYING, state: "stopping", stopRequestedAt: T0 }, startedAt: T0 });
    expect(evaluate(passthrough, at(grace))).toEqual({ kind: "none" });
    // The mark is what starts the GRACE clock: an UNMARKED creating runner never reads grace_expired, however long the
    // create takes. Inside ending's own window it owes nothing, long past the grace; beyond that window the F19 backstop
    // (ending_timeout, from deadlineOf when ending_at is lost) bounds it — never the grace. Task 2B ruling: this row
    // read `none` at 1e6, which contradicts F19 ("a composed one whose runner carries no stop mark") and the
    // ACTIVE_STATES sweep above; the implementation text is the authority, so the row was corrected, not the code.
    const unmarked = S({ state: "ending", mode: "composed", runner: { ...PLAYING, state: "creating", machineId: null, stopRequestedAt: null } });
    expect(evaluate({ ...unmarked, endingAt: T0 }, at(ENDING_TIMEOUT_SECONDS - 1))).toEqual({ kind: "none" });
    expect(evaluate(unmarked, at(1e6))).toEqual({ kind: "ending_timeout" });
  });
  // Fix round 1 — I2 (Task 2B review; orchestrator ruling, money/safety). A live composed session that still wants to be
  // live, whose runner is NOT playing/booting and carries NO stop mark — destroyed awaiting its one retry (the process died
  // before `retry_runner` ran), a replacement stuck in `creating`, a `lost` one — is a dead stream still reading `live`,
  // holding its credit and its reservation until the 5 h wall clock. It is timed by the SAME stale-beat rule. This test pins
  // ONLY evaluate's answer: what stale_beat does to each runner state is the runner table's (Task 2C), and 2A's stub throws.
  it("a LIVE COMPOSED session wanting live whose runner is NOT playing/booting and UNMARKED (destroyed awaiting retry, creating, lost…) owes the beat: stale_beat at (heartbeatAt ?? startedAt) + STALE_HEARTBEAT_SECONDS, none 1 s before; marked / passthrough / desired-ending twins never read stale_beat; wall clock still outranks (I2)", () => {
    const beat = 60;   // heartbeatAt ≠ startedAt, so the anchor is witnessed (a retry restarts the window through beatWindowAt, I4)
    const idle = RUNNER_STATES.filter((r) => r !== "playing" && r !== "booting");   // walked, never a typed list
    expect(idle).toEqual(expect.arrayContaining(["destroyed", "creating", "lost"]));   // not vacuous: the ruled states are in it
    const GRACE_TIMED: readonly RunnerState[] = ["stopping", "exited", "creating"];
    for (const state of idle) {
      const s = S({ state: "live", mode: "composed", startedAt: T0, heartbeatAt: at(beat), runner: { ...PLAYING, state } });
      expect(evaluate(s, at(beat + STALE_HEARTBEAT_SECONDS - 1)), `${state} T−1`).toEqual({ kind: "none" });
      expect(evaluate(s, at(beat + STALE_HEARTBEAT_SECONDS)), `${state} T`).toEqual({ kind: "stale_beat" });
      // no beat since it went live: measured from started_at, both sides
      expect(evaluate({ ...s, heartbeatAt: null }, at(STALE_HEARTBEAT_SECONDS - 1)), `${state} from started_at T−1`).toEqual({ kind: "none" });
      expect(evaluate({ ...s, heartbeatAt: null }, at(STALE_HEARTBEAT_SECONDS)), `${state} from started_at T`).toEqual({ kind: "stale_beat" });
      // a stop-MARKED twin stays with the grace rule (which times only stopping/exited/creating) — never stale_beat
      const marked = { ...s, runner: { ...s.runner, stopRequestedAt: at(beat) } };
      expect(evaluate(marked, at(beat + STALE_HEARTBEAT_SECONDS)), `${state} marked`).toEqual({ kind: GRACE_TIMED.includes(state) ? "grace_expired" : "none" });
      // a passthrough twin has no Machine; a session that no longer wants to be live is not the beat's business
      expect(evaluate({ ...s, mode: "passthrough" }, at(beat + STALE_HEARTBEAT_SECONDS)), `${state} passthrough`).toEqual({ kind: "none" });
      expect(evaluate({ ...s, desiredState: "ending" }, at(beat + STALE_HEARTBEAT_SECONDS)), `${state} desired ending`).toEqual({ kind: "none" });
      // precedence unchanged: the wall clock still outranks
      expect(evaluate(s, at(MAX_DURATION_MINUTES * 60)), `${state} wall clock`).toEqual({ kind: "wall_clock" });
    }
    // playing/booting are UNCHANGED by the ruling: they owe the beat whatever desiredState says (only the idle states are gated)
    for (const state of ["playing", "booting"] as const) {
      const s = S({ state: "live", mode: "composed", desiredState: "ending", startedAt: T0, heartbeatAt: at(beat), runner: { ...PLAYING, state } });
      expect(evaluate(s, at(beat + STALE_HEARTBEAT_SECONDS)), `${state} desired ending`).toEqual({ kind: "stale_beat" });
    }
  });
  // Task 2C review I4, RULING option A (fix round 1): a stale-beat decision or a retry restarts the window through its OWN
  // anchor, beatWindowAt; heartbeatAt stays "last beat RECEIVED". The window runs from whichever is LATER, a null on either
  // side ignored, then the existing started_at ?? created_at fallback. Every order is a row, so min / either-side-only / a
  // `??` preference each red on one.
  it("I4: the stale beat is timed from the LATER of heartbeatAt and beatWindowAt (a null on either side ignored), falling back to startedAt ?? createdAt", () => {
    const rows: [string, Date | null, Date | null, number][] = [
      ["anchor later than the beat", at(60), at(120), 120],
      ["beat later than the anchor", at(120), at(60), 120],
      ["anchor only", null, at(120), 120],
      ["beat only", at(120), null, 120],
      ["neither: started_at", null, null, 30],
    ];
    for (const [label, heartbeatAt, beatWindowAt, from] of rows) {
      const s = S({ state: "live", mode: "composed", runner: PLAYING, startedAt: at(30), heartbeatAt, beatWindowAt });
      expect(evaluate(s, at(from + STALE_HEARTBEAT_SECONDS - 1)), `${label} T−1`).toEqual({ kind: "none" });
      expect(evaluate(s, at(from + STALE_HEARTBEAT_SECONDS)), `${label} T`).toEqual({ kind: "stale_beat" });
    }
    // and with no started_at either, created_at (T0)
    const unstarted = S({ state: "live", mode: "composed", runner: PLAYING, startedAt: null });
    expect(evaluate(unstarted, at(STALE_HEARTBEAT_SECONDS - 1))).toEqual({ kind: "none" });
    expect(evaluate(unstarted, at(STALE_HEARTBEAT_SECONDS))).toEqual({ kind: "stale_beat" });
  });
  it("wall clock outranks a stale beat (an over-long session ends, it is not retried)", () => {
    const c = S({ state: "live", mode: "composed", runner: PLAYING, startedAt: T0, heartbeatAt: T0 });
    expect(evaluate(c, at(MAX_DURATION_MINUTES * 60))).toEqual({ kind: "wall_clock" });
  });
  it("limits are injectable and default to config.ts", () => {
    const SHORT = { warmingTimeoutMinutes: 0, staleHeartbeatSeconds: 90, stopGraceSeconds: 30, provisionTimeoutSeconds: 1, requestedTimeoutSeconds: 1, endingTimeoutSeconds: 1 };
    expect(DEFAULT_LIMITS).toEqual({ warmingTimeoutMinutes: WARMING_TIMEOUT_MINUTES, staleHeartbeatSeconds: STALE_HEARTBEAT_SECONDS, stopGraceSeconds: RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS, provisionTimeoutSeconds: PROVISION_TIMEOUT_SECONDS, requestedTimeoutSeconds: REQUESTED_TIMEOUT_SECONDS, endingTimeoutSeconds: ENDING_TIMEOUT_SECONDS });
    expect(evaluate(S(), at(5), SHORT)).toEqual({ kind: "warming_timeout" });
    expect(evaluate(S({ state: "provisioning" }), at(5), SHORT)).toEqual({ kind: "provision_timeout" });
    expect(evaluate(S({ state: "requested" }), at(5), SHORT)).toEqual({ kind: "requested_timeout" });
  });
  it("deadlineOf = (started_at ?? created_at) + max_duration — the ONE hard-stop instant (recommendation B)", () => {
    expect(deadlineOf(S()).toISOString()).toBe(at(MAX_DURATION_MINUTES * 60).toISOString());
    expect(deadlineOf(S({ startedAt: at(30) })).toISOString()).toBe(at(30 + MAX_DURATION_MINUTES * 60).toISOString());
    // Fix round 1 (M5): the SESSION's own max_duration, never the constant — every fixture above carries the default,
    // so "always use MAX_DURATION_MINUTES" survived. A 90-minute booking stops at 90 minutes, not at 89 and not at 300.
    const booked90 = S({ state: "live", startedAt: T0, maxDurationMinutes: 90 });
    expect(deadlineOf(booked90).toISOString()).toBe(at(90 * 60).toISOString());
    expect(evaluate(booked90, at(89 * 60))).toEqual({ kind: "none" });
    expect(evaluate(booked90, at(90 * 60 - 1))).toEqual({ kind: "none" });
    expect(evaluate(booked90, at(90 * 60))).toEqual({ kind: "wall_clock" });
  });
  it("feeds decide: a passthrough wall clock ends with end_reason max_duration and completes now; none → identity (the composed routes are Task 2C's tests)", () => {
    const p = S({ state: "live", startedAt: T0 });
    const d = decide(p, { type: "expire", expiry: evaluate(p, at(MAX_DURATION_MINUTES * 60)) }, at(MAX_DURATION_MINUTES * 60));
    expect(d.next).toMatchObject({ state: "ending", endReason: "max_duration" });
    expect(d.effects).toEqual([{ type: "complete_now" }]);
    expect(decide(p, { type: "expire", expiry: { kind: "none" } }, T0).events).toEqual([]);
  });
  // Orchestrator ruling (Task 2B dispatch, V408): fixture_id is `on delete set null`. A deleted fixture must NOT
  // stop expiry — this policy is the backstop that ends an orphaned live stream, so it may never read fixtureId.
  it("a session whose fixture was DELETED (fixtureId null) expires exactly like one with a fixture — every expiry kind, same instant, same answer", () => {
    const grace = RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS;
    const cases: [Session, Date, Expiry["kind"]][] = [
      [S({ state: "requested" }), at(REQUESTED_TIMEOUT_SECONDS), "requested_timeout"],
      [S({ state: "provisioning" }), at(PROVISION_TIMEOUT_SECONDS), "provision_timeout"],
      [S({ state: "warming" }), at(WARMING_TIMEOUT_MINUTES * 60), "warming_timeout"],
      [S({ state: "live", startedAt: T0 }), at(MAX_DURATION_MINUTES * 60), "wall_clock"],
      [S({ state: "live", mode: "composed", runner: PLAYING, startedAt: T0, heartbeatAt: T0 }), at(STALE_HEARTBEAT_SECONDS), "stale_beat"],
      [S({ state: "ending", mode: "composed", runner: { ...PLAYING, state: "stopping", stopRequestedAt: T0 }, startedAt: T0 }), at(grace), "grace_expired"],
      [S({ state: "ending", desiredState: "ending", endReason: "stopped", startedAt: T0, endingAt: T0 }), at(ENDING_TIMEOUT_SECONDS), "ending_timeout"],
    ];
    for (const [s, now, kind] of cases) {
      const orphan = { ...s, fixtureId: null };
      expect(evaluate(orphan, now), `${s.state} ${kind}`).toEqual({ kind });
      expect(evaluate(orphan, now)).toEqual(evaluate({ ...s, fixtureId: "f1" }, now));
    }
    // not vacuous: the table names every kind the policy can return except none
    expect(new Set(cases.map(([, , k]) => k)).size).toBe(7);
    // …and the orphaned live stream actually ENDS: the wall clock feeds decide to ending(max_duration), fixtureId still null
    const orphanLive = S({ state: "live", startedAt: T0, fixtureId: null });
    const d = decide(orphanLive, { type: "expire", expiry: evaluate(orphanLive, at(MAX_DURATION_MINUTES * 60)) }, at(MAX_DURATION_MINUTES * 60));
    expect(d.next).toMatchObject({ state: "ending", endReason: "max_duration", fixtureId: null });
    expect(d.effects).toEqual([{ type: "complete_now" }]);
  });
});
