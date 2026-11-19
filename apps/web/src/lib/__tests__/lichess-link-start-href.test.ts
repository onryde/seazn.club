// The Lichess link start's URL (lib/lichess-link.ts). It names a club only when the caller has one (the registration
// form, the match room); the /me and Settings card — shown to every signed-in player (owner 2026-11-18) — names none.
// The route reads the same parameter name, so a start the builder makes is the start the route accepts
// (api/auth/lichess/__tests__/lichess-oauth-routes.test.ts drives the real route with these hrefs).
import { describe, expect, it } from "vitest";
import { LICHESS_LINK_ORG_PARAM, LICHESS_LINK_START_PATH, lichessLinkStartHref } from "@/lib/lichess-link";

describe("lichessLinkStartHref", () => {
  it("names the club it is given, and carries the return path", () => {
    expect(lichessLinkStartHref("club-b")).toBe(`${LICHESS_LINK_START_PATH}?${LICHESS_LINK_ORG_PARAM}=club-b`);
    expect(lichessLinkStartHref("club-b", "/me")).toBe(`${LICHESS_LINK_START_PATH}?${LICHESS_LINK_ORG_PARAM}=club-b&next=%2Fme`);
  });

  it("names NO club when given none — never the text 'null' or 'undefined' — and still carries the return path", () => {
    let checked = 0;
    for (const none of [null, undefined, ""] as const) {
      expect(lichessLinkStartHref(none as null), String(none)).toBe(LICHESS_LINK_START_PATH);
      expect(lichessLinkStartHref(none as null, "/settings?tab=account"), String(none)).toBe(
        `${LICHESS_LINK_START_PATH}?next=%2Fsettings%3Ftab%3Daccount`,
      );
      expect(lichessLinkStartHref(none as null), String(none)).not.toContain(LICHESS_LINK_ORG_PARAM);
      checked += 2;
    }
    expect(checked).toBe(6);
  });
});
