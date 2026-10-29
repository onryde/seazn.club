// P0.1 (pad wave) - the `./pad` subpath's lookups over a PadSpec, and the per-sport record keys.
//
// Two halves. A hand-built spec drives every branch of padFieldOf / padEnumValues / padNumberBound (the found case, each way of NOT
// finding, and the one the plan did not foresee: two actions of the same event type that declare the same path differently). Then a
// sweep over the sport registry, over every config a sport declares, reads every field of every real PadSpec back through padFieldOf
// and compares it with an oracle that shares no code with the lookup (a plain scan that groups definitions by JSON text). Every
// sweep asserts it checked something: a sweep over nothing proves nothing. The keys the real specs declare two ways are also read
// back through `scope.action` (the one way to address a single button of a shared event type).
import { describe, expect, it } from "vitest";
import type { PadAction, PadField, PadSpec } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { padEnumValues, padFieldOf, padNumberBound } from "./index.ts";
import type { FootballPadRules, PadRulesBySport, PeriodPadRules } from "./index.ts";

const label = { key: "pad.fake", label: "fake" };
/** `key` is the action's labelKey.key: the one identity an action has, and what `scope.action` matches. */
const action = (type: string, fields: PadField[], key = "pad.fake"): PadAction => ({ type, labelKey: { key, label: key }, fields, attribution: [] });
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

describe("padFieldOf: what counts as one definition", () => {
  const base: PadField = { kind: "enum", path: "a.b", values: ["p", "q"] };
  const refuses = (a: PadField, b: PadField) => {
    expect(() => padFieldOf(spec([action("x.ev", [a])], [action("x.ev", [b])]), "x.ev", "a.b")).toThrow(/ambiguous/);
    expect(() => padFieldOf(spec([action("x.ev", [b])], [action("x.ev", [a])]), "x.ev", "a.b"), "the order of the actions does not matter").toThrow(/ambiguous/);
  };

  it("a field that differs only by an added key is a different definition (in either order of the actions)", () => {
    refuses(base, { ...base, optional: true });
    refuses(base, { ...base, labelKey: { key: "k", label: "l" } });
  });

  it("a field that differs only by a presentation key is a different definition for padFieldOf, which returns the whole field", () => {
    refuses({ ...base, labelKey: { key: "k1", label: "l" } }, { ...base, labelKey: { key: "k2", label: "l" } });
    refuses(base, { ...base, chips: true });
  });

  it("two fields with the same number of keys but different key sets are different, even when the missing keys hold undefined", () => {
    refuses({ ...base, optional: undefined }, { ...base, group: undefined });
  });

  it("a different kind at the same path is a different definition", () => {
    refuses(base, { kind: "number", path: "a.b", min: 0, max: 1 });
  });

  it("an array is not an object that happens to hold the same indexed keys", () => {
    refuses(base, { ...base, values: { 0: "p", 1: "q" } as unknown as readonly string[] });
  });
});

