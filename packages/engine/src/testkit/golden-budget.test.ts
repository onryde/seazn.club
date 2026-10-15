// The sweep budget (golden-budget.ts) is arithmetic a test timeout hangs on, so it is pinned: it scales with the sport count, each
// kind of work costs what its constant says, and a count that is not a sport count is refused rather than read as zero.
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { SWEEP_MS_PER_SPORT, SWEEP_SLACK_MS, sweepBudget } from "./golden-budget.ts";

describe("sweepBudget — a sweep's time budget is stated from the work, so it moves with the registry", () => {
  const kinds = Object.keys(SWEEP_MS_PER_SPORT) as (keyof typeof SWEEP_MS_PER_SPORT)[];

  it("one more sport costs exactly one sport's work more, for every kind, and the default is the whole registry", () => {
    expect(kinds.length, "three kinds of work").toBe(3);
    for (const kind of kinds) {
      expect(sweepBudget(kind, builtinModules.length + 1) - sweepBudget(kind, builtinModules.length), kind).toBe(SWEEP_MS_PER_SPORT[kind]);
      expect(sweepBudget(kind), `${kind}: the default is the registry`).toBe(sweepBudget(kind, builtinModules.length));
      expect(sweepBudget(kind, 1), `${kind}: a single sport still pays the slack`).toBe(SWEEP_SLACK_MS + SWEEP_MS_PER_SPORT[kind]);
    }
  });

  it("the kinds are ordered by cost (reading a corpus < probing it < rebuilding its floor) and every budget leaves room above a bare vitest default", () => {
    expect(SWEEP_MS_PER_SPORT.read).toBeLessThan(SWEEP_MS_PER_SPORT.probe);
    expect(SWEEP_MS_PER_SPORT.probe).toBeLessThan(SWEEP_MS_PER_SPORT.build);
    for (const kind of kinds) expect(sweepBudget(kind), kind).toBeGreaterThan(5_000);
  });

  it("refuses a count that is not a sport count, never reads it as free", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => sweepBudget("read", bad), String(bad)).toThrow(/sport count of at least 1/);
  });
});
