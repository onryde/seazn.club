// Sponsor tiers — the ONE authority for the tier list (R4 sponsors on stream, F10). Client-safe on purpose: this module
// imports nothing, so the pure planner (lib/sponsor-plan.ts), the overlay card and client components can read it.
// `server/usecases/sponsors.ts` re-exports the list and type rather than declaring its own (it imports the email
// outbox, so nothing client-side may import it). The DB's two tier CHECKs (V283: sponsors.tier, sponsor_packages.tier)
// must name the same four — server/sponsors/__tests__/migration.test.ts reads them back and compares.

/** Rank order, highest first (spec 2026-10-27 §1). */
export const SPONSOR_TIERS = ["title", "gold", "silver", "partner"] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

/** Owner ruling D9: how many turns each tier takes in the on-stream rotation (smooth weighted round robin, plan P7).
 *  Every tier has a positive integer weight — a zero would drop the tier from the cycle without saying so. */
export const SPONSOR_TIER_WEIGHTS: Readonly<Record<SponsorTier, number>> = Object.freeze({
  title: 3,
  gold: 2,
  silver: 1,
  partner: 1,
});
