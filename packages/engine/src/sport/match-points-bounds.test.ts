// Standings qualification status (spec 2026-09-22 §3.1, plan P1): every sport
// declares the points ONE SIDE can take from one match. `winFloor`/`lossCeil`
// exist because a win is not one number — OT, shoot-out and 3-2 wins pay less.
//
// Expected values are read off each module's OWN parsed cfg, never typed:
// change a default and this file moves with it. The volleyball and ice-hockey
// cases are the ones where the right answer differs from the wrong constant
// (`winFloor` ≠ `max`, `lossCeil` ≠ `min`).
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { generic } from "../sports/generic/index.ts";
import { football } from "../sports/football/index.ts";
import { cricket } from "../sports/cricket/index.ts";
import { carrom } from "../sports/carrom/index.ts";
import { boardgame } from "../sports/boardgame/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { tennis } from "../sports/tennis/index.ts";
import { EngineError } from "../core/errors.ts";
import { boundsFrom, type AnySportModule } from "./module.ts";

describe("boundsFrom", () => {
  it("states the empty-`others` case: max/min come from wins and losses alone, min never above 0", () => {
    expect(boundsFrom([3], [1])).toEqual({ max: 3, min: 0, winFloor: 3, lossCeil: 1 });
  });
  it("winFloor is the SMALLEST win, lossCeil the LARGEST loss", () => {
    expect(boundsFrom([3, 2], [0, 1], [1])).toEqual({ max: 3, min: 0, winFloor: 2, lossCeil: 1 });
  });
  it("an `others` value above every win still sets max — a draw can outpay a win", () => {
    expect(boundsFrom([1], [0], [2])).toEqual({ max: 2, min: 0, winFloor: 1, lossCeil: 0 });
  });
  // Without a guard, `Math.min()` of nothing is Infinity and `Math.max()` of
  // nothing is -Infinity: a winFloor of Infinity makes "Win and in" provable
  // for nobody, silently. Each list has its own message so each guard is
  // witnessed on its own, not covered by the other.
  it("refuses an empty wins list rather than returning ±Infinity bounds", () => {
    expect(() => boundsFrom([], [0])).toThrow(EngineError);
    expect(() => boundsFrom([], [0])).toThrow(/at least one WIN payout/);
  });
  it("refuses an empty losses list rather than returning ±Infinity bounds", () => {
    expect(() => boundsFrom([2], [])).toThrow(EngineError);
    expect(() => boundsFrom([2], [])).toThrow(/at least one LOSS payout/);
  });
});

// Review round 1: the per-module ORDER checks (min ≤ lossCeil ≤ max, min ≤
// winFloor ≤ max, min ≤ 0) were removed. They hold for any `boundsFrom` output
// and every kernel builds its bounds through `boundsFrom`, so nothing could red
// them. The check that stays crosses TWO kernel methods, and it reaches every
// declared variant — most have no conformance suite. A set-based kernel that
// read its wins from the loss column (max 1 against a declared total of 3)
// failed here for all ten set-based variants.
describe("matchPointsBounds — no declared pair total exceeds what two sides could take (every module and variant)", () => {
  for (const m of builtinModules) {
    // Controller ruling M4: a module whose schema has required fields (generic:
    // `resultMode`, `allowDraws`) cannot parse `{}`, so its "default" sample is
    // skipped and its declared variants carry it instead.
    const cfgs: [string, unknown][] = [
      ...(m.configSchema.safeParse({}).success ? [["default", {}] as [string, unknown]] : []),
      ...Object.entries(m.variants ?? {}),
    ];
    it(`${m.key} contributes at least one cfg to sample`, () => {
      expect(cfgs.length).toBeGreaterThan(0);
    });
    for (const [label, raw] of cfgs) {
      it(`${m.key} (${label})`, () => {
        const cfg = m.configSchema.parse(raw);
        const b = m.matchPointsBounds(cfg);
        for (const total of m.declaredPointsSets(cfg)) expect(total).toBeLessThanOrEqual(2 * b.max);
      });
    }
  }
});

describe("matchPointsBounds — the cases a single 'win' constant gets wrong", () => {
  it("volleyball FIVB: a 3-2 win pays less than a 3-0, a 2-3 loss pays more than 0-3", () => {
    const cfg = volleyball.configSchema.parse({});
    const pairs = Object.values(cfg.pointsMap);
    const b = volleyball.matchPointsBounds(cfg);
    expect(b.winFloor).toBe(Math.min(...pairs.map((p) => p[0])));
    expect(b.lossCeil).toBe(Math.max(...pairs.map((p) => p[1])));
    expect(b.winFloor).toBeLessThan(b.max); // the differential: winFloor ≠ max
    expect(b.lossCeil).toBeGreaterThan(b.min); // and lossCeil ≠ min
  });
  it("ice hockey: an OT win is the floor, an OT loss the ceiling", () => {
    const cfg = icehockey.configSchema.parse({});
    const p = cfg.points;
    const b = icehockey.matchPointsBounds(cfg);
    expect(b.winFloor).toBe(Math.min(p.win, p.otWin ?? p.win, p.shootoutWin ?? p.win));
    expect(b.lossCeil).toBe(Math.max(p.loss, p.otLoss ?? p.loss, p.shootoutLoss ?? p.loss));
    expect(b.max).toBe(Math.max(p.win, p.draw, p.otWin ?? 0, p.shootoutWin ?? 0));
  });
  it("generic: win/draw/loss read from `points.w/d/l`", () => {
    const cfg = generic.configSchema.parse({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false });
    expect(generic.matchPointsBounds(cfg)).toEqual({ max: cfg.points.w, min: 0, winFloor: cfg.points.w, lossCeil: cfg.points.l });
  });
});

