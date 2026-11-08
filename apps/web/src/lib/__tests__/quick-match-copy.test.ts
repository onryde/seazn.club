// Quick match guest copy (plan 2 Task 1; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5, C10; plan 2
// pre-flight amendments 2026-11-08, A1 and B1). Every key a guest screen reads, in all four locales, and the rules the
// copy keeps:
//   - plural pairs: "1 matches" never ships (A11, B1a);
//   - a number that a constant decides is a placeholder, never typed into the copy (B1b);
//   - no internal word on a guest screen (spec §4);
//   - sport and variant names are NOT copied into quickMatch.* (they are the existing `sport.*` / `variant.*` keys).
// Expected strings come from the mockups of record (docs/superpowers/specs/mockups/2026-11-03-quick-match/), and the key
// families that track a declaration (kinds, formats, plays) are derived from the create's own schema, so a new kind or a
// higher plays cap reds here until it has copy.
//
// DB-free on purpose (no DATABASE_URL needed): it reads the dictionary files and pure modules only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { interpolate, plural } from "@/lib/i18n-runtime";
import {
  QUICK_MATCH_ERRORS,
  QUICK_MATCH_MAX_ADHOC,
  QUICK_MATCH_MAX_PLAYS,
} from "@/lib/quick-match-constants";
import { CreateQuickMatch } from "@/server/api-v1/schemas";

type File = "marketing" | "ui";
const load = (locale: Locale, file: File): Record<string, string> =>
  JSON.parse(readFileSync(`src/dictionaries/${locale}/${file}.json`, "utf8")) as Record<string, string>;
const DICTS: Record<Locale, Record<File, Record<string, string>>> = Object.fromEntries(
  LOCALES.map((l) => [l, { marketing: load(l, "marketing"), ui: load(l, "ui") }]),
) as Record<Locale, Record<File, Record<string, string>>>;

// The contract plan 2's later tasks read (T4 setup, T5 home, T6 Score, T7 Share, T8 Add a match, T9 CTA and strip) and
// plan 3 T5's Save button (`quickMatch.home.save`). Kind and format words are derived below, not listed.
const MARKETING_KEYS = [
  "quickMatch.meta.title",
  "quickMatch.meta.description",
  "quickMatch.cta",
  "quickMatch.ctaHint",
  "quickMatch.setup.title",
  "quickMatch.setup.nameLabel",
  "quickMatch.setup.nameHint",
  "quickMatch.setup.suggestedName",
  "quickMatch.setup.sport",
  "quickMatch.setup.sides",
  "quickMatch.setup.sidesCount.one",
  "quickMatch.setup.sidesCount.other",
  "quickMatch.setup.sideLabel",
  "quickMatch.setup.removeSide",
  "quickMatch.setup.addSide",
  "quickMatch.setup.format",
  "quickMatch.setup.leagueHelp",
  "quickMatch.setup.knockoutHelp",
  "quickMatch.setup.knockoutUnavailable",
  "quickMatch.setup.plays",
  "quickMatch.setup.rules",
  "quickMatch.setup.email",
  "quickMatch.setup.emailLabel",
  "quickMatch.setup.start",
  "quickMatch.setup.startCount.one",
  "quickMatch.setup.startCount.other",
  "quickMatch.setup.sitsOut",
  "quickMatch.setup.winnersMeet",
  "quickMatch.recent.title",
  "quickMatch.errors.tooManyAlive",
  "quickMatch.errors.rateLimited",
  "quickMatch.errors.formatNotOffered",
  "quickMatch.errors.sportNotOffered",
  "quickMatch.errors.kindNotOffered",
  "quickMatch.errors.unavailable",
  "quickMatch.errors.generic",
] as const;

