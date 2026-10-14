// T20 fix round 1, m5 — every outcome a Lichess linking flow reports on its landing page (`?lichess=<code>`, from the
// start route and the callback alike) has a sentence in all four locales, and nothing else is turned into a key.
// The codes come from the module's own declaration (LICHESS_FLASH_CODES); the routes are typed against it, so a code
// they emit cannot fall outside this sweep.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LICHESS_FLASH_CODES, lichessFlashKey, lichessLanding } from "@/lib/lichess-link";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

describe("the Lichess linking flash", () => {
  it("every reported outcome maps to a sentence present and non-empty in all four locales", () => {
    let checked = 0;
    for (const code of LICHESS_FLASH_CODES) {
      const key = lichessFlashKey(code);
      expect(key, code).toBe(`settings.account.lichess.flash.${code}`);
      for (const loc of LOCALES) {
        const text = DICTS[loc][key!];
        expect(typeof text === "string" && text.trim().length > 0, `${loc} ${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 4 locales × every code").toBe(4 * LICHESS_FLASH_CODES.length);
    expect(LICHESS_FLASH_CODES, "the start's own refusal is one of them").toContain("unavailable");
  });

  it("anything else is no key at all: absent, empty, hand-typed, or a code's look-alike", () => {
    let checked = 0;
    for (const v of [undefined, null, "", "Unavailable", "unavailable ", "flash.linked", "<script>"]) {
      expect(lichessFlashKey(v), JSON.stringify(v)).toBeNull();
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("lands on next — keeping its own query — or on /me", () => {
    expect(lichessLanding(null, "unavailable")).toBe("/me?lichess=unavailable");
    expect(lichessLanding("/settings?tab=account", "unavailable")).toBe("/settings?tab=account&lichess=unavailable");
    expect(lichessLanding("/shared/o/c/d/fixtures/f1/play", "linked")).toBe("/shared/o/c/d/fixtures/f1/play?lichess=linked");
  });
});
