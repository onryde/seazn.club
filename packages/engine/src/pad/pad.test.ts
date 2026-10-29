// P0.1 (pad wave) - the `./pad` subpath's lookups over a PadSpec, and the per-sport record keys.
//
// Two halves. A hand-built spec drives every branch of padFieldOf / padEnumValues / padNumberBound (the found case, each way of NOT
// finding, and the one the plan did not foresee: two actions of the same event type that declare the same path differently). Then a
// sweep over the sport registry, over every config a sport declares, reads every field of every real PadSpec back through padFieldOf
// and compares it with an oracle that shares no code with the lookup (a plain scan that groups definitions by JSON text). Every
// sweep asserts it checked something: a sweep over nothing proves nothing.
import { describe, expect, it } from "vitest";
import type { PadAction, PadField, PadSpec } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { padEnumValues, padFieldOf, padNumberBound } from "./index.ts";
import type { PadRulesBySport } from "./index.ts";

const label = { key: "pad.fake", label: "fake" };
const action = (type: string, fields: PadField[]): PadAction => ({ type, labelKey: label, fields, attribution: [] });
const spec = (...actions: PadAction[][]): PadSpec => ({
  // one panel per group of actions, so a lookup that only reads the first panel is caught
  panels: actions.map((as) => ({ labelKey: label, phase: "live", layout: "primary", actions: as })),
  fidelity: {},
});

const ENUM: PadField = { kind: "enum", path: "a.b", values: ["p", "q"] };
const NUM: PadField = { kind: "number", path: "n.x", min: 2, max: 9 };
const TOGGLE: PadField = { kind: "toggle", path: "t" };

describe("padFieldOf", () => {
  const s = spec([action("x.ev", [ENUM, TOGGLE])], [action("y.ev", [NUM])]);

  it("finds a field by event type and path, in any panel", () => {
    expect(padFieldOf(s, "x.ev", "a.b")).toBe(ENUM);
    expect(padFieldOf(s, "x.ev", "t")).toBe(TOGGLE);
    expect(padFieldOf(s, "y.ev", "n.x")).toBe(NUM); // the second panel
  });

  it("is undefined for an absent path, an absent event type, and a path that belongs to another event type", () => {
    expect(padFieldOf(s, "x.ev", "a.c")).toBeUndefined();
    expect(padFieldOf(s, "z.ev", "a.b")).toBeUndefined();
    expect(padFieldOf(s, "y.ev", "a.b")).toBeUndefined(); // a.b exists, under x.ev
  });

  it("is undefined for an empty spec (the empty case)", () => {
    expect(padFieldOf({ panels: [], fidelity: {} }, "x.ev", "a.b")).toBeUndefined();
    expect(padFieldOf(spec([action("x.ev", [])]), "x.ev", "a.b")).toBeUndefined();
  });

  it("answers the same for two actions of one event type that declare a path identically", () => {
    const twin: PadField = { kind: "enum", path: "a.b", values: ["p", "q"] }; // equal data, a different object
    const dup = spec([action("x.ev", [ENUM])], [action("x.ev", [twin])]);
    expect(padFieldOf(dup, "x.ev", "a.b")).toEqual(ENUM);
  });

  it("refuses, naming the event type and the path, when two actions of one event type declare a path differently", () => {
    // boardgame.result's `method` and carrom.game.adjust's `delta` are exactly this: one event type, two buttons, two bounds
    const other: PadField = { kind: "enum", path: "a.b", values: ["p", "r"] };
    const dup = spec([action("x.ev", [ENUM])], [action("x.ev", [other])]);
    expect(() => padFieldOf(dup, "x.ev", "a.b")).toThrow(/x\.ev.*a\.b|a\.b.*x\.ev/);
    // the refusal is about the differing definitions, not the count: a third action that repeats one of them does not change it
    expect(() => padFieldOf(spec([action("x.ev", [ENUM])], [action("x.ev", [other])], [action("x.ev", [ENUM])]), "x.ev", "a.b")).toThrow(/ambiguous/);
    // a kind change is a difference too
    const num: PadField = { kind: "number", path: "a.b", min: 0, max: 1 };
    expect(() => padFieldOf(spec([action("x.ev", [ENUM, num])]), "x.ev", "a.b")).toThrow(/ambiguous/);
  });
});

describe("padEnumValues", () => {
  const s = spec([action("x.ev", [ENUM, NUM, TOGGLE])]);

  it("returns the declared values", () => {
    expect(padEnumValues(s, "x.ev", "a.b")).toEqual(["p", "q"]);
  });

  it("throws on a missing path, naming the event type and the path (a missing field is a build bug, never [])", () => {
    expect(() => padEnumValues(s, "x.ev", "a.c")).toThrow(/x\.ev.*a\.c/);
    expect(() => padEnumValues(s, "nope.ev", "a.b")).toThrow(/nope\.ev.*a\.b/);
    expect(() => padEnumValues({ panels: [], fidelity: {} }, "x.ev", "a.b")).toThrow(/x\.ev.*a\.b/);
  });

  it("throws on a field that is not an enum, naming the event type, the path and the kind it is", () => {
    expect(() => padEnumValues(s, "x.ev", "n.x")).toThrow(/x\.ev.*n\.x.*number/);
    expect(() => padEnumValues(s, "x.ev", "t")).toThrow(/x\.ev.*t.*toggle/);
  });

  it("throws on an ambiguous path rather than answering with one of the sets", () => {
    const other: PadField = { kind: "enum", path: "a.b", values: ["z"] };
    expect(() => padEnumValues(spec([action("x.ev", [ENUM])], [action("x.ev", [other])]), "x.ev", "a.b")).toThrow(/ambiguous/);
  });
});

