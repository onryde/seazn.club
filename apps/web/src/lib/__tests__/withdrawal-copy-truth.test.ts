// Truth-in-copy guard for the WITHDRAW-ENTRANT confirmation body, in all four
// locales.
//
// ── WHAT WAS FALSE ───────────────────────────────────────────────────────────
// The retired copy promised "if they've played less than half their games,
// everything they played is voided (standings read as if they never entered)".
// An organiser reads that as "half the season". The engine does not measure a
// season. `withdrawTableEntrant` in packages/engine/src/competition/stage.ts is:
//
//   const total = playedCount + fixtures.pending.length;   // SCHEDULED so far
//   const expunge = (total === 0 ? 0 : playedCount / total) < 0.5;
//
// `total` counts only the fixtures that EXIST. Swiss pairs one round at a time,
// so an entrant who has played round 1 with nothing pending sits at 1/1 and the
// expunge branch never fires. Driven live on 2026-09-21: an organiser withdrew
// a Swiss entrant expecting the row to vanish; it stayed, ranked and scoring.
//
// ── WHAT THIS PINS ───────────────────────────────────────────────────────────
// Truth conditions, never wording. Each locale owes three things:
//   1. it must NOT carry its retired literal (the bare half-of-their-games
//      claim, or the standings-read-as-if-they-never-entered promise);
//   2. it MUST carry the scheduled-so-far qualifier, so the threshold reads
//      against what is on the board rather than a whole season;
//   3. it MUST cover the open formats, which the retired copy omitted entirely.
//
// Every `retired` pattern is proved live against the string it retired
// (RETIRED_BODY below), so a regex that matches nothing anywhere is a FAULT
// rather than a silent pass — the shape that lets a rule certify `en` and wave
// es/fr/nl through untouched.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`, beside
// `dictionary-copy-truth.test.ts`. CI's unit job selects `src/server src/lib`
// and `src/app`; a file outside those runs in no job at all.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DICT_ROOT = "src/dictionaries";
const KEY = "confirm.withdrawEntrant.body";

// DERIVED, never typed out. A hardcoded list silently skips a locale someone
// adds, and a stray non-directory in `src/dictionaries` would otherwise read as
// a phantom locale.
const LOCALES = readdirSync(DICT_ROOT)
  .filter((entry) => statSync(join(DICT_ROOT, entry)).isDirectory())
  .sort();

function body(locale: string): string {
  const raw = readFileSync(join(DICT_ROOT, locale, "ui.json"), "utf8");
  const dict = JSON.parse(raw) as Record<string, string | undefined>;
  return dict[KEY] ?? "";
}

type Claim = {
  /** The exact string this locale retired — the positive proof its patterns bite. */
  retiredBody: string;
  /** Phrases that must NOT survive in the shipped copy. */
  retired: RegExp[];
  /** The "measured against what is scheduled so far" qualifier. */
  qualifier: RegExp;
  /** The open formats (ladder / americano), absent from the retired copy. */
  openFormats: RegExp;
};

