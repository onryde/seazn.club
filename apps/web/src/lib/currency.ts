// Multi-currency price points (v3/07 §4). Pure + isomorphic: the pricing page
// (server), the currency switcher (client) and the checkout routes all read
// the same stripe-plans.json price points — SET amounts, never FX conversions.
import stripePlans from "@/config/stripe-plans.json";
import type { PlanKey, PurchasablePlanKey } from "@/lib/types";

/**
 * Every currency the platform quotes, charges and settles in.
 *
 * THIS LIST AND `config/stripe-plans.json` MOVE IN ONE COMMIT. `amountFor`
 * below falls back to `unit_amount` when a currency has no SET point, so a code
 * listed here but absent from the seed renders the USD number under the wrong
 * symbol — no error, a wrong price. The reverse (a seed point for a code not
 * listed here) is dead weight `stripe-sync.test.ts` reds on.
 *
 * AUD was withdrawn outright by the owner on 2026-09-03 (entitlements v18,
 * T10), knowing the cost: it did two jobs, and this took both — our own plan
 * prices AND `organizations.currency`, so Australian clubs can no longer
 * collect registration entry fees in AUD either. `organizations.currency`'s
 * CHECK constraint was narrowed to match in V393; `org-currency.test.ts` parses
 * that constraint back out of the catalog and compares it to
 * `REGISTRATION_CURRENCIES`, so this list and the database cannot drift.
 */
export const SUPPORTED_CURRENCIES = ["usd", "eur", "gbp", "inr"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Cookie the pricing-page switcher writes; checkout honours it (v3/07 §4). */
export const CURRENCY_COOKIE = "seazn_currency";

export function isSupportedCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/**
 * Currencies a registration entry fee may NOT be priced in (RS001b).
 *
 * The standing lever for delisting a registration currency without touching
 * subscriptions, which are a different rule set: a subscription is the platform
 * charging itself, a registration entry fee is a DESTINATION charge onto the
 * club's connected account. Starts empty — nothing is excluded today — but the
 * mechanism exists so a delist is a one-line edit plus a migration, not a
 * redesign.
 *
 * Delisting a code does NOT retract it from carts already submitted: a
 * `registration_groups.currency` is a snapshot taken at submit and deliberately
 * carries no allowlist CHECK, so historical groups keep settling in what they
 * were quoted.
 */
export const REGISTRATION_CURRENCY_EXCLUSIONS: readonly Currency[] = [];

/**
 * The currencies a registration entry fee CAN be priced in.
 *
 * DERIVED from `SUPPORTED_CURRENCIES`, never hand-written beside it — one
 * authority. A second literal list is the drift bug this shape exists to
 * prevent: the copy the public pay step reads is the one nobody remembers to
 * edit, and the failure lands on a registrant's card page rather than on the
 * organiser's settings save.
 *
 * Every member must be a 2-decimal currency (`registration-currency.test.ts`) —
 * the whole fee path does `×100` minor-unit math.
 *
 * `organizations.currency` carries a DB CHECK over exactly this set; the drift
 * test in `org-currency.test.ts` fails if the two ever disagree, so a change
 * here without a migration goes red.
 */
export const REGISTRATION_CURRENCIES: readonly Currency[] = SUPPORTED_CURRENCIES.filter(
  (c) => !(REGISTRATION_CURRENCY_EXCLUSIONS as readonly string[]).includes(c),
);

/** Narrower than `isSupportedCurrency`: is this a currency an entry fee may be
 *  priced, charged and settled in? Codes are stored lowercase. */
export function isRegistrationCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (REGISTRATION_CURRENCIES as readonly string[]).includes(value);
}

/** Narrow Stripe's plain-string currency (any case) for display helpers; usd
 *  fallback keeps formatting total even if an unexpected currency appears. */
export function asCurrency(value: unknown): Currency {
  const lower = typeof value === "string" ? value.toLowerCase() : value;
  return isSupportedCurrency(lower) ? lower : "usd";
}

interface PriceSpec {
  unit_amount: number;
  currency_options?: Record<string, number>;
}

function amountFor(spec: PriceSpec, currency: Currency): number {
  if (currency === "usd") return spec.unit_amount;
  return spec.currency_options?.[currency] ?? spec.unit_amount;
}

/** Pro price in minor units for a currency, straight from stripe-plans.json. */
export function proPrice(interval: "monthly" | "annual", currency: Currency): number {
  const pro = stripePlans.plans.find((p) => p.key === "pro");
  if (!pro) throw new Error("stripe-plans.json is missing the pro plan");
  return amountFor(pro.prices[interval], currency);
}

