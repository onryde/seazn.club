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
import { afterAll, describe, expect, it } from "vitest";
import seed from "../stripe-plans.json";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { sql } from "@/lib/db";

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

// ── The credit packs against the plan that already includes credits ──────────
//
// Added W3 (2026-09-04). Every rule above compares a subscription to a pass —
// packaging against packaging. Nothing compared a CONSUMABLE to the plan whose
// allowance it tops up, and that gap is precisely what let the INR credit packs
// sit at twice the multiple every other market paid, for a whole wave: the
// plans were re-anchored to per-market set points and the packs were carried
// forward as "unchanged", which leaves a dollar-priced SKU in a rupee-priced
// catalogue. Nothing was red, because nothing was looking.
//
// THE INVARIANT IS A RATIO, NOT AN AMOUNT. Every amount in this seed is a SET
// price point per market (v3/07 §4, never an FX conversion), so no two
// currencies' absolute numbers are comparable at all. What IS one decision,
// made once and merely expressed four times, is how a pack's per-credit price
// relates to the per-credit rate of the plan that includes credits. So each
// market's pack-to-plan multiple is checked against the seed's OWN anchor
// currency's multiple. A re-anchoring that moves the plans and forgets the
// packs moves that multiple in exactly one market — which is the shape this
// rule sees and no absolute bound can.
//
// BOTH SIDES ARE READ FROM THEIR SOURCE OF TRUTH: the pack amount and its
// `credits` grant from the seed, the plan's included allowance from the live
// `plan_entitlements` matrix. That allowance is not a stable number — V393 cut
// Pro from 60 to 35 and V395 from 35 to 25 inside a single wave — so a count
// typed here would already have been stale twice, and would have moved this
// rule's verdict without anyone repricing anything. It is why this block needs
// a database when the six rules above do not; it carries the repo's standard
// HAS_DB guard and skips cleanly without one, the same way every other
// DB-backed suite here does.

const HAS_DB = !!process.env.DATABASE_URL;

interface Pack {
  key: string;
  /** Our own field, never sent to Stripe: the credits this pack grants. */
  credits: number;
  price: Amount & { lookup_key: string };
}
const packs = (seed as unknown as { packs?: Pack[] }).packs ?? [];

/** The seed's own declared base currency — the one `point()` reads out of
 *  `unit_amount` — used as the anchor every other market is compared against.
 *  Read from the file rather than typed here, so re-anchoring the catalogue
 *  itself moves the reference with it. */
const ANCHOR_CURRENCY: string = seed.currency;

/**
 * How far a market's pack-to-plan multiple may sit from the anchor market's.
 *
 * A band rather than the equality the charm rule uses, because these are set
 * price points and not conversions: the packs are priced in whole units of
 * each currency against a plan priced on the charm grid, so a few points of
 * drift is the arithmetic and not a decision. Today the widest legitimate gap
 * is gbp at +9.1% (£8 against a £10.99 plan), then eur at +6.2%. A quarter
 * leaves that room twice over and still refuses the fault this rule exists
 * for, which was a clean 2.00x.
 */
const PACK_MULTIPLE_TOLERANCE = 0.25;

/** One pack's price per credit in one market, in minor units. */
const packPerCredit = (pack: Pack, currency: string): number =>
  point(pack.price, currency) / pack.credits;

/** A pack's per-credit price as a multiple of the per-credit rate a plan's own
 *  monthly price implies. Both sides in the same market, so the market's set
 *  points cancel and what is left is the product decision. */
const packMultiple = (
  pack: Pack,
  plan: { price: TieredPrice; included: number },
  currency: string,
): number => packPerCredit(pack, currency) / (point(plan.price, currency) / plan.included);

/** `ai.credits.monthly` for a plan key, read from the live matrix. Returns null
 *  for a plan that carries no row (the Event Pass rungs do not — their grant is
 *  one-time), which is not a fault, only a plan this rule cannot speak about. */
