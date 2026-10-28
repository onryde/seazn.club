// W2e Task 28 (B1-1; owner D5, ruling 157) - the five stage keys the engine reads and no editor offered: carrom's
// `pointsPerCoin`, cricket's `minOversForResult` and `superOverStillTied`, football's `rollingSubs` and `concussionSubs`.
//
// Every expected value is the ENGINE's own declaration (the schema's JSON form for a field's kind, range and options;
// `stageKeysFor` / `ruleKeys` for which keys exist and where they are offered), never a number typed in from the web file
// under test. Each sweep reports how many items it judged, and judging none fails it.
//
// Sweeps the sport registry by default (the ratchet). The per-field tests are single-sport on purpose: each of the five
// keys exists in exactly one sport's schema, so there is no other sport to run it against.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StageKind } from "@seazn/engine/core";
import { stageDefaultsFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { cricket } from "@seazn/engine/sports/cricket";
import { SPORT_RULES, buildRuleOverride, hydrateRuleValues, type RuleField } from "@/lib/match-rules";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { detailIsInert, resolvedStageCfg, stageFieldsShown, stageSections } from "@/components/v2/stage-rules/stage-row-model";
import { judgeBuilds } from "./run-contract.ts";

/** The five keys of ruling 157: the sport, the engine cfg key, and the field key the table gives it (the same string). */
const R157 = [
  { sport: "carrom", key: "pointsPerCoin" },
  { sport: "cricket", key: "minOversForResult" },
  { sport: "cricket", key: "superOverStillTied" },
  { sport: "football", key: "rollingSubs" },
  { sport: "football", key: "concussionSubs" },
] as const;

const moduleOf = (sport: string): AnySportModule => builtinModules.find((m) => m.key === sport)!;
const fieldOf = (sport: string, key: string): RuleField | undefined => (SPORT_RULES[sport] ?? []).find((f) => f.key === key);

interface JsonProp { type?: string; enum?: string[]; minimum?: number; exclusiveMinimum?: number }
/** The engine's own statement of one top-level cfg key, read off the schema's JSON form. */
function declared(m: AnySportModule, key: string): JsonProp {
  const json = z.toJSONSchema(m.configSchema as never, { io: "input", unrepresentable: "any" }) as { properties: Record<string, JsonProp> };
  const prop = json.properties[key];
  if (prop === undefined) throw new Error(`${m.key} declares no cfg key ${key}`);
  return prop;
}

describe("R157 the five fields exist and follow the engine's declaration", () => {
  it("R157 no declared stage key lacks a field (every sport x kind x variant; counted; the five were swept)", () => {
    const lacking = new Set<string>();
    const seen = new Set<string>();
    let keys = 0;
    for (const m of builtinModules)
      for (const kind of [null, ...StageKind.options])
        for (const variant of [null, ...Object.keys(m.variants)])
          for (const key of stageKeysFor(m, kind, variant)) {
            keys++;
            seen.add(`${m.key}:${key}`);
            const top = key.split(".")[0];
            if (!(SPORT_RULES[m.key] ?? []).some((f) => f.edits.some((e) => e.split(".")[0] === top))) lacking.add(`${m.key}:${key}`);
          }
    expect(keys, "keys checked").toBeGreaterThan(300);
    // The sweep reaches the five (a population that missed them would pass the ratchet vacuously).
    for (const { sport, key } of R157) expect(seen.has(`${sport}:${key}`), `${sport}:${key} was in the swept population`).toBe(true);
    expect([...lacking].sort()).toEqual([]);
  });

  it("R157 each field's kind, range and options are the engine schema's: integer -> number (its lowest legal value), boolean -> bool, enum -> select (its values, in its order)", () => {
    let judged = 0;
    for (const { sport, key } of R157) {
      const field = fieldOf(sport, key);
      expect(field, `${sport}.${key} has a field`).toBeDefined();
      expect(field!.edits, `${sport}.${key} edits the key it is named for`).toEqual([key]);
      const prop = declared(moduleOf(sport), key);
      if (prop.type === "integer") {
        expect(field!.kind, `${sport}.${key}`).toBe("number");
        const lowest = prop.minimum ?? (prop.exclusiveMinimum === undefined ? undefined : prop.exclusiveMinimum + 1);
        expect(lowest, `${sport}.${key}: the engine bounds it below`).toBeDefined();
        expect(field!.min, `${sport}.${key}: the lowest value the control offers`).toBe(lowest);
        expect(field!.max, `${sport}.${key}: a number control declares both ends`).toBeGreaterThanOrEqual(field!.min!);
      } else if (prop.type === "boolean") {
        expect(field!.kind, `${sport}.${key}`).toBe("bool");
      } else {
        expect(prop.enum, `${sport}.${key}: premise - an enum`).toBeDefined();
        expect(field!.kind, `${sport}.${key}`).toBe("select");
        expect(field!.options!.map((o) => o.value), `${sport}.${key}: the options are the enum`).toEqual(prop.enum);
      }
      judged++;
    }
    expect(judged).toBe(R157.length);
  });

  it("R157 each field's build() parses over every variant of its sport (the variants that offer the key are judged; the rest are named)", () => {
    let parsed = 0;
    let variantsJudged = 0;
    const skipped: string[] = [];
    const tolerated: Record<string, string> = {};
    for (const { sport, key } of R157) {
      const m = moduleOf(sport);
      const field = fieldOf(sport, key)!;
      const verdict = judgeBuilds(m, [field]);
      parsed += verdict.checked;
      Object.assign(tolerated, verdict.tolerated);
      for (const variant of [null, ...Object.keys(m.variants)]) {
        const offered = stageKeysFor(m, null, variant).includes(key);
        if (!offered) {
          skipped.push(`${sport}/${variant}/${key}`);
          continue;
        }
        // The engine offers the key here, so at least one probe of the control must be a config the schema takes.
        const preset = variant === null ? {} : (m.variants[variant] as Record<string, unknown>);
        const probes = field.kind === "select" ? field.options!.map((o) => o.value) : field.kind === "bool" ? ["on", "off"] : [String(field.min), String(field.max)];
        const okProbes = probes.filter((p) => m.configSchema.safeParse({ ...preset, ...field.build(p, { [field.key]: p }) }).success);
        expect(okProbes.length, `${sport}/${variant ?? "-"}/${key}: no probe of the control parses`).toBeGreaterThan(0);
        variantsJudged++;
      }
    }
    expect(parsed, "builds parsed").toBeGreaterThan(0);
    expect(variantsJudged, "sport x variant cells judged").toBeGreaterThan(R157.length);
    // The cricket test match plays two innings, so the engine offers it no super over and no still-tied policy (Task 7), and
    // no DLS and so no result floor (fix round 1: only a DLS par reads it): the two cells the sweep names rather than judges.
    expect(skipped.sort()).toEqual(["cricket/test/minOversForResult", "cricket/test/superOverStillTied"]);
    // The only refusals are the engine's own cross-field ones: the result floor against a short innings.
    for (const [at, message] of Object.entries(tolerated)) {
      expect(at.split("/")[1], `${at}: only minOversForResult meets a cross-field refusal`).toBe("minOversForResult");
      expect(message, at).toBe("minOversForResult exceeds the innings length");
    }
    expect(Object.keys(tolerated).length, "the cross-field refusal is real, not assumed").toBeGreaterThan(0);
  });

  it("R157 a blank control writes nothing (the stage inherits), and a value round-trips build -> read; zero is a value, not blank", () => {
    let judged = 0;
    for (const { sport, key } of R157) {
      const field = fieldOf(sport, key)!;
      expect(buildRuleOverride(sport, {}), `${sport}.${key} blank`).not.toHaveProperty(key);
      const probes = field.kind === "select" ? field.options!.map((o) => o.value) : field.kind === "bool" ? ["on", "off"] : [String(field.min), String(field.max)];
      for (const p of probes) {
        const built = buildRuleOverride(sport, { [field.key]: p });
        expect(built, `${sport}.${key}=${p}`).toHaveProperty(key);
        expect(hydrateRuleValues(sport, built)[field.key], `${sport}.${key}=${p} reopens as typed`).toBe(p);
        judged++;
      }
    }
    expect(judged).toBeGreaterThan(R157.length);
    // A count of zero (no extra concussion substitutes; no minimum overs) is a legal value and must be stored, not skipped.
    expect(buildRuleOverride("football", { concussionSubs: "0" })).toEqual({ concussionSubs: 0 });
    expect(buildRuleOverride("cricket", { minOversForResult: "0" })).toEqual({ minOversForResult: 0 });
  });

  it("R157 a number control opens at the engine's default: the placeholder names the division's value, which is the schema's default where the division carries none", () => {
    // Class 19: pin what the control OPENS AT. The division config the stage editor receives is the parsed one, so the
    // placeholder reads the engine default of each key; two of them differ from the other (1 vs 5 vs 20).
    const opensAt = (sport: string, key: string, variant?: string): unknown => (moduleOf(sport).configSchema.parse(variant === undefined ? {} : moduleOf(sport).variants[variant]) as Record<string, unknown>)[key];
    expect(opensAt("carrom", "pointsPerCoin")).toBe(1);
    expect(opensAt("cricket", "minOversForResult", "t20")).toBe(5);
    expect(opensAt("cricket", "minOversForResult", "odi")).toBe(20);
    expect(opensAt("cricket", "minOversForResult", "t20")).not.toBe(opensAt("cricket", "minOversForResult", "odi"));
  });
});

describe("R157 labels and help come through the dictionary, in all four locales", () => {
  const LOCALES = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as unknown as Record<string, Record<string, string>>;

  it("R157 every field carries a label key and a help key present in en, es, fr and nl; English is the field's own fallback text; the others are translated", () => {
    let judged = 0;
    for (const { sport, key } of R157) {
      const field = fieldOf(sport, key)!;
      expect(field.labelKey, `${sport}.${key} labelKey`).toBeTypeOf("string");
      expect(field.helpKey, `${sport}.${key} helpKey`).toBeTypeOf("string");
      for (const [dictKey, fallback] of [[field.labelKey!, field.label], [field.helpKey!, field.help]] as const) {
        expect(LOCALES.en![dictKey], `en ${dictKey}`).toBe(fallback);
        for (const locale of ["es", "fr", "nl"]) {
          const text = LOCALES[locale]![dictKey];
          expect(text, `${locale} ${dictKey}`).toBeTypeOf("string");
          expect(text!.trim().length, `${locale} ${dictKey} is not blank`).toBeGreaterThan(0);
          expect(text, `${locale} ${dictKey} is not the English copy`).not.toBe(fallback);
        }
        judged++;
      }
    }
    expect(judged).toBe(R157.length * 2);
  });

  it("R157 every option of the still-tied select carries a label key in all four locales, and the English fallback", () => {
    const field = fieldOf("cricket", "superOverStillTied")!;
    let judged = 0;
    for (const option of field.options!) {
      expect(option.labelKey, `option ${option.value}`).toBeTypeOf("string");
      expect(LOCALES.en![option.labelKey!], `en ${option.value}`).toBe(option.label);
      for (const locale of ["es", "fr", "nl"]) {
        expect(LOCALES[locale]![option.labelKey!], `${locale} ${option.value}`).toBeTypeOf("string");
        expect(LOCALES[locale]![option.labelKey!], `${locale} ${option.value} is translated`).not.toBe(option.label);
      }
      judged++;
    }
    expect(judged).toBe(declared(cricket, "superOverStillTied").enum!.length);
  });

  it("R157 the help for 'most boundaries' says what the engine counts: ball-by-ball boundaries only, a summary innings none", () => {
    const field = fieldOf("cricket", "superOverStillTied")!;
    expect(field.help).toMatch(/ball by ball/i);
    expect(field.help).toMatch(/summary/i);
  });

  // M2 (review): the rolling-subs help names the variants that set it. The set is the ENGINE's (the football presets that carry
  // `rollingSubs: true`), so a variant added to the list owes the copy; every locale names mini-soccer (its word for it).
  it("R157 the rolling-subs help names every football variant that sets it (youth, small-sided, mini-soccer), in every locale", () => {
    const football = moduleOf("football");
    const setting = Object.entries(football.variants as Record<string, Record<string, unknown>>)
      .filter(([, v]) => v.rollingSubs === true)
      .map(([name]) => name);
    expect(setting, "premise: the engine's variants that set it").toEqual(expect.arrayContaining(["youth", "small-sided", "mini-soccer"]));
    const field = fieldOf("football", "rollingSubs")!;
    for (const name of setting) expect(field.help, `en help names ${name}`).toContain(name);
    let judged = 0;
    for (const locale of ["en", "es", "fr", "nl"]) {
      expect(LOCALES[locale]![field.helpKey!], `${locale} names mini-soccer`).toMatch(/mini/i);
      judged++;
    }
    expect(judged).toBe(4);
    // 11-a-side does not set it, and the help still says so (the negative pair).
    expect(football.variants["11-a-side"]).not.toHaveProperty("rollingSubs");
    expect(field.help).toContain("11-a-side");
  });
});

describe("R157 superOverStillTied is a detail of the super over: held while it is off, free while it is on", () => {
  const division = cricket.configSchema.parse(cricket.variants.t20) as Record<string, unknown>;
  const field = fieldOf("cricket", "superOverStillTied")!;

  it("R157 superOverStillTied is disabled while the super over is off (the real stage-row model, on the resolved cfg), enabled while it is on", () => {
    const at = (rules: Record<string, unknown>) => resolvedStageCfg(cricket, division, "knockout", rules);
    const off = at({ superOver: false });
    const on = at({ superOver: true });
    expect(off, "premise: the cfg resolves").not.toBeNull();
    expect(on, "premise: the cfg resolves").not.toBeNull();
    expect(detailIsInert(cricket, field, off)).toBe(true);
    expect(detailIsInert(cricket, field, on)).toBe(false);
    // The stage preset a new knockout starts with plays the super over, so the field opens free.
    expect(detailIsInert(cricket, field, at(stageDefaultsFor(cricket, "knockout", "t20")))).toBe(false);
    // The switch itself is never held.
    expect(detailIsInert(cricket, fieldOf("cricket", "superOver")!, off)).toBe(false);
    // A cfg the schema refuses holds nothing (the shared rule).
    expect(detailIsInert(cricket, field, null)).toBe(false);
  });

  // Fix round 1 (PO ruling): the result floor is read only by a DLS par, so it is held while DLS is off, free while it is on.
  // Driven through the real stage-row model on the resolved cfg, over every variant that offers it (counted); the held / free
  // answer is the engine's own: DLS off is a no result at any floor (`cricket.test.ts`, the detailOf premise).
  it("R157 minOversForResult is disabled while DLS is off and enabled while it is on, on every variant that offers it (the real stage-row model)", () => {
    const floor = fieldOf("cricket", "minOversForResult")!;
    const dls = fieldOf("cricket", "dls")!;
    let judged = 0;
    for (const variant of Object.keys(cricket.variants)) {
      if (!stageKeysFor(cricket, "knockout", variant).includes("minOversForResult")) continue;
      const base = cricket.configSchema.parse(cricket.variants[variant as keyof typeof cricket.variants]) as Record<string, unknown>;
      const at = (rules: Record<string, unknown>) => resolvedStageCfg(cricket, base, "knockout", rules);
      const off = at({ dls: { enabled: false, edition: "standard" } });
      const on = at({ dls: { enabled: true, edition: "standard" } });
      expect(off, `${variant}: the cfg resolves`).not.toBeNull();
      expect(on, `${variant}: the cfg resolves`).not.toBeNull();
      expect(detailIsInert(cricket, floor, off), `${variant}: DLS off holds the floor`).toBe(true);
      expect(detailIsInert(cricket, floor, on), `${variant}: DLS on frees the floor`).toBe(false);
      // Every variant defaults DLS to off, so a stage that says nothing holds it (the case that shipped a dead control).
      expect(detailIsInert(cricket, floor, at({})), `${variant}: a stage that says nothing about DLS holds the floor`).toBe(true);
      // The switch is never a detail of itself, in either state.
      expect(detailIsInert(cricket, dls, off)).toBe(false);
      expect(detailIsInert(cricket, dls, on)).toBe(false);
      judged++;
    }
    expect(judged, "variants that offer the floor").toBeGreaterThan(0);
    expect(judged, "and at least one that does not (the test match)").toBeLessThan(Object.keys(cricket.variants).length);
  });

  it("R157 the stage row offers the still-tied policy where the engine does (the deciders section, t20 / odi / hundred) and not on the two-innings test match", () => {
    const sectionOf = (variant: string): string | undefined =>
      stageSections(cricket, "knockout", variant).find((s) => s.fields.some((f) => f.key === "superOverStillTied"))?.id;
    let offered = 0;
    for (const variant of Object.keys(cricket.variants)) {
      const engineOffers = stageKeysFor(cricket, "knockout", variant).includes("superOverStillTied");
      expect(stageFieldsShown(cricket, "knockout", variant).some((f) => f.key === "superOverStillTied"), variant).toBe(engineOffers);
      if (engineOffers) {
        expect(sectionOf(variant), `${variant}: it is a detail of a decider, so it sits with the deciders`).toBe("deciders");
        offered++;
      } else expect(sectionOf(variant), variant).toBeUndefined();
    }
    expect(offered, "variants that offer it").toBeGreaterThan(0);
    expect(offered, "and at least one that does not").toBeLessThan(Object.keys(cricket.variants).length);
    // The result floor is a detail of the DLS SWITCH, not of a decider: it is held while DLS is off, but nothing is being decided,
    // so it sits with the match format beside the switch, and only on the variants that can play DLS.
    for (const variant of Object.keys(cricket.variants)) {
      const sectionOfFloor = stageSections(cricket, "knockout", variant).find((s) => s.fields.some((f) => f.key === "minOversForResult"))?.id;
      const sectionOfSwitch = stageSections(cricket, "knockout", variant).find((s) => s.fields.some((f) => f.key === "dls"))?.id;
      const offered = stageKeysFor(cricket, "knockout", variant).includes("minOversForResult");
      expect(sectionOfFloor, `${variant}: the floor's section`).toBe(offered ? "format" : undefined);
      expect(sectionOfSwitch, `${variant}: the DLS switch's section`).toBe(offered ? "format" : undefined);
    }
  });
});
