// W3 app-B Task 7 (X-SW-11; rulebook-W3-swiss.md §4 "Points are written in the stage's table points ... Win points means the
// table's `win` value"; FIDE C.04.3 (1 Feb 2026) Art. 1.8): `maxRoundPoints(rule, module, cfg)` is the most table points ONE
// fixture can pay one side under the stage's points rule, bonuses included - the unit the final round's topscorer threshold
// is measured in, so it must be the SAME number the table pays. It calls the engine's own `payout` (the call
// `loadStageInputs` pays every result with) on a regulation win with the clean-sweep result for the sport's format, and never
// a hand formula: a formula is a second authority that drifts on bonuses.
//
// No database: the function is pure over (rule, module, cfg). The DB cases that drive it through the real Pair live in
// usecases/__tests__/swiss-look-ahead.test.ts.
//
// Expected values are typed here from each sport's own rulebook win value, never read back from `maxRoundPoints`:
// football, hockey and generic pay 3 for a win (FIFA / FIH convention), cricket and carrom 2, chess 1 point = 2 half-points
// (rulebook-W3-swiss.md §4), badminton, table tennis and tennis 2, volleyball by set score (indoor 3 for a 3-0, beach 2), ice
// hockey IIHF 3 for a regulation win (an overtime win pays 2) and recreational 2. A sweep over the registry that lists a
// (sport, variant) this table does not name FAILS: a new declared variant must be typed here, not skipped.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { setsToWinOf, validatePointsRule, type PointsRule } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { maxRoundPoints } from "../swiss-max-round-points";

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

/** The rulebook's win value per sport, by variant name (declaredCfgs' own names: the schema default is "(schema default)"). */
const WIN_POINTS: Record<string, number | Record<string, number>> = {
  football: 3,
  cricket: 2,
  boardgame: 2, // half-points: chess's win is 1 point (rulebook-W3-swiss.md §4), stored as 2
  carrom: 2,
  generic: 3,
  volleyball: { beach: 2, indoor: 3, "(schema default)": 3 },
  badminton: 2,
  tabletennis: 2,
  tennis: 2,
  icehockey: { recreational: 2, iihf: 3, "(schema default)": 3 },
  hockey: 3,
};
const expectedWin = (sport: string, variant: string): number | undefined => {
  const e = WIN_POINTS[sport];
  return typeof e === "object" ? e[variant] : e;
};

/** A rule with nothing but a win, a loss and (optionally) extras - the shape every test below starts from. */
const rule = (over: Partial<PointsRule> = {}): PointsRule => ({
  win: { regulation: 3 },
  loss: { regulation: 0 },
  draw: 1,
  shootoutAs: "result",
  unit: "whole",
  bonuses: [],
  ...over,
});

