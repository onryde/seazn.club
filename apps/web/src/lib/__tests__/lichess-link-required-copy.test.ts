// The organiser-side refusal for a player with no linked Lichess account ("<name> needs a linked Lichess account to
// enter this online division. Ask them to link one…") must say WHERE the player links (owner 2026-11-18): the card on
// their own /me page, or Settings → Account → Lichess. "Ask them to link one" with no place sends an organiser looking.
//
// The place is spelt from the labels of the screens it names — the Settings menu entry, the Account tab and the Lichess
// card's title — read from the SAME locale's dictionary, so a rename of any of them moves this test with it instead of
// leaving the copy pointing at a screen that no longer says that. Every refusal of this kind is found by its key name
// (`*.lichess.linkRequired.*`), not by a list typed here, so a new one cannot dodge the rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";

type Locale = (typeof LOCALES)[number];
const DICT_ROOT = join(__dirname, "..", "..", "dictionaries");
const ui = (loc: Locale) => JSON.parse(readFileSync(join(DICT_ROOT, loc, "ui.json"), "utf8")) as Record<string, string>;
const DICTS = Object.fromEntries(LOCALES.map((l) => [l, ui(l)])) as Record<Locale, Record<string, string>>;

/** The refusals this is about: an organiser (or an import) turned away because a player has no linked Lichess account. */
const isLinkRequired = (key: string) => /\.lichess\.linkRequired\./.test(key);
const KEYS = Object.keys(DICTS.en).filter(isLinkRequired).sort();

/** Where a player links, as the app labels it in a locale. */
const settingsPath = (loc: Locale) =>
  [DICTS[loc]["org.home.menu.settings"], DICTS[loc]["settings.nav.account"], DICTS[loc]["settings.account.lichess.title"]].join(" → ");

describe("the 'needs a linked Lichess account' refusals say where to link", () => {
  it("anti-vacuity: the sweep finds all seven (add, import and registrants-hub), in the same set in every locale", () => {
    expect(KEYS).toEqual([
      "entrants.lichess.linkRequired.one",
      "entrants.lichess.linkRequired.other",
      "entrants.lichess.linkRequired.unnamed",
      "import.lichess.linkRequired.one",
      "import.lichess.linkRequired.other",
      "import.lichess.linkRequired.unnamed",
      "reg.hub.registrants.lichess.linkRequired.unnamed",
    ]);
    for (const loc of LOCALES) expect(Object.keys(DICTS[loc]).filter(isLinkRequired).sort(), loc).toEqual(KEYS);
  });

  it("the place is spelt from the app's own labels, and they are real words (not an empty join)", () => {
    for (const loc of LOCALES) {
      const parts = settingsPath(loc).split(" → ");
      expect(parts, loc).toHaveLength(3);
      for (const p of parts) expect(p.trim().length, `${loc}: label ${JSON.stringify(p)}`).toBeGreaterThan(2);
    }
  });

  it("every refusal, every locale: names the Settings path AND the /me page, and keeps its {players} slot", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const key of KEYS) {
        const text = DICTS[loc][key]!;
        expect(text, `${loc} ${key}: the Settings path`).toContain(settingsPath(loc));
        expect(text, `${loc} ${key}: the /me page`).toContain("/me");
        // The slot: the named forms carry the players' names once; the unnamed form carries none.
        expect(text.split("{players}").length - 1, `${loc} ${key}: {players} slot`).toBe(key.endsWith(".unnamed") ? 0 : 1);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 7 refusals").toBe(LOCALES.length * KEYS.length);
  });

  it("the non-en locales are their own translation of the sentence, not en pasted in", () => {
    let checked = 0;
    for (const loc of LOCALES.filter((l) => l !== "en")) {
      for (const key of KEYS) {
        expect(DICTS[loc][key], `${loc} ${key}`).not.toBe(DICTS.en[key]);
        checked += 1;
      }
    }
    expect(checked).toBe(3 * KEYS.length);
  });
});
