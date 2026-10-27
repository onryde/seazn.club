// W2d Task 8 (spec §5.4 "Resolution", §5.9, §6 E1/E3/E6; rule row X-TB-1; PS-7c). The one resolver of a stage's table
// rules: `pinned ?? { points: own ?? the sport's rule under the merged cfg, tiebreakers: own ?? division ?? the sport's
// default for the stage kind, crossGroup: own ?? the order without its head-to-head steps }`, with `sources` naming the
// layer that won.
//
// Expected values come from the spec text (the layer order of X-TB-1, §5.9's "every head-to-head key removed", D10(a)'s
// volleyball tables, D8's fair-play default) or from the engine's own declarations — `module.defaultTiebreakers(kind,
// cfg)`, `module.tablePointsRule(cfg, kind)`, `module.configSchema`, `validateCascade`'s rule 4 — never from the resolver.
// The layers each test sets hold three DIFFERENT orders, so a swapped precedence answers differently (rule 5).
//
// Sequence (TEST-STRATEGY rule 1): nothing set → the division sets an order → the stage sets its own → a pin → another
// sport (every sport, every table kind); a second call on the same input; an order the resolver must not share.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { DRAW_KINDS } from "../core/types.ts";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "../sport/module.ts";
// single-sport: chess is the sport whose game points differ from its 3/1/0 preset's table points (B5) — the gamePoints seam
import { boardgame } from "../sports/boardgame/index.ts";
// single-sport: football is the one sport whose cfg carries `fairPlay` (D8), the cfg PS-7c's default reads from Task 11 on
import { football } from "../sports/football/index.ts";
// single-sport: hockey is the one sport that declares winsCount "regulation" (HK-TB-1) — the winsCount seam
import { hockey } from "../sports/hockey/index.ts";
import { builtinModules } from "../sports/index.ts";
// single-sport: volleyball is the sport whose best-of-3 stage pays a different table than its best-of-5 division (D10(a))
import { volleyball } from "../sports/setbased/volleyball.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { validateCascade } from "./cascade-rules.ts";
import { PointsRule } from "./points.ts";
import { completeTableStage, type TableFixture, type TableStage } from "./stage.ts";
import type { FixtureResult } from "./standings.ts";
import { defaultCrossGroup, resolveTableRules, type TableRules, type TableRulesInput, type TableRulesPin } from "./table-rules.ts";
import { rankStandings } from "./tiebreakers.ts";

// The four stage kinds that keep a table: the engine's own declaration of the kinds where a level result stands
// (`DRAW_KINDS`, core/types.ts) — league, group, swiss, americano. Every one of them is a TableStageKind.
const TABLE_KINDS = [...DRAW_KINDS] as TableStageKind[];

// The whole vocabulary, in TiebreakerKey's order: a full Record, so engine tsc fails the day the union grows a key the
// cross-group test below would not visit.
const VOCABULARY: Record<TiebreakerKey, true> = {
  points: true, wins: true, h2h_points: true, h2h_diff: true, h2h_for: true, diff: true, for: true, nrr: true,
  set_ratio: true, game_ratio: true, board_ratio: true, point_ratio: true, buchholz: true, buchholz_cut1: true,
  sberger: true, direct: true, fair_play: true, seed: true, lots: true, set_diff: true, point_diff: true, h2h_two: true,
  h2h_wins: true, h2h_set_ratio: true, h2h_point_ratio: true, h2h_reapply: true, h2h_exclusion: true,
  matches_played: true, field_goals: true,
};
const KEYS = Object.keys(VOCABULARY) as TiebreakerKey[];
// Spec §5.9 / §5.5 rule 4: "every head-to-head key (`h2h_*`, `h2h_two`, `direct`, the h2h modifiers)".
const headToHead = (key: TiebreakerKey): boolean => key.startsWith("h2h_") || key === "direct";

// Two orders no sport declares as its default (each test checks that premise), so each layer answers differently.
const DIVISION_ORDER: readonly TiebreakerKey[] = ["seed", "h2h_points", "lots"];
const OWN_ORDER: readonly TiebreakerKey[] = ["lots"];
const OWN_CROSS: readonly TiebreakerKey[] = ["seed", "lots"];
// A rule no sport pays by default: a win 7, a loss 5.
const OWN_POINTS: PointsRule = PointsRule.parse({ win: { regulation: 7 }, loss: { regulation: 5 }, shootoutAs: "result", unit: "whole" });

const NOTHING = { points: null, tiebreakers: null, crossGroup: null } as const;

function input(module: AnySportModule, stageKind: TableStageKind, mergedCfg: unknown, over: Partial<TableRulesInput> = {}): TableRulesInput {
  return { module, stageKind, mergedCfg, stageOwn: NOTHING, divisionTiebreakers: null, pinned: null, ...over };
}

