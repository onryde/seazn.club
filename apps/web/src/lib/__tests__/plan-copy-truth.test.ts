// Truth-in-copy guards for the Stripe seed (v17 gap wave 7, #298 / #299).
//
// The guards themselves live in `@/lib/copy-truth` — a plain module, so that
// Tasks 3, 4 and 7 can import the pattern lists without re-running this suite.
// This file is the application of them to `stripe-plans.json`, plus the
// rewording proofs that keep them honest.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`, not `src/__tests__/`. CI's
// unit job has no DATABASE_URL, and its two Postgres steps select
// `src/server src/lib` (.github/workflows/ci.yml:222) and `src/app` (:234).
// From `src/__tests__/` the entire `describe.skipIf(!HAS_DB)` half — cap↔matrix,
// the organisation allowance, the Pro Plus differentiator and the "largest
// grant" superlative — ran in NO job at all and reported 6 pending / exit 0.
// That is the exact failure vitest.config.ts's own header and ci.yml:215-220
// both document. Do not move this file out of a Postgres-covered tree.
import { afterAll, describe, expect, it } from "vitest";
import stripePlans from "@/config/stripe-plans.json";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { sql } from "@/lib/db";
import {
  type OrgAddon,
  type PricedPlan,
  type Rung,
  type RungCaps,
  type QuantifiedProduct,
  capClaimFaults,
  describedEntries,
  describedNameFaults,
  describedSections,
  orgAddonRiderFaults,
  passCreditGrantFaults,
  passDurationFaults,
  plusDifferentiatorFaults,
  productNameQuantityFaults,
  retiredRunCapFaults,
  riderRateFaults,
} from "@/lib/copy-truth";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** Same shape as pricing-cards.test.ts's capFor — duplicated locally rather
 *  than imported across test files. The row must EXIST: `int_value` is
 *  legitimately null on these columns (it means unlimited), so a missing row
 *  would otherwise read as "unlimited" and the copy check would sail on. */
