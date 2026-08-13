// PROMPT-13: the event-type → feature map must DERIVE from each module's
// fidelityTiers declaration (doc 14 §4), not a hand-kept table. Pure — no DB.
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { requiredFeatureForEvent, resolveFidelityBand, resolveFidelityEntitlements } from "../fidelity";

const byKey = new Map(builtinModules.map((m) => [m.key, m]));
const football = byKey.get("football")!;
const cricket = byKey.get("cricket")!;
const boardgame = byKey.get("boardgame")!;
const generic = byKey.get("generic")!;
const volleyball = byKey.get("volleyball")!;

describe("requiredFeatureForEvent (doc 14 §4 derivation)", () => {
  // [module key, eventType, required feature | null]
  const cases: [string, string, string | null][] = [
    // Tier 0/1 always passes — coarse scoring is never paywalled (doc 14 §3).
    ["cricket", "cricket.innings.summary", null],
    ["cricket", "cricket.toss", null],
    ["cricket", "cricket.revise", null], // fidelity-free; the DLS gate is separate
    ["football", "football.goal", null], // Tier 1 final score AND Tier 2 timeline → free
    ["football", "football.period", null],
    ["volleyball", "volleyball.set.summary", null],
    ["boardgame", "boardgame.result", null],
    ["generic", "generic.result", null],
    // Fine-grained tiers carry their declared entitlement (doc 10 §1).
    ["cricket", "cricket.ball", "scoring.ball_by_ball"],
    ["cricket", "cricket.player.line", "stats.player"], // the Tier-2 scorecard
    ["football", "football.card", "scoring.match_timeline"],
    ["football", "football.sub", "scoring.match_timeline"],
    ["volleyball", "volleyball.rally", "scoring.rally_by_rally"],
  ];

  it.each(cases)("%s: %s → %s", (moduleKey, eventType, expected) => {
    const sportModule = byKey.get(moduleKey) as AnySportModule;
    expect(requiredFeatureForEvent(sportModule, eventType)).toBe(expected);
  });

  it("core.* events are always free", () => {
    for (const sportModule of [cricket, football, volleyball, boardgame, generic]) {
      expect(requiredFeatureForEvent(sportModule, "core.start")).toBeNull();
      expect(requiredFeatureForEvent(sportModule, "core.void")).toBeNull();
      expect(requiredFeatureForEvent(sportModule, "core.finalize")).toBeNull();
    }
  });

  it("unknown event types are not paywalled (the module 422s them instead)", () => {
    expect(requiredFeatureForEvent(football, "football.nonsense")).toBeNull();
  });

  it("every declared tier>1 event type across shipped modules resolves to a feature", () => {
    // Guards the doc 10 §1 contract: a module may not declare a paid tier
    // without naming the entitlement that unlocks it.
    for (const sportModule of [cricket, football, volleyball, boardgame, generic]) {
      const free = new Set(
        sportModule.fidelityTiers.filter((t) => t.tier <= 1).flatMap((t) => t.eventTypes),
      );
      for (const tier of sportModule.fidelityTiers.filter((t) => t.tier > 1)) {
        for (const type of tier.eventTypes) {
          if (free.has(type)) continue; // coarse alias — free by design
          expect(
            requiredFeatureForEvent(sportModule, type),
            `${sportModule.key}:${type}`,
          ).toBeTruthy();
        }
      }
    }
  });
});

// S12/#421 — the band a real caller (both v2 entry-point loaders) resolves an
// org into, and the entitlements map that feeds it. Both pure: the async
// hasFeature resolution is a caller-supplied function, never a real DB call.
describe("resolveFidelityEntitlements", () => {
  it("resolves every feature key PadSpec.fidelityEntitlements names, and only those", async () => {
    const hasFeatureFn = vi.fn(async (key: string) => key === "stats.player");
    const result = await resolveFidelityEntitlements({ 2: "stats.player", 3: "scoring.ball_by_ball" }, hasFeatureFn);
    expect(result).toEqual({ "stats.player": true, "scoring.ball_by_ball": false });
  });

  it("an empty fidelityEntitlements resolves to an empty map and never calls hasFeature", async () => {
    const hasFeatureFn = vi.fn(async () => true);
    const result = await resolveFidelityEntitlements({}, hasFeatureFn);
    expect(result).toEqual({});
    expect(hasFeatureFn).not.toHaveBeenCalled();
  });

  it("the SAME feature key named at two bands is resolved once, not twice", async () => {
    // Real shape: football's tier 2 and tier 3 both name "scoring.match_timeline"
    // (S2/#430's decision log — the "duplicate 2/3" finding).
    const hasFeatureFn = vi.fn(async () => true);
    const result = await resolveFidelityEntitlements(
      { 2: "scoring.match_timeline", 3: "scoring.match_timeline" },
      hasFeatureFn,
    );
    expect(result).toEqual({ "scoring.match_timeline": true });
    expect(hasFeatureFn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveFidelityBand", () => {
  it("no gated bands at all -> the ceiling, band 3 (nothing paywalled)", () => {
    expect(resolveFidelityBand({}, {})).toBe(3);
  });

  it("bands 0/1 are always free -> band 1 when band 2's entitlement is missing", () => {
    expect(resolveFidelityBand({ 2: "stats.player" }, { "stats.player": false })).toBe(1);
    expect(resolveFidelityBand({ 2: "stats.player" }, {})).toBe(1); // absent key reads as false, never grants
  });

  it("holding every gated entitlement reaches band 3", () => {
    expect(
      resolveFidelityBand(
        { 2: "stats.player", 3: "scoring.ball_by_ball" },
        { "stats.player": true, "scoring.ball_by_ball": true },
      ),
    ).toBe(3);
  });

  it("a MID-band entitlement missing caps the band even though a HIGHER band's entitlement is held", () => {
    // The exact case the brief calls out: band 2's gate is missing, so band
    // 3 never gets evaluated even though its own entitlement is present.
    expect(
      resolveFidelityBand(
        { 2: "stats.player", 3: "scoring.ball_by_ball" },
        { "stats.player": false, "scoring.ball_by_ball": true },
      ),
    ).toBe(1);
  });

  it("bands are read in numeric order, not object key insertion order", () => {
    // A caller building the object with 3 before 2 must not change the
    // verdict — band 3's own entitlement must never be consulted before
    // band 2's has been confirmed.
    const fidelityEntitlements = { 3: "scoring.ball_by_ball", 2: "stats.player" };
    expect(resolveFidelityBand(fidelityEntitlements, { "stats.player": false, "scoring.ball_by_ball": true })).toBe(1);
  });
});