describe("scope.action: addressing one button of a shared event type", () => {
  const credit: PadField = { kind: "number", path: "d", min: 1, max: 25 };
  const deduct: PadField = { kind: "number", path: "d", min: -25, max: -1 };
  const methodA: PadField = { kind: "enum", path: "m", values: ["p", "q"] };
  const methodB: PadField = { kind: "enum", path: "m", values: ["r"] };
  const s = spec(
    [action("x.ev", [credit, methodA], "pad.fake.credit")],
    [action("x.ev", [deduct, methodB], "pad.fake.deduct")],
    [action("y.ev", [{ kind: "toggle", path: "t" }], "pad.fake.other")],
  );

  it("picks the one action whose labelKey.key is named, for all three lookups", () => {
    expect(padFieldOf(s, "x.ev", "d", { action: "pad.fake.credit" })).toBe(credit);
    expect(padFieldOf(s, "x.ev", "d", { action: "pad.fake.deduct" })).toBe(deduct);
    expect(padNumberBound(s, "x.ev", "d", { action: "pad.fake.credit" })).toEqual({ min: 1, max: 25 });
    expect(padNumberBound(s, "x.ev", "d", { action: "pad.fake.deduct" })).toEqual({ min: -25, max: -1 });
    expect(padEnumValues(s, "x.ev", "m", { action: "pad.fake.credit" })).toEqual(["p", "q"]);
    expect(padEnumValues(s, "x.ev", "m", { action: "pad.fake.deduct" })).toEqual(["r"]);
  });

  it("changes nothing for a key no two actions disagree on, and an empty scope is no scope", () => {
    expect(padFieldOf(s, "y.ev", "t")).toEqual({ kind: "toggle", path: "t" });
    expect(padFieldOf(s, "y.ev", "t", { action: "pad.fake.other" })).toEqual({ kind: "toggle", path: "t" });
    expect(() => padFieldOf(s, "x.ev", "d", {})).toThrow(/ambiguous/);
  });

  it("an ambiguous refusal lists the candidate action keys, so the caller knows what to pass", () => {
    expect(() => padNumberBound(s, "x.ev", "d")).toThrow(/pad\.fake\.credit.*pad\.fake\.deduct/);
    expect(() => padEnumValues(s, "x.ev", "m")).toThrow(/pad\.fake\.credit.*pad\.fake\.deduct/);
    expect(() => padFieldOf(s, "x.ev", "d")).toThrow(/scope/);
  });

  it("throws by name for an action key that is not an action of that event type (a typo is a build bug, never undefined)", () => {
    expect(() => padFieldOf(s, "x.ev", "d", { action: "pad.fake.crdit" })).toThrow(/pad\.fake\.crdit/);
    expect(() => padNumberBound(s, "x.ev", "d", { action: "pad.fake.crdit" })).toThrow(/pad\.fake\.crdit/);
    expect(() => padEnumValues(s, "x.ev", "m", { action: "pad.fake.crdit" })).toThrow(/pad\.fake\.crdit/);
    // the key names the refusal's candidates: the actions of THIS event type
    expect(() => padFieldOf(s, "x.ev", "d", { action: "pad.fake.crdit" })).toThrow(/pad\.fake\.credit.*pad\.fake\.deduct/);
    // a real action key, but of another event type
    expect(() => padFieldOf(s, "x.ev", "t", { action: "pad.fake.other" })).toThrow(/pad\.fake\.other/);
    // an event type with no action at all
    expect(() => padFieldOf(s, "z.ev", "d", { action: "pad.fake.credit" })).toThrow(/z\.ev/);
  });

  it("an action that does not declare the path: undefined from padFieldOf, a named throw from the other two", () => {
    expect(padFieldOf(s, "x.ev", "t", { action: "pad.fake.credit" })).toBeUndefined();
    expect(() => padNumberBound(s, "x.ev", "t", { action: "pad.fake.credit" })).toThrow(/x\.ev.*t/);
  });

  it("a scope cannot disambiguate an action that declares the path two ways itself", () => {
    const twice = spec([action("x.ev", [credit, deduct], "pad.fake.both")]);
    expect(() => padFieldOf(twice, "x.ev", "d", { action: "pad.fake.both" })).toThrow(/ambiguous.*pad\.fake\.both/);
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

  it("judges agreement on what it returns: two actions that differ only in label, chips, optional or group still resolve; a different value set, order or kind does not", () => {
    const dressed: PadField = { kind: "enum", path: "a.b", values: ["p", "q"], labelKey: { key: "pad.fake.f", label: "f" }, chips: true, optional: true, group: "g" };
    const two = (b: PadField) => spec([action("x.ev", [ENUM], "pad.fake.one")], [action("x.ev", [b], "pad.fake.two")]);
    expect(padEnumValues(two(dressed), "x.ev", "a.b")).toEqual(["p", "q"]);
    expect(() => padFieldOf(two(dressed), "x.ev", "a.b"), "padFieldOf returns the whole field, so presentation counts there").toThrow(/ambiguous/);
    expect(() => padEnumValues(two({ ...dressed, values: ["q", "p"] }), "x.ev", "a.b"), "the order of the values").toThrow(/ambiguous/);
    expect(() => padEnumValues(two({ ...dressed, values: ["p"] }), "x.ev", "a.b"), "the value set").toThrow(/ambiguous/);
    expect(() => padEnumValues(two({ kind: "toggle", path: "a.b" }), "x.ev", "a.b"), "the kind").toThrow(/ambiguous/);
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

  it("judges agreement on what it returns: two actions that differ only in label, step, optional or group still resolve; a different bound or kind does not", () => {
    const dressed: PadField = { kind: "number", path: "n.x", min: 2, max: 9, step: 1, labelKey: { key: "pad.fake.f", label: "f" }, optional: true, group: "g" };
    const two = (b: PadField) => spec([action("x.ev", [NUM], "pad.fake.one")], [action("x.ev", [b], "pad.fake.two")]);
    expect(padNumberBound(two(dressed), "x.ev", "n.x")).toEqual({ min: 2, max: 9 });
    expect(() => padFieldOf(two(dressed), "x.ev", "n.x"), "padFieldOf returns the whole field, so presentation counts there").toThrow(/ambiguous/);
    expect(() => padNumberBound(two({ ...dressed, max: 10 }), "x.ev", "n.x"), "the upper bound").toThrow(/ambiguous/);
    expect(() => padNumberBound(two({ ...dressed, min: 1 }), "x.ev", "n.x"), "the lower bound").toThrow(/ambiguous/);
    expect(() => padNumberBound(two({ kind: "toggle", path: "n.x" }), "x.ev", "n.x"), "the kind").toThrow(/ambiguous/);
  });

  it("throws on an ambiguous path rather than answering with one of the bounds", () => {
    // carrom's delta: +1..+25 on one button, -25..-1 on the other
    const up: PadField = { kind: "number", path: "d", min: 1, max: 25 };
    const down: PadField = { kind: "number", path: "d", min: -25, max: -1 };
    expect(() => padNumberBound(spec([action("x.ev", [up])], [action("x.ev", [down])]), "x.ev", "d")).toThrow(/ambiguous/);
  });
});

describe("the lookups on the real modules", () => {
  interface Group {
    fields: PadField[];
    distinct: Set<string>;
  }
  interface Entry extends Group {
    byAction: Map<string, Group>;
  }
  const grow = (g: Group, f: PadField) => {
    g.fields.push(f);
    g.distinct.add(JSON.stringify(f));
  };
  /** The oracle: every (event type, path) key of a spec with its distinct definitions, grouped by JSON text, overall and per action
   *  (labelKey.key). It shares no code with the lookups (a different traversal, a different notion of equal). */
  function oracle(s: PadSpec): Map<string, Entry> {
    const out = new Map<string, Entry>();
    for (const panel of s.panels)
      for (const a of panel.actions)
        for (const f of a.fields) {
          const key = `${a.type}\u0000${f.path}`;
          const e = out.get(key) ?? { fields: [], distinct: new Set<string>(), byAction: new Map<string, Group>() };
          grow(e, f);
          const g = e.byAction.get(a.labelKey.key) ?? { fields: [], distinct: new Set<string>() };
          grow(g, f);
          e.byAction.set(a.labelKey.key, g);
          out.set(key, e);
        }
    return out;
  }
  /** What the enum and number lookups return for a field, as text: its kind and its values or bounds, nothing of its presentation. */
  const returnedOf = (f: PadField): string => (f.kind === "enum" ? `enum ${JSON.stringify(f.values)}` : f.kind === "number" ? `number ${f.min}..${f.max}` : "toggle");
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };

  it("reads every field of every action of every declared config back, refuses exactly the paths declared two ways, and reads those back by action", () => {
    let sports = 0;
    let cfgs = 0;
    let fields = 0;
    let keys = 0;
    let resolved = 0;
    let ambiguous = 0;
    let returned = 0; // enum / number lookups compared with the field's own values or bounds
    let scoped = 0; // lookups through scope.action compared with that action's own field
    const ambiguousKeys = new Set<string>();
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
          const who = `${module.key} ${type} ${path}`;
          const first = e.fields[0] as PadField;
          keys++;
          fields += e.fields.length;
          // the enum / number lookups return only values or bounds, so they judge agreement on those alone
          const sameReturned = new Set(e.fields.map(returnedOf)).size === 1;
          if (e.distinct.size === 1) {
            resolved++;
            expect(padFieldOf(s, type, path), who).toEqual(first);
          } else {
            ambiguous++;
            ambiguousKeys.add(who);
            const msg = messageOf(() => padFieldOf(s, type, path));
            expect(msg, `${who}: padFieldOf refuses`).toMatch(/ambiguous/);
            for (const actionKey of e.byAction.keys()) expect(msg, `${who}: the refusal lists the candidate ${actionKey}`).toContain(actionKey);
          }
          if (first.kind === "enum" || first.kind === "number") {
            const read = () => (first.kind === "enum" ? padEnumValues(s, type, path) : padNumberBound(s, type, path));
            if (sameReturned) expect(read(), `${who}: returned`).toEqual(first.kind === "enum" ? first.values : { min: first.min, max: (first as { max: number }).max });
            else expect(read, `${who}: returned`).toThrow(/ambiguous/);
            returned++;
          }
          if (e.distinct.size > 1) {
            // each action's own definition is one definition, so its key addresses it
            for (const [actionKey, g] of e.byAction) {
              const own = g.fields[0] as PadField;
              expect(g.distinct.size, `${who}: ${actionKey} declares the path one way, or its key cannot address it`).toBe(1);
              expect(padFieldOf(s, type, path, { action: actionKey }), `${who} @ ${actionKey}`).toEqual(own);
              if (own.kind === "enum") expect(padEnumValues(s, type, path, { action: actionKey }), `${who} @ ${actionKey}`).toEqual(own.values);
              if (own.kind === "number") expect(padNumberBound(s, type, path, { action: actionKey }), `${who} @ ${actionKey}`).toEqual({ min: own.min, max: own.max });
              scoped++;
            }
          }
        }
      }
    });
    const sorted = [...ambiguousKeys].sort();
    // eslint-disable-next-line no-console -- the sweep reports what it checked; the same counts are asserted non-zero below
    console.info(`pad lookups: ${sports} sports, ${cfgs} configs, ${keys} (type, path) keys over ${fields} fields: ${resolved} resolved, ${ambiguous} ambiguous (${sorted.join("; ")}); ${returned} enum/number lookups, ${scoped} scoped lookups`);
    expect(noPadSpec, "a sport without a padSpec is outside ./pad's reach: decide that before skipping it").toEqual([]);
    expect(sports, "sports checked").toBe(builtinModules.length);
    expect(cfgs, "configs checked").toBeGreaterThanOrEqual(sports);
    expect(fields, "fields checked").toBeGreaterThan(0);
    expect(keys, "keys checked").toBeGreaterThan(0);
    expect(returned, "enum / number lookups compared").toBeGreaterThan(0);
    // the three keys the plan did not foresee: one event type, two buttons, two definitions. If the engine stops declaring one of them
    // two ways this fails, and the scope tests above stop being proved on a real spec: say so before deleting the name.
    expect(sorted, "the real specs' two-way keys").toEqual(expect.arrayContaining(["boardgame boardgame.result method", "carrom carrom.game.adjust delta", "generic generic.score points"]));
    expect(scoped, "scoped lookups compared").toBeGreaterThanOrEqual(2 * 3);
  });
});