async function includedCredits(planKey: string): Promise<number | null> {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'ai.credits.monthly'`;
  return row?.int_value ?? null;
}

/** Every seed plan the comparison can actually be made against: a graduated
 *  plan that carries a monthly credit allowance. Derived on both sides, so a
 *  second such plan is checked the day it lands. */
async function ratedPlans(): Promise<Array<{ key: string; price: TieredPrice; included: number }>> {
  const out: Array<{ key: string; price: TieredPrice; included: number }> = [];
  for (const plan of tieredPlans) {
    const included = await includedCredits(plan.key);
    if (typeof included === "number" && included > 0) {
      out.push({ key: plan.key, price: plan.prices.monthly, included });
    }
  }
  return out;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("stripe-plans ladder — credit packs against the plan that includes credits", () => {
  it("prices every pack at the same multiple of the plan's included rate in every market", async () => {
    const rated = await ratedPlans();
    expect(
      rated.map((p) => p.key),
      "no seed plan carries an ai.credits.monthly row — there is nothing to compare a pack against",
    ).not.toEqual([]);
    expect(packs.length, "the seed has no credit packs to check").toBeGreaterThan(1);

    const faults: string[] = [];
    let compared = 0;
    for (const plan of rated) {
      for (const pack of packs) {
        // A pack that grants nothing would make every multiple Infinity and
        // every comparison below meaningless rather than false.
        expect(pack.credits, `${pack.key} grants no credits`).toBeGreaterThan(0);
        const anchor = packMultiple(pack, plan, ANCHOR_CURRENCY);
        for (const currency of SUPPORTED_CURRENCIES) {
          if (currency === ANCHOR_CURRENCY) continue;
          compared += 1;
          const here = packMultiple(pack, plan, currency);
          const drift = here / anchor - 1;
          if (Math.abs(drift) > PACK_MULTIPLE_TOLERANCE) {
            faults.push(
              `${pack.key} ${currency}: ${here.toFixed(3)}x ${plan.key}'s included rate, against ${anchor.toFixed(3)}x in ${ANCHOR_CURRENCY} (${(drift * 100).toFixed(1)}% adrift)`,
            );
          }
        }
      }
    }
    expect(faults).toEqual([]);
    // ANTI-VACUITY. Every fault above comes out of a nested loop, and a loop
    // over an empty collection reports clean. The count is asserted EXACTLY and
    // derived from the three collections, so a seed section renamed out from
    // under `packs`, a plan that lost its matrix row, or a currency list that
    // silently emptied is a red here rather than a quiet pass.
    expect(compared, "no pack/market pair was compared").toBe(
      rated.length * packs.length * (SUPPORTED_CURRENCIES.length - 1),
    );
  });

  it("never prices a pack above the included rate itself — a top-up is not a dominated SKU", async () => {
    // The pack's per-credit price against the plan's whole monthly price
    // divided by the allowance it includes. That divisor deliberately
    // OVERSTATES what the included credits cost, because a subscription buys
    // far more than credits — so this is a floor with a lot of daylight (the
    // dearest pack today sits at 0.455x) and a breach means the top-up costs
    // more per credit than simply buying the plan that includes them. Nobody
    // rational buys that, and it is reachable without breaking the parity rule
    // above: raising every market's pack together keeps them consistent with
    // each other while making all four dominated.
    const rated = await ratedPlans();
    expect(
      rated.map((p) => p.key),
      "no seed plan carries an ai.credits.monthly row — there is nothing to compare a pack against",
    ).not.toEqual([]);

    const faults: string[] = [];
    let compared = 0;
    for (const plan of rated) {
      for (const pack of packs) {
        for (const currency of SUPPORTED_CURRENCIES) {
          compared += 1;
          const multiple = packMultiple(pack, plan, currency);
          if (multiple >= 1) {
            faults.push(
              `${pack.key} ${currency}: ${multiple.toFixed(3)}x ${plan.key}'s included rate — the top-up costs more per credit than the plan that includes them`,
            );
          }
        }
      }
    }
    expect(faults).toEqual([]);
    expect(compared, "no pack/market pair was compared").toBe(
      rated.length * packs.length * SUPPORTED_CURRENCIES.length,
    );
  });
});

// ── The PLATFORM FEE ladder, in `plan_entitlements` ──────────────────────────
//
// Added after the W2 pass-4 review (2026-09-04) found the V398 guard NULL-blind.
//
// V398 re-cut `registration.fee_percent` for the additive fee model and closed
// with a `do $$` block that lists the five rates and raises on "a rate this
// migration does not set". That block is written as
// `(plan_key, int_value) not in (...)`, and SQL's three-valued logic makes it
// blind twice over: a row whose `int_value` is NULL compares UNKNOWN and is
// never selected, and a ladder with NO ROWS AT ALL `string_agg`s to NULL, which
// the `if wrong is not null` reads as clean. It also runs exactly once, at
// apply time — every way the ladder can rot arrives AFTER that.
//
// NULL IS NOT UNLIMITED HERE. Everywhere else in this matrix a null `int_value`
// means "no ceiling" (V393's header states it, and `compareCell` renders it as
// "Unlimited"). A RATE has no such reading: `feePercentFor` resolves
// `getLimit(...) == null || <= 0` to `platformFeeDefault()`, which is 5. So a
// null on `pro` does not make Pro's registrations free and does not make them
// uncapped — it silently charges an organiser sold 2% the Free rate of 5%, on
// every entry, with nothing anywhere going red. A MISSING row lands in the same
// place by a different route (`getLimit` reads no row as 0, and `<= 0` falls
// through to the same default), which is why coverage and nullity are both
// faults here rather than one being the other's proxy.
//
// Every rate is READ, never typed — the file rule at the top of this test. What
// is stated here is the SHAPE the rates have to keep, so a legitimate reprice
// moves the numbers and this block still refuses the combinations the owner
// ruled out.