describe("resolveTableRules — the layers (X-TB-1)", () => {
  it("X-TB-1 own order beats the division's, which beats the sport default for the stage kind; sources say which (empty case: nothing set → sport)", () => {
    let checked = 0;
    const sports = forEachSport(({ module }) => {
      for (const kind of TABLE_KINDS) {
        for (const { name, cfg } of declaredCfgs(module)) {
          const label = `${module.key} ${kind} ${name}`;
          const sportOrder = module.defaultTiebreakers(kind, module.configSchema.parse(cfg));
          const sportPoints = module.tablePointsRule(module.configSchema.parse(cfg), kind);
          // Premise: the three orders differ, so a swapped precedence cannot answer the same.
          expect(sportOrder, label).not.toEqual(DIVISION_ORDER);
          expect(sportOrder, label).not.toEqual(OWN_ORDER);
          expect(sportPoints, label).not.toEqual(OWN_POINTS);

          // Empty case first: nothing set → the sport's default for this kind, under this cfg.
          const nothing = resolveTableRules(input(module, kind, cfg));
          expect(nothing.tiebreakers, label).toEqual(sportOrder);
          expect(nothing.points, label).toEqual(sportPoints);
          expect(nothing.sources, label).toEqual({ points: "sport", tiebreakers: "sport", crossGroup: "derived" });
          expect(nothing.crossGroup, label).toEqual(sportOrder.filter((key) => !headToHead(key)));

          // The division sets an order: it beats the sport's.
          const division = resolveTableRules(input(module, kind, cfg, { divisionTiebreakers: DIVISION_ORDER }));
          expect(division.tiebreakers, label).toEqual(DIVISION_ORDER);
          expect(division.sources, label).toEqual({ points: "sport", tiebreakers: "division", crossGroup: "derived" });
          expect(division.crossGroup, label).toEqual(["seed", "lots"]);

          // The stage sets its own order and points: they beat the division's and the sport's.
          const own = resolveTableRules(
            input(module, kind, cfg, { divisionTiebreakers: DIVISION_ORDER, stageOwn: { points: OWN_POINTS, tiebreakers: OWN_ORDER, crossGroup: null } }),
          );
          expect(own.tiebreakers, label).toEqual(OWN_ORDER);
          expect(own.points, label).toBe(OWN_POINTS);
          // an own ORDER is not an own cross-group order: the cross-group order is still derived from it (T9 re-review N2)
          expect(own.sources, label).toEqual({ points: "stage", tiebreakers: "stage", crossGroup: "derived" });
          expect(own.crossGroup, label).toEqual(OWN_ORDER);

          // Its own cross-group order beats the default one, whichever order won.
          const ownCross = resolveTableRules(input(module, kind, cfg, { stageOwn: { ...NOTHING, crossGroup: OWN_CROSS } }));
          expect(ownCross.crossGroup, label).toEqual(OWN_CROSS);
          expect(ownCross.tiebreakers, label).toEqual(sportOrder);
          expect(ownCross.sources, label).toEqual({ points: "sport", tiebreakers: "sport", crossGroup: "stage" });
          // its own cross-group order EQUAL to the derived one is still its own: the source says so, not the value
          const ownEqual = resolveTableRules(input(module, kind, cfg, { stageOwn: { ...NOTHING, crossGroup: nothing.crossGroup } }));
          expect(ownEqual.crossGroup, label).toEqual(nothing.crossGroup);
          expect(ownEqual.sources.crossGroup, label).toBe("stage");

          // A second call on the same input answers the same.
          expect(resolveTableRules(input(module, kind, cfg)), label).toStrictEqual(nothing);
          checked++;
        }
      }
    });
    expect(sports).toBe(builtinModules.length);
    expect(checked).toBeGreaterThanOrEqual(sports * TABLE_KINDS.length);
    expect(TABLE_KINDS).toHaveLength(4);
  });

  it("X-TB-1 a pin beats every layer, including a stage own value saved after it (the web re-pins; the engine never merges)", () => {
    const pin: TableRulesPin = {
      points: PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole" }),
      tiebreakers: ["points", "diff", "for", "h2h_points", "seed"],
      crossGroup: ["points", "diff", "for", "seed"],
      sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" },
    };
    const asked = { tiebreakers: 0, points: 0, parse: 0 };
    const spy: AnySportModule = {
      ...football,
      configSchema: { ...football.configSchema, safeParse: (v: unknown) => (asked.parse++, football.configSchema.safeParse(v)), parse: (v: unknown) => (asked.parse++, football.configSchema.parse(v)) } as never,
      defaultTiebreakers: (kind, cfg) => (asked.tiebreakers++, football.defaultTiebreakers(kind, cfg)),
      tablePointsRule: (cfg, kind) => (asked.points++, football.tablePointsRule(cfg, kind)),
    };
    // Every layer set, and set differently from the pin; a cfg no layer could even read.
    const everything = input(spy, "group", "not a cfg", {
      stageOwn: { points: OWN_POINTS, tiebreakers: OWN_ORDER, crossGroup: OWN_CROSS },
      divisionTiebreakers: DIVISION_ORDER,
      pinned: pin,
    });
    expect(resolveTableRules(everything)).toBe(pin);
    // A pin whose sources name a live layer is still returned whole: the engine never re-reads the layer it names.
    const fromDivision: TableRulesPin = { ...pin, sources: { points: "sport", tiebreakers: "division", crossGroup: "derived" } };
    expect(resolveTableRules({ ...everything, pinned: fromDivision })).toBe(fromDivision);
    expect(asked).toEqual({ tiebreakers: 0, points: 0, parse: 0 });
    // The same input with the pin taken away reads the stage's own layer: the pin, not the input, was answering.
    expect(resolveTableRules({ ...everything, pinned: null }).tiebreakers).toEqual(OWN_ORDER);
  });

  it("X-TB-1 a value a stored config never had (undefined, not null) inherits, layer by layer — it is never an order or a pin of its own", () => {
    const absent = undefined as never;
    const cfg = football.configSchema.parse({});
    const sport = football.defaultTiebreakers("league", cfg);
    const none = resolveTableRules(input(football, "league", cfg, { pinned: absent, divisionTiebreakers: absent, stageOwn: { points: absent, tiebreakers: absent, crossGroup: absent } }));
    expect(none.tiebreakers).toEqual(sport);
    expect(none.points).toEqual(football.tablePointsRule(cfg, "league"));
    expect(none.sources).toEqual({ points: "sport", tiebreakers: "sport", crossGroup: "derived" });
    // An absent own order over a division order: the division's.
    const division = resolveTableRules(input(football, "league", cfg, { divisionTiebreakers: DIVISION_ORDER, stageOwn: { points: absent, tiebreakers: absent, crossGroup: null } }));
    expect(division.tiebreakers).toEqual(DIVISION_ORDER);
    expect(division.sources.tiebreakers).toBe("division");
  });

  it("the points layer: own rule → else tablePointsRule(division ⊕ stage.rules, kind) — a stage's best-of-3 rules change the sport rule it inherits (volleyball)", () => {
    // D10(a): indoor best of 5 on the FIVB map — 3-0 and 3-1 pay 3:0, 3-2 pays 2:1; best of 3 — 2-0 pays 3:0, 2-1 pays 2:1.
    const division = volleyball.configSchema.parse({});
    expect(division.bestOf, "premise: the division plays best of 5").toBe(5);
    const bo5 = resolveTableRules(input(volleyball, "league", division));
    expect(bo5.points.bySetScore).toEqual({ "3-0": [3, 0], "3-1": [3, 0], "3-2": [2, 1] });
    expect(bo5.sources.points).toBe("sport");
    // The stage's rules set best of 3 over the division's cfg (W2c: division ⊕ stage.rules).
    const bo3 = resolveTableRules(input(volleyball, "league", { ...division, bestOf: 3 }));
    expect(bo3.points.bySetScore).toEqual({ "2-0": [3, 0], "2-1": [2, 1] });
    expect(bo3.sources.points).toBe("sport");
    // A merged cfg is read as the sport's schema parses it: a stored partial cfg (just the stage's bestOf) reads the
    // division defaults it leaves out — the FIVB map — rather than crashing on a missing pointsMap.
    expect(resolveTableRules(input(volleyball, "league", { bestOf: 3 })).points).toEqual(bo3.points);
    // The stage's own rule wins outright, and then the sport's rule is never built.
    let built = 0;
    const counting: AnySportModule = { ...volleyball, tablePointsRule: (cfg, kind) => (built++, volleyball.tablePointsRule(cfg, kind)) };
    const own = resolveTableRules(input(counting, "league", { ...division, bestOf: 3 }, { stageOwn: { ...NOTHING, points: OWN_POINTS } }));
    expect(own.points).toBe(OWN_POINTS);
    expect(own.sources.points).toBe("stage");
    expect(built).toBe(0);
    resolveTableRules(input(counting, "league", division));
    expect(built).toBe(1);
  });
});

