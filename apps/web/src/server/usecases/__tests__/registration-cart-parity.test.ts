// Registration redesign B3 T12 (spec §4.1 cart arithmetic; plan Review Focus 2): the register form's cart must say, per entry,
// what the SERVER will do with it — which entries take a place, which go on the waiting list, and what the total is.
//
// The unit tests hold `summarizeCart` to submit's rule as written down (capacity.test.ts re-states the loop). This holds it to the
// real thing, end to end, through both real ends of the seam: the division list comes from `publicRegistrationInfo` (the producer
// the page hands the stepper), the cart is built by the stepper's own reducer and mapped by its own `toGroupEntry`, and the
// verdict is whatever `submitRegistrationGroup` writes. Nothing here is typed in from the code under test: the expected value of
// every case is the status the database ends up with. Real Postgres, skipped without DATABASE_URL (repo convention).
//
// Another sport: N/A — registration capacity is sport-agnostic (one generic division per case).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { cartReducer, summarizeCart, toGroupEntry } from "@/components/public-site/register/cart";
import { EMPTY_CART, type CartState } from "@/components/public-site/register/types";
import { createDivision } from "../divisions";
import { publicRegistrationInfo, putRegistrationSettings } from "../registrations";
import { submitRegistrationGroup } from "../registration-submit";
import { asOwner, rig, seedOrg } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const FEE = 1000;

/** One division in a case: its organiser capacity (null = none) and how many TEAM entries already hold a place. */
interface DivSpec {
  capacity: number | null;
  prior: number;
}
/** One cart entry: which division of the case it goes into, and whether it is a solo sign-up. */
interface EntrySpec {
  div: number;
  solo?: boolean;
}