/** `plan_key` → `registration.fee_percent`.`int_value`. A key absent from the
 *  map is a plan with NO ROW, which is a different fault from a null rate. */
type FeeRates = ReadonlyMap<string, number | null>;

interface LadderShape {
  /** Every plan key the `plans` table holds — each one owes a rate. */
  plans: readonly string[];
  /** The plan an organiser pays us nothing for: it must charge the MOST. */
  free: string;
  /** The cheapest graduated subscription — the plan the entry rung is a
   *  strict subset of, which is why its rate must be the better one. */
  entry: string;
  /** The pass rungs, from the seed. */
  rungs: readonly string[];
}

/**
 * Every way the live fee ladder can be wrong, as strings. A faults array rather
 * than an assertion per rule so one run reports the whole ladder — the shape
 * `feeLadderFaults` in `lib/copy-truth.ts` already uses for the published fee
 * tables this matrix is the source of truth for.
 */
function feeLadderFaults(rates: FeeRates, shape: LadderShape): string[] {
  // THE EMPTY CASE FIRST. Every rule below is a loop or a lookup, and both
  // answer "nothing is wrong" over an empty collection — which is exactly how
  // V398's own guard passes on a ladder with no rows at all. An empty input is
  // reported here and nothing else is, because every later verdict would be
  // vacuous rather than clean.
  const empty: string[] = [];
  if (shape.plans.length === 0) empty.push("fee ladder: no plan keys to check");
  if (shape.rungs.length === 0) empty.push("fee ladder: no pass rungs to check");
  if (rates.size === 0) empty.push("fee ladder: registration.fee_percent has no rows at all");
  if (empty.length > 0) return empty;

  const faults: string[] = [];
  /** The rates this function can actually reason about: present, non-null and
   *  in range. Everything else is faulted on the way in. */
  const usable = new Map<string, number>();

  for (const plan of shape.plans) {
    if (!rates.has(plan)) {
      faults.push(
        `${plan}: no registration.fee_percent row — getLimit reads a missing row as 0 and feePercentFor charges platformFeeDefault() instead`,
      );
      continue;
    }
    const rate = rates.get(plan) ?? null;
    if (rate === null) {
      faults.push(
        `${plan}: registration.fee_percent is NULL — null means UNLIMITED for a cap key, but for a rate feePercentFor reads it as unset and charges platformFeeDefault() instead`,
      );
    } else if (rate <= 0) {
      faults.push(
        `${plan}: registration.fee_percent is ${rate} — a plan row of 0 or less means "this plan sets no rate", so feePercentFor charges platformFeeDefault() instead`,
      );
    } else if (rate > 100) {
      faults.push(`${plan}: registration.fee_percent is ${rate}%, which is more than the whole fee`);
    } else {
      usable.set(plan, rate);
    }
  }

  // Paying us must buy a lower cut. This is the whole shape of the V398 ladder
  // and the claim the /pricing Event Pass card makes in words ("not 5%").
  const free = usable.get(shape.free);
  if (free === undefined) {
    faults.push(`the free plan (${shape.free}) has no usable rate — the ladder has no anchor`);
  } else {
    for (const [plan, rate] of usable) {
      if (plan === shape.free) continue;
      if (rate >= free) {
        faults.push(
          `${plan}: ${rate}% does not undercut the free plan's ${free}% — an organiser who pays us a subscription or a pass must pay a smaller cut`,
        );
      }
    }
  }

  // ...and the pass must stay the DEARER rate. Pass M is a strict subset of the
  // entry plan on every other axis (see "keeps the entry pass rung under a
  // MONTH of the plan that dominates it" above, which names the entry-fee rate
  // as one of them). A rung that also charged less would make the subscription
  // the dominated buy on every axis at once.
  const entry = usable.get(shape.entry);
  if (entry !== undefined) {
    for (const rung of shape.rungs) {
      const rate = usable.get(rung);
      if (rate !== undefined && rate <= entry) {
        faults.push(
          `${rung}: ${rate}% is not dearer than the ${shape.entry} plan's ${entry}% — the rung is a subset of that plan on every other axis, so the subscription would be dominated`,
        );
      }
    }
  }

  return faults;
}

