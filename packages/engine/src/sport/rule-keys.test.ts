// P1 engine sweep (spec §9, §4.1 as amended) and the match-override check
// (X-SR-2). Moves with the engine. Expected populations come from the
// registry, the cfg schemas and the modules' own declarations (`ruleKeys`,
// `variants`, `StageKind`, `BRACKET_KINDS`, `DRAW_KINDS`), never from
// rule-keys.ts. Helpers are imported through the `@seazn/engine/sport` barrel,
// the seam apps/web reads them from.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { SHOOTOUT_ATTEMPTS_DEFAULT } from "../sports/football/football.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { schemaHasPath, schemaTopKeys } from "../testkit/schema-paths.ts";
import {
  checkFixtureOverride, deciderKeysFor, fixtureKeysFor, pointsKeysFor, ruleKeyApplies, ruleKeyOwning, sportTopKeys,
  stageDefaultsFor, stageKeysFor, stageTopKeysFor,
  type AnySportModule, type RuleKeyFact, type RuleKeys, type RuleScope,
} from "./index.ts";

const KINDS = StageKind.options;
const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
/** A module that declares only `ruleKeys`: the helpers read nothing else. Used
 *  where no builtin declares the shape under test (said at each use). */
const fake = (ruleKeys: RuleKeys): AnySportModule => ({ key: "fake", ruleKeys }) as unknown as AnySportModule;
/** A module's deciders, read from its own declaration: every key carrying a `matchBound` (X-SR-2, signed). */
const deciders = (m: AnySportModule): [string, RuleKeyFact][] =>
  Object.entries(m.ruleKeys ?? {}).filter(([, f]) => f.matchBound !== undefined);
