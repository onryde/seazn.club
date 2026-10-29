// W2e Task 29 (B1-2; rows TN-CF-1, VB-CF-1, TT-CF-1; ruling 31, RB2A-13; PO decision on cricket's minOversForResult) - what the
// division editors (the builder and Settings, which share `MatchRuleFields`) say BEFORE the organiser presses Save: the write
// doors' refusals beside the fields they are about, the set-target floor on the inputs, and cricket's result floor held while DLS
// is off and gone where the variant has no DLS.
//
// Where each expected value comes from: the refusal sentences are the ENGINE's own constants and `setTargetBelowFloor`; whether a
// combination is refused is ITF App VI (a match tie-break REPLACES the deciding set, so a best of 1 has none) and the engine's own
// answer (`writeConfigIssues`), asked of every combination; the variants a key applies to are the engine's `ruleKeys`
// declarations. Sweeps report how many items they judged, and judging none fails them.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BO1_MATCH_TIEBREAK,
  SET_TARGET_BELOW_FLOOR,
  ruleKeyApplies,
  setTargetBelowFloor,
  writeConfigIssues,
  type AnySportModule,
} from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { SPORT_RULES, buildRuleOverride, rulesFor } from "@/lib/match-rules";
import { setTargetFloorOf } from "@/lib/match-rules/set-target-floor";
import { configIssueText } from "@/lib/config-issue-copy";
import { ruleFormState } from "../match-rules-state";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

const { activeDict } = vi.hoisted(() => ({ activeDict: { current: {} as Record<string, string> } }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const raw = activeDict.current[key];
      if (typeof raw !== "string") return key;
      return vars ? raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : raw;
    },
  };
});

import { MatchRuleFields } from "@/components/v2/match-rules";

type Cfg = Record<string, unknown>;
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const presetOf = (m: AnySportModule, variant: string): Cfg => (m.variants as Record<string, Cfg>)[variant]!;
const EN = enUi as Record<string, string>;
/** The markup a string renders as: `renderToStaticMarkup` escapes `&`, `<`, `>`, `"` and `'` (a French sentence carries an apostrophe). */
const escaped = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("TN-CF-1 the tennis fields refuse best of 1 with a match tie-break in the editor", () => {
  const tennis = moduleOf("tennis");
  const BEST_OF = ["1", "3", "5"] as const;
  const FINAL_SET = ["same", "mtb10", "mtb7", "tb10"] as const;
  /** ITF App VI: a match tie-break REPLACES the deciding set, so a best of 1 (which is its own deciding set) has none. A set
   *  tie-break to ten (`tb10`) is still a set, and is not refused. */
  const refused = (bestOf: string, finalSet: string): boolean => bestOf === "1" && (finalSet === "mtb10" || finalSet === "mtb7");

  it("TN-CF-1 every best-of x deciding-set pair, under every tennis variant: refused exactly when a match tie-break meets best of 1 (counted)", () => {
    let judged = 0;
    let refusedCount = 0;
    for (const variant of Object.keys(tennis.variants)) {
      for (const bestOf of BEST_OF) {
        for (const finalSet of FINAL_SET) {
          const state = ruleFormState({ sportKey: "tennis", variantKey: variant, values: { bestOf, finalSet }, base: presetOf(tennis, variant) });
          const sentences = state.problems.map((p) => p.sentence);
          if (refused(bestOf, finalSet)) {
            expect(sentences, `${variant} best of ${bestOf} + ${finalSet}`).toEqual([BO1_MATCH_TIEBREAK]);
            expect(state.problems[0]!.fields, "the sentence sits beside both fields of the pair").toEqual(["bestOf", "finalSet"]);
            expect([...state.invalid.keys()].sort()).toEqual(["bestOf", "finalSet"]);
            refusedCount++;
          } else {
            expect(sentences, `${variant} best of ${bestOf} + ${finalSet}`).toEqual([]);
            expect(state.invalid.size).toBe(0);
          }
          // The editor and the write door say the same thing about the same config.
          const merged = tennis.configSchema.parse({ ...presetOf(tennis, variant), ...buildRuleOverride("tennis", { bestOf, finalSet }) });
          expect(writeConfigIssues(tennis, merged).length > 0, `${variant} best of ${bestOf} + ${finalSet}: the door agrees`).toBe(refused(bestOf, finalSet));
          judged++;
        }
      }
    }
    expect(judged, "anti-vacuity: 5 variants x 3 x 4").toBe(Object.keys(tennis.variants).length * BEST_OF.length * FINAL_SET.length);
    expect(refusedCount, "and some of them are refusals").toBe(Object.keys(tennis.variants).length * 2);
  });

  it("TN-CF-1 a saved best of 1 with a match tie-break (the Settings case) is refused from the saved config, with the fields blank", () => {
    const saved = tennis.configSchema.parse({ bestOf: 1, finalSet: { matchTiebreakTo: 10 } }) as Cfg;
    const state = ruleFormState({ sportKey: "tennis", variantKey: "tour", values: {}, base: saved });
    expect(state.problems.map((p) => p.sentence)).toEqual([BO1_MATCH_TIEBREAK]);
    // Fixing ONE field of the pair clears it.
    expect(ruleFormState({ sportKey: "tennis", variantKey: "tour", values: { bestOf: "3" }, base: saved }).problems).toEqual([]);
    expect(ruleFormState({ sportKey: "tennis", variantKey: "tour", values: { finalSet: "tb10" }, base: saved }).problems).toEqual([]);
  });

  it("TN-CF-1 the control draws the sentence beside the two fields, in the reader's language, and marks them invalid and described by it", () => {
    for (const [dict, name] of [[enUi, "en"], [esUi, "es"], [frUi, "fr"], [nlUi, "nl"]] as const) {
      activeDict.current = dict as Record<string, string>;
      const values = { bestOf: "1", finalSet: "mtb10" };
      const state = ruleFormState({ sportKey: "tennis", variantKey: "tour", values, base: presetOf(tennis, "tour") });
      const html = renderToStaticMarkup(<MatchRuleFields sportKey="tennis" values={values} onChange={() => {}} state={state} />);
      const sentence = (dict as Record<string, string>)["rules.err.bo1MatchTiebreak"]!;
      expect(sentence, `${name}: the sentence exists`).toBeTruthy();
      expect(html.split(escaped(sentence)).length - 1, `${name}: said once beside each field of the pair`).toBe(2);
      expect(html.match(/role="alert"/g)?.length ?? 0, name).toBe(2);
      expect(html.match(/aria-invalid="true"/g)?.length ?? 0, `${name}: the two controls`).toBe(2);
      // And the control points at the sentence it is described by.
      const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]!);
      expect(ids.length, `${name}: both controls are described`).toBeGreaterThanOrEqual(2);
      for (const id of ids) expect(html, `${name}: ${id} names an element on the page`).toContain(`id="${id}"`);
    }
    expect((esUi as Record<string, string>)["rules.err.bo1MatchTiebreak"]).not.toBe(EN["rules.err.bo1MatchTiebreak"]);
  });

  it("TN-CF-1 a pair the door accepts draws no sentence and no invalid mark", () => {
    activeDict.current = EN;
    const values = { bestOf: "3", finalSet: "mtb10" };
    const state = ruleFormState({ sportKey: "tennis", variantKey: "tour", values, base: presetOf(tennis, "tour") });
    const html = renderToStaticMarkup(<MatchRuleFields sportKey="tennis" values={values} onChange={() => {}} state={state} />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("aria-invalid");
  });
});