// Mutation sweep, Task 1 (measured against the cases above plus every
// conformance §9.3b): dropping `others` from `max` in `boundsFrom`, dropping
// football's draw from its `others`, and dropping football's shoot-out win
// all SURVIVED — no shipped default makes a draw outpay a win, and no football
// cfg in the tree sets the split. All are the UNSAFE direction: a low `max`
// understates a rival's best case (a false "Through"), a high `winFloor` or a
// low `lossCeil` makes a false "Win and in".
describe("matchPointsBounds — split payouts the default cfgs never exercise", () => {
  it("football youth-cup shoot-out split: an SO win is the floor, an SO loss the ceiling", () => {
    const cfg = football.configSchema.parse({ points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 } });
    const p = cfg.points;
    const b = football.matchPointsBounds(cfg);
    expect(b.winFloor).toBe(p.shootoutWin);
    expect(b.lossCeil).toBe(p.shootoutLoss);
    expect(b.winFloor).toBeLessThan(p.win); // the differential: winFloor ≠ the plain win
    expect(b.lossCeil).toBeGreaterThan(p.loss); // and lossCeil ≠ the plain loss
  });
  it("hockey `fih-shootout`: an SO win is the floor, an SO loss the ceiling", () => {
    const cfg = hockey.configSchema.parse(hockey.variants["fih-shootout"]);
    const p = cfg.points;
    const b = hockey.matchPointsBounds(cfg);
    expect(b.winFloor).toBe(p.shootoutWin);
    expect(b.lossCeil).toBe(p.shootoutLoss);
    expect(b.winFloor).toBeLessThan(p.win);
    expect(b.lossCeil).toBeGreaterThan(p.loss);
  });
});

describe("matchPointsBounds — a plain win/loss default is TIGHT, not merely safe", () => {
  // Loose bounds never make a status wrong, but they silently suppress one: a
  // kernel that passed `[loss]` as its wins and `[win]` as its losses survived
  // every case above and would print no "Win and in" in any of that sport's
  // tables (AGENTS.md #6). Win and loss are read back off the parsed default.
  const cases: [AnySportModule, readonly [string, string, string]][] = [
    [football, ["points", "win", "loss"]],
    [cricket, ["points", "win", "loss"]],
    [carrom, ["points", "win", "loss"]],
    [boardgame, ["scoring", "win", "loss"]],
    [tennis, ["points", "win", "loss"]],
  ];
  for (const [m, [group, win, loss]] of cases) {
    it(`${m.key}: winFloor is the win, lossCeil the loss`, () => {
      const cfg = m.configSchema.parse({}) as Record<string, Record<string, number>>;
      const b = m.matchPointsBounds(cfg);
      expect(b.winFloor).toBe(cfg[group]?.[win]);
      expect(b.lossCeil).toBe(cfg[group]?.[loss]);
      expect(b.winFloor).toBeGreaterThan(b.lossCeil); // the differential: a swap would invert this
    });
  }
});

describe("matchPointsBounds — a draw-like payout above a win still reaches `max`", () => {
  // Schema-legal: every points field is only `.nonnegative()`, with no
  // ordering refine, so an organiser CAN make a draw, tie or no-result outpay
  // a win. Each case sets ONE such payout above the win; the expected `max` is
  // read back off the parsed cfg at `[group, key]`.
  const cases: [string, AnySportModule, unknown, readonly [string, string]][] = [
    ["football draw", football, { points: { win: 1, draw: 2, loss: 0 } }, ["points", "draw"]],
    ["cricket tie", cricket, { points: { win: 1, tie: 2, noResult: 0, loss: 0 } }, ["points", "tie"]],
    ["cricket no-result", cricket, { points: { win: 1, tie: 0, noResult: 2, loss: 0 } }, ["points", "noResult"]],
    ["cricket draw", cricket, { points: { win: 1, tie: 0, noResult: 0, loss: 0, draw: 2 } }, ["points", "draw"]],
    ["ice hockey draw", icehockey, { points: { win: 1, draw: 2, loss: 0 } }, ["points", "draw"]],
    ["carrom draw", carrom, { points: { win: 1, draw: 2, loss: 0 } }, ["points", "draw"]],
    ["boardgame draw", boardgame, { scoring: { win: 1, draw: 2, loss: 0 } }, ["scoring", "draw"]],
    ["generic draw", generic, { resultMode: "score", allowDraws: true, points: { w: 1, d: 2, l: 0 } }, ["points", "d"]],
  ];
  for (const [label, m, raw, [group, key]] of cases) {
    it(label, () => {
      const cfg = m.configSchema.parse(raw) as Record<string, Record<string, number>>;
      const b = m.matchPointsBounds(cfg);
      expect(b.max).toBe(cfg[group]?.[key]);
      expect(b.max).toBeGreaterThan(b.winFloor); // the differential: max ≠ the win
    });
  }
});
