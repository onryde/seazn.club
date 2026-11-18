// W5 app PR A, Task 13 (X-PO-3 <- RB5-P5, X-PO-4 <- RB5-P7): the pure decisions of the rank override. The database-backed behaviour is
// `server/usecases/__tests__/rank-override-pool.test.ts`; this pins the rules where no database is needed, the empty cases included.
import { describe, expect, it } from "vitest";
import { changedPools, pinsSurvivingRedraw, planRankOverride, reportsRankOverrides, type StageSeating } from "../rank-override";

/** Two pools of three: a1 a2 a3 in "A", b1 b2 b3 in "B". */
const TWO_POOLS: StageSeating = {
  seated: true,
  poolOf: new Map([["a1", "A"], ["a2", "A"], ["a3", "A"], ["b1", "B"], ["b2", "B"], ["b3", "B"]]),
  sizeOf: new Map([["A", 3], ["B", 3]]),
};
const LEAGUE: StageSeating = { seated: true, poolOf: new Map([["x", null], ["y", null]]), sizeOf: new Map([[null, 2]]) };
const UNDRAWN: StageSeating = { seated: false, poolOf: new Map(), sizeOf: new Map() };

describe("planRankOverride (RB5-P5)", () => {
  it("the same rank in two pools is fine; in one pool it is a duplicate", () => {
    expect(planRankOverride([], [{ entrant_id: "a1", rank: 1 }, { entrant_id: "b1", rank: 1 }], TWO_POOLS)).toEqual({
      ok: true,
      pins: [{ entrant_id: "a1", rank: 1, pool_id: "A" }, { entrant_id: "b1", rank: 1, pool_id: "B" }],
    });
    expect(planRankOverride([], [{ entrant_id: "a1", rank: 2 }, { entrant_id: "a2", rank: 2 }], TWO_POOLS)).toEqual({ ok: false, reason: "duplicate", pool_id: "A", rank: 2 });
  });
  it("a rank above the pool's size is refused, the size itself is not; the bound is the pool's, not the field's", () => {
    expect(planRankOverride([], [{ entrant_id: "a1", rank: 4 }], TWO_POOLS)).toEqual({ ok: false, reason: "above_size", pool_id: "A", rank: 4, size: 3 });
    expect(planRankOverride([], [{ entrant_id: "a1", rank: 3 }], TWO_POOLS).ok).toBe(true);
    expect(planRankOverride([], [{ entrant_id: "x", rank: 3 }], LEAGUE)).toEqual({ ok: false, reason: "above_size", pool_id: null, rank: 3, size: 2 });
  });
  it("an entrant with no seat in a drawn stage is refused; in an undrawn stage the body stands as one table, unchecked for size", () => {
    expect(planRankOverride([], [{ entrant_id: "nobody", rank: 1 }], TWO_POOLS)).toEqual({ ok: false, reason: "unseated", entrant_id: "nobody" });
    expect(planRankOverride([], [{ entrant_id: "nobody", rank: 99 }], UNDRAWN)).toEqual({ ok: true, pins: [{ entrant_id: "nobody", rank: 99, pool_id: null }] });
  });
  it("a second body replaces only the pools it names; an old pin with no pool_id is placed by its entrant's pool", () => {
    const existing = [{ entrant_id: "a1", rank: 1, pool_id: "A" }, { entrant_id: "b1", rank: 1 }, { entrant_id: "b2", rank: 2, pool_id: "B" }];
    const plan = planRankOverride(existing, [{ entrant_id: "b3", rank: 3 }], TWO_POOLS);
    expect(plan).toEqual({ ok: true, pins: [{ entrant_id: "a1", rank: 1, pool_id: "A" }, { entrant_id: "b3", rank: 3, pool_id: "B" }] });
  });
  it("an empty body changes nothing (the empty case)", () => {
    const existing = [{ entrant_id: "a1", rank: 1, pool_id: "A" }];
    expect(planRankOverride(existing, [], TWO_POOLS)).toEqual({ ok: true, pins: existing });
    expect(planRankOverride([], [], TWO_POOLS)).toEqual({ ok: true, pins: [] });
  });
});

describe("a redraw (G7)", () => {
  const members = (o: Record<string, string[]>) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  it("changedPools: same members in another order is unchanged; a grown, shrunk, swapped or vanished pool is changed", () => {
    const before = members({ A: ["1", "2"], B: ["3", "4"], C: ["5", "6"], D: ["7", "8"] });
    const after = members({ A: ["2", "1"], B: ["3", "4", "9"], C: ["5", "7"] });
    expect([...changedPools(before, after)].sort()).toEqual(["B", "C", "D"]);
    expect(changedPools(before, before).size, "nothing moved").toBe(0);
    expect(changedPools(new Map(), new Map()).size, "empty").toBe(0);
  });
  it("pinsSurvivingRedraw: a changed pool's pins go (an old pin by its entrant's earlier pool), an unchanged pool's and an unplaceable pin stay", () => {
    const pins = [{ entrant_id: "a", rank: 1, pool_id: "A" }, { entrant_id: "b", rank: 1, pool_id: "B" }, { entrant_id: "c", rank: 2 }, { entrant_id: "d", rank: 2 }];
    const kept = pinsSurvivingRedraw(pins, new Set(["B"]), new Map([["c", "B"]]));
    expect(kept.map((p) => p.entrant_id)).toEqual(["a", "d"]);
    expect(pinsSurvivingRedraw([], new Set(["B"]), new Map())).toEqual([]);
  });
});

describe("reportsRankOverrides (RB5-P7)", () => {
  it("only a table stage with stored pins reports them", () => {
    expect(reportsRankOverrides("league", true)).toBe(true);
    expect(reportsRankOverrides("knockout", true)).toBe(false);
    expect(reportsRankOverrides("league", false)).toBe(false);
    expect(reportsRankOverrides("league", null)).toBe(false);
  });
});
