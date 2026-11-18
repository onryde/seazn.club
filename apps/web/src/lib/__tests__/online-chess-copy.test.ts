// Online chess copy truth (owner 2026-11-18). Online chess is played on SEAZN'S board; every move goes to a real
// Lichess game that Seazn creates, and Lichess runs the clock, checks each move and records the result. The copy must
// never say the game is played ON Lichess, and never claim Seazn analyses move timing.
//
// Three claims, checked against the four shipped dictionaries (every file in each locale's folder):
//  - the five product sentences are the owner-approved wording VERBATIM in en. Typed here from the ruling, the
//    authority, never read back from the dictionary; es/fr/nl are checked structurally (they name Seazn's board AND
//    Lichess, differ from en, and keep their {division} slot).
//  - a sweep: no string in any locale says games are played on Lichess, and none says "Seazn Hosted Chess" or claims
//    move-timing analysis. The sweep reports how many strings it checked, and each pattern is shown to FIRE on the
//    old wording, so a pattern that matches nothing cannot pass for a clean tree.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";

type Locale = (typeof LOCALES)[number];
const DICT_ROOT = join(__dirname, "..", "..", "dictionaries");

/** Every dictionary file of a locale, flattened to `file:key -> text` (a new dictionary file is swept without an edit here). */
function load(loc: Locale): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(join(DICT_ROOT, loc)).filter((n) => n.endsWith(".json"))) {
    const json = JSON.parse(readFileSync(join(DICT_ROOT, loc, f), "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(json)) if (typeof v === "string") out.set(`${f}:${k}`, v);
  }
  return out;
}
const DICTS = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<Locale, Map<string, string>>;
const get = (loc: Locale, file: string, key: string): string => {
  const v = DICTS[loc].get(`${file}.json:${key}`);
  expect(v, `${loc} ${file}.json ${key}`).toBeTypeOf("string");
  return v!;
};

// The owner's sentences (2026-11-18), verbatim.
const HELP =
  "Players link Lichess in Settings. They play on Seazn's board, and every move goes to a real Lichess game that Seazn creates with this time control. Lichess runs the clock, checks each move and records the result; Seazn flags any move made outside its board.";
const NOTE = "Played on Seazn's board, recorded on Lichess. Entering needs a linked Lichess account.";
const NOTE_NAMED = "{division} is played on Seazn's board, recorded on Lichess. Entering needs a linked Lichess account.";
const DETAILS_ONLINE = "Online — Seazn board, Lichess game";

const PRODUCT_KEYS: readonly { file: string; key: string; en: string }[] = [
  { file: "ui", key: "divset.onlinePlay.help", en: HELP },
  { file: "public", key: "info.onlinePlay.body", en: NOTE },
  { file: "public", key: "info.onlinePlay.named", en: NOTE_NAMED },
  { file: "ui", key: "register.online.lichess", en: NOTE },
  { file: "ui", key: "externalPlay.watch.details.online", en: DETAILS_ONLINE },
];

describe("online chess copy: the five product sentences", () => {
  it("en is the owner's wording verbatim", () => {
    for (const p of PRODUCT_KEYS) expect(get("en", p.file, p.key), p.key).toBe(p.en);
  });

  it("every locale says Seazn's board AND Lichess, is its own translation, and keeps the {division} slot where en has it", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const p of PRODUCT_KEYS) {
        const v = get(loc, p.file, p.key);
        expect(v, `${loc} ${p.key}: names Seazn`).toContain("Seazn");
        expect(v, `${loc} ${p.key}: names Lichess`).toContain("Lichess");
        if (loc !== "en") expect(v, `${loc} ${p.key}: translated`).not.toBe(p.en);
        expect(v.split("{division}").length - 1, `${loc} ${p.key}: {division} slot`).toBe(p.en.split("{division}").length - 1);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 5 sentences").toBe(LOCALES.length * PRODUCT_KEYS.length);
  });
});

/** "Games are played ON Lichess", per locale. The Lichess GAME being aborted / still running on Lichess is true and is
 *  not this claim; only the where-it-is-played sentence is. */
const PLAYED_ON_LICHESS: Record<Locale, RegExp> = {
  en: /\bplay(?:ed|s)?\s+(?:online\s+)?on Lichess\b/i,
  es: /\b(?:se juegan?|jugad[oa]s?)\s+(?:en línea\s+)?en Lichess\b/i,
  fr: /\b(?:se jouent?|jou[ée]s?)\s+(?:en ligne\s+)?sur Lichess\b/i,
  nl: /\b(?:op Lichess gespeeld|gespeeld op Lichess)\b/i,
};
/** Claims the product does not make, in any language it is spelt in. */
const NEVER_CLAIMED = /seazn hosted chess|hosted chess|timing integrity|move[- ]timing|timing analysis|analy[sz]es? (?:the )?(?:move )?timing/i;

/** The wording this change replaces: each pattern must fire on it, or the sweep below proves nothing. */
const OLD_WORDING: Record<Locale, string> = {
  en: "games in this division are played on Lichess, and your Lichess account isn't linked to play yet",
  es: "las partidas de esta división se juegan en Lichess y tu cuenta de Lichess aún no está vinculada",
  fr: "les parties de cette division se jouent sur Lichess, et votre compte Lichess n'est pas encore lié",
  nl: "de partijen in deze divisie worden op Lichess gespeeld, en je Lichess-account is nog niet gekoppeld",
};

describe("online chess copy: no string says it is played on Lichess, or claims move-timing analysis", () => {
  it("the patterns fire on the old wording (a pattern that fires on nothing is not a sweep)", () => {
    for (const loc of LOCALES) expect(OLD_WORDING[loc], loc).toMatch(PLAYED_ON_LICHESS[loc]);
    for (const claim of ["Seazn Hosted Chess", "timing integrity checks", "Seazn analyses move timing", "move timing analysis"]) {
      expect(claim, claim).toMatch(NEVER_CLAIMED);
    }
  });

  it("every string of every dictionary file, in every locale", () => {
    let scanned = 0;
    let mentioningLichess = 0;
    for (const loc of LOCALES) {
      let perLocale = 0;
      for (const [id, text] of DICTS[loc]) {
        scanned += 1;
        expect(text, `${loc} ${id}`).not.toMatch(NEVER_CLAIMED);
        if (!/lichess/i.test(text)) continue;
        perLocale += 1;
        mentioningLichess += 1;
        expect(text, `${loc} ${id}`).not.toMatch(PLAYED_ON_LICHESS[loc]);
      }
      expect(perLocale, `anti-vacuity: ${loc} has Lichess strings in the sweep`).toBeGreaterThan(50);
    }
    expect(scanned, "anti-vacuity: strings swept").toBeGreaterThan(4 * 1000);
    expect(mentioningLichess).toBeGreaterThan(4 * 50);
  });

  it("the Lichess-mentioning keys are the same set in every locale (a locale cannot dodge the sweep by dropping a key)", () => {
    const keysOf = (loc: Locale) => [...DICTS[loc]].filter(([, t]) => /lichess/i.test(t)).map(([id]) => id).sort();
    const base = keysOf("en");
    expect(base.length).toBeGreaterThan(50);
    for (const loc of LOCALES) expect(keysOf(loc), loc).toEqual(base);
  });
});
