// Scoring-fidelity → entitlement mapping (doc 14 §4, doc 10 §2 rule 2).
// Derived from each SportModule's own `fidelityTiers` declaration — never a
// hand-kept table — so a new module (or a new fine event type) is gated the
// moment it declares itself. Pure: safe to unit-test without a DB.
import type { AnySportModule, FidelityBand, PadSpec } from "@seazn/engine/sport";

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
 * Deduplicates: two bands may legitimately name the SAME key (football's
 * tier 2/3 both declare "scoring.match_timeline", S2/#430's decision log),
 * and that key is resolved once, not once per band.
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
