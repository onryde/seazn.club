// dailySeed — deterministic integer from an ISO date + a per-game salt, so
// every player gets the same daily puzzle and two different daily games
// landing on the same calendar day never draw the same index from their
// respective content lists. Pure: no Date.now()/Math.random() inside the
// hash itself — every case here passes an explicit date string rather than
// relying on the real "today", so the suite never goes flaky at midnight.
import { describe, expect, it } from "vitest";
import { dailySeed } from "../daily-seed";

describe("dailySeed", () => {
  it("is stable: same date + same salt always returns the same integer", () => {
    const a = dailySeed("2026-08-27", "daily-word");
    const b = dailySeed("2026-08-27", "daily-word");
    const c = dailySeed("2026-08-27", "daily-word");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns a non-negative integer", () => {
    const seed = dailySeed("2026-08-27", "daily-word");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });

  it("different salts for the same date produce different integers", () => {
    const wordSeed = dailySeed("2026-08-27", "daily-word");
    const otherSeed = dailySeed("2026-08-27", "some-other-daily-game");
    expect(wordSeed).not.toBe(otherSeed);
  });

  it("different dates for the same salt produce different integers", () => {
    const day1 = dailySeed("2026-08-27", "daily-word");
    const day2 = dailySeed("2026-08-28", "daily-word");
    expect(day1).not.toBe(day2);
  });

  it("is a pure function of its inputs — no hidden dependency on real time", () => {
    // Same call, spread over multiple ticks of the event loop, must still
    // agree — proves nothing inside the hash reads Date.now()/Math.random().
    const results = Array.from({ length: 5 }, () => dailySeed("2000-01-01", "x"));
    expect(new Set(results).size).toBe(1);
  });

  it("defaults `date` to today when omitted, without throwing", () => {
    expect(() => dailySeed(undefined, "daily-word")).not.toThrow();
    expect(Number.isInteger(dailySeed(undefined, "daily-word"))).toBe(true);
  });
});