/**
 * What ONE more organisation in the billing group costs, in minor units.
 *
 * Read from the price seed's tier 2 (`up_to: "inf"`), not computed — the tier
 * amounts are SET per-currency price points like every other amount in that
 * file, never an FX conversion or an arithmetic half. Stripe bills from those
 * tiers, so this is the only number that can honestly be advertised.
 *
 * It IS half of tier 1 today, and a lot of copy says so in prose across four
 * locales. `extra-org-price-parity.test.ts` fails if that stops being true, and
 * names the strings to rewrite — so the price can be changed, it just cannot be
 * changed quietly.
 *
 * `plan` is `PurchasablePlanKey` (entitlements v18: "pro" only) rather than a
 * bare `"pro"` literal, so this stays visibly the same set `checkoutSchema`
 * validates rather than an independent literal that happens to match it —
 * the org add-on is only ever sold alongside a self-serve subscription.
 */
export function extraOrgPrice(
  plan: PurchasablePlanKey,
  interval: "monthly" | "annual",
  currency: Currency,
): number {
  const spec = stripePlans.plans.find((p) => p.key === plan);
  if (!spec) throw new Error(`stripe-plans.json is missing the ${plan} plan`);
  const price = spec.prices[interval];
  const tier = price.tiers?.find((t) => t.up_to === "inf");
  if (!tier) throw new Error(`${plan} ${interval} has no extra-organisation tier`);
  return amountFor(tier, currency);
}

/** The Event Pass rungs (v17 #294). Same upgrade, two sizes: `event_pass` is M
 *  (10 divisions / 128 entrants), `event_pass_l` is L (20 / unlimited). These are
 *  `plans` keys AND `stripe-plans.json` pass keys — M's is literally `event_pass`,
 *  never `event_pass_m`. */
export const PASS_KEYS = ["event_pass", "event_pass_l"] as const;
export type PassKey = (typeof PASS_KEYS)[number];

/** Is this a rung we know how to sell? The one place that decides — used by the
 *  checkout route's request validation and by the webhook / reconcile paths that
 *  read a rung back out of Stripe session metadata (v17 #294). */
export function isPassKey(value: unknown): value is PassKey {
  return typeof value === "string" && (PASS_KEYS as readonly string[]).includes(value);
}

/** Union of every `plans.key` value: the subscription plans plus the pass
 *  rungs, which are also `plans` rows (`ALL_PLAN_KEYS` below is the ordered
 *  list; this is just the type). */
export type AnyPlanKey = PlanKey | PassKey;

/**
 * Every `plans.key` row in the database, in ONE canonical price-ascending
 * column order — the union `PRICING_PLAN_KEYS` (`lib/pricing-matrix.ts`, the
 * four purchasable columns) and `ADMIN_PLAN_KEYS` (`lib/entitlement-admin.ts`,
 * all five — `/admin/entitlements` shows staff every plan, `enterprise`
 * included) both derive from by filtering/aliasing this, rather than each
 * hand-typing its own copy (the bug this replaces: adding the L rung once
 * meant a plan could land in one list and not the other).
 *
 * A `Record<AnyPlanKey, true>` object literal, not a hand-typed array,
 * decides membership: TypeScript refuses to compile this file if `PlanKey`
 * or `PassKey` ever gains a member missing here, or if a key here isn't one
 * of them. `Object.keys` then reads the column ORDER straight back out —
 * plain string keys preserve insertion order, so the object's field order
 * above is the only place that order is chosen.
 */
const ALL_PLAN_KEYS_ORDER: Record<AnyPlanKey, true> = {
  community: true,
  event_pass: true,
  event_pass_l: true,
  pro: true,
  enterprise: true,
};
export const ALL_PLAN_KEYS: readonly AnyPlanKey[] = Object.keys(
  ALL_PLAN_KEYS_ORDER,
) as AnyPlanKey[];

/**
 * What one Event Pass rung COSTS TO ADVERTISE, in minor units, straight from
 * stripe-plans.json — the same seed `stripe:sync` pushes to Stripe.
 *
 * Display only. The actual charge never comes from here: pass checkout resolves
 * `plans.stripe_price_id_onetime` by pass key (`api/billing/pass-checkout`) and
 * Stripe prices from that. So a wrong `passKey` here MISQUOTES — the page says
 * $29 and the customer is charged $59 — rather than mischarging. That failure
 * is invisible to every test that does not compare the two, which is why
 * `passKey` is REQUIRED (v17 #294): with two rungs live there is no longer a
 * safe default, and making callers name the rung lets `tsc` enumerate every
 * surface that has to make the choice.
 */
export function passPrice(currency: Currency, passKey: PassKey): number {
  const pass = stripePlans.passes?.find((p) => p.key === passKey);
  if (!pass) throw new Error(`stripe-plans.json is missing the ${passKey}`);
  return amountFor(pass.price, currency);
}

