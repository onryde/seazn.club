// THE EVENT PASS CREDIT GRANT IS PER RUNG (entitlements v18 W2 T5, design R9,
// owner ruling 2026-09-03).
//
// M grants 25 one-time AI credits, L grants 35 (W2 T12 re-cut it from 50 with
// the monthly grants, owner ruling 2026-09-03). The grant is a ONE-TIME TOP-UP
// that stays in the wallet: no expiry, no clawback on downgrade, no cap. A
// customer keeps what they paid for. (The one thing that takes it back is a
// refund of the pass itself — money returned, not a grant expiring; that path
// is `recordPassRefund`, covered in billing-pass-financial-trace.test.ts.)
//
// ── WHY THIS FILE EXISTS SEPARATELY ─────────────────────────────────────────
// `passCreditGrantFaults` has exactly one other caller, plan-copy-truth.test.ts,
// and that file cannot COLLECT on this branch: W2 T4 deleted the `pro_plus`
// entry from stripe-plans.json and its module scope still does
// `stripePlans.plans.find((p) => p.key === "pro_plus").product` (measured:
// "TypeError: Cannot read properties of undefined (reading 'product')", 0 tests
// run, which the JSON reporter shows as 0 failures — a suite that fails to
// collect contributes neither). Repairing that means deleting this wave's Pro
// Plus assertions, which is T8's job and not this task's. So the per-rung rule
// keeps its own running witness here rather than an unrunnable one there.
//
// Pure: no DB, no network. The seed and the constant are the two things being
// compared, and both are files.
import { describe, expect, it } from "vitest";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { PASS_KEYS } from "@/lib/currency";
import { passCreditGrantFaults, type Rung } from "@/lib/copy-truth";
import stripePlans from "@/config/stripe-plans.json";

/** The rungs as Checkout renders them — the same mapping plan-copy-truth uses:
 *  the seed's own product name and description, which are what a buyer reads on
 *  the Stripe payment page and on their receipt. */
const passRungs: Rung[] = stripePlans.passes.map((p) => ({
  key: p.key,
  name: p.product.name,
  description: p.product.description,
}));

describe("the declaration", () => {
  it("gives every rung the product can sell its own grant, and they differ", () => {
    // Anti-vacuity FIRST. Every assertion in this file about "L's grant" is
    // satisfied by a flat 25 unless the two numbers actually differ, so the day
    // someone equalises them the whole suite must red here rather than pass
    // everywhere.
    expect(PASS_CREDIT_GRANT.event_pass_l).not.toBe(PASS_CREDIT_GRANT.event_pass);
    // The literal pin is the ONE thing in this file not derived from the
    // constant, and that is deliberate: every other assertion here (and every
    // wallet-delta assertion in billing-pass-financial-trace.test.ts) reads
    // PASS_CREDIT_GRANT, so all of them move silently with a wrong edit. This
    // line is what actually witnesses a change to the numbers themselves.
    expect(PASS_CREDIT_GRANT).toEqual({ event_pass: 25, event_pass_l: 35 });
    // No rung falls through to a default, because there is no default: a rung
    // added to PASS_KEYS without a grant is a compile error, and this is the
    // runtime half of that same claim.
    expect(Object.keys(PASS_CREDIT_GRANT).sort()).toEqual([...PASS_KEYS].sort());
  });

  it("grants MORE on the larger rung, which is the whole point of pricing it", () => {
    expect(PASS_CREDIT_GRANT.event_pass_l).toBeGreaterThan(PASS_CREDIT_GRANT.event_pass);
  });
});

describe("passCreditGrantFaults judges each rung against ITS OWN grant", () => {
  // The producer/consumer check, not a fixture on both ends: the copy is the
  // SEED's own description (what stripe:sync pushes to Stripe and what Checkout
  // renders), and the number is the constant the wallet is actually credited
  // from. Nothing in between is written twice.
  it("passes the live seed, whose two rungs now quote two different figures", () => {
    expect(passCreditGrantFaults(passRungs)).toEqual([]);
    // …and the fixture is real: two rungs, each quoting its own number, so the
    // assertion above is not satisfied by an empty list.
    expect(passRungs).toHaveLength(2);
    for (const rung of passRungs) {
      const grant = PASS_CREDIT_GRANT[rung.key as keyof typeof PASS_CREDIT_GRANT];
      expect(rung.description, `${rung.key} must quote its own grant`).toContain(
        `+${grant} AI credits`,
      );
    }
    // The discriminator: the two descriptions do NOT quote the same figure.
    const [m, l] = passRungs;
    expect(m!.description).not.toContain(`+${PASS_CREDIT_GRANT.event_pass_l} AI credits`);
    expect(l!.description).not.toContain(`+${PASS_CREDIT_GRANT.event_pass} AI credits`);
  });

  const M = "event_pass";
  const L = "event_pass_l";
  const mGrant = PASS_CREDIT_GRANT.event_pass;
  const lGrant = PASS_CREDIT_GRANT.event_pass_l;

  it("faults a rung that quotes the OTHER rung's number — both directions", () => {
    // The defect this wave creates and the flat rule could not express. L's
    // description was written by copying M's, so "+25" on L is the wording a
    // careful editor lands on by accident, and it read as CORRECT until today.
    expect(
      passCreditGrantFaults([{ key: L, description: `…a one-time +${mGrant} AI credits.` }]).join(
        " ",
      ),
    ).toContain(`${L}: quotes ${mGrant} AI credits, but the grant is ${lGrant}`);
    expect(
      passCreditGrantFaults([{ key: M, description: `…a one-time +${lGrant} AI credits.` }]).join(
        " ",
      ),
    ).toContain(`${M}: quotes ${lGrant} AI credits, but the grant is ${mGrant}`);
  });

  it("faults a rung that states no grant at all, naming that rung's own figure", () => {
    expect(passCreditGrantFaults([{ key: L, description: "…realtime scoreboard." }])).toEqual([
      `${L}: does not state the +${lGrant} AI credit grant`,
    ]);
    expect(passCreditGrantFaults([{ key: M, description: "…realtime scoreboard." }])).toEqual([
      `${M}: does not state the +${mGrant} AI credit grant`,
    ]);
  });

  it("faults a rung it has no grant for, rather than judging it against another's", () => {
    // A third rung wired up without a grant would otherwise be the one product
    // this rule exempts — every check below a silent `?? 25` passes.
    expect(
      passCreditGrantFaults([
        { key: "event_pass_xl", description: `…a one-time +${mGrant} AI credits.` },
      ]),
    ).toEqual(["event_pass_xl: no credit grant is declared for this rung"]);
  });

  it("still catches the cadence inversion, per rung", () => {
    // Right number, wrong cadence: neither rung has an `ai.credits.monthly` row,
    // so "every month" is false rather than merely stylistic.
    expect(
      passCreditGrantFaults([
        { key: L, description: `…and +${lGrant} AI credits every month while it runs.` },
      ]).join(" "),
    ).toContain("recurring");
  });

  it("reads the NAME as well as the description for a misquoted figure", () => {
    // The Checkout line-item label is customer-facing too, and the positive half
    // deliberately stays on the description (the only one with room to state a
    // bound) while the negative half reads both.
    expect(
      passCreditGrantFaults([
        {
          key: L,
          name: `Seazn Club Event Pass L — ${mGrant} AI credits`,
          description: `…a one-time +${lGrant} AI credits.`,
        },
      ]).join(" "),
    ).toContain(`quotes ${mGrant} AI credits, but the grant is ${lGrant}`);
  });
});
