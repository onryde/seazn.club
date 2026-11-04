import { describe, expect, it } from "vitest";
import { registerBuiltins } from "@seazn/engine/sports";
import type { AnySportModule, SportRegistry } from "@seazn/engine/sport";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { VENUE_NOUNS, venueNoun, venueNounOf, venueWords, type VenueMsg, type VenueNoun } from "@/lib/venue";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

// The playing-area noun ("court", "pitch", "table", "board", "rink") used to reach every locale as an English word through
// `{venue}`: a Dutch organiser read "Kies de pitches die dit schema mag gebruiken". `venueWords` is the msg-aware twin of
// `venueNoun`/`venueLabel`/`pluralizeVenue`; these tests read the real dictionaries, so a locale cannot lose a noun
// without a red.

const LOCALES = ["en", "es", "fr", "nl"] as const;
type L = (typeof LOCALES)[number];
const DICT: Record<L, Dict> = { en: enUi as Dict, es: esUi as Dict, fr: frUi as Dict, nl: nlUi as Dict };
const msgIn = (l: L): VenueMsg => (key, vars) => t(DICT[l], key, vars);

/** Every sport the engine registers (never a list typed here: a new sport joins the sweep by registering). */
const SPORTS: string[] = [];
registerBuiltins({
  register(m: AnySportModule) {
    SPORTS.push(m.key);
  },
  get: () => {
    throw new Error("capture registry: get");
  },
} as unknown as SportRegistry);

describe("venueWords: every sport's noun resolves in every locale", () => {
  it("anti-vacuity: the registry yields sports, and they reach more than one noun", () => {
    expect(SPORTS.length).toBeGreaterThan(5);
    expect(new Set(SPORTS.map(venueNoun)).size).toBeGreaterThan(2);
  });

  it("each registered sport x locale: a non-empty singular and plural, in both cases, and the plural is not the singular", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const noun = venueNoun(sport);
      for (const l of LOCALES) {
        const w = venueWords(msgIn(l), noun);
        for (const [form, value] of Object.entries(w)) {
          expect(value, `${sport}/${l}/${form}`).toBeTruthy();
          expect(value, `${sport}/${l}/${form} is a key, not a word`).not.toMatch(/^venue\.noun\./);
        }
        expect(w.plural, `${sport}/${l}: plural differs from singular`).not.toBe(w.singular);
        expect(w.singularCap, `${sport}/${l}`).toBe(w.singularCap.charAt(0).toLocaleUpperCase() + w.singularCap.slice(1));
        expect(w.singular, `${sport}/${l}: the lowercase form is the capitalised one lowercased`).toBe(w.singularCap.toLowerCase());
        expect(w.plural, `${sport}/${l}`).toBe(w.pluralCap.toLowerCase());
        checked++;
      }
    }
    expect(checked, "sports x locales checked").toBe(SPORTS.length * LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the closed noun set is covered whole, not just the nouns today's registry reaches", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const l of LOCALES) {
        const w = venueWords(msgIn(l), noun);
        expect(w.singularCap && w.pluralCap, `${noun}/${l}`).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * LOCALES.length);
  });

  it("an absent or unknown sport reads the court, in every locale", () => {
    for (const l of LOCALES) {
      expect(venueWords(msgIn(l), venueNoun(undefined)).singularCap).toBe(venueWords(msgIn(l), "court").singularCap);
      expect(venueWords(msgIn(l), venueNoun("no-such-sport")).pluralCap).toBe(venueWords(msgIn(l), "court").pluralCap);
    }
  });
});

