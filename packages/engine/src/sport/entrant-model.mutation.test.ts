// Engine mutation debt (sport-free lane) — effectiveEntrantModel's field-by-field merge (spec 2026-07-18: module declaration ←
// division `config.entrants` override), swept over every entrant model the shipped sport modules declare. Expected values come
// from each module's OWN declaration (its kinds, defaultKind and team block) and the merge rule, never from a list typed here, so
// a sport added later is swept without an edit. The kind universe is the engine's legacy fallback (no model ⇒ every kind),
// which entrant-model.test.ts pins to team / individual / pair.
import { describe, expect, it } from "vitest";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { effectiveEntrantModel, type EntrantKind, type EntrantModel } from "./entrant-model.ts";

const UNIVERSE: readonly EntrantKind[] = effectiveEntrantModel(null).kinds;

/** Each shipped module's declared entrant model (a module with none — generic — is the legacy fallback, covered elsewhere). */
function declaredModels(): { key: string; model: EntrantModel }[] {
  const out: { key: string; model: EntrantModel }[] = [];
  const visited = forEachSport(({ key, module }) => {
    if (module.entrantModel !== undefined) out.push({ key, model: module.entrantModel });
  });
  expect(visited).toBeGreaterThan(0);
  expect(out.length).toBeGreaterThan(0);
  return out;
}

/** The affordance a module declares, or the legacy "team affordances on" when it declares no team block. */
const declaredSquadNumbers = (m: EntrantModel): boolean => (m.team === undefined ? true : m.team.squadNumbers);
const declaredCaptain = (m: EntrantModel): boolean => (m.team === undefined ? true : m.team.captain);

