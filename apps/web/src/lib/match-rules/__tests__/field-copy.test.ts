// W2e Task 33a (carry: "every rule label reads in the viewer's language") - every curated rule field of EVERY sport names the
// dictionary keys that localize its label, its help and its options, and the four dictionaries carry them.
//
// Before this, only the eight fields W2e Task 28 added were keyed; the other ~60 rendered the English table text in every locale
// (the stage editor, the division grid, the "kept" lines of a refused save, the "held while ... is off" reason). The type now
// REQUIRES `labelKey`, so a new field cannot ship without one; this test is the other half: that the key it names exists in all
// four languages, says what the English `label` says, and is a translation rather than a copy.
//
// Where each expected value comes from: the English text is the field's own `label`/`help` (the table's canonical English, which
// is what the English dictionary value must equal); what counts as "translated" is "not the English sentence", with the few
// proper nouns that legitimately read the same in a language named below and checked to BE the same (so a stale exemption fails).
// Sweeps the whole sport registry; every sweep reports how many items it judged and judging none fails it.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { SPORT_RULES, SINGLE_SET_POINTS_LABEL, SINGLE_SET_POINTS_LABEL_KEY, visibleRuleFields, type RuleField } from "@/lib/match-rules";
import { ABANDON_LABELS, ABANDON_LABEL_KEYS } from "@/lib/match-rules/shared";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

const DICTS = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as unknown as Record<string, Record<string, string>>;
const OTHERS = ["es", "fr", "nl"] as const;

/** Copy that is the same word in a language, as the game itself is called there: chess's clock family and its last-resort game
 *  keep their international names, and Dutch cricket says "overs" and "innings" as they are. Each pair is asserted to be
 *  identical to English (see the last test). */
const SAME_AS_ENGLISH: ReadonlyArray<readonly [locale: string, key: string]> = [
  ["es", "rules.field.variant.option.blitz"],
  ["fr", "rules.field.variant.option.blitz"],
  ["nl", "rules.field.variant.option.blitz"],
  ["nl", "rules.field.variant.option.rapid"],
  ["fr", "rules.field.tiebreakRungs.option.armageddon"],
  ["nl", "rules.field.tiebreakRungs.option.armageddon"],
  ["nl", "rules.field.overs.label"],
];
const sameAsEnglish = (locale: string, key: string): boolean => SAME_AS_ENGLISH.some(([l, k]) => l === locale && k === key);

interface Item { where: string; key: string; english: string }

/** Every localizable string of the table: each field's label and help and each of its options (the legacy ones too), with the
 *  dictionary key it names and the English text that key must carry. `missing` is what names no key. */
function itemsOf(): { items: Item[]; missing: string[]; fields: number; options: number; helps: number } {
  const items: Item[] = [];
  const missing: string[] = [];
  let fields = 0, options = 0, helps = 0;
  for (const [sport, list] of Object.entries(SPORT_RULES)) {
    for (const f of list as RuleField[]) {
      const at = `${sport}.${f.key}`;
      fields++;
      if (typeof f.labelKey !== "string") missing.push(`${at} label`);
      else items.push({ where: `${at} label`, key: f.labelKey, english: f.label });
      if (f.help !== undefined || f.helpKey !== undefined) {
        helps++;
        if (f.help === undefined || typeof f.helpKey !== "string") missing.push(`${at} help`);
        else items.push({ where: `${at} help`, key: f.helpKey, english: f.help });
      }
      for (const o of [...(f.options ?? []), ...(f.legacyOptions ?? [])]) {
        options++;
        if (typeof o.labelKey !== "string") missing.push(`${at} option ${o.value}`);
        else items.push({ where: `${at} option ${o.value}`, key: o.labelKey, english: o.label });
      }
    }
  }
  return { items, missing, fields, options, helps };
}