describe("venueWords: the translations are not the English word", () => {
  it("Spanish and Dutch differ from English for every noun (nothing in either language is spelt like the English noun)", () => {
    let differing = 0;
    for (const noun of VENUE_NOUNS) {
      const en = venueWords(msgIn("en"), noun);
      for (const l of ["es", "nl"] as const) {
        const w = venueWords(msgIn(l), noun);
        expect(w.singularCap, `${l}/${noun} singular`).not.toBe(en.singularCap);
        expect(w.pluralCap, `${l}/${noun} plural`).not.toBe(en.pluralCap);
        differing++;
      }
    }
    expect(differing).toBe(VENUE_NOUNS.length * 2);
  });

  it("French says 'terrain' for the court too (controller ruling, fix round 1: it overrides 'French keeps court')", () => {
    const fr = (n: VenueNoun) => venueWords(msgIn("fr"), n);
    const en = (n: VenueNoun) => venueWords(msgIn("en"), n);
    expect(fr("court").singular).toBe("terrain");
    expect(fr("court").plural).toBe("terrains");
    // Every noun but the table (a French word too) is spelt differently from the English one.
    let differing = 0;
    for (const n of VENUE_NOUNS.filter((v) => v !== "table")) {
      expect(fr(n).singularCap, n).not.toBe(en(n).singularCap);
      differing++;
    }
    expect(differing).toBe(VENUE_NOUNS.length - 1);
    // Real sports reach them: badminton's court and football's pitch are both a "terrain".
    expect(fr(venueNoun("badminton")).singular).toBe("terrain");
    expect(fr(venueNoun("football")).singular).toBe("terrain");
  });

  it("the nouns agree with what Match Day's own keys already say, in every locale (one word per thing across the file)", () => {
    let checked = 0;
    for (const l of ["es", "fr", "nl"] as const) {
      const dict = DICT[l] as unknown as Record<string, string>;
      for (const noun of VENUE_NOUNS) {
        const w = venueWords(msgIn(l), noun);
        expect(w.singularCap, `${l}/${noun} vs matchDay.noun.${noun}`).toBe(dict[`matchDay.noun.${noun}`]);
        expect(w.plural, `${l}/${noun} vs divBuilder.places.${noun}.other`).toBe(dict[`divBuilder.places.${noun}.other`]!.replace("{count} ", ""));
        checked++;
      }
    }
    expect(checked).toBe(3 * VENUE_NOUNS.length);
  });

  it("the pitch is a different word in each locale (a case where the right answer differs from the wrong one's constant)", () => {
    const words = LOCALES.map((l) => venueWords(msgIn(l), "pitch").singular);
    expect(new Set(words).size, words.join(",")).toBeGreaterThanOrEqual(3);
  });
});

describe("venueNounOf: the English label the board components still receive maps back onto the closed noun set", () => {
  it("round-trips every noun through venueLabel's shape (capitalised) and the lowercase shape", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      expect(venueNounOf(noun.charAt(0).toUpperCase() + noun.slice(1))).toBe(noun);
      expect(venueNounOf(noun)).toBe(noun);
      checked++;
    }
    expect(checked).toBe(VENUE_NOUNS.length);
  });

  it("a label that is not a noun (a stale 'Field', empty, absent) reads the court, venueNoun's own default", () => {
    expect(venueNounOf("Field")).toBe("court");
    expect(venueNounOf("")).toBe("court");
    expect(venueNounOf(undefined)).toBe("court");
    // The prototype hazard the builder test already names: an inherited property name is not a noun.
    expect(venueNounOf("constructor")).toBe("court");
  });
});

