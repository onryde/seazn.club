import "server-only";
// Sponsor deals — the plan gates a package or a deal passes (plan 2026-11-07-sponsor-deals D17; spec §8 and §10 Q1).
// Both resolve against the competition the placement is scoped to, so an Event Pass lifts its own competition and only
// that one (the pass-scoping guard, lib/__tests__/pass-scoping-guard.test.ts, checks the argument is threaded). A null
// competition resolves org-wide: on a pass org that is the community answer, by design — the pass buys a tier or online
// selling ON ITS OWN COMPETITION, never org-wide.
import { requireFeature } from "@/lib/entitlements";
import { placementNeedsTiers } from "@/lib/sponsor-deal-policy";
import type { SponsorTier } from "@/lib/sponsor-tiers";

/** A tier other than partner, or a competition scope, needs `sponsors.tiers` (402 naming it); a partner placement on the
 *  whole org passes on every plan. The answer is `placementNeedsTiers`'s, never re-decided here. */
export async function assertPlacementAllowed(
  orgId: string,
  tier: SponsorTier,
  competitionId: string | null,
): Promise<void> {
  if (placementNeedsTiers(tier, competitionId)) {
    await requireFeature(orgId, "sponsors.tiers", competitionId ?? undefined);
  }
}

/** Online invoices and payment need `sponsors.monetize` (spec §8), resolved against the deal's competition. Connect is
 *  the caller's separate check. */
export async function assertOnlineAllowed(orgId: string, competitionId: string | null): Promise<void> {
  await requireFeature(orgId, "sponsors.monetize", competitionId ?? undefined);
}