const deciderCount = (): number => builtinModules.reduce((n, m) => n + deciders(m).length, 0);
/** The value at a dotted cfg path; undefined through an absent or null parent. */
const at = (o: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((a, k) => (a !== null && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
/** An override changing ONE dotted leaf of `stage`, carrying the whole top-level value as the writer sends it. */
function overrideAt(stage: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const set = (o: unknown, path: readonly string[]): unknown =>
    path.length === 0 ? value : { ...(o as Record<string, unknown>), [path[0]!]: set((o as Record<string, unknown>)[path[0]!], path.slice(1)) };
  const [top, ...rest] = key.split(".");
  return { [top!]: set(stage[top!], rest) };
}
const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A top-level key switched ON over `preset`, from the engine's own values: a boolean true, an `{enabled}` object
 *  enabled; an absent or null value takes what the bracket deciders force, else the first value another declared cfg
 *  gives it; anything else (a length, an enum) is already on as the preset holds it. */
function switchedOn(m: AnySportModule, top: string, preset: Record<string, unknown>, donors: readonly Record<string, unknown>[]): unknown {
  const v = preset[top];
  if (typeof v === "boolean") return true;
  if (isPlainObj(v) && typeof v.enabled === "boolean") return { ...v, enabled: true };
  if (v !== undefined && v !== null) return v;
  const forced = (m.bracketDeciders(preset) as Record<string, unknown>)[top];
  return forced ?? donors.map((d) => d[top]).find((d) => d !== undefined && d !== null);
}

/** Every cfg a sport DECLARES, with what a NEW stage of each bracket kind stores over it (`stageDefaults`, spec §4.2) —
 *  the engine's own declaration of a knockout preset. A key only a stage preset sets (football's shootoutAttempts) has a
 *  value to sweep nowhere else: `declaredCfgs` reads variants, and no variant carries it. The base cfgs come first and
 *  unchanged; a preset that adds nothing for a cell adds no row. */
function declaredCfgsWithStagePresets(m: AnySportModule): { name: string; cfg: Record<string, unknown> }[] {
  const base = declaredCfgs(m).map(({ name, cfg }) => ({ name, cfg: cfg as Record<string, unknown> }));
  const staged: { name: string; cfg: Record<string, unknown> }[] = [];
  for (const { name, cfg } of base)
    for (const kind of BRACKET_KINDS) {
      const preset = stageDefaultsFor(m, kind, Object.hasOwn(m.variants, name) ? name : null);
      if (Object.keys(preset).length > 0) staged.push({ name: `${name}+${kind}`, cfg: m.configSchema.parse({ ...cfg, ...preset }) as Record<string, unknown> });
    }
  return [...base, ...staged];
}

/** Top-level cfg keys an organiser never sets, per sport, each with its reason.
 *  Reviewed line by line; a new schema key fails the sweep until it is either
 *  declared in ruleKeys or listed here, and a row whose key becomes declared
 *  fails until it is deleted. */
const VARIANT = "a variant fact: set by the variant preset, never edited per stage or match (not in spec §4.1 Q5's settable list)";
const BOOKKEEPING = "scorer bookkeeping or pad vocabulary, not a format rule";
const PERIOD_SECONDS =
  "a per-phase length override in seconds, only for periods of UNEQUAL length (period/kernel.ts:781-786); the settable length is the minutes scalar Q5 names";
const PERIOD_UNSET = {
  setPieceKinds: BOOKKEEPING, goalkeeper: BOOKKEEPING, periodSeconds: PERIOD_SECONDS, suspensions: VARIANT,
  strength: VARIANT, goalKinds: BOOKKEEPING, assists: BOOKKEEPING,
} as const;
const SET_UNSET = { records: "stat-recording flags, not a format rule" } as const;
const UNSETTABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  volleyball: SET_UNSET, badminton: SET_UNSET,
  tabletennis: { ...SET_UNSET, cap: "ITTF has no cap (the preset's cap is null: deuce runs on until a two-point lead); the set kernel's key exists, table tennis narrows it out" },
  tennis: { interruptions: BOOKKEEPING },
  football: {
    periodSeconds: PERIOD_SECONDS,
    halves: "picks the phase machine (2 halves or 4 quarters); a variant fact",
    fairPlay: "card tracking for the FIFA fair-play tie-break; the tie-break cascade is W2d's",
  },
  cricket: {
    inningsPerSide: VARIANT, ballsPerOver: VARIANT, followOn: VARIANT,
    reviews: "the DRS review allowance per innings per side (W4 domain audit); not in spec §4.1 Q5's settable list",
    lineupChanges: "team-sheet policy, owned by the lineups programme (W4)",
  },
  icehockey: PERIOD_UNSET,
  hockey: { ...PERIOD_UNSET, overtime: "hockey has no overtime (FIH); the kernel key exists, hockey narrows it out" },
  boardgame: {
    colors: "home = White (chess.md §2); the in-page chess contract owns colours (do not touch colorOfHome)",
    tiebreak: "forced on for every bracket stage by bracketDeciders; the organiser's decider is the tiebreakRungs list, whose EMPTY list is \"no tie-break games\" (BG-KO-1, BG-KO-3)",
  },
  carrom: {},
  generic: { progressScore: "a pad display switch, not a result rule" },
};

/** THE RULEBOOK: spec §4.1 Q5, owner-approved (docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md:160-166),
 *  in its three lists — match (:160-162), stage only (:163-165), points (:166). Q5 names keys in rule vocabulary; the
 *  plan's Task 4 declaration table ("by ENGINE key", plans/2026-10-13-format-matrix-w2c.md) says where each lives in
 *  an engine cfg (`Q5_WHERE`) and which keys it declares that no Q5 name covers (`PLAN_ONLY`). Each scope is pinned on
 *  its own, so a key moved between ANY two scopes goes red. */
const Q5 = {
  match: [
    "bestOf", "setTo", "finalSetTo", "finalSet", "setType", "gameTo", "cap", "winBy", "tiebreakWinBy", "noAd",
    "halfMinutes", "quarterMinutes", "periodMinutes", "overtimeMinutes", "shootoutAttempts", "overs",
    "maxOversPerBowler", "maxBoards", "extraTime",
  ],
  stage: [
    "allowDraws", "shootout", "superOver", "overtime", "dls", "tieBoard", "variant", "resultMode", "teamSize",
    "playersPerSide", "maxSubs", "subWindows", "sinBinMinutes", "overtimeSkaters", "queenFollowsBoard", "queenCapAt",
    "queenPoints", "clockBaseMinutes", "clockIncrementSeconds", "clockDelaySeconds", "tiebreakRungs", "abandon",
  ],
  // W2d (spec §5.3, D10(e); PS-1): the shoot-out split became one bonus (football, hockey), greenfield.
  points: ["soBonus"],
} as const satisfies Record<RuleScope, readonly string[]>;
/** Q5 names no engine cfg holds yet, each with the task that adds it; the sweep fails once one lands, so its row goes. */
const Q5_PENDING: Readonly<Record<string, string>> = {
};
/** Where a Q5 name lives in an engine cfg: the schema path it names, and the declared key owning that path (default:
 *  the path itself). A sport row wins over the shared one. */
interface Where { readonly path: string; readonly owner?: string }
const Q5_WHERE: Readonly<Record<string, Where>> = {
  setType: { path: "set" }, noAd: { path: "game.noAd" }, tiebreakWinBy: { path: "tiebreak.winBy" },
  periodMinutes: { path: "periods.minutes" }, quarterMinutes: { path: "periods.minutes" },
  overtimeMinutes: { path: "overtime.minutes" }, shootoutAttempts: { path: "shootout.attempts" },
  overs: { path: "ballsPerInnings" }, overtimeSkaters: { path: "overtime.skaters", owner: "overtime" },
  clockBaseMinutes: { path: "clock.base", owner: "clock" }, clockIncrementSeconds: { path: "clock.increment", owner: "clock" },
  clockDelaySeconds: { path: "clock.delay", owner: "clock" }, abandon: { path: "abandonPolicy" },
  soBonus: { path: "points.soBonus", owner: "points" },
};
const Q5_WHERE_BY_SPORT: Readonly<Record<string, Readonly<Record<string, Where>>>> = {
  football: { shootoutAttempts: { path: "shootoutAttempts" } }, // W2c Task 6 adds it to the schema, top-level
};
/** Keys the plan's Task 4 table declares that no Q5 name covers, by sport and scope — each straight from that table. */
const SET_PLAN = { points: ["pointsMap"] } as const;
const PLAN_ONLY: Readonly<Record<string, Partial<Record<RuleScope, readonly string[]>>>> = {
  volleyball: SET_PLAN, badminton: SET_PLAN, tabletennis: SET_PLAN,
  tennis: { points: ["points"] },
  football: { stage: ["rollingSubs", "concussionSubs"], points: ["awardScore"] },
  cricket: { stage: ["superOverStillTied", "minOversForResult"], points: ["points"] },
  // W2d (spec D10(e), PS-1): ice hockey keeps its `points` key for `otWin`/`otLoss` (a GWS pays them); Q5's shoot-out
  // names became football's and hockey's `soBonus`, which a result sport's schema does not take.
  icehockey: { points: ["awardScore", "points"] },
  hockey: { points: ["awardScore"] },
  boardgame: { points: ["scoring", "byeScore"] },
  carrom: { stage: ["pointsPerCoin"], points: ["points"] },
  generic: { points: ["points"] },
};
/** The bounded deciders a match may only shorten or switch off: extraTime "per match only off or shorter" (Q5,
 *  RB2B-3); the overtime and shoot-out LENGTHS shorter only (X-SR-2, signed; coordinator correction 2026-10-13). */
const Q5_MATCH_BOUNDS: Readonly<Record<string, RuleKeyFact["matchBound"]>> = {
  extraTime: "off_or_shorter", overtimeMinutes: "shorter", shootoutAttempts: "shorter",
};
/** The WHOLE deciders (spec §4.1 "plus the existing decider keys"; X-SR-6): Q5's decider names, plus the chess bracket
 *  tie-break games, which no Q5 name covers as a decider. For chess the decider is the ordered RUNG LIST
 *  (`tiebreakRungs`, BG-KO-1, BG-KO-3): its off state is the EMPTY list, which holds a drawn game for the organiser. The
 *  bare `tiebreak` switch is not a decider any more (UNSETTABLE above: bracketDeciders forces it on). */
const Q5_WHOLE_DECIDERS = ["extraTime", "shootout", "overtime", "superOver", "tieBoard"] as const;
const PLAN_ONLY_DECIDERS: Readonly<Record<string, readonly string[]>> = { boardgame: ["tiebreakRungs"] };
const whereOf = (m: AnySportModule, name: string): Where => Q5_WHERE_BY_SPORT[m.key]?.[name] ?? Q5_WHERE[name] ?? { path: name };
/** The declared key a Q5 name maps to in this sport, or null where its schema holds no such path (or holds it only
 *  under a top-level key the UNSETTABLE table keeps out). */
function q5Owner(m: AnySportModule, name: string): string | null {
  const where = whereOf(m, name);
  const path = where.path.split(".");
  if (!schemaHasPath(m.configSchema, path) || Object.hasOwn(UNSETTABLE[m.key] ?? {}, path[0]!)) return null;
  return where.owner ?? where.path;
}
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

describe("X-SR-1 P1 engine sweep — ruleKeys", () => {
  it("the testkit path reader answers no as well as yes (the sweep below leans on it)", () => {
    // Single-sport: icehockey's overtime is the one cfg union whose options carry different leaves.
    const ice = sport("icehockey").configSchema;
    expect(schemaHasPath(ice, [])).toBe(true);
    expect(schemaHasPath(ice, ["overtime", "minutes"])).toBe(true);
    expect(schemaHasPath(ice, ["overtime", "skaters"])).toBe(true); // the sudden_death option only
    expect(schemaHasPath(ice, ["overtime", "count"])).toBe(true); // the periods option only
    expect(schemaHasPath(ice, ["overtime", "bogus"])).toBe(false);
    expect(schemaHasPath(ice, ["periods", "minutes", "deeper"])).toBe(false);
    expect(schemaHasPath(ice, ["nope"])).toBe(false);
    expect(schemaTopKeys(ice)).toContain("overtime");
    expect(schemaTopKeys(z.number())).toEqual([]);
  });

  it("every builtin module declares ruleKeys, and every declared key is a real schema path", () => {
    let checked = 0;
    for (const m of builtinModules) {
      expect(m.ruleKeys, m.key).toBeDefined();
      for (const key of Object.keys(m.ruleKeys!)) {
        expect(schemaHasPath(m.configSchema, key.split(".")), `${m.key}: ${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + Object.keys(m.ruleKeys ?? {}).length, 0));
    expect(checked).toBeGreaterThan(builtinModules.length);
  });

  it("UNSETTABLE names exactly the builtin sports, and each row is a real top-level key that is not declared", () => {
    expect(Object.keys(UNSETTABLE).sort()).toEqual(builtinModules.map((m) => m.key).sort());
    let checked = 0;
    for (const m of builtinModules) {
      const tops = schemaTopKeys(m.configSchema);
      const declared = new Set(Object.keys(m.ruleKeys ?? {}).map((k) => k.split(".")[0]!));
      for (const [top, reason] of Object.entries(UNSETTABLE[m.key] ?? {})) {
        expect(tops, `${m.key}.${top} is not a schema key`).toContain(top);
        expect(declared.has(top), `${m.key}.${top} is declared: delete its UNSETTABLE row`).toBe(false);
        expect(reason.length, `${m.key}.${top}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(Object.values(UNSETTABLE).reduce((n, rows) => n + Object.keys(rows).length, 0));
    expect(checked).toBeGreaterThan(0);
  });

  it("every top-level schema key is declared or listed UNSETTABLE with a reason", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const declared = new Set(Object.keys(m.ruleKeys ?? {}).map((k) => k.split(".")[0]!));
      const unsettable = UNSETTABLE[m.key] ?? {};
      for (const top of schemaTopKeys(m.configSchema)) {
        const ok = declared.has(top) || (Object.hasOwn(unsettable, top) && unsettable[top]!.length > 0);
        expect(ok, `${m.key}.${top} is neither a ruleKey nor UNSETTABLE`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + schemaTopKeys(m.configSchema).length, 0));
    expect(checked).toBeGreaterThan(0);
  });

  it("every decider (a key with a matchBound) is a match key holding the shape its bound reads in every declared cfg", () => {
    let checked = 0;
    let values = 0;
    for (const m of builtinModules)
      for (const [key, fact] of deciders(m)) {
        expect(fact.scope, `${m.key}.${key}`).toBe("match");
        const held = declaredCfgsWithStagePresets(m).map(({ cfg }) => at(cfg, key)).filter((v) => v !== undefined);
        expect(held.length, `${m.key}.${key}: no declared cfg holds it`).toBeGreaterThan(0);
        for (const v of held) {
          if (fact.matchBound === "off_or_shorter") {
            expect(schemaHasPath(m.configSchema, [...key.split("."), "enabled"]), `${m.key}.${key}.enabled`).toBe(true);
            expect(typeof at(v, "enabled"), `${m.key}.${key}.enabled`).toBe("boolean");
            expect(typeof at(v, "halfMinutes"), `${m.key}.${key}.halfMinutes`).toBe("number");
          } else {
            expect(typeof v, `${m.key}.${key}`).toBe("number");
          }
          values++;
        }
        checked++;
      }
    expect(checked).toBe(deciderCount());
    expect(checked).toBeGreaterThan(0);
    expect(values).toBeGreaterThanOrEqual(checked);
  });

  // W2c Task 17, fix round 1 (review M-4): the stage editor holds a decider's detail (the kicks of a shoot-out, the minutes
  // of an overtime) while its decider is off, and reads the pairing from the engine's `detailOf`. The expected pairs are the
  // rulebook's: FB-SO-1 (the kicks are the penalty shoot-out's) and the period kernel's own comment (the overtime and the
  // shoot-out are stage objects whose LENGTH leaves a match may lower).
  const DETAILS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    football: { shootoutAttempts: "shootout" },
    hockey: { "shootout.attempts": "shootout" },
    icehockey: { "overtime.minutes": "overtime", "shootout.attempts": "shootout" },
    // W2e Task 7 (A1c-2, ruling 157): what a TIED super over does (repeat / boundary count / shared) is only asked while
    // the super over is on (cricket DOMAIN.md, "Super over"; `canEndLevel` reads it under `cfg.superOver` alone).
    cricket: { superOverStillTied: "superOver" },
  };

  it("every bounded key is a whole decider or the detail of one: `detailOf` names a declared decider of the same sport, and the pairs are the rulebook's (counted)", () => {
    let bounded = 0;
    let details = 0;
    for (const m of builtinModules) {
      for (const [key, fact] of deciders(m)) {
        bounded++;
        if (fact.decider === true) expect(fact.detailOf, `${m.key}.${key}: a whole decider is not a detail`).toBeUndefined();
        else expect(fact.detailOf, `${m.key}.${key}: a bounded key that is not a decider is a detail of one`).toBeDefined();
      }
      const declared: Record<string, string> = {};
      for (const [key, fact] of Object.entries(m.ruleKeys ?? {})) {
        if (fact.detailOf === undefined) continue;
        expect(m.ruleKeys![fact.detailOf]?.decider, `${m.key}.${key} -> ${fact.detailOf} is a declared whole decider`).toBe(true);
        declared[key] = fact.detailOf;
        details++;
      }
      expect(declared, `${m.key}: the declared pairs`).toEqual(DETAILS[m.key] ?? {});
    }
    expect(bounded).toBe(deciderCount());
    expect(details).toBe(Object.values(DETAILS).reduce((n, d) => n + Object.keys(d).length, 0));
    expect(details).toBeGreaterThan(0);
  });

  // Single-sport on purpose: `superOverStillTied` is cricket's key and no other sport declares one; the all-sport population
  // (every `detailOf` in the registry is the rulebook's pair, counted) is the sweep above.
  it("cricket superOverStillTied is a detail of superOver", () => {
    const cricket = sport("cricket");
    const facts = cricket.ruleKeys!;
    expect(facts.superOverStillTied, "premise: the key is declared").toBeDefined();
    expect(facts.superOverStillTied!.detailOf, "held by the super over").toBe("superOver");
    expect(facts.superOver?.decider, "the super over is a declared whole decider").toBe(true);
    // Still a stage key (the field is per stage, never per match) and still no decider of its own: the knockout
    // preselection and the "no decider" notice read `decider: true`, and a policy is not what settles a level match.
    expect(facts.superOverStillTied!.scope).toBe("stage");
    expect(facts.superOverStillTied!.decider).toBeUndefined();
    // Positive pair, on the stage a knockout creates: the pairing moved nothing about which keys the stage carries.
    expect(stageKeysFor(cricket, "knockout", "t20")).toContain("superOverStillTied");
    expect(deciderKeysFor(cricket, "knockout", "t20")).toContain("superOver");
    expect(deciderKeysFor(cricket, "knockout", "t20")).not.toContain("superOverStillTied");
    // The negative pair: cricket's other stage keys are not details (a pairing declared too widely would hold them too).
    const details = Object.entries(facts).filter(([, f]) => f.detailOf !== undefined).map(([k]) => k);
    expect(details).toEqual(["superOverStillTied"]);
    expect(Object.keys(facts).length, "the other cricket keys were walked").toBeGreaterThan(details.length);
  });

  // W2e Task 7 (controller ruling, Task 28 anti-goal 3): a detail offered where its decider cannot exist is a control that is
  // held for ever. The oracle is the schema's own refusal (`CricketCfg` rejects a super over unless one innings a side, CK-SO-1),
  // not the `appliesTo` under test.
  it("cricket superOverStillTied is offered exactly on the variants that can play a super over, in every stage kind (counted)", () => {
    const cricket = sport("cricket");
    const offered: string[] = [];
    const refused: string[] = [];
    for (const [name, variant] of Object.entries(cricket.variants)) {
      const canPlay = cricket.configSchema.safeParse({ ...variant, superOver: true }).success;
      (canPlay ? offered : refused).push(name);
      for (const kind of KINDS) {
        expect(stageKeysFor(cricket, kind, name).includes("superOverStillTied"), `${name}/${kind}: the still-tied policy`).toBe(canPlay);
        expect(deciderKeysFor(cricket, kind, name).includes("superOver"), `${name}/${kind}: the super over itself`).toBe(canPlay);
      }
    }
    // Both populations are non-empty (a sweep over an empty side proves nothing), and the two formats named in CK-SO-1 are on
    // the right sides: a two-innings test match never goes to a super over; the limited-overs formats do.
    expect(offered.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused).toContain("test");
    for (const v of ["t20", "odi", "hundred"]) expect(offered, v).toContain(v);
    // The division level (no variant) is never narrowed, as for every other key.
    expect(stageKeysFor(cricket, "knockout", null)).toContain("superOverStillTied");
  });

  it("a detail is offered exactly where its decider is: no registry sport declares a detail wider than its decider (counted)", () => {
    let details = 0;
    let cells = 0;
    for (const m of builtinModules)
      for (const [key, fact] of Object.entries(m.ruleKeys ?? {})) {
        if (fact.detailOf === undefined) continue;
        const decider = m.ruleKeys![fact.detailOf]!;
        details++;
        for (const kind of [null, ...KINDS])
          for (const variant of [null, ...Object.keys(m.variants)]) {
            expect(ruleKeyApplies(fact, kind, variant), `${m.key}.${key} vs ${fact.detailOf} at ${String(kind)}/${String(variant)}`).toBe(ruleKeyApplies(decider, kind, variant));
            cells++;
          }
      }
    expect(details).toBe(Object.values(DETAILS).reduce((n, d) => n + Object.keys(d).length, 0));
    expect(cells).toBeGreaterThan(details);
  });

  it("Q5 (rulebook): each sport's match, stage and points keys are exactly Q5's lists plus the plan's, restricted to its schema", () => {
    let sports = 0;
    const counts: Record<RuleScope, number> = { match: 0, stage: 0, points: 0 };
    const hit = new Set<string>();
    for (const m of builtinModules) {
      for (const scope of ["match", "stage", "points"] as const) {
        const fromQ5 = new Set<string>();
        for (const name of Q5[scope]) {
          const owner = q5Owner(m, name);
          if (owner === null) continue;
          fromQ5.add(owner);
          hit.add(name);
        }
        const planOnly = PLAN_ONLY[m.key]?.[scope] ?? [];
        for (const key of planOnly) {
          expect(schemaHasPath(m.configSchema, key.split(".")), `${m.key}: PLAN_ONLY ${key} is not a schema path`).toBe(true);
          expect(fromQ5.has(key), `${m.key}: PLAN_ONLY ${key} is already a Q5 key`).toBe(false);
        }
        const expected = sorted([...fromQ5, ...planOnly]);
        const declared = sorted(Object.entries(m.ruleKeys ?? {}).filter(([, f]) => f.scope === scope).map(([k]) => k));
        expect(declared, `${m.key}: ${scope} keys vs Q5`).toEqual(expected);
        counts[scope] += expected.length;
      }
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(counts.match + counts.stage + counts.points).toBe(builtinModules.reduce((n, m) => n + Object.keys(m.ruleKeys ?? {}).length, 0));
    for (const scope of ["match", "stage", "points"] as const) expect(counts[scope], scope).toBeGreaterThan(0);
    // Every Q5 name lands in some sport's schema (a mistyped engine path would drop out silently), except the ones a
    // later task adds — and those must still be missing, or their pending row is stale.
    expect(sorted([...Q5.match, ...Q5.stage, ...Q5.points].filter((n) => !hit.has(n)))).toEqual(sorted(Object.keys(Q5_PENDING)));
  });

  it("Q5 (rulebook): the match bounds and the whole deciders are exactly Q5's, restricted to each sport's schema", () => {
    let bounds = 0;
    let whole = 0;
    for (const m of builtinModules) {
      const expectedBounds = Object.fromEntries(Object.entries(Q5_MATCH_BOUNDS).flatMap(([name, bound]) => {
        const owner = q5Owner(m, name);
        return owner === null ? [] : [[owner, bound]];
      }));
      expect(Object.fromEntries(deciders(m).map(([k, f]) => [k, f.matchBound])), `${m.key}: match bounds vs Q5`).toEqual(expectedBounds);
      const expectedWhole = sorted([
        ...Q5_WHOLE_DECIDERS.map((n) => q5Owner(m, n)).filter((k): k is string => k !== null),
        ...(PLAN_ONLY_DECIDERS[m.key] ?? []),
      ]);
      const declaredWhole = Object.entries(m.ruleKeys ?? {}).filter(([, f]) => f.decider === true);
      expect(sorted(declaredWhole.map(([k]) => k)), `${m.key}: whole deciders vs Q5`).toEqual(expectedWhole);
      for (const [k, f] of declaredWhole) expect(f.scope, `${m.key}.${k}: a decider is never table points`).not.toBe("points");
      bounds += Object.keys(expectedBounds).length;
      whole += expectedWhole.length;
    }
    expect(bounds).toBe(deciderCount());
    expect(bounds).toBeGreaterThan(0);
    expect(whole).toBe(builtinModules.reduce((n, m) => n + Object.values(m.ruleKeys ?? {}).filter((f) => f.decider === true).length, 0));
    expect(whole).toBeGreaterThan(0);
  });

  it("appliesTo is carried by exactly carrom tieBoard and the two share-the-points abandon policies (DRAW_KINDS), chess tiebreakRungs (BRACKET_KINDS), and cricket superOver, its still-tied policy and dls (the variants the schema lets switch them on)", () => {
    const ck = sport("cricket");
    const ckVariants = ck.variants as Record<string, object>;
    const variantsWhere = (on: Record<string, unknown>): string[] =>
      sorted(Object.keys(ckVariants).filter((v) => ck.configSchema.safeParse({ ...ckVariants[v], ...on }).success));
    const expected: Record<string, { stageKinds?: string[]; variants?: string[] }> = {
      "carrom.tieBoard": { stageKinds: sorted(DRAW_KINDS) },
      // W2c Task 7 (CA-AB-2, GN-AB-2): sharing the points on an abandon is a table stage's choice.
      "carrom.abandonPolicy": { stageKinds: sorted(DRAW_KINDS) },
      "generic.abandonPolicy": { stageKinds: sorted(DRAW_KINDS) },
      "boardgame.tiebreakRungs": { stageKinds: sorted(BRACKET_KINDS) }, // W2c BG-KO-3: the rung list is a bracket stage's, like the tie-break it orders
      "cricket.superOver": { variants: variantsWhere({ superOver: true }) },
      // W2e Task 7: the still-tied policy is a detail of the super over, so it is offered on the same variants and no others.
      "cricket.superOverStillTied": { variants: variantsWhere({ superOver: true }) },
      "cricket.dls": { variants: variantsWhere({ dls: { enabled: true, edition: "standard" } }) },
    };
    // The variant axis is not degenerate: each cricket list leaves out a variant, and holds one.
    for (const key of ["cricket.superOver", "cricket.superOverStillTied", "cricket.dls"]) {
      expect(expected[key]!.variants!.length, key).toBeGreaterThan(0);
      expect(expected[key]!.variants!.length, key).toBeLessThan(Object.keys(ckVariants).length);
    }
    const declared: Record<string, { stageKinds?: string[]; variants?: string[] }> = {};
    for (const m of builtinModules)
      for (const [k, f] of Object.entries(m.ruleKeys ?? {}))
        if (f.appliesTo !== undefined)
          declared[`${m.key}.${k}`] = {
            ...(f.appliesTo.stageKinds ? { stageKinds: sorted(f.appliesTo.stageKinds) } : {}),
            ...(f.appliesTo.variants ? { variants: sorted(f.appliesTo.variants) } : {}),
          };
    expect(declared).toEqual(expected);
  });

  it("every key a cell offers parses switched ON over that variant's preset, and a key the schema refuses there is not offered", () => {
    let cells = 0;
    let offered = 0;
    let refused = 0;
    let narrowed = 0;
    let narrowedDetails = 0;
    const noOnValue = new Set<string>();
    for (const m of builtinModules) {
      const presets: [string | null, Record<string, unknown>][] = Object.entries(m.variants).map(([v, p]) => [v, m.configSchema.parse(p) as Record<string, unknown>]);
      const bare = m.configSchema.safeParse({});
      if (bare.success) presets.push([null, bare.data as Record<string, unknown>]); // the division level: no variant
      const donors = declaredCfgsWithStagePresets(m).map(({ cfg }) => cfg);
      const tops = new Set(Object.entries(m.ruleKeys ?? {}).filter(([, f]) => f.scope !== "points").map(([k]) => k.split(".")[0]!));
      for (const [variant, preset] of presets) {
        const parsesOn = new Map<string, boolean>();
        for (const top of tops) {
          const on = switchedOn(m, top, preset, donors);
          if (on === undefined) noOnValue.add(`${m.key}.${top}`);
          else parsesOn.set(top, m.configSchema.safeParse({ ...preset, [top]: on }).success);
        }
        for (const kind of [...KINDS, null]) {
          const offeredTops = stageTopKeysFor(m, kind, variant);
          for (const top of offeredTops) {
            if (!parsesOn.has(top)) continue; // no engine value switches it on: pinned below
            expect(parsesOn.get(top), `${m.key} ${kind}/${variant}: ${top} is offered, but refused switched on`).toBe(true);
            offered++;
          }
          for (const [top, ok] of parsesOn)
            if (!ok) {
              expect(offeredTops.has(top), `${m.key} ${kind}/${variant}: ${top} is refused switched on, yet offered`).toBe(false);
              refused++;
            }
          cells++;
        }
        // Not over-narrowed: a key a variant list leaves out is one the schema refuses there. A DETAIL's own value is a plain
        // choice the schema takes anywhere (cricket's `superOverStillTied: "repeat"` parses on a test match), so what it is left out
        // for is that its DECIDER is refused there (W2e Task 7): the oracle for a detail is the decider's.
        for (const [k, f] of Object.entries(m.ruleKeys ?? {}))
          if (variant !== null && f.appliesTo?.variants !== undefined && !f.appliesTo.variants.includes(variant)) {
            const oracle = (f.detailOf ?? k).split(".")[0]!;
            expect(parsesOn.get(oracle), `${m.key}/${variant}: ${k} left out, yet the schema accepts ${oracle}`).toBe(false);
            narrowed++;
            if (f.detailOf !== undefined) narrowedDetails++;
          }
      }
    }
    expect(cells).toBeGreaterThan(0);
    expect(offered).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0); // the variant axis refuses something (cricket's test match: no super over, no DLS)
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowedDetails, "a detail left out of a variant was checked against its decider").toBeGreaterThan(0);
    // Optional keys no declared cfg (and no bracket decider) gives a value: the engine names no ON state for them, and
    // any value here would be the test's own invention. Pinned, so the skip stays visible and a new one goes red.
    expect(sorted(noOnValue)).toEqual(sorted([
      "football.maxSubs", "football.subWindows", "football.sinBinMinutes", "football.concussionSubs",
      "boardgame.clock", "boardgame.tiebreakRungs", "volleyball.cap", // tiebreakRungs: absent = every rung; no declared cfg lists any
      // W2c Task 7: a policy, not an on/off switch - `share` is one of two values, and no declared cfg sets either.
      "carrom.abandonPolicy", "generic.abandonPolicy",
    ]));
  });

  it("appliesTo names only real stage kinds and real variants", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const [key, fact] of Object.entries(m.ruleKeys ?? {})) {
        for (const k of fact.appliesTo?.stageKinds ?? []) { expect(KINDS, `${m.key}.${key}`).toContain(k); checked++; }
        for (const v of fact.appliesTo?.variants ?? []) { expect(Object.keys(m.variants), `${m.key}.${key}`).toContain(v); checked++; }
      }
    expect(checked).toBeGreaterThan(0); // carrom tieBoard and chess tiebreak at least
  });

  it("match ⊂ stage in every sport × kind × variant (fixtureKeys ⊂ stageKeys), and points keys are in neither", () => {
    let cells = 0;
    for (const m of builtinModules)
      for (const kind of [null, ...KINDS])
        for (const variant of [null, ...Object.keys(m.variants)]) {
          const stage = new Set(stageKeysFor(m, kind, variant));
          for (const k of fixtureKeysFor(m, kind, variant)) expect(stage.has(k), `${m.key}/${kind}/${variant}: ${k}`).toBe(true);
          for (const k of pointsKeysFor(m, kind, variant)) expect(stage.has(k), `${m.key}: points key ${k} leaked into stage`).toBe(false);
          cells++;
        }
    expect(cells).toBe(builtinModules.reduce((n, m) => n + (KINDS.length + 1) * (Object.keys(m.variants).length + 1), 0));
    expect(cells).toBeGreaterThan(0);
  });

  it("every applying key lands in exactly its declared scope's helper, in every sport × kind × variant", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const kind of [null, ...KINDS])
        for (const variant of [null, ...Object.keys(m.variants)]) {
          const stage = new Set(stageKeysFor(m, kind, variant));
          const fixture = new Set(fixtureKeysFor(m, kind, variant));
          const points = new Set(pointsKeysFor(m, kind, variant));
          for (const [key, fact] of Object.entries(m.ruleKeys ?? {})) {
            const on = ruleKeyApplies(fact, kind, variant);
            const at = `${m.key}/${kind}/${variant}: ${key} (${fact.scope})`;
            expect(fixture.has(key), at).toBe(on && fact.scope === "match");
            expect(stage.has(key), at).toBe(on && fact.scope !== "points");
            expect(points.has(key), at).toBe(on && fact.scope === "points");
            checked++;
          }
          expect(stage.size + points.size, `${m.key}/${kind}/${variant}`).toBeLessThanOrEqual(Object.keys(m.ruleKeys ?? {}).length);
        }
    expect(checked).toBeGreaterThan(0);
    // Every scope is exercised somewhere, or the three expectations above could pass on two empty helpers.
    const scopes = new Set(builtinModules.flatMap((m) => Object.values(m.ruleKeys ?? {}).map((f) => f.scope)));
    expect([...scopes].sort()).toEqual(["match", "points", "stage"]);
  });

  it("a key with no appliesTo applies in every cell, and a kind-limited key follows its declared kinds", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const [key, fact] of Object.entries(m.ruleKeys ?? {}))
        for (const kind of KINDS) {
          const declared = fact.appliesTo?.stageKinds;
          const expected = declared === undefined || declared.includes(kind);
          const helper = fact.scope === "points" ? pointsKeysFor : stageKeysFor;
          expect(helper(m, kind, null).includes(key), `${m.key}.${key} @ ${kind}`).toBe(expected);
          // The division level (no stage yet) is never narrowed by kind.
          expect(helper(m, null, null).includes(key), `${m.key}.${key} @ division`).toBe(true);
          checked++;
        }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + Object.keys(m.ruleKeys ?? {}).length * KINDS.length, 0));
    expect(checked).toBeGreaterThan(0);
  });

  it("every declared cfg parses with every stageDefaults output over it, and the defaults stay inside the stage keys", () => {
    // declaredCfgs: each variant, plus the bare schema default only where the schema accepts {} (generic does not).
    let parsed = 0;
    let contained = 0;
    for (const m of builtinModules) {
      for (const { name, cfg } of declaredCfgs(m)) {
        const variant = Object.hasOwn(m.variants, name) ? name : null;
        for (const kind of KINDS) {
          const r = m.configSchema.safeParse({ ...(cfg as object), ...stageDefaultsFor(m, kind, variant) });
          expect(r.success, `${m.key}/${name}/${kind}`).toBe(true);
          parsed++;
        }
      }
      for (const variant of [null, ...Object.keys(m.variants)])
        for (const kind of KINDS) {
          const allowed = stageTopKeysFor(m, kind, variant);
          for (const k of Object.keys(stageDefaultsFor(m, kind, variant))) expect(allowed.has(k), `${m.key}/${kind}/${variant}: default ${k}`).toBe(true);
          contained++;
        }
    }
    expect(parsed).toBe(builtinModules.reduce((n, m) => n + declaredCfgs(m).length * KINDS.length, 0));
    expect(contained).toBe(builtinModules.reduce((n, m) => n + (Object.keys(m.variants).length + 1) * KINDS.length, 0));
    expect(parsed).toBeGreaterThan(0);
  });

  it("carrom tieBoard applies to table kinds only (item 9)", () => {
    // Single-sport: item 9 is a carrom rule (the tie board is offered only where a table can hold a draw).
    const carrom = sport("carrom");
    let shown = 0;
    for (const k of KINDS) {
      const has = stageKeysFor(carrom, k, null).includes("tieBoard");
      expect(has, k).toBe(DRAW_KINDS.has(k));
      if (has) shown++;
    }
    expect(shown).toBe(DRAW_KINDS.size);
    expect(BRACKET_KINDS.size + DRAW_KINDS.size).toBe(KINDS.length);
    expect(stageKeysFor(carrom, null, null)).toContain("tieBoard"); // division level: not narrowed
  });

  it("BG-KO-3: the chess rung list is the bracket-only decider, and the forced tiebreak switch is no organiser key", () => {
    // Single-sport: the tie-break games exist only where someone must advance (boardgame's bracketDeciders), and the
    // rung list (W2c BG-KO-3, spec §4.1 Q5) orders exactly those games.
    const chess = sport("boardgame");
    let shown = 0;
    for (const k of KINDS) {
      const has = stageKeysFor(chess, k, null).includes("tiebreakRungs");
      expect(has, `tiebreakRungs @ ${k}`).toBe(BRACKET_KINDS.has(k));
      if (has) shown++;
    }
    expect(shown).toBe(BRACKET_KINDS.size);
    expect(stageKeysFor(chess, null, null), "tiebreakRungs @ division").toContain("tiebreakRungs"); // not narrowed before a stage exists
    // The rung list is stage-scope only (never a per-match key) and IS the chess decider (BG-KO-1, BG-KO-3): an EMPTY
    // list is "no tie-break games" and holds a drawn game for the organiser, so the stage's list is authoritative and
    // bracketDeciders must not write it.
    expect(chess.ruleKeys!.tiebreakRungs).toEqual({ scope: "stage", decider: true, appliesTo: { stageKinds: [...BRACKET_KINDS] } });
    expect(Object.hasOwn(chess.bracketDeciders(chess.configSchema.parse({})) as object, "tiebreakRungs")).toBe(false);
    // `tiebreak` is the bracket overlay's own switch, forced on: the organiser sets no such key, in any kind or at the
    // division, and it is no decider (the list is). The schema still carries it, so the overlay can force it.
    expect(Object.hasOwn(chess.ruleKeys!, "tiebreak")).toBe(false);
    for (const k of [...KINDS, null]) expect(stageKeysFor(chess, k, null), `tiebreak @ ${k}`).not.toContain("tiebreak");
    expect(chess.bracketDeciders(chess.configSchema.parse({}))).toEqual({ tiebreak: true });
    expect(schemaHasPath(chess.configSchema, ["tiebreak"])).toBe(true);
  });

  it("ruleKeyApplies narrows by variant too; a null kind or variant is not narrowed", () => {
    // Synthetic facts: no builtin declares appliesTo.variants yet (the contract is in the spec, §4.1).
    const byVariant: RuleKeyFact = { scope: "stage", appliesTo: { variants: ["t20"] } };
    const byBoth: RuleKeyFact = { scope: "match", appliesTo: { stageKinds: ["knockout"], variants: ["t20"] } };
    expect(ruleKeyApplies(byVariant, "league", "t20")).toBe(true);
    expect(ruleKeyApplies(byVariant, "league", "odi")).toBe(false);
    expect(ruleKeyApplies(byVariant, "league", null)).toBe(true);
    expect(ruleKeyApplies(byBoth, "knockout", "t20")).toBe(true);
    expect(ruleKeyApplies(byBoth, "league", "t20")).toBe(false);
    expect(ruleKeyApplies(byBoth, "knockout", "odi")).toBe(false);
    expect(ruleKeyApplies(byBoth, null, null)).toBe(true);
    expect(ruleKeyApplies({ scope: "points" }, "ladder", "odi")).toBe(true);
    const m = fake({ overs: byVariant });
    expect(stageKeysFor(m, "league", "t20")).toEqual(["overs"]);
    expect(stageKeysFor(m, "league", "odi")).toEqual([]);
  });

  it("ruleKeyOwning picks the most specific key", () => {
    // Single-sport: icehockey is the one module declaring both a parent (overtime) and its leaf (overtime.minutes).
    const ice = sport("icehockey");
    expect(ruleKeyOwning(ice, ["overtime", "minutes"])?.key).toBe("overtime.minutes");
    expect(ruleKeyOwning(ice, ["overtime", "minutes"])?.fact.scope).toBe("match");
    expect(ruleKeyOwning(ice, ["overtime", "skaters"])?.key).toBe("overtime");
    expect(ruleKeyOwning(ice, ["overtime", "skaters"])?.fact.scope).toBe("stage");
    expect(ruleKeyOwning(ice, ["periods", "count"])).toBeNull(); // only periods.minutes is declared
    expect(ruleKeyOwning(ice, ["nope"])).toBeNull();
    expect(ruleKeyOwning(ice, ["toString"])).toBeNull(); // an inherited property is never a rule key
    expect(ruleKeyOwning(ice, [])).toBeNull();
  });

  it("sportTopKeys and stageTopKeysFor hold first segments only, each a real top-level schema key", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const tops = new Set(schemaTopKeys(m.configSchema));
      const all = sportTopKeys(m);
      for (const key of Object.keys(m.ruleKeys ?? {})) expect(all.has(key.split(".")[0]!), `${m.key}: ${key}`).toBe(true);
      for (const t of all) { expect(tops.has(t), `${m.key}: ${t}`).toBe(true); checked++; }
      for (const kind of [null, ...KINDS])
        for (const t of stageTopKeysFor(m, kind, null)) { expect(all.has(t), `${m.key}/${kind}: ${t}`).toBe(true); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
    // icehockey declares periods only through its leaf, and points only at table scope.
    const ice = sport("icehockey");
    expect(stageTopKeysFor(ice, "knockout", null).has("periods")).toBe(true);
    expect(stageTopKeysFor(ice, "knockout", null).has("points")).toBe(false);
    expect(sportTopKeys(ice).has("points")).toBe(true);
  });
});

