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
//   * an extra organisation (the graduated tier 2+ rider) is half the base
//     FLOORED TO THE CHARM GRID — exactly that, not merely "at most half";
//   * every SET point sits ON that charm grid (AI credit packs excepted, and
//     the exception is asserted rather than assumed);
//   * the Event Pass rungs are ordered M < L and both sit under a year of the
//     cheapest subscription;
//   * the M rung sits under a MONTH of it;
//   * 3 × L >= that annual price, so a third pass is a nudge to subscribe;
//   * 2 × L < it, so a two-tournament organiser is never pushed into one.
//
// Two of those changed with the additive-fee reprice (W3, 2026-09-04):
//
// THE ROUNDING RULE WAS REWORDED, not re-run. It read "half the base rounded
// DOWN to a whole major unit (INR to the nearest x99)", which stopped being
// true the moment the prices became charm points: half of $14.99 is $7.495 and
// the rider is $6.99, not $7. A rule the seed no longer obeys is worse than no
// rule, because the next editor reads it and reprices to match the sentence.
// It is now expressed as one function, `charmFloor`, and asserted EXACTLY —
// where the old wording could only ever be checked as an inequality.
//
// THE M RUNG GAINED A CEILING. Nothing stopped Pass M from costing more than a
// month of Pro, and at the pre-W3 prices ($15 M against $12/month Pro) nothing
// had. Pass M is a strict SUBSET of Pro on every axis the two share — 10
// divisions against 20, 128 entrants against 256, 4 stages against 6, 5 restore
// points against 10, and a higher entry-fee rate — so a rung dearer than one
// month of the plan that dominates it is a product nobody rational buys. It was
// invisible because every existing bound compared the rungs against the ANNUAL
// price, where $15 < $99 passes comfortably.
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

/** The cheapest MONTHLY subscription in a currency — one month of the plan the
 *  entry pass rung is a strict subset of. Derived the same way `entryAnnual`
 *  is, and for the same reason. */
const entryMonthly = (currency: string): number =>
  Math.min(...tieredPlans.map((p) => point(p.prices.monthly, currency)));

/** The pass rungs ordered by their canonical (usd) price: smallest is M, the
 *  largest is the L rung every bound below is written about. */
const rungsByPrice = [...passes].sort((a, b) => a.price.unit_amount - b.price.unit_amount);

// ── The charm grid ───────────────────────────────────────────────────────────
//
// Every SET point in the seed is a charm price, and "charm" is not the same
// shape in every market. A rule that says "x.99" would be wrong for INR, where
// the idiom is a whole-rupee x99 (₹599, ₹4,999) and paise-level .99 reads as a
// conversion artefact rather than a price. So the grid is per-currency: the
// charm points are `tail`, `tail + step`, `tail + 2·step`, … in MINOR units.

interface CharmGrid {
  step: number;
  tail: number;
}
const CHARM_GRID: Record<string, CharmGrid> = {
  // ₹99, ₹199, ₹299 … — whole rupees, no paise. Owner ruling 2026-09-04.
  inr: { step: 100_00, tail: 99_00 },
};
/** `<major>.99` — $6.99, €5.99, £4.99 — one major unit apart. */
const DEFAULT_CHARM: CharmGrid = { step: 1_00, tail: 99 };
const charmGrid = (currency: string): CharmGrid => CHARM_GRID[currency] ?? DEFAULT_CHARM;

const onCharmGrid = (amount: number, currency: string): boolean => {
  const { step, tail } = charmGrid(currency);
  return amount >= tail && (amount - tail) % step === 0;
};
/** The largest charm point at or below `amount` — the rounding rule itself,
 *  expressed once so the seed and this test cannot describe it differently. */
const charmFloor = (amount: number, currency: string): number => {
  const { step, tail } = charmGrid(currency);
  return Math.floor((amount - tail) / step) * step + tail;
};

/**
 * Every SET point in the seed, walked from the file's OWN top-level arrays
 * rather than from a list of section names typed here — a new SKU array added
 * to the seed is checked the day it lands, or (if its section is unknown to
 * the exemption below) reported as unclassified. That is the difference
 * between a sweep and a spot-check: `feeLadderFaults` was scoped to one file
 * for a whole wave while two unscanned copies of its table drifted.
 */
const AMOUNT_GROUPS = Object.entries(seed as unknown as Record<string, unknown>).filter(
  (pair): pair is [string, Array<Record<string, unknown>>] => Array.isArray(pair[1]),
);

/**
 * Sections whose amounts are deliberately ROUND rather than charm points.
 *
 * design/v3/07 §3a marks the AI credit packs so on purpose and gives the
 * reason: "credits are compute, not packaging". A pack is bought as a quantity
 * of a metered resource — $10 buys 40 credits — and $9.99 for 40 credits reads
 * as a discount on a thing whose price is arithmetic, not as a keen price. The
 * v18 reprice left them alone for the same reason and so did W3's. Named here,
 * with the reason, so a later reader can tell a deliberate exception from an
 * oversight — which is exactly how these amounts would otherwise read.
 */
