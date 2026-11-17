// Pricing comparison rows rendered FROM plan_entitlements (spec 2026-07-18
// pro-plus-tier §5) — the marketing table can't drift from what the resolver
// actually enforces. Pure: the page queries the four plan columns and pivots
// them through here, grouped by ENTITLEMENT_DOMAINS so /pricing and
// /admin/entitlements tell the same story.
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import {
  ALL_PLAN_KEYS,
  HIDDEN_PASS_KEYS,
  PASS_KEYS,
  type AnyPlanKey,
  type HiddenPassKey,
} from "@/lib/currency";

export interface MatrixCell {
  bool_value: boolean | null;
  int_value: number | null;
}

/** feature_key → plan_key → cell, straight from plan_entitlements. */
export type MatrixData = Record<string, Record<string, MatrixCell>>;

/**
 * Every column of the comparison table, in render order — and the exact plan
 * list `/pricing` reads from `plan_entitlements`.
 *
 * ONE list, because the table used to have three: a hardcoded `where plan_key
 * in (…)` in the page's query, a fixed set of named fields on `PricingRow`,
 * and a hand-written `<th>` row. Adding the L rung (v17 #294) meant a plan
 * could be in the query and still have nowhere to render — and a plan with
 * nowhere to render inherits the neighbouring column's numbers, which on this
 * page means quoting M's 128-entrant ceiling to someone paying to remove it.
 * Deriving the query, the row shape and the headings from this tuple makes
 * that class of gap a type error instead.
 *
 * Entitlements v18: derived from `lib/currency.ts`'s `ALL_PLAN_KEYS` — every
 * plan in the database — filtered down to the PURCHASABLE columns.
 * `enterprise` is never a `/pricing` column (design §4: it's the Contact-us
 * strip below the table, not a priced offer); `lib/entitlement-admin.ts`'s
 * `ADMIN_PLAN_KEYS` derives from the same list unfiltered, so a plan added to
 * one can't be forgotten on the other.
 *
 * Nor is a pass rung that is OFF SALE (owner decision 2026-09-05 — see
 * `SELLABLE_PASS_KEYS` in lib/currency.ts). Same reason as `enterprise`, one
 * step further: this table exists to help a reader CHOOSE between the offers,
 * and a column for an offer with no checkout behind it is a choice that cannot
 * be taken. It is not a courtesy either — the hidden rung's column is the one
 * that beats Pro on entrants, so leaving it in would keep making the exact
 * comparison the rung was withdrawn for.
 *
 * `/admin/entitlements` keeps every plan, hidden rungs included: staff need to
 * see what the resolver enforces, not what the shop sells.
 */
export const PRICING_PLAN_KEYS = ALL_PLAN_KEYS.filter(
  (k): k is Exclude<AnyPlanKey, "enterprise" | HiddenPassKey> =>
    k !== "enterprise" && !(HIDDEN_PASS_KEYS as readonly string[]).includes(k),
);

export type PricingPlanKey = (typeof PRICING_PLAN_KEYS)[number];

/** Column heading, per plan. A `Record` so a plan added above without a
 *  heading is a compile error rather than a blank column. */
export const PRICING_COLUMN_LABEL_KEY: Record<PricingPlanKey, string> = {
  community: "pricing.table.community",
  event_pass: "pricing.table.pass",
  pro: "pricing.table.pro",
};

/** The rungs of the Event Pass ladder — the columns that fall through to
 *  community, because a pass grants only what it explicitly lifts.
 *
 *  Derived from `PASS_KEYS`, the FULL rung set, and deliberately not from the
 *  sellable one: this set answers "does this column fall through to community",
 *  which is a fact about how the resolver treats a pass and is true of a rung
 *  whether or not it is on sale. Filtering it by sellability would make the
 *  question accidentally right today and wrong the moment a hidden rung is
 *  rendered anywhere — the membership check below already only ever sees
 *  columns `PRICING_PLAN_KEYS` produced. */