const UI_KEYS = [
  "quickMatch.backToMatch",
  "quickMatch.home.title",
  "quickMatch.home.played.one",
  "quickMatch.home.played.other",
  "quickMatch.home.upNext",
  "quickMatch.home.upNextRound",
  "quickMatch.home.live",
  "quickMatch.home.liveMatch",
  "quickMatch.home.liveRound",
  "quickMatch.home.score",
  "quickMatch.home.continue",
  "quickMatch.home.scoreShort",
  "quickMatch.home.waits",
  "quickMatch.home.share",
  "quickMatch.home.shareNative",
  "quickMatch.home.copy",
  "quickMatch.home.copied",
  "quickMatch.home.qrAlt",
  "quickMatch.home.save",
  "quickMatch.home.standings",
  "quickMatch.home.sideCol",
  "quickMatch.home.draw",
  "quickMatch.home.all",
  "quickMatch.home.addMatch",
  "quickMatch.home.anyoneCanScore",
  "quickMatch.home.winner",
  "quickMatch.home.level",
  "quickMatch.home.beat",
  "quickMatch.home.drew",
  "quickMatch.home.versus",
  "quickMatch.home.winnerOf",
  "quickMatch.home.winnerOfSemi",
  "quickMatch.home.winnerOfMatch",
  "quickMatch.home.quarterFinal",
  "quickMatch.home.semiFinal",
  "quickMatch.addMatch.home",
  "quickMatch.addMatch.away",
  "quickMatch.addMatch.submit",
  "quickMatch.flash.linkLimit",
  "quickMatch.flash.adhocLimit",
  "quickMatch.flash.notReady",
  "quickMatch.flash.sameSide",
  "quickMatch.flash.notFound",
  "quickMatch.flash.expired",
  "quickMatch.flash.generic",
  "quickMatch.dead.title",
  "quickMatch.dead.hint",
  "quickMatch.dead.startNew",
] as const;

/** Every `quickMatch.*` key of one file in one locale, sorted. */
const quickKeys = (locale: Locale, file: File): string[] =>
  Object.keys(DICTS[locale][file]).filter((k) => k.startsWith("quickMatch.")).sort();
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

