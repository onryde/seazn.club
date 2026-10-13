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
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { schemaHasPath, schemaTopKeys } from "../testkit/schema-paths.ts";
import {
  checkFixtureOverride, fixtureKeysFor, pointsKeysFor, ruleKeyApplies, ruleKeyOwning, sportTopKeys,
  stageDefaultsFor, stageKeysFor, stageTopKeysFor,
  type AnySportModule, type RuleKeyFact, type RuleKeys,
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

/** Top-level cfg keys an organiser never sets, per sport, each with its reason.
 *  Reviewed line by line; a new schema key fails the sweep until it is either
 *  declared in ruleKeys or listed here, and a row whose key becomes declared
 *  fails until it is deleted. */
const VARIANT = "a variant fact: set by the variant preset, never edited per stage or match (not in spec §4.1 Q5's settable list)";
const BOOKKEEPING = "scorer bookkeeping or pad vocabulary, not a format rule";
const ABANDON_T7 = "D9: settable from W2c Task 7, which declares it (stage) with abandonOptions and its web field; no form sets it before then";
const PERIOD_UNSET = {
  setPieceKinds: BOOKKEEPING, goalkeeper: BOOKKEEPING, periodSeconds: VARIANT, suspensions: VARIANT,
  strength: VARIANT, goalKinds: BOOKKEEPING, assists: BOOKKEEPING, abandonPolicy: ABANDON_T7,
} as const;
const SET_UNSET = { records: "stat-recording flags, not a format rule" } as const;
const UNSETTABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  volleyball: SET_UNSET, badminton: SET_UNSET, tabletennis: SET_UNSET,
  tennis: { interruptions: BOOKKEEPING },
  football: {
    periodSeconds: VARIANT,
    halves: "picks the phase machine (2 halves or 4 quarters); a variant fact",
    fairPlay: "card tracking for the FIFA fair-play tie-break; the tie-break cascade is W2d's",
    abandonPolicy: ABANDON_T7,
  },
  cricket: {
    inningsPerSide: VARIANT, ballsPerOver: VARIANT, followOn: VARIANT,
    reviews: BOOKKEEPING, lineupChanges: "team-sheet policy, owned by the lineups programme (W4)",
  },
  icehockey: PERIOD_UNSET,
  hockey: { ...PERIOD_UNSET, overtime: "hockey has no overtime (FIH); the kernel key exists, hockey narrows it out" },
  boardgame: { colors: "home = White (chess.md §2); the in-page chess contract owns colours (do not touch colorOfHome)" },
  carrom: {},
  generic: { progressScore: "a pad display switch, not a result rule" },
};

/** THE RULEBOOK for which keys a match may set: spec §4.1 Q5, owner-approved
 *  (docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md:160-166). Q5 names keys in rule vocabulary; the
 *  plan's Task 4 declaration table ("by ENGINE key", plans/2026-10-13-format-matrix-w2c.md) maps each to its engine
 *  path. Stage-only and points keys are everything else, so pinning the match list pins them too. */
const Q5_MATCH = [
  "bestOf", "setTo", "finalSetTo", "finalSet", "setType", "gameTo", "cap", "winBy", "tiebreakWinBy", "noAd",
  "halfMinutes", "quarterMinutes", "periodMinutes", "overtimeMinutes", "shootoutAttempts", "overs",
  "maxOversPerBowler", "maxBoards", "extraTime",
] as const;
/** Q5's deciders a match may only shorten or switch off: extraTime "per match only off or shorter" (RB2B-3); the
 *  overtime and shoot-out LENGTHS shorter only (X-SR-2, signed; coordinator correction 2026-10-13). */
