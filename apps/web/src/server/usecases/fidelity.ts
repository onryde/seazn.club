// Scoring-fidelity → entitlement mapping (doc 14 §4, doc 10 §2 rule 2).
// Derived from each SportModule's own `fidelityTiers` declaration — never a
// hand-kept table — so a new module (or a new fine event type) is gated the
// moment it declares itself. Pure: safe to unit-test without a DB.
import type { EventEnvelope } from "@seazn/engine/core";
import type { AnySportModule, FidelityBand, PadSpec } from "@seazn/engine/sport";
// Type-only: erased at compile time, so this carries no runtime dependency on
// a "use client" file (registry.tsx) despite `fidelity.ts` being server-only.
import type { OwnIdentity } from "@/components/v2/scorepad/types";
import type { ScorePadBootstrap } from "@/components/v2/scorepad/registry";

/**
 * The feature key an org must hold to append `eventType` to a fixture of this
 * module, or null when the event is free (doc 14 §1: Tier 0/1 always pass).
 *
 * An event type may appear in several tiers (football.goal is both the Tier 1
 * final score and part of the Tier 2 timeline); the LOWEST tier that accepts
 * it wins — coarse entry must never be blocked. Unknown types return null:
 * the module's eventSchema rejects them downstream with a 422, which is the
 * right error (not a paywall).
 */
export function requiredFeatureForEvent(
  sportModule: AnySportModule,
  eventType: string,
): string | null {
  if (eventType.startsWith("core.")) return null; // start/void/finalize… are free
  let lowest: { tier: number; entitlement?: string } | null = null;
  for (const t of sportModule.fidelityTiers) {
    if (!t.eventTypes.includes(eventType)) continue;
    if (lowest === null || t.tier < lowest.tier) lowest = t;
  }
  if (lowest === null || lowest.tier <= 1) return null;
  return lowest.entitlement ?? null;
}

// S12/#421 — the redesigned `PadSpec.fidelity`/`fidelityEntitlements` model
// (module.ts's own doc, "OWNER RULING: redesign the fidelity model") is what
// the v2 pad reads; these two are its entitlement/band resolvers. Additive
// alongside `requiredFeatureForEvent` above — that one keeps gating the v1
// API surface unchanged, this is v2's own read of the SAME PadSpec shape
// S6/S10/S11 already ship.

/**
 * Every feature key `fidelityEntitlements` names, resolved for real via the
 * caller's own `hasFeatureFn` (production: `(key) => hasFeature(orgId, key,
 * competitionId)`). Never grant-all: S11 shipped two skins that rendered
 * paid-gated actions as live controls precisely because their coverage
 * sweeps granted everything and `locked` never occurred in the suite
 * (_INDEX.md, S11/#420) — this is the real-value counterpart.
 *
 * Deduplicates: two bands may legitimately name the SAME key (hockey and
 * icehockey both declare "scoring.match_timeline" at tier 2 AND tier 3), and
 * that key is resolved once, not once per band. Football was this example
 * until R3-3 gave its band 3 its own key, "scoring.ball_by_ball".
 */
export async function resolveFidelityEntitlements(
  fidelityEntitlements: PadSpec["fidelityEntitlements"],
  hasFeatureFn: (featureKey: string) => Promise<boolean>,
): Promise<Record<string, boolean>> {
  const keys = new Set(Object.values(fidelityEntitlements).filter((k): k is string => typeof k === "string"));
  const entries = await Promise.all([...keys].map(async (key) => [key, await hasFeatureFn(key)] as const));
  return Object.fromEntries(entries);
}

/**
 * The highest band the org is actually entitled to: the largest `b` in 0..3
 * such that every band `<= b` either declares no entitlement (bands 0/1 are
 * always free — PadSpec's own doc, "Bands 0 and 1 are never keyed here") or
 * names one `entitlements` holds. Walked in numeric band order regardless of
 * the object's own key order, so a mid-band gap (band 2 missing) caps the
 * result even when a HIGHER band's entitlement (band 3) is separately held —
 * band 3 is never even consulted once band 2 fails.
 *
 * Pure — the async `hasFeature` resolution already happened in
 * `resolveFidelityEntitlements` above; this only walks the already-resolved
 * map, which is what makes the mid-band-gap case cheap to unit-test without
 * a DB or a mocked network call.
 */