describe("quick match guest copy: every key in all four locales", () => {
  it("each contract key is present and non-blank in en, fr, es and nl (counted)", () => {
    let checked = 0;
    const faults: string[] = [];
    for (const locale of LOCALES) {
      for (const [file, keys] of [["marketing", MARKETING_KEYS], ["ui", UI_KEYS]] as const) {
        for (const key of keys) {
          const v = DICTS[locale][file][key];
          if (typeof v !== "string" || v.trim() === "") faults.push(`${locale}/${file}: ${key}`);
          checked++;
        }
      }
    }
    console.info(`quick match copy: ${checked} locale x key values checked`);
    expect(checked, "anti-vacuity").toBe(LOCALES.length * (MARKETING_KEYS.length + UI_KEYS.length));
    expect(faults).toEqual([]);
  });

  it("kind and format words exist for every kind and format the create accepts, once, in ui.json (counted)", () => {
    // Derived from the create's own schema, never typed: a new kind or format reds here until a guest can read it.
    const kinds = CreateQuickMatch.shape.kind.options;
    const formats = CreateQuickMatch.shape.format.options;
    expect(kinds.length, "anti-vacuity: the schema declares kinds").toBeGreaterThan(0);
    expect(formats.length, "anti-vacuity: the schema declares formats").toBeGreaterThan(0);
    const wanted = [...kinds.map((k) => `quickMatch.kind.${k}`), ...formats.map((f) => `quickMatch.format.${f}`)];
    let checked = 0;
    const faults: string[] = [];
    for (const locale of LOCALES) {
      for (const key of wanted) {
        if (!(DICTS[locale].ui[key] ?? "").trim()) faults.push(`${locale}/ui: ${key}`);
        // "Once, in ui.json" (amendment A1): the home reads them through msgFor, the setup page loads ui as well.
        if (key in DICTS[locale].marketing) faults.push(`${locale}/marketing duplicates ${key}`);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * wanted.length);
    expect(faults).toEqual([]);
  });

  it("'Each pair plays' has one label per plays value the create accepts, and none beyond it", () => {
    expect(QUICK_MATCH_MAX_PLAYS, "anti-vacuity").toBeGreaterThan(0);
    expect(CreateQuickMatch.shape.plays.unwrap().maxValue).toBe(QUICK_MATCH_MAX_PLAYS);
    let checked = 0;
    for (const locale of LOCALES) {
      for (let p = 1; p <= QUICK_MATCH_MAX_PLAYS; p++) {
        expect((DICTS[locale].marketing[`quickMatch.setup.plays.${p}`] ?? "").trim(), `${locale} plays.${p}`).not.toBe("");
        checked++;
      }
      // No label for a value the create refuses (a dead option on the setup screen).
      expect(DICTS[locale].marketing[`quickMatch.setup.plays.${QUICK_MATCH_MAX_PLAYS + 1}`], locale).toBeUndefined();
    }
    expect(checked).toBe(LOCALES.length * QUICK_MATCH_MAX_PLAYS);
  });

  it("every quickMatch.* value carries the same {placeholders} as en, in every locale (counted)", () => {
    let checked = 0;
    const faults: string[] = [];
    for (const file of ["marketing", "ui"] as const) {
      const en = DICTS.en[file];
      for (const key of quickKeys("en", file)) {
        for (const locale of LOCALES) {
          if (locale === "en") continue;
          const want = placeholders(en[key]!);
          const got = placeholders(DICTS[locale][file][key] ?? "");
          if (want.join() !== got.join()) faults.push(`${locale}/${file} ${key}: {${got.join(",")}} vs en {${want.join(",")}}`);
          checked++;
        }
      }
    }
    console.info(`quick match copy: ${checked} placeholder sets compared`);
    expect(checked, "anti-vacuity: the quickMatch.* families were read").toBeGreaterThanOrEqual(
      (LOCALES.length - 1) * (MARKETING_KEYS.length + UI_KEYS.length),
    );
    expect(faults).toEqual([]);
  });
});

describe("quick match guest copy: plurals", () => {
  const FAMILIES = [
    ["marketing", "quickMatch.setup.startCount"],
    ["marketing", "quickMatch.setup.sidesCount"],
    ["ui", "quickMatch.home.played"],
  ] as const;

  it("each plural family has .one and .other in every locale, and the noun changes where the copy has one", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const [file, key] of FAMILIES) {
        const one = DICTS[locale][file][`${key}.one`];
        const other = DICTS[locale][file][`${key}.other`];
        expect(one, `${locale} ${key}.one`).toBeTypeOf("string");
        expect(other, `${locale} ${key}.other`).toBeTypeOf("string");
        // "{count} of {max}" names no noun, so its two forms may match; the other two must differ ("1 matches", A11).
        if (key !== "quickMatch.setup.sidesCount") expect(one, `${locale} ${key}: singular differs`).not.toBe(other);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * FAMILIES.length);
  });

  it("en reads the mockups' copy at 1 and at many, through the real plural()", () => {
    const m = DICTS.en.marketing;
    const ui = DICTS.en.ui;
    // setup.html: "Start playing · 6 matches"; A11: "Start playing · 1 match".
    expect(`${m["quickMatch.setup.start"]} ${plural(m, "quickMatch.setup.startCount", 1, "en")}`).toBe("Start playing · 1 match");
    expect(`${m["quickMatch.setup.start"]} ${plural(m, "quickMatch.setup.startCount", 6, "en")}`).toBe("Start playing · 6 matches");
    // setup.html: "Sides 4 of 6".
    expect(plural(m, "quickMatch.setup.sidesCount", 4, "en", { max: 6 })).toBe("4 of 6");
    // home.html: "2 of 6 matches played · kept 7 days after the last score"; A11: "0 of 1 match played".
    expect(plural(ui, "quickMatch.home.played", 6, "en", { played: 2, days: 7 })).toBe(
      "2 of 6 matches played · kept 7 days after the last score",
    );
    expect(plural(ui, "quickMatch.home.played", 1, "en", { played: 0, days: 7 })).toBe(
      "0 of 1 match played · kept 7 days after the last score",
    );
    // home.html hero lines.
    expect(interpolate(ui["quickMatch.home.upNext"]!, { n: 3, total: 6 })).toBe("Up next · match 3 of 6");
    expect(interpolate(ui["quickMatch.home.liveRound"]!, { round: interpolate(ui["quickMatch.home.semiFinal"]!, { n: 2 }) }))
      .toBe("Live · Semi-final 2");
  });
});

