// Live crash, stg 2026-11-03 (fixture 2f4a670d, "scoring event fold crashed"): `TypeError: Cannot read properties of
// undefined (reading 'expedite')` on every `badminton.rally`. Engine 041d70653f (S6/#416, 2026-08-11) moved `records`
// into `SetBasedCfg` behind a zod `.default(...)`, and the set-based kernel reads `state.cfg.records.expedite`. The
// engine never parses the cfg it folds (`init` stores it raw), so the default reached only a caller that parsed first,
// and a division stored before the key existed crashed every rally — the live branch and a frozen snapshot alike.
//
// The fix is `withSchemaDefaults`, applied once by `resolveFixtureCfg` (its "fold" form): the sport's schema defaults
// fill what the stored cfg lacks, and nothing stored is changed or dropped. Pure: the DB proof through the real write
// path, the pad's payload and the freeze is `legacy-cfg-defaults.test.ts`. Expected values come from the engine's own
// `configSchema.parse` and `variants` (via `declaredCfgs`), never from the helper under test.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EngineError, foldMatchWithStoppage, summaryOf, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { resolveFixtureCfg, withSchemaDefaults } from "../fixture-cfg";

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no builtin module ${key}`);
  return m;
};
type Cfg = Record<string, unknown>;
const isObj = (v: unknown): v is Cfg => v !== null && typeof v === "object" && !Array.isArray(v);
const without = (o: Cfg, k: string): Cfg => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The stored division config the stg log names: a badminton division written before `records` existed. Input data
 *  copied off the row, not an expected value. */
const STG_CFG: Cfg = { cap: 30, setTo: 21, winBy: 2, bestOf: 3, pointsMap: { "*": [2, 0] }, finalSetTo: 21 };

const LINEUPS: LineupPair = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };
const env = (seq: number, type: string, payload: unknown): EventEnvelope => ({
  id: `e${seq}`,
  fixtureId: "f",
  seq,
  type,
  payload,
  recordedAt: "2026-11-03T00:00:00.000Z",
  recordedBy: null,
});
/** core.start, then one rally won by the home side: one point, by the badminton/table tennis/volleyball rulebooks. */
const oneRally = (key: string) => [env(1, "core.start", {}), env(2, `${key}.rally`, { wonBy: "H" })];
const pointsOf = (m: AnySportModule, cfg: unknown, events: EventEnvelope[]) =>
  (summaryOf(m, foldMatchWithStoppage(m, cfg, LINEUPS, events)).detail as { points?: unknown }).points;

describe("withSchemaDefaults — the sport's schema defaults filled into the cfg a fixture folds under", () => {
  it("empty case first: a cfg that is not an object comes back as it is, for every sport", () => {
    const shapes: unknown[] = [null, undefined, 0, 7, "", "bwf", true, [], [STG_CFG]];
    let checked = 0;
    const visited = forEachSport(({ module }) => {
      for (const s of shapes) {
        expect(withSchemaDefaults(module, s), `${module.key} ${JSON.stringify(s)}`).toBe(s);
        checked++;
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(checked, `checked ${checked}`).toBe(builtinModules.length * shapes.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the stg row: badminton stored without records crashes a rally raw and scores it 1-0 once filled; every stored key kept", () => {
    const badminton = mod("badminton");
    const stored = deepFreeze(structuredClone(STG_CFG)); // frozen: a fill that wrote into it would throw here
    // The premise, from the engine itself: this is the stg TypeError, and it is not a refusal (no EngineError).
    expect(() => foldMatchWithStoppage(badminton, stored, LINEUPS, oneRally("badminton"))).toThrow(TypeError);
    expect(() => foldMatchWithStoppage(badminton, stored, LINEUPS, oneRally("badminton"))).toThrow(/expedite/);

    const filled = withSchemaDefaults(badminton, stored) as Cfg;
    expect(filled.records, "the engine's own default").toEqual(badminton.configSchema.parse({}).records);
    for (const [k, v] of Object.entries(STG_CFG)) expect(filled[k], k).toEqual(v);
    expect(filled.pointsMap, "an object the schema already had is the stored object itself").toBe(stored.pointsMap);
    expect(Object.keys(filled).sort()).toEqual([...Object.keys(STG_CFG), "records"].sort());
    expect(stored, "the stored cfg is untouched").toEqual(STG_CFG);
    expect(pointsOf(badminton, filled, oneRally("badminton"))).toEqual({ home: 1, away: 0 });
  });

  it("every sport that declares records: stripped of them, one rally crashes raw, and filled it scores 1-0 and padSpec answers", () => {
    let checked = 0;
    const seen: string[] = [];
    forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs<Cfg>(module)) {
        if (!Object.hasOwn(cfg, "records")) continue;
        const legacy = without(cfg, "records");
        expect(() => foldMatchWithStoppage(module, legacy, LINEUPS, oneRally(module.key)), `${module.key}/${name}`).toThrow(TypeError);
        expect(() => module.padSpec?.(legacy as never), `${module.key}/${name} padSpec`).toThrow(TypeError);
        const filled = withSchemaDefaults(module, legacy) as Cfg;
        expect(filled.records, `${module.key}/${name}`).toEqual(module.configSchema.parse(legacy).records);
        expect(pointsOf(module, filled, oneRally(module.key)), `${module.key}/${name}`).toEqual({ home: 1, away: 0 });
        expect(() => module.padSpec?.(filled as never), `${module.key}/${name} padSpec`).not.toThrow();
        checked++;
        if (!seen.includes(module.key)) seen.push(module.key);
      }
    });
    expect(checked, `checked ${checked} declared cfgs`).toBeGreaterThan(0);
    expect(seen, "the stg sport is among them").toContain("badminton");
  });

  it("registry sweep: every defaulted top-level key a declared cfg can lose comes back with the engine's own value, every other key as stored", () => {
    let checked = 0;
    const keys = new Set<string>();
    forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs<Cfg>(module)) {
        for (const k of Object.keys(cfg)) {
          const stripped = without(cfg, k);
          const parsed = module.configSchema.safeParse(stripped);
          if (!parsed.success || !Object.hasOwn(parsed.data as Cfg, k)) continue; // not a defaulted key
          const filled = withSchemaDefaults(module, stripped) as Cfg;
          expect(filled[k], `${module.key}/${name} ${k}`).toEqual((parsed.data as Cfg)[k]);
          for (const other of Object.keys(stripped)) expect(filled[other], `${module.key}/${name} kept ${other}`).toBe(stripped[other]);
          checked++;
          keys.add(`${module.key}.${k}`);
        }
      }
    });
    expect(checked, `checked ${checked} (sport, cfg, key)`).toBeGreaterThan(0);
    for (const k of ["badminton.records", "tabletennis.records", "volleyball.records"]) expect(keys, k).toContain(k);
  });

  it("registry sweep: a declared cfg that is already complete comes back as the very same object, for every sport", () => {
    let checked = 0;
    const visited = forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs<Cfg>(module)) {
        expect(withSchemaDefaults(module, cfg), `${module.key}/${name}`).toBe(cfg);
        checked++;
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(checked, `checked ${checked}`).toBeGreaterThan(0);
  });

  it("nested: a defaulted leaf missing from a stored object is filled from the engine's parse, and its sibling leaves are kept", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs<Cfg>(module)) {
        for (const [k, v] of Object.entries(cfg)) {
          if (!isObj(v)) continue;
          for (const leaf of Object.keys(v)) {
            const partial = { ...cfg, [k]: without(v, leaf) };
            const parsed = module.configSchema.safeParse(partial);
            if (!parsed.success || !isObj((parsed.data as Cfg)[k]) || !Object.hasOwn((parsed.data as Cfg)[k] as Cfg, leaf)) continue;
            const filled = (withSchemaDefaults(module, partial) as Cfg)[k] as Cfg;
            expect(filled[leaf], `${module.key}/${name} ${k}.${leaf}`).toEqual(((parsed.data as Cfg)[k] as Cfg)[leaf]);
            for (const sib of Object.keys(v)) if (sib !== leaf) expect(filled[sib], `${module.key}/${name} ${k}.${sib}`).toBe(v[sib]);
            checked++;
          }
        }
      }
    });
    expect(checked, `checked ${checked} nested leaves`).toBeGreaterThan(0);
  });

  it("a stored key the schema does not know is kept, at the top level and inside an object the schema strips it from", () => {
    const badminton = mod("badminton");
    const filled = withSchemaDefaults(badminton, { ...STG_CFG, legacyFlag: "kept" }) as Cfg;
    expect(filled.legacyFlag).toBe("kept");
    expect(filled.records).toEqual(badminton.configSchema.parse({}).records);
    // Hockey's shoot-out drops a pre-W2e `suddenDeath` in its own parse (the schema's preprocess): the one place the
    // engine's parse of a stored value DIFFERS from it today. The stored object wins whole, so the key survives.
    let checked = 0;
    for (const key of ["hockey", "icehockey"]) {
      const m = mod(key);
      for (const { name, cfg } of declaredCfgs<Cfg>(m)) {
        if (!isObj(cfg.shootout)) continue;
        const stored = { ...without(cfg, "strength"), shootout: { ...cfg.shootout, suddenDeath: true } };
        const parsed = m.configSchema.parse(stored) as Cfg;
        expect(parsed.shootout, `premise: ${key}/${name} parse drops it`).not.toHaveProperty("suddenDeath");
        const out = withSchemaDefaults(m, stored) as Cfg;
        expect(out.shootout, `${key}/${name}`).toBe(stored.shootout);
        expect(out.strength, `${key}/${name} the missing key still filled`).toEqual(parsed.strength);
        checked++;
      }
    }
    expect(checked, `checked ${checked}`).toBeGreaterThan(0);
  });

  it("an existing value is never changed: a stored value off the default stays, and a value the schema's parse would transform stays as stored", () => {
    const badminton = mod("badminton");
    const short = { ...STG_CFG, setTo: 15, finalSetTo: 15 };
    expect(badminton.configSchema.parse({}).setTo, "premise: 15 is not the default").not.toBe(15);
    expect((withSchemaDefaults(badminton, short) as Cfg).setTo).toBe(15);
    // No shipped schema transforms a value today; this one does, so the rule "the stored value wins" has a witness.
    const schema = z.object({ n: z.number().transform((x) => x * 2), d: z.number().default(7) });
    expect(schema.parse({ n: 2 }).n, "premise: the parse changes it").toBe(4);
    expect(withSchemaDefaults({ configSchema: schema }, { n: 2 })).toEqual({ n: 2, d: 7 });
  });

  it("a cfg the sport's schema refuses comes back unchanged (safeParse, never stricter than the fold)", () => {
    const badminton = mod("badminton");
    const refused: Cfg[] = [
      { ...STG_CFG, bestOf: 2 }, // even: no decider (the kernel's refine)
      { ...STG_CFG, records: { timeouts: true } }, // a partial records object: its leaves have no default
      { ...STG_CFG, cap: 10 }, // below the set target
    ];
    for (const cfg of refused) {
      expect(badminton.configSchema.safeParse(cfg).success, `premise: ${JSON.stringify(cfg)}`).toBe(false);
      expect(withSchemaDefaults(badminton, cfg)).toBe(cfg);
    }
    // generic has no all-default cfg: `{}` is refused by its schema and folds raw, as it always has.
    const generic = mod("generic");
    const empty = {};
    expect(generic.configSchema.safeParse(empty).success, "premise").toBe(false);
    expect(withSchemaDefaults(generic, empty)).toBe(empty);
  });

  it("a second call changes nothing: the filled cfg, filled again, is the same object", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const { cfg } of declaredCfgs<Cfg>(module)) {
        const k = Object.keys(cfg)[0]!;
        const once = withSchemaDefaults(module, without(cfg, k));
        expect(withSchemaDefaults(module, once)).toBe(once);
        checked++;
      }
    });
    expect(checked, `checked ${checked}`).toBeGreaterThan(0);
  });
});

describe("resolveFixtureCfg folds the filled cfg in both branches; its stored form is the resolution a freeze writes", () => {
  const badminton = mod("badminton");
  const RECORDS = badminton.configSchema.parse({}).records;

  it("the live branch: a division stored without records resolves with the engine's records; the stored form is the raw division", () => {
    const none = { config_snapshot: null, rules_override: null };
    const out = resolveFixtureCfg(none, STG_CFG, { kind: "league", config: {} }, badminton) as Cfg;
    expect(out.records).toEqual(RECORDS);
    expect(out).toMatchObject(STG_CFG);
    expect(resolveFixtureCfg(none, STG_CFG, { kind: "league", config: {} }, badminton, "stored")).toBe(STG_CFG);
    // The match's own override lands before the fill, and the fill never touches it.
    const ov = resolveFixtureCfg({ config_snapshot: null, rules_override: { bestOf: 5 } }, STG_CFG, null, badminton) as Cfg;
    expect([ov.bestOf, ov.records]).toEqual([5, RECORDS]);
  });

  it("the frozen branch: a snapshot without records resolves with them; the stored form is the snapshot itself", () => {
    const snapshot = structuredClone(STG_CFG);
    const row = { config_snapshot: snapshot, rules_override: null };
    const moved = { ...STG_CFG, bestOf: 5 }; // the division moved since: the snapshot still wins
    const out = resolveFixtureCfg(row, moved, null, badminton) as Cfg;
    expect(out.records).toEqual(RECORDS);
    expect(out.bestOf).toBe(STG_CFG.bestOf);
    expect(resolveFixtureCfg(row, moved, null, badminton, "stored")).toBe(snapshot);
    expect(snapshot, "the snapshot object is never written").toEqual(STG_CFG);
  });

  it("volleyball beach keeps its own records (no substitutions) in both branches, never indoor's default, and a substitution is refused under strict", () => {
    const volleyball = mod("volleyball");
    const beach = volleyball.configSchema.parse(volleyball.variants.beach) as Cfg;
    const indoorDefault = (volleyball.configSchema.parse({}) as Cfg).records as Cfg;
    expect((beach.records as Cfg).substitutions, "premise: beach records no substitutions").toBe(false);
    expect(indoorDefault.substitutions, "premise: the schema default does — the wrong answer differs").toBe(true);
    const frozen = resolveFixtureCfg({ config_snapshot: beach, rules_override: null }, {}, null, volleyball) as Cfg;
    const live = resolveFixtureCfg({ config_snapshot: null, rules_override: null }, beach, null, volleyball) as Cfg;
    for (const cfg of [frozen, live]) {
      expect(cfg.records).toEqual(beach.records);
      const sub = [env(1, "core.start", {}), env(2, "volleyball.sub", { by: "H" })];
      let err: unknown;
      try {
        foldMatchWithStoppage(volleyball, cfg, LINEUPS, sub, { strictFromSeq: 2 });
      } catch (e) {
        err = e;
      }
      expect(EngineError.is(err) && err.code, JSON.stringify(err)).toBe("INVALID_EVENT");
      // The negative pair: under indoor's records the same substitution is accepted.
      expect(() => foldMatchWithStoppage(volleyball, { ...cfg, records: indoorDefault }, LINEUPS, sub, { strictFromSeq: 2 })).not.toThrow();
    }
  });

  it("a sport outside the set-based kernel (tennis, then every sport): an already complete cfg resolves untouched in both branches", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      for (const { name, cfg } of declaredCfgs<Cfg>(module)) {
        expect(resolveFixtureCfg({ config_snapshot: cfg, rules_override: null }, null, null, module), `${module.key}/${name} frozen`).toBe(cfg);
        expect(resolveFixtureCfg({ config_snapshot: null, rules_override: null }, cfg, null, module), `${module.key}/${name} live`).toBe(cfg);
        checked++;
      }
    });
    expect(checked, `checked ${checked}`).toBeGreaterThan(0);
    expect(Object.hasOwn(declaredCfgs<Cfg>(mod("tennis"))[0]!.cfg, "records"), "premise: tennis has no records").toBe(false);
  });
});