describe("the platform fee ladder — the rules themselves", () => {
  // The live matrix satisfies every rule below, so running these against the
  // database alone would prove only that today's data is fine and nothing about
  // whether the guard can SEE the faults it is written for. These are the
  // mutants, as cases.
  const LIVE: LadderShape = {
    plans: ["community", "pro", "event_pass", "event_pass_l", "enterprise"],
    free: "community",
    entry: "pro",
    rungs: ["event_pass", "event_pass_l"],
  };
  const rates = (over: Record<string, number | null> = {}): FeeRates =>
    new Map<string, number | null>(
      Object.entries({
        community: 5,
        pro: 2,
        event_pass: 4,
        event_pass_l: 4,
        enterprise: 1,
        ...over,
      }),
    );

  it("passes a ladder shaped like today's", () => {
    expect(feeLadderFaults(rates(), LIVE)).toEqual([]);
  });

  it("reports the EMPTY ladder rather than reading it as clean", () => {
    // V398's `do $$` block string_aggs an empty ladder to NULL and its
    // `if wrong is not null` calls that clean. The empty set answers "no" to
    // every question a fault rule asks.
    expect(feeLadderFaults(new Map(), LIVE)).toEqual([
      "fee ladder: registration.fee_percent has no rows at all",
    ]);
    expect(feeLadderFaults(rates(), { ...LIVE, plans: [] }).join(" ")).toContain("no plan keys");
    expect(feeLadderFaults(rates(), { ...LIVE, rungs: [] }).join(" ")).toContain("no pass rungs");
  });

  it("faults a NULL rate, naming what it silently charges instead", () => {
    // The finding: `(plan_key, int_value) not in (...)` compares UNKNOWN
    // against a null and never selects the row, so V398's guard would have
    // passed a Pro plan quietly charging the 5% platform default.
    const faults = feeLadderFaults(rates({ pro: null }), LIVE);
    expect(faults.join(" ")).toContain("pro: registration.fee_percent is NULL");
    expect(faults.join(" ")).toContain("platformFeeDefault()");
  });

  it("faults a MISSING rate, which lands in the same place by another route", () => {
    const missing = new Map(rates());
    missing.delete("pro");
    expect(feeLadderFaults(missing, LIVE).join(" ")).toContain("pro: no registration.fee_percent row");
  });

  it("faults a zero rate — a plan row of 0 means unset, never free", () => {
    expect(feeLadderFaults(rates({ pro: 0 }), LIVE).join(" ")).toContain(
      'pro: registration.fee_percent is 0',
    );
  });

  it("faults a paid plan that does not undercut the free rate", () => {
    expect(feeLadderFaults(rates({ pro: 5 }), LIVE).join(" ")).toContain("does not undercut");
    expect(feeLadderFaults(rates({ event_pass: 6 }), LIVE).join(" ")).toContain("does not undercut");
  });

  it("faults a pass rung priced better than the plan that dominates it", () => {
    expect(feeLadderFaults(rates({ event_pass: 2 }), LIVE).join(" ")).toContain("is not dearer");
    expect(feeLadderFaults(rates({ event_pass_l: 1 }), LIVE).join(" ")).toContain("is not dearer");
  });
});

describe.skipIf(!HAS_DB)("the platform fee ladder — the live matrix", () => {
  /** Every plan key the product actually sells or grants. */
  async function liveShape(): Promise<{ shape: LadderShape; rates: FeeRates }> {
    const planRows = await sql<{ key: string; is_public: boolean }[]>`
      select key, is_public from plans order by key`;
    const rateRows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
       where feature_key = 'registration.fee_percent'`;

    // The free plan, DERIVED: the one public plan the Stripe seed does not sell.
    // Named nowhere here, so a second free tier is a visible fault rather than
    // a silently unchecked one.
    const sold = new Set(plans.map((p) => p.key));
    const free = planRows.filter((p) => p.is_public && !sold.has(p.key)).map((p) => p.key);
    expect(free, "exactly one public plan should carry no Stripe price").toHaveLength(1);

    // The entry subscription: the cheapest graduated plan, the same derivation
    // `entryMonthly` uses for the price bounds above.
    const entry = [...tieredPlans].sort(
      (a, b) => point(a.prices.monthly, ANCHOR_CURRENCY) - point(b.prices.monthly, ANCHOR_CURRENCY),
    )[0]!;

    return {
      shape: {
        plans: planRows.map((p) => p.key),
        free: free[0]!,
        entry: entry.key,
        rungs: passes.map((p) => p.key),
      },
      rates: new Map(rateRows.map((r) => [r.plan_key, r.int_value])),
    };
  }

  it("has a ladder in the database to check at all", async () => {
    const { shape, rates } = await liveShape();
    expect(shape.plans.length, "no plans").toBeGreaterThan(1);
    expect(rates.size, "registration.fee_percent has no rows").toBeGreaterThan(1);
    expect(shape.rungs.length, "no pass rungs").toBeGreaterThan(1);
  });

  it("carries a usable rate for every plan and keeps the ladder's order", async () => {
    const { shape, rates } = await liveShape();
    expect(feeLadderFaults(rates, shape)).toEqual([]);
  });
});
