// The tier-name guard, and the day metrics reaching the response.
//
// `solveBuild` does not return the placement service's board because the
// service says so — it compares that board against the legalised greedy seed
// with `isStrictlyBetter` and ships the SEED when the candidate does not win
// (`build.ts`, `const improved = ...`). That gate is the last thing between an
// organiser and a worse board, and it is only as good as its ordering.
//
// WHY THIS FILE EXISTS. When the day-aware rungs landed in the service
// (2026-08-13), `isStrictlyBetter` was left ranking `placed → makespanMinutes →
// idleGap → imbalance` — the retired ladder — and the `already_optimal` gate
// still keyed on a bare tier COUNT. Two silent consequences:
//
//   * the solver's `day_start` rung deliberately BUYS an earlier day start with
//     a worse idle gap (production board: 132 600 000 → 170 400 000 ms), so a
//     day-anchored board could lose the comparison and be discarded for the
//     greedy seed — the change's entire benefit thrown away on exactly the
//     boards it was written for;
//   * and a reply from a service running a DIFFERENT six-rung ladder would have
//     its `tiers_completed: 6` read as a full proof of ours, which is the live
//     hazard while two separately deployed apps disagree about the ladder.
//
// Both were found by review rather than by a test, because nothing drove a
// board where the two ladders disagree. The ORDERING itself is pinned rung by
// rung in `build-objectives.test.ts`; what this file pins is the WIRING — that
// the gate is handed a day view at all, and that the name check is real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSchedule, TIER_COUNT, TIER_NAMES } from "./build.ts";
import type { SchedulableFixture, SlotConfig } from "./calendar.ts";
import type { SolveBuildOutcome } from "./placement-client.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 7, 8, 9, 0);

const config: SlotConfig & { courts: string[] } = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 240 * MIN },
  tz: "Europe/London",
};

/** The measured corner (borrowed from `build-polish.test.ts`): one court, a
 *  start window only `b` can use. Greedy takes 09:00 for `a` and is left with
 *  nowhere legal for `b`, so it returns a ONE-card board; the solver places
 *  both. That gap on `placed` is what carries the solver's board past the gate,
 *  which is what makes it usable for testing what the gate MEASURES. */
const cornerConfig: SlotConfig & { courts: string[] } = {
  ...config,
  courts: ["C1"],
  sessionWindows: [{ from: T0, to: T0 + 60 * MIN }],
  constraints: {
    noBackToBack: false,
    fieldFairness: "off",
    parallelism: "mixed",
    crossPersonClash: "warn",
    startWindows: [{ target: { kind: "entrant", id: "E3" }, notAfter: T0 }],
  },
};
const cornerFixtures: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2" },
  { id: "b", roundNo: 1, home: "E3", away: "E4" },
];

/** Two cards locked onto the one 09:00 row: nothing for the solver to place and
 *  nothing to improve, so the run reaches the `!improved` branch — the only
 *  place `already_optimal` is reachable from. */
const optimal: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2", locked: { court: "C1", startAt: T0 } },
  { id: "b", roundNo: 1, home: "E3", away: "E4", locked: { court: "C2", startAt: T0 } },
];

const reply = (
  assignments: SolveBuildOutcome["assignments"],
  names: readonly string[] = TIER_NAMES,
): SolveBuildOutcome => ({
  assignments,
  status: "OPTIMAL",
  tiersCompleted: TIER_COUNT,
  objectiveValues: names.map((name, i) => ({ name, value: i })),
  elapsedMs: 5,
  wallExhausted: false,
});

const stub = async (outcome: SolveBuildOutcome): Promise<void> => {
  vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(outcome);
};

describe("the day metrics reach the response", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the day view to boardMetrics, so a shipped board reports real day metrics", async () => {
    // `boardMetrics` day fields are 0 unless a `DayView` is passed, and 0 is a
    // legal value — an unwired call therefore does not throw or fail a type
    // check, it silently reports every board as touching no days at all. A
    // shipped board carrying non-zero day metrics is the observable proof that
    // the view reached the metric call.
    //
    // REPORTED, NOT RANKED. `isStrictlyBetter` deliberately does not read these
    // — see its own note, and the C2 follow-up in the release-2 index for why
    // mirroring the solver's ladder into the acceptance gate is a separate,
    // still-open task rather than something this change does.
    await stub(
      reply([
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
      ]),
    );

    const out = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });

    expect(out.engine).toBe("optimized");
    expect(out.metrics.placed).toBe(2);
    // Both cards are on one calendar day, 09:00 and 09:30 London.
    expect(out.metrics.daysUsed).toBe(1);
    expect(out.metrics.daySpanMinutes).toBe(60);
    expect(out.metrics.dayStartOffsetMinutes).toBe(0);
  });
});

