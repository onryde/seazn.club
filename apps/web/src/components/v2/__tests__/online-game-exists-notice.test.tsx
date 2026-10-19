// T16 (T19 carry) — Unpair, Rebuild and deleting an entrant refuse 409
// ONLINE_GAME_EXISTS on a board an online game stands behind
// (stages.ts lockBoardsRefusingOnlineGames). The organiser's way out is the
// arbiter panel's settle, so the refusal says so and links there.
//
// The copy is checked for TRUTH, not only presence: settling a board decides
// it, and a Swiss round with a decided board can never be unpaired
// (swissRoundHasPlayedResult), so "void the game, then try again" — T19's
// first wording — promised a retry that is refused. No void that would unblock
// it exists.
//
// The real chain (route → apiV1 → isOnlineGameExists → notice) runs against
// the database in online-game-exists-route.test.tsx.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { ApiV1Error } from "@/lib/client-v1";
import { ONLINE_GAME_EXISTS_CODE, ONLINE_GAME_EXISTS_KEY, isOnlineGameExists } from "@/lib/open-round";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Loc, Dict>;
const current = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/components/i18n/dict-provider", () => ({
  useMsg: () => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[current.locale as Loc], key, vars),
}));

import { OnlineGameExistsNotice } from "../online-game-exists-notice";

const ARBITER = "/o/club/c/cup/d/open/arbiter";
const s = (loc: Loc, key: string) => String(DICTS[loc][key]);
const esc = (x: string) => x.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

describe("isOnlineGameExists", () => {
  it("only the 409 game-exists refusal — never another code, never a non-API error", () => {
    const cells: [string, unknown, boolean][] = [
      ["the refusal", new ApiV1Error("x", 409, ONLINE_GAME_EXISTS_CODE), true],
      ["another 409", new ApiV1Error("x", 409, "STAGE_NOT_READY"), false],
      ["the paywall", new ApiV1Error("x", 402, "PAYMENT_REQUIRED"), false],
      ["a network failure", new TypeError("fetch failed"), false],
      ["nothing", null, false],
    ];
    let checked = 0;
    for (const [label, err, want] of cells) {
      expect(isOnlineGameExists(err), label).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
  });
});

describe("OnlineGameExistsNotice", () => {
  const notice = (href: string | null, loc: Loc = "en") => {
    current.locale = loc;
    return renderToStaticMarkup(<OnlineGameExistsNotice arbiterHref={href} />);
  };

  it("says why and links to the arbiter panel, where the board is settled", () => {
    const h = notice(ARBITER);
    expect(h).toContain('data-testid="online-game-exists"');
    expect(h).toContain(esc(s("en", ONLINE_GAME_EXISTS_KEY)));
    expect(h).toMatch(new RegExp(`data-testid="online-game-exists-link"[^>]*href="${ARBITER}"|href="${ARBITER}"[^>]*data-testid="online-game-exists-link"`));
    expect(h).toContain(`>${esc(s("en", "externalPlay.gameExistsCta"))}</a>`);
  });

  it("the empty case: with no arbiter panel to link to (none on this page), the sentence alone — never a dead link", () => {
    const h = notice(null);
    expect(h).toContain(esc(s("en", ONLINE_GAME_EXISTS_KEY)));
    expect(h).not.toContain("<a");
  });

  it("four locales, each its own words; no locale promises a retry or a void that does not exist", () => {
    const RETRY = /try again|vuelve a intentar|réessay|probeer .*opnieuw|void|anula|annulez|ongeldig/i;
    let checked = 0;
    for (const loc of LOCALES) {
      for (const key of [ONLINE_GAME_EXISTS_KEY, "externalPlay.gameExistsCta"]) {
        const text = s(loc, key);
        expect(text.trim().length, `${loc} ${key}`).toBeGreaterThan(0);
        if (loc !== "en") expect(text, `${loc} ${key}`).not.toBe(s("en", key));
        expect(text, `${loc} ${key}`).not.toMatch(RETRY);
        expect(notice(ARBITER, loc), `${loc} ${key}`).toContain(esc(text));
        checked += 1;
      }
    }
    expect(checked).toBe(LOCALES.length * 2);
  });
});
