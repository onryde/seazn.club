// Capacity test 34, the pure half (spec §6.1 (3), §8.1): `Retry-After` is a whole number of seconds clamped to 1..60, and a
// header that is missing, zero, negative or not a number counts as the longest the limiter can hold, 60.
import { describe, expect, it } from "vitest";
import { parseRetryAfterS, seatWaitRemainingS } from "../seat-wait";
import { SEAT_ASK_WINDOW_S } from "../room-snapshot";

describe("parseRetryAfterS", () => {
  it("the spec's 60 is the limiter's window, not a number typed here", () => {
    expect(SEAT_ASK_WINDOW_S).toBe(60);
  });

  it("a whole number of seconds from 1 to 60 is itself; above 60 is clamped to 60", () => {
    const CASES: [string, number][] = [
      ["1", 1],
      ["23", 23],
      ["59", 59],
      ["60", 60],
      ["61", 60],
      ["9999", 60],
      [" 23 ", 23], // a header value may carry its padding
    ];
    for (const [raw, want] of CASES) expect(parseRetryAfterS(raw), JSON.stringify(raw)).toBe(want);
    expect(CASES.length, "cases checked").toBe(7);
  });

  it("missing, zero, negative and non-numeric each count as the longest, 60 (never 0, never a crash)", () => {
    const CASES: (string | null | undefined)[] = [null, undefined, "", "   ", "0", "-5", "-0", "abc", "23s", "2.5", "1e2", "NaN", "Infinity", "0x10", "+5", "99999999999999999999"];
    for (const raw of CASES) expect(parseRetryAfterS(raw), JSON.stringify(raw)).toBe(SEAT_ASK_WINDOW_S);
    expect(CASES.length, "cases checked").toBe(16);
  });
});

describe("seatWaitRemainingS: whole seconds, rounded UP, so the face never reads 0 while the button is shut", () => {
  it("counts down in whole seconds and reaches 0 exactly at the end", () => {
    const END = 23_000;
    const CASES: [number, number][] = [
      [0, 23],
      [1, 23], // 22.999 s left is still shown as 23
      [999, 23],
      [1_000, 22],
      [22_000, 1],
      [22_999, 1], // a millisecond before the end: still 1, never 0
      [23_000, 0],
      [30_000, 0],
    ];
    for (const [now, want] of CASES) expect(seatWaitRemainingS(END, now), `at ${now} ms`).toBe(want);
    expect(CASES.length, "cases checked").toBe(8);
  });
});