const Q5_DECIDERS: Readonly<Record<string, RuleKeyFact["matchBound"]>> = {
  extraTime: "off_or_shorter", overtimeMinutes: "shorter", shootoutAttempts: "shorter",
};
/** Q5 name → engine path where they differ (plan Task 4 table); a sport row wins over the shared one. */
const Q5_ENGINE_PATH: Readonly<Record<string, string>> = {
  setType: "set", noAd: "game.noAd", tiebreakWinBy: "tiebreak.winBy", periodMinutes: "periods.minutes",
  quarterMinutes: "periods.minutes", overtimeMinutes: "overtime.minutes", shootoutAttempts: "shootout.attempts",
  overs: "ballsPerInnings",
};
const Q5_ENGINE_PATH_BY_SPORT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  football: { shootoutAttempts: "shootoutAttempts" }, // W2c Task 6 adds it to the schema, top-level
};

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
        const held = declaredCfgs(m).map(({ cfg }) => at(cfg, key)).filter((v) => v !== undefined);
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

  it("Q5 (rulebook): each sport's match keys and deciders are exactly spec §4.1 Q5's, restricted to its schema", () => {
    let sports = 0;
    let matchKeys = 0;
    let deciderKeys = 0;
    const hit = new Set<string>();
    for (const m of builtinModules) {
      const unsettable = UNSETTABLE[m.key] ?? {};
      const pathOf = (name: string): string => Q5_ENGINE_PATH_BY_SPORT[m.key]?.[name] ?? Q5_ENGINE_PATH[name] ?? name;
      const inSchema = (name: string): boolean =>
        schemaHasPath(m.configSchema, pathOf(name).split(".")) && !Object.hasOwn(unsettable, pathOf(name).split(".")[0]!);
      const expectedMatch = new Set(Q5_MATCH.filter(inSchema).map(pathOf));
      for (const name of Q5_MATCH.filter(inSchema)) hit.add(name);
      const declaredMatch = new Set(Object.entries(m.ruleKeys ?? {}).filter(([, f]) => f.scope === "match").map(([k]) => k));
      expect([...declaredMatch].sort(), `${m.key}: match keys vs Q5`).toEqual([...expectedMatch].sort());
      const expectedDeciders = Object.fromEntries(
        Object.entries(Q5_DECIDERS).filter(([name]) => inSchema(name)).map(([name, bound]) => [pathOf(name), bound]));
      const declaredDeciders = Object.fromEntries(deciders(m).map(([k, f]) => [k, f.matchBound]));
      expect(declaredDeciders, `${m.key}: deciders vs Q5`).toEqual(expectedDeciders);
      matchKeys += expectedMatch.size;
      deciderKeys += Object.keys(expectedDeciders).length;
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(matchKeys).toBeGreaterThan(0);
    expect(deciderKeys).toBe(deciderCount());
    expect(deciderKeys).toBeGreaterThan(0);
    // Every Q5 match name lands in some sport's schema: a mistyped engine path would otherwise drop out silently.
    expect(Q5_MATCH.filter((n) => !hit.has(n))).toEqual([]);
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

  it("chess tiebreak applies to bracket kinds only", () => {
    // Single-sport: the tie-break games exist only where someone must advance (boardgame's bracketDeciders).
    const chess = sport("boardgame");
    let shown = 0;
    for (const k of KINDS) {
      const has = stageKeysFor(chess, k, null).includes("tiebreak");
      expect(has, k).toBe(BRACKET_KINDS.has(k));
      if (has) shown++;
    }
    expect(shown).toBe(BRACKET_KINDS.size);
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
        const cfgs = declaredCfgs(m).map(({ cfg }) => cfg as Record<string, unknown>);
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

  it("a decider's bound reads the stage: a length the stage lacks is off; a non-number is never shorter", () => {
    // Synthetic module: no builtin's resolved stage lacks its length leaf.
    const m = fake({ so: { scope: "stage" }, "so.attempts": { scope: "match", matchBound: "shorter" } });
    expect(checkFixtureOverride(m, "knockout", null, { so: { sd: true } }, { so: { sd: true, attempts: 3 } })).toMatchObject({ ok: false, path: "so.attempts", reason: expect.stringMatching(/off for this stage/) });
    expect(checkFixtureOverride(m, "knockout", null, { so: { attempts: 5 } }, { so: { attempts: "3" } })).toMatchObject({ ok: false, path: "so.attempts", reason: expect.stringMatching(/shorter/) });
  });
});
