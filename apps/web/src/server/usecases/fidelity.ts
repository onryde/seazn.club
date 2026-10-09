// W1 (entitlements v18, owner ruling 2026-08-30): scoring detail is free on
// every plan. This file used to derive an event-type → feature map from each
// SportModule's `fidelityTiers` declaration (`requiredFeatureForEvent`) and
// resolve a per-org fidelity BAND from it (`resolveFidelityEntitlements` /
// `resolveFidelityBand`) — Task 2 deleted `fidelityTiers` and
// `PadSpec.fidelityEntitlements` from the engine, and this task deletes their
// callers. `padSpec(cfg).fidelity` is now a UX-only filter the pad reads
// directly (module.ts's own doc) — nothing in apps/web resolves an
// entitlement from it any more.
import type { EventEnvelope } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
// Type-only: erased at compile time, so this carries no runtime dependency on
// a "use client" file (registry.tsx) despite `fidelity.ts` being server-only.
import type { OwnIdentity } from "@/components/v2/scorepad/types";
import type { ScorePadBootstrap } from "@/components/v2/scorepad/registry";

/**
 * Opt-in per-org "swap-sheet OFF-step enforcement" (owner ruling 2026-08-25;
 * swap-sheet.tsx's own `enforceOffStep`/`shouldRefuseOffStep` doc has the UI
 * side). A CHASSIS-level key, not a fidelity-band one — no `PadSpec` names
 * it, and none should ever need to, unlike the three deleted fidelity keys
 * (`scoring.match_timeline`/`scoring.ball_by_ball`/`scoring.rally_by_rally`)
 * which used to gate DEPTH of scoring detail. This one gates a swap-sheet UI
 * behaviour that exists identically at every fidelity band, so it is
 * resolved unconditionally in `resolveScorePadBootstrap` below.
 */
const SWAP_OFF_STEP_ENFORCEMENT_KEY = "scoring.swap_off_step_enforcement";

/**
 * Both v2 entry-point loaders' shared "resolve everything `<ScorePad/>`
 * needs for one fixture" call: `configSchema.parse` + the ONE remaining
 * chassis-level entitlement, wrapped into a single bootstrap — or `null` on
 * ANY resolution failure.
 *
 * The null-on-throw is deliberate, not defensive theatre: `divisions.config`
 * (and the device-link fixture's own `config` column) IS already the
 * resolved, schema-parsed variant cfg (S12/#421 decision log — every
 * `.default()` is materialised by `usecases/divisions.ts` at write time), so
 * `configSchema.parse` ordinarily succeeds. But this is called unconditionally
 * (S13/#422 removed the feature flag that used to gate it, and with it the
 * v1 pad a resolution failure used to fall back to), so a failure here must
 * still not 500 the page — the caller (FixtureConsole / DeviceScorePad)
 * simply renders no pad section when this returns `null`.
 */
export async function resolveScorePadBootstrap(params: {
  sportModule: AnySportModule;
  rawConfig: unknown;
  hasFeatureFn: (featureKey: string) => Promise<boolean>;
  initialEvents: readonly EventEnvelope[];
  identity: OwnIdentity;
  /** W2a Task 12 — `loadFixturePadCfg`'s stage kind, carried to the pad unchanged. */
  stageKind: string | null;
}): Promise<ScorePadBootstrap | null> {
  try {
    const resolvedConfig: unknown = params.sportModule.configSchema.parse(params.rawConfig);
    // W1: fidelity bands are a UX choice, never an entitlement. The only key
    // the pad still needs resolved is the swap-sheet OFF-step chassis flag.
    const swapOffStepEnforcement = await params.hasFeatureFn(SWAP_OFF_STEP_ENFORCEMENT_KEY);
    return {
      moduleVersion: params.sportModule.version,
      resolvedConfig,
      initialEvents: params.initialEvents,
      entitlements: { [SWAP_OFF_STEP_ENFORCEMENT_KEY]: swapOffStepEnforcement },
      identity: params.identity,
      stageKind: params.stageKind,
    };
  } catch {
    return null;
  }
}