describe("defaultCrossGroup (§5.9)", () => {
  it("defaultCrossGroup removes h2h_*, h2h_two, direct and the modifiers, keeping order", () => {
    // Empty case first.
    expect(defaultCrossGroup([])).toEqual([]);
    // Every key, in the vocabulary's order: exactly the head-to-head ones go, the rest keep their order.
    const kept = defaultCrossGroup(KEYS);
    expect(kept).toEqual(KEYS.filter((key) => !headToHead(key)));
    expect(kept).not.toContain("h2h_two");
    expect(kept).not.toContain("direct");
    expect(kept).not.toContain("h2h_reapply");
    expect(kept).not.toContain("h2h_exclusion");
    // Order kept, not sorted: a reversed list comes back reversed.
    expect(defaultCrossGroup([...KEYS].reverse())).toEqual(KEYS.filter((key) => !headToHead(key)).reverse());
    // An order with no head-to-head step comes back as it was.
    expect(defaultCrossGroup(["points", "diff", "for", "lots"])).toEqual(["points", "diff", "for", "lots"]);
    // The engine's own rule 4 agrees key by key: what is removed is exactly what a cross-group order refuses (D3).
    let removed = 0;
    for (const key of KEYS) {
      const refusedAcrossGroups = validateCascade([key], { module: football, cfg: {}, stageKind: "swiss", crossGroup: true }).some(
        (refusal) => refusal.reason === "cross_group",
      );
      expect(kept.includes(key), key).toBe(!refusedAcrossGroups);
      if (refusedAcrossGroups) removed++;
    }
    expect(removed).toBe(KEYS.filter(headToHead).length);
    expect(removed).toBeGreaterThan(0);
  });

  it("every sport's default order, for every table kind, defaults to a cross-group order rule 4 never refuses (counted)", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const kind of TABLE_KINDS) {
        const cfg = declaredCfgs(module)[0]!.cfg;
        const cross = resolveTableRules(input(module, kind, cfg)).crossGroup;
        expect(cross.some(headToHead), `${module.key} ${kind}`).toBe(false);
        const refusals = validateCascade(cross, { module, cfg, stageKind: kind, crossGroup: true });
        expect(refusals.filter((r) => r.reason === "cross_group"), `${module.key} ${kind}`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * TABLE_KINDS.length);
  });

  it("a stored order with a key outside the vocabulary is refused CONFIG_INVALID, never a crash", () => {
    const stored = ["points", "goal_average", "lots"] as unknown as readonly TiebreakerKey[];
    expect(() => defaultCrossGroup(stored)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    // The refusal names the key, in its words and its data (an organiser's 422 says which step is unknown).
    expect(() => defaultCrossGroup(stored)).toThrow(/"goal_average"/);
    expect(() => defaultCrossGroup(stored)).toThrow(expect.objectContaining({ data: { key: "goal_average" } }));
    expect(() => resolveTableRules(input(football, "league", {}, { divisionTiebreakers: stored }))).toThrow(EngineError);
  });
});