export function resolveFidelityBand(
  fidelityEntitlements: PadSpec["fidelityEntitlements"],
  entitlements: Readonly<Record<string, boolean>>,
): FidelityBand {
  let band: FidelityBand = 0;
  for (const b of [0, 1, 2, 3] as const) {
    const key = fidelityEntitlements[b];
    if (key !== undefined && !entitlements[key]) break;
    band = b;
  }
  return band;
}

const EMPTY_SPEC: PadSpec = { panels: [], fidelity: {}, fidelityEntitlements: {} };

/**
 * Opt-in per-org "swap-sheet OFF-step enforcement" (owner ruling 2026-08-25;
 * swap-sheet.tsx's own `enforceOffStep`/`shouldRefuseOffStep` doc has the UI
 * side). A CHASSIS-level key, not a fidelity-band one — no `PadSpec` names
 * it, and none should ever need to, unlike `scoring.match_timeline`/
 * `scoring.ball_by_ball` which gate DEPTH of scoring detail. This one gates a
 * swap-sheet UI behaviour that exists identically at every fidelity band, so
 * it is resolved unconditionally in `resolveScorePadBootstrap` below rather
 * than threaded through any module's `fidelityEntitlements`.
 */
const SWAP_OFF_STEP_ENFORCEMENT_KEY = "scoring.swap_off_step_enforcement";

/**
 * Both v2 entry-point loaders' shared "resolve everything `<ScorePad/>`
 * needs for one fixture" call, wrapping `configSchema.parse` +
 * `resolveFidelityEntitlements` + `resolveFidelityBand` into one bootstrap —
 * or `null` on ANY resolution failure.
 *
 * The null-on-throw is deliberate, not defensive theatre: `divisions.config`
 * (and the device-link fixture's own `config` column) IS already the
 * resolved, schema-parsed variant cfg (S12/#421 decision log — every
 * `.default()` is materialised by `usecases/divisions.ts` at write time), so
 * `configSchema.parse` ordinarily succeeds. But this is called unconditionally
 * now (S13/#422 removed the feature flag that used to gate it, and with it
 * the v1 pad a resolution failure used to fall back to), so a failure here
 * must still not 500 the page — the caller (FixtureConsole / DeviceScorePad)
 * simply renders no pad section when this returns `null`.
 */
export async function resolveScorePadBootstrap(params: {
  sportModule: AnySportModule;
  rawConfig: unknown;
  hasFeatureFn: (featureKey: string) => Promise<boolean>;
  initialEvents: readonly EventEnvelope[];
  identity: OwnIdentity;
}): Promise<ScorePadBootstrap | null> {
  try {
    const resolvedConfig: unknown = params.sportModule.configSchema.parse(params.rawConfig);
    const spec = params.sportModule.padSpec?.(resolvedConfig) ?? EMPTY_SPEC;
    const bandEntitlements = await resolveFidelityEntitlements(spec.fidelityEntitlements, params.hasFeatureFn);
    // Chassis-level keys, resolved unconditionally and merged into the SAME
    // map — regardless of whether this module's own `fidelityEntitlements`
    // names them. Set-based dedup, same idiom `resolveFidelityEntitlements`
    // itself uses for two bands naming one key (hockey/icehockey's
    // `scoring.match_timeline`): if a fidelity band ever happens to declare
    // the identical string, its already-resolved value is reused rather than
    // asking `hasFeatureFn` a second time for the same org+key.
    const alreadyResolved = new Set(Object.keys(bandEntitlements));
    const swapOffStepEnforcement = alreadyResolved.has(SWAP_OFF_STEP_ENFORCEMENT_KEY)
      ? bandEntitlements[SWAP_OFF_STEP_ENFORCEMENT_KEY]!
      : await params.hasFeatureFn(SWAP_OFF_STEP_ENFORCEMENT_KEY);
    const entitlements = { ...bandEntitlements, [SWAP_OFF_STEP_ENFORCEMENT_KEY]: swapOffStepEnforcement };
    const band = resolveFidelityBand(spec.fidelityEntitlements, entitlements);
    return {
      moduleVersion: params.sportModule.version,
      resolvedConfig,
      initialEvents: params.initialEvents,
      entitlements,
      band,
      identity: params.identity,
    };
  } catch {
    return null;
  }
}
