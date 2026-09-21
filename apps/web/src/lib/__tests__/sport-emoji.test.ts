// F8, seen on the live onboarding wizard (2026-09-21): a new customer's first
// screen showed five identical 🏅 tiles — Carrom, Hockey, Ice Hockey and
// Tennis had no glyph, and the map fell through to the generic medal. There
// were also TWO maps, `discovery-cards.tsx` and `onboarding-wizard.tsx`, and
// they had already drifted (discovery knew Carrom, onboarding did not).
//
// The expectation here is DERIVED, never typed: `builtinModules` is what
// `scripts/sync-sports.ts` upserts into the `sports` table, and the onboarding
// wizard lists that table. So the engine's own module list is the thing this
// map must keep up with, and adding a sport to the engine reds this file
// instead of quietly shipping a medal.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { SPORT_EMOJI, sportEmoji } from "@/lib/sport-emoji";
import { SPORT_EMOJI as VIA_DISCOVERY, sportEmoji as sportEmojiViaDiscovery } from "@/components/discovery-cards";

/** Every sport `sync:sports` seeds, which is every sport onboarding lists. */
const SEEDED = builtinModules.map((m) => m.key);

describe("the sport glyph map", () => {
  it("premise: the engine really does ship the sports this map has to cover", () => {
    // A guard against the derivation going hollow: if `builtinModules` were
    // ever empty, every row below would pass vacuously.
    expect(SEEDED.length).toBeGreaterThanOrEqual(10);
    expect(SEEDED).toContain("generic");
  });

  it("has a glyph for every sport the engine ships", () => {
    const missing = SEEDED.filter((key) => key !== "generic" && !SPORT_EMOJI[key]);
    expect(missing, `these sports would render the generic medal: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives each sport its OWN glyph — the medal belongs to `generic` alone", () => {
    // The defect was not "no entry", it was "the same picture on five tiles".
    // A map that answered 🏅 for everything would satisfy the row above.
    const medal = SPORT_EMOJI.generic!;
    const wearingTheFallback = SEEDED.filter((k) => k !== "generic" && sportEmoji(k) === medal);
    expect(wearingTheFallback, "a real sport still renders the generic medal").toEqual([]);
    // And the glyphs are distinct: two sports sharing one picture is the same
    // defect at smaller scale.
    const glyphs = SEEDED.map((k) => sportEmoji(k));
    expect(new Set(glyphs).size).toBe(SEEDED.length);
  });

  it("still falls back to the medal for an unknown key, null and undefined", () => {
    // The positive pair for the rows above, and the reason `generic` keeps the
    // medal: the fallback must exist and must be reachable.
    expect(sportEmoji("no-such-sport")).toBe(SPORT_EMOJI.generic);
    expect(sportEmoji(null)).toBe(SPORT_EMOJI.generic);
    expect(sportEmoji(undefined)).toBe(SPORT_EMOJI.generic);
  });

  it("is ONE map — discovery-cards re-exports it rather than keeping its own", () => {
    // The two copies drifted before this file existed. Identity, not deep
    // equality: a second literal that happened to match today would pass a
    // value comparison and drift again tomorrow.
    expect(VIA_DISCOVERY).toBe(SPORT_EMOJI);
    expect(sportEmojiViaDiscovery).toBe(sportEmoji);
  });
});