describe("a fixture's offered suspension classes depend on its cfg (PeriodPadRules.suspensionClasses)", () => {
  // The skins offer the classes `cfg.suspensions.classes` lists, so the engine declares them per cfg in padSpec. The record's
  // `suspensionClassKeys` is the static catalogue that keys a tone map; `suspensionClasses(cfg)` is what a fixture is offered.
  const classesByCfg = (sport: string) => {
    const module = builtinModules.find((m) => m.key === sport);
    if (!module?.padSpec) throw new Error(`${sport} has no padSpec`);
    return declaredCfgs(module).map(({ name, cfg }) => ({ name, classes: padEnumValues(module.padSpec!(cfg as never), `${sport}.suspension.start`, "class") }));
  };

  it("icehockey: the recreational cfg offers fewer classes than iihf, read from padSpec", () => {
    const by = new Map(classesByCfg("icehockey").map((c) => [c.name, c.classes]));
    const iihf = by.get("iihf");
    const rec = by.get("recreational");
    expect(iihf, "the iihf variant is declared").toBeDefined();
    expect(rec, "the recreational variant is declared").toBeDefined();
    expect(rec!.length, "recreational offers something").toBeGreaterThan(0);
    expect(rec!.length, "recreational offers fewer").toBeLessThan(iihf!.length);
    for (const c of rec!) expect(iihf!, `${c} is an iihf class too`).toContain(c);
    expect(new Set([...by.values()].map((c) => c.join())).size, "icehockey's declared cfgs disagree").toBeGreaterThan(1);
  });

  it("hockey: every declared cfg offers the same classes (the other sport, and why the cfg argument is still required)", () => {
    const all = classesByCfg("hockey");
    expect(all.length, "hockey cfgs checked").toBeGreaterThan(1);
    expect(new Set(all.map((c) => c.classes.join())).size).toBe(1);
  });
});

describe("the period and football records (tsc is the assertion)", () => {
  it("PeriodPadRules has suspensionClasses(cfg) beside the static suspensionClassKeys, and both period and football take cfg in eventAllowedInPhase", () => {
    // These assignments fail to COMPILE if the member is missing or if eventAllowedInPhase has no cfg parameter (a three-parameter
    // function is not assignable to a two-parameter type); `npm run typecheck` includes this file.
    const classes: PeriodPadRules["suspensionClasses"] = (cfg: unknown) => (cfg === null ? [] : ["minor"]);
    const catalogue: PeriodPadRules["suspensionClassKeys"] = ["minor", "major"];
    const period: PeriodPadRules["eventAllowedInPhase"] = (eventType: string, phase: string, cfg: unknown) => eventType === "e" && phase === "p" && cfg === 1;
    const football: FootballPadRules["eventAllowedInPhase"] = (eventType: string, phase: string, cfg: unknown) => eventType === "e" && phase === "p" && cfg === 1;
    expect([classes(null), classes({}), catalogue, period("e", "p", 1), period("e", "p", 2), football("e", "p", 1), football("e", "q", 1)]).toEqual([[], ["minor"], ["minor", "major"], true, false, true, false]);
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