const PASS_PLANS: ReadonlySet<string> = new Set<string>(PASS_KEYS);

export interface PricingRow {
  labelKey: string;
  /** Optional second line under the label, always a dict KEY. Used where a
   *  bare number would mislead — the orgs row is a price, not an allowance
   *  (billing-groups spec 2026-07-21 §Surfaces to update). */
  noteKey?: string;
  /** One rendered value per column, keyed by plan. */
  cells: Record<PricingPlanKey, string>;
}

/** Build a row's cells by asking `value` for each column in turn. */
function cellsFor(value: (plan: PricingPlanKey) => string): Record<PricingPlanKey, string> {
  return Object.fromEntries(PRICING_PLAN_KEYS.map((p) => [p, value(p)])) as Record<
    PricingPlanKey,
    string
  >;
}

export interface PricingSection {
  labelKey: string;
  rows: PricingRow[];
}

const CHECK = "✓";
const DASH = "—";
// Locale-free: rendered as-is, never translated to the English word
// "Unlimited" (approved UI-copy decision 2026-07-18).
const INF = "∞";

function intCell(cell: MatrixCell | undefined): string {
  if (!cell) return DASH;
  return cell.int_value === null ? INF : String(cell.int_value);
}

function boolCell(cell: MatrixCell | undefined): string {
  return cell?.bool_value === true ? CHECK : DASH;
}

/**
 * The raw cell a column should render, with the resolver's own fall-through.
 *
 * A feature key missing from a PASS rung's matrix falls through to the
 * community plan at resolution time — mirror that here so the table tells the
 * truth about what a passed competition actually gets. It applies to BOTH
 * rungs: V341 derives L from M, so the keys L has no row for are exactly the
 * keys M has no row for, and rendering "—" there would make the more expensive
 * rung look like it grants less.
 */
function cellAt(data: MatrixData, feature: string, plan: PricingPlanKey): MatrixCell | undefined {
  const direct = data[feature]?.[plan];
  if (direct) return direct;
  return PASS_PLANS.has(plan) ? data[feature]?.community : undefined;
}

// Quota-style features render a count (∞ for unlimited); every other feature
// in the domains below is a plain on/off flag.
const INT_FEATURES = new Set([
  "orgs.max_owned",
  "divisions.per_competition.max",
  "entrants.per_division.max",
  "members.max",
  // scorers.max is not here because the KEY is gone: retired from the
  // comparison by #244 while it was dormant, then deleted from
  // plan_entitlements outright by V395 (entitlements v18 W2 T12) once the seat
  // stopped being sold separately. officials.per_fixture.max dropped because
  // V319 made it ∞ on every plan — an all-∞ row tells no story — and V393 then
  // deleted that key too.
  "clubs.max",
  "teams.max",
  "teams.squad_max",
  // stages.per_division.max dropped at V471 ("all stages are free", owner
  // ruling 2026-10-20): ∞ on every plan, the same all-∞ row that retired
  // officials.per_fixture.max above. Its key stays in plan_entitlements (an
  // override can still cap one organisation), so /admin lists it under
  // "other".
  "dashboard.public.max",
  "import.bulk",
  "schedule.checkpoints.max",
  // scheduling.ai.runs_per_division.max retired (v17 Phase 2 Task 5, V322):
  // the graded per-division run cap is gone, replaced by the AI credit
  // wallet, which meters spend rather than a plan-graded count — there is no
  // longer a number to render here.
]);

function cellFormatter(feature: string): (cell: MatrixCell | undefined) => string {
  return INT_FEATURES.has(feature) ? intCell : boolCell;
}

/** Entry fees fold two keys into one honest cell: enabled + platform cut. */
function feeCell(data: MatrixData, plan: PricingPlanKey): string {
  if (cellAt(data, "registration.paid", plan)?.bool_value !== true) return DASH;
  const cut = cellAt(data, "registration.fee_percent", plan);
  return cut?.int_value != null ? `${CHECK} ${cut.int_value}%` : CHECK;
}

