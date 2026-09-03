// THE PRICE LADDER, checked against the RULES the prices were set to satisfy —
// not against a table of the amounts themselves.
//
// `stripe-plans.test.ts` beside this one is seed-INTERNAL: unique lookup keys,
// a point in every currency, M < L. Nothing anywhere asserted that the amounts
// obey the relationships the pricing decision was actually made on, so the
// entitlements v18 reprice (2026-09-03, every amount in the file rewritten in
// four currencies and two graduated tiers) had no guard at all — a slipped
// digit would have shipped as a live price.
//
// Every number here is READ FROM THE SEED. A table of expected amounts typed
// into a test freezes today's prices and reds on the next legitimate reprice,
// which teaches the next editor to retype the table instead of re-checking the
// rules; a rule read from the seed moves with the prices and still refuses the
// combinations the owner ruled out.
//
// The rules, from the entitlements v18 plan (§"The price table as it will be
// written") and design/v3/07 §3a:
//   * a year costs 8–9 months of the same plan (the annual discount);
//   * an extra organisation (the graduated tier 2+ rider) is AT MOST half the
//     base — at most, not exactly, because the seed rounds DOWN to a whole
//     major unit, and INR to the nearest x99 (₹499 → ₹199, 40%);
//   * the Event Pass rungs are ordered M < L and both sit under a year of the
//     cheapest subscription;
//   * 3 × L >= that annual price, so a third pass is a nudge to subscribe;
//   * 2 × L < it, so a two-tournament organiser is never pushed into one.
import { describe, expect, it } from "vitest";
import seed from "../stripe-plans.json";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";

interface Amount {
  unit_amount: number;
  currency_options?: Record<string, number>;
}
interface Tier extends Amount {
  up_to: number | string;
}
interface TieredPrice extends Amount {
  lookup_key: string;
  tiers?: Tier[];
}
interface Plan {
  key: string;
  prices: { monthly: TieredPrice; annual: TieredPrice };
}
interface Pass {
  key: string;
  price: Amount & { lookup_key: string };
}

const plans = seed.plans as unknown as Plan[];
const passes = seed.passes as unknown as Pass[];

/**
 * Subscription plans sold on a graduated ladder — the ones these rules are
 * about. Derived, so a future plan that ships without tiers is simply not a
 * ladder rather than a crash, and a future SECOND tiered plan is checked the
 * day it lands instead of being invisible to a hardcoded `find("pro")`.
 */
const tieredPlans = plans.filter((p) => (p.prices.monthly.tiers?.length ?? 0) > 1);

/** One SET price point, in minor units. Deliberately does NOT fall back to
 *  `unit_amount` the way `lib/currency.ts`'s `amountFor` does: a missing point
 *  is a hole (`stripe-plans.test.ts` owns that fault), and silently comparing
 *  the usd number here would make every rule below pass on it. */
function point(node: Amount, currency: string): number {
  const value = currency === "usd" ? node.unit_amount : node.currency_options?.[currency];
  if (typeof value !== "number") {
    throw new Error(`the seed has no ${currency} point to check (currency coverage is a fault)`);
  }
  return value;
}

/** The base rung and the extra-organisation rider of a graduated price, by
 *  POSITION rather than by `up_to`, so a ladder that grows a middle rung is a
 *  visible change here rather than a silently skipped one. */
function ladder(price: TieredPrice): { base: Tier; rider: Tier } {
  const tiers = price.tiers ?? [];
  return { base: tiers[0]!, rider: tiers[tiers.length - 1]! };
}

/** The cheapest annual subscription in a currency — what an Event Pass buyer is
 *  choosing against. Derived rather than named, so the bound follows the entry
 *  plan if the ladder ever gains a cheaper or a dearer tier above it. */
const entryAnnual = (currency: string): number =>
  Math.min(...tieredPlans.map((p) => point(p.prices.annual, currency)));

/** The pass rungs ordered by their canonical (usd) price: smallest is M, the
 *  largest is the L rung every bound below is written about. */
const rungsByPrice = [...passes].sort((a, b) => a.price.unit_amount - b.price.unit_amount);

