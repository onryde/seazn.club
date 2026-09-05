import type { PlanKey } from "@/lib/types";

/** Display names for the paid plans. Plan names are product names — they are
 *  the same in every locale (like "Connect"), so they live here and not in the
 *  dictionaries.
 *
 *  Exists because the billing page rendered the raw `plan_key` under a CSS
 *  `capitalize`, which turns `pro_plus` into "Pro_plus", and because several
 *  strings around cancel/resume said "Pro" to a Pro Plus subscriber.
 *
 *  `plans.name` in the database carries the same fact (today identical:
 *  "Community" / "Pro" / "Enterprise") — but THIS map is the one every
 *  display call site actually reads, because each already has just the bare
 *  `plan_key` string (a subscription row, an admin diff, cancel/resume copy)
 *  and a DB round trip purely for a label is what this file exists to avoid.
 *  If the seed's `plans.name` ever changes, update this map to match — there
 *  is no drift guard between the two today.
 *
 *  A `Record<PlanKey, string>` — not `Record<string, string>` — so adding a
 *  plan to `PlanKey` without a label here is a compile error, not a silent
 *  fall-through to the title-cased guess below. */
const LABELS: Record<PlanKey, string> = {
  community: "Community",
  pro: "Pro",
  enterprise: "Enterprise",
};

/**
 * Plan keys the product has SOLD and then retired, newest first, each with the
 * migration that took it.
 *
 * A hand-written list is unavoidable and safe for the same reason
 * `retired-matrix-keys.test.ts` gives for its own: a retired key is by
 * definition absent from every runtime source of truth, so there is nothing
 * left to derive it FROM. What is derived is the part that matters — the
 * DISPLAY NAME, taken from `planLabel` below, so no guard has to hand-type
 * "Pro Plus" and none can drift from how the product would render the key.
 *
 * Read by `retiredPlanNameFaults` (lib/copy-truth.ts): no shipped user-facing
 * string may name a plan nobody can buy. Adding a plan here is therefore a
 * copy obligation, not just bookkeeping.
 */
export const RETIRED_PLAN_KEYS: readonly { key: string; retiredBy: string }[] = [
  { key: "pro_plus", retiredBy: "V393 (entitlements v18) — replaced by enterprise" },
  { key: "business", retiredBy: "V290 — folded into pro_plus, itself retired by V393" },
];

/** `enterprise` → "Enterprise". An unknown (historical, or pre-map) key is
 *  title-cased rather than shown raw, so a plan key not in `PlanKey` — e.g.
 *  a retired `pro_plus` row a stale client still has cached — is still
 *  legible instead of printing its raw snake_case form. */
export function planLabel(planKey: string | null | undefined): string {
  if (!planKey) return LABELS.community;
  return (
    LABELS[planKey as PlanKey] ??
    planKey
      .split("_")
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}
