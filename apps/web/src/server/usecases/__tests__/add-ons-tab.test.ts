// v17 gap #293, SPEC-6 §A5 — the Add-ons tab's view model. Real-Postgres
// integration test: skips without DATABASE_URL. Mirrors credits-tab.test.ts.
//
// The brief's five cases are all HEALTHY fixtures, and every one of them passes
// against an implementation that derives the rendered cap from `groupOrgLimit`
// — which is the exact bug this tab has to avoid. The cases below the fold
// therefore discriminate on the states where the entitlement resolver and the
// customer's receipt disagree: dunning, an admin comp, a canceled rider, and a
// group standing above its base cap.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { walletIdFor } from "@/lib/credits";
import { groupOrgLimit } from "@/lib/billing-group";
import { seedOrg } from "./_seed";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { MAX_EXTRA_ORGS } from "../extra-orgs";
import { getAddOnsTab } from "../add-ons-tab";
import stripePlans from "@/config/stripe-plans.json";

/** The org-addon rider catalog, straight from the seed the tab itself prices
 *  from — so a reprice moves this test instead of breaking it. */
const orgAddonSeed = stripePlans.org_addons;

const HAS_DB = !!process.env.DATABASE_URL;

/** Add `n` more live organisations to an existing group. */
async function addOrgsToGroup(
  walletId: string,
  createdBy: string | null,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const suffix = randomUUID().slice(0, 8);
    const [{ id }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${"T6 " + suffix}, ${"t6-" + suffix}, ${createdBy}, ${walletId})
      returning id`;
    ids.push(id);
  }
  return ids;
}

/** A purchased rider, as the webhook writes it: group-wide, `active`, carrying
 *  a Stripe item id. The id is UNIQUE PER CALL on purpose — V324's unique index
 *  is on `stripe_item_id` ALONE, so a literal reused across tests upserts the
 *  previous test's row onto this wallet and both tests still pass. */
async function buyRiders(walletId: string, qty: number): Promise<void> {
  await sql`
    insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                            stripe_item_id, status)
    values (${walletId}, null, 'orgs.max_owned', 1, ${qty}, ${"si_" + randomUUID()}, 'active')`;
}

describe.skipIf(!HAS_DB)("getAddOnsTab", () => {
  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("a Pro payer sees the base cap, zero extra orgs, and the add-on offered", async () => {
    const { auth } = await seedOrg("pro");
    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.planKey).toBe("pro");
    expect(view.isPayer).toBe(true);
    expect(view.hasLiveSubscription).toBe(false); // smoke/tests never touch real Stripe
    expect(view.addonAvailable).toBe(true);
    expect(view.orgCap).toBe(5);
    expect(view.extraOrgCount).toBe(0);
    // The NEGATIVE half of the dunning case below. Without this, `capReduced`
    // could be hardcoded true and the whole suite would still be green — an
    // absence assertion needs a positive discriminator somewhere, and this is
    // the other end of it.
    expect(view.capReduced).toBe(false);
    expect(view.minExtraOrgs).toBe(0);
    expect(view.maxExtraOrgs).toBe(MAX_EXTRA_ORGS);
  });

  it("community cannot buy the add-on", async () => {
    const { auth } = await seedOrg("community");
    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.addonAvailable).toBe(false);
    expect(view.orgCap).toBe(1);
    // Nothing to sell means nothing to quote — a price rendered next to
    // "upgrade to buy this" is an offer we do not honour.
    expect(view.priceMinor).toBeNull();
  });

  it("reflects a purchased extra-org row in both the cap and the count", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.orgCap).toBe(7);
    expect(view.extraOrgCount).toBe(2);
  });

  it("a non-payer member sees the same numbers but isPayer=false", async () => {
    const { auth } = await seedOrg("pro");
    const view = await getAddOnsTab(auth.orgId, "not-" + auth.userId, "usd");
    expect(view.isPayer).toBe(false);
    expect(view.orgCap).toBe(5);
  });

  // Was "pro_plus prices independently of pro", asserting a hardcoded cap of
  // 10 for the second paid tier. V392 deleted that tier, and the property is
  // repointed rather than deleted: what it really proved is that the tab reads
  // the org's OWN plan row after a plan change, instead of caching the plan it
  // was first seeded on. Community -> Pro exercises exactly that, and the caps
  // are now READ from the matrix, so the case keeps working when they move
  // again (this file already had 10 typed in it from a cap that had moved).
  it("re-reads the cap from the org's own plan after a plan change", async () => {
    const capFor = async (plan: string) => {
      const [row] = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements
        where plan_key = ${plan} and feature_key = 'orgs.max_owned'`;
      expect(row, `${plan} must carry an orgs.max_owned row`).toBeDefined();
      return row!.int_value;
    };
    const [communityCap, proCap] = await Promise.all([capFor("community"), capFor("pro")]);
    // Anti-vacuity: the whole case turns on the two caps DIFFERING. Equal
    // values would satisfy both assertions below whether or not the tab
    // re-read anything.
    expect(proCap).not.toBe(communityCap);

    const { auth } = await seedOrg("community");
    expect((await getAddOnsTab(auth.orgId, auth.userId, "usd")).orgCap).toBe(communityCap);

    await setOrgPlan(auth.orgId, "pro");
    await invalidateOrgEntitlements(auth.orgId);
    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.planKey).toBe("pro");
    expect(view.orgCap).toBe(proCap);
  });

  // ── the cases the healthy fixtures above cannot fail on ──────────────────

  // The per-plan half of this case is gone with `pro_plus` — v18 leaves ONE
  // priced rider tier, so "never quote one plan's rate on the other" has no
  // second rate to confuse it with. The per-CURRENCY half is the half that was
  // always the more dangerous one, and it survives intact.
  //
  // Amounts are READ from the seed, not retyped: they were 900/700 here and
  // W2's reprice moved them to 600/400, so a literal is a guaranteed future
  // red that says nothing about the tab. Reading the seed is not a tautology
  // for the property under test — the risk is `amountFor`'s
  // `currency_options?.[c] ?? unit_amount`, which SILENTLY serves the USD
  // number under a foreign symbol when a currency is missing. That is a wrong
  // price with no error, and the assertion that catches it is that the two
  // differ, not what either one is.
  it("quotes the rider's MONTHLY SKU price in the currency asked for", async () => {
    const rider = orgAddonSeed.find((e) => e.plan_key === "pro");
    expect(rider, "stripe-plans.json has no pro extra-org rider to price").toBeDefined();
    const usdMinor = rider!.price.unit_amount;
    const gbpMinor = rider!.price.currency_options?.gbp;
    expect(gbpMinor, "the pro rider has no gbp set point — amountFor would serve the USD amount")
      .toBeTypeOf("number");
    expect(gbpMinor, "gbp must be its own set point, not a copy of usd").not.toBe(usdMinor);

    const pro = await seedOrg("pro");
    expect((await getAddOnsTab(pro.auth.orgId, pro.auth.userId, "usd")).priceMinor).toBe(usdMinor);
    expect((await getAddOnsTab(pro.auth.orgId, pro.auth.userId, "gbp")).priceMinor).toBe(gbpMinor);
  });

  it("shows what the group BOUGHT while dunning degrades what it may add", async () => {
    // The whole reason `orgCap` is not `groupOrgLimit`. A Pro group past its
    // 14-day dunning grace resolves to the community base, so the resolver's
    // admission cap is 1 + 2 riders = 3 while the customer is paying for 5 + 2.
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    await addOrgsToGroup(walletId, auth.userId, 4); // 5 live orgs in total
    await sql`
      update subscriptions
         set status = 'past_due',
             status_changed_at = now() - interval '30 days',
             stripe_subscription_id = ${"sub_" + randomUUID()}
       where id = ${walletId}`;
    const orgIds = await sql<{ id: string }[]>`
      select id from organizations where subscription_id = ${walletId}`;
    for (const o of orgIds) await invalidateOrgEntitlements(o.id);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");

    // Both numbers asserted IN THE SAME TEST, deliberately: it is their
    // DISAGREEMENT that is the requirement, so anyone who later "simplifies"
    // the two calls into one reds this line.
    expect(await groupOrgLimit(walletId)).toBe(3);
    expect(view.orgCap).toBe(7);
    expect(view.capReduced).toBe(true);

    // `hasLiveSubscription` admits past_due, so the control renders — and it
    // must, because cancelling a rider is what this customer is here to do.
    expect(view.hasLiveSubscription).toBe(true);
    expect(view.extraOrgCount).toBe(2);
    // 5 live orgs against a Pro base of 5: the riders carry nobody, so both may
    // be cancelled. Off a degraded base of 1 this would be 4, clamped to 2 —
    // i.e. "you cannot cancel anything", the refusal the customer cannot act on.
    expect(view.minExtraOrgs).toBe(0);
  });

  it("counts only ACTIVE riders in the stepper, while a comp still lifts the cap", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    // An admin comp (SPEC-3): capacity the group was GIVEN. Real capacity, but
    // not a rider the customer may cancel — it has no Stripe item at all.
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                              stripe_item_id, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 3, null, 'granted')`;
    // Frozen-not-deleted (V323/V324): a cancelled rider keeps its row for ever
    // and must count for nothing, in either number.
    await sql`
      insert into org_addons (wallet_id, target_org_id, feature_key, delta_each, qty,
                              stripe_item_id, status)
      values (${walletId}, null, 'orgs.max_owned', 1, 4, ${"si_" + randomUUID()}, 'canceled')`;

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.extraOrgCount).toBe(2); // not 5 (comp), not 6 (canceled), not 9
    expect(view.orgCap).toBe(10); // 5 base + 2 bought + 3 comped, canceled excluded
  });

  it("will not let the stepper drop below the organisations already standing on riders", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    await addOrgsToGroup(walletId, auth.userId, 6); // 7 live orgs on a base of 5

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.liveOrgCount).toBe(7);
    expect(view.orgCap).toBe(7);
    // Both riders are carrying an organisation, so the floor equals the count:
    // the control can raise but not lower. A hardcoded 0 fails here.
    expect(view.minExtraOrgs).toBe(2);
    expect(view.extraOrgCount).toBe(2);
  });

  it("never quotes a floor above what was purchased, even over cap", async () => {
    // Caps are ADMISSION-ONLY, so a group holding more organisations than its
    // capacity is an ordinary state (a downgrade, an expired comp). The raw
    // arithmetic would blame the whole overhang on riders and refuse a
    // cancellation with a number the customer never bought.
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 1);
    await addOrgsToGroup(walletId, auth.userId, 8); // 9 live orgs, capacity 6

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.liveOrgCount).toBe(9);
    expect(view.minExtraOrgs).toBe(1); // clamped to the one rider bought, not 3
    expect(view.minExtraOrgs).toBeLessThanOrEqual(view.extraOrgCount);
  });

  // ── the `capReduced` ordering: an UNLIMITED purchased cap ────────────────
  //
  // `capReduced` asks `admissionCap !== null && (orgCap === null || admissionCap
  // < orgCap)`. The null arm is the whole reorder, and the naive ordering
  // (`orgCap !== null && …`) answers false for it while every healthy fixture
  // above stays green.
  //
  // Reaching it needs a group whose PURCHASED cap is unlimited while its
  // ADMISSION cap is finite. A null `int_value` override is unlimited
  // (lib/auth.ts, and the admin route writes `int_value ?? null` for exactly
  // that grant), and it SURVIVES the resolver's dunning degradation — so a
  // past_due group is not that state, and the pair of tests below says so in
  // both directions rather than asserting one and hoping.

  it("flags the reduction when the purchased cap is UNLIMITED and admission is not", async () => {
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    // Staff-written UNLIMITED, on the org that resolves the group's cap.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'orgs.max_owned', null)`;
    // Every live organisation suspended. `groupOrgLimit`'s degenerate branch
    // then reads `plan_entitlements` straight — it documents that per-org
    // overrides are LOST there — so admission falls back to the Pro base of 5
    // while the receipt still says unlimited. That divergence is the state, and
    // moderation reaching it is not exotic.
    await sql`update organizations set status = 'suspended' where subscription_id = ${walletId}`;
    await sql`
      update subscriptions set stripe_subscription_id = ${"sub_" + randomUUID()}
       where id = ${walletId}`;
    await invalidateOrgEntitlements(auth.orgId);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");

    // FIRST, so the fixture cannot pass un-degraded: the purchased cap really
    // is unlimited, and admission really is finite and below it.
    expect(view.orgCap).toBeNull();
    expect(await groupOrgLimit(walletId)).toBe(5);
    expect(view.capReduced).toBe(true);
  });

  it("does NOT flag it when an unlimited override survives the degradation", async () => {
    // The negative half, and the reason `capReduced` is not simply
    // `orgCap === null`. Dunning degrades the PLAN, but the override outranks
    // the plan row in `resolve()`, so both caps stay unlimited and the two
    // agree — there is nothing to tell the customer.
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'orgs.max_owned', null)`;
    await sql`
      update subscriptions
         set status = 'past_due', status_changed_at = now() - interval '20 days',
             stripe_subscription_id = ${"sub_" + randomUUID()}
       where id = ${walletId}`;
    await invalidateOrgEntitlements(auth.orgId);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");

    expect(view.orgCap).toBeNull();
    expect(await groupOrgLimit(walletId)).toBeNull();
    expect(view.capReduced).toBe(false);
  });

  it("reads a staff override as the base, not the plan row", async () => {
    // An override REPLACES the plan base, and the >= 25 population this feature
    // courts is exactly where staff write one. Reading `plan_entitlements`
    // instead would tell a comped group it is standing on riders it does not
    // need and refuse to let it cancel them.
    const { auth } = await seedOrg("pro");
    const walletId = await walletIdFor(auth.orgId);
    await buyRiders(walletId, 2);
    await addOrgsToGroup(walletId, auth.userId, 9); // 10 live orgs
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${auth.orgId}, 'orgs.max_owned', 30)`;
    await invalidateOrgEntitlements(auth.orgId);

    const view = await getAddOnsTab(auth.orgId, auth.userId, "usd");
    expect(view.orgCap).toBe(32); // 30 override + 2 riders, NOT 5 + 2
    expect(view.minExtraOrgs).toBe(0); // the override carries all 10 orgs
  });
});
