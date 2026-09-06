/**
 * What the NEXT PLAN UP hosts, for the public-dashboard degrade card.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * When an org at its `dashboard.public.max` cap creates a competition, the
 * create is not refused: V396 (entitlements v18 W2 T15) made it succeed as a
 * PRIVATE competition and return `public_quota_degraded: { feature_key, limit }`
 * on the 201. That is the best-timed upgrade moment in the product — the
 * organiser has just been told, in the middle of a successful create, that the
 * thing they asked for is the thing their plan cannot do.
 *
 * It was also the one place refusing to quantify what upgrading buys. The card
 * said "your plan's public dashboards are all in use" and named neither the cap
 * that was hit nor the cap on the other side of the paywall.
 *
 * Both numbers are read from `plan_entitlements`, never typed:
 *   - the cap they HIT comes back on the 201 (`public_quota_degraded.limit`);
 *   - the cap they would GET is this module's `PublicDashboardUpgrade`, which
 *     the create page reads for the plan `featurePlan()` names as the cheapest
 *     one that lifts this key — community 2 / pro 10 today (V396).
 *
 * Copy that quotes a limit rots the moment the matrix moves and nothing fails
 * when it does — the reason `lib/pass-comparison.ts` gives for reading every
 * figure it prints at render time, and the same reason applies here.
 */

/** The entitlement key the degrade is refused BY. */
export const PUBLIC_DASHBOARD_FEATURE = "dashboard.public.max";

/** One plan's answer for {@link PUBLIC_DASHBOARD_FEATURE}, as the create page
 *  read it out of `plan_entitlements`. */
export interface PublicDashboardUpgrade {
  /** Display name of the plan (`planLabel(featurePlan(...))`), e.g. "Pro". */
  plan: string;
  /**
   * That plan's `dashboard.public.max`.
   *
   * `null` is the column's UNLIMITED, and `undefined` is "we could not read it"
   * — a DB unreachable at build, or a row that has gone. The two must stay
   * distinguishable: `?? null` here would turn a failed read into a promise of
   * an uncapped plan, which is the embellishment `/pricing`'s ladder
   * suppression rule exists to prevent.
   */
  limit: number | null | undefined;
}

/**
 * The number worth putting in front of an organiser who just hit `hit`, or
 * `null` when there is nothing honest to say.
 *
 * Suppresses in four cases, each for its own reason:
 *
 *  - no upgrade figure was read at all (`undefined`) — absence must suppress,
 *    never embellish;
 *  - the upgrade plan is UNLIMITED (`null`). There is no sentence for this
 *    today: `featurePlan("dashboard.public.max")` resolves to `pro`, whose cap
 *    is a finite 10, so an unlimited answer would mean Pro itself had been
 *    uncapped. Writing "raises that to ∞" against a branch no live matrix
 *    reaches is a dead branch carrying a dictionary key; the card degrades to
 *    the `<UpgradeGate>` beneath it, which still sells the plan.
 *  - the org's own cap is unknown (`hit == null`) — with nothing to compare
 *    against, "raises that to 10" is a claim about a delta we cannot see;
 *  - the upgrade is not actually an upgrade (`plan <= hit`). A Pro org that
 *    hits 10 must not read "Pro raises that to 10". Their honest paths are
 *    archiving and Contact-us, and the gate below already offers both.
 */
export function publicDashboardGain(
  hit: number | null | undefined,
  upgrade: PublicDashboardUpgrade | null | undefined,
): number | null {
  const gain = upgrade?.limit;
  if (typeof gain !== "number" || typeof hit !== "number") return null;
  return gain > hit ? gain : null;
}