/**
 * The two org-wide counts a pass takes its competition OUT of (`liveUnpassedCompetition`, usecases/entitlement-freeze:
 * a passed competition holds neither an active slot nor a public-dashboard slot). A pass has no row for either, so a
 * bare number in its column would be Community's, and would read as "the pass buys nothing here".
 */
const PASSED_EVENT_FEATURES = ["competitions.max_active", "dashboard.public.max"] as const;
type PassedEventFeature = (typeof PASSED_EVENT_FEATURES)[number];
const isPassedEventFeature = (feature: string): feature is PassedEventFeature =>
  (PASSED_EVENT_FEATURES as readonly string[]).includes(feature);

/**
 * Quota semantics differ per offer: free counts active comps, a pass IS one
 * competition, Pro/Pro Plus have no cap — prose beats a bare number here.
 * The `pass` cell holds a `pricing.matrix.`-prefixed dict KEY (translated
 * prose) — every other cell in this module is a locale-free literal (a
 * number, ∞, ✓ or —). The page distinguishes the two by that prefix before
 * calling `t()`.
 */
function competitionsRow(data: MatrixData, feature: PassedEventFeature): PricingRow {
  const cell = data[feature];
  return {
    labelKey: `pricing.matrix.${feature}`,
    // Both rungs read the prose cell: a pass IS one competition, at either
    // size. What L buys is a bigger event, never more of them.
    cells: cellsFor((plan) =>
      PASS_PLANS.has(plan) ? "pricing.matrix.passedEvent" : intCell(cell?.[plan]),
    ),
  };
}

/**
 * V398 made our percentage pure margin: the club's own connected Stripe
 * account still pays Stripe's own processing cost on top of it, and no copy
 * on the page said so before this note (W3 fix round 2, item 6 — the same
 * disclosure the new `pricing.faq.platformFee` FAQ entry states in full;
 * this is the row a buyer actually forms the number from, so it carries the
 * qualifier too, not just the FAQ three sections down).
 */
function feesRow(data: MatrixData): PricingRow {
  return {
    labelKey: "pricing.matrix.fees",
    noteKey: "pricing.matrix.fees.note",
    cells: cellsFor((plan) => feeCell(data, plan)),
  };
}

/**
 * Since billing groups (spec 2026-07-21) one subscription covers several
 * organisations, so this row is a PRICE, not an allowance: the count is what
 * the plan's bill may stretch to, and each organisation past the first costs
 * half the plan's rate. The number still comes from `orgs.max_owned` in
 * plan_entitlements — only the framing is added, as a translated note key, so
 * nothing about the ladder is hardcoded here.
 */
function orgsRow(data: MatrixData): PricingRow {
  return {
    labelKey: "pricing.matrix.orgs.max_owned",
    noteKey: "pricing.matrix.orgs.max_owned.note",
    cells: cellsFor((plan) => intCell(cellAt(data, "orgs.max_owned", plan))),
  };
}

/** A one-time amount an Event Pass adds, as against the monthly count beside it: "+3", never a bare "3". */
function oneOffCell(amount: number | null | undefined): string {
  return amount == null || amount <= 0 ? DASH : `+${amount}`;
}

/**
 * Free match streams. A subscription column is a MONTHLY grant; a pass column is the ONE-OFF amount granted when the
 * pass is bought (usecases/stream-credits.ts `streamMonthlyRate`: a pass key never grants monthly). So a pass reads
 * its OWN row and never falls through to community — a pass with no row adds nothing, which is what "—" says.
 */