describe("the seven keys that took {venue} carry the localised noun and no English one", () => {
  const KEYS = [
    "boardset.venuesLabel",
    "boardset.venuesDesc",
    "boardset.removeVenue",
    "boardset.gapHint",
    "wizard.venuesProHint",
    "board.grid.unassignedCol",
    "schedule.capacity.suggestion.addCourt",
  ] as const satisfies readonly MessageKey[];
  // English words a non-English string must not hold. 'table' is also a real French word.
  const ENGLISH: Record<Exclude<L, "en">, RegExp> = {
    es: /\b(court|pitch|table|board|rink)(e?s)?\b/i,
    fr: /\b(court|pitch|board|rink)(e?s)?\b/i,
    nl: /\b(court|pitch|table|board|rink)(e?s)?\b/i,
  };

  it("anti-vacuity: seven keys, four locales, five nouns", () => {
    expect(KEYS.length).toBe(7);
    expect(VENUE_NOUNS.length).toBe(5);
  });

  for (const l of ["es", "fr", "nl"] as const) {
    it(`${l}: with its own nouns fed in, no placeholder is left, no English noun is left, and the noun's own word is there`, () => {
      let checked = 0;
      for (const noun of VENUE_NOUNS) {
        const w = venueWords(msgIn(l), noun);
        for (const key of KEYS) {
          const out = msgIn(l)(key, { venue: w.singular, venues: w.plural, n: 2 });
          expect(out, `${l}/${noun}/${key}`).not.toMatch(/\{\w+\}/);
          expect(out, `${l}/${noun}/${key}: an English noun`).not.toMatch(ENGLISH[l]);
          if (key !== "boardset.venuesLabel") expect(out.toLowerCase(), `${l}/${noun}/${key}`).toContain(w.singular.toLowerCase().split(" ")[0]);
          checked++;
        }
        // The heading is the capitalised plural, alone.
        expect(msgIn(l)("boardset.venuesLabel", { venue: w.pluralCap })).toBe(w.pluralCap);
      }
      expect(checked).toBe(KEYS.length * VENUE_NOUNS.length);
    });
  }

  it("the pro hint takes the plural as its own {venues}, in every locale - the English 's' is no longer baked in after {venue}", () => {
    for (const l of LOCALES) {
      const raw = (DICT[l] as unknown as Record<string, string>)["wizard.venuesProHint"];
      expect(raw, l).toContain("{venues}");
      expect(raw, `${l}: an English plural 's' glued to {venue}`).not.toMatch(/\{venue\}s/);
      const w = venueWords(msgIn(l), "pitch");
      expect(msgIn(l)("wizard.venuesProHint", { venue: w.singular, venues: w.plural }), l).toContain(w.plural);
    }
    // English football: "parallel pitches", not "parallel pitchs".
    const en = venueWords(msgIn("en"), "pitch");
    expect(msgIn("en")("wizard.venuesProHint", { venue: en.singular, venues: en.plural })).toContain("parallel pitches");
  });

  // French says "terrain" for the court (ruling 2026-11-04), as `venue.noun.court` and `matchDay.noun.court` do. In French
  // "court" is ALSO the adjective "short" (un nom court, des sets courts), and those must stay - so the keys that mean "short"
  // are listed, and every other fr/ui.json and fr/errors.json value (placeholders removed: `{court}` is a name, not the noun)
  // is checked to have no "court(s)" left.
  it("fr: no value says the noun \"court\" any more - only the keys where it means 'short' keep the word", async () => {
    const SHORT_NOT_COURT = [
      "clubs.form.short", "clubs.team.short", "format.swiss_playoff.tagline", "format.swiss_knockout.tagline",
      "rules.field.setType.option.short4", "import.field.clubShort", "import.field.teamShort", "variant.badminton.short",
      "variant.tennis.fast4", "variant.tennis.shortSets", "schedule.health.explain.restSpread",
    ];
    const frErrors = (await import("@/dictionaries/fr/errors.json")).default as Dict;
    const noun = /\bcourts?\b/i;
    let checked = 0;
    const leaked: string[] = [];
    for (const [file, dict] of [["ui", DICT.fr], ["errors", frErrors]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value !== "string") continue;
        checked++;
        const words = value.replace(/\{\w+\}/g, "");
        if (noun.test(words) && !SHORT_NOT_COURT.includes(key)) leaked.push(`${file}:${key}`);
      }
    }
    expect(checked, "anti-vacuity: the sweep read the French dictionaries").toBeGreaterThan(1000);
    expect(leaked).toEqual([]);
    // The allow-list is not stale: every listed key still carries the adjective in French, and its English is not about the
    // venue at all (no "court" there) - so none of them is a place that should have been renamed.
    for (const key of SHORT_NOT_COURT) {
      expect((DICT.fr as unknown as Record<string, string>)[key]!.replace(/\{\w+\}/g, ""), key).toMatch(noun);
      expect((DICT.en as Dict)[key], `${key}: English does not say court`).not.toMatch(noun);
    }
    expect(SHORT_NOT_COURT.length).toBe(11);
  });
});
