// Engine 7.0.0 (onryde/seazn.club.engine#41, F-R3) — football's `extraTimeSubs: { subs, windows }`, Law 3's extra substitution
// and opportunity in extra time, as two number controls in the stage rules form.
//
// single-sport: the key exists in football's schema alone. Expected shapes come from the engine's declaration (the schema's
// JSON form, `stageKeysFor`) and from Law 3 (IFAB 2025/26, 3.2: one more of each), never from the field under test.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StageKind } from "@seazn/engine/core";
import { stageKeysFor } from "@seazn/engine/sport";
import { football } from "@seazn/engine/sports/football";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RuleFieldControl } from "@/components/v2/stage-rules/rule-field-control";
import { stageSections } from "@/components/v2/stage-rules/stage-row-model";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { SPORT_RULES, buildRuleOverride, hydrateRuleValues, type RuleField } from "@/lib/match-rules";
import { stageFieldsFor } from "@/lib/rule-scope";

const FIELDS = ["extraTimeSubs", "extraTimeWindows"] as const;
const fieldOf = (key: string): RuleField => {
  const f = (SPORT_RULES.football ?? []).find((x) => x.key === key);
  if (f === undefined) throw new Error(`football has no field ${key}`);
  return f;
};
const LOCALES = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as unknown as Record<string, Record<string, string>>;

interface JsonObj { type?: string; required?: string[]; properties?: Record<string, { type?: string; minimum?: number }> }
const declared = (): JsonObj =>
  (z.toJSONSchema(football.configSchema as never, { io: "input", unrepresentable: "any" }) as { properties: Record<string, JsonObj> }).properties
    .extraTimeSubs!;

describe("engine 7.0.0 extraTimeSubs: the two controls follow the engine's declaration", () => {
  it("premise: the engine declares an object of two required non-negative integers, stage-scoped", () => {
    const d = declared();
    expect(d.type).toBe("object");
    expect([...(d.required ?? [])].sort()).toEqual(["subs", "windows"]);
    expect(d.properties?.subs).toMatchObject({ type: "integer", minimum: 0 });
    expect(d.properties?.windows).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("both fields are number controls that edit the one key and open at the engine's lowest value", () => {
    for (const key of FIELDS) {
      const f = fieldOf(key);
      expect(f.edits, key).toEqual(["extraTimeSubs"]);
      expect(f.kind, key).toBe("number");
      expect(f.min, key).toBe(0);
      expect(f.max, key).toBeGreaterThanOrEqual(1);
    }
  });

  it("the stage form offers them wherever the engine offers the key (every stage kind, counted), beside the caps they raise", () => {
    let offered = 0;
    for (const kind of StageKind.options) {
      const engine = stageKeysFor(football, kind, null).includes("extraTimeSubs");
      const keys = stageFieldsFor({ module: football, stageKind: kind, variant: null }).map((f) => f.key);
      for (const key of FIELDS) expect(keys.includes(key), `${kind}: ${key}`).toBe(engine);
      if (engine) {
        offered++;
        expect(keys.indexOf("extraTimeSubs"), `${kind}: after the window cap`).toBe(keys.indexOf("subWindows") + 1);
        expect(keys.indexOf("extraTimeWindows"), kind).toBe(keys.indexOf("extraTimeSubs") + 1);
      }
    }
    expect(offered, "stage kinds that offer the key").toBeGreaterThan(0);
    // The knockout stage, where extra time is played, has them in its row.
    const knockout = stageSections(football, "knockout", null).flatMap((s) => s.fields.map((f) => f.key));
    for (const key of FIELDS) expect(knockout, key).toContain(key);
  });

  it("renders as a labelled number input in every locale", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of FIELDS) {
        const f = fieldOf(key);
        const html = renderToStaticMarkup(
          <DictProvider dict={dict as unknown as Dict} locale={locale as never}>
            <RuleFieldControl sportKey="football" field={f} value="1" onEdit={() => undefined} />
          </DictProvider>,
        );
        expect(html, `${locale} ${key}: a number input`).toMatch(/<input\b[^>]*type="number"/);
        expect(html, `${locale} ${key}: holding the value`).toMatch(/<input\b[^>]*value="1"/);
        expect(html, `${locale} ${key}: the localized label`).toContain(dict[f.labelKey]!.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
      }
    }
  });
});

describe("engine 7.0.0 extraTimeSubs: saves and round-trips", () => {
  it("both boxes save the whole object the engine parses, and reopen as typed", () => {
    const built = buildRuleOverride("football", { extraTimeSubs: "1", extraTimeWindows: "1" });
    expect(built).toEqual({ extraTimeSubs: { subs: 1, windows: 1 } });
    expect(football.configSchema.parse({ extraTime: { enabled: true, halfMinutes: 15 }, ...built }).extraTimeSubs).toEqual({ subs: 1, windows: 1 });
    expect(hydrateRuleValues("football", built)).toMatchObject({ extraTimeSubs: "1", extraTimeWindows: "1" });
    // Values that differ, so a swapped leaf cannot pass.
    const two = buildRuleOverride("football", { extraTimeSubs: "2", extraTimeWindows: "0" });
    expect(two).toEqual({ extraTimeSubs: { subs: 2, windows: 0 } });
    expect(hydrateRuleValues("football", two)).toMatchObject({ extraTimeSubs: "2", extraTimeWindows: "0" });
  });

  it("one box alone fills the other with Law 3's one (the engine requires both leaves)", () => {
    expect(buildRuleOverride("football", { extraTimeSubs: "2" })).toEqual({ extraTimeSubs: { subs: 2, windows: 1 } });
    expect(buildRuleOverride("football", { extraTimeWindows: "2" })).toEqual({ extraTimeSubs: { subs: 1, windows: 2 } });
    // Zero is a value, not blank.
    expect(buildRuleOverride("football", { extraTimeSubs: "0" })).toEqual({ extraTimeSubs: { subs: 0, windows: 1 } });
  });

  it("both blank writes nothing (the stage inherits: no extra allowance), and a config without the key reopens blank", () => {
    expect(buildRuleOverride("football", {})).not.toHaveProperty("extraTimeSubs");
    expect(buildRuleOverride("football", { extraTimeSubs: "", extraTimeWindows: "" })).not.toHaveProperty("extraTimeSubs");
    const values = hydrateRuleValues("football", { maxSubs: 5 });
    expect(values).not.toHaveProperty("extraTimeSubs");
    expect(values).not.toHaveProperty("extraTimeWindows");
    // A malformed saved value reads blank rather than as a confident number.
    expect(hydrateRuleValues("football", { extraTimeSubs: 1 })).not.toHaveProperty("extraTimeSubs");
  });

  it("labels and help come through the dictionary in en, es, fr and nl; English is the field's own fallback; the rest are translated", () => {
    let judged = 0;
    for (const key of FIELDS) {
      const f = fieldOf(key);
      for (const [dictKey, fallback] of [[f.labelKey, f.label], [f.helpKey!, f.help!]] as const) {
        expect(LOCALES.en![dictKey], `en ${dictKey}`).toBe(fallback);
        for (const locale of ["es", "fr", "nl"]) {
          const text = LOCALES[locale]![dictKey];
          expect(text?.trim().length, `${locale} ${dictKey}`).toBeGreaterThan(0);
          expect(text, `${locale} ${dictKey} is translated`).not.toBe(fallback);
        }
        judged++;
      }
    }
    expect(judged).toBe(4);
    expect(fieldOf("extraTimeSubs").label).toBe("Extra subs in extra time");
    expect(fieldOf("extraTimeWindows").label).toBe("Extra windows in extra time");
  });
});