describe("X-SR-2 checkFixtureOverride", () => {
  const ice = sport("icehockey");
  const fb = sport("football");
  const tennis = sport("tennis");
  const chess = sport("boardgame");
  const stage = { periods: { count: 3, minutes: 20 }, overtime: { kind: "sudden_death", minutes: 10, skaters: 3 }, shootout: { attempts: 5, suddenDeath: true } };

  it("empty override: ok, nothing changed", () => {
    expect(checkFixtureOverride(ice, "knockout", null, stage, {})).toEqual({ ok: true, changed: [] });
  });
  it("a match leaf inside a stage object is accepted (overtime.minutes)", () => {
    // Single-sport: icehockey's overtime is the object mixing a match leaf with stage leaves.
    expect(checkFixtureOverride(ice, "knockout", null, stage, { overtime: { ...stage.overtime, minutes: 5 } })).toEqual({ ok: true, changed: ["overtime.minutes"] });
  });
  it("a second check, against a stage that already carries the override, changes nothing", () => {
    const once = { overtime: { ...stage.overtime, minutes: 5 } };
    expect(checkFixtureOverride(ice, "knockout", null, { ...stage, ...once }, once)).toEqual({ ok: true, changed: [] });
  });
  it("a stage leaf in the same object is refused RULE_NOT_SETTABLE (overtime.skaters)", () => {
    expect(checkFixtureOverride(ice, "knockout", null, stage, { overtime: { ...stage.overtime, skaters: 4 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "overtime.skaters", reason: expect.stringMatching(/per stage/) });
  });
  it("a declared leaf beside an undeclared sibling: periods.minutes accepted, periods.count refused", () => {
    expect(checkFixtureOverride(ice, "league", null, stage, { periods: { count: 3, minutes: 15 } })).toEqual({ ok: true, changed: ["periods.minutes"] });
    expect(checkFixtureOverride(ice, "league", null, stage, { periods: { count: 2, minutes: 20 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "periods.count" });
  });
  it("a match cannot switch on a decider its stage has off", () => {
    expect(checkFixtureOverride(ice, "knockout", null, { ...stage, overtime: null }, { overtime: { kind: "sudden_death", minutes: 5, skaters: 3 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "overtime" });
  });
  it("a key the sport never declares is UNKNOWN_RULE_KEY", () => {
    expect(checkFixtureOverride(ice, "knockout", null, stage, { bogus: 1 })).toMatchObject({ ok: false, code: "UNKNOWN_RULE_KEY", path: "bogus", reason: expect.stringMatching(/bogus.*icehockey/) });
  });
  it("table points are not a match key (declared, at points scope)", () => {
    expect(checkFixtureOverride(ice, "league", null, { points: { win: 3, draw: 1, loss: 0 } }, { points: { win: 2, draw: 1, loss: 0 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "points.win" });
  });
  it("another sport: tennis noAd accepted; a chess clock refused (stage only, item 14)", () => {
    expect(checkFixtureOverride(tennis, "league", null, { game: { noAd: false } }, { game: { noAd: true } })).toEqual({ ok: true, changed: ["game.noAd"] });
    expect(checkFixtureOverride(chess, "knockout", null, { clock: { base: 600 } }, { clock: { base: 300 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "clock.base" });
  });
  it("a value that changes shape is one leaf (tennis finalSet: \"same\" → a tie-break to 10)", () => {
    expect(checkFixtureOverride(tennis, "knockout", null, { finalSet: "same" }, { finalSet: { tiebreakTo: 10 } })).toEqual({ ok: true, changed: ["finalSet"] });
  });
  it("X-SR-2 football extra time per match: off or shorter only", () => {
    // Single-sport: extraTime is the one key declared matchBound "off_or_shorter" (RB2B-3).
    const st = { extraTime: { enabled: true, halfMinutes: 15 } };
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: false, halfMinutes: 15 } })).toMatchObject({ ok: true });
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: false, halfMinutes: 20 } })).toMatchObject({ ok: true }); // off: the length is moot
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: true, halfMinutes: 10 } })).toEqual({ ok: true, changed: ["extraTime.halfMinutes"] });
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: true, halfMinutes: 15 } })).toEqual({ ok: true, changed: [] }); // nothing differs
    // The bound reads the length alone: the stage's own length restated beside another sub-key is not longer (the
    // writer's schema parse judges the extra sub-key, not this check).
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: true, halfMinutes: 15, note: "x" } })).toEqual({ ok: true, changed: ["extraTime.note"] });
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: true, halfMinutes: 20 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "extraTime", reason: expect.stringMatching(/shorter/) });
    expect(checkFixtureOverride(fb, "knockout", null, { extraTime: { enabled: false, halfMinutes: 15 } }, { extraTime: { enabled: true, halfMinutes: 15 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", reason: expect.stringMatching(/off/) });
    expect(checkFixtureOverride(fb, "knockout", null, {}, { extraTime: { enabled: true, halfMinutes: 10 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "extraTime" }); // the stage names none
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: null })).toMatchObject({ ok: true }); // switches nothing on; the schema judges the shape
  });
  it("fix round 1 (ruling) a legacy stage with the shoot-out on and NO shootoutAttempts key: an absent key reads as the engine's default (5), never as off", () => {
    const legacy = { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true };
    expect(legacy).not.toHaveProperty("shootoutAttempts");
    expect(fb.configSchema.safeParse(legacy).success, "rig: the legacy stage is a valid football cfg").toBe(true);
    const asked = (n: number) => checkFixtureOverride(fb, "knockout", null, legacy, { shootoutAttempts: n });
    // The probe: a match asks for 3 kicks each.
    expect(asked(3)).toEqual({ ok: true, changed: ["shootoutAttempts"] });
    // Shorter-or-equal to the default only: the default is the bound.
    expect(asked(SHOOTOUT_ATTEMPTS_DEFAULT)).toEqual({ ok: true, changed: ["shootoutAttempts"] });
    expect(asked(SHOOTOUT_ATTEMPTS_DEFAULT + 1)).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "shootoutAttempts", reason: expect.stringMatching(/shorter/) });
    // A stage that DOES carry the key is bound by its own value, not by the default (the right answer differs from the constant).
    const youth = { ...legacy, shootoutAttempts: 3 };
    expect(checkFixtureOverride(fb, "knockout", null, youth, { shootoutAttempts: 2 })).toEqual({ ok: true, changed: ["shootoutAttempts"] });
    expect(checkFixtureOverride(fb, "knockout", null, youth, { shootoutAttempts: 4 })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", reason: expect.stringMatching(/shorter/) });
    // Every OTHER bounded key still reads an absent stage value as off (no whenAbsent declared): ice hockey's overtime.
    expect(checkFixtureOverride(sport("icehockey"), "knockout", null, { periods: { count: 3, minutes: 20 } }, { overtime: { kind: "sudden_death", minutes: 5, skaters: 3 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "overtime" });
  });
  it("a match key outside its declared kinds is refused; a format key the stage does not carry may be set", () => {
    // Synthetic module: no builtin declares a kind-limited match key.
    const m = fake({ legs: { scope: "match", appliesTo: { stageKinds: ["knockout"] } }, overs: { scope: "match" } });
    expect(checkFixtureOverride(m, "knockout", null, { legs: 2 }, { legs: 1 })).toEqual({ ok: true, changed: ["legs"] });
    expect(checkFixtureOverride(m, "league", null, { legs: 2 }, { legs: 1 })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "legs" });
    expect(checkFixtureOverride(m, "league", null, {}, { overs: 10 })).toEqual({ ok: true, changed: ["overs"] });
    expect(checkFixtureOverride(m, "league", null, { overs: 20 }, { overs: 10 })).toEqual({ ok: true, changed: ["overs"] });
  });

  it("X-SR-2 a format key may differ where the stage has none; a decider the stage has off may not be switched on", () => {
    // Cricket's bowler limit is the one optional, default-less match key; football's extra time the one decider whose
    // off state a resolved stage carries. The super over is a whole decider: stage-only (Q5), so a match never touches it.
    const ck = sport("cricket");
    const { maxOversPerBowler: _none, ...stage } = declaredCfgs(ck)[0]!.cfg as Record<string, unknown>;
    expect(stage).not.toHaveProperty("maxOversPerBowler");
    expect(ck.configSchema.safeParse(stage).success).toBe(true);
    expect(checkFixtureOverride(ck, "league", null, stage, { maxOversPerBowler: 4 })).toEqual({ ok: true, changed: ["maxOversPerBowler"] });
    expect(ck.configSchema.safeParse({ ...stage, maxOversPerBowler: 4 }).success).toBe(true);
    for (const superOver of [true, false])
      expect(checkFixtureOverride(ck, "knockout", null, { ...stage, superOver: !superOver }, { superOver })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "superOver", reason: expect.stringMatching(/per stage/) });
    const fbStage = declaredCfgs(fb)[0]!.cfg as Record<string, unknown>;
    expect(at(fbStage, "extraTime.enabled")).toBe(false);
    expect(checkFixtureOverride(fb, "knockout", null, fbStage, overrideAt(fbStage, "extraTime.enabled", true))).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "extraTime", reason: expect.stringMatching(/off for this stage/) });
  });

  it("X-SR-2 every declared decider, every sport: a longer value is refused, shorter or off accepted, equal allowed", () => {
    // Empty case first: a module declaring no decider, or only format keys, has nothing to bound.
    expect(deciders(fake({}))).toEqual([]);
    expect(deciders(fake({ overs: { scope: "match" }, dls: { scope: "stage" } }))).toEqual([]);
    let checked = 0;
    let without = 0;
    const bounds = new Set<string>();
    for (const m of builtinModules) {
      if (deciders(m).length === 0) without++;
      for (const [key, fact] of deciders(m)) {
        const kind = KINDS.find((k) => ruleKeyApplies(fact, k, null));
        expect(kind, `${m.key}.${key} applies to no stage kind`).toBeDefined();
        const check = (st: Record<string, unknown>, ov: Record<string, unknown>) => checkFixtureOverride(m, kind!, null, st, ov);
        const parses = (st: Record<string, unknown>, ov: Record<string, unknown>) =>
          expect(m.configSchema.safeParse({ ...st, ...ov }).success, `${m.key}.${key} parses`).toBe(true);
        const refused = (reason: RegExp) => ({ ok: false, code: "RULE_NOT_SETTABLE", path: key, reason: expect.stringMatching(reason) });
        const cfgs = declaredCfgsWithStagePresets(m).map(({ cfg }) => cfg);
        if (fact.matchBound === "shorter") {
          const on = cfgs.find((c) => typeof at(c, key) === "number" && (at(c, key) as number) > 1);
          expect(on, `${m.key}: no declared cfg carries a length above 1 for ${key}`).toBeDefined();
          const n = at(on!, key) as number;
          expect(check(on!, overrideAt(on!, key, n))).toEqual({ ok: true, changed: [] });
          expect(check(on!, overrideAt(on!, key, n + 1))).toMatchObject(refused(/shorter/));
          expect(check(on!, overrideAt(on!, key, n - 1))).toEqual({ ok: true, changed: [key] });
          parses(on!, overrideAt(on!, key, n - 1));
        } else {
          const h = at(cfgs[0]!, `${key}.halfMinutes`) as number;
          expect(h, `${m.key}.${key}.halfMinutes`).toBeGreaterThan(1);
          const on = { ...cfgs[0]!, ...overrideAt(cfgs[0]!, `${key}.enabled`, true) };
          const off = { ...cfgs[0]!, ...overrideAt(cfgs[0]!, `${key}.enabled`, false) };
          parses(on, {});
          expect(check(on, overrideAt(on, key, at(on, key)))).toEqual({ ok: true, changed: [] });
          expect(check(on, overrideAt(on, `${key}.halfMinutes`, h + 1))).toMatchObject(refused(/shorter/));
          expect(check(off, overrideAt(off, `${key}.enabled`, true))).toMatchObject(refused(/off for this stage/));
          expect(check(on, overrideAt(on, `${key}.halfMinutes`, h - 1))).toEqual({ ok: true, changed: [`${key}.halfMinutes`] });
          expect(check(on, overrideAt(on, `${key}.enabled`, false))).toEqual({ ok: true, changed: [`${key}.enabled`] });
          parses(on, overrideAt(on, `${key}.halfMinutes`, h - 1));
        }
        bounds.add(fact.matchBound!);
        checked++;
      }
    }
    expect(checked).toBe(deciderCount());
    expect(checked).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0);
    expect([...bounds].sort()).toEqual(["off_or_shorter", "shorter"]); // every bound kind is exercised
  });

  it("a decider's bound reads the stage: a length the stage lacks is off; a non-number is never shorter (both bounds)", () => {
    // Synthetic module: no builtin's resolved stage lacks its length leaf, or holds a non-number length.
    const m = fake({
      so: { scope: "stage" }, "so.attempts": { scope: "match", matchBound: "shorter" },
      et: { scope: "match", matchBound: "off_or_shorter" },
    });
    const off = { ok: false, code: "RULE_NOT_SETTABLE", reason: expect.stringMatching(/off for this stage/) };
    const longer = { ok: false, code: "RULE_NOT_SETTABLE", reason: expect.stringMatching(/shorter/) };
    let checked = 0;
    // shorter: the stage's length must be a finite number, and so must the override's.
    for (const s of [undefined, null, "5", false, Infinity]) {
      expect(checkFixtureOverride(m, "knockout", null, { so: { sd: true, attempts: s } }, { so: { sd: true, attempts: 3 } }), `stage ${String(s)}`).toMatchObject({ ...off, path: "so.attempts" });
      checked++;
    }
    for (const o of ["3", null, false, -Infinity, NaN, { n: 3 }]) {
      expect(checkFixtureOverride(m, "knockout", null, { so: { attempts: 5 } }, { so: { attempts: o } }), `override ${JSON.stringify(o)}`).toMatchObject({ ...longer, path: "so.attempts" });
      checked++;
    }
    // off_or_shorter: the same, on the half length of a switched-on decider.
    for (const s of [undefined, null, "20", false, Infinity]) {
      expect(checkFixtureOverride(m, "knockout", null, { et: { enabled: true, halfMinutes: s } }, { et: { enabled: true, halfMinutes: 10 } }), `stage ${String(s)}`).toMatchObject({ ...off, path: "et" });
      checked++;
    }
    for (const o of ["10", null, false, "", -Infinity, NaN]) {
      expect(checkFixtureOverride(m, "knockout", null, { et: { enabled: true, halfMinutes: 15 } }, { et: { enabled: true, halfMinutes: o } }), `override ${String(o)}`).toMatchObject({ ...longer, path: "et" });
      checked++;
    }
    expect(checked).toBe(22);
    // The positive pair: finite and not longer is accepted on both bounds.
    expect(checkFixtureOverride(m, "knockout", null, { so: { attempts: 5 } }, { so: { attempts: 3 } })).toEqual({ ok: true, changed: ["so.attempts"] });
    expect(checkFixtureOverride(m, "knockout", null, { et: { enabled: true, halfMinutes: 15 } }, { et: { enabled: true, halfMinutes: 10 } })).toEqual({ ok: true, changed: ["et.halfMinutes"] });
  });

  it("a list leaf is compared by value: a copied pointsMap changes nothing; a different one is a points key, refused", () => {
    // Set-kernel family: its pointsMap is the one cfg value holding lists (PointsPair tuples).
    const vb = sport("volleyball");
    const cfg = declaredCfgs(vb)[0]!.cfg as Record<string, unknown>;
    const pm = cfg.pointsMap as Record<string, unknown>;
    const first = Object.keys(pm)[0]!;
    expect(Array.isArray(pm[first])).toBe(true);
    expect(checkFixtureOverride(vb, "league", null, cfg, { pointsMap: structuredClone(pm) })).toEqual({ ok: true, changed: [] });
    expect(checkFixtureOverride(vb, "league", null, cfg, { pointsMap: { ...pm, [first]: [9, 9] } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: `pointsMap.${first}` });
  });
});

