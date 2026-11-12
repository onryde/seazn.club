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
  // Branch review A I2: the address is the form's only fault.
  "quickMatch.errors.emailInvalid",
  // Review m5: the name inputs' `title`, which the browser's own bubble carries for an all-space name.
  "quickMatch.errors.nameBlank",
  "quickMatch.errors.unavailable",
  "quickMatch.errors.generic",
  // The bot check (Cloudflare Turnstile, owner 2026-11-12). A refusal reads #1136's shared `turnstile.error` (review m2), so
  // the quick match carries only its own two lines: the box still to tick (controller ruling 2026-11-12), and the line the
  // server's HTML shows a browser without the script (review m3).
  "quickMatch.setup.tickCheck",
  "quickMatch.setup.needsScript",
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
  "quickMatch.home.result",
  "quickMatch.home.drawn",
  "quickMatch.home.versus",
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
  "quickMatch.flash.generic",
  // Plan 2 Task 8: "Add a match" posted against a knockout (C5: only a league takes an extra match).
  "quickMatch.flash.leagueOnly",
  // Branch review B m3: a create the mail limit spared lands on its home with this line, as information.
  "quickMatch.flash.emailLimited",
  // Branch review A I3 (a saved match's played line, no countdown) and M6 (a settled row's secondary action).
  "quickMatch.home.playedSaved.one",
  "quickMatch.home.playedSaved.other",
  "quickMatch.home.editResult",
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

describe("quick match guest copy: the bot check reads #1136's shared sentence (review m2)", () => {
  it("no locale keeps a quick-match copy of it, and every locale has the shared one (counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      expect(DICTS[locale].marketing["quickMatch.errors.botCheck"], `${locale}: no dead quick-match copy`).toBeUndefined();
      expect(DICTS[locale].ui["turnstile.error"], `${locale}: the shared sentence`).toEqual(expect.stringMatching(/\S/));
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("quick match guest copy: plurals", () => {
  const FAMILIES = [
    ["marketing", "quickMatch.setup.startCount"],
    ["marketing", "quickMatch.setup.sidesCount"],
    ["ui", "quickMatch.home.played"],
    ["ui", "quickMatch.home.playedSaved"],
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

  // The word for "match" in each locale, singular and plural: the translation's own grammar, typed here as the rule,
  // never read back from the dictionary. A `.one`/`.other` pair written the wrong way round still has both keys and
  // still differs, so only the noun that comes back for 1 and for 2 can witness it.
  const MATCH_NOUN: Record<Locale, readonly [one: string, other: string]> = {
    en: ["match", "matches"],
    fr: ["match", "matchs"],
    es: ["partido", "partidos"],
    nl: ["wedstrijd", "wedstrijden"],
  };
  const word = (w: string) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u");

  it("every locale reads its .one for 1 and its .other for 2 through plural(), with the right noun (counted)", () => {
    const NOUN_FAMILIES = FAMILIES.filter(([, key]) => key !== "quickMatch.setup.sidesCount");
    const vars = { max: 6, played: 0, days: 7 };
    let checked = 0;
    for (const locale of LOCALES) {
      const [singular, pluralNoun] = MATCH_NOUN[locale];
      for (const [file, key] of NOUN_FAMILIES) {
        const dict = DICTS[locale][file];
        const atOne = plural(dict, key, 1, locale, vars);
        const atTwo = plural(dict, key, 2, locale, vars);
        // plural() picks the locale's own category: .one at 1, .other at 2 (fr, es and nl as en).
        expect(atOne, `${locale} ${key} at 1 is .one`).toBe(interpolate(dict[`${key}.one`]!, { count: 1, ...vars }));
        expect(atTwo, `${locale} ${key} at 2 is .other`).toBe(interpolate(dict[`${key}.other`]!, { count: 2, ...vars }));
        // ...and .one really is the singular: a swapped pair reds here.
        expect(atOne, `${locale} ${key} at 1 says "${singular}"`).toMatch(word(singular));
        expect(atOne, `${locale} ${key} at 1 never says "${pluralNoun}"`).not.toMatch(word(pluralNoun));
        expect(atTwo, `${locale} ${key} at 2 says "${pluralNoun}"`).toMatch(word(pluralNoun));
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length * NOUN_FAMILIES.length);
  });

  it("a result reads as one sentence with both sides named, in every locale (no verb to agree with a pair)", () => {
    // home.html: "Ravi & Sam beat Priya & Tom". fr, es and nl use a noun phrase ("Victoire de ...", "Empate entre ..."),
    // so a doubles pair as subject never needs a plural verb.
    const ui = DICTS.en.ui;
    expect(interpolate(ui["quickMatch.home.result"]!, { winner: "Ravi & Sam", loser: "Priya & Tom" })).toBe(
      "Ravi & Sam beat Priya & Tom",
    );
    expect(interpolate(ui["quickMatch.home.drawn"]!, { a: "Ravi & Sam", b: "Jo & Max" })).toBe("Ravi & Sam drew with Jo & Max");
    for (const locale of LOCALES) {
      const r = interpolate(DICTS[locale].ui["quickMatch.home.result"] ?? "", { winner: "W", loser: "L" });
      const d = interpolate(DICTS[locale].ui["quickMatch.home.drawn"] ?? "", { a: "A", b: "B" });
      expect(r, locale).toMatch(word("W"));
      expect(r, locale).toMatch(word("L"));
      expect(d, locale).toMatch(word("A"));
      expect(d, locale).toMatch(word("B"));
    }
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
    // A saved match (branch review A I3): the same count, no countdown.
    expect(plural(ui, "quickMatch.home.playedSaved", 6, "en", { played: 2 })).toBe("2 of 6 matches played");
    expect(plural(ui, "quickMatch.home.playedSaved", 1, "en", { played: 0 })).toBe("0 of 1 match played");
    // Branch-fix A review m1 (controller ruling 2026-11-12): neutral. The address may be a friend's, and the cause may be the
    // network's limit or the limiter being down, not that inbox, so the line names no cause and no "you".
    expect(ui["quickMatch.flash.emailLimited"]).toBe("We didn't email the link this time. Share or bookmark this page now.");
    expect(m["quickMatch.errors.emailInvalid"]).toBe("Check the email address, or leave it blank.");
    // Review m5: what the browser's own bubble carries for an all-space name (the input's `title`).
    expect(m["quickMatch.errors.nameBlank"]).toBe("Type a name, not just spaces.");
    // The bot check (2026-11-12): the box still to tick (controller ruling; it names the button as rendered, final review A
    // m-3), and the no-script line (review m3).
    expect(m["quickMatch.setup.tickCheck"]).toBe("Tick the check above, then tap Start playing.");
    expect(m["quickMatch.setup.needsScript"]).toBe("Starting a quick match needs JavaScript.");
    expect(ui["quickMatch.home.editResult"]).toBe("Edit result");
    // Task 1 review I2 and m1 (controller, 2026-11-08): the league line names no tie-break the standings do not use
    // (draws score points, so "most wins" was false), and the two offer refusals name nothing the guest did not choose.
    expect(m["quickMatch.setup.leagueHelp"]).toBe("Everyone plays everyone. Top of the table wins.");
    expect(m["quickMatch.errors.formatNotOffered"]).toBe("That format isn't available for this match.");
    expect(m["quickMatch.errors.sportNotOffered"]).toBe("Those match rules aren't available for quick matches.");
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
