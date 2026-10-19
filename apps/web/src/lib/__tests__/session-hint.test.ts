// T16 fix round 1, R2 — the signed-in HINT: a cookie the page's own scripts can read ("1" or absent) so the public
// fixture page's Your-board island never asks the lobby for an anonymous viewer (who would be refused, 401). It
// carries no identity and no authority; the server never reads it. Parsed exactly — a lookalike name or another value
// is not the hint.
import { describe, expect, it } from "vitest";
import { SESSION_HINT_COOKIE, hasSessionHint } from "../session-hint";

describe("hasSessionHint", () => {
  it("the empty case first: no cookies at all is no hint", () => {
    expect(hasSessionHint("")).toBe(false);
  });

  it("the hint alone, first, middle or last among others — and nothing else counts", () => {
    const rows: [string, boolean][] = [
      [`${SESSION_HINT_COOKIE}=1`, true],
      [`${SESSION_HINT_COOKIE}=1; seazn_locale=fr`, true],
      [`seazn_locale=fr; ${SESSION_HINT_COOKIE}=1; seazn_tz=Europe%2FLondon`, true],
      [`seazn_locale=fr;${SESSION_HINT_COOKIE}=1`, true],
      ["seazn_locale=fr", false],
      [`${SESSION_HINT_COOKIE}=0`, false],
      [`${SESSION_HINT_COOKIE}=`, false],
      [`${SESSION_HINT_COOKIE}=11`, false],
      [`x${SESSION_HINT_COOKIE}=1`, false],
      ["seazn_session=eyJhbGciOi", false],
    ];
    let checked = 0;
    for (const [cookie, want] of rows) {
      expect(hasSessionHint(cookie), cookie).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(rows.length);
  });
});
