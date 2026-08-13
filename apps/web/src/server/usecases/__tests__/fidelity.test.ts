// PROMPT-13: the event-type → feature map must DERIVE from each module's
// fidelityTiers declaration (doc 14 §4), not a hand-kept table. Pure — no DB.
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { generic } from "@seazn/engine/sports/generic";
import type { AnySportModule } from "@seazn/engine/sport";
import {
  requiredFeatureForEvent,
  resolveFidelityBand,
  resolveFidelityEntitlements,
  resolveScorePadBootstrap,
} from "../fidelity";

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

// S12/#421 — both page loaders' shared "resolve everything the v2 pad needs
// for one fixture" helper. `divisions.config` IS the resolved, schema-parsed
// variant cfg (decision log), so parsing normally succeeds — this still
// degrades to null on ANY throw rather than assumes, because a page reaches
// this function only once the flag is already ON, and a resolution failure
// there must fall back to the (always-safe) v1 path, never 500 the page.
describe("resolveScorePadBootstrap", () => {
  const GENERIC_CFG = { resultMode: "score" as const, allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false };
  const IDENTITY = { recordedBy: "user-1", deviceLinkId: null };

  it("builds a full bootstrap when resolution succeeds", async () => {
    const result = await resolveScorePadBootstrap({
      sportModule: generic,
      rawConfig: GENERIC_CFG,
      hasFeatureFn: async () => true,
      initialEvents: [],
      identity: IDENTITY,
    });
    expect(result).not.toBeNull();
    expect(result!.moduleVersion).toBe(generic.version);
    expect(result!.resolvedConfig).toEqual(GENERIC_CFG);
    expect(result!.identity).toBe(IDENTITY);
    expect(result!.band).toBeGreaterThanOrEqual(0);
    expect(result!.band).toBeLessThanOrEqual(3);
  });

  it("degrades to null — never throws — when the raw config fails configSchema.parse", async () => {
    const hasFeatureFn = vi.fn(async () => true);
    const result = await resolveScorePadBootstrap({
      sportModule: generic,
      rawConfig: { totallyNotAValidConfig: true },
      hasFeatureFn,
      initialEvents: [],
      identity: IDENTITY,
    });
    expect(result).toBeNull();
  });

  it("passes initialEvents through verbatim on success", async () => {
    const events = [
      {
        id: "e-1",
        fixtureId: "fx-1",
        seq: 1,
        type: "core.start",
        payload: {},
        recordedAt: "2026-08-13T00:00:00.000Z",
        recordedBy: "user-1",
      },
    ];
    const result = await resolveScorePadBootstrap({
      sportModule: generic,
      rawConfig: GENERIC_CFG,
      hasFeatureFn: async () => true,
      initialEvents: events,
      identity: IDENTITY,
    });
    expect(result!.initialEvents).toBe(events);
  });

  it("resolves entitlements/band from the module's OWN padSpec, never grants blindly", async () => {
    // cricket's ball-by-ball tier is genuinely gated — denying its
    // entitlement must cap the band below 3, proving this path reads real
    // padSpec data rather than defaulting to the ceiling.
    const { cricket } = await import("@seazn/engine/sports/cricket");
    const cricketCfg = cricket.configSchema.parse({});
    const result = await resolveScorePadBootstrap({
      sportModule: cricket as unknown as AnySportModule,
      rawConfig: cricketCfg,
      hasFeatureFn: async (key) => key !== "scoring.ball_by_ball",
      initialEvents: [],
      identity: IDENTITY,
    });
    expect(result).not.toBeNull();
    expect(result!.entitlements["scoring.ball_by_ball"]).toBe(false);
    expect(result!.band).toBeLessThan(3);
  });
});
