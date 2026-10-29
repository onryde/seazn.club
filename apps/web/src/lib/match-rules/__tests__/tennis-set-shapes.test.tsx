// W2e Task 29 (owner D18, ruling 157's neighbour; row TN-SS-2) - the tennis "Set type" field after the engine gave a SET its own
// tie-break margin (`set.tiebreakWinBy`, absent = the match's `tiebreak.winBy`).
//
// Where each expected value comes from: the shapes are the ENGINE's variant presets (`tennis.variants[...]`) and its schema; the
// set a variant stores, the margin the kernel plays it by (`set.tiebreakWinBy ?? tiebreak.winBy`, kernel.ts `setTiebreakWinBy`) and
// the option a variant should read back as (Fast4 is Fast4) are the sport's own words. The dictionaries are read off disk.
// Sweeps report how many items they judged and judging none fails them. Single-sport on purpose: it is tennis's field.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { tennis } from "@seazn/engine/sports/tennis";
import { SPORT_RULES, buildRuleOverride, hydrateRuleValues, ruleOptionLabel } from "@/lib/match-rules";
import { TENNIS_SET_SHAPES } from "../tennis.ts";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useMsg: () => (key: string) => (enUi as Record<string, string>)[key] ?? key };
});

import { MatchRuleFields } from "@/components/v2/match-rules";

type Cfg = Record<string, unknown>;
type SetCfg = { gamesTo: number; winBy: number; tiebreakAt: number | null; tiebreakTo: number; tiebreakWinBy?: number };
const variants = tennis.variants as Record<string, Cfg>;
/** A variant's stored config: its preset parsed through the schema (the module's defaults fill the rest). */
const storedFor = (variant: string): Cfg => tennis.configSchema.parse(variants[variant]) as Cfg;
const defaults = (): Cfg => tennis.configSchema.parse({}) as Cfg;
/** The margin the kernel plays a SET's tie-break by: its own, else the match's (kernel.ts `setTiebreakWinBy`). */
const setMargin = (cfg: Cfg): number => ((cfg.set as SetCfg).tiebreakWinBy ?? (cfg.tiebreak as { winBy: number }).winBy);
const fields = Object.fromEntries(SPORT_RULES.tennis!.map((f) => [f.key, f]));

/** What each shipped variant is, in the sport's own words (ITF Rules of Tennis 2026, Appendix VI for the short formats). */
const OPTION_OF_VARIANT: Record<string, string> = {
  tour: "tb6",
  "grand-slam": "tb6",
  fast4: "fast4",
  "doubles-noad-mtb10": "tb6",
  "short-sets": "short4",
};

