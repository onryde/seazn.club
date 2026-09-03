import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { ALL_PLAN_KEYS } from "@/lib/currency";

export interface AdminEntRow {
  feature_key: string;
  plan_key: string;
  bool_value: boolean | null;
  int_value: number | null;
}

export interface AdminEntFeature {
  feature_key: string;
  type: "bool" | "int";
  // True when ANY plan cell carries a non-null int_value — i.e. this is a
  // dual-value (bool + cap) feature like import.bulk. The cell editor renders
  // the int input next to the bool toggle for every plan of such a feature.
  hasInt: boolean;
  cells: Record<string, string>; // plan_key -> rendered value
  // plan_key -> raw stored values, so the admin cell editor can seed its input
  // from truth (∞ = int_value null) rather than parse the rendered string.
  // `present` distinguishes a real row from an absent one: an absent cell
  // resolves as DENY (getLimit → 0), NOT unlimited, so it must render "—" not ∞.
  raw: Record<string, { present: boolean; bool_value: boolean | null; int_value: number | null }>;
}

export interface AdminEntSection { slug: string; features: AdminEntFeature[] }

/**
 * Every plan `/admin/entitlements` shows a column for — and the single list
 * three separate files used to keep their own copy of: this pivot, the page's
 * `<th>` row, and the PATCH route's zod enum.
 *
 * Adding the L rung (v17 #294) is what made the duplication expensive: the
 * three had to move together or an operator would get a column they cannot
 * save (page widened, enum not) or a plan they cannot see at all (enum
 * widened, page not). Importing this everywhere makes a new plan key one edit.
 *
 * Entitlements v18: derived from `lib/currency.ts`'s `ALL_PLAN_KEYS` — every
 * plan in the database, `enterprise` included, because staff need to see and
 * edit every row even though it is never sold. `lib/pricing-matrix.ts`'s
 * `PRICING_PLAN_KEYS` derives from the SAME list, filtered to the four
 * purchasable columns — one union, so a plan added to it can't be forgotten
 * on either surface.
 */
export const ADMIN_PLAN_KEYS = ALL_PLAN_KEYS;

export type AdminPlanKey = (typeof ADMIN_PLAN_KEYS)[number];

/** Column heading per plan. `/admin` is staff-only and deliberately not
 *  localised (dark shell, English throughout), so these are plain strings —
 *  but they are a `Record`, so a plan with no heading is a compile error. */
export const ADMIN_PLAN_LABEL: Record<AdminPlanKey, string> = {
  community: "Community",
  event_pass: "Event Pass M",
  event_pass_l: "Event Pass L",
  pro: "Pro",
  enterprise: "Enterprise",
};

const PLANS = ADMIN_PLAN_KEYS;

function render(cell: AdminEntRow | undefined): string {
  if (!cell) return "—";
  if (cell.bool_value !== null) {
    // Dual-value keys (import.bulk carries a bool AND a row cap) show both.
    // The figure is deliberately not named here: it moved to 50 in V319 and this
    // comment carried the old 20 for a year, alongside two further copies of it
    // that W2 T12 had to correct — and main removed the same number
    // independently while that was happening. The caps live in
    // `plan_entitlements`, differ per plan, and belong nowhere else.
    if (cell.bool_value && cell.int_value !== null) return `true (${cell.int_value})`;
    return cell.bool_value ? "true" : "false";
  }
  return cell.int_value === null ? "∞" : String(cell.int_value);
}

/** Pivot plan_entitlements rows into domain-grouped admin sections. Keys not
 *  in ENTITLEMENT_DOMAINS land in a trailing "other" section (vestigial +
 *  spec-2 keys stay visible to staff even while unadvertised). */
export function groupForAdmin(rows: AdminEntRow[]): AdminEntSection[] {
  const byKey = new Map<string, Map<string, AdminEntRow>>();
  for (const r of rows) {
    if (!byKey.has(r.feature_key)) byKey.set(r.feature_key, new Map());
    byKey.get(r.feature_key)!.set(r.plan_key, r);
  }
  const toFeature = (k: string): AdminEntFeature => {
    const plans = byKey.get(k) ?? new Map<string, AdminEntRow>();
    const sample = [...plans.values()][0];
    return {
      feature_key: k,
      type: sample && sample.bool_value !== null ? "bool" : "int",
      hasInt: [...plans.values()].some((c) => c.int_value !== null),
      cells: Object.fromEntries(PLANS.map((p) => [p, render(plans.get(p))])),
      raw: Object.fromEntries(
        PLANS.map((p) => {
          const cell = plans.get(p);
          return [
            p,
            {
              present: cell !== undefined,
              bool_value: cell?.bool_value ?? null,
              int_value: cell?.int_value ?? null,
            },
          ];
        }),
      ),
    };
  };
  const listed = new Set(ENTITLEMENT_DOMAINS.flatMap((d) => d.features));
  const sections: AdminEntSection[] = ENTITLEMENT_DOMAINS.map((d) => ({
    slug: d.slug,
    features: d.features.filter((f) => byKey.has(f)).map(toFeature),
  }));
  const other = [...byKey.keys()].filter((k) => !listed.has(k)).sort().map(toFeature);
  if (other.length > 0) sections.push({ slug: "other", features: other });
  return sections;
}
