// X-BD-3: the any-sport template sheet's state transitions. The sports are the engine registry's own, through the page's
// own mapping (`sportOptionsFrom`), so a sport the engine adds is swept without a line here.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sportOptionsFrom } from "@/lib/sport-options";
import { getTemplate } from "@/server/templates/catalog";
import {
  choiceBody, choosableSports, initialChoice, pickCount, pickKind, pickSport, pickVariantKey, templateRequestBody, toChoice,
} from "../template-choice";

const SPORTS = sportOptionsFrom(
  builtinModules.map((m) => ({ key: m.key, name: m.key })),
  builtinModules.flatMap((m) => Object.keys(m.variants).map((key) => ({ sport_key: m.key, key, name: key, is_system: true, config: null }))),
  (key) => {
    const m = builtinModules.find((x) => x.key === key)!;
    const e = effectiveEntrantModel((m as { entrantModel?: never }).entrantModel ?? null, null);
    return { kinds: e.kinds, defaultKind: e.defaultKind };
  },
);
const DIVISION = getTemplate("super-groups")!.divisions[0]!;
const modelOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key)!;
  return effectiveEntrantModel((m as { entrantModel?: never }).entrantModel ?? null, null);
};

describe("template choice — the sheet's state (X-BD-3)", () => {
  it("empty case first: no sport to build on gives no state, and a sport the page could not resolve is not offered", () => {
    expect(initialChoice(DIVISION, [])).toBeNull();
    const unresolved = [{ key: "x", name: "x", variants: [{ key: "v", name: "v", system: true }] }];
    expect(choosableSports(unresolved)).toEqual([]);
    expect(initialChoice(DIVISION, unresolved)).toBeNull();
    expect(choosableSports([{ key: "y", name: "y", variants: [], entrants: { kinds: ["team"], defaultKind: "team" } }])).toEqual([]);
  });

  it("the first state is a real sport on its starting variant with its own default kind and the template's default count", () => {
    const s = initialChoice(DIVISION, SPORTS)!;
    expect(SPORTS.some((x) => x.key === s.sportKey)).toBe(true);
    expect(s.kind).toBe(modelOf(s.sportKey).defaultKind);
    expect(s.count).toBe(16);
    expect(s.kindTouched).toBe(false);
  });

  it("every sport: picking it lands on one of its variants and a kind it plays (an untouched kind follows the sport)", () => {
    let checked = 0;
    const from = initialChoice(DIVISION, SPORTS)!;
    for (const m of builtinModules) {
      const next = pickSport(from, m.key, SPORTS);
      expect(next.sportKey).toBe(m.key);
      expect(Object.keys(m.variants), m.key).toContain(next.variantKey);
      expect(next.kind, m.key).toBe(modelOf(m.key).defaultKind);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a kind the organiser picked survives a sport change only where the new sport plays it", () => {
    let kept = 0;
    let dropped = 0;
    const start = pickKind(pickSport(initialChoice(DIVISION, SPORTS)!, "badminton", SPORTS), "pair");
    expect(start.kind).toBe("pair");
    for (const m of builtinModules) {
      const next = pickSport(start, m.key, SPORTS);
      const plays = modelOf(m.key).kinds.includes("pair");
      expect(next.kind, m.key).toBe(plays ? "pair" : modelOf(m.key).defaultKind);
      if (plays) kept++; else dropped++;
    }
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
  });

  it("an unknown sport leaves the state as it was; a variant and a count change only themselves", () => {
    const s = initialChoice(DIVISION, SPORTS)!;
    expect(pickSport(s, "no-such-sport", SPORTS)).toBe(s);
    expect(pickVariantKey(s, "zzz")).toEqual({ ...s, variantKey: "zzz" });
    expect(pickCount(s, 24)).toEqual({ ...s, count: 24 });
  });

  it("the state goes out as resolveTemplate and the POST take it", () => {
    const s = pickCount(pickKind(pickSport(initialChoice(DIVISION, SPORTS)!, "badminton", SPORTS), "pair"), 12);
    expect(toChoice(s)).toEqual({ sportKey: "badminton", variantKey: s.variantKey, entrantKind: "pair", entrantCount: 12 });
    expect(choiceBody(s)).toEqual({ sport_key: "badminton", variant_key: s.variantKey, entrant_kind: "pair", entrant_count: 12 });
  });

  it("the POST carries the choice for an any-sport template and nothing extra for a fixed one", () => {
    const fields = { name: "Cup", startsOn: "", endsOn: "2030-12-31" };
    const choice = pickCount(pickKind(pickSport(initialChoice(DIVISION, SPORTS)!, "badminton", SPORTS), "pair"), 24);
    const any = templateRequestBody({ template: { key: "super-groups", version: 1 }, ...fields, choice });
    expect(any).toEqual({
      template_key: "super-groups", template_version: 1, name: "Cup", starts_on: null, ends_on: "2030-12-31",
      sport_key: "badminton", variant_key: choice.variantKey, entrant_kind: "pair", entrant_count: 24,
    });
    const fixed = templateRequestBody({ template: { key: "t20-super8", version: 1 }, ...fields, choice: null });
    expect(Object.keys(fixed).sort()).toEqual(["ends_on", "name", "starts_on", "template_key", "template_version"]);
  });
});