describe("defaultTiebreakers(kind, cfg) and the sport layer (PS-7c)", () => {
  it("defaultTiebreakers(kind, cfg) for every module × TableStageKind × the module's default cfg is non-empty and every key it returns has a comparator (anti-goal 2) — content, not totality, which tsc already enforces (forEachSport, counted; PS-9g)", () => {
    let lists = 0;
    let keys = 0;
    forEachSport(({ module }) => {
      expect(typeof module.defaultTiebreakers, `${module.key}: defaultTiebreakers is a function of (kind, cfg)`).toBe("function");
      for (const kind of TABLE_KINDS) {
        for (const { name, cfg } of declaredCfgs(module)) {
          const label = `${module.key} ${kind} ${name}`;
          const order = module.defaultTiebreakers(kind, cfg);
          expect(order.length, label).toBeGreaterThan(0);
          // Every step is a key of the vocabulary, and the ranker runs the order: four identical rows tie on every step,
          // so it visits each one — a key with no comparator throws CONFIG_INVALID there (anti-goal 2).
          for (const key of order) {
            expect(Object.hasOwn(VOCABULARY, key), `${label}: ${key}`).toBe(true);
            keys++;
          }
          const rows = ["A", "B", "C", "D"].map((id) => ({ entrantId: id, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} }));
          expect(() => rankStandings(rows, { cascade: order, results: [], rngSeed: 1 }), label).not.toThrow();
          // The caller owns what it gets: mutating one answer never reaches the next.
          const first = module.defaultTiebreakers(kind, cfg);
          first.push("lots");
          expect(module.defaultTiebreakers(kind, cfg), label).toEqual(order);
          lists++;
        }
      }
    });
    expect(lists).toBeGreaterThanOrEqual(builtinModules.length * TABLE_KINDS.length);
    expect(keys).toBeGreaterThan(lists);
  });

  it("PS-7c the sport layer is asked with the input's mergedCfg: a spy module's defaultTiebreakers receives exactly that object and the stage kind; it is not called when an own or division order wins", () => {
    const calls: { kind: TableStageKind; cfg: unknown }[] = [];
    const spy: AnySportModule = { ...football, defaultTiebreakers: (kind, cfg) => (calls.push({ kind, cfg }), football.defaultTiebreakers(kind, cfg)) };
    // A merged cfg with the organiser's own values (fair play off, 2/1/0): the sport layer reads exactly these, as the
    // sport's schema parses them — never `{}`, never the division's cfg alone.
    const merged = { fairPlay: false, points: { win: 2, draw: 1, loss: 0 } };
    resolveTableRules(input(spy, "group", merged));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("group");
    // "Exactly that object" is the merged cfg as the sport's schema parses it — the same values, not the same reference
    // (a stored partial cfg reads the schema's defaults, below).
    expect(calls[0]!.cfg).toEqual(football.configSchema.parse(merged));
    expect(calls[0]!.cfg).not.toBe(merged);
    expect((calls[0]!.cfg as { fairPlay: boolean }).fairPlay).toBe(false);
    // A stored partial cfg reads the schema's declared defaults (D8: football tracks fair play unless told not to) — the
    // reading `validateCascade` gives the same cfg, so a default and its validator cannot disagree.
    resolveTableRules(input(spy, "swiss", {}));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.kind).toBe("swiss");
    expect((calls[1]!.cfg as { fairPlay: boolean }).fairPlay).toBe(true);
    // An own order or a division order wins: the sport is not asked.
    resolveTableRules(input(spy, "league", merged, { stageOwn: { ...NOTHING, tiebreakers: OWN_ORDER } }));
    resolveTableRules(input(spy, "league", merged, { divisionTiebreakers: DIVISION_ORDER }));
    expect(calls).toHaveLength(2);
  });

  it("T8 m-R1-1 the sport's points rule comes back in the schema's form on both branches — a cfg the schema takes and one it refuses read as given: defaults applied (bonuses []), stray keys dropped", () => {
    // A sport whose rule leaves out `bonuses` (PointsRule defaults it to []) and carries a key PointsRule does not read.
    const bare = { win: { regulation: 4 }, loss: { regulation: 1 }, shootoutAs: "result", unit: "whole", stray: true };
    const spy = { ...football, tablePointsRule: () => bare } as unknown as AnySportModule;
    const taken = football.configSchema.parse({});
    const refusedCfg = { ...taken, extraTime: "not a boolean" };
    expect(football.configSchema.safeParse(refusedCfg).success, "premise: the schema refuses the second cfg").toBe(false);
    const viaParsed = resolveTableRules(input(spy, "league", taken)).points;
    const viaGiven = resolveTableRules(input(spy, "league", refusedCfg)).points;
    const schemaForm = PointsRule.parse(bare);
    expect(schemaForm.bonuses, "premise: the schema's form has the default").toEqual([]);
    expect(viaParsed).toStrictEqual(schemaForm);
    expect(viaGiven).toStrictEqual(schemaForm);
    // On a cfg the schema takes, a sport answering no rule is its own defect: thrown as the schema refuses it, not dressed.
    const broken = { ...football, tablePointsRule: () => ({ win: { regulation: "x" } }) } as unknown as AnySportModule;
    let thrown: unknown;
    try {
      resolveTableRules(input(broken, "league", taken));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(EngineError);
  });

  it("a merged cfg the sport layer cannot read is a typed CONFIG_INVALID refusal, never a crash — and a stage that never asks the sport is not refused", () => {
    // T3 M-4: a set sport's pointsMap that prices no set score. The schema takes it; the sport's rule refuses it.
    const junk = { ...volleyball.configSchema.parse({}), pointsMap: { junk: [9, 9] } };
    expect(volleyball.configSchema.safeParse(junk).success, "premise: the schema takes a stray key").toBe(true);
    expect(() => resolveTableRules(input(volleyball, "league", junk))).toThrow(EngineError);
    expect(() => resolveTableRules(input(volleyball, "league", junk))).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    // A cfg the schema refuses is read AS GIVEN — as the fold reads it (fixture-cfg.ts) and validateCascade reads it (D8)
    // — so a stored cfg that scores is never refused here. Chess's half-point scoring, stored before the schema took
    // whole points only (admin-fixture-config.test.ts seeds it): the sport prices its draw at the cfg's own 0.5.
    const halfPoints = { variant: "classical", colors: true, scoring: { win: 1, draw: 0.5, loss: 0 } };
    expect(boardgame.configSchema.safeParse(halfPoints).success, "premise: the schema refuses a half-point draw").toBe(false);
    const chess = resolveTableRules(input(boardgame, "swiss", halfPoints));
    expect(chess.points.draw).toBe(halfPoints.scoring.draw);
    expect(chess.points.win.regulation).toBe(halfPoints.scoring.win);
    expect(chess.points.unit).toBe("half");
    expect(PointsRule.safeParse(chess.points).success, "the half-point rule is a points rule").toBe(true);
    expect(chess.sources).toEqual({ points: "sport", tiebreakers: "sport", crossGroup: "derived" });
    // The other direction: a reader that meets a missing field returns `undefined` where a number belongs instead of
    // throwing. Generic's settings with a win and a draw but no loss read a rule PointsRule refuses (no loss.regulation);
    // a pin (T9) would keep it for good, so it is the typed refusal, naming the rule's own issues.
    const genericModule = builtinModules.find((m) => m.key === "generic")!;
    const noLoss = { points: { w: 3, d: 1 } };
    expect(genericModule.configSchema.safeParse(noLoss).success, "premise: the schema refuses a cfg with no loss").toBe(false);
    expect(PointsRule.safeParse(genericModule.tablePointsRule(noLoss as never, "league")).success, "premise: read as given it is no points rule").toBe(false);
    let lossless: unknown;
    try {
      resolveTableRules(input(genericModule, "league", noLoss));
    } catch (e) {
      lossless = e;
    }
    expect(lossless).toBeInstanceOf(EngineError);
    expect((lossless as EngineError).code).toBe("CONFIG_INVALID");
    expect((lossless as EngineError).message).toMatch(/generic settings do not parse, so the table rule .* is no points rule/);
    const ruleIssues = ((lossless as EngineError).data as { ruleIssues?: { path: unknown[] }[] }).ruleIssues;
    expect(ruleIssues?.map((i) => i.path.join("."))).toContain("loss.regulation");
    expect(((lossless as EngineError).data as { issues?: unknown[] }).issues?.length, "the schema's issues ride along").toBeGreaterThan(0);
    // A cfg the sport cannot read even as given — generic's settings with no result mode and no points — is the typed
    // refusal, naming the schema's issues, never the TypeError reading it would be.
    let generic: unknown;
    try {
      resolveTableRules(input(builtinModules.find((m) => m.key === "generic")!, "league", {}));
    } catch (e) {
      generic = e;
    }
    expect(generic).toBeInstanceOf(EngineError);
    expect((generic as EngineError).code).toBe("CONFIG_INVALID");
    expect((generic as EngineError).message).toMatch(/generic settings do not parse, so its sport's table rules cannot be read/);
    // What the reading made of it rides along for the log: the TypeError it would have been.
    expect(((generic as EngineError).data as { reading?: unknown }).reading).toMatch(/^TypeError/);
    expect(((generic as EngineError).data as { issues?: { path: unknown[] }[] }).issues?.map((i) => i.path[0])).toContain("resultMode");
    // A sport's OWN typed refusal of a cfg read as given stands as the sport worded it, never re-worded as "do not parse":
    // a set map left pricing no set score (M-4) beside a best-of the schema refuses.
    const evenBestOf = { ...volleyball.configSchema.parse({}), bestOf: 4, pointsMap: {} };
    expect(volleyball.configSchema.safeParse(evenBestOf).success, "premise: the schema refuses an even best-of").toBe(false);
    expect(() => resolveTableRules(input(volleyball, "league", evenBestOf))).toThrow(/prices no set score/);
    // In every sport, the cfgs above that its schema refuses (a cfg a sport's schema takes is the parsed path, skipped):
    // the sport answers with a rule PointsRule takes, or refuses typed — never another error, never a rule with a hole
    // (counted; both halves reached: chess answers its half-point cfg, every sport refuses 42).
    const refusedCfgs: readonly { name: string; cfg: unknown }[] = [
      { name: "42", cfg: 42 },
      { name: "half-point chess", cfg: halfPoints },
      { name: "a win and a draw, no loss", cfg: noLoss },
    ];
    let asGiven = 0;
    let answered = 0;
    let refused = 0;
    const swept = forEachSport(({ module }) => {
      for (const { name, cfg } of refusedCfgs) {
        if (module.configSchema.safeParse(cfg).success) continue;
        asGiven++;
        const label = `${module.key} ${name}`;
        let caught: unknown;
        let got: TableRulesPin | undefined;
        try {
          got = resolveTableRules(input(module, "league", cfg));
        } catch (e) {
          caught = e;
        }
        if (got !== undefined) {
          answered++;
          expect(PointsRule.safeParse(got.points).success, label).toBe(true);
        } else {
          refused++;
          expect(caught, label).toBeInstanceOf(EngineError);
          expect((caught as EngineError).code, label).toBe("CONFIG_INVALID");
          expect(((caught as EngineError).data as { issues?: unknown[] }).issues?.length, label).toBeGreaterThan(0);
        }
      }
    });
    expect(swept).toBe(builtinModules.length);
    expect(answered + refused).toBe(asGiven);
    expect(asGiven, "every sport's schema refuses 42").toBeGreaterThanOrEqual(builtinModules.length);
    expect(answered, "a sport reads a cfg its schema refuses and scores it (chess half points)").toBeGreaterThan(0);
    expect(refused, "a sport that reads its cfg refuses 42").toBeGreaterThan(0);
    // The same unreadable cfgs on a stage whose own layers (or pin) answer everything: nothing asks the sport, nothing throws.
    const ownAll = { stageOwn: { points: OWN_POINTS, tiebreakers: OWN_ORDER, crossGroup: null } };
    expect(resolveTableRules(input(volleyball, "league", junk, ownAll)).tiebreakers).toEqual(OWN_ORDER);
    expect(resolveTableRules(input(volleyball, "league", 42, ownAll)).points).toBe(OWN_POINTS);
    // Own points, the division's order: the order needs no cfg reading, the junk map is never priced.
    expect(resolveTableRules(input(volleyball, "league", junk, { stageOwn: { ...NOTHING, points: OWN_POINTS }, divisionTiebreakers: DIVISION_ORDER })).sources)
      .toEqual({ points: "stage", tiebreakers: "division", crossGroup: "derived" });
  });
});