describe("already_optimal requires OUR ladder, not merely a matching count", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses the claim when the reply names a different ladder of the same length", async () => {
    // The deploy hazard as a test. A COUNT cannot tell one ladder from another,
    // and the two apps ship separately. This reply is fully proved and
    // correctly counted, and names the RETIRED ladder with `makespan` where
    // `days` belongs.
    await stub(
      reply([], ["placed", "makespan", "idle_gap", "imbalance", "spare_one", "spare_two"]),
    );

    const out = await buildSchedule({ fixtures: optimal, config, frozen: ["a", "b"] });

    expect(out.status).not.toBe("already_optimal");
    // The count still says six, which is exactly why the count is not enough.
    expect(out.tiersCompleted).toBe(TIER_COUNT);
  });

  it("refuses the claim when the reply is short a rung it never named", async () => {
    // The other shape of the same hazard: right names, too few of them. A
    // service that proved four of six rungs must not be read as a full ladder.
    await stub(reply([], TIER_NAMES.slice(0, 4)));

    const out = await buildSchedule({ fixtures: optimal, config, frozen: ["a", "b"] });

    expect(out.status).not.toBe("already_optimal");
  });

  it("still claims already_optimal on our own ladder", async () => {
    // Without this the two above pass against a gate that simply never fires.
    await stub(reply([]));

    const out = await buildSchedule({ fixtures: optimal, config, frozen: ["a", "b"] });

    expect(out.status).toBe("already_optimal");
    expect(out.tiersCompleted).toBe(TIER_COUNT);
  });
});

// ---------------------------------------------------------------------------
// The acceptance gate itself (2026-08-13). The defect this file's own header
// PREDICTED, now driven.
// ---------------------------------------------------------------------------

/** `config.startAt` IS NOT THE SOLVER'S FLOOR, and that is the whole fixture.
 *
 *  The grid opens at `window.from`; greedy's cursor opens at
 *  `max(config.startAt, window.notBefore)` (`calendar.ts:759`). Set the window
 *  to midnight and `startAt` to 09:00 and the two producers legitimately see
 *  different first ticks — which is exactly what production does, where
 *  `applyWindow` floors the window at START-OF-DAY. Greedy's board then sits
 *  nine hours past the day's opening slot and the solver's does not.
 *
 *  The two boards are then IDENTICAL on every term `isStrictlyBetter` ranks —
 *  same `placed`, same 30-minute makespan, same zero idle gap, same zero court
 *  imbalance — and differ only on `dayStartOffsetMinutes`, a rung the solver
 *  optimises and that comparison cannot see. Measured on the real service in
 *  `schedule-polish-current`: 0 against 540. */
const dayOpenConfig: SlotConfig & { courts: string[] } = {
  ...config,
  tz: "UTC",
  startAt: Date.UTC(2026, 7, 8, 9, 0),
  window: { from: Date.UTC(2026, 7, 8, 0, 0), to: Date.UTC(2026, 7, 8, 23, 0) },
};
const DAY_OPEN = Date.UTC(2026, 7, 8, 0, 0);

/** Four distinct entrants, so no participant plays twice and `worstIdleGap` is
 *  0 on BOTH boards by construction rather than by luck — one fewer term that
 *  could accidentally separate them. */
const twoCards: SchedulableFixture[] = [
  { id: "a", roundNo: 1, home: "E1", away: "E2" },
  { id: "b", roundNo: 1, home: "E3", away: "E4" },
];

