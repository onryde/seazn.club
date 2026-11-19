// Truth-in-copy guard for the Archived divisions list's description (`archived.desc`), in every locale.
//
// ── WHAT WAS FALSE ───────────────────────────────────────────────────────────
// The line said an archived division "doesn't count against your plan". Since V354 that is true only for a division
// with NO recorded results: one with results keeps its `divisions.per_competition.max` slot after it is archived
// (`division_has_results(...)`, read by usecases/division-slots.ts), and staff alone can waive it. The sentence sat
// above exactly the rows that disprove it - and an org that archived a played division learned the truth from a
// paywall on a later create. (`danger.archiveBody`, the archive dialog's sentence, makes the same promise but is shown
// only when the slot is NOT held - `division-danger-zone.tsx` forks it from `danger.archiveBodySlotHeld` - so it stays.)
//
// ── WHAT THIS PINS ───────────────────────────────────────────────────────────
// Truth conditions, never wording. Each locale owes: (1) it must NOT carry its retired blanket promise; (2) it MUST say
// the two halves of the rule - a division WITHOUT results frees its slot, one WITH results keeps counting. Every
// retired pattern is proved against the string it retired, so a regex that matches nothing anywhere is a FAULT.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/` runs in CI's unit job; a file outside `src/server src/lib src/app`
// runs in no job at all.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DICT_ROOT = "src/dictionaries";
const KEY = "archived.desc";

// DERIVED, never typed out (a stray non-directory would read as a phantom locale; a new locale must be guarded).
const LOCALES = readdirSync(DICT_ROOT)
  .filter((entry) => statSync(join(DICT_ROOT, entry)).isDirectory())
  .sort();

function line(locale: string): string {
  const dict = JSON.parse(readFileSync(join(DICT_ROOT, locale, "ui.json"), "utf8")) as Record<string, string | undefined>;
  return dict[KEY] ?? "";
}

type Claim = {
  /** The line as it shipped - the positive proof `blanket` bites. */
  retired: string;
  /** The blanket promise: archived divisions do not count against the plan. */
  blanket: RegExp;
  /** A division with no recorded results frees its slot. */
  frees: RegExp;
  /** One with results keeps counting toward the limit. */
  keeps: RegExp;
};

const CLAIMS: Record<string, Claim> = {
  en: {
    retired: "Hidden from your console and the public site; they don't count against your plan. Restore brings everything back exactly as it was.",
    blanket: /they don'?t count against your plan/i,
    frees: /no recorded results frees its division slot/i,
    keeps: /with results keeps counting toward your limit/i,
  },
  fr: {
    retired: "Masquées de votre console et du site public ; elles ne comptent pas dans votre forfait. La restauration ramène tout exactement comme c'était.",
    blanket: /elles ne comptent pas dans votre forfait/i,
    frees: /sans résultat enregistré libère sa place/i,
    keeps: /avec des résultats continue de compter dans votre limite/i,
  },
  es: {
    retired: "Ocultos de tu consola y del sitio público; no cuentan para tu plan. Restaurar devuelve todo exactamente como estaba.",
    blanket: /no cuentan para tu plan/i,
    frees: /sin resultados registrados libera su plaza/i,
    keeps: /con resultados sigue contando para tu límite/i,
  },
  nl: {
    retired: "Verborgen voor je console en de openbare site; ze tellen niet mee voor je abonnement. Herstellen brengt alles precies terug zoals het was.",
    blanket: /ze tellen niet mee voor je abonnement/i,
    frees: /zonder geregistreerde resultaten geeft haar plek vrij/i,
    keeps: /met resultaten blijft meetellen voor je limiet/i,
  },
};

describe(`${KEY} tells the truth about the division slot in every locale`, () => {
  it("has locales to examine, each with a claim (anti-vacuity)", () => {
    expect(LOCALES.length).toBeGreaterThan(3);
    const unguarded = LOCALES.filter((l) => CLAIMS[l] === undefined);
    expect(unguarded, `locale(s) with no truth claim: ${unguarded.join(", ")}`).toEqual([]);
  });

  for (const locale of LOCALES) {
    const claim = CLAIMS[locale];
    if (claim === undefined) continue;

    it(`${locale}: every pattern bites what it should - the blanket the old line, the two halves not`, () => {
      expect(claim.blanket.test(claim.retired), `${locale} blanket matches nothing it retired`).toBe(true);
      expect(claim.frees.test(claim.retired), `${locale} frees already matched the old line`).toBe(false);
      expect(claim.keeps.test(claim.retired), `${locale} keeps already matched the old line`).toBe(false);
    });

    it(`${locale}: no blanket promise that an archived division does not count`, () => {
      const text = line(locale);
      expect(claim.blanket.test(text), `${locale} ${KEY} still promises the blanket.\n  on disk: ${text}`).toBe(false);
    });

    it(`${locale}: says an unplayed division frees its slot and a played one keeps counting`, () => {
      const text = line(locale);
      expect(claim.frees.test(text), `${locale} ${KEY} does not say a division with no results frees its slot.\n  on disk: ${text}`).toBe(true);
      expect(claim.keeps.test(text), `${locale} ${KEY} does not say a division with results keeps counting.\n  on disk: ${text}`).toBe(true);
    });
  }

  it("every locale holds its own translation, not a copy of a sibling", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const locale of LOCALES) {
      const text = line(locale);
      const owner = seen.get(text);
      if (owner !== undefined) dupes.push(`${locale} is byte-identical to ${owner}`);
      else seen.set(text, locale);
    }
    expect(dupes, dupes.join("\n  ")).toEqual([]);
  });
});