describe("G3 deciderKeysFor — the whole deciders a stage carries", () => {
  it("empty case first: a module declaring none, or a sport without deciders, carries none in any cell", () => {
    expect(deciderKeysFor(fake({}), "knockout", null)).toEqual([]);
    expect(deciderKeysFor(fake({ overs: { scope: "match" } }), "knockout", null)).toEqual([]);
    for (const kind of [...KINDS, null]) expect(deciderKeysFor(sport("generic"), kind, null), String(kind)).toEqual([]);
  });
  it("the engine's own deciders: football ET and penalties; chess tie-breaks in a bracket only; a test match has no super over", () => {
    expect(sorted(deciderKeysFor(sport("football"), "knockout", null))).toEqual(["extraTime", "shootout"]);
    // BG-KO-3: the rung list IS the chess decider (an empty list is "off"); the forced `tiebreak` switch is not one.
    expect(deciderKeysFor(sport("boardgame"), "knockout", null)).toEqual(["tiebreakRungs"]);
    expect(deciderKeysFor(sport("boardgame"), "league", null)).toEqual([]);
    expect(deciderKeysFor(sport("cricket"), "knockout", "t20")).toEqual(["superOver"]);
    expect(deciderKeysFor(sport("cricket"), "knockout", "test")).toEqual([]);
  });
  it("in every sport × kind × variant cell: exactly the decider facts that apply there, each a key the stage may set", () => {
    let cells = 0;
    let found = 0;
    for (const m of builtinModules)
      for (const kind of [...KINDS, null])
        for (const variant of [...Object.keys(m.variants), null]) {
          const got = deciderKeysFor(m, kind, variant);
          const want = Object.entries(m.ruleKeys ?? {}).filter(([, f]) => f.decider === true && ruleKeyApplies(f, kind, variant)).map(([k]) => k);
          expect(sorted(got), `${m.key} ${kind}/${variant}`).toEqual(sorted(want));
          for (const k of got) expect(stageKeysFor(m, kind, variant), `${m.key}.${k}`).toContain(k);
          found += got.length;
          cells++;
        }
    expect(cells).toBeGreaterThan(0);
    expect(found).toBeGreaterThan(0);
  });
});