function streamCreditsRow(data: MatrixData): PricingRow {
  const cell = data["streaming.credits.monthly"];
  return {
    labelKey: "pricing.matrix.streaming.credits.monthly",
    noteKey: "pricing.matrix.streaming.credits.monthly.note",
    cells: cellsFor((plan) => (PASS_PLANS.has(plan) ? oneOffCell(cell?.[plan]?.int_value) : intCell(cell?.[plan]))),
  };
}

/**
 * AI credits. Monthly on a subscription column, from `ai.credits.monthly`. The Event Pass has no row for that key: its
 * top-up is one-time and lives in `PASS_CREDIT_GRANT`, the constant the grant itself reads.
 */
function aiCreditsRow(data: MatrixData): PricingRow {
  const cell = data["ai.credits.monthly"];
  return {
    labelKey: "pricing.matrix.ai.credits.monthly",
    noteKey: "pricing.matrix.ai.credits.monthly.note",
    cells: cellsFor((plan) =>
      PASS_PLANS.has(plan) ? oneOffCell(PASS_CREDIT_GRANT[plan as keyof typeof PASS_CREDIT_GRANT]) : intCell(cell?.[plan]),
    ),
  };
}

/**
 * Whether a feature is reachable by NO purchasable plan and IS granted on
 * enterprise — the self-serve-unreachable class (design §4: today just
 * `api.write`). DERIVED from the matrix, never a hardcoded key list: a key
 * that becomes enterprise-only later gets the routing note automatically,
 * and one that stops being enterprise-only loses it the same way.
 *
 * Only meaningful for a boolean row — `cellFormatter`'s caller below gates
 * this on `fmt === boolCell`, so an int row (a cap, not a yes/no) can never
 * pick it up even if `enterprise` happened to carry a truthy int value.
 */
function isEnterpriseOnlyFeature(data: MatrixData, feature: string): boolean {
  if (data[feature]?.enterprise?.bool_value !== true) return false;
  return PRICING_PLAN_KEYS.every((plan) => cellAt(data, feature, plan)?.bool_value !== true);
}

function buildRow(data: MatrixData, feature: string): PricingRow {
  if (isPassedEventFeature(feature)) return competitionsRow(data, feature);
  if (feature === "orgs.max_owned") return orgsRow(data);
  // registration.paid is never rendered bare — it's folded with
  // registration.fee_percent into the honest "fees" row instead.
  if (feature === "registration.paid") return feesRow(data);
  if (feature === "streaming.credits.monthly") return streamCreditsRow(data);
  if (feature === "ai.credits.monthly") return aiCreditsRow(data);
  const fmt = cellFormatter(feature);
  // The routing note (W3 fix round 2, item 3): of 56 rows, exactly one today
  // has every purchasable cell dashed with nowhere for the reader to go —
  // reusing the same noteKey mechanism `orgsRow` and `feesRow` already use,
  // never a second rendering path.
  const noteKey =
    feature === "sponsors.monetize"
      ? // The one money claim this row owes: what a sponsorship paid by card costs (SPONSOR_PLATFORM_FEE_PERCENT, a fixed
        // rate that is NOT the entry-fee rate in the row above it).
        "pricing.matrix.sponsors.monetize.note"
      : fmt === boolCell && isEnterpriseOnlyFeature(data, feature)
        ? "pricing.matrix.enterpriseOnly.note"
        : undefined;
  return {
    labelKey: `pricing.matrix.${feature}`,
    ...(noteKey ? { noteKey } : {}),
    cells: cellsFor((plan) => fmt(cellAt(data, feature, plan))),
  };
}

/** One section per ENTITLEMENT_DOMAINS entry, in domain order. Keys not
 *  listed there (vestigial D9 keys + domains.custom) are never rendered. */
export function buildPricingSections(data: MatrixData): PricingSection[] {
  return ENTITLEMENT_DOMAINS.map((domain) => ({
    labelKey: `pricing.matrix.section.${domain.slug}`,
    rows: domain.features.map((feature) => buildRow(data, feature)),
  }));
}
