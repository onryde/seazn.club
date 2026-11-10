// Sponsor deals — the ONE place the placement answer lives (plan 2026-11-07-sponsor-deals D17, preflight F14; spec §10
// Q1, owner-confirmed 2026-11-07). Sponsors, packages and deals all read it: `server/usecases/sponsors.ts`'s tier gate
// and `server/sponsors/deal-gates.ts` decide by this predicate and nothing else, so a later change of the owner's answer
// changes this function and its test, and nothing else. Client-safe on purpose (it imports only the tier authority): a
// sheet may ask the same question the usecases enforce.
import type { SponsorTier } from "./sponsor-tiers";

/** Does this placement need `sponsors.tiers`? A tier other than partner, or a competition scope, does (spec §10 Q1:
 *  on the community plan every deal is Partner on the whole org, until the club upgrades; today's gate also gates
 *  competition scoping, §2 premise 2). `competitionId` null is the whole org. */
export function placementNeedsTiers(tier: SponsorTier, competitionId: string | null): boolean {
  return tier !== "partner" || competitionId !== null;
}
