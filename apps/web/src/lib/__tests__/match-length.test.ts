// match-length.ts had no coverage at all before this. #431 ruling 3 dropped
// cricket's `pairs-6-a-side` variant and its now-dead `VARIANT_OVERRIDE`
// entry (45); this pins the fallback behavior that change relies on, plus
// the surviving overrides so a future edit to this file can't silently
// widen or narrow the lookup without a test noticing.
import { describe, expect, it } from "vitest";
import { defaultMatchMinutes } from "@/lib/match-length";

describe("defaultMatchMinutes", () => {
  it("falls back to the sport default for pairs-6-a-side — #431 dropped its override", () => {
    // Before #431 ruling 3 this returned 45 (the removed VARIANT_OVERRIDE
    // entry). The key is no longer resolvable as a real cricket variant
    // anywhere else in the product, but this function takes a bare string
    // and must not silently keep serving a stale number for it.
    expect(defaultMatchMinutes("cricket", "pairs-6-a-side")).toBe(180);
  });

  it("still resolves every surviving cricket variant override", () => {
    expect(defaultMatchMinutes("cricket", "t20")).toBe(180);
    expect(defaultMatchMinutes("cricket", "hundred")).toBe(150);
    expect(defaultMatchMinutes("cricket", "odi")).toBe(420);
    expect(defaultMatchMinutes("cricket", "test")).toBe(480);
  });

  it("falls back to the bare sport default with no variant", () => {
    expect(defaultMatchMinutes("cricket", null)).toBe(180);
    expect(defaultMatchMinutes("cricket", undefined)).toBe(180);
  });

  it("falls back to 30 for a sport this table does not know at all", () => {
    expect(defaultMatchMinutes("not-a-real-sport", "whatever")).toBe(30);
    expect(defaultMatchMinutes(null, null)).toBe(30);
  });

  // W2e Task 3: 3×15 is the shorter BWF game, so its slot sits strictly between the 11-point `short` and 3×21 `bwf`
  // (author's call, plan Task 3). Its value equals badminton's sport default today; the entry keeps it there if that moves.
  it("orders badminton's slots by game length: short < bwf-3x15 < bwf", () => {
    const short = defaultMatchMinutes("badminton", "short");
    const threeBy15 = defaultMatchMinutes("badminton", "bwf-3x15");
    const bwf = defaultMatchMinutes("badminton", "bwf");
    expect(short).toBeLessThan(threeBy15);
    expect(threeBy15).toBeLessThan(bwf);
  });

  // W2e Task 5 (TN-SS-2): short sets with the tie-break at four all play advantage games and can run to 5–3, so a match
  // outlasts Fast4 (three-all tie-break, no-ad games) and is still well short of tour's six-game sets (author's call).
  it("orders tennis's slots by set length: fast4 < short-sets < tour", () => {
    const fast4 = defaultMatchMinutes("tennis", "fast4");
    const shortSets = defaultMatchMinutes("tennis", "short-sets");
    const tour = defaultMatchMinutes("tennis", "tour");
    expect(fast4).toBeLessThan(shortSets);
    expect(shortSets).toBeLessThan(tour);
  });

  it("is case-insensitive on both sport and variant", () => {
    expect(defaultMatchMinutes("Cricket", "T20")).toBe(180);
  });
});