describe("X-SW-11 maxRoundPoints is the most table points one fixture pays one side (no database)", () => {
  it("empty case first: a rule with no bySetScore and no bonus is win.regulation", () => {
    const football = moduleOf("football");
    const cfg = football.configSchema.parse({});
    expect(maxRoundPoints(rule(), football, cfg), "win 3, nothing else").toBe(3);
    // differential: a rule that pays a draw more or a loss something does not move it - only the win is the maximum
    expect(maxRoundPoints(rule({ win: { regulation: 5 }, loss: { regulation: 1 }, draw: 2 }), football, cfg), "win 5").toBe(5);
  });

  it("X-SW-11 every sport's declared Swiss rule gives its rulebook win value (registry sweep, counted)", () => {
    const seen = { sports: 0, cfgs: 0, setRules: 0, halfUnit: 0 };
    const sports = forEachSport(({ key, module }) => {
      seen.sports++;
      for (const { name, cfg } of declaredCfgs<unknown>(module)) {
        const declared = module.tablePointsRule(cfg, "swiss");
        const want = expectedWin(key, name);
        expect(want, `${key} / ${name}: the test names the win value of every declared variant`).toBeDefined();
        expect(maxRoundPoints(declared, module, cfg), `${key} / ${name}`).toBe(want);
        seen.cfgs++;
        if (declared.bySetScore !== undefined) seen.setRules++;
        if (declared.unit === "half") seen.halfUnit++;
      }
    });
    expect(sports, "every registry sport was swept").toBe(builtinModules.length);
    expect(seen.sports).toBe(sports);
    expect(seen.cfgs, `anti-vacuity: ${seen.cfgs} declared configurations were held to the rulebook`).toBeGreaterThan(sports);
    expect(seen.setRules, "a set-score rule (volleyball, badminton) was swept").toBeGreaterThan(0);
    expect(seen.halfUnit, "a half-point sport (chess) was swept").toBeGreaterThan(0);
  });

  it("maxRoundPoints counts a win bonus the rule pays, as the table does", () => {
    // football keeps a score, so the margin bonus is valid on it; the table pays a winner by 2 or more goals one point extra.
    const football = moduleOf("football");
    const cfg = football.configSchema.parse({});
    const bonus: PointsRule = rule({ bonuses: [{ when: "win_margin_gte", param: 2, points: 1 }] });
    // differential: a bonus-free formula gives win only (3)
    expect(maxRoundPoints(bonus, football, cfg), "win 3 + the bonus the table pays a decisive win").toBe(4);
    expect(maxRoundPoints(rule(), football, cfg), "the same rule without the bonus").toBe(3);
  });

  it("a bonus that pays a LOSER, a draw or a forfeit is no part of a win's maximum", () => {
    const football = moduleOf("football");
    const cfg = football.configSchema.parse({});
    const others: PointsRule = rule({
      bonuses: [
        { when: "loss_margin_lte", param: 1, points: 5 },
        { when: "draw", points: 5 },
        { when: "forfeit_win", points: 5 },
        { when: "no_result", points: 5 },
      ],
    });
    expect(maxRoundPoints(others, football, cfg), "none of those pays a played win").toBe(3);
  });

  it("a set-score rule pays the CLEAN SWEEP's winner points, not win.regulation", () => {
    // badminton is a best-of-three: setsToWin 2, so the clean sweep is "2-0". The custom map pays a sweep 7 and a three-setter 5.
    const badminton = moduleOf("badminton");
    const cfg = badminton.configSchema.parse(badminton.variants.bwf);
    const bySetScore: PointsRule = rule({ win: { regulation: 2 }, bySetScore: { "2-0": [7, 0], "2-1": [5, 1] } });
    // differential: win.regulation says 2; the map's clean sweep says 7
    expect(maxRoundPoints(bySetScore, badminton, cfg)).toBe(7);
    // and a catch-all "*" row pays every score the same
    expect(maxRoundPoints(rule({ win: { regulation: 2 }, bySetScore: { "*": [4, 1] } }), badminton, cfg)).toBe(4);
    // the best-of count comes from the sport's cfg: volleyball beach (best of three) sweeps 2-0, indoor (best of five) 3-0
    const volleyball = moduleOf("volleyball");
    const indoor = volleyball.configSchema.parse(volleyball.variants.indoor);
    const beach = volleyball.configSchema.parse(volleyball.variants.beach);
    const perSweep: PointsRule = rule({ win: { regulation: 1 }, bySetScore: { "3-0": [9, 0], "2-0": [6, 0], "*": [2, 1] } });
    expect(maxRoundPoints(perSweep, volleyball, indoor), "indoor sweeps 3-0").toBe(9);
    expect(maxRoundPoints(perSweep, volleyball, beach), "beach sweeps 2-0").toBe(6);
  });

  it("no registry sport carries a set-score map AND a margin bonus, so the two never compose on a saved rule (tripwire, counted)", () => {
    // A margin bonus needs a sport that emits a score (`validatePointsRule` refuses it otherwise, at save); a set table
    // (`setsToWinOf` defined) exists on the set sports, which keep sets, not a score. Today no sport is both, so the maximum
    // never adds a bonus to a sweep's points on a rule the app can hold. If one ever is, this reds: type a case for it
    // (sweep + bonus) in this file before shipping the sport, instead of trusting `payout`'s composition untested.
    const margin: PointsRule = rule({ bonuses: [{ when: "win_margin_gte", param: 1, points: 1 }] });
    const both: string[] = [];
    let setSports = 0;
    let scoreSports = 0;
    const sports = forEachSport(({ key, module }) => {
      let marginOk = true;
      try {
        validatePointsRule(margin, module.metrics);
      } catch {
        marginOk = false;
      }
      const sets = declaredCfgs<unknown>(module).some(({ cfg }) => setsToWinOf(module, cfg) !== undefined);
      if (sets) setSports++;
      if (marginOk) scoreSports++;
      if (sets && marginOk) both.push(key);
    });
    expect(sports, "every registry sport was swept").toBe(builtinModules.length);
    expect(setSports, "anti-vacuity: the set sports were seen").toBeGreaterThan(0);
    expect(scoreSports, "anti-vacuity: the score sports were seen").toBeGreaterThan(0);
    expect(both, "a sport with a set table and a margin bonus needs its own sweep + bonus case in this file").toEqual([]);
  });

  it("a set-score rule on a sport with no set table is refused by the engine, never read as win.regulation", () => {
    const football = moduleOf("football");
    const cfg = football.configSchema.parse({});
    expect(() => maxRoundPoints(rule({ bySetScore: { "*": [2, 0] } }), football, cfg)).toThrow(/set/i);
  });
});