describe("padNumberBound", () => {
  const s = spec([action("x.ev", [ENUM, NUM, TOGGLE])]);

  it("returns the declared bound", () => {
    expect(padNumberBound(s, "x.ev", "n.x")).toEqual({ min: 2, max: 9 });
  });

  it("throws on a missing path, naming the event type and the path", () => {
    expect(() => padNumberBound(s, "x.ev", "n.y")).toThrow(/x\.ev.*n\.y/);
    expect(() => padNumberBound(s, "nope.ev", "n.x")).toThrow(/nope\.ev.*n\.x/);
    expect(() => padNumberBound({ panels: [], fidelity: {} }, "x.ev", "n.x")).toThrow(/x\.ev.*n\.x/);
  });

  it("throws on a field that is not a number, naming the event type, the path and the kind it is", () => {
    expect(() => padNumberBound(s, "x.ev", "a.b")).toThrow(/x\.ev.*a\.b.*enum/);
    expect(() => padNumberBound(s, "x.ev", "t")).toThrow(/x\.ev.*t.*toggle/);
  });

  it("throws on an ambiguous path rather than answering with one of the bounds", () => {
    // carrom's delta: +1..+25 on one button, -25..-1 on the other
    const up: PadField = { kind: "number", path: "d", min: 1, max: 25 };
    const down: PadField = { kind: "number", path: "d", min: -25, max: -1 };
    expect(() => padNumberBound(spec([action("x.ev", [up])], [action("x.ev", [down])]), "x.ev", "d")).toThrow(/ambiguous/);
  });
});

describe("padFieldOf on the real modules", () => {
  /** The oracle: every (event type, path) key of a spec with its distinct definitions, grouped by JSON text. It shares no code with
   *  padFieldOf (a different traversal, a different notion of equal). */
  function oracle(s: PadSpec): Map<string, { fields: PadField[]; distinct: Set<string> }> {
    const out = new Map<string, { fields: PadField[]; distinct: Set<string> }>();
    for (const panel of s.panels)
      for (const a of panel.actions)
        for (const f of a.fields) {
          const key = `${a.type}\u0000${f.path}`;
          const e = out.get(key) ?? { fields: [], distinct: new Set<string>() };
          e.fields.push(f);
          e.distinct.add(JSON.stringify(f));
          out.set(key, e);
        }
    return out;
  }

  it("reads every field of every action of every declared config back, and refuses exactly the paths declared two ways", () => {
    let sports = 0;
    let cfgs = 0;
    let fields = 0;
    let keys = 0;
    let resolved = 0;
    let ambiguous = 0;
    const noPadSpec: string[] = [];
    forEachSport(({ module }) => {
      if (!module.padSpec) {
        noPadSpec.push(module.key);
        return;
      }
      sports++;
      for (const { cfg } of declaredCfgs(module)) {
        cfgs++;
        const s = module.padSpec(cfg as never);
        for (const [key, e] of oracle(s)) {
          const [type, path] = key.split("\u0000") as [string, string];
          keys++;
          fields += e.fields.length;
          if (e.distinct.size === 1) {
            resolved++;
            expect(padFieldOf(s, type, path), `${module.key} ${type} ${path}`).toEqual(e.fields[0]);
          } else {
            ambiguous++;
            expect(() => padFieldOf(s, type, path), `${module.key} ${type} ${path}`).toThrow(/ambiguous/);
          }
        }
      }
    });
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the same report is asserted non-zero below
    console.info(`pad lookups: ${sports} sports, ${cfgs} configs, ${keys} (type, path) keys over ${fields} fields: ${resolved} resolved, ${ambiguous} ambiguous`);
    expect(noPadSpec, "a sport without a padSpec is outside ./pad's reach: decide that before skipping it").toEqual([]);
    expect(sports, "sports checked").toBe(builtinModules.length);
    expect(cfgs, "configs checked").toBeGreaterThanOrEqual(sports);
    expect(fields, "fields checked").toBeGreaterThan(0);
    expect(keys, "keys checked").toBeGreaterThan(0);
    expect(resolved + ambiguous, "every key was classified").toBe(keys);
  });
});

describe("PadRulesBySport", () => {
  // The record type names one entry per sport. This table is the exhaustiveness witness: `Record<keyof PadRulesBySport, true>` is a
  // compile error for a sport the type has and the table lacks (and for one the table has and the type lacks), and the registry
  // comparison below is the runtime half - a sport added to the registry without a pad record fails here, by name.
  const KEYS: Record<keyof PadRulesBySport, true> = {
    hockey: true,
    icehockey: true,
    football: true,
    cricket: true,
    badminton: true,
    tabletennis: true,
    volleyball: true,
    tennis: true,
    carrom: true,
    boardgame: true,
    generic: true,
  };

  it("has exactly one entry per registered sport", () => {
    const registered = builtinModules.map((m) => m.key).sort();
    expect(registered.length, "registered sports").toBeGreaterThan(0);
    expect(Object.keys(KEYS).sort()).toEqual(registered);
  });
});