describe("every rule field of every sport is localized (W2e T33a)", () => {
  const swept = itemsOf();

  it("the sweep reaches the whole registry: every sport's table, every field, help and option is judged (counted)", () => {
    expect(Object.keys(SPORT_RULES).length, "premise: the registry has sports").toBeGreaterThan(0);
    // The table's sports are the engine's own modules (the generic prototype included): none is skipped by this sweep.
    for (const m of builtinModules) expect(SPORT_RULES[m.key], `${m.key} has a rule table`).toBeDefined();
    expect(swept.fields, "premise: fields were found").toBeGreaterThan(0);
    expect(swept.options, "premise: options were found").toBeGreaterThan(0);
    expect(swept.helps, "premise: helps were found").toBeGreaterThan(0);
    expect(swept.items.length, "every label, help and option became one item").toBe(swept.fields + swept.helps + swept.options);
  });

  it("no field, help or option is left without a dictionary key (the English-in-every-language defect, listed)", () => {
    expect(swept.missing).toEqual([]);
  });

  it("the English dictionary value is the table's own text for every key a field or option names, so the fallback and the key cannot drift (counted)", () => {
    let judged = 0;
    for (const item of swept.items) {
      expect(DICTS.en![item.key], `en ${item.key} (${item.where})`).toBe(item.english);
      judged++;
    }
    expect(judged).toBe(swept.items.length);
  });

  it("es, fr and nl each carry every key, non-blank, and a translation rather than the English sentence (counted, per locale)", () => {
    for (const locale of OTHERS) {
      let judged = 0;
      const copied: string[] = [];
      for (const item of swept.items) {
        const text = DICTS[locale]![item.key];
        expect(text, `${locale} ${item.key} (${item.where})`).toBeTypeOf("string");
        expect(text!.trim().length, `${locale} ${item.key} is not blank`).toBeGreaterThan(0);
        if (!sameAsEnglish(locale, item.key) && text === item.english) copied.push(`${item.key} (${item.where})`);
        judged++;
      }
      expect(copied, `${locale}: English copy left in place`).toEqual([]);
      expect(judged, locale).toBe(swept.items.length);
    }
  });

  it("two fields share a key only when they say the same thing: every key's English is one sentence (counted)", () => {
    const byKey = new Map<string, Set<string>>();
    for (const item of swept.items) byKey.set(item.key, (byKey.get(item.key) ?? new Set()).add(item.english));
    let shared = 0;
    for (const [key, texts] of byKey) {
      expect([...texts], `${key} names two different English texts`).toHaveLength(1);
      if (swept.items.filter((i) => i.key === key).length > 1) shared++;
    }
    expect(byKey.size, "premise: keys were found").toBeGreaterThan(0);
    expect(shared, "premise: some keys are shared (the labels the sports have in common)").toBeGreaterThan(0);
  });

  it("no rules.field.* entry of the dictionary is orphaned: every one is named by a field, an option, or the best-of-1 relabel (counted)", () => {
    const named = new Set<string>([...swept.items.map((i) => i.key), SINGLE_SET_POINTS_LABEL_KEY]);
    const inDictionary = Object.keys(DICTS.en!).filter((k) => k.startsWith("rules.field."));
    expect(inDictionary.length, "premise: the dictionary carries rule field copy").toBeGreaterThan(0);
    expect(inDictionary.filter((k) => !named.has(k)), "dictionary keys no field names").toEqual([]);
    for (const locale of OTHERS) expect(Object.keys(DICTS[locale]!).filter((k) => k.startsWith("rules.field.")).sort(), locale).toEqual([...inDictionary].sort());
  });

  it("the best-of-1 field keeps its relabel in the viewer's language: the copy names the new text's key, not finalSetTo's (every sport that folds, counted)", () => {
    let judged = 0;
    for (const sport of Object.keys(SPORT_RULES)) {
      const folded = visibleRuleFields(sport, { bestOf: "1" }).find((f) => f.label === SINGLE_SET_POINTS_LABEL);
      if (folded === undefined) continue;
      expect(folded.labelKey, `${sport}: the relabelled copy names the Points-to-win key`).toBe(SINGLE_SET_POINTS_LABEL_KEY);
      expect(DICTS.en![SINGLE_SET_POINTS_LABEL_KEY]).toBe(SINGLE_SET_POINTS_LABEL);
      for (const locale of OTHERS) expect(DICTS[locale]![SINGLE_SET_POINTS_LABEL_KEY], `${sport} ${locale}`).not.toBe(SINGLE_SET_POINTS_LABEL);
      judged++;
    }
    expect(judged, "premise: the sets-based sports fold").toBeGreaterThan(0);
    // ... and the sports that do not fold keep their own label on best of 1.
    expect(visibleRuleFields("football", { bestOf: "1" }).map((f) => f.labelKey)).toEqual(SPORT_RULES.football!.map((f) => f.labelKey));
  });

  it("every abandon policy the engine names has an English label AND a key, the same set (counted)", () => {
    expect(Object.keys(ABANDON_LABEL_KEYS).sort()).toEqual(Object.keys(ABANDON_LABELS).sort());
    let judged = 0;
    for (const [policy, english] of Object.entries(ABANDON_LABELS)) {
      expect(DICTS.en![ABANDON_LABEL_KEYS[policy]!], policy).toBe(english);
      judged++;
    }
    // Every policy a module offers is labelled, through the same table (a module offering one the table lacks throws at load).
    const offered = new Set(builtinModules.flatMap((m) => m.abandonOptions ?? []));
    expect(offered.size, "premise: modules offer abandon policies").toBeGreaterThan(0);
    for (const policy of offered) expect(Object.hasOwn(ABANDON_LABELS, policy), `policy ${policy}`).toBe(true);
    expect(judged).toBe(Object.keys(ABANDON_LABELS).length);
  });

  it("the sentences that QUOTE a label quote the label in that language: the 'share the points' refusals name the controls the organiser sees", () => {
    const carrom = SPORT_RULES.carrom!;
    const generic = SPORT_RULES.generic!;
    const allowDraws = generic.find((f) => f.key === "allowDraws")!;
    const tieBoard = carrom.find((f) => f.key === "tieBoard")!;
    const drawn = tieBoard.options!.find((o) => o.value === "draw")!;
    // The option's label is "Drawn game (house rule; ...)": the sentence names the part before the bracket.
    const head = (text: string): string => text.split(" (")[0]!;
    let judged = 0;
    for (const locale of ["en", ...OTHERS]) {
      const d = DICTS[locale]!;
      expect(d["rules.err.shareNeedsDraws"], `${locale} names Allow draws`).toContain(d[allowDraws.labelKey]!);
      expect(d["rules.err.shareNeedsDrawnGame"], `${locale} names the tied-game control`).toContain(d[tieBoard.labelKey]!);
      expect(d["rules.err.shareNeedsDrawnGame"], `${locale} names its drawn-game choice`).toContain(head(d[drawn.labelKey!]!));
      judged++;
    }
    expect(judged).toBe(4);
  });

  // W2e PR B (copy): this pin used to demand the OPPOSITE - that the floor's help quote the DLS switch by its label - and it
  // did, which is how a stage with DLS off read "Only used while DLS revised targets is on" in the help and "Only used when DLS
  // revised targets is on" in the held reason beneath it. The reason is now the one sentence that names the switch (built from
  // the switch's label in the viewer's language: `rule-field-copy-render.test.tsx`, "the reason a detail is held names the switch
  // in the page's language"); the help says what the field does (`stage-rule-fields.test.tsx`, "a held cricket detail says WHY once").
  it("the result floor's help does not quote the DLS switch: the held reason is the one place that names it, in every language", () => {
    const cricket = SPORT_RULES.cricket!;
    const dls = cricket.find((f) => f.key === "dls")!;
    const floor = cricket.find((f) => f.key === "minOversForResult")!;
    let judged = 0;
    for (const locale of ["en", ...OTHERS]) {
      const d = DICTS[locale]!;
      expect(d[dls.labelKey], `${locale}: the switch has a label to name`).toBeTruthy();
      expect(d[floor.helpKey!]!.toLowerCase(), `${locale}: the floor's help leaves the switch's name to the held reason`).not.toContain(d[dls.labelKey]!.toLowerCase());
      expect(d["stageRules.detail.off"], `${locale}: the reason names the switch through {decider}`).toContain("{decider}");
      judged++;
    }
    expect(judged).toBe(4);
  });

  it("every same-as-English exemption IS the English text (a stale exemption fails), and each key is one the table names", () => {
    const named = new Set(swept.items.map((i) => i.key));
    expect(SAME_AS_ENGLISH.length).toBeGreaterThan(0);
    for (const [locale, key] of SAME_AS_ENGLISH) {
      expect(named.has(key), `${key} is a field/option key`).toBe(true);
      expect(DICTS[locale]![key], `${locale} ${key} reads like English`).toBe(DICTS.en![key]);
    }
  });
});
