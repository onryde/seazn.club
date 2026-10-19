// M5 (measured 2026-10-09, spike-battery2.log §D): `move e7e6xx` returned
// 200 {"ok":true} and the export showed `moves=e4 e6` — Lichess TRUNCATED the
// suffix and moved a piece. A malformed move string is therefore not a Lichess
// error to catch, it is a wrong move we caused. This validator is the only
// thing standing between a client string and that outcome.
import { describe, expect, it } from "vitest";
import { UCI_RE, assertUci } from "../lichess/uci";

/** The exact string M5 was measured with, plus its truncation. Kept side by
 *  side so the test says what the bug WAS, not just what the regex does. */
const M5_MALFORMED = "e7e6xx";
const M5_WHAT_LICHESS_PLAYED = "e7e6";

const GOOD = [
  "e2e4", "a1a2", "h8h1", "a1h8",     // plain
  "e7e8q", "e7e8r", "e7e8b", "e7e8n", // promotion (M7: e7e8q → 200, export e8=Q)
  "e1g1",                              // castling is a king move in UCI
];
const BAD = [
  M5_MALFORMED,        // M5 itself
  "e7e8x",             // a promotion piece Lichess does not take
  "e7e8Q",             // uppercase promotion
  "E2E4",              // uppercase squares
  "e2e",               // short
  "e2e45",             // long
  "i2i4",              // file out of range
  "e0e9",              // rank out of range
  "e2 e4",             // whitespace inside
  " e2e4",             // leading whitespace
  "e2e4\n",            // trailing newline — a pasted value
  "",                  // empty: the shape a missing field arrives as
  "e2e4;drop table",   // an injection-shaped string
  "e2e4e2e4",          // two moves in one field
  "0-0",               // SAN castling, not UCI
  "Nf3",               // SAN, not UCI
];

describe("UCI validation (M5)", () => {
  it("accepts every well-formed move, and reports how many it checked", () => {
    let checked = 0;
    for (const uci of GOOD) {
      expect(UCI_RE.test(uci), uci).toBe(true);
      expect(assertUci(uci)).toBe(uci);
      checked++;
    }
    expect(checked, "the GOOD sweep checked nothing").toBe(GOOD.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("refuses every malformed move with 400 INVALID_UCI, and reports the count", () => {
    let checked = 0;
    for (const uci of BAD) {
      expect(UCI_RE.test(uci), uci).toBe(false);
      expect(() => assertUci(uci), uci).toThrowError(
        expect.objectContaining({ status: 400, code: "INVALID_UCI" }),
      );
      checked++;
    }
    expect(checked, "the BAD sweep checked nothing").toBe(BAD.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("M5 by name: the string Lichess silently truncated is refused, its truncation is not", () => {
    expect(() => assertUci(M5_MALFORMED)).toThrowError(
      expect.objectContaining({ code: "INVALID_UCI" }),
    );
    // The differential: the move Lichess ACTUALLY played is itself legal UCI,
    // so a validator that merely rejected "anything unusual" would be
    // indistinguishable from one that understood the bug.
    expect(assertUci(M5_WHAT_LICHESS_PLAYED)).toBe(M5_WHAT_LICHESS_PLAYED);
  });

  it("is anchored at both ends — a good move with garbage around it is refused", () => {
    expect(UCI_RE.test("xe2e4")).toBe(false);
    expect(UCI_RE.test("e2e4x")).toBe(false);
  });

  it("the error never echoes the rejected value back to the caller", () => {
    let message = "";
    try { assertUci("e2e4;drop table users"); } catch (e) { message = (e as Error).message; }
    expect(message).not.toContain("drop table");
    expect(message.length).toBeGreaterThan(0);
  });

  it("has no global or sticky flag — a shared RegExp with /g carries lastIndex between calls", () => {
    expect(UCI_RE.flags).toBe("");
    expect(UCI_RE.test("e2e4")).toBe(true);
    expect(UCI_RE.test("e2e4")).toBe(true); // same answer twice
  });
});