describe("the gate does not discard a board the service proved optimal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ships a proved board that beats the seed only on a rung isStrictlyBetter cannot see", async () => {
    // THE REGRESSION. Before this change the gate ranked
    // `placed → makespan → idleGap → imbalance`, so this reply — better on
    // `day_start`, tied on all four of those — lost to the greedy seed and was
    // thrown away. `engine` is the observable: "greedy" means the proved board
    // was discarded.
    await stub(
      reply([
        { fixtureId: "a", court: "C1", startAtMs: DAY_OPEN },
        { fixtureId: "b", court: "C2", startAtMs: DAY_OPEN },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig });

    expect(out.engine).toBe("optimized");
    expect(out.status).toBe("ok");
    expect(out.assignments.map((a) => a.startAt)).toEqual([DAY_OPEN, DAY_OPEN]);
    // The board that shipped opens the day it is on — the rung it won.
    expect(out.metrics.dayStartOffsetMinutes).toBe(0);
  });

  it("is a run the OLD ordering could not have separated", async () => {
    // The premise of the spec above, asserted rather than assumed, so it cannot
    // quietly become a test about a board that simply wins on makespan too.
    // This run takes the greedy fallback, so `out.metrics` IS the seed's.
    vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockRejectedValue(
      new Error("no service"),
    );

    const seed = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig });

    expect(seed.engine).toBe("greedy");
    // Greedy opens at `startAt`, nine hours after the day's first slot.
    expect(seed.metrics.dayStartOffsetMinutes).toBe(0); // no DayView on the seed's own metrics
    expect(seed.assignments.map((a) => a.startAt)).toEqual([
      dayOpenConfig.startAt,
      dayOpenConfig.startAt,
    ]);
    // The four terms the retired comparison ranked, all tied against the
    // proved board above — which is why it could only ever have kept the seed.
    expect(seed.metrics.placed).toBe(2);
    expect(seed.metrics.makespanMinutes).toBe(30);
    expect(seed.metrics.worstIdleGapMinutes).toBe(0);
    expect(seed.metrics.courtImbalanceMinutes).toBe(0);
  });

  it("keeps the seed when the proved board only rearranges it", async () => {
    // THE OTHER DIRECTION, and it is not hypothetical: on
    // `schedule-solver-telemetry`'s one-fixture board the service returns a
    // bare COURT SWAP — same instant, every rung byte-identical. Trusting the
    // proof must not mean shipping churn, so the tie is decided on the LADDER:
    // nothing to gain, keep the board the organiser already had.
    //
    // Board IDENTITY is the wrong predicate here and this spec is what says so.
    // These two boards are not the same board — `a` and `b` swap courts — so a
    // gate comparing assignments ships this reply, reports `ok`, and moves
    // every card on a board nothing improved.
    await stub(
      reply([
        { fixtureId: "a", court: "C2", startAtMs: dayOpenConfig.startAt },
        { fixtureId: "b", court: "C1", startAtMs: dayOpenConfig.startAt },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig });

    expect(out.engine).toBe("greedy");
    expect(out.status).toBe("already_optimal");
    // Greedy's own courts, untouched — the swap did not ship.
    expect(out.assignments.find((a) => a.fixtureId === "a")?.court).toBe("C1");
  });

  it("still refuses a proved board that places fewer than the seed", async () => {
    // D6's floor, unchanged and checked before the proof in every arm: no
    // amount of proof outranks placing fewer fixtures.
    await stub(reply([{ fixtureId: "a", court: "C1", startAtMs: DAY_OPEN }]));

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig });

    expect(out.engine).toBe("greedy");
    expect(out.metrics.placed).toBe(2);
  });

  it("reports moved 0 for a BUILD, even now that the solver's board ships", async () => {
    // `moved`'s baseline used to be greedy's own seed, which read as zero only
    // because every no-`current` exit RETURNED that seed. The spec above breaks
    // that coincidence: the solver's board ships, and against an invented
    // baseline this would report "2 matches moved" on a fresh full pass — the
    // meaningless number R20 warns about, and the one
    // `schedule-polish-current`'s "does not anchor a BUILD" spec exists to
    // refuse. Nothing to have moved FROM is zero, exactly as `lost` already is.
    await stub(
      reply([
        { fixtureId: "a", court: "C1", startAtMs: DAY_OPEN },
        { fixtureId: "b", court: "C2", startAtMs: DAY_OPEN },
      ]),
    );

    const out = await buildSchedule({ fixtures: twoCards, config: dayOpenConfig });

    expect(out.engine).toBe("optimized");
    expect(out.moved).toBe(0);
    expect(out.lost).toBe(0);
  });
});
