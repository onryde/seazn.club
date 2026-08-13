// The acceptance gate, and the two ways it can lie after a ladder change.
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

describe("the acceptance gate measures the rungs the solver optimises", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the day view to boardMetrics, so a shipped board reports real day metrics", async () => {
    // THE WIRING, and it is the half a unit test of `isStrictlyBetter` cannot
    // reach. `boardMetrics`' day fields are 0 unless a `DayView` is passed, and
    // 0 is a legal value — an unwired gate therefore does not throw or fail a
    // type check, it silently scores every board `daysUsed: 0` and compares
    // ladders that are all ties. Worse, the seed's metrics are computed before
    // this run has a grid: if the gate compared THOSE against a day-aware
    // candidate, the seed would win `days` automatically by never having been
    // measured, and every solver board on every board would be discarded.
    //
    // A shipped board carrying non-zero day metrics is the observable proof
    // that the view reached the metric call.
    await stub(
      reply([
        { fixtureId: "b", court: "C1", startAtMs: T0 },
        { fixtureId: "a", court: "C1", startAtMs: T0 + 30 * MIN },
      ]),
    );

    const out = await buildSchedule({ fixtures: cornerFixtures, config: cornerConfig });

    // The solver's board shipped — `engine` names where the board came from.
    expect(out.engine).toBe("optimized");
    expect(out.metrics.placed).toBe(2);
    // Both cards are on one calendar day, 09:00 and 09:30 London.
    expect(out.metrics.daysUsed).toBe(1);
    expect(out.metrics.daySpanMinutes).toBe(60);
    // The day opens at the first admissible tick and the board starts there.
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
