// match-length.ts had no coverage at all before this. #431 ruling 3 dropped
// cricket's `pairs-6-a-side` variant and its now-dead `VARIANT_OVERRIDE`
// entry (45); this pins the fallback behavior that change relies on, plus
// the surviving overrides so a future edit to this file can't silently
// widen or narrow the lookup without a test noticing.
import { describe, expect, it } from "vitest";
import { defaultMatchMinutes, timeControlMatchMinutes } from "@/lib/match-length";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";

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

// Match Day C9 fix round 1 (m8): an online chess division's slot is its Lichess control's length. The table is the
// rule worked by hand, not the helper: BOTH clocks spent, each Lichess's own estimate of a player's time - the base plus
// 40 moves of increment (time-controls.ts `estimatedSeconds`, the same budget the external-play sweep's `expectedEndAt`
// waits out) - rounded UP to whole minutes, so a slot never ends before the sweep would call the game over.
describe("timeControlMatchMinutes", () => {
  const BY_HAND: Record<string, number> = {
    "3+0": 6, // 2 x 180 s = 6 min
    "3+2": 9, // 2 x (180 + 80) = 520 s = 8.67 -> 9
    "5+0": 10,
    "5+3": 14, // 2 x (300 + 120) = 840 s
    "10+0": 20,
    "10+5": 27, // 2 x (600 + 200) = 1600 s = 26.67 -> 27
    "15+0": 30,
    "15+10": 44, // 2 x (900 + 400) = 2600 s = 43.33 -> 44
  };

  it("every control in the catalogue, worked by hand (counts; the table and the catalogue are the same set)", () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      expect(BY_HAND[tc.key], `${tc.key} has a hand-worked row`).toBeDefined();
      expect(timeControlMatchMinutes(tc.key), tc.key).toBe(BY_HAND[tc.key]);
      checked++;
    }
    expect(checked).toBe(Object.keys(BY_HAND).length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the empty case: no control, or one outside the catalogue, has no length (the sport's default stands)", () => {
    expect(timeControlMatchMinutes("")).toBeUndefined();
    expect(timeControlMatchMinutes("7+7")).toBeUndefined();
  });
});