describe.skipIf(!HAS_DB)("the cart's waiting-list verdicts and total are what submit actually does (B3 T12)", () => {
  /** Stands up the divisions, seats the prior entries through the real submit, then returns the cart's prediction and the
   *  server's outcome for `cart` — the same cart, in the same order, through the real producer and the real consumer. */
  async function run(org: { orgSlug: string; competition: { id: string; slug: string }; owner: ReturnType<typeof asOwner> }, divs: DivSpec[], cart: EntrySpec[]) {
    const ids: string[] = [];
    for (const [i, d] of divs.entries()) {
      const division = await createDivision(org.owner, org.competition.id, {
        name: `Case ${i} ${randomUUID().slice(0, 6)}`,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
      await putRegistrationSettings(org.owner, division.id, {
        enabled: true,
        entrant_kind: "team",
        fee_cents: FEE,
        payment_method: "offline",
        capacity: d.capacity,
        allow_free_agents: true,
        form_fields: [],
      });
      ids.push(division.id);
      if (d.prior > 0) {
        const seated = await submitRegistrationGroup(
          { orgSlug: org.orgSlug, compSlug: org.competition.slug },
          {
            contact: { name: "Earlier Rep", email: `earlier-${randomUUID().slice(0, 8)}@test.local` },
            privacy_consent: true,
            entries: Array.from({ length: d.prior }, (_, k) => ({
              division_id: division.id,
              entrant_kind: "team" as const,
              team_name: `Earlier ${k}-${randomUUID().slice(0, 6)}`,
              players: [{ full_name: `Earlier Player ${k}` }],
              answers: {},
            })),
          },
        );
        expect(seated.entries.map((e) => e.status), "premise: the prior entries each hold a place").not.toContain("waitlisted");
      }
    }

    // What the page hands the stepper (the real producer), then the cart built the way the stepper builds it (its own reducer).
    const info = await publicRegistrationInfo(org.orgSlug, org.competition.slug);
    let state: CartState = EMPTY_CART;
    cart.forEach((spec, i) => {
      const id = `entry-${i}`;
      state = cartReducer(state, { type: "ADD_ENTRY", id, division_id: ids[spec.div]!, entrant_kind: "team" });
      state = cartReducer(state, { type: "UPDATE_ENTRY", id, patch: spec.solo ? { free_agent: true } : { team_name: `Team ${i}-${randomUUID().slice(0, 6)}` } });
    });
    const predicted = summarizeCart(state, info.divisions);

    // The real consumer: the same cart, mapped by the stepper's own `toGroupEntry`, through submit.
    const result = await submitRegistrationGroup(
      { orgSlug: org.orgSlug, compSlug: org.competition.slug },
      {
        contact: { name: "Rae Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
        privacy_consent: true,
        entries: state.entries.map((e, i) => ({ ...toGroupEntry(e), players: [{ full_name: `Player ${i + 1}` }], answers: {} })),
      },
    );
    return {
      predicted: predicted.lines.map((l) => l.waitlisted),
      predictedTotal: predicted.subtotalCents,
      actual: result.entries.map((e) => e.status === "waitlisted"),
      actualTotal: result.amount_cents,
      statuses: result.entries.map((e) => e.status),
    };
  }

  let seated = 0;
  let waited = 0;
  let compared = 0;

  const CASES: [string, DivSpec[], EntrySpec[], boolean[]][] = [
    // [label, divisions, cart, the verdict the premise says submit reaches: only used as a guard that the case is not vacuous]
    ["one place left, two entries (Review Focus 2)", [{ capacity: 1, prior: 0 }], [{ div: 0 }, { div: 0 }], [false, true]],
    ["three places, one held, three entries", [{ capacity: 3, prior: 1 }], [{ div: 0 }, { div: 0 }, { div: 0 }], [false, false, true]],
    ["already full: every entry waits", [{ capacity: 2, prior: 2 }], [{ div: 0 }, { div: 0 }], [true, true]],
    ["a solo sign-up between team entries takes no place", [{ capacity: 4, prior: 2 }], [{ div: 0 }, { div: 0, solo: true }, { div: 0 }, { div: 0 }], [false, false, false, true]],
    ["a division with no capacity never waits anyone", [{ capacity: null, prior: 0 }], [{ div: 0 }, { div: 0 }, { div: 0 }], [false, false, false]],
    ["two divisions counted separately, interleaved", [{ capacity: 1, prior: 0 }, { capacity: 5, prior: 0 }], [{ div: 0 }, { div: 1 }, { div: 0 }, { div: 1 }], [false, false, true, false]],
    ["one entry into the last place", [{ capacity: 8, prior: 7 }], [{ div: 0 }], [false]],
    ["a single entry into a full division", [{ capacity: 1, prior: 1 }], [{ div: 0 }], [true]],
  ];

  it("every case: the cart's per-entry waiting flags and its total equal the statuses and amount submit wrote", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    for (const [label, divs, cart, expected] of CASES) {
      const r = await run({ orgSlug, competition, owner }, divs, cart);
      expect(r.actual, `${label}: premise — the server's verdict for each entry`).toEqual(expected);
      expect(r.predicted, `${label}: the cart's flag for each entry`).toEqual(r.actual);
      expect(r.predictedTotal, `${label}: the total — waiting entries are excluded`).toBe(r.actualTotal);
      compared += 1;
      seated += r.actual.filter((w) => !w).length;
      waited += r.actual.filter(Boolean).length;
    }
    expect(compared, "anti-vacuity: every case compared").toBe(CASES.length);
    expect(waited, "anti-vacuity: both verdicts were reached").toBeGreaterThan(3);
    expect(seated).toBeGreaterThan(3);
  });

  it("the plan limit counts as a cap, as it does at submit: no capacity set, a plan limit of 3, one place held, four entries", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    // The limit is what the public panel reads through `getLimit` and what submit reads before its transaction; an override row
    // is the production shape of "the plan allows fewer than the organiser planned" (a downgrade, an expired pass).
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${orgId}, 'entrants.per_division.max', 3, 'test — B3 T12 cart parity')`;
    await invalidateOrgEntitlements(orgId);
    const r = await run({ orgSlug, competition, owner }, [{ capacity: null, prior: 1 }], [{ div: 0 }, { div: 0 }, { div: 0 }, { div: 0 }]);
    expect(r.actual, "premise: 3 places under the plan, 1 held, so two fit and two wait").toEqual([false, false, true, true]);
    expect(r.predicted).toEqual(r.actual);
    expect(r.predictedTotal).toBe(r.actualTotal);
    expect(r.actualTotal, "two charged entries").toBe(2 * FEE);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
