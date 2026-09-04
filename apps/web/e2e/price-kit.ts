// The prices the e2e suite asserts, read from the SAME seed the product renders
// from and Stripe is synced from — `src/config/stripe-plans.json`.
//
// ── Why this file exists instead of an import ───────────────────────────────
// `src/lib/currency.ts` is the one authority for these numbers, and importing
// `formatMinor`/`passPrice`/`proPrice` here would be the obvious move. It does
// not work: `apps/web` is `"type": "module"`, so Playwright loads the app's TS
// through Node's ESM loader, and `currency.ts` pulls the seed in as a bare
// `import stripePlans from "@/config/stripe-plans.json"`. The alias resolves;
// Node then refuses the JSON — `needs an import attribute of "type: json"` —
// and the importing spec collects NO tests at all. A whole file silently
// leaving the run is a worse failure than a stale literal, so the seed is read
// here directly, with the attribute, and the format rule is restated.
//
// A restated rule is a second authority, so it is guarded rather than trusted:
// `src/lib/__tests__/e2e-price-kit-parity.test.ts` compares every function
// below to the production one it mirrors, across every supported currency and
// every SKU in the seed. Change `formatMinor` or a price point and that test
// reds, naming what drifted — the e2e expectations move with the seed instead
// of rotting until a merge to `main` turns them red for everyone (e2e.yml
// triggers on push to `main`, never on a pull request, so nothing catches a
// stale price before it lands).
//
// The rule for callers: NEVER write a money literal in a spec. Every expected
// amount, rendered or charged, comes from here.
import seed from "../src/config/stripe-plans.json" with { type: "json" };
// Type-only, so nothing from the app reaches the Playwright runtime — the same
// import event-pass.spec.ts and helpers.ts already make. Keyed off the real
// unions so a third rung or a fifth currency is a compile error here rather
// than a price this kit quietly cannot quote.
import type { Currency, PassKey } from "../src/lib/currency";

/** The currency the suite runs in: Playwright's default locale is en-US, and
 *  `currencyFromAcceptLanguage` maps that to usd. Pinned in the parity test. */
const DEFAULT_CURRENCY: Currency = "usd";

interface PriceSpec {
  unit_amount: number;
  currency_options?: Record<string, number>;
}

/** Mirrors `amountFor` in lib/currency: usd is the seed's base `unit_amount`,
 *  every other currency is a SET point, never an FX conversion. */
function amountFor(spec: PriceSpec, currency: Currency): number {
  if (currency === DEFAULT_CURRENCY) return spec.unit_amount;
  return (spec.currency_options as Record<string, number> | undefined)?.[currency] ?? spec.unit_amount;
}

/** Mirrors `formatMinor` in lib/currency: whole amounts drop the decimals
 *  ("$19"), fractional ones keep them ("$11.99"). Since the 2026-09-04 reprice
 *  every headline price is a charm `.99`, so the fractional branch is the live
 *  one — which is exactly why the whole branch still has to be right here, or
 *  the kit agrees with the pages only by accident. */
export function money(
  amountMinor: number,
  currency: Currency = DEFAULT_CURRENCY,
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

/** What an Event Pass rung costs, in MINOR units — the figure Stripe charges,
 *  so this is what `pi.amount`, `invoice.total`, `customer.balance` and
 *  `refund.amount` are asserted against. */
export function passMinor(passKey: PassKey, currency: Currency = DEFAULT_CURRENCY): number {
  const pass = seed.passes.find((p) => p.key === passKey);
  if (!pass) throw new Error(`stripe-plans.json is missing the ${passKey} rung`);
  return amountFor(pass.price, currency);
}

/** The rendered price of an Event Pass rung — what a CTA, ticket or receipt row
 *  reads on screen. */
export function passLabel(passKey: PassKey, currency: Currency = DEFAULT_CURRENCY): string {
  return money(passMinor(passKey, currency), currency);
}

/** Pro's price in minor units for an interval. */
export function proMinor(
  interval: "monthly" | "annual",
  currency: Currency = DEFAULT_CURRENCY,
): number {
  const pro = seed.plans.find((p) => p.key === "pro");
  if (!pro) throw new Error("stripe-plans.json is missing the pro plan");
  return amountFor(pro.prices[interval], currency);
}

/** The pricing page's annual framing, `round(annual / 12)` formatted — the
 *  derivation ProPriceCard is handed (marketing/pricing/page.tsx). Rounding is
 *  part of the assertion: gbp's annual point does not divide by twelve. */
export function proAnnualPerMonthLabel(currency: Currency = DEFAULT_CURRENCY): string {
  return money(Math.round(proMinor("annual", currency) / 12), currency);
}