describe("effectiveEntrantModel over every declared entrant model", () => {
  it("guards the sweep's own premises: three kinds, and every declared default is one of its own kinds", () => {
    expect(UNIVERSE).toHaveLength(3);
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      expect(model.kinds.length, key).toBeGreaterThan(0);
      expect(model.kinds, key).toContain(model.defaultKind);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("no override — no config, no `entrants`, a null `entrants`, a primitive `entrants` — is the declaration as declared", () => {
    // `{ entrants: null }` is a jsonb config an organiser's division can hold; it must read as "no override", not crash.
    const configs: unknown[] = [undefined, null, {}, { entrants: undefined }, { entrants: null }, { entrants: "team" }, { entrants: 7 }];
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      for (const config of configs) {
        const eff = effectiveEntrantModel(model, config);
        expect(eff.kinds, `${key} ${JSON.stringify(config)}`).toEqual(model.kinds);
        expect(eff.defaultKind, `${key} ${JSON.stringify(config)}`).toBe(model.defaultKind);
        expect(eff.squadNumbers, key).toBe(declaredSquadNumbers(model));
        expect(eff.captain, key).toBe(declaredCaptain(model));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a declaration whose default is outside its own kinds is repaired to its first kind even with NO division override", () => {
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      for (const outside of UNIVERSE.filter((k) => !model.kinds.includes(k))) {
        const broken: EntrantModel = { ...model, defaultKind: outside };
        expect(effectiveEntrantModel(broken).defaultKind, `${key} declaring ${outside}`).toBe(model.kinds[0]);
        expect(effectiveEntrantModel(broken, {}).defaultKind, `${key} declaring ${outside}, empty config`).toBe(model.kinds[0]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a kinds override keeps only real kinds, in the order the division gave them; nothing real left ⇒ the declaration", () => {
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      const reversed = [...model.kinds].reverse();
      const eff = effectiveEntrantModel(model, { entrants: { kinds: [...reversed, "bogus", 7, null, "Team"] } });
      expect(eff.kinds, key).toEqual(reversed);
      // The empty case: a kinds list with no real kind in it is no override at all.
      expect(effectiveEntrantModel(model, { entrants: { kinds: [] } }).kinds, key).toEqual(model.kinds);
      expect(effectiveEntrantModel(model, { entrants: { kinds: ["bogus"] } }).kinds, key).toEqual(model.kinds);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a defaultKind override applies exactly when it is a kind among the effective kinds", () => {
    let applied = 0;
    let refused = 0;
    for (const { key, model } of declaredModels()) {
      for (const k of UNIVERSE) {
        const eff = effectiveEntrantModel(model, { entrants: { defaultKind: k } });
        if (model.kinds.includes(k)) {
          expect(eff.defaultKind, `${key} default ${k}`).toBe(k);
          applied++;
        } else {
          expect(eff.defaultKind, `${key} default ${k}`).toBe(model.defaultKind);
          refused++;
        }
      }
    }
    // Both directions, and at least one module where the override MOVES the default (a multi-kind module).
    expect(applied).toBeGreaterThan(declaredModels().length);
    expect(refused).toBeGreaterThan(0);
  });

  it("a reordered kinds override keeps the declared default while it is still allowed — a refused or garbage default changes nothing", () => {
    // Reversing a multi-kind declaration puts a DIFFERENT kind first, so "fell back to the first kind" and "kept the declared
    // default" give different answers here; a single-kind module cannot witness it and is not counted.
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      const reversed = [...model.kinds].reverse();
      if (reversed[0] === model.defaultKind) continue;
      const refusedDefaults: unknown[] = [undefined, "bogus", 3, ...UNIVERSE.filter((k) => !model.kinds.includes(k))];
      for (const defaultKind of refusedDefaults) {
        const eff = effectiveEntrantModel(model, { entrants: { kinds: reversed, defaultKind } });
        expect(eff.kinds, key).toEqual(reversed);
        expect(eff.defaultKind, `${key} reversed, default ${String(defaultKind)}`).toBe(model.defaultKind);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a kinds override that drops the declared default moves it to the override's first kind", () => {
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      for (const k of UNIVERSE.filter((kind) => kind !== model.defaultKind)) {
        const eff = effectiveEntrantModel(model, { entrants: { kinds: [k] } });
        expect(eff.kinds, key).toEqual([k]);
        expect(eff.defaultKind, `${key} narrowed to ${k}`).toBe(k);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("squadNumbers and captain: a boolean override wins in both directions; anything else leaves the declaration", () => {
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      for (const value of [true, false]) {
        expect(effectiveEntrantModel(model, { entrants: { squadNumbers: value } }).squadNumbers, `${key} squadNumbers ${value}`).toBe(value);
        expect(effectiveEntrantModel(model, { entrants: { captain: value } }).captain, `${key} captain ${value}`).toBe(value);
        // The other affordance is untouched by an override of this one.
        expect(effectiveEntrantModel(model, { entrants: { squadNumbers: value } }).captain, key).toBe(declaredCaptain(model));
        expect(effectiveEntrantModel(model, { entrants: { captain: value } }).squadNumbers, key).toBe(declaredSquadNumbers(model));
      }
      for (const garbage of [undefined, null, "false", 0, 1, {}]) {
        const eff = effectiveEntrantModel(model, { entrants: { squadNumbers: garbage, captain: garbage } });
        expect(eff.squadNumbers, `${key} squadNumbers ${JSON.stringify(garbage)}`).toBe(declaredSquadNumbers(model));
        expect(eff.captain, `${key} captain ${JSON.stringify(garbage)}`).toBe(declaredCaptain(model));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a second call is independent of the first: changing one result's kinds leaves the declaration and the next call alone", () => {
    let checked = 0;
    for (const { key, model } of declaredModels()) {
      const declared = [...model.kinds];
      const first = effectiveEntrantModel(model, { entrants: {} });
      first.kinds.push("pair", "team");
      first.defaultKind = "pair";
      expect(model.kinds, key).toEqual(declared);
      expect(effectiveEntrantModel(model, { entrants: {} }).kinds, key).toEqual(declared);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