describe("quick match guest copy: constants are placeholders, never typed numbers", () => {
  // B1b: a constant change must move the copy with it. Each value names its placeholder and types no digit at all.
  const CASES = [
    ["marketing", "quickMatch.errors.tooManyAlive", "max"],
    ["ui", "quickMatch.home.played.one", "days"],
    ["ui", "quickMatch.home.played.other", "days"],
    ["ui", "quickMatch.flash.adhocLimit", "max"],
    ["ui", "quickMatch.dead.hint", "days"],
  ] as const;

  it("each constant-bearing value interpolates its constant in every locale (counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const [file, key, ph] of CASES) {
        const v = DICTS[locale][file][key] ?? "";
        expect(v, `${locale} ${key}`).toContain(`{${ph}}`);
        expect(v, `${locale} ${key}: no typed number`).not.toMatch(/\d/);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * CASES.length);
  });

  it("the ad-hoc cap the refusal names is a real constant (D4), and the shared code map carries the plan 2 codes", () => {
    expect(Number.isInteger(QUICK_MATCH_MAX_ADHOC) && QUICK_MATCH_MAX_ADHOC > 0).toBe(true);
    expect(interpolate(DICTS.en.ui["quickMatch.flash.adhocLimit"]!, { max: QUICK_MATCH_MAX_ADHOC })).toContain(
      String(QUICK_MATCH_MAX_ADHOC),
    );
    // The code device-links.ts throws for a waiting knockout seat (pinned by quick-match-device-link.test.ts), and the
    // code plan 2 T8's cap throws: both live in the one import-free map plan 2 maps to copy (amendment A4, D4).
    expect(QUICK_MATCH_ERRORS.SIDES_UNKNOWN).toBe("QUICK_MATCH_SIDES_UNKNOWN");
    expect(QUICK_MATCH_ERRORS.ADHOC_LIMIT).toBe("QUICK_MATCH_ADHOC_LIMIT");
  });
});

describe("quick match guest copy: no internal word, no copied sport name", () => {
  it("no en quickMatch.* value says stage, variant, legs, entrant, fixture or division (spec §4; counted)", () => {
    // en only: these are the product's English identifiers, the words §4 names; fr/es/nl carry the same reviewed copy.
    const INTERNAL = /\b(stages?|variants?|legs?|entrants?|fixtures?|divisions?)\b/i;
    let checked = 0;
    const faults: string[] = [];
    for (const file of ["marketing", "ui"] as const) {
      for (const key of quickKeys("en", file)) {
        if (INTERNAL.test(DICTS.en[file][key]!)) faults.push(`${file} ${key}: ${DICTS.en[file][key]}`);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBeGreaterThanOrEqual(MARKETING_KEYS.length + UI_KEYS.length);
    expect(faults).toEqual([]);
  });

  it("no quickMatch.* value repeats a sport name (they are the existing sport.* keys; counted)", () => {
    const sportNames = new Set(
      Object.entries(DICTS.en.ui)
        .filter(([k]) => /^sport\.[a-z]+$/.test(k))
        .map(([, v]) => v),
    );
    expect(sportNames.size, "anti-vacuity: the sport names were read").toBeGreaterThan(5);
    let checked = 0;
    const faults: string[] = [];
    for (const file of ["marketing", "ui"] as const) {
      for (const key of quickKeys("en", file)) {
        if (sportNames.has(DICTS.en[file][key]!)) faults.push(`${file} ${key}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(faults).toEqual([]);
  });
});
