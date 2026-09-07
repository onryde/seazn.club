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
// The dictionary, read rather than imported for the same reason as the note
// above: a bare JSON import needs an import attribute and a missing one makes
// the importing spec collect nothing at all.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const UI_EN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
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

/**
 * WHICH RUNGS ARE ON SALE, and which are dormant — restated for the same reason
 * every price in this file is, and guarded the same way.
 *
 * `SELLABLE_PASS_KEYS` in `src/lib/currency.ts` is the one authority. A VALUE
 * import of it from a spec drags `stripe-plans.json` in through the app's own
 * bare JSON import, Node's ESM loader refuses it, and the importing spec
 * collects ZERO TESTS — the exact failure this file's header describes, and the
 * one that cost a run before these two lines were moved here.
 *
 * `satisfies readonly PassKey[]` makes a rung that is not a rung a compile
 * error; `e2e-price-kit-parity.test.ts` compares both lists to the production
 * ones, member for member and in order, so a rung going on or off sale reds
 * there rather than leaving the e2e suite asserting last month's shop.
 */
export const SELLABLE_PASS_RUNGS = ["event_pass"] as const satisfies readonly PassKey[];
export const HIDDEN_PASS_RUNGS = ["event_pass_l"] as const satisfies readonly PassKey[];

/**
 * The HELD marker a buyer reads once a pass is active — "Event Pass active",
 * or "Event Pass L active" for the rung that is off sale.
 *
 * Composed here rather than imported from `lib/pass-ladder`, for this file's
 * whole reason for existing: importing `@/lib/*` into a Playwright spec makes
 * it collect ZERO tests, which reports as a silently missing file rather than
 * a failure.
 *
 * The rule it mirrors (`heldRungNeedsNaming`): a held rung is named UNLESS it
 * is exactly the one rung on sale. An L holder must still read "Event Pass L"
 * — v17 #294, a $44.99 buyer must not see their purchase as the $11.99
 * product — while the rung actually being sold drops its letter, because the
 * buy button says "Buy the pass" and a size appearing only after payment names
 * something the buyer was never shown. Stripe's own product name for that rung
 * is "Seazn Club Event Pass", with no letter, so this is also what the receipt
 * says.
 *
 * Both halves READ the dictionary, so a reword moves the assertion with it;
 * only the RULE is restated, and `pass-rung-naming.test.ts` pins that against
 * literal sets.
 */
export function passActiveMarker(passKey: PassKey): string {
  const named = !(SELLABLE_PASS_RUNGS.length === 1 && SELLABLE_PASS_RUNGS[0] === passKey);
  const rung = named ? UI_EN[`upgrade.rung.${passKey === "event_pass_l" ? "l" : "m"}`] : UI_EN["upgrade.rung.plain"];
  if (!rung) throw new Error(`price-kit: en/ui.json has no rung name for ${passKey}`);
  const template = UI_EN["pass.entry.active"];
  if (!template) throw new Error("price-kit: en/ui.json has no pass.entry.active");
  return template.replace("{rung}", rung);
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

/**
 * What ONE extra-organisation rider costs PER MONTH on `planKey`, in minor
 * units — the `org_addons` SKU Stripe actually bills, mirroring
 * `orgAddonPriceMinor` (src/lib/org-addons.ts).
 *
 * Here rather than imported for the reason this whole file exists, twice over:
 * `org-addons.ts` opens with `import "server-only"` AND pulls the seed in as a
 * bare `import stripePlans from "@/config/stripe-plans.json"`, so a spec that
 * imports it collects ZERO TESTS.
 *
 * `null` — never 0 — when the plan has no rider SKU (community). The
 * difference is the whole point: 0 would render as a free add-on, while null
 * means the surface must not offer one at all. `e2e-price-kit-parity.test.ts`
 * compares this to `orgAddonPriceMinor` for every plan in the seed AND for a
 * plan that is not, so the null branch is guarded too.
 *
 * NOT `extraOrgPrice()` (the plan's graduated `up_to: "inf"` tier): the two
 * agree monthly and diverge annually, so quoting the tier would understate an
 * annual group's rider by about a third.
 */
export function orgAddonMinor(planKey: string, currency: Currency = DEFAULT_CURRENCY): number | null {
  const entry = (seed.org_addons ?? []).find((e) => e.plan_key === planKey);
  if (!entry) return null;
  return amountFor(entry.price, currency);
}

/** The rendered price of one rider — what the Add-ons stepper reads on screen. */
export function orgAddonLabel(planKey: string, currency: Currency = DEFAULT_CURRENCY): string {
  const minor = orgAddonMinor(planKey, currency);
  if (minor === null) throw new Error(`stripe-plans.json sells no extra-org rider on ${planKey}`);
  return money(minor, currency);
}

/** Plan keys the seed sells a rider on, in catalog order — mirrors
 *  `ORG_ADDON_PLAN_KEYS` (src/lib/org-addon-plans.ts), which a spec cannot
 *  import for the same bare-JSON reason. Guarded in the parity test. */
export const ORG_ADDON_RIDER_PLANS: readonly string[] = (seed.org_addons ?? []).map(
  (e) => e.plan_key,
);

/**
 * The credit-pack ladder's keys, IN SEED ORDER (SPEC-6 §A4).
 *
 * Mirrors `creditPackOptions` (src/lib/currency.ts), which maps the seed's
 * `packs` array straight through — so the Buy credits modal renders one radio
 * per entry here, in this order. Order matters to a caller, not just
 * membership: the modal's rungs are picked by index, and the parity test
 * compares the whole sequence rather than a set.
 */
export const CREDIT_PACK_KEYS: readonly string[] = (seed.packs ?? []).map((p) => p.key);

/**
 * One credit pack's price in minor units — `creditPackOptions`'s `amountMinor`.
 *
 * THROWS on an unknown key rather than returning 0: a 0 would render to a buyer
 * as a free pack, which is the same failure `orgAddonMinor`'s null branch above
 * exists to prevent, and a spec asking for a rung the seed does not sell has a
 * stale expectation that must be loud.
 */
export function creditPackMinor(key: string, currency: Currency = DEFAULT_CURRENCY): number {
  const pack = (seed.packs ?? []).find((p) => p.key === key);
  if (!pack) throw new Error(`stripe-plans.json sells no credit pack "${key}"`);
  return amountFor(pack.price, currency);
}

/** The rendered price of one pack — what the modal's radio row shows and what
 *  its `Pay {price}` button quotes for the selected rung. */
export function creditPackLabel(key: string, currency: Currency = DEFAULT_CURRENCY): string {
  return money(creditPackMinor(key, currency), currency);
}
