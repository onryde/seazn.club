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
import { MatchRuleFields, StageRuleFields } from "@/components/v2/rules/match-format-editor";
import { RuleFieldControl } from "@/components/v2/stage-rules/rule-field-control";
import { deciderOfDetail, detailIsInert, resolvedStageCfg, stageSections } from "@/components/v2/stage-rules/stage-row-model";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { RULE_PAIR_INCOMPLETE, SPORT_RULES, buildRuleOverride, hydrateRuleValues, rulePairProblems, type RuleField } from "@/lib/match-rules";
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

const LAW_ET = { enabled: true, halfMinutes: 15 } as const;
const division = football.configSchema.parse({ maxSubs: 5, subWindows: 3 }) as Record<string, unknown>;

describe("engine 7.0.0 extraTimeSubs is a detail of extra time (`detailOf`)", () => {
  it("premise: the engine declares it a detail of extraTime, a decider", () => {
    expect(football.ruleKeys?.extraTimeSubs?.detailOf).toBe("extraTime");
    expect(football.ruleKeys?.extraTime?.decider).toBe(true);
    for (const key of FIELDS) expect(deciderOfDetail(football, fieldOf(key)), key).toBe("extraTime");
  });

  it("the stage row holds both while extra time is off and frees them while it is on (the real stage-row model)", () => {
    const off = resolvedStageCfg(football, division, "knockout", { extraTime: { enabled: false, halfMinutes: 15 } });
    const on = resolvedStageCfg(football, division, "knockout", { extraTime: LAW_ET });
    expect(off, "premise: resolves").not.toBeNull();
    expect(on, "premise: resolves").not.toBeNull();
    for (const key of FIELDS) {
      expect(detailIsInert(football, fieldOf(key), off), `${key} held while extra time is off`).toBe(true);
      expect(detailIsInert(football, fieldOf(key), on), `${key} free while extra time is on`).toBe(false);
    }
    // The switch itself is never held, and a league (no extra time by default) holds them.
    expect(detailIsInert(football, fieldOf("maxSubs"), off)).toBe(false);
    expect(detailIsInert(football, fieldOf("extraTimeSubs"), resolvedStageCfg(football, division, "league", null))).toBe(true);
  });

  it("they sit with the deciders in the knockout stage row, beside extra time", () => {
    const deciders = stageSections(football, "knockout", null).find((s) => s.id === "deciders")?.fields.map((f) => f.key) ?? [];
    for (const key of FIELDS) expect(deciders, key).toContain(key);
  });

  it("rendered: disabled with \"Only used when Extra time is on\" while it is off; enabled with no such line while it is on", () => {
    const render = (extraTime: Record<string, unknown>) =>
      renderToStaticMarkup(
        <DictProvider dict={enUi as unknown as Dict} locale="en">
          <StageRuleFields
            sportKey="football"
            module={football}
            kind="knockout"
            variant={null}
            values={{ extraTimeSubs: "1", extraTimeWindows: "1" }}
            onChange={() => undefined}
            disabled={false}
            divisionConfig={division}
            resolved={resolvedStageCfg(football, division, "knockout", { extraTime, extraTimeSubs: { subs: 1, windows: 1 } })}
          />
        </DictProvider>,
      );
    // The control has no id or name: its input is the one right after its label's text.
    const inputOf = (html: string, key: string) => {
      const label = LOCALES.en![fieldOf(key).labelKey]!.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");
      const at = html.indexOf(`>${label}</span>`);
      return at < 0 ? undefined : html.slice(at).match(/<input[^>]*>/)?.[0];
    };
    const offLine = LOCALES.en!["stageRules.detail.off"]!.replace("{decider}", LOCALES.en![fieldOf("extraTime").labelKey]!);
    const off = render({ enabled: false, halfMinutes: 15 });
    const on = render(LAW_ET);
    expect(off.match(/data-testid="stage-rule-detail-off-extraTimeSubs"/g)?.length, "both boxes say why").toBe(2);
    expect(off).toContain(offLine);
    expect(on).not.toContain('data-testid="stage-rule-detail-off-extraTimeSubs"');
    for (const key of FIELDS) {
      const offInput = inputOf(off, key);
      const onInput = inputOf(on, key);
      expect(offInput, `${key}: premise, the input is found`).toBeDefined();
      expect(offInput, `${key} disabled while off`).toMatch(/\sdisabled=""/);
      expect(onInput, `${key} enabled while on`).not.toMatch(/\sdisabled=""/);
    }
  });
});