// ---------------------------------------------------------------------------
// completeTableStage reads the stage's rules (E1)
// ---------------------------------------------------------------------------

const side = (id: string, o: { won?: number; drawn?: number; lost?: number; points: number; metrics?: Record<string, number> }) => ({
  entrantId: id, played: 1, won: o.won ?? 0, drawn: o.drawn ?? 0, lost: o.lost ?? 0, points: o.points, metrics: o.metrics ?? {},
});
/** A goals match paid 3/1/0, W/D/L and gf/ga/gd from the score; `ot` marks the winner's win as an overtime one (won_ot). */
function goals(home: string, away: string, hg: number, ag: number, ot = false): FixtureResult {
  const hw = hg > ag ? 1 : 0;
  const aw = ag > hg ? 1 : 0;
  const d = hg === ag ? 1 : 0;
  return [
    side(home, { won: hw, drawn: d, lost: aw, points: 3 * hw + d, metrics: { gf: hg, ga: ag, gd: hg - ag, ...(ot && hw ? { won_ot: 1 } : {}) } }),
    side(away, { won: aw, drawn: d, lost: hw, points: 3 * aw + d, metrics: { gf: ag, ga: hg, gd: ag - hg, ...(ot && aw ? { won_ot: 1 } : {}) } }),
  ];
}
/** A chess game in a round robin that pays the 3/1/0 preset (RB2B-18). */
function chess(home: string, away: string, r: "1-0" | "½-½" | "0-1"): FixtureResult {
  if (r === "½-½") return [side(home, { drawn: 1, points: 1 }), side(away, { drawn: 1, points: 1 })];
  const hw = r === "1-0" ? 1 : 0;
  return [side(home, { won: hw, lost: 1 - hw, points: 3 * hw }), side(away, { won: 1 - hw, lost: hw, points: 3 * (1 - hw) })];
}
const decided = (results: readonly FixtureResult[]): TableFixture[] => results.map((result, i) => ({ id: `f${i}`, status: "decided", result }));
const rulesOf = (tiebreakers: readonly TiebreakerKey[]): TableRules => ({ points: OWN_POINTS, tiebreakers, crossGroup: defaultCrossGroup(tiebreakers) });
const order = (stage: TableStage, fixtures: readonly TableFixture[]) => completeTableStage(stage, fixtures).tables.overall!.map((r) => r.entrantId);