describe("TN-SS-2 the set type field reads and writes the set's own tie-break margin", () => {
  it("every shipped variant reads back as its own set type, and a Settings save keeps the margin it was played by (counted)", () => {
    const names = Object.keys(variants);
    expect(Object.keys(OPTION_OF_VARIANT).sort(), "the table names exactly the variants the engine declares").toEqual([...names].sort());
    let judged = 0;
    for (const variant of names) {
      const stored = storedFor(variant);
      const values = hydrateRuleValues("tennis", stored);
      expect(values.setType, `${variant}: reads as its set type, not blank`).toBe(OPTION_OF_VARIANT[variant]);
      const built = buildRuleOverride("tennis", { setType: values.setType! }) as { set: SetCfg };
      const after = tennis.configSchema.parse({ ...stored, ...built }) as Cfg;
      expect(setMargin(after), `${variant}: the margin its sets are played by`).toBe(setMargin(stored));
      const was = stored.set as SetCfg;
      const now = after.set as SetCfg;
      expect([now.gamesTo, now.winBy, now.tiebreakAt, now.tiebreakTo], `${variant}: the rest of the set`).toEqual([was.gamesTo, was.winBy, was.tiebreakAt, was.tiebreakTo]);
      judged++;
    }
    expect(judged).toBe(names.length);
    expect(judged).toBeGreaterThanOrEqual(5);
  });

  it("every set shape the field writes names its tie-break margin, so a stage's per-leaf merge cannot keep another set's (counted)", () => {
    let judged = 0;
    for (const [option, shape] of Object.entries(TENNIS_SET_SHAPES)) {
      expect(typeof shape.tiebreakWinBy, `${option}: carries tiebreakWinBy`).toBe("number");
      // And the engine accepts it as a whole (a partial `set` is refused, v8 gotcha).
      expect(tennis.configSchema.safeParse({ ...defaults(), set: shape }).success, `${option}: parses under the module schema`).toBe(true);
      judged++;
    }
    expect(judged).toBeGreaterThanOrEqual(5); // tb6, fast4, short4, advantage and the legacy Fast4 at a margin of two
  });

  it("the two App VI formats are the engine's own presets: Fast4 and short sets play their tie-break to a margin of one", () => {
    expect(TENNIS_SET_SHAPES.fast4).toEqual((variants.fast4!.set as SetCfg));
    expect(TENNIS_SET_SHAPES.short4).toEqual((variants["short-sets"]!.set as SetCfg));
    expect((TENNIS_SET_SHAPES.fast4 as SetCfg).tiebreakWinBy).toBe(1);
    expect((TENNIS_SET_SHAPES.short4 as SetCfg).tiebreakWinBy).toBe(1);
    // The standard sets play to two, as every set tie-break did before W2e.
    expect((TENNIS_SET_SHAPES.tb6 as SetCfg).tiebreakWinBy).toBe(setMargin(defaults()));
    expect((TENNIS_SET_SHAPES.advantage as SetCfg).tiebreakAt).toBeNull();
  });

  it("the picker offers the four formats an organiser can choose, and short sets is one of them", () => {
    const offered = (fields.setType!.options ?? []).map((o) => o.value);
    expect(offered).toEqual(["tb6", "fast4", "short4", "advantage"]);
    // A Fast4 saved before W2e is not a choice (its margin was two); it is shown when it is what is saved, never offered.
    expect(offered).not.toContain("fast4Margin2");
    expect((fields.setType!.legacyOptions ?? []).map((o) => o.value)).toEqual(["fast4Margin2"]);
  });

  it("a Fast4 saved BEFORE W2e (set without a margin, the match's margin two) keeps playing to two: it reads as the legacy shape and writes it back unchanged", () => {
    const old = { set: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 }, tiebreak: { winBy: 2 } };
    const values = hydrateRuleValues("tennis", old);
    expect(values.setType).toBe("fast4Margin2");
    const written = buildRuleOverride("tennis", { setType: values.setType! }) as { set: SetCfg };
    expect(written.set.tiebreakWinBy, "writes the margin it was played by, not the new Fast4's one").toBe(2);
    expect(written.set.tiebreakWinBy).not.toBe((TENNIS_SET_SHAPES.fast4 as SetCfg).tiebreakWinBy);
    // The same Fast4 as the W2e migration stores it (the margin written into the set) reads the same.
    expect(hydrateRuleValues("tennis", { set: { ...old.set, tiebreakWinBy: 2 } }).setType).toBe("fast4Margin2");
    // And the new Fast4 does not read as the legacy one.
    expect(hydrateRuleValues("tennis", { set: { ...old.set, tiebreakWinBy: 1 } }).setType).toBe("fast4");
  });

  it("the legacy shape has a label of its own, distinct from Fast4's, and it says the margin", () => {
    const legacy = ruleOptionLabel("tennis", "setType", "fast4Margin2");
    const fast4 = ruleOptionLabel("tennis", "setType", "fast4");
    expect(legacy).toBeDefined();
    expect(legacy).not.toBe(fast4);
    expect(legacy).toMatch(/two/i);
  });

  it("the control shows a saved legacy Fast4 as itself - not 'Default' - and does not offer it beside the real choices", () => {
    const html = renderToStaticMarkup(<MatchRuleFields sportKey="tennis" values={{ setType: "fast4Margin2" }} onChange={() => {}} />);
    const label = ruleOptionLabel("tennis", "setType", "fast4Margin2")!;
    expect(html).toContain(`<option value="fast4Margin2"`);
    expect(html).toContain(label);
    // Offered: not there when the saved value is something else.
    const other = renderToStaticMarkup(<MatchRuleFields sportKey="tennis" values={{ setType: "tb6" }} onChange={() => {}} />);
    expect(other).not.toContain("fast4Margin2");
  });

  it("a set the field cannot name reads blank and is never rewritten (a sudden-death standard set, a set with an extra key)", () => {
    const suddenDeath = { set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 }, tiebreak: { winBy: 1 } };
    expect(hydrateRuleValues("tennis", suddenDeath).setType, "tb6 played to a margin of one is no option").toBeUndefined();
    expect(hydrateRuleValues("tennis", { set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7, tiebreakWinBy: 1 } }).setType).toBeUndefined();
    expect(hydrateRuleValues("tennis", { set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7, serveOrder: "alt" } }).setType).toBeUndefined();
    // A set with no tie-break has no margin to disagree about: advantage reads as advantage whatever the match's one says.
    expect(hydrateRuleValues("tennis", { set: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 }, tiebreak: { winBy: 1 } }).setType).toBe("advantage");
  });

  it("a stage fragment that carries a set but no margin reads against the division it inherits from", () => {
    const fragment = { set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 } };
    expect(hydrateRuleValues("tennis", fragment, { tiebreak: { winBy: 2 } }).setType).toBe("tb6");
    expect(hydrateRuleValues("tennis", fragment, { tiebreak: { winBy: 1 } }).setType).toBeUndefined();
    expect(hydrateRuleValues("tennis", fragment).setType, "nothing to inherit from: the standard margin").toBe("tb6");
    // A fragment with no set at all reads blank - the absence still means INHERIT.
    expect(hydrateRuleValues("tennis", {}, { set: fragment.set }).setType).toBeUndefined();
  });
});

describe("the tie-break margin field says it is the MATCH tie-break's", () => {
  const field = fields.tiebreakWinBy!;

  it("names the match tie-break in its label, in the dictionary of every locale (the English text is the fallback)", () => {
    expect(field.label).toMatch(/match tie-?break/i);
    expect(field.labelKey, "drawn from the dictionary").toBeDefined();
    expect(field.helpKey).toBeDefined();
    const en = enUi as Record<string, string>;
    expect(en[field.labelKey!], "the English dictionary value is the label").toBe(field.label);
    for (const [name, dict] of [["es", esUi], ["fr", frUi], ["nl", nlUi]] as const) {
      const d = dict as Record<string, string>;
      expect(typeof d[field.labelKey!], `${name} label`).toBe("string");
      expect(d[field.labelKey!], `${name} label is translated`).not.toBe(en[field.labelKey!]);
      expect(typeof d[field.helpKey!], `${name} help`).toBe("string");
      expect(d[field.helpKey!], `${name} help is translated`).not.toBe(en[field.helpKey!]);
    }
  });

  it("still edits the match's tiebreak.winBy and nothing of a set", () => {
    expect(field.edits).toEqual(["tiebreak.winBy"]);
    expect(buildRuleOverride("tennis", { tiebreakWinBy: "1" })).toEqual({ tiebreak: { winBy: 1 } });
  });
});
