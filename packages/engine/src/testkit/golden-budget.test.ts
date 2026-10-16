// The sweep budget (golden-budget.ts) is arithmetic a test timeout hangs on, so it is pinned: it scales with the sport count, each
// kind of work costs what its constant says, and a count that is not a sport count is refused rather than read as zero.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("no golden test states a flat 60 s / 120 s timeout (AGENTS.md class 20: a flat timeout beside a derived cost is a latent red)", () => {
  const dir = import.meta.dirname;
  const files = readdirSync(dir).filter((name) => /^golden.*\.test\.ts$/.test(name));
  const closers = (name: string): { flat: string[]; derived: number } => {
    const flat: string[] = [];
    let derived = 0;
    readFileSync(join(dir, name), "utf8").split("\n").forEach((line, i) => {
      if (/\},\s*(?:60|120)_?000\s*\)/.test(line)) flat.push(`${name}:${i + 1}`);
      if (/\},\s*sweepBudget\(/.test(line)) derived++;
    });
    return { flat, derived };
  };

  it("the golden test files that sweep a corpus close their slow tests with sweepBudget, and none of them states 60_000 or 120_000", () => {
    expect(files.length, "the scan found the golden test files").toBeGreaterThan(10);
    const flat: string[] = [];
    const derivedBy = new Map<string, number>();
    for (const name of files) {
      const found = closers(name);
      flat.push(...found.flat);
      derivedBy.set(name, found.derived);
    }
    // anti-vacuity: the three files GF-2 T4 reintroduced flat budgets in must each hold derived ones now (9, 7 and 1 tests moved)
    expect(derivedBy.get("golden-stats.test.ts")!, "golden-stats.test.ts").toBeGreaterThanOrEqual(9);
    expect(derivedBy.get("golden-format.test.ts")!, "golden-format.test.ts").toBeGreaterThanOrEqual(7);
    expect(derivedBy.get("golden-overlay.test.ts")!, "golden-overlay.test.ts").toBeGreaterThanOrEqual(1);
    expect(flat, "a flat timeout beside the derived ones").toEqual([]);
  });
});