const capFor = async (feature: string, plan: string): Promise<number | null> => {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
    where plan_key = ${plan} and feature_key = ${feature}`;
  expect(row, `plan_entitlements has no ${plan}/${feature} row`).toBeDefined();
  return row!.int_value;
};

// The `grants()` helper that used to sit here (a boolean read where a MISSING
// row denies, unlike `capFor` where absent is a matrix bug) went with the three
// deleted Pro Plus tests below — they were its only callers.

const seed = stripePlans as unknown as Record<string, unknown>;
const entries = describedEntries(seed);

/**
 * Everything a buyer reads that comes out of this seed — NAMES AS WELL AS
 * DESCRIPTIONS (fix round 6).
 *
 * The name is not metadata. Checkout renders the PRODUCT'S name as the
 * line-item label (`lib/credit-packs.ts:112` and `lib/size-packs.ts:231` both
 * send `line_items: [{ price }]`, so Stripe reads the label off the product),
 * `scripts/stripe-sync.ts` syncs name and description together on every run,
 * and `ci.yml` runs `stripe:sync` against the shared test-mode account on every
 * PR. Until this line changed, NOTHING in the repo read `product.name`: a probe
 * carrying "Event Pass — yours forever, never expires", "Event Pass L — 10 AI
 * schedule runs per division", "AI Credits — 4000" (seed: 40), "Size Pack —
 * +320 entrants" (delta_each: 32) and "Extra Organisation — Pro, half the base
 * rate" shipped 216 passed / 0 failed. Both flagship falsehoods of this wave,
 * on the payment page.
 */
const stripeRenderedText = entries.map((e) => `${e.name} | ${e.description}`).join(" | ");

/** The Event Pass rungs. EVERY guard iterates this rather than naming
 *  `event_pass`: v17 #294 added a second rung, and a guard hardcoded to the
 *  first key silently stops covering the product the moment a rung is added.
 *  Carries the NAME too — see `rungText` for which half of each rule reads it. */
const passRungs: Rung[] = stripePlans.passes.map((p) => ({
  key: p.key,
  name: p.product.name,
  description: p.product.description,
}));

/** The seed figures that are written into a product NAME, paired with the field
 *  they are supposed to equal. Built from the seed itself — never restated — so
 *  changing `credits` or `delta_each` and forgetting the label is a red. */
const quantifiedProducts: QuantifiedProduct[] = [
  ...stripePlans.packs.map((p) => ({
    key: p.key,
    name: p.product.name,
    field: "credits",
    quantity: p.credits,
  })),
  ...stripePlans.size_packs.map((p) => ({
    key: p.key,
    name: p.product.name,
    field: "delta_each",
    quantity: p.delta_each,
  })),
];

// `plusDescription` USED TO LIVE HERE, and its removal is the point.
//
//   const plusDescription = stripePlans.plans.find(p => p.key === "pro_plus")!.product.description;
//
// W2 T4 deleted `pro_plus` from the seed, so `.find()` returned undefined and
// the `!` threw AT MODULE SCOPE. The whole file then collected ZERO tests —
// which the JSON reporter reports as 0 failures, not as an error. This file is
// the only caller of `passCreditGrantFaults`, so the per-rung pass-credit
// change shipped with no running witness at all while the suite looked clean.
//
// The three tests that read it are gone with it (see below). Nothing replaces
// them: they asserted a description for a plan that no longer has one, and
// `enterprise` has no seed product to describe — it is not purchasable.

// ─────────────────────────────────────────────────────────────────────────────
// The guards, against the real seed.
// ─────────────────────────────────────────────────────────────────────────────

describe("stripe-plans.json names no retired feature and no false pass permanence", () => {
  // The scan is only as good as what it collects, and a hand-written section
  // list is itself the thing that must be remembered — v17 #293 found
  // `org_addons` had escaped the sibling seed guard's list for a whole wave.
  it("scans every described section in the file, including ones added later", () => {
    const walked = new Set(entries.map((e) => e.section));
    expect([...walked].sort()).toEqual(describedSections(seed).sort());

    // The count floor, DERIVED from the seed rather than typed. A literal
    // `expect(entries.length).toBeGreaterThan(10)` stood here and went stale
    // the moment W2 deleted two seed entries (the `pro_plus` plan and its
    // `extra_org_pro_plus` rider) — an anti-vacuity floor that is itself a
    // magic number rots exactly like the copy it exists to guard, and the
    // obvious repair is to lower the number, which guards less each time.
    //
    // Per-section equality is also strictly stronger than any total: a walk
    // that dropped one product out of `packs` still clears a total floor.
    const describedInSeed = new Map<string, number>();
    for (const section of describedSections(seed)) {
      const list = (seed[section] ?? []) as unknown[];
      describedInSeed.set(
        section,
        list.filter((e) => !!e && typeof e === "object" && "product" in e).length,
      );
    }
    expect(describedInSeed.size, "no described sections at all").toBeGreaterThan(0);
    for (const [section, expected] of describedInSeed) {
      expect(expected, `${section} carries no described products`).toBeGreaterThan(0);
      expect(entries.filter((e) => e.section === section).length, section).toBe(expected);
    }
  });

  // …and every field a buyer reads, not just the one the walk happened to
  // start with. The walk was general about SECTIONS and hardcoded about
  // FIELDS, which is the same failure one field over.
  it("collects the product NAME of every entry, so nothing is scanned blind", () => {
    expect(describedNameFaults(entries)).toEqual([]);
    // ANTI-VACUITY: names must actually be reaching the scan. An empty string
    // per entry would satisfy every negative rule above for free.
    expect(stripeRenderedText).toContain("Seazn Club Event Pass");
    expect(entries.every((e) => e.name.length > 0)).toBe(true);
  });

  // A figure in a Checkout line-item label, pinned to the seed field it is
  // supposed to be. `credits: 40/105/220/460` and `delta_each: 32` had no
  // check of any kind — "AI Credits — 4000" and "Size Pack — +320 entrants"
  // were both green.
  it("every quantity in a product name is the seed's own figure", () => {
    expect(productNameQuantityFaults(quantifiedProducts)).toEqual([]);
    // The rule must have had products to look at, and each must carry a digit —
    // a name with no number satisfies "quotes no OTHER number" vacuously.
    expect(quantifiedProducts.length).toBeGreaterThanOrEqual(5);
    expect(quantifiedProducts.every((p) => /\d/.test(p.name))).toBe(true);
  });

  it("quotes no retired per-division AI-run cap, in any section", () => {
    expect(retiredRunCapFaults(stripeRenderedText)).toEqual([]);
  });

  it("every Event Pass rung is sold as bounded, and says so", () => {
    expect(passDurationFaults(passRungs)).toEqual([]);
  });

  it("every Event Pass rung states ITS OWN one-time credit grant, and only that", () => {
    expect(passCreditGrantFaults(passRungs)).toEqual([]);
  });

  // The rungs are told apart ONLY by size, so everything else about them must
  // read identically — a difference in wording between two products that are
  // deliberately identical is how a buyer infers a difference that isn't there.
  it("describes both rungs in the same terms apart from their caps", () => {
    const shape = passRungs.map(({ description }) =>
      description
        .replace(/\b\d+\s+(entrants|divisions)\b/gi, "N $1")
        .replace(/\bunlimited\s+/gi, "N ")
        // W2 T5: the credit top-up is now a SIZE too — it is priced by rung —
        // so it is normalised alongside the caps. Without this the rule would
        // read two honest per-rung figures as "the copy diverged"; with it, a
        // difference in the WORDS around the number is still caught.
        .replace(/\+\d+\s+AI\s+credits\b/gi, "+N AI credits"),
    );
    expect(new Set(shape).size, `rung copy diverged:\n${shape.join("\n")}`).toBe(1);
  });

  // N1: the extra-organisation rider, checked against the claim the copy makes
  // about it. No DB — both halves are in the seed.
  it("charges no more for an extra organisation than the copy claims", () => {
    expect(riderRateFaults(stripePlans.plans as unknown as PricedPlan[])).toEqual([]);
  });

  // …and the same money charged the other way. The rate claim above is pinned
  // to the GRADUATED TIERS only, so an `org_addons` price could drift over half
  // the base with that guard green and the sentence still on the page. Parity
  // carries the ≤-half verdict across.
  it("charges the same for an extra organisation whichever way it is bought", () => {
    expect(
      orgAddonRiderFaults(
        stripePlans.plans as unknown as PricedPlan[],
        stripePlans.org_addons as unknown as OrgAddon[],
      ),
    ).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("stripe-plans.json quotes the numbers the matrix enforces", () => {
  it("every Event Pass rung quotes its OWN live caps, and no other rung's", async () => {
    const caps: RungCaps[] = [];
    for (const { key } of passRungs) {
      caps.push({
        key,
        entrants: await capFor("entrants.per_division.max", key),
        divisions: await capFor("divisions.per_competition.max", key),
      });
    }
    expect(capClaimFaults(passRungs, caps)).toEqual([]);
  });

  // The pass grant is a ONE-TIME top-up: neither rung has an
  // `ai.credits.monthly` row, which is what makes "monthly" a false word in
  // that copy rather than a stylistic one, and PASS_CREDIT_GRANT its single
  // source.
  it("neither rung carries a monthly credit allowance in the matrix", async () => {
    // W2 T5: the one-time grant is per rung (25 on M, 50 on L). "One-time" is
    // still what makes "monthly" a false word here, and the absence of a
    // `ai.credits.monthly` row is still what makes PASS_CREDIT_GRANT its single
    // source — what moved is that there are now two sources, one per rung.
    expect(PASS_CREDIT_GRANT).toEqual({ event_pass: 25, event_pass_l: 50 });
    for (const { key } of passRungs) {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${key} and feature_key = 'ai.credits.monthly'`;
      expect(row, `${key} must have no monthly credit row`).toBeUndefined();
    }
  });

  // THREE TESTS WERE DELETED HERE by W2 (entitlements v18, V391), all three
  // reading the retired `pro_plus` product description out of the seed:
  //
  //   • "Pro Plus claims no differentiator that Pro already has"
  //   • "Pro Plus's unlimited-scale claim is unlimited on Plus and capped on Pro"
  //   • "Pro Plus's 'largest credit grant' claim is the matrix's strict maximum"
  //
  // They are DELETED rather than repointed at `enterprise`, and the reason is
  // not that the tier changed name. Enterprise has no `stripe-plans.json`
  // entry at all — design §4 makes it a Contact-us conversation, never a
  // priced, self-serve SKU — so there is no seed description for any of the
  // three to read. A guard over a description that does not exist would pass
  // vacuously, which is worse than its absence.
  //
  // The mechanism each one proved is NOT lost:
  //   • the differentiator-frame logic keeps its own pure rewording proof
  //     further down this file (it drives `plusDifferentiatorFaults` on
  //     fixture strings, no seed involved);
  //   • "quotes its own live organisation allowance" below still walks every
  //     plan the seed DOES carry;
  //   • the credit-superlative check has nothing left to guard: no surviving
  //     seed description claims a credit superlative. If Enterprise ever gains
  //     public copy, that copy needs this check rebuilt against it — recorded
  //     as owed in the v18 _INDEX.md.

  // Every plan description quotes its group ceiling in prose. That number is
  // `orgs.max_owned`, and exceeding it is a PURCHASE (the extra-org add-on,
  // v17 #293) — so the figure is the included allowance, not a hard wall, and
  // it has to track the matrix row that decides when the add-on is offered.
  it("each plan quotes its own live organisation allowance", async () => {
    for (const plan of stripePlans.plans) {
      const quoted = /up\s+to\s+(\d+)\s+organisations?/i.exec(plan.product.description);
      expect(quoted, `${plan.key}: no organisation allowance in the copy`).not.toBeNull();
      expect(Number(quoted![1]), `${plan.key} organisation allowance`).toBe(
        await capFor("orgs.max_owned", plan.key),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVING THE GUARDS — by REWORDING, not by reverting.
//
// The real seed is (and must stay) correct, so every assertion above passes
// whether or not the guard actually covers the claim. These point the same pure
// functions at the copy a future editor plausibly writes: the falsehood said a
// different way, and — for each presence rule — its inverse.
//
// Every case marked "fix round 1" is one that was MEASURED green against the
// first version of these guards. They are the evidence the widenings work, and
// they are why this block exists instead of a revert.
//
// Asserted with `toEqual([...])` on exact fault labels: "it returned something"
// would be satisfied by a guard firing for an unrelated reason.
// ─────────────────────────────────────────────────────────────────────────────
describe("the guards survive a rewording, not just a revert", () => {
  const M = "event_pass";

  it("catches the retired AI-run cap however it is phrased", () => {
    // The historical sentence…
    expect(retiredRunCapFaults("realtime and 10 AI schedule runs per division")).not.toEqual([]);
    // …and rewordings of the same claim, none of which contain it. The last
    // three were measured GREEN against the first version of this list.
    for (const reworded of [
      "AI-powered scheduling with 6 runs per competition",
      "includes 12 scheduling runs",
      "5 AI runs per division, included",
      "includes an allowance of AI schedule runs for each division", // fix round 1
      "AI scheduling: three runs a division", // fix round 1
      "a monthly quota of AI schedule generations per division", // fix round 1
    ]) {
      expect(retiredRunCapFaults(reworded), reworded).not.toEqual([]);
    }
    // …while the live, credit-metered story is not a false positive. "news
    // runs" in the credit packs is the phrase that makes a loose /runs?/ rule
    // unusable, so it is pinned here.
    for (const honest of [
      "40 AI credits (schedule / officials / news runs) for your organisation's shared wallet",
      "a one-time +25 AI credits added to your wallet",
      "AI-assisted scheduling, metered by your credit wallet",
      "One extra member seat for an organisation, billed monthly.",
    ]) {
      expect(retiredRunCapFaults(honest), honest).toEqual([]);
    }
  });

  it("catches unbounded-duration claims however they are phrased", () => {
    const bounded = "One-time upgrade for a single competition, while it's active: 10 divisions";
    expect(passDurationFaults([{ key: M, description: bounded }])).toEqual([]);

    for (const [label, reworded] of [
      ["the original", `${bounded.replace(", while it's active", "")} — for the event's lifetime`],
      ["a synonym", `${bounded} — yours forever`],
      ["another synonym", `${bounded} — a permanent upgrade`],
      ["a third", `${bounded} — it never expires`],
      ["a concessive", `${bounded} — it keeps working even after the competition finishes`],
      ["fix round 1 (as long as you want)", `${bounded} — it stays yours for as long as you want`],
      ["fix round 1 (does not lapse)", `${bounded}. The upgrade does not lapse.`],
      ["fix round 1 (yours to keep)", `${bounded} — once bought, it is yours to keep`],
    ] as const) {
      const faults = passDurationFaults([{ key: M, description: reworded }]);
      expect(faults, label).not.toEqual([]);
      expect(faults.join(" "), label).toContain("unbounded duration");
    }
  });

  // The other half of the same rule. An absence-shaped guard is happiest when
  // the claim is deleted outright — which tells the buyer nothing about when
  // the pass stops, and is exactly how "must mention add-ons" was satisfied by
  // copy saying they stop counting.
  it("catches the bound being DELETED, not just contradicted", () => {
    const silent = "One-time upgrade for a single competition: 10 divisions, 128 entrants";
    expect(passDurationFaults([{ key: M, description: silent }])).toEqual([
      `${M}: opening clause never states the pass is bounded to an active competition`,
    ]);
  });

  // …and it must not be satisfiable by the WRONG CLAUSE in the same sentence:
  // "active competitions" is a feature-list item, not a scope statement.
  it("is not satisfied by the word 'active' appearing further down the sentence", () => {
    const wrongClause =
      "One-time upgrade for a single competition: 10 active competitions, 128 entrants";
    expect(passDurationFaults([{ key: M, description: wrongClause }])).not.toEqual([]);
  });

  // fix round 1: the clause scoping was defeated by DROPPING THE COLON —
  // `split(":")[0]` then returns the whole description, so the feature list
  // answers for the scope statement. Measured: one character took the fixture
  // above from red to green.
  it("is not defeated by removing the colon that defines the clause", () => {
    const noColon =
      "One-time upgrade for a single competition — 10 active competitions, 128 entrants per division, advanced formats.";
    expect(passDurationFaults([{ key: M, description: noColon }])).toEqual([
      `${M}: no ":" separating the scope statement from the feature list — the bound cannot be scoped`,
    ]);
  });

  // fix round 1: wrong-clause satisfaction surviving INSIDE the scoped clause.
  // "active immediately" asserts an immediate start and no end at all, yet
  // satisfied a rule meant to assert a bound. The bound's grammar is required.
  it("requires the bound's grammar, not merely the word 'active'", () => {
    for (const unbounded of [
      "One-time upgrade for a single competition, active immediately: 10 divisions",
      "One-time upgrade for an active competition: 10 divisions",
    ]) {
      expect(passDurationFaults([{ key: M, description: unbounded }]), unbounded).toEqual([
        `${M}: opening clause never states the pass is bounded to an active competition`,
      ]);
    }
    // …and the genuine bound, in more than one phrasing, still passes.
    for (const bounded of [
      "One-time upgrade for a single competition, while it's active: 10 divisions",
      "One-time upgrade, for as long as the competition is active: 10 divisions",
      "One-time upgrade, until the competition is no longer active: 10 divisions",
    ]) {
      expect(passDurationFaults([{ key: M, description: bounded }]), bounded).toEqual([]);
    }
  });

  it("catches a missing, drifted, other-rung's, or recurring credit grant", () => {
    const mGrant = PASS_CREDIT_GRANT.event_pass;
    const lGrant = PASS_CREDIT_GRANT.event_pass_l;
    const honest = `…and a one-time +${mGrant} AI credits added to your wallet.`;
    expect(passCreditGrantFaults([{ key: M, description: honest }])).toEqual([]);

    expect(passCreditGrantFaults([{ key: M, description: "…realtime scoreboard." }])).toEqual([
      `${M}: does not state the +${mGrant} AI credit grant`,
    ]);
    // THE OTHER RUNG'S NUMBER. This case used to read "the rung-keyed grant
    // PASS_CREDIT_GRANT must never become" — W2 T5 made it exactly that, so the
    // same fixture now proves the opposite rule: M's copy quoting L's figure is
    // the likeliest real defect, because L's description was written by copying
    // M's.
    expect(
      passCreditGrantFaults([
        { key: M, description: `…and a one-time +${lGrant} AI credits.` },
      ]).join(" "),
    ).toContain(`quotes ${lGrant} AI credits, but the grant is ${mGrant}`);
    // …and its mirror, which the flat rule could not express at all.
    expect(
      passCreditGrantFaults([
        { key: "event_pass_l", description: `…and a one-time +${mGrant} AI credits.` },
      ]).join(" "),
    ).toContain(`quotes ${mGrant} AI credits, but the grant is ${lGrant}`);
    // A rung with no declared grant is a fault in its own right — otherwise it
    // would be the one product this rule exempts.
    expect(
      passCreditGrantFaults([{ key: "event_pass_xl", description: honest }]).join(" "),
    ).toContain("no credit grant is declared for this rung");
    // The inverse claim: right number, wrong cadence.
    expect(
      passCreditGrantFaults([
        { key: M, description: `…and +${mGrant} AI credits every month while it runs.` },
      ]).join(" "),
    ).toContain("recurring");
  });

  // ── The product NAME (fix round 6) ─────────────────────────────────────────
  //
  // Probe P5's five falsehoods, each in the field Checkout renders as the
  // line-item label. All five shipped 216 passed / 0 failed before this round.

  it("catches a falsehood written into the pass's NAME, not its description", () => {
    const bounded = "One-time upgrade for a single competition, while it's active: 10 divisions";
    // Same description, honest name — clean.
    expect(
      passDurationFaults([{ key: M, name: "Seazn Club Event Pass", description: bounded }]),
    ).toEqual([]);
    // …and the probe's name, with that same honest description beside it.
    for (const name of [
      "Seazn Club Event Pass — yours forever, never expires",
      "Seazn Club Event Pass — a permanent upgrade",
      "Seazn Club Event Pass — yours to keep",
    ]) {
      const faults = passDurationFaults([{ key: M, name, description: bounded }]);
      expect(faults, name).not.toEqual([]);
      expect(faults.join(" "), name).toContain("unbounded duration");
    }
  });

  it("catches a retired AI-run cap written into a NAME", () => {
    // P5 put this on the L rung's label. `stripeRenderedText` is what feeds
    // this rule, and it now carries names.
    expect(
      retiredRunCapFaults(
        "Seazn Club Event Pass L — 10 AI schedule runs per division, forever | One-time upgrade",
      ),
    ).not.toEqual([]);
  });

  it("catches a credit grant misquoted in a NAME", () => {
    const honest = `…and a one-time +${PASS_CREDIT_GRANT.event_pass} AI credits added to your wallet.`;
    expect(
      passCreditGrantFaults([
        { key: M, name: "Seazn Club Event Pass — 250 AI credits", description: honest },
      ]).join(" "),
    ).toContain("quotes 250 AI credits");
  });

  it("catches a quantity in a name that is not the seed's own figure", () => {
    const honest: QuantifiedProduct[] = [
      { key: "credits_10", name: "Seazn Club AI Credits — 40", field: "credits", quantity: 40 },
      {
        key: "size_pack_32",
        name: "Seazn Club Size Pack — +32 entrants",
        field: "delta_each",
        quantity: 32,
      },
    ];
    expect(productNameQuantityFaults(honest)).toEqual([]);

    // The 100x claim, and the 10x one. A substring rule would have passed both.
    expect(
      productNameQuantityFaults([
        { key: "credits_10", name: "Seazn Club AI Credits — 4000", field: "credits", quantity: 40 },
      ]),
    ).toEqual([
      'credits_10: product name "Seazn Club AI Credits — 4000" does not quote its credits (40)',
      "credits_10: product name quotes 4000, but credits is 40",
    ]);
    expect(
      productNameQuantityFaults([
        {
          key: "size_pack_32",
          name: "Seazn Club Size Pack — +320 entrants",
          field: "delta_each",
          quantity: 32,
        },
      ]).join(" "),
    ).toContain("quotes 320, but delta_each is 32");

    // Both halves matter: keeping the honest number and ADDING a fictional one
    // defeats a presence-only rule.
    expect(
      productNameQuantityFaults([
        {
          key: "credits_10",
          name: "Seazn Club AI Credits — 40 (4000 on Pro)",
          field: "credits",
          quantity: 40,
        },
      ]),
    ).toEqual(["credits_10: product name quotes 4000, but credits is 40"]);

    // …and DELETING the figure is a fault too, not a clean escape.
    expect(
      productNameQuantityFaults([
        { key: "credits_10", name: "Seazn Club AI Credits", field: "credits", quantity: 40 },
      ]),
    ).toEqual([
      'credits_10: product name "Seazn Club AI Credits" does not quote its credits (40)',
    ]);
  });

  it("catches an unqualified rider rate claim in an add-on's NAME", () => {
    const plans = stripePlans.plans as unknown as PricedPlan[];
    const addons = stripePlans.org_addons as unknown as OrgAddon[];
    // The live seed is clean…
    expect(orgAddonRiderFaults(plans, addons)).toEqual([]);
    // …and P5's label is not. "half the base rate" bare is false in usd (47.4%)
    // and would OVERCHARGE the moment a price moved the other way.
    const holed = addons.map((a) =>
      a.key === "extra_org_pro"
        ? { ...a, product: { ...a.product, name: "Seazn Club Extra Organisation — Pro, half the base rate" } }
        : a,
    );
    expect(orgAddonRiderFaults(plans, holed).join(" ")).toContain(
      "claims the rider is exactly half the base rate",
    );
  });

  it("makes a MISSING product name a fault, so a section cannot go unscanned", () => {
    expect(
      describedNameFaults([{ section: "packs", key: "credits_10", name: "", description: "x" }]),
    ).toEqual(["packs/credits_10: has a product.description but no product.name"]);
  });

  it("catches one rung wearing the other's caps", () => {
    const caps: RungCaps[] = [
      { key: "event_pass", entrants: 128, divisions: 10 },
      { key: "event_pass_l", entrants: null, divisions: 20 },
    ];
    const honest: Rung[] = [
      { key: "event_pass", description: "10 divisions, 128 entrants per division" },
      { key: "event_pass_l", description: "20 divisions, unlimited entrants per division" },
    ];
    expect(capClaimFaults(honest, caps)).toEqual([]);

    // L sold with M's ceiling — the exact defect that made "an Event Pass caps
    // at 128" read as true for the product a buyer paid $59 to escape.
    expect(
      capClaimFaults(
        [{ key: "event_pass_l", description: "20 divisions, 128 entrants per division" }],
        caps,
      ),
    ).toEqual([
      "event_pass_l: entrant cap is unlimited but the copy never says so",
      'event_pass_l: quotes "128 entrants" for an unlimited cap',
      "event_pass_l: quotes event_pass's entrant cap (128)",
    ]);

    // A stale number that belongs to nobody.
    expect(
      capClaimFaults([{ key: "event_pass", description: "10 divisions, 64 entrants" }], caps).join(
        " ",
      ),
    ).toContain("does not quote its live entrant cap (128)");
  });

  it("catches a Pro Plus differentiator Pro already has, however it is phrased", () => {
    // The live matrix, as this file's DB tests read it: scheduling.ai is true
    // on EVERY plan, so it can never be a Pro Plus differentiator.
    const proGrants = {
      "scheduling.ai": true,
      "officials.auto": false,
      "api.write": false,
      "support.priority": false,
    };
    const plusGrants = {
      "scheduling.ai": true,
      "officials.auto": true,
      "api.write": true,
      "support.priority": true,
    };
    const honest =
      "Everything in Pro, plus automatic officials assignment, write API access and priority support. Covers up to 10 organisations.";
    expect(plusDifferentiatorFaults(honest, proGrants, plusGrants)).toEqual([]);

    for (const reworded of [
      "Everything in Pro, plus AI-assisted scheduling and priority support.",
      "Everything in Pro, plus AI-powered scheduling.",
      "Everything in Pro, plus AI schedule building.",
    ]) {
      expect(plusDifferentiatorFaults(reworded, proGrants, plusGrants), reworded).toContain(
        "pro_plus: sells scheduling.ai as a differentiator, but Pro already grants it",
      );
    }

    // A claim Pro Plus does not actually grant, caught from the other side.
    expect(
      plusDifferentiatorFaults("Everything in Pro, plus write API access.", proGrants, {
        ...plusGrants,
        "api.write": false,
      }),
    ).toEqual(["pro_plus: claims api.write, but Pro Plus does not grant it"]);

    // Dropping the frame disables the scope — a fault in itself.
    expect(
      plusDifferentiatorFaults("Now with AI-assisted scheduling.", proGrants, plusGrants),
    ).toEqual(['pro_plus: no "Everything in Pro, plus" frame — nothing to scope the claims to']);

    // fix round 1 — the positive backstop for an all-negative list: a reword
    // that keeps the frame but phrases every claim outside the vocabulary
    // would have the guard examine NOTHING and report clean.
    expect(
      plusDifferentiatorFaults(
        "Everything in Pro, plus a bigger allowance and nicer colours.",
        proGrants,
        plusGrants,
      ),
    ).toEqual([
      "pro_plus: names no recognised differentiator — the vocabulary has gone stale and this guard examined nothing",
    ]);
  });

  // N1. The claim and the arithmetic are checked against each other, so the
  // guard reds whichever of the two moves.
  it("ties the extra-organisation rate claim to the actual tier amounts", () => {
    // Every non-usd currency gets a SET point, because a MISSING one is its own
    // fault (the guard says so, and config/__tests__/stripe-plans.test.ts covers
    // it in depth) — supplying only one would drown the rate signal in three
    // "no price point" faults.
    const points = (amount: number) => ({ eur: amount, gbp: amount, inr: amount });
    const priced = (description: string, base: number, rider: number): PricedPlan[] => [
      {
        key: "pro",
        product: { description },
        prices: {
          monthly: {
            lookup_key: "seazn_pro_monthly",
            unit_amount: base,
            currency_options: points(base),
            tiers: [
              { up_to: 1, unit_amount: base, currency_options: points(base) },
              { up_to: "inf", unit_amount: rider, currency_options: points(rider) },
            ],
          },
        },
      },
    ];
    const AT_MOST = "each extra organisation costs no more than half the base rate.";

    // Shipped shape: rider below half, claim says "no more than half".
    expect(riderRateFaults(priced(AT_MOST, 1900, 900))).toEqual([]);
    // Exactly half is still within "no more than half" — this is the eur/aud
    // case on seazn_pro_monthly, which is why the copy cannot say "under".
    expect(riderRateFaults(priced(AT_MOST, 1800, 900))).toEqual([]);

    // The direction that overcharges against the copy.
    expect(riderRateFaults(priced(AT_MOST, 1900, 1000)).join(" ")).toContain("OVER half");

    // The wording this task replaced: a bare "half" with no qualifier is only
    // true where the rider is EXACTLY half, which it is not in usd.
    const BARE = "each extra organisation is half the base rate.";
    expect(riderRateFaults(priced(BARE, 1900, 900)).join(" ")).toContain("not exactly half");
    // …and "under half" is false wherever the halves land on whole units.
    const UNDER = "each extra organisation is a little under half the base rate.";
    expect(riderRateFaults(priced(UNDER, 1800, 900)).join(" ")).toContain(
      "exactly half, but the copy claims UNDER half",
    );
    // Saying nothing about the rate at all is a fault, not a pass.
    expect(riderRateFaults(priced("Covers up to 5 organisations.", 1900, 900))).toEqual([
      "pro: makes no statement about the extra-organisation rate",
    ]);
  });

  // The org_addons half of the same claim, proved by HOLING the clone: the only
  // way an add-on drift can be caught is if the guard compares every currency,
  // and the only way a DELETED add-on can be caught is if the guard also walks
  // the plans. Both directions are asserted.
  it("catches an extra-organisation add-on that drifts off its rider", () => {
    const points = (amount: number) => ({ eur: amount, gbp: amount, inr: amount });
    const plans: PricedPlan[] = [
      {
        key: "pro",
        product: { description: "each extra organisation costs no more than half the base rate." },
        prices: {
          monthly: {
            lookup_key: "seazn_pro_monthly",
            unit_amount: 1900,
            currency_options: points(1900),
            tiers: [
              { up_to: 1, unit_amount: 1900, currency_options: points(1900) },
              { up_to: "inf", unit_amount: 900, currency_options: points(900) },
            ],
          },
        },
      },
    ];
    const addon = (
      amount: number,
      currencies: Record<string, number> = points(amount),
    ): OrgAddon => ({
      key: "extra_org_pro",
      plan_key: "pro",
      price: {
        lookup_key: "seazn_extra_org_pro_monthly",
        unit_amount: amount,
        currency_options: currencies,
      },
    });

    expect(orgAddonRiderFaults(plans, [addon(900)])).toEqual([]);

    // A drift in usd alone…
    expect(orgAddonRiderFaults(plans, [addon(1000, points(900))]).join(" ")).toContain(
      "extra_org_pro usd: add-on charges 1000 but seazn_pro_monthly's rider is 900",
    );
    // …and in one non-usd currency alone, which `unit_amount` cannot see.
    expect(
      orgAddonRiderFaults(plans, [addon(900, { ...points(900), gbp: 1200 })]).join(" "),
    ).toContain("extra_org_pro gbp: add-on charges 1200");
    // A missing currency point is its own fault, not a skipped comparison.
    expect(orgAddonRiderFaults(plans, [addon(900, { eur: 900 })]).join(" ")).toContain(
      "extra_org_pro gbp: no price point on the add-on",
    );
    // An add-on pointed at a plan that no longer exists. Two faults, not one:
    // the add-on charges for nothing AND `pro`'s rider is left unpinned — a
    // renamed plan_key silently un-covers the plan it used to cover.
    expect(orgAddonRiderFaults(plans, [{ ...addon(900), plan_key: "starter" }])).toEqual([
      'extra_org_pro: plan_key "starter" matches no plan in the seed',
      "pro: charges a graduated extra-organisation rider but no org_addons entry pins it to the copy",
    ]);
    // …and the inverse: deleting the add-on must not make the guard scan
    // nothing and report clean. This is exactly how org_addons escaped the
    // sibling seed guard's hand-written section list for a whole wave (#293).
    expect(orgAddonRiderFaults(plans, [])).toEqual([
      "pro: charges a graduated extra-organisation rider but no org_addons entry pins it to the copy",
    ]);
  });
});