const CLAIMS: Record<string, Claim> = {
  en: {
    retiredBody:
      "In a running table stage: if they've played less than half their games, everything they played is voided (standings read as if they never entered); otherwise their results stand and remaining games walk over to opponents. In a bracket, opponents advance. This settles matches through the normal scoring ledger, so each one can be undone.",
    retired: [/less than half their games/i, /as if they never entered/i],
    qualifier: /scheduled so far/i,
    openFormats: /americano/i,
  },
  es: {
    retiredBody:
      "En una fase de liga en curso: si ha jugado menos de la mitad de sus partidos, todo lo que jugó se anula (la clasificación se lee como si nunca hubiera participado); de lo contrario, sus resultados se mantienen y los partidos restantes se otorgan a los oponentes. En un cuadro, los oponentes avanzan. Esto resuelve los partidos a través del registro de puntuación normal, por lo que cada uno se puede deshacer.",
    retired: [/menos de la mitad de sus partidos/i, /como si nunca hubiera participado/i],
    qualifier: /hasta ahora/i,
    openFormats: /americano/i,
  },
  fr: {
    retiredBody:
      "Dans une phase de poule en cours : s'ils ont joué moins de la moitié de leurs matchs, tout ce qu'ils ont joué est annulé (le classement se lit comme s'ils n'avaient jamais participé) ; sinon leurs résultats sont conservés et les matchs restants sont attribués par forfait aux adversaires. Dans un tableau, les adversaires progressent. Cela règle les matchs via le registre de scores habituel, chacun peut donc être annulé.",
    retired: [/moins de la moiti[ée] de leurs matchs/i, /jamais particip[ée]/i],
    qualifier: /jusqu['’]ici/i,
    openFormats: /americano/i,
  },
  nl: {
    retiredBody:
      "In een lopende tabelfase: als ze minder dan de helft van hun wedstrijden hebben gespeeld, wordt alles wat ze speelden ongeldig verklaard (de stand leest alsof ze nooit hebben deelgenomen); anders blijven hun resultaten staan en gaan resterende wedstrijden als walk-over naar de tegenstanders. In een schema gaan de tegenstanders door. Dit verwerkt wedstrijden via het normale scoreregister, dus elk kan ongedaan worden gemaakt.",
    retired: [/minder dan de helft van hun wedstrijden/i, /nooit hebben deelgenomen/i],
    qualifier: /tot nu toe/i,
    openFormats: /americano/i,
  },
};

describe(`${KEY} tells the truth in every locale`, () => {
  // Anti-vacuity. Every loop below is over LOCALES; an empty or one-entry list
  // would make the whole file pass by examining nothing.
  it("has locales to examine, derived from the dictionaries directory", () => {
    expect(LOCALES.length).toBeGreaterThan(3);
    expect(LOCALES).toContain("en");
    // A new locale directory with no claim entry is a FAULT, not a skip —
    // otherwise the first locale someone adds ships the falsehood again.
    const unguarded = LOCALES.filter((locale) => CLAIMS[locale] === undefined);
    expect(unguarded, `locale(s) with no truth claim: ${unguarded.join(", ")}`).toEqual([]);
  });

  for (const locale of LOCALES) {
    const claim = CLAIMS[locale];
    if (claim === undefined) continue;

    it(`${locale}: every retired pattern still bites the string it retired`, () => {
      for (const pattern of claim.retired) {
        expect(
          pattern.test(claim.retiredBody),
          `${locale} retired pattern ${String(pattern)} matches nothing in the copy it exists to forbid`,
        ).toBe(true);
      }
      // The qualifier and the open formats are exactly what the retired copy
      // lacked; if they already matched it, they prove nothing about the fix.
      expect(claim.qualifier.test(claim.retiredBody)).toBe(false);
      expect(claim.openFormats.test(claim.retiredBody)).toBe(false);
    });

    it(`${locale}: carries a non-empty body`, () => {
      expect(body(locale).trim().length).toBeGreaterThan(80);
    });

    it(`${locale}: no longer claims a bare half-their-games threshold, nor that the standings forget them`, () => {
      const text = body(locale);
      const hits = claim.retired.filter((pattern) => pattern.test(text)).map(String);
      expect(
        hits,
        `${locale} ${KEY} still carries retired copy ${hits.join(", ")}\n  on disk: ${text}`,
      ).toEqual([]);
    });

    it(`${locale}: measures the threshold against what is scheduled so far`, () => {
      const text = body(locale);
      expect(
        claim.qualifier.test(text),
        `${locale} ${KEY} is missing the scheduled-so-far qualifier ${String(claim.qualifier)} — ` +
          `without it an organiser reads the threshold as half a season, which the engine never measures.\n  on disk: ${text}`,
      ).toBe(true);
    });

    it(`${locale}: covers the open formats the retired copy left out`, () => {
      const text = body(locale);
      expect(
        claim.openFormats.test(text),
        `${locale} ${KEY} says nothing about ladder/americano withdrawals.\n  on disk: ${text}`,
      ).toBe(true);
    });
  }

  // A copy-paste of the English into another locale passes every regex above
  // if the regexes happen to be English-shaped, and ships an English sentence
  // onto a Spanish screen. Distinctness is what catches it.
  it("every locale holds its own translation, not a copy of a sibling", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const locale of LOCALES) {
      const text = body(locale);
      const owner = seen.get(text);
      if (owner !== undefined) duplicates.push(`${locale} is byte-identical to ${owner}`);
      else seen.set(text, locale);
    }
    expect(duplicates, duplicates.join("\n  ")).toEqual([]);
  });
});
