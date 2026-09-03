// W1 (entitlements v18, 2026-09-02): scoring detail is free on every plan —
// `requiredFeatureForEvent`, `resolveFidelityEntitlements` and
// `resolveFidelityBand` are deleted (their own describes below, formerly
// PROMPT-13/S12/#421, are gone with them). `resolveScorePadBootstrap` is the
// only surviving export; its own describe below is what remains, adapted to
// resolve no fidelity key at all. Pure — no DB.
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { resolveScorePadBootstrap } from "../fidelity";

const byKey = new Map(builtinModules.map((m) => [m.key, m]));
const generic = byKey.get("generic")!;

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
    // W1: formerly also asserted `result!.band` was within 0-3 — bands are
    // no longer resolved from entitlements, and the bootstrap carries none.
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

  // Opt-in per-org "swap-sheet OFF-step enforcement" (owner ruling
  // 2026-08-25). `scoring.swap_off_step_enforcement` is a CHASSIS-level key —
  // it gates swap-sheet.tsx's OFF-step UI behaviour, not a fidelity band —
  // so it is resolved into `entitlements` unconditionally via `hasFeatureFn`,
  // never hardcoded true.
  it("resolves scoring.swap_off_step_enforcement into entitlements via hasFeatureFn, not hardcoded true", async () => {
    const hasFeatureFn = vi.fn(async (key: string) => key !== "scoring.swap_off_step_enforcement");
    const result = await resolveScorePadBootstrap({
      sportModule: generic,
      rawConfig: GENERIC_CFG,
      hasFeatureFn,
      initialEvents: [],
      identity: IDENTITY,
    });
    expect(result).not.toBeNull();
    expect(result!.entitlements["scoring.swap_off_step_enforcement"]).toBe(false);
    expect(hasFeatureFn).toHaveBeenCalledWith("scoring.swap_off_step_enforcement");
  });

  // W1: formerly "does not double-resolve when a fidelity band happens to
  // name the SAME key — dedup mirrors resolveFidelityEntitlements' own
  // idiom" (a fake module's `padSpec.fidelityEntitlements` naming the
  // chassis key, proving the two resolutions merged into one call).
  // `PadSpec.fidelityEntitlements` no longer exists (Task 2) and
  // `resolveScorePadBootstrap` never reads a module's `padSpec` at all any
  // more — rewritten to assert that directly: `hasFeatureFn` is called
  // EXACTLY once, with the swap key, regardless of what the module declares.
  it("does not resolve any fidelity key — hasFeatureFn is called exactly once, with the swap key", async () => {
    const hasFeatureFn = vi.fn(async () => true);
    const result = await resolveScorePadBootstrap({
      sportModule: generic,
      rawConfig: GENERIC_CFG,
      hasFeatureFn,
      initialEvents: [],
      identity: IDENTITY,
    });
    expect(result).not.toBeNull();
    expect(hasFeatureFn).toHaveBeenCalledTimes(1);
    expect(hasFeatureFn).toHaveBeenCalledWith("scoring.swap_off_step_enforcement");
    // Mutation check for "never reads padSpec any more": generic's `padSpec`
    // is a real function on a real module (unlike the deleted test's fake
    // one) — if `resolveScorePadBootstrap` still called it, `entitlements`
    // would carry whatever fidelity keys `generic.padSpec(cfg)` names on top
    // of the chassis key. It carries only the one key.
    expect(Object.keys(result!.entitlements)).toEqual(["scoring.swap_off_step_enforcement"]);
  });
});
