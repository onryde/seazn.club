// W2c Task 17 — a stage's rules FRAGMENT reopens as what it holds, for every sport.
//
// Until now only the four sets-based sports (and two football points fields) implemented `RuleField.read`, so the stage
// editor would have opened every other sport's stored knockout preset showing "Default" over a saved extra time, shoot-out
// or tie-break list, and its first save would have rebuilt (or dropped) them. The stage form is now offered for EVERY
// sport, so this sweep derives its populations from the engine's own declarations (`stageFieldsFor`, which asks
// `ruleKeys` for each sport, stage kind and variant) and walks every one of them through the real `buildRuleOverride` /
// `hydrateRuleValues` pair:
//
//  1. ROUND-TRIP: what a field builds, it reads back, for EVERY value it can produce (each select option, both bool
//     states, both ends of a number's range, a sequence in full, reversed, partial and empty);
//  2. FRAGMENT-ONLY: an empty fragment hydrates to nothing (a `read` that fell back to a default would make every field
//     look overridden, and the first save would pin the whole division format onto the stage).
//
// Pure: no database, no DOM. Counts are reported and pinned from the declarations, never from the code under test.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { SPORT_RULES, buildRuleOverride, hydrateRuleValues, type RuleField } from "@/lib/match-rules";
import { stageFieldsFor } from "@/lib/rule-scope";

const KINDS = ["league", ...BRACKET_KINDS] as const;

/** Every stage field of a sport across the stage kinds and variants the engine declares, in table order, once each. */
function stageFieldsOf(sport: string): RuleField[] {
  const m = builtinModules.find((x) => x.key === sport)!;
  const seen = new Map<string, RuleField>();
  for (const kind of KINDS)
    for (const variant of [null, ...Object.keys(m.variants)])
      for (const f of stageFieldsFor({ module: m, stageKind: kind, variant })) seen.set(f.key, f);
  const order = SPORT_RULES[sport]!.map((f) => f.key);
  return [...seen.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** A field that builds nothing for its own value - a sub-field whose parent assembles the object (hockey's shoot-out
 *  attempts). It has a home in the config only while the parent is on. */
const isDependent = (f: RuleField): boolean => Object.keys(f.build(probesFor(f)[0]!, {})).length === 0;

/** Every value this field can produce, from its own declaration. */
function probesFor(f: RuleField): string[] {
  if (f.kind === "select") return (f.options ?? []).map((o) => o.value);
  if (f.kind === "bool") return ["on", "off"];
  if (f.kind === "sequence") {
    const all = (f.options ?? []).map((o) => o.value);
    return [all.join(","), [...all].reverse().join(","), all[0]!, ...(f.emptyValue === undefined ? [] : [f.emptyValue])];
  }
  const lo = f.min ?? 1;
  const hi = f.max ?? lo + 1;
  return lo === hi ? [String(lo)] : [String(lo), String(hi)];
}

describe("the stage form reopens as what it holds (every sport, derived from the engine)", () => {
  it("round-trips every value of every stage field, with every other field set beside it (counted)", () => {
    const probed: Record<string, number> = {};
    let expected = 0;
    const failures: string[] = [];
    for (const m of builtinModules) {
      const fields = stageFieldsOf(m.key);
      expect(fields.length, `${m.key} offers no stage field at all`).toBeGreaterThan(0);
      // Every other stage field, set to a value that disturbs no sibling: a bool on, a select at its LAST option (a
      // best of 1 would fold "set to" into the single points field, which is that pair's own test), a number at its
      // low end. A dependent sub-field is left out of the base.
      const base: Record<string, string> = {};
      for (const f of fields) {
        if (isDependent(f)) continue;
        const p = probesFor(f);
        base[f.key] = f.kind === "bool" ? "on" : f.kind === "select" ? p[p.length - 1]! : p[0]!;
      }
      for (const f of fields) {
        for (const probe of probesFor(f)) {
          expected++;
          const values = { ...base, [f.key]: probe };
          const hydrated = hydrateRuleValues(m.key, buildRuleOverride(m.key, values));
          // A dependent sub-field has no home while its parent is off: only probed beside an "on" parent.
          const ok = hydrated[f.key] === probe;
          if (!ok) failures.push(`${m.key}.${f.key} probe "${probe}" read back ${JSON.stringify(hydrated[f.key])}`);
          probed[`${m.key}.${f.key}`] = (probed[`${m.key}.${f.key}`] ?? 0) + 1;
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(Object.values(probed).reduce((a, b) => a + b, 0), "every probe was run").toBe(expected);
    // Every sport contributed, and every stage field contributed at least one probe.
    for (const m of builtinModules)
      for (const f of stageFieldsOf(m.key)) expect(probed[`${m.key}.${f.key}`], `${m.key}.${f.key} was never probed`).toBeGreaterThan(0);
    expect(new Set(Object.keys(probed).map((k) => k.split(".")[0])).size).toBe(builtinModules.length);
    expect(expected).toBeGreaterThan(builtinModules.length * 4);
  });

  it("an empty fragment hydrates to nothing for every sport, so a save never pins what it never read (counted)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      expect(hydrateRuleValues(m.key, {}), m.key).toEqual({});
      expect(hydrateRuleValues(m.key, null), m.key).toEqual({});
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
  });

  it("a number field reads a number only: a string where a number belongs hydrates blank, never a false value (counted)", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const f of stageFieldsOf(m.key).filter((x) => x.kind === "number")) {
        const built = f.build(String(f.min ?? 1), { [f.key]: String(f.min ?? 1) });
        const junk = Object.fromEntries(Object.keys(built).map((k) => [k, "7"]));
        if (Object.keys(junk).length === 0) continue; // a dependent sub-field has no key of its own
        expect(hydrateRuleValues(m.key, junk)[f.key], `${m.key}.${f.key}`).toBeUndefined();
        checked++;
      }
    expect(checked).toBeGreaterThan(builtinModules.length);
  });
});
