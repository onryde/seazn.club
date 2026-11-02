// W2e Task 33a - the rule fields REACH the screen in the viewer's language. `lib/match-rules/__tests__/field-copy.test.ts` proves
// every field names its dictionary keys and the four dictionaries carry them; this file proves the SCREENS read them: the real
// stage editor (`StageRuleFields`) and the real division grid (`MatchRuleFields`), rendered in Spanish, French and Dutch for every
// sport, draw the dictionary's label, help and option text and none of the English; and so do the places that quote a field by
// name (the "held while ... is off" reason, an abandon option's unavailable reason, the "kept" lines of a refused save, the best of 1
// relabel). Static markup is the "is it on the screen" half; it cannot see a click.
//
// Expected text is read from the locale's own dictionary through the key the FIELD names - never typed here, never taken from the
// code under test's output. Every sweep reports how many items it judged, and judging none fails it.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, type StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { SPORT_RULES, SINGLE_SET_POINTS_LABEL_KEY, ruleOptionText, visibleRuleFields, type RuleField } from "@/lib/match-rules";
import { stageFieldsFor } from "@/lib/rule-scope";
import type { RefusedField } from "@/lib/rule-errors";
import { MatchRuleFields } from "@/components/v2/rules/match-format-editor";
import { StageRuleFields } from "@/components/v2/rules/match-format-editor";
import { resolvedStageCfg } from "../stage-rules/stage-row-model";
import { refusedLines } from "../division-settings-locks";

type Locale = "es" | "fr" | "nl";
const LOCALES: ReadonlyArray<readonly [Locale, Record<string, string>]> = [
  ["es", esUi as unknown as Record<string, string>],
  ["fr", frUi as unknown as Record<string, string>],
  ["nl", nlUi as unknown as Record<string, string>],
];
const EN = enUi as unknown as Record<string, string>;
const KINDS = ["league", ...BRACKET_KINDS] as StageKind[];
/** `renderToStaticMarkup` escapes `&`, `<`, `>`, `"` and `'` in text. */
const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** The same word in a language (see `field-copy.test.ts`): the English reading is then correct and not a leftover. */
const SAME_AS_ENGLISH = new Set(["nl rules.field.overs.label", "nl rules.field.tiebreakRungs.option.armageddon", "fr rules.field.tiebreakRungs.option.armageddon", "es rules.field.variant.option.blitz", "fr rules.field.variant.option.blitz", "nl rules.field.variant.option.blitz", "nl rules.field.variant.option.rapid"]);

const inDictProvider = (locale: Locale, dict: Record<string, string>, node: React.ReactNode): string =>
  renderToStaticMarkup(<DictProvider dict={dict as unknown as Dict} locale={locale}>{node}</DictProvider>);

/** What a screen must draw for one field in a language, and what it must not: the label span, the help line, each option's text. */
function expectations(field: RuleField, locale: Locale, dict: Record<string, string>): { present: string[]; absent: string[] } {
  const present: string[] = [];
  const absent: string[] = [];
  const add = (key: string, english: string, wrap: (s: string) => string) => {
    present.push(wrap(esc(dict[key]!)));
    if (!SAME_AS_ENGLISH.has(`${locale} ${key}`)) absent.push(wrap(esc(english)));
  };
  add(field.labelKey, field.label, (s) => `>${s}<`);
  // Only a dictionary-keyed help is drawn from the dictionary; every curated field has one when it has help at all.
  if (field.help !== undefined) add(field.helpKey!, field.help, (s) => `>${s}<`);
  if (field.kind === "select" || field.kind === "sequence") {
    for (const o of field.options ?? []) add(o.labelKey!, o.label, (s) => `>${s}<`);
  }
  return { present, absent };
}