describe("VB-CF-1 / TT-CF-1 the set-target inputs take their floor from the engine, and a target below it is refused beside the input", () => {
  const SPORTS = ["volleyball", "tabletennis"] as const;

  it("the input's min is the smallest target the engine's write door accepts, for both fields of both sports (counted)", () => {
    let judged = 0;
    for (const sport of SPORTS) {
      const m = moduleOf(sport);
      const defaults = m.configSchema.parse({}) as Cfg;
      const floor = setTargetFloorOf(sport);
      // The floor is the door's own: one below is refused, the floor is accepted (ruling 31 says 5).
      expect(writeConfigIssues(m, { ...defaults, setTo: floor, finalSetTo: floor }), `${sport}: the floor itself is accepted`).toEqual([]);
      expect(writeConfigIssues(m, { ...defaults, setTo: floor - 1, finalSetTo: floor }), `${sport}: one below is refused`).toEqual([setTargetBelowFloor(floor)]);
      expect(floor, `${sport}: ruling 31`).toBe(5);
      for (const key of ["setTo", "finalSetTo"]) {
        const field = rulesFor(sport).find((f) => f.key === key)!;
        expect(field.min, `${sport}.${key}`).toBe(floor);
        judged++;
      }
    }
    expect(judged).toBe(4);
  });

  it("a sport whose door refuses no target floors at 1, and the search finds no floor for the sports the door says nothing about (every sport counted)", () => {
    let judged = 0;
    for (const m of builtinModules) {
      const floor = setTargetFloorOf(m.key);
      expect(floor, m.key).toBe((SPORTS as readonly string[]).includes(m.key) ? 5 : 1);
      judged++;
    }
    expect(judged).toBe(builtinModules.length);
    expect(setTargetFloorOf("no-such-sport")).toBe(1);
  });

  it("a target below the floor is refused on exactly the field(s) below it; at the floor there is nothing to say (counted)", () => {
    let judged = 0;
    for (const sport of SPORTS) {
      const m = moduleOf(sport);
      const floor = setTargetFloorOf(sport);
      const base = presetOf(m, Object.keys(m.variants)[0]!);
      const cases: { values: Record<string, string>; fields: string[] }[] = [
        { values: { setTo: String(floor - 1) }, fields: ["setTo"] },
        { values: { finalSetTo: String(floor - 1) }, fields: ["finalSetTo"] },
        { values: { setTo: "1", finalSetTo: "2" }, fields: ["setTo", "finalSetTo"] },
        { values: { setTo: String(floor), finalSetTo: String(floor) }, fields: [] },
        { values: {}, fields: [] },
      ];
      for (const c of cases) {
        // `bestOf: "3"` keeps both fields on the screen (best of 1 shows one "Points to win" field).
        const values = { bestOf: "3", ...c.values };
        const state = ruleFormState({ sportKey: sport, variantKey: Object.keys(m.variants)[0]!, values, base });
        expect(state.problems.flatMap((p) => p.fields).sort(), `${sport} ${JSON.stringify(c.values)}`).toEqual([...c.fields].sort());
        for (const p of state.problems) expect(p.sentence).toBe(setTargetBelowFloor(floor));
        judged++;
      }
    }
    expect(judged).toBe(10);
  });

  it("the sentence reads in every locale with the floor filled in, and sits beside the input", () => {
    for (const [dict, name] of [[enUi, "en"], [esUi, "es"], [frUi, "fr"], [nlUi, "nl"]] as const) {
      activeDict.current = dict as Record<string, string>;
      const values = { bestOf: "3", setTo: "3" };
      const state = ruleFormState({ sportKey: "volleyball", variantKey: "indoor", values, base: presetOf(moduleOf("volleyball"), "indoor") });
      const html = renderToStaticMarkup(<MatchRuleFields sportKey="volleyball" values={values} onChange={() => {}} state={state} />);
      const expected = configIssueText({ path: [], message: setTargetBelowFloor(5) }, (key, vars) => {
        const raw = (dict as Record<string, string>)[key]!;
        return vars ? raw.replace(/\{(\w+)\}/g, (m, n: string) => String(vars[n] ?? m)) : raw;
      });
      expect(expected, name).toContain("5");
      expect(expected, `${name}: the template's slot is filled`).not.toContain("{min}");
      expect(html.split(escaped(expected)).length - 1, `${name}: said once, beside setTo only`).toBe(1);
    }
    expect(SET_TARGET_BELOW_FLOOR).toContain("{min}");
  });
});