/** One rung of the AI credit-pack ladder (SPEC-6 §A4), ready for the client. */
export interface CreditPackOption {
  /** `pack_key` the checkout route validates against `CREDIT_PACKS`. */
  key: string;
  /** Credits granted on purchase — DATA from the catalog, never translated. */
  credits: number;
  /** Price in the display currency's minor units. */
  amountMinor: number;
  /** Bonus credits over the smallest pack's rate, as a whole percent (0 = none). */
  bonusPct: number;
  /** The single best-value rung (largest bonus) gets the marker. */
  bestValue: boolean;
}

/**
 * The credit-pack ladder for a currency, derived from `stripe-plans.json`'s
 * `packs` — the SAME seed `lib/credit-packs.ts` builds `CREDIT_PACKS` from and
 * that `stripe-sync` seeds Stripe from, so the Buy Credits modal, the checkout
 * route and Stripe all read one price list (no second hardcoded ladder).
 *
 * `bonusPct` is computed against the smallest pack's credits-per-unit rate on
 * the CANONICAL usd amounts (so the advertised bonus is currency-stable, not a
 * rounding artefact of each currency's set price points); the largest bonus is
 * flagged best value.
 */
export function creditPackOptions(currency: Currency): CreditPackOption[] {
  const packs = stripePlans.packs ?? [];
  if (packs.length === 0) return [];
  // Rate of the smallest (usd) pack: credits per minor unit — the baseline a
  // bigger pack's bonus is measured against.
  const base = packs[0]!.credits / packs[0]!.price.unit_amount;
  const withBonus = packs.map((p) => {
    const expected = base * p.price.unit_amount;
    const bonusPct = Math.round((p.credits / expected - 1) * 100);
    return {
      key: p.key,
      credits: p.credits,
      amountMinor: amountFor(p.price, currency),
      bonusPct,
    };
  });
  const maxBonus = Math.max(...withBonus.map((o) => o.bonusPct));
  // The largest-amount rung carrying the top bonus is the one best-value marker.
  const bestKey = maxBonus > 0
    ? [...withBonus].reverse().find((o) => o.bonusPct === maxBonus)?.key
    : undefined;
  return withBonus.map((o) => ({ ...o, bestValue: o.key === bestKey }));
}

/**
 * The CHEAPEST credit pack in a currency, for the "AI credits from …" line.
 *
 * v17 gap wave 7, fix round 2: `pricing.addons.credits` hardcoded "$10" in all
 * four locales and rendered statically, on a page where every other price goes
 * through `formatMinor(…, currency)` behind the `CurrencySwitcher`. The seed's
 * cheapest pack is eur 900 / gbp 800 / inr 79900, so the literal was
 * false in three of the four supported currencies — the same defect #191 was
 * filed for, which is why the FAQ answers interpolate their prices.
 *
 * DERIVED, not named: the smallest AMOUNT in the switched currency, so adding a
 * cheaper pack (or discounting one) moves the advertised floor with it rather
 * than leaving a stale "from". Mirrors `lowestPassRung`'s reasoning for the
 * Event Pass ladder.
 */
export function lowestCreditPackAmount(currency: Currency): number {
  const options = creditPackOptions(currency);
  if (options.length === 0) throw new Error("stripe-plans.json has no credit packs");
  return Math.min(...options.map((o) => o.amountMinor));
}

/**
 * Format minor units in a currency for marketing surfaces: whole amounts drop
 * the decimals ("$19", "₹1,399"), fractional ones keep them ("$13.25").
 */
export function formatMinor(
  amountMinor: number,
  currency: Currency,
  locale = "en",
): string {
  const amount = amountMinor / 100;
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

/**
 * Best-effort currency guess from an Accept-Language header — the fallback
 * when neither a subscription currency nor the switcher cookie exists.
 */
export function currencyFromAcceptLanguage(header: string | null): Currency {
  if (!header) return "usd";
  const lang = header.split(",")[0]?.trim().toLowerCase() ?? "";
  const region = lang.split("-")[1] ?? "";
  if (region === "gb" || region === "uk") return "gbp";
  if (region === "in" || lang.startsWith("hi")) return "inr";
  const EURO_REGIONS = new Set([
    "de", "fr", "es", "it", "nl", "pt", "ie", "at", "be", "fi", "gr", "sk", "si", "lv", "lt", "ee", "lu", "mt", "cy", "hr",
  ]);
  const EURO_LANGS = new Set(["de", "fr", "es", "it", "nl", "pt", "fi", "el"]);
  if (EURO_REGIONS.has(region) || (!region && EURO_LANGS.has(lang))) return "eur";
  return "usd";
}