describe("completeTableStage — the stage's TableRules (E1)", () => {
  it("completeTableStage ranks with rules.tiebreakers and returns newLotsDraws; h2hRecursive no longer exists on TableStage", () => {
    // A and B on 3 points: A has the better goal difference (+3 vs +1), B scored more (5 vs 3). C and D drew 1-1 and
    // played nobody else: level on every step. E (−3) and F (−1) lost.
    const fixtures = decided([goals("A", "E", 3, 0), goals("B", "F", 5, 4), goals("C", "D", 1, 1)]);
    const base: TableStage = { id: "s", kind: "league", entrants: ["A", "B", "C", "D", "E", "F"], rules: rulesOf(["points", "diff", "lots"]), rngSeed: 3 };
    expect(order(base, fixtures).slice(0, 2)).toEqual(["A", "B"]);
    // The stage's order is what ranks: by goals scored, B is first.
    expect(order({ ...base, rules: rulesOf(["points", "for", "lots"]) }, fixtures).slice(0, 2)).toEqual(["B", "A"]);
    // The rule's points and cross-group order are carried, not applied: the table is the fold of the fixtures it is given.
    const other: TableRules = { ...rulesOf(["points", "diff", "lots"]), points: PointsRule.parse({ win: { regulation: 1 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole" }), crossGroup: ["lots"] };
    expect(completeTableStage({ ...base, rules: other }, fixtures).tables).toStrictEqual(completeTableStage(base, fixtures).tables);

    // C and D level on everything: their order is a drawing of lots, returned to be stored.
    const drawn = completeTableStage(base, fixtures);
    expect(drawn.newLotsDraws).toHaveLength(1);
    expect(drawn.newLotsDraws[0]).toMatchObject({ pool: "", membersKey: "C,D", members: ["C", "D"] });
    expect(drawn.events.filter((e) => e.type === "rank_lock_required")).toEqual([{ type: "rank_lock_required", stageId: "s", group: ["C", "D"] }]);
    // An order with no `lots` draws nothing: the residual tie stays seed → id.
    expect(completeTableStage({ ...base, rules: rulesOf(["points", "diff"]) }, fixtures).newLotsDraws).toEqual([]);
    // After a void, C and D never played: still level with each other (0 points, 0 goals), still drawn.
    const voided = fixtures.map((f, i) => (i === 2 ? { ...f, status: "void" as const } : f));
    expect(completeTableStage(base, voided).newLotsDraws.map((d) => d.membersKey)).toEqual(["C,D"]);

    // The retired fields are gone from the type (engine tsc holds these two directives).
    // @ts-expect-error — UEFA re-application is the cascade's own `h2h_reapply` modifier now (W2d T4).
    const recursive: TableStage = { ...base, h2hRecursive: true };
    // @ts-expect-error — the order is `rules.tiebreakers` (W2d T8).
    const cascade: TableStage = { ...base, cascade: ["points"] };
    expect([recursive.id, cascade.id]).toEqual(["s", "s"]);
  });

  it("HK-TB-1 completeTableStage hands the stage's winsCount to the ranker: under 'regulation' an overtime win is not a win for the `wins` step", () => {
    // A won in regulation 1-0, B in overtime 5-0: both on 3 points. Every win counted, `wins` ties and goal difference
    // puts B first; FIH counts regulation wins only (RBG:236), so A has 1 win to B's 0.
    const fixtures = decided([goals("A", "C", 1, 0), goals("B", "D", 5, 0, true)]);
    const stage: TableStage = { id: "s", kind: "league", entrants: ["A", "B", "C", "D"], rules: rulesOf(["points", "wins", "diff", "lots"]), rngSeed: 1 };
    expect(order(stage, fixtures).slice(0, 2)).toEqual(["B", "A"]);
    expect(order({ ...stage, winsCount: "all" }, fixtures).slice(0, 2)).toEqual(["B", "A"]);
    expect(hockey.winsCount).toBe("regulation");
    expect(order({ ...stage, winsCount: hockey.winsCount }, fixtures).slice(0, 2)).toEqual(["A", "B"]);
  });

  it("B5 completeTableStage hands the stage's gamePoints to the ranker: a 3/1/0 chess round robin scores Sonneborn-Berger on game points", () => {
    // Six players, the 3/1/0 preset (tiebreak-keys-w2d.test.ts BG-TB-1): A and E level on 5 table points. SB on GAME points
    // (FIDE C.07): A 3¼, E 3½ → E above A. On the 3/1/0 table points both have 9: a drawing of lots.
    const results = [
      chess("A", "B", "0-1"), chess("A", "C", "0-1"), chess("A", "D", "1-0"), chess("A", "E", "½-½"), chess("A", "F", "½-½"),
      chess("B", "C", "½-½"), chess("B", "D", "1-0"), chess("B", "E", "½-½"), chess("B", "F", "1-0"),
      chess("C", "D", "1-0"), chess("C", "E", "1-0"), chess("C", "F", "1-0"),
      chess("D", "E", "1-0"), chess("D", "F", "1-0"), chess("E", "F", "1-0"),
    ];
    const gamePointOf = (d: { won: number; drawn: number }): number => (d.won === 1 ? 2 : d.drawn === 1 ? 1 : 0);
    const stage: TableStage = {
      id: "s", kind: "league", entrants: ["A", "B", "C", "D", "E", "F"], rules: rulesOf(["points", "sberger", "lots"]), rngSeed: 1,
    };
    // single-sport: chess is the sport whose game points differ from its table points (B5) — the gamePoints seam
    expect(boardgame.key, "premise: the B5 case is chess's").toBe("boardgame");
    const byTable = completeTableStage(stage, decided(results));
    expect(byTable.newLotsDraws.map((d) => d.membersKey)).toEqual(["A,E"]);
    const byGame = completeTableStage({ ...stage, gamePoints: (r) => [gamePointOf(r[0]), gamePointOf(r[1])] }, decided(results));
    expect(byGame.tables.overall!.map((r) => r.entrantId)).toEqual(["C", "B", "D", "E", "A", "F"]);
    expect(byGame.newLotsDraws).toEqual([]);
  });
});