describe("no problems where the sport's door refuses nothing, and a config the schema refuses says nothing (every sport counted)", () => {
  it("empty values over each sport's own preset: no problem, no hold, no hide - except cricket's test variant, which has no DLS or super over", () => {
    let judged = 0;
    for (const m of builtinModules) {
      for (const variant of Object.keys(m.variants)) {
        const state = ruleFormState({ sportKey: m.key, variantKey: variant, values: {}, base: presetOf(m, variant) });
        expect(state.problems, `${m.key}/${variant}`).toEqual([]);
        if (!(m.key === "cricket" && variant === "test")) expect([...state.hidden], `${m.key}/${variant}: nothing hidden`).toEqual([]);
        judged++;
      }
    }
    expect(judged, "anti-vacuity: every variant of every sport").toBeGreaterThan(30);
  });

  it("a base the schema refuses reports no problem (the door's first answer is the schema's own, not this sentence)", () => {
    const state = ruleFormState({ sportKey: "volleyball", variantKey: "indoor", values: { setTo: "3" }, base: { bestOf: "not a number" } });
    expect(state.problems).toEqual([]);
    expect(ruleFormState({ sportKey: "tennis", variantKey: null, values: { bestOf: "1", finalSet: "mtb10" }, base: undefined }).problems, "no base = nothing to judge against").toEqual([]);
  });
});