describe("stripe-plans ladder", () => {
  // ANTI-VACUITY. Every rule below is a loop, and a loop over an empty
  // collection passes while checking nothing — the failure mode that would let
  // a renamed section (or a currency list that silently emptied) read as green.
  it("has a ladder, two pass rungs and four currencies to check", () => {
    expect(tieredPlans.map((p) => p.key), "no graduated plan to check").not.toEqual([]);
    expect(passes.length, "the pass bounds need at least two rungs").toBeGreaterThan(1);
    expect(SUPPORTED_CURRENCIES.length, "no currency to check").toBeGreaterThanOrEqual(4);
    for (const plan of tieredPlans) {
      for (const interval of ["monthly", "annual"] as const) {
        expect(plan.prices[interval].tiers!.length, `${plan.key} ${interval} rungs`).toBe(2);
      }
    }
  });

  it("prices a year at 8 to 9 months of the same plan, in every currency", () => {
    const faults: string[] = [];
    for (const plan of tieredPlans) {
      for (const currency of SUPPORTED_CURRENCIES) {
        const monthly = point(plan.prices.monthly, currency);
        const annual = point(plan.prices.annual, currency);
        const months = annual / monthly;
        if (months < 8 || months > 9) {
          faults.push(`${plan.key} ${currency}: a year costs ${months.toFixed(2)} months`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it("charges AT MOST half the base for each extra organisation, every rung and currency", () => {
    // The claim four locales make in prose ("no more than half your plan's
    // rate"), and what `extraOrgPrice()` advertises. Rounding DOWN keeps this
    // true; a rounding rule that ever rounded up would break the copy silently.
    const faults: string[] = [];
    for (const plan of tieredPlans) {
      for (const interval of ["monthly", "annual"] as const) {
        const { base, rider } = ladder(plan.prices[interval]);
        for (const currency of SUPPORTED_CURRENCIES) {
          const half = point(base, currency) / 2;
          const extra = point(rider, currency);
          if (extra > half) {
            faults.push(`${plan.key} ${interval} ${currency}: rider ${extra} > half ${half}`);
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it("keeps tier 1 and the advertised unit_amount the same number", () => {
    // `lib/currency.ts` advertises `unit_amount`; Stripe bills tier 1. A drift
    // between them quotes one price and charges another.
    const faults: string[] = [];
    for (const plan of tieredPlans) {
      for (const interval of ["monthly", "annual"] as const) {
        const price = plan.prices[interval];
        const { base } = ladder(price);
        for (const currency of SUPPORTED_CURRENCIES) {
          if (point(base, currency) !== point(price, currency)) {
            faults.push(`${plan.key} ${interval} ${currency}: tier 1 != unit_amount`);
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it("orders the pass rungs and keeps every one under a year of the entry plan", () => {
    const faults: string[] = [];
    for (const currency of SUPPORTED_CURRENCIES) {
      const annual = entryAnnual(currency);
      let previous = 0;
      for (const rung of rungsByPrice) {
        const amount = point(rung.price, currency);
        if (amount <= previous) {
          faults.push(`${rung.key} ${currency}: ${amount} does not rise above ${previous}`);
        }
        if (amount >= annual) {
          faults.push(`${rung.key} ${currency}: ${amount} is not under the annual ${annual}`);
        }
        previous = amount;
      }
    }
    expect(faults).toEqual([]);
  });

  it("bounds the top pass rung against the annual price on BOTH sides", () => {
    // The nudge and its limit, from design/v3/07 §3a's own prose. Two passes
    // must stay cheaper than subscribing (an organiser running two tournaments
    // a year is not pushed onto a plan); three must not (a third is where the
    // subscription becomes the better buy).
    const top = rungsByPrice[rungsByPrice.length - 1]!;
    const faults: string[] = [];
    for (const currency of SUPPORTED_CURRENCIES) {
      const annual = entryAnnual(currency);
      const l = point(top.price, currency);
      if (3 * l < annual) faults.push(`${currency}: 3 x ${l} = ${3 * l} < annual ${annual}`);
      if (2 * l >= annual) faults.push(`${currency}: 2 x ${l} = ${2 * l} >= annual ${annual}`);
    }
    expect(faults).toEqual([]);
  });
});