describe("ruling 161: the two boxes are a pair", () => {
  it("rulePairProblems names both boxes when exactly one is filled, and neither when both are filled or both blank", () => {
    const cases: [Record<string, string>, string[]][] = [
      [{}, []],
      [{ extraTimeSubs: "", extraTimeWindows: "" }, []],
      [{ extraTimeSubs: "1", extraTimeWindows: "1" }, []],
      [{ extraTimeSubs: "0", extraTimeWindows: "0" }, []],
      [{ extraTimeSubs: "1" }, ["extraTimeSubs", "extraTimeWindows"]],
      [{ extraTimeWindows: "0" }, ["extraTimeSubs", "extraTimeWindows"]],
      [{ extraTimeSubs: "2", extraTimeWindows: "" }, ["extraTimeSubs", "extraTimeWindows"]],
    ];
    for (const [values, named] of cases) {
      const got = rulePairProblems("football", values);
      expect([...got.keys()].sort(), JSON.stringify(values)).toEqual(named);
      for (const key of named) expect(got.get(key)).toBe(RULE_PAIR_INCOMPLETE);
    }
    expect(cases.length).toBe(7);
    // Another sport has no pair: nothing is ever named.
    expect(rulePairProblems("icehockey", { overtime: "on" }).size).toBe(0);
  });

  it("the message is drawn beside both boxes in every locale, in both editors, and only for a half pair", () => {
    expect(LOCALES.en![RULE_PAIR_INCOMPLETE]).toBe("Fill both, or leave both empty");
    let judged = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const text = dict[RULE_PAIR_INCOMPLETE]!;
      expect(text?.trim().length, locale).toBeGreaterThan(0);
      if (locale !== "en") expect(text, `${locale} is translated`).not.toBe(LOCALES.en![RULE_PAIR_INCOMPLETE]);
      const escaped = text.replace(/'/g, "&#x27;");
      const division_ = (values: Record<string, string>) =>
        renderToStaticMarkup(
          <DictProvider dict={dict as unknown as Dict} locale={locale as never}>
            <MatchRuleFields sportKey="football" values={values} onChange={() => undefined} inherited={division} />
          </DictProvider>,
        );
      const stage = (values: Record<string, string>) =>
        renderToStaticMarkup(
          <DictProvider dict={dict as unknown as Dict} locale={locale as never}>
            <StageRuleFields
              sportKey="football"
              module={football}
              kind="knockout"
              variant={null}
              values={values}
              onChange={() => undefined}
              disabled={false}
              divisionConfig={division}
              resolved={null}
            />
          </DictProvider>,
        );
      for (const render of [division_, stage]) {
        expect(render({ extraTimeSubs: "1" }).split(escaped).length - 1, `${locale}: beside both boxes`).toBe(2);
        expect(render({ extraTimeSubs: "1", extraTimeWindows: "1" }), `${locale}: a whole pair says nothing`).not.toContain(escaped);
        expect(render({}), `${locale}: a blank pair says nothing`).not.toContain(escaped);
        judged++;
      }
    }
    expect(judged).toBe(8);
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

  it("ruling 161: one box alone is refused, never defaulted: its half fails the engine's schema at the write door", () => {
    for (const [values, half] of [
      [{ extraTimeSubs: "2" }, { subs: 2 }],
      [{ extraTimeWindows: "2" }, { windows: 2 }],
      [{ extraTimeSubs: "0", extraTimeWindows: "" }, { subs: 0 }],
    ] as const) {
      const built = buildRuleOverride("football", values);
      expect(built, JSON.stringify(values)).toEqual({ extraTimeSubs: half });
      expect(football.configSchema.safeParse({ extraTime: { enabled: true, halfMinutes: 15 }, ...built }).success, `${JSON.stringify(values)} is refused`).toBe(false);
    }
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
