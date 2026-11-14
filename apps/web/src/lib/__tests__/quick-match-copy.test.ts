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
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MAX_ADHOC,
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_QUALIFIERS,
  QUICK_MATCH_SEMIS_MIN_SIDES,
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
  "quickMatch.setup.plays",
  "quickMatch.setup.rules",
  "quickMatch.setup.email",
  "quickMatch.setup.emailLabel",
  "quickMatch.setup.start",
  "quickMatch.setup.startCount.one",
  "quickMatch.setup.startCount.other",
  "quickMatch.recent.title",
  // Owner 2026-11-12: the setup page's Continue card and the heading over the form beneath it (its count line is the home's
  // own `quickMatch.home.playedSaved`, so the card never says a different "played" from the match's home).
  "quickMatch.continue.action",
  "quickMatch.continue.startNew",
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
  // Owner 2026-11-12: the line above Start that says an unsaved quick match is deleted, and when.
  "quickMatch.setup.keepNote",
  // Plan 5 (League + Knockout, spec 2026-11-12 §2, §12; mockup qmd13a01 §6): the three-choice format list, the semi-finals'
  // minimum, and its refusal. Setup copy lives here because the setup island reads `quickMatch.setup.` / `.errors.` from
  // marketing (play/setup-props.ts).
  "quickMatch.setup.format",
  "quickMatch.setup.shape.league",
  "quickMatch.setup.shape.leagueHint",
  "quickMatch.setup.shape.final",
  "quickMatch.setup.shape.finalHint",
  "quickMatch.setup.shape.semis",
  "quickMatch.setup.shape.semisHint",
  "quickMatch.setup.shape.semisNeeds",
  "quickMatch.errors.semisTooFewSides",
  // Owner 2026-11-14: every row is always listed; League → Final below three sides, and both knockout rows on rules that may
  // never play one, are disabled with their own reason.
  "quickMatch.setup.shape.finalNeeds",
  "quickMatch.setup.shape.notForSport",
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
  // Owner 2026-11-12: under Save, while nobody has saved the match, the day it is deleted.
  "quickMatch.home.notSaved",
  "quickMatch.dead.title",
  "quickMatch.dead.hint",
  "quickMatch.dead.startNew",
  // Plan 4 (skip one league match, spec 2026-11-12 §3, §6): the row's ⋯ menu (owner 2026-11-13: one menu per row, named by
  // its sides; Edit result moves into it), the confirm sheet, the Not played row and counts, the league finished by skips
  // and with no match played, the refusals, and the stale-screen line (T1 review G1) on the home and the pad.
  "quickMatch.home.moreActions",
  "quickMatch.home.notPlayed",
  "quickMatch.home.notPlayedHint",
  "quickMatch.home.putBack",
  "quickMatch.home.notPlayedPart.one",
  "quickMatch.home.notPlayedPart.other",
  "quickMatch.home.playedSkipped.one",
  "quickMatch.home.playedSkipped.other",
  "quickMatch.home.playedSkippedSaved.one",
  "quickMatch.home.playedSkippedSaved.other",
  "quickMatch.home.countsPlayedOnly",
  "quickMatch.home.finalTable",
  "quickMatch.home.winnerAfter.one",
  "quickMatch.home.winnerAfter.other",
  "quickMatch.home.winnerSkipped.one",
  "quickMatch.home.winnerSkipped.other",
  "quickMatch.home.leagueFinished",
  "quickMatch.home.noPlay",
  "quickMatch.home.noPlayHint.one",
  "quickMatch.home.noPlayHint.other",
  "quickMatch.skip.title",
  "quickMatch.skip.body",
  "quickMatch.skip.bodyLast",
  "quickMatch.skip.partial",
  // FR4 m1: a live match with nothing scored yet (only Started) says so, and quotes no score.
  "quickMatch.skip.started",
  "quickMatch.skip.confirm",
  "quickMatch.skip.keep",
  "quickMatch.flash.notSkippable",
  "quickMatch.flash.leagueFinished",
  "quickMatch.flash.notPlayed",
  "device.quickMatch.notPlayed",
  // FR3 (T5 finding 1): the guest pad's Not played screen reads the match again on tap.
  "device.quickMatch.checkAgain",
  // FR4 m2: the same screen once the league has finished: no Put back can come, so no hint.
  "device.quickMatch.notPlayedFinal",
  // Plan 5 (League + Knockout, spec §5, §6, §11, §12; mockup qmd13a01 §7-12): the played line's two parts, the standings
  // caption and markers, the knockout card and its seats, the setting-up and champion cards, the tie question and its two
  // answers, and the four refusals. The format word and the seat ranks are derived below, not listed.
  "quickMatch.home.stagePart.split",
  "quickMatch.home.stagePart.knockoutOn",
  "quickMatch.home.goThrough",
  "quickMatch.home.wentThrough",
  "quickMatch.home.knockout",
  "quickMatch.home.knockoutFills",
  "quickMatch.home.knockoutWaiting",
  "quickMatch.home.toDecide",
  "quickMatch.home.byLotShort",
  "quickMatch.home.byLot",
  "quickMatch.home.picked",
  "quickMatch.home.levelToDecide",
  "quickMatch.home.leagueMatches",
  "quickMatch.home.finalLeagueTable",
  "quickMatch.home.settingUp",
  "quickMatch.home.settingUpHint",
  "quickMatch.home.refresh",
  "quickMatch.home.champion",
  "quickMatch.home.championBeat",
  "quickMatch.home.championTopToo",
  "quickMatch.cut.kicker.one",
  "quickMatch.cut.kicker.other",
  "quickMatch.cut.title",
  "quickMatch.cut.titleMany.one",
  "quickMatch.cut.titleMany.other",
  "quickMatch.cut.body",
  "quickMatch.cut.pick",
  "quickMatch.cut.toss",
  "quickMatch.cut.back",
  "quickMatch.cut.pickQuestion.one",
  "quickMatch.cut.pickQuestion.other",
  "quickMatch.cut.send",
  "quickMatch.cut.tossResult",
  "quickMatch.cut.tossBody",
  "quickMatch.cut.pickResult",
  "quickMatch.flash.alreadyDecided",
  "quickMatch.flash.tieChanged",
  "quickMatch.flash.pickInvalid",
  "quickMatch.flash.leagueComplete",
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
    // Plan 4: the Not played counts, the winner's note and the no-play hint.
    ["ui", "quickMatch.home.notPlayedPart"],
    ["ui", "quickMatch.home.playedSkipped"],
    ["ui", "quickMatch.home.playedSkippedSaved"],
    ["ui", "quickMatch.home.winnerAfter"],
    ["ui", "quickMatch.home.winnerSkipped"],
    ["ui", "quickMatch.home.noPlayHint"],
  ] as const;
  /** Families that name no noun, so their two forms may read the same: "{count} of {max}", and "{count} not played" (en and
   *  nl; fr and es agree the participle, which the participle check below witnesses). */
  const NOUNLESS: ReadonlySet<string> = new Set(["quickMatch.setup.sidesCount", "quickMatch.home.notPlayedPart"]);

  it("each plural family has .one and .other in every locale, and the noun changes where the copy has one", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const [file, key] of FAMILIES) {
        const one = DICTS[locale][file][`${key}.one`];
        const other = DICTS[locale][file][`${key}.other`];
        expect(one, `${locale} ${key}.one`).toBeTypeOf("string");
        expect(other, `${locale} ${key}.other`).toBeTypeOf("string");
        // A family with no noun may match; every other must differ ("1 matches", A11).
        if (!NOUNLESS.has(key)) expect(one, `${locale} ${key}: singular differs`).not.toBe(other);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * FAMILIES.length);
  });

  // T1 review M1: plural() fills only {count}. A family whose number rode another name ({n}, {played}) printed the raw
  // placeholder when called the natural way, `plural(dict, key, n, locale)`; T4's own test would have mirrored it.
  const COUNTED = [
    "quickMatch.home.notPlayedPart",
    "quickMatch.home.winnerAfter",
    "quickMatch.home.winnerSkipped",
    "quickMatch.home.noPlayHint",
  ] as const;

  it("the Not played, winner and no-play counts read their number from plural() alone, in every locale (counted)", () => {
    let checked = 0;
    const faults: string[] = [];
    for (const locale of LOCALES) {
      const ui = DICTS[locale].ui;
      for (const key of COUNTED) {
        for (const form of ["one", "other"]) {
          const extra = placeholders(ui[`${key}.${form}`] ?? "").filter((p) => p !== "count");
          if (extra.length) faults.push(`${locale} ${key}.${form}: {${extra.join(",")}} besides {count}`);
        }
        for (const n of [1, 2, 5]) {
          const out = plural(ui, key, n, locale);
          if (/\{\w+\}/.test(out)) faults.push(`${locale} ${key} at ${n}: ${out}`);
          // The .other forms always print the number; the no-play hint's .one says "the only match" instead.
          if (n > 1 && !out.includes(String(n))) faults.push(`${locale} ${key} at ${n} omits ${n}: ${out}`);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length * COUNTED.length * 3);
    expect(faults).toEqual([]);
  });

  // "Not played" agrees with "match" in fr and es; en and nl do not inflect it. The grammar, typed here as the rule.
  const PARTICIPLE: Record<Locale, readonly [one: string, other: string]> = {
    en: ["played", "played"],
    fr: ["joué", "joués"],
    es: ["jugado", "jugados"],
    nl: ["gespeeld", "gespeeld"],
  };

  it("'N not played' agrees in every locale: .one at 1, .other at 2 (counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const [one, many] = PARTICIPLE[locale];
      const ui = DICTS[locale].ui;
      const atOne = plural(ui, "quickMatch.home.notPlayedPart", 1, locale);
      const atTwo = plural(ui, "quickMatch.home.notPlayedPart", 2, locale);
      expect(atOne, `${locale} at 1`).toMatch(new RegExp(`(^|[^\\p{L}])${one}([^\\p{L}]|$)`, "u"));
      expect(atTwo, `${locale} at 2`).toMatch(new RegExp(`(^|[^\\p{L}])${many}([^\\p{L}]|$)`, "u"));
      if (one !== many) expect(atOne, `${locale} at 1 never says "${many}"`).not.toMatch(new RegExp(`(^|[^\\p{L}])${many}([^\\p{L}]|$)`, "u"));
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the stale-screen line (T1 review G1) reads the same on the home and on the pad, in every locale (counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const ui = DICTS[locale].ui;
      expect(ui["device.quickMatch.notPlayed"], locale).toEqual(expect.stringMatching(/\S/));
      expect(ui["device.quickMatch.notPlayed"], locale).toBe(ui["quickMatch.flash.notPlayed"]);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("FR4: the finished league's pad line and the started sheet line are their own words in every locale (counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const ui = DICTS[locale].ui;
      // Not the open league's line, which says how to put the match back: on a finished league that hint is false.
      expect(ui["device.quickMatch.notPlayedFinal"], locale).not.toBe(ui["device.quickMatch.notPlayed"]);
      // Not the partial line: a match only Started has no score to quote, so the line takes none.
      expect(ui["quickMatch.skip.started"], locale).not.toBe(ui["quickMatch.skip.partial"]);
      expect(placeholders(ui["quickMatch.skip.started"]!), locale).toEqual([]);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
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
    const NOUN_FAMILIES = FAMILIES.filter(([, key]) => !NOUNLESS.has(key));
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
    // home.html's count; owner 2026-11-12: an unsaved match says plainly that it is DELETED, and that saving it stops that
    // (it read "kept 7 days after the last score", which a guest took for a promise, not a deletion).
    expect(plural(ui, "quickMatch.home.played", 6, "en", { played: 2, days: 7 })).toBe(
      "2 of 6 matches played · deleted 7 days after the last score unless saved",
    );
    expect(plural(ui, "quickMatch.home.played", 1, "en", { played: 0, days: 7 })).toBe(
      "0 of 1 match played · deleted 7 days after the last score unless saved",
    );
    // Owner 2026-11-12, the owner's words: the setup line above Start, and the dated line under Save.
    expect(interpolate(m["quickMatch.setup.keepNote"]!, { days: 7 })).toBe(
      "No account needed. Deleted 7 days after the last score unless you save it.",
    );
    expect(interpolate(ui["quickMatch.home.notSaved"]!, { date: "19 November 2026" })).toBe(
      "Not saved — deleted on 19 November 2026",
    );
    // Owner 2026-11-12: the setup page's Continue card and the heading over the form.
    expect(m["quickMatch.continue.action"]).toBe("Continue");
    expect(m["quickMatch.continue.startNew"]).toBe("Or start a new quick match");
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
    // Plan 5 T6 review m1 (controller, 2026-11-13): that line is now the plain League row's hint, so the row still says who
    // wins. Each locale keeps its own existing sentence (typed here: the translations of record); the standalone line's key
    // is gone from every locale.
    const LEAGUE_HINT: Record<Locale, string> = {
      en: "Everyone plays everyone. Top of the table wins.",
      fr: "Tout le monde affronte tout le monde. Le premier du classement gagne.",
      es: "Todos juegan contra todos. Gana quien acabe primero en la tabla.",
      nl: "Iedereen speelt tegen iedereen. Wie bovenaan eindigt, wint.",
    };
    let hints = 0;
    for (const locale of LOCALES) {
      expect(DICTS[locale].marketing["quickMatch.setup.shape.leagueHint"], locale).toBe(LEAGUE_HINT[locale]);
      expect(DICTS[locale].marketing["quickMatch.setup.leagueHelp"], `${locale} quickMatch.setup.leagueHelp`).toBeUndefined();
      hints++;
    }
    expect(hints, "anti-vacuity: every locale").toBe(4);
    // Owner 2026-11-12 ("take out"): League only for now. The setup's knockout lines are gone from every locale, and the
    // page's description no longer promises one. Plan 5 (owner 2026-11-13, mockup qmd13a01 §6 FINAL) brings the "Format"
    // label back over its three-row list (`quickMatch.setup.shape.*`); the plain knockout's own lines stay gone.
    for (const locale of LOCALES) {
      for (const gone of ["knockoutHelp", "knockoutUnavailable", "sitsOut", "winnersMeet"]) {
        expect(DICTS[locale].marketing[`quickMatch.setup.${gone}`], `${locale} quickMatch.setup.${gone}`).toBeUndefined();
      }
    }
    expect(m["quickMatch.meta.description"]).toBe("Set up a small league in seconds, share one link, and keep score from any phone. No account needed.");
    expect(m["quickMatch.errors.formatNotOffered"]).toBe("That format isn't available for this match.");
    expect(m["quickMatch.errors.sportNotOffered"]).toBe("Those match rules aren't available for quick matches.");
    // home.html hero lines.
    expect(interpolate(ui["quickMatch.home.upNext"]!, { n: 3, total: 6 })).toBe("Up next · match 3 of 6");
    expect(interpolate(ui["quickMatch.home.liveRound"]!, { round: interpolate(ui["quickMatch.home.semiFinal"]!, { n: 2 }) }))
      .toBe("Live · Semi-final 2");
  });

  it("en reads plan 4's copy (skip one league match) through the real plural(), each count from plural() alone", () => {
    const ui = DICTS.en.ui;
    // The played line with skips (spec §6: "N of M played · K not played", M the full total). Plan 4's key table keeps the
    // unsaved countdown on it (the owner's 11-12 rule that the purge is stated), where mockup frames 4-5 say "league finished".
    const skipped = (k: number) => plural(ui, "quickMatch.home.notPlayedPart", k, "en");
    expect(plural(ui, "quickMatch.home.playedSkipped", 6, "en", { played: 4, days: 7, skipped: skipped(2) })).toBe(
      "4 of 6 matches played · 2 not played · deleted 7 days after the last score unless saved",
    );
    expect(plural(ui, "quickMatch.home.playedSkipped", 1, "en", { played: 0, days: 7, skipped: skipped(1) })).toBe(
      "0 of 1 match played · 1 not played · deleted 7 days after the last score unless saved",
    );
    expect(plural(ui, "quickMatch.home.playedSkippedSaved", 6, "en", { played: 4, skipped: skipped(2) })).toBe(
      "4 of 6 matches played · 2 not played",
    );
    // The winner's note under a league finished by skips, and the no-play card's hint.
    expect(`${plural(ui, "quickMatch.home.winnerAfter", 2, "en")} ${plural(ui, "quickMatch.home.winnerSkipped", 1, "en")}`).toBe(
      "Top of the table after 2 played matches. 1 match was not played.",
    );
    expect(`${plural(ui, "quickMatch.home.winnerAfter", 1, "en")} ${plural(ui, "quickMatch.home.winnerSkipped", 3, "en")}`).toBe(
      "Top of the table after 1 played match. 3 matches were not played.",
    );
    expect(plural(ui, "quickMatch.home.noPlayHint", 1, "en")).toBe("The only match was marked Not played, so there is no winner.");
    expect(plural(ui, "quickMatch.home.noPlayHint", 3, "en")).toBe("All 3 matches were marked Not played, so there is no winner.");
    // The row's ⋯ menu, named by its sides (owner 2026-11-13), and the confirm sheet (mockup qmd13a01 frame 2; D6).
    expect(interpolate(ui["quickMatch.home.moreActions"]!, { home: "Ravi & Sam", away: "Priya & Tom" })).toBe(
      "More actions for Ravi & Sam v Priya & Tom",
    );
    expect(interpolate(ui["quickMatch.skip.title"]!, { home: "Ravi & Sam", away: "Priya & Tom" })).toBe(
      "Skip Ravi & Sam v Priya & Tom?",
    );
    expect(interpolate(ui["quickMatch.skip.partial"]!, { score: "8–5" })).toBe(
      "8–5 is already scored. It will not count in the table; it stays in the match history.",
    );
    // FR4 m1: a match only Started has nothing to quote.
    expect(ui["quickMatch.skip.started"]).toBe("This match has started, but nothing is scored yet.");
    // FR4 m2: the pad's Not played line once the league has finished.
    expect(ui["device.quickMatch.notPlayedFinal"]).toBe("This match was not played.");
    // The refusals, scoped to what was refused (T1 review I1: Edit result and Add a match still change a finished league;
    // G2: a knockout match is not skippable either, and has no result to point at).
    expect(ui["quickMatch.flash.leagueFinished"]).toBe("The league has finished, so a Not played match can't be put back.");
    expect(ui["quickMatch.flash.notSkippable"]).toBe(
      "Only an unfinished league match can be marked Not played. To change a result, use Edit result.",
    );
    // T1 review G1: a Score or a pad tap on a match somebody else marked Not played.
    expect(ui["quickMatch.flash.notPlayed"]).toBe("This match was marked Not played. Put it back from the match list to score it.");
    // The words the copy names are the controls' own labels: Edit result in every locale, Not played in en.
    for (const locale of LOCALES) {
      const d = DICTS[locale].ui;
      expect(d["quickMatch.flash.notSkippable"], locale).toContain(d["quickMatch.home.editResult"]!);
    }
    expect(ui["quickMatch.flash.notPlayed"]).toContain(ui["quickMatch.home.notPlayed"]!);
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
    ["marketing", "quickMatch.setup.keepNote", "days"],
    ["ui", "quickMatch.home.playedSkipped.one", "days"],
    ["ui", "quickMatch.home.playedSkipped.other", "days"],
    // Plan 5: the semi-finals' minimum is QUICK_MATCH_SEMIS_MIN_SIDES, and a shape's count is its QUICK_MATCH_QUALIFIERS entry
    // (the knockout stage's own progression on a live match).
    ["marketing", "quickMatch.setup.shape.semisNeeds", "min"],
    ["marketing", "quickMatch.setup.shape.finalNeeds", "min"],
    ["marketing", "quickMatch.errors.semisTooFewSides", "min"],
    ["marketing", "quickMatch.setup.shape.finalHint", "count"],
    ["marketing", "quickMatch.setup.shape.semisHint", "count"],
    ["ui", "quickMatch.home.goThrough", "count"],
    ["ui", "quickMatch.home.wentThrough", "count"],
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

describe("quick match guest copy: League + Knockout (plan 5 Task 1)", () => {
  const seats = Math.max(...QUICK_MATCH_QUALIFIERS);

  it("every knockout seat's rank has its two labels, 1st..the largest knockout's last seat, and none beyond, in ui.json (counted)", () => {
    // Derived from the qualifier counts the create accepts: a larger knockout reds here until its seats can be named.
    expect(seats, "anti-vacuity: the qualifier counts were read").toBeGreaterThan(0);
    let checked = 0;
    for (const locale of LOCALES) {
      const ui = DICTS[locale].ui;
      for (let n = 1; n <= seats; n++) {
        for (const family of ["quickMatch.home.leagueRank", "quickMatch.home.rankShort"]) {
          expect((ui[`${family}.${n}`] ?? "").trim(), `${locale} ${family}.${n}`).not.toBe("");
          expect(placeholders(ui[`${family}.${n}`]!), `${locale} ${family}.${n}: a fixed rank, no placeholder`).toEqual([]);
          checked++;
        }
      }
      // No label for a seat no knockout has (a dead key), and the four ranks read four different words.
      expect(ui[`quickMatch.home.leagueRank.${seats + 1}`], locale).toBeUndefined();
      expect(ui[`quickMatch.home.rankShort.${seats + 1}`], locale).toBeUndefined();
      const short = Array.from({ length: seats }, (_, i) => ui[`quickMatch.home.rankShort.${i + 1}`]);
      expect(new Set(short).size, `${locale}: the short ranks differ`).toBe(seats);
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length * seats * 2);
  });

  // The place a tie leaves in the knockout, singular and plural, typed here as each locale's grammar (never read back).
  const PLACE: Record<Locale, readonly [one: string, other: string]> = {
    en: ["place", "places"],
    fr: ["place", "places"],
    es: ["plaza", "plazas"],
    nl: ["plaats", "plaatsen"],
  };
  const word = (w: string) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u");
  const vars = { place: "2nd", sides: 3 };

  it("the tie's two place counts read .one at 1 and .other at 2 with the right noun, their number from plural() (counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const ui = DICTS[locale].ui;
      const [one, many] = PLACE[locale];
      for (const key of ["quickMatch.cut.kicker", "quickMatch.cut.titleMany"]) {
        const atOne = plural(ui, key, 1, locale, vars);
        const atTwo = plural(ui, key, 2, locale, vars);
        expect(atOne, `${locale} ${key} at 1`).toMatch(word(one));
        expect(atOne, `${locale} ${key} at 1 never says "${many}"`).not.toMatch(word(many));
        expect(atTwo, `${locale} ${key} at 2`).toMatch(word(many));
        expect(atTwo, `${locale} ${key} at 2 names the count`).toContain("2");
        for (const out of [atOne, atTwo]) expect(out, `${locale} ${key}: every placeholder filled`).not.toMatch(/\{\w+\}/);
        checked++;
      }
      // "Who goes through?" / "Choose 2 to go through": no shared noun, so the two forms differ and the count shows at 2.
      const q1 = plural(ui, "quickMatch.cut.pickQuestion", 1, locale);
      const q2 = plural(ui, "quickMatch.cut.pickQuestion", 2, locale);
      expect(q1, locale).not.toBe(q2);
      expect(q2, locale).toContain("2");
      for (const out of [q1, q2]) expect(out, locale).not.toMatch(/\{\w+\}/);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length * 3);
  });

  it("en reads the plan's key table and the spec's examples (plan 5 Task 1; spec §5, §11)", () => {
    const m = DICTS.en.marketing;
    const ui = DICTS.en.ui;
    expect(ui["quickMatch.format.league_knockout"]).toBe("League + Knockout");
    // §6: the three stacked choices and the disabled row's reason.
    expect(m["quickMatch.setup.shape.final"]).toBe("League → Final");
    expect(interpolate(m["quickMatch.setup.shape.finalHint"]!, { count: QUICK_MATCH_QUALIFIERS[0] })).toBe(
      "Everyone plays everyone, then the top 2 play a final.",
    );
    expect(interpolate(m["quickMatch.setup.shape.semisHint"]!, { count: QUICK_MATCH_QUALIFIERS[1] })).toBe(
      "Everyone plays everyone, then the top 4 play semi-finals and a final.",
    );
    expect(interpolate(m["quickMatch.setup.shape.semisNeeds"]!, { min: QUICK_MATCH_SEMIS_MIN_SIDES })).toBe("Needs 4 or more sides");
    // Owner 2026-11-14 (verbatim reasons): League → Final below three sides, and both knockout rows on rules with no knockout.
    expect(interpolate(m["quickMatch.setup.shape.finalNeeds"]!, { min: QUICK_MATCH_KNOCKOUT_MIN_SIDES })).toBe("Needs 3 or more sides");
    expect(m["quickMatch.setup.shape.notForSport"]).toBe("Not available for this sport");
    // §5: "Tie for 2nd: Ines and Mika"; §11: "Tie for 2nd: 3 sides, 1 place".
    expect(interpolate(ui["quickMatch.cut.title"]!, { place: ui["quickMatch.home.rankShort.2"]!, names: "Ines and Mika" })).toBe(
      "Tie for 2nd: Ines and Mika",
    );
    expect(plural(ui, "quickMatch.cut.titleMany", 1, "en", { place: "2nd", sides: 3 })).toBe("Tie for 2nd: 3 sides, 1 place");
    expect(plural(ui, "quickMatch.cut.kicker", 1, "en")).toBe("League finished · one place left in the knockout");
    expect(plural(ui, "quickMatch.cut.kicker", 2, "en")).toBe("League finished · 2 places left in the knockout");
    // D7: a waiting seat, and a seat that waits on the tie.
    expect(ui["quickMatch.home.leagueRank.1"]).toBe("1st in the league");
    expect(interpolate(ui["quickMatch.home.toDecide"]!, { seat: ui["quickMatch.home.leagueRank.2"]! })).toBe(
      "2nd in the league — to decide",
    );
  });

  // es: rankShort is the standalone ordinal ("1.º", "3.º"), which the draw prints on its own after a name. Before a noun
  // Spanish shortens 1 and 3 ("1.er puesto"), so the tie's title must put {place} AFTER "puesto", never before it.
  it("es names the tied place after its noun, where the standalone short rank reads right (counted)", () => {
    const ui = DICTS.es.ui;
    let checked = 0;
    for (const key of ["quickMatch.cut.title", "quickMatch.cut.titleMany.one", "quickMatch.cut.titleMany.other"]) {
      expect(ui[key], key).toMatch(/puesto \{place\}/);
      expect(ui[key], key).not.toMatch(/\{place\}\s+puesto/);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(3);
  });

  // TIE_NOT_OPEN also lands when no tie is open at all (the league reopened by an edit, or the knockout filled), so its line
  // says the table moved and shows where it stands; it never tells the guest to decide again (T7 review m5, controller
  // ruling: neutral copy). The old imperative, per locale, is what must not come back.
  it("the tie-changed flash is neutral in every locale: no 'decide again' (counted)", () => {
    const decideAgain: Record<Locale, RegExp> = { en: /decide again/i, es: /vuelve a decidir/i, fr: /décidez à nouveau/i, nl: /beslis opnieuw/i };
    let checked = 0;
    for (const locale of LOCALES) {
      const v = DICTS[locale].ui["quickMatch.flash.tieChanged"] ?? "";
      expect(v.trim(), locale).not.toBe("");
      expect(v, locale).not.toMatch(decideAgain[locale]);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length);
    expect(DICTS.en.ui["quickMatch.flash.tieChanged"]).toBe("The table changed since you opened this page. Here is where it stands.");
  });
});
