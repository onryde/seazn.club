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
