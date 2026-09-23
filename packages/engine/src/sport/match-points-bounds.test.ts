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
import { badminton } from "../sports/setbased/badminton.ts";
import { tabletennis } from "../sports/setbased/tabletennis.ts";
import { EngineError } from "../core/errors.ts";
import { boundsFrom, type AnySportModule } from "./module.ts";

describe("boundsFrom", () => {
  it("states the empty-`others` case: max/min come from wins and losses alone, min never above 0", () => {
    expect(boundsFrom([3], [1])).toEqual({ max: 3, min: 0, winFloor: 3, lossCeil: 1, winsOnly: false });
  });
  it("winFloor is the SMALLEST win, lossCeil the LARGEST loss", () => {
    expect(boundsFrom([3, 2], [0, 1], [1])).toEqual({ max: 3, min: 0, winFloor: 2, lossCeil: 1, winsOnly: false });
  });
  it("an `others` value above every win still sets max — a draw can outpay a win", () => {
    expect(boundsFrom([1], [0], [2])).toEqual({ max: 2, min: 0, winFloor: 1, lossCeil: 0, winsOnly: false });
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
    expect(generic.matchPointsBounds(cfg)).toEqual({
      max: cfg.points.w,
      min: 0,
      winFloor: cfg.points.w,
      lossCeil: cfg.points.l,
      winsOnly: false, // the draw pays
    });
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

// Standings what-if (spec 2026-09-22 §3.4; controller rulings OQ1/M11): the
// tie-break `wins` cannot separate two rows level on points exactly when
// points = winFloor × won — every win pays ONE amount and every other outcome
// pays 0. Then level points ARE level wins. One case per conjunct, and each
// case is the one input that conjunct alone refuses.
describe("boundsFrom — winsOnly: points are winFloor × won, so level points mean level wins", () => {
  it("one win payout and nothing else pays → true, a declared draw that pays 0 included", () => {
    expect(boundsFrom([2], [0]).winsOnly).toBe(true);
    expect(boundsFrom([2, 2], [0, 0]).winsOnly).toBe(true);
    expect(boundsFrom([2], [0], [0]).winsOnly).toBe(true);
  });
  it("two win payouts (an OT or 3-2 win pays less, winFloor < max) → false", () => {
    expect(boundsFrom([3, 2], [0]).winsOnly).toBe(false);
  });
  it("a loss that pays → false: on 2/1, two wins and one win plus two losses both make 4", () => {
    expect(boundsFrom([2], [1]).winsOnly).toBe(false);
    expect(boundsFrom([2], [0, 1]).winsOnly).toBe(false);
  });
  it("a draw, tie or no-result that pays → false", () => {
    expect(boundsFrom([2], [0], [1]).winsOnly).toBe(false);
    expect(boundsFrom([2], [0], [0, 1]).winsOnly).toBe(false);
  });
  it("nothing pays at all → false: everyone level on 0 says nothing about wins", () => {
    expect(boundsFrom([0], [0]).winsOnly).toBe(false);
  });
});

// The same fact per shipped module, read off each parsed default cfg. Carrom
// and limited-overs cricket are the differential against `supportsDraws`: both
// say a league match cannot be drawn, and both still pay a no-result, so a
// row can be level on points with FEWER wins there. `winsOnly` must say false.
// That real standingsDelta output agrees is conformance §9.3b's job.
describe("matchPointsBounds — winsOnly per module (the fact, not supportsDraws)", () => {
  it("badminton and table tennis: every pointsMap pair pays one win amount and a 0 loss → true", () => {
    for (const m of [badminton, tabletennis]) {
      const cfg = m.configSchema.parse({});
      const pairs = Object.values(cfg.pointsMap) as readonly (readonly [number, number])[];
      expect(pairs.every(([w, l]) => w === pairs[0]![0] && w !== 0 && l === 0), m.key).toBe(true);
      expect(m.matchPointsBounds(cfg).winsOnly, m.key).toBe(true);
    }
  });
  it("tennis: a win pays `points.win`, a loss `points.loss` = 0 → true", () => {
    const cfg = tennis.configSchema.parse({});
    expect(cfg.points.loss).toBe(0);
    expect(tennis.matchPointsBounds(cfg).winsOnly).toBe(true);
  });
  it("volleyball FIVB: a 3-2 win pays less than a 3-0 and a 2-3 loss pays → false", () => {
    const cfg = volleyball.configSchema.parse({});
    expect(volleyball.matchPointsBounds(cfg).winsOnly).toBe(false);
  });
  it("carrom and limited-overs cricket: no draws, yet a no-result pays → false", () => {
    const carromCfg = carrom.configSchema.parse({});
    expect(carrom.supportsDraws(carromCfg, "league")).toBe(false);
    expect(carromCfg.points.draw).toBeGreaterThan(0);
    expect(carrom.matchPointsBounds(carromCfg).winsOnly).toBe(false);
    const cricketCfg = cricket.configSchema.parse({});
    expect(cricket.supportsDraws(cricketCfg, "league")).toBe(false);
    expect(cricketCfg.points.noResult).toBeGreaterThan(0);
    expect(cricket.matchPointsBounds(cricketCfg).winsOnly).toBe(false);
  });
});

// Conformance §9.3b checks `winsOnly` on played matches only; its generators
// never make a bye. A Swiss bye is scored through the module's own
// `standingsDelta` as an `award` win (apps/web engine-db/competition.ts
// `awardByeDelta`, phantom opponent, init state) — the path replayed here, for
// every module and variant that claims winsOnly.
describe("matchPointsBounds — winsOnly holds on the bye path too (an award through standingsDelta)", () => {
  const claimed: string[] = [];
  for (const m of builtinModules) {
    const cfgs: [string, unknown][] = [
      ...(m.configSchema.safeParse({}).success ? [["default", {}] as [string, unknown]] : []),
      ...Object.entries(m.variants ?? {}),
    ];
    for (const [label, raw] of cfgs) {
      const cfg = m.configSchema.parse(raw);
      const b = m.matchPointsBounds(cfg);
      if (!b.winsOnly) continue;
      claimed.push(`${m.key} (${label})`);
      it(`${m.key} (${label}): a bye pays winFloor to the winner, 0 to the phantom`, () => {
        const state = m.init(cfg, { home: { entrantId: "W", slots: [] }, away: { entrantId: "BYE", slots: [] } });
        const pair = m.standingsDelta({ kind: "award", winner: "W" }, cfg, { kind: "swiss" }, state);
        for (const d of pair) expect(d.points, d.entrantId).toBe(d.won * b.winFloor);
        expect(pair.find((d) => d.entrantId === "W")?.won).toBe(1);
      });
    }
  }
  // Pinned exactly (task-3 review minor): a `>= 3` floor let the sweep lose
  // ten of its thirteen cases and stay green. A module or variant that starts
  // or stops claiming winsOnly must show up here as a deliberate edit.
  it("the sweep covers exactly the 13 module/variant configs that claim winsOnly", () => {
    expect(claimed).toEqual([
      "volleyball (beach)",
      "badminton (default)",
      "badminton (bwf)",
      "badminton (short)",
      "tabletennis (default)",
      "tabletennis (bo5)",
      "tabletennis (bo7)",
      "tabletennis (hardbat-21)",
      "tennis (default)",
      "tennis (tour)",
      "tennis (grand-slam)",
      "tennis (fast4)",
      "tennis (doubles-noad-mtb10)",
    ]);
  });
});
