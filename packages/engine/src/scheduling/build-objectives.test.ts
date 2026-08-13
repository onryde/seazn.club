import { describe, expect, it } from "vitest";
import { boardMetrics, isStrictlyBetter } from "./build-objectives.ts";
import { TIER_NAMES } from "./build.ts";
import type { Assignment } from "./calendar.ts";

const T0 = Date.UTC(2026, 7, 8, 9, 0);
const MIN = 60_000;

const card = (id: string, court: string, startMin: number, durMin = 30, entrants: string[] = [], people: string[] = []): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + startMin * MIN,
  endAt: T0 + (startMin + durMin) * MIN,
  entrants,
  people,
});

describe("boardMetrics", () => {
  it("reports zero for an empty board", () => {
    expect(boardMetrics([], ["C1"], 0)).toEqual({
      daysUsed: 0, daySpanMinutes: 0, dayStartOffsetMinutes: 0,
      makespanMinutes: 0, worstIdleGapMinutes: 0, courtImbalanceMinutes: 0, placed: 0, total: 0,
    });
  });

  it("makespan spans earliest start to latest end", () => {
    const m = boardMetrics([card("a", "C1", 0), card("b", "C1", 60)], ["C1"], 2);
    expect(m.makespanMinutes).toBe(90);
  });

  it("worst idle gap is measured per entrant, between consecutive matches", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 120, 30, ["E1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(90); // 30 -> 120
  });

  it("counts a person's gap as well as an entrant's", () => {
    const m = boardMetrics(
      [card("a", "C1", 0, 30, [], ["p1"]), card("b", "C2", 200, 30, [], ["p1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(170);
  });

  it("never merges an entrant with a person that shares its id string", () => {
    // `entrants` is EntrantId[] and `people` is string[], but both are plain
    // strings at runtime, so the `e:` / `p:` key prefixes inside boardMetrics
    // are load-bearing. Drop them and these two cards collapse into ONE
    // participant chain that reports a fabricated 470-minute wait.
    const m = boardMetrics(
      [card("a", "C1", 0, 30, ["X1"]), card("b", "C2", 500, 30, [], ["X1"])],
      ["C1", "C2"], 2,
    );
    expect(m.worstIdleGapMinutes).toBe(0);
  });

  it("is zero when nobody plays twice", () => {
    const m = boardMetrics([card("a", "C1", 0, 30, ["E1"]), card("b", "C2", 500, 30, ["E2"])], ["C1", "C2"], 2);
    expect(m.worstIdleGapMinutes).toBe(0);
  });

  it("court imbalance counts an unused configured court as zero minutes", () => {
    const m = boardMetrics([card("a", "C1", 0, 30), card("b", "C1", 60, 30)], ["C1", "C2"], 2);
    expect(m.courtImbalanceMinutes).toBe(60);
  });

  it("counts a court the board uses but the config omits", () => {
    // Two courts must reach `mins` for this to constrain anything: the
    // configured-but-unused C1 at 0, and the unconfigured-but-used CX at 30.
    // A version that only ever measured the configured courts would see
    // [0] and report 0; one that only measured used courts would see [30]
    // and also report 0. Only counting BOTH gives 30.
    const m = boardMetrics([card("a", "CX", 0, 30)], ["C1"], 1);
    expect(m.courtImbalanceMinutes).toBe(30);
  });
});

describe("isStrictlyBetter", () => {
  const base = {
    daysUsed: 3, daySpanMinutes: 300, dayStartOffsetMinutes: 60,
    makespanMinutes: 100, worstIdleGapMinutes: 50, courtImbalanceMinutes: 20, placed: 10, total: 10,
  };

  it("prefers more placed above everything", () => {
    expect(isStrictlyBetter({ ...base, placed: 11, makespanMinutes: 999 }, base)).toBe(true);
  });

  // THE LADDER, rung by rung. Each case makes the rung under test better and
  // everything BELOW it worse, so it can only pass if that rung outranks them.
  //
  // These replace a `prefers a shorter makespan over a fairer board` case that
  // encoded the pre-2026-08-13 order. Whole-board makespan is no longer the
  // second rung — it is no longer a rung at all, only the last tie-break — and
  // that is the entire point of the change: the solver stopped optimising it,
  // so a gate that ranked on it discarded boards the solver had proved optimal.

  it("prefers fewer days used over every board metric below it", () => {
    expect(
      isStrictlyBetter(
        { ...base, daysUsed: 2, daySpanMinutes: 999, dayStartOffsetMinutes: 999, worstIdleGapMinutes: 999, makespanMinutes: 999 },
        base,
      ),
    ).toBe(true);
    expect(isStrictlyBetter({ ...base, daysUsed: 4, daySpanMinutes: 0 }, base)).toBe(false);
  });

  it("prefers a tighter summed day span over a fairer board", () => {
    expect(
      isStrictlyBetter({ ...base, daySpanMinutes: 200, worstIdleGapMinutes: 999, makespanMinutes: 999 }, base),
    ).toBe(true);
    expect(isStrictlyBetter({ ...base, daySpanMinutes: 400, worstIdleGapMinutes: 0 }, base)).toBe(false);
  });

  it("prefers an earlier day start over a fairer board — the trade day_start exists to make", () => {
    // The rung deliberately BUYS an earlier start with a worse idle gap; that
    // is what "day_start outranks idle_gap" means, and on the production board
    // it costs 132 600 000 -> 170 400 000 ms of idle gap. A gate that ranked
    // idle gap first would discard exactly the board the rung produces.
    expect(
      isStrictlyBetter({ ...base, dayStartOffsetMinutes: 0, worstIdleGapMinutes: 999 }, base),
    ).toBe(true);
    expect(isStrictlyBetter({ ...base, dayStartOffsetMinutes: 120, worstIdleGapMinutes: 0 }, base)).toBe(false);
  });

  it("ranks whole-board makespan LAST, below every rung the solver optimises", () => {
    // Better makespan cannot buy a worse rung...
    expect(isStrictlyBetter({ ...base, makespanMinutes: 1, daysUsed: 4 }, base)).toBe(false);
    expect(isStrictlyBetter({ ...base, makespanMinutes: 1, courtImbalanceMinutes: 21 }, base)).toBe(false);
    // ...but it still breaks an otherwise exact tie, which is what keeps
    // `improveByWindows` (no day view, so every day term ties there) able to
    // tell a board that got longer from one that did not.
    expect(isStrictlyBetter({ ...base, makespanMinutes: 90 }, base)).toBe(true);
    expect(isStrictlyBetter({ ...base, makespanMinutes: 110 }, base)).toBe(false);
  });

  it("prefers a fairer board over a balanced one", () => {
    expect(isStrictlyBetter({ ...base, worstIdleGapMinutes: 40, courtImbalanceMinutes: 999 }, base)).toBe(true);
  });

  it("matches the placement service's TIER_ORDER, name for name and in order", () => {
    // The gate and the solver's chain are ONE ordering expressed twice — a
    // rung here that the placer does not optimise throws away proved boards,
    // and vice versa. `TIER_NAMES` is the shared vocabulary; this pins the
    // comparator against it so a future ladder change cannot move one side
    // only. `placed` is the maximised rung and has no board-metric ordering
    // pair below, so it is asserted separately above.
    expect([...TIER_NAMES]).toEqual([
      "placed",
      "days",
      "day_span",
      "day_start",
      "idle_gap",
      "imbalance",
    ]);
  });

  it("is false for an identical board", () => {
    expect(isStrictlyBetter(base, base)).toBe(false);
  });
});