const ROUND_BY_DESIGN = new Set(["packs"]);

/** Every `{label, node}` price node an entry carries, tiers included. */
function nodesOf(entry: Record<string, unknown>): Array<{ label: string; node: Amount }> {
  const key = String(entry.key);
  const out: Array<{ label: string; node: Amount }> = [];
  const push = (label: string, price: TieredPrice | Amount) => {
    out.push({ label, node: price });
    const tiers = (price as TieredPrice).tiers ?? [];
    tiers.forEach((tier, i) => out.push({ label: `${label} tier ${i + 1}`, node: tier }));
  };
  if (entry.price) push(key, entry.price as TieredPrice);
  for (const [interval, price] of Object.entries((entry.prices ?? {}) as Record<string, TieredPrice>)) {
    push(`${key} ${interval}`, price);
  }
  return out;
}

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

  it("sets each extra organisation at EXACTLY half the base, floored to the charm grid", () => {
    // The rounding rule itself, not the inequality it implies. The test above
    // refuses a rider dearer than half; this one refuses every OTHER value —
    // including a rider set too LOW, which the at-most-half bound welcomes and
    // which is the shape a fat-fingered reprice actually takes.
    //
    // It is asserted as an equality against `charmFloor` rather than as a
    // range, because the rule is a computation: the seed's author performs it
    // by hand for eight numbers, and a range would accept seven of the eight
    // being off by a grid step.
    const faults: string[] = [];
    for (const plan of tieredPlans) {
      for (const interval of ["monthly", "annual"] as const) {
        const { base, rider } = ladder(plan.prices[interval]);
        for (const currency of SUPPORTED_CURRENCIES) {
          const expected = charmFloor(point(base, currency) / 2, currency);
          const actual = point(rider, currency);
          if (actual !== expected) {
            faults.push(
              `${plan.key} ${interval} ${currency}: rider ${actual}, but half of ${point(base, currency)} floored to the charm grid is ${expected}`,
            );
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });

  it("sets every price point ON the charm grid, the AI credit packs excepted", () => {
    const faults: string[] = [];
    const exempted: string[] = [];
    let checked = 0;
    for (const [group, entries] of AMOUNT_GROUPS) {
      if (ROUND_BY_DESIGN.has(group)) {
        exempted.push(group);
        // The exception is not a licence to be EMPTY: a section that lost its
        // entries would otherwise satisfy this rule by having nothing in it.
        expect(entries.length, `${group} is exempt from the charm grid but carries no prices`).toBeGreaterThan(0);
        continue;
      }
      for (const entry of entries) {
        for (const { label, node } of nodesOf(entry)) {
          for (const currency of SUPPORTED_CURRENCIES) {
            const amount = point(node, currency);
            checked += 1;
            if (!onCharmGrid(amount, currency)) {
              const { tail, step } = charmGrid(currency);
              faults.push(
                `${group}/${label} ${currency}: ${amount} is not a charm point (${tail}, ${tail + step}, ${tail + 2 * step}, …)`,
              );
            }
          }
        }
      }
    }
    expect(faults).toEqual([]);
    // ANTI-VACUITY, both halves. A walker that stopped finding nodes (a seed
    // section renamed, `nodesOf` blinded by a shape change) checks nothing and
    // reports clean; and an exemption list that quietly grew would hide the
    // next section rather than the one it was written for.
    expect(checked, "no price point was checked — the seed walker found nothing").toBeGreaterThan(30);
    expect(exempted.sort()).toEqual([...ROUND_BY_DESIGN].sort());
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

  it("keeps the entry pass rung under a MONTH of the plan that dominates it", () => {
    // Added W3 (2026-09-04) after its absence let a dominated rung ship. Pass M
    // is a strict subset of Pro on every axis the two share — 10 divisions
    // against 20, 128 entrants against 256, 4 stages against 6, 5 restore
    // points against 10, and a dearer entry-fee rate — so an organiser who can
    // rent the superset for a month has no reason to buy the subset outright.
    // At the pre-W3 prices the seed said $15 for M against $12/month for Pro
    // and every guard here passed, because all of them compared the rungs
    // against the ANNUAL price.
    //
    // Written about the CHEAPEST rung rather than named as "M": the bound is a
    // property of the smallest rung, and it does not hold for L (which is not a
    // subset of Pro — its entrant cap is higher).
    const entry = rungsByPrice[0]!;
    const faults: string[] = [];
    for (const currency of SUPPORTED_CURRENCIES) {
      const monthly = entryMonthly(currency);
      const rung = point(entry.price, currency);
      if (rung >= monthly) {
        faults.push(
          `${entry.key} ${currency}: ${rung} is not under one month of the entry plan (${monthly}) — the rung is dominated`,
        );
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
