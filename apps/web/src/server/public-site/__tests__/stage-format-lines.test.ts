// W2c Task 16 (batch-4 review M4; spec item 15) - the public stage line names how a stage's matches END.
//
// Batch 4 pinned a premise here: the describer answered for the four set/nested sports only, none of which declares a
// decider, so a stage's decider override could not reach the line (ruling M4 wanted it to; the clause was routed to this
// task). The premise is now false by design: the describer covers every sport, and the line is built from the stage-
// RESOLVED config (`resolveFixtureCfg`), where `config.rules` carries the stage's deciders. This file pins the new truth.
//
// Both halves are read from the engine's own declarations, never a sport list typed here; the one typed-in thing is
// what the rulebook says a knockout of cricket / chess / carrom reads like. Counted: zero checked is a failure.
import { describe, expect, it } from "vitest";
import { pointsRuleAwardReachesTable } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { deciderKeysFor, stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { decidersOffRules } from "@/lib/stage-decider-off";
import enPublic from "@/dictionaries/en/public.json";
import { rulesLineText } from "@/lib/rules-line";
import { resolveLatestModule } from "@/server/engine-db";
import { stageFormatLines } from "../stage-format-lines";

const modules = builtinModules as readonly AnySportModule[];
const mod = (k: string): AnySportModule => resolveLatestModule(k);
const divisionCfg = (m: AnySportModule, v: string): Record<string, unknown> => m.configSchema.parse(m.variants[v]) as Record<string, unknown>;
const stage = (id: string, seq: number, kind: string, rules?: unknown, points_rule?: unknown, name = `Stage ${id}`) => ({
  id,
  name,
  seq,
  kind,
  ...(rules === undefined ? {} : { rules }),
  ...(points_rule === undefined ? {} : { points_rule }),
});
const words = (l: { line: unknown }) => rulesLineText(enPublic as never, l.line as never);
/** A walkover's two point figures are joined by a NON-BREAKING dash (U+2011), so a wrapped line never splits them. */
const NB = String.fromCharCode(0x2011);

/** The numbers a preset carries that the engine bounds for a match (`matchBound`) - what a spectator reads. */
function numbersOf(preset: Record<string, unknown>, m: AnySportModule): number[] {
  const out: number[] = [];
  for (const [path, fact] of Object.entries(m.ruleKeys ?? {})) {
    if (fact.matchBound === undefined) continue;
    const v =
      path.split(".").reduce<unknown>((a, k) => (a !== null && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), preset) ??
      fact.whenAbsent;
    const n = typeof v === "object" && v !== null ? (v as { halfMinutes?: unknown }).halfMinutes : v;
    if (typeof n === "number") out.push(n);
  }
  return out;
}

describe("stage format line - a stage's deciders reach its line (batch 4 M4, closed by Task 16)", () => {
  it("every sport that declares a decider is described, and a knockout stage created with the sport's preset names how a tie ends (counted)", () => {
    const withDeciders = modules.filter((m) => deciderKeysFor(m, null, null).length > 0);
    expect(withDeciders.length, "anti-vacuity: sports whose stages can switch a decider").toBeGreaterThan(0);
    // What the rulebook says each one's knockout reads like (the only typed table here): cricket's super over, chess's
    // rung list, carrom's extra board; the goal sports' numbers are read back off the engine's own preset below.
    const READS: Record<string, RegExp> = {
      cricket: /super over/i,
      boardgame: /rapid tie-break.*blitz tie-break.*Armageddon/i,
      carrom: /extra board/i,
    };
    let checked = 0;
    let numbered = 0;
    for (const m of withDeciders) {
      const v = Object.keys(m.variants)[0]!;
      const preset = stageDefaultsFor(m, "knockout", v);
      const lines = stageFormatLines(m.key, m, divisionCfg(m, v), [stage("s1", 1, "knockout", Object.keys(preset).length ? preset : undefined)]);
      expect(lines.length, `${m.key} has deciders and a line`).toBe(1);
      const text = words(lines[0]!);
      if (READS[m.key]) expect(text, m.key).toMatch(READS[m.key]!);
      for (const n of numbersOf(preset, m)) {
        expect(text, `${m.key} ${n}`).toMatch(new RegExp(`(?<![\\w.])${n}(?![\\w.])`));
        numbered++;
      }
      checked++;
    }
    expect(checked).toBe(withDeciders.length);
    expect(numbered, "the goal sports' bounded numbers were checked").toBeGreaterThan(0);
  });

  it("the line is built from the STAGE-resolved config: ice hockey's all-off knockout over an IIHF division says the switch, in the stage's words", () => {
    const ice = mod("icehockey");
    const division = divisionCfg(ice, "iihf");
    expect(division.overtime, "premise: the division plays overtime").not.toBeNull();
    const off = decidersOffRules(ice, "iihf", "knockout");
    expect(off, "premise: `false` is how a stage switches a null-off decider off").toEqual({ overtime: false, shootout: false });
    const [line] = stageFormatLines("icehockey", ice, division, [stage("s1", 1, "knockout", off)]);
    expect(line!.line.map((c) => c.key)).toEqual(["format.rules.period.thirds", "format.rules.decider.none"]);
    expect(words(line!)).toBe("3 periods of 20 min, level matches wait for the organiser");
  });

  it("a bracket stage states how a tie ends even where nothing differs from its division (all off over an all-off division)", () => {
    const football = mod("football");
    const division = divisionCfg(football, "11-a-side");
    const off = decidersOffRules(football, "11-a-side", "knockout");
    const [line] = stageFormatLines("football", football, division, [stage("s1", 1, "knockout", off)]);
    expect(line!.line).toEqual([{ key: "format.rules.decider.none" }]);
    expect(words(line!)).toBe("Level matches wait for the organiser");
  });

  it("chess knockout with no stored rules says every rung (BG-KO-1); a list the organiser set says the format it differs by, then its order; [] says none", () => {
    const chess = mod("boardgame");
    const division = divisionCfg(chess, "classical");
    const rungs = (rules: unknown) => words(stageFormatLines("boardgame", chess, division, [stage("s1", 1, "knockout", rules)])[0]!);
    expect(rungs(undefined)).toBe("Rapid tie-break, blitz tie-break, Armageddon");
    // A list the stage sets is a rule that DIFFERS from its division, so the line is the format first (the same rule as
    // every other sport: a differing stage never reads as the division's preset), then the rungs in the stage's order.
    expect(rungs({ tiebreakRungs: ["armageddon", "rapid"] })).toBe("Classical time control, Armageddon, rapid tie-break");
    expect(rungs({ tiebreakRungs: [] })).toBe("Classical time control, level matches wait for the organiser");
  });

  it("the sequence: a table stage first (the empty case), then other kinds, in stage order, each under its own name", () => {
    const hockey = mod("hockey");
    const division = divisionCfg(hockey, "fih-outdoor");
    const preset = stageDefaultsFor(hockey, "knockout", "fih-outdoor") as { shootout: { attempts: number } };
    const longName = "A very long stage name that a spectator on a phone has to read in full without the page growing sideways";
    // Listed out of order on purpose: the builder sorts by `seq`.
    const lines = stageFormatLines("hockey", hockey, division, [
      stage("k", 3, "knockout", preset, undefined, "Playoffs"),
      stage("l", 1, "league", undefined, undefined, "Pool play"),
      stage("g", 2, "group", { periods: { count: 4, minutes: 12 } }, undefined, longName),
    ]);
    expect(lines.map((l) => l.stageId), "the league (nothing differs) has no line").toEqual(["g", "k"]);
    expect(lines.map((l) => l.stageName)).toEqual([longName, "Playoffs"]);
    expect(words(lines[0]!)).toBe("4 quarters of 12 min");
    expect(words(lines[1]!)).toBe(`4 quarters of 15 min, shoot-out (${preset.shootout.attempts} each)`);
  });

  it("a stage with no rules, no points and no deciders to state has no line (the empty case), for every table kind of every sport", () => {
    let checked = 0;
    for (const m of modules) {
      const v = Object.keys(m.variants)[0]!;
      for (const kind of ["league", "group", "swiss", "americano"])
        expect(stageFormatLines(m.key, m, divisionCfg(m, v), [stage("s1", 1, kind)]), `${m.key}/${kind}`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(modules.length);
    // And a set-based knockout: no decider to state, no difference, no line.
    const badminton = mod("badminton");
    expect(stageFormatLines("badminton", badminton, divisionCfg(badminton, "bwf"), [stage("s1", 1, "knockout")])).toEqual([]);
  });

  it("a retired module, or a stage with no kind, never throws and says nothing it cannot back", () => {
    expect(stageFormatLines("football", null, {}, [stage("s1", 1, "knockout", { shootout: true })])).toEqual([]);
    const football = mod("football");
    const division = divisionCfg(football, "11-a-side");
    const lines = stageFormatLines("football", football, division, [{ id: "s", name: "No kind", seq: 1, rules: { halfMinutes: 40 } }]);
    expect(lines.map(words)).toEqual(["2 halves of 40 min"]);
  });
});

describe("stage format line - a stage's own points rule (X-PT-1, public half)", () => {
  const football = mod("football");
  const division = divisionCfg(football, "11-a-side");
  // The rule's award score (7-0) is NOT the division's (football's own `awardScore.goals`). Since X-WO-1 part B (Task 16b)
  // the walkover headline reads the RULE's award wherever it reaches the sport's table, so the line says it there.
  const points = { win: { regulation: 4 }, draw: 2, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [7, 0] } };
  const noAward = { ...points, forfeit: { winnerPoints: 2, loserPoints: 0 } };

  it("a stage with its own points and the division's format gets the points sentence alone", () => {
    const [line] = stageFormatLines("football", football, division, [stage("s1", 1, "league", undefined, noAward)]);
    expect(words(line!)).toBe(`Win 4, draw 2, loss 0, walkover pays 2${NB}0 points`);
  });

  it("a points rule's walkover AWARD score (7-0) is said on the public line, with the RULE's number, beside the base points - and not the division's award", () => {
    expect(football.configSchema.parse(football.variants["11-a-side"]).awardScore.goals, "premise: the division's award is not the rule's").not.toBe(7);
    const [line] = stageFormatLines("football", football, division, [stage("s1", 1, "league", undefined, points)]);
    const text = words(line!);
    expect(text, "the positive pair: the base points are there").toMatch(/^Win 4, draw 2, loss 0/);
    expect(text).toBe(`Win 4, draw 2, loss 0, walkover pays 2${NB}0 points, walkover scored 7${NB}0`);
    expect(line!.line.at(-1)).toEqual({ key: "format.points.forfeitScore", params: { winner: 7, loser: 0 } });
    // The same stage with no award says none.
    const [plain] = stageFormatLines("football", football, division, [stage("s1", 1, "league", undefined, noAward)]);
    expect(plain!.line.map((c) => c.key)).not.toContain("format.points.forfeitScore");
  });

  it("the clause is said exactly for the sports whose table the award reaches, and never for the rest (counted, both sides)", () => {
    let said = 0;
    let withheld = 0;
    for (const m of modules) {
      const lines = stageFormatLines(m.key, m, divisionCfg(m, Object.keys(m.variants)[0]!), [stage("s1", 1, "league", undefined, points)]);
      expect(lines.length, m.key).toBe(1);
      const keys = lines[0]!.line.map((c) => c.key);
      if (pointsRuleAwardReachesTable(m)) {
        expect(keys, `${m.key}: the award reaches its table`).toContain("format.points.forfeitScore");
        said++;
      } else {
        expect(keys, `${m.key}: the award never reaches its table, so the headline cannot agree with it`).not.toContain("format.points.forfeitScore");
        withheld++;
      }
    }
    expect(said, "sports that say it").toBeGreaterThan(0);
    expect(withheld, "sports that do not").toBeGreaterThan(0);
    expect(said + withheld).toBe(modules.length);
  });

  it("a retired module (none to ask) never claims a score it cannot back", () => {
    const [line] = stageFormatLines("football", null, {}, [stage("s1", 1, "league", undefined, points)]);
    expect(line!.line.map((c) => c.key)).toEqual(["format.points.base", "format.points.forfeit"]);
  });

  it("points ride AFTER the format and the deciders when the stage differs too (4 is not the division's win of 3)", () => {
    expect(division.points, "premise: the division's win is not 4").toEqual({ win: 3, draw: 1, loss: 0 });
    const preset = stageDefaultsFor(football, "knockout", "11-a-side");
    const [line] = stageFormatLines("football", football, division, [stage("s1", 1, "knockout", preset, points)]);
    expect(line!.line.map((c) => c.key)).toEqual([
      "format.rules.period.halves",
      "format.rules.decider.extraTime",
      "format.rules.decider.penalties",
      "format.points.base",
      "format.points.forfeit",
      "format.points.forfeitScore",
    ]);
  });

  it("a stored points value the view could not rebuild (null, wrong shape) is no points - the stage keeps whatever else it says", () => {
    for (const bad of [null, "x", 7, [], { base: "3-1-0" }, { bonuses: [] }])
      expect(stageFormatLines("football", football, division, [stage("s1", 1, "league", undefined, bad)]), JSON.stringify(bad)).toEqual([]);
  });

  it("points are said for every sport's stage, not just football's (counted)", () => {
    let checked = 0;
    for (const m of modules) {
      const lines = stageFormatLines(m.key, m, divisionCfg(m, Object.keys(m.variants)[0]!), [stage("s1", 1, "league", undefined, noAward)]);
      expect(lines.length, m.key).toBe(1);
      expect(words(lines[0]!), m.key).toMatch(/Win 4, draw 2, loss 0/);
      checked++;
    }
    expect(checked).toBe(modules.length);
  });
});