describe("cricket's minimum overs for a result: held while DLS is off, gone where the variant has no DLS (PO decision, same as the stage editor)", () => {
  const cricket = moduleOf("cricket");
  const FIELD = "minOversForResult";
  const variantsWithDls = Object.keys(cricket.variants).filter((v) => ruleKeyApplies(cricket.ruleKeys![FIELD]!, null, v));

  it("held while DLS is off (the default), free once it is switched on, on every variant that can play DLS; the reason names the switch (counted)", () => {
    expect(variantsWithDls.length, "premise: some variants can play DLS and one cannot").toBeGreaterThan(0);
    expect(variantsWithDls.length).toBeLessThan(Object.keys(cricket.variants).length);
    const switchLabel = rulesFor("cricket").find((f) => f.key === "dls")!.label;
    let judged = 0;
    for (const variant of variantsWithDls) {
      const off = ruleFormState({ sportKey: "cricket", variantKey: variant, values: {}, base: presetOf(cricket, variant) });
      expect(off.held.get(FIELD), `${variant}: held while DLS is off`).toBe(switchLabel);
      const explicitOff = ruleFormState({ sportKey: "cricket", variantKey: variant, values: { dls: "off" }, base: presetOf(cricket, variant) });
      expect(explicitOff.held.has(FIELD), `${variant}: explicitly off is off`).toBe(true);
      const on = ruleFormState({ sportKey: "cricket", variantKey: variant, values: { dls: "on" }, base: presetOf(cricket, variant) });
      expect(on.held.has(FIELD), `${variant}: free once DLS is on`).toBe(false);
      expect(on.hidden.has(FIELD)).toBe(false);
      judged++;
    }
    expect(judged).toBe(variantsWithDls.length);
  });

  it("a saved DLS-on config frees the field with the DLS field blank (Settings opens on what is saved)", () => {
    const saved = cricket.configSchema.parse({ ...presetOf(cricket, "t20"), dls: { enabled: true, edition: "standard" } }) as Cfg;
    expect(ruleFormState({ sportKey: "cricket", variantKey: "t20", values: {}, base: saved }).held.has(FIELD)).toBe(false);
  });

  it("hidden on the variants the engine says it does not apply to - together with the other keys that share its declaration - and nowhere else (counted)", () => {
    const facts = cricket.ruleKeys!;
    // Every cricket field whose declared keys do not apply to a variant, from the engine's own `appliesTo` (the stage editor's rule).
    let judged = 0;
    for (const variant of Object.keys(cricket.variants)) {
      const expected = rulesFor("cricket")
        .filter((f) => f.edits.some((e) => Object.hasOwn(facts, e)) && f.edits.filter((e) => Object.hasOwn(facts, e)).every((e) => !ruleKeyApplies(facts[e]!, null, variant)))
        .map((f) => f.key)
        .sort();
      const state = ruleFormState({ sportKey: "cricket", variantKey: variant, values: {}, base: presetOf(cricket, variant) });
      expect([...state.hidden].sort(), `cricket/${variant}`).toEqual(expected);
      if (!variantsWithDls.includes(variant)) expect(state.hidden.has(FIELD), `${variant}: no DLS here`).toBe(true);
      judged++;
    }
    expect(judged).toBe(Object.keys(cricket.variants).length);
    // The test variant is the one that hides, and the result floor is among them.
    expect(ruleFormState({ sportKey: "cricket", variantKey: "test", values: {}, base: presetOf(cricket, "test") }).hidden.has(FIELD)).toBe(true);
  });

  it("the grid draws a held field disabled with the reason beside it, omits a hidden one, and still draws the free one (static render)", () => {
    activeDict.current = EN;
    const grid = (variant: string, values: Record<string, string>) =>
      renderToStaticMarkup(
        <MatchRuleFields
          sportKey="cricket"
          values={values}
          onChange={() => {}}
          state={ruleFormState({ sportKey: "cricket", variantKey: variant, values, base: presetOf(cricket, variant) })}
        />,
      );
    const label = EN["rules.field.minOversForResult.label"]!;
    const reason = EN["stageRules.detail.off"]!.replace("{decider}", rulesFor("cricket").find((f) => f.key === "dls")!.label);
    const held = grid("t20", {});
    expect(held).toContain(label);
    expect(held).toContain(reason);
    expect(held).toMatch(/data-testid="rule-field-minOversForResult"[^>]*data-held="true"/);
    expect(held).toMatch(/<input[^>]*disabled=""[^>]*placeholder/);
    const free = grid("t20", { dls: "on" });
    expect(free).toContain(label);
    expect(free).not.toContain(reason);
    const gone = grid("test", {});
    expect(gone).not.toContain(label);
    expect(gone).not.toContain(reason);
    // The other cricket fields are all still there on the test variant (only the four DLS / super-over ones go).
    const kept = rulesFor("cricket").filter((f) => !ruleFormState({ sportKey: "cricket", variantKey: "test", values: {}, base: presetOf(cricket, "test") }).hidden.has(f.key));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(rulesFor("cricket").length);
  });

  it("a sport with no switch-held detail holds nothing, with every switch off (every sport counted)", () => {
    let judged = 0;
    for (const m of builtinModules) {
      if (m.key === "cricket") continue;
      const state = ruleFormState({ sportKey: m.key, variantKey: Object.keys(m.variants)[0]!, values: {}, base: presetOf(m, Object.keys(m.variants)[0]!) });
      expect(state.held.size, m.key).toBe(0);
      judged++;
    }
    expect(judged).toBe(builtinModules.length - 1);
    expect(Object.keys(SPORT_RULES).length).toBeGreaterThan(0);
  });
});