describe("the stage editor draws every field's label, help and options in the page's language (every sport x stage kind x locale, counted)", () => {
  it("each stage field the engine declares for a cell reads from the locale's dictionary and leaves no English behind", () => {
    let cells = 0, fieldsJudged = 0, optionsJudged = 0;
    const problems: string[] = [];
    for (const [locale, dict] of LOCALES) {
      for (const m of builtinModules) {
        for (const kind of KINDS) {
          const fields = stageFieldsFor({ module: m, stageKind: kind, variant: null });
          const markup = inDictProvider(
            locale,
            dict,
            <StageRuleFields sportKey={m.key} module={m} kind={kind} variant={null} values={{}} onChange={() => undefined} disabled={false} divisionConfig={{}} resolved={null} />,
          );
          cells++;
          for (const f of fields) {
            const { present, absent } = expectations(f, locale, dict);
            for (const text of present) if (!markup.includes(text)) problems.push(`${locale} ${m.key}/${kind} ${f.key}: missing ${text}`);
            for (const text of absent) if (markup.includes(text)) problems.push(`${locale} ${m.key}/${kind} ${f.key}: English left ${text}`);
            fieldsJudged++;
            optionsJudged += f.options?.length ?? 0;
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(cells, "premise: cells were rendered").toBeGreaterThan(builtinModules.length);
    expect(fieldsJudged, "premise: fields were judged").toBeGreaterThan(cells);
    expect(optionsJudged, "premise: select options were judged").toBeGreaterThan(0);
  });

  it("an ordered list (chess's tie-break games) draws its group name, its add menu and each listed game in the page's language", () => {
    const boardgame = builtinModules.find((m) => m.key === "boardgame")!;
    const rungs = SPORT_RULES.boardgame!.find((f) => f.kind === "sequence")!;
    let judged = 0;
    for (const [locale, dict] of LOCALES) {
      const markup = inDictProvider(locale, dict, <StageRuleFields sportKey="boardgame" module={boardgame} kind={"knockout" as StageKind} variant={null} values={{ [rungs.key]: "rapid,blitz" }} onChange={() => undefined} disabled={false} divisionConfig={{}} resolved={null} />);
      expect(markup, `${locale}: the group is named in this language`).toContain(`role="group" aria-label="${esc(dict[rungs.labelKey]!)}"`);
      expect(markup, `${locale}: the add menu names the field in this language`).toContain(`aria-label="${esc(dict[rungs.labelKey]!)}: ${esc(dict["stageRules.sequence.add"]!)}"`);
      // Two games listed (rapid, blitz); the third (armageddon) is still to add, so it is a menu option.
      for (const value of ["rapid", "blitz"]) expect(markup, `${locale}: ${value} is listed`).toContain(`>${esc(dict[rungs.options!.find((o) => o.value === value)!.labelKey!]!)}<`);
      expect(markup, `${locale}: armageddon is offered`).toContain(`>${esc(dict[rungs.options!.find((o) => o.value === "armageddon")!.labelKey!]!)}<`);
      judged++;
    }
    expect(judged).toBe(LOCALES.length);
  });

  it("the reason a detail is held names the switch in the page's language (cricket DLS off, football shoot-out off)", () => {
    const cricket = builtinModules.find((m) => m.key === "cricket")!;
    const division = cricket.configSchema.parse(cricket.variants.t20) as Record<string, unknown>;
    const dls = SPORT_RULES.cricket!.find((f) => f.key === "dls")!;
    let judged = 0;
    for (const [locale, dict] of LOCALES) {
      const markup = inDictProvider(locale, dict, <StageRuleFields sportKey="cricket" module={cricket} kind={"knockout" as StageKind} variant="t20" values={{}} onChange={() => undefined} disabled={false} divisionConfig={division} resolved={resolvedStageCfg(cricket, division, "knockout", { dls: { enabled: false, edition: "standard" } })} />);
      const reason = dict["stageRules.detail.off"]!.replace("{decider}", dict[dls.labelKey]!);
      expect(markup, `${locale}: the reason names the switch in this language`).toContain(esc(reason));
      expect(markup, `${locale}: ... and not by its English label`).not.toContain(esc(dict["stageRules.detail.off"]!.replace("{decider}", dls.label)));
      judged++;
    }
    expect(judged).toBe(LOCALES.length);
  });

  it("an abandon option the engine will not take is named in the page's language beside its reason", () => {
    const generic = builtinModules.find((m) => m.key === "generic")!;
    const abandon = SPORT_RULES.generic!.find((f) => f.key === "abandon")!;
    const share = abandon.options!.find((o) => o.value === "share")!;
    let judged = 0;
    for (const [locale, dict] of LOCALES) {
      const markup = inDictProvider(locale, dict, <StageRuleFields sportKey="generic" module={generic} kind={"league" as StageKind} variant={null} values={{}} onChange={() => undefined} disabled={false} divisionConfig={{ allowDraws: false }} resolved={null} />);
      const line = markup.slice(markup.indexOf('data-testid="stage-abandon-unavailable-share"'));
      expect(line.slice(0, line.indexOf("</li>")), `${locale}: the unavailable option is named in this language`).toContain(`>${esc(dict[share.labelKey!]!)}: `);
      judged++;
    }
    expect(judged).toBe(LOCALES.length);
  });
});

describe("the division grid draws every field's label, help and options in the page's language (every sport x locale, counted)", () => {
  it("each field of each sport reads from the locale's dictionary and leaves no English behind", () => {
    let sports = 0, fieldsJudged = 0;
    const problems: string[] = [];
    for (const [locale, dict] of LOCALES) {
      for (const sport of Object.keys(SPORT_RULES)) {
        const markup = inDictProvider(locale, dict, <MatchRuleFields sportKey={sport} values={{}} onChange={() => undefined} />);
        sports++;
        for (const f of visibleRuleFields(sport, {}, {})) {
          const { present, absent } = expectations(f, locale, dict);
          for (const text of present) if (!markup.includes(text)) problems.push(`${locale} ${sport} ${f.key}: missing ${text}`);
          for (const text of absent) if (markup.includes(text)) problems.push(`${locale} ${sport} ${f.key}: English left ${text}`);
          fieldsJudged++;
        }
      }
    }
    expect(problems).toEqual([]);
    expect(sports, "premise: every sport was rendered in every locale").toBe(Object.keys(SPORT_RULES).length * LOCALES.length);
    expect(fieldsJudged, "premise: fields were judged").toBeGreaterThan(sports);
  });

  it("best of 1 folds the points pair to ONE field that reads 'Points to win' in the page's language, not the deciding set's label", () => {
    let judged = 0;
    for (const [locale, dict] of LOCALES) {
      for (const sport of ["badminton", "volleyball", "tabletennis", "tennis"]) {
        if (visibleRuleFields(sport, { bestOf: "1" }, {}).every((f) => f.labelKey !== SINGLE_SET_POINTS_LABEL_KEY)) continue;
        const markup = inDictProvider(locale, dict, <MatchRuleFields sportKey={sport} values={{ bestOf: "1" }} onChange={() => undefined} />);
        expect(markup, `${locale} ${sport}`).toContain(`>${esc(dict[SINGLE_SET_POINTS_LABEL_KEY]!)}<`);
        const deciding = SPORT_RULES[sport]!.find((f) => f.key === "finalSetTo");
        if (deciding !== undefined) expect(markup, `${locale} ${sport}: the deciding-set label is gone`).not.toContain(`>${esc(dict[deciding.labelKey]!)}<`);
        judged++;
      }
    }
    expect(judged, "premise: the sets sports fold in every locale").toBeGreaterThan(LOCALES.length);
  });

  it("a saved value the picker cannot offer is shown under the option's text in the page's language (D9: badminton best of 7 is tabletennis's option)", () => {
    const tabletennis = SPORT_RULES.tabletennis!.find((f) => f.key === "bestOf")!;
    const seven = tabletennis.options!.find((o) => o.value === "7")!;
    expect(SPORT_RULES.badminton!.find((f) => f.key === "bestOf")!.options!.some((o) => o.value === "7"), "premise: badminton does not offer 7").toBe(false);
    let judged = 0;
    for (const [locale, dict] of LOCALES) {
      const markup = inDictProvider(locale, dict, <MatchRuleFields sportKey="badminton" values={{ bestOf: "7" }} onChange={() => undefined} />);
      expect(markup, `${locale}: the borrowed option reads in this language`).toContain(`<option value="7" selected="">${esc(dict[seven.labelKey!]!)}</option>`);
      expect(ruleOptionText("badminton", "bestOf", "7", (key) => dict[key]!), locale).toBe(dict[seven.labelKey!]);
      judged++;
    }
    expect(judged).toBe(LOCALES.length);
  });
});

describe("the 'kept' lines of a refused save name each control in the page's language (refusedLines)", () => {
  it("every field of every sport, refused by its key, is named by the locale's label for it (counted)", () => {
    let judged = 0;
    for (const [locale, dict] of LOCALES) {
      const m = (key: string) => dict[key] ?? key;
      for (const sport of Object.keys(SPORT_RULES)) {
        const fields = visibleRuleFields(sport, {}, {});
        for (const f of fields) {
          const refusal: RefusedField = { field: f.key, code: "DIVISION_FORMAT_LOCKED", stageId: "s", stageName: "Pool A" };
          const lines = refusedLines(fields, [refusal], m as never, false);
          expect(lines.map((l) => l.label), `${locale} ${sport}.${f.key}`).toEqual([dict[f.labelKey]]);
          judged++;
        }
      }
      expect(EN["rules.field.dls.label"], "premise: the English label differs from the locale's").not.toBe(dict["rules.field.dls.label"]);
    }
    expect(judged, "premise: lines were judged").toBeGreaterThan(LOCALES.length);
  });
});
