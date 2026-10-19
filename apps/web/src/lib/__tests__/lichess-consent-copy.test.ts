// T17 L2 — the Lichess consent copy must name what our server DOES with a
// player's grant. Lichess's own label for `challenge:write` is "Send, accept
// and reject challenges" (lila translation/source/oauthScope.xml, read
// 2026-10-13), and our server uses it both ways: White's token CREATES the
// challenge and Black's token ACCEPTS it (create-game.ts; pinned by
// external-play-create-game.test.ts "White's token challenges Black's
// username, and Black's token accepts"). A consent line saying only "create"
// tells a Black player less than the grant is used for.
//
// The expected phrases are the ruling's wording, one natural rendering per
// locale, typed here — never read back out of the dictionaries under test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const KEY = "settings.account.lichess.consent.scopes";
const dict = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;

/** The challenge:write half, in each locale: create AND accept. */
const CREATE_AND_ACCEPT: Record<string, string> = {
  en: "create and accept challenges",
  es: "crear y aceptar desafíos",
  fr: "créer et accepter des défis",
  nl: "uitdagingen aanmaken en accepteren",
};
/** The other two scopes, unchanged: board:play and challenge:read. */
const OTHERS: Record<string, [string, string]> = {
  en: ["play on a board", "read your challenges"],
  es: ["jugar en un tablero", "consultar tus desafíos"],
  fr: ["jouer sur un échiquier", "consulter vos défis"],
  nl: ["spelen op een bord", "je uitdagingen bekijken"],
};

describe("Lichess consent copy (T17 L2)", () => {
  it("names creating AND accepting challenges in every locale, beside the other two permissions", () => {
    let checked = 0;
    for (const [locale, phrase] of Object.entries(CREATE_AND_ACCEPT)) {
      const line = dict(locale)[KEY];
      expect(line, `${locale}: the key exists`).toBeTypeOf("string");
      expect(line, `${locale}: challenge:write is create AND accept`).toContain(phrase);
      for (const other of OTHERS[locale]!) expect(line, `${locale}: ${other}`).toContain(other);
      checked += 1;
    }
    expect(checked, "anti-vacuity: all four locales").toBe(4);
  });
});
