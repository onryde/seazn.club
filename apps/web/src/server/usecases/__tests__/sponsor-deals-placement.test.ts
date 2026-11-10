// Sponsor deals, batch G (controller ruling (g); plan D8; spec §5.1, §5.3, §10 Q3): placement provenance. D8's all-ended reset
// (partner, whole org, off the stream) exists to undo what a DEAL wrote on its sponsor. Before this batch it fired on every
// transition into all-ended, so ending an invoice that never went live wiped the placement the club had set by hand. The rule
// now: `sponsors.placement_from_deal_id` names the deal whose snapshot the sponsor carries — the live write sets it, the
// transition into all-ended resets tier, scope and stream ONLY when it is set (status is always `inactive`) and then clears it,
// and a hand PATCH of tier, competition_id or on_stream clears it.
//
// Every case drives the REAL producers and exits over real Postgres (createSponsor, patchSponsor, createDeal, endDealNow,
// markDealPaid, refundDeal, sweepSponsorDeals, and the payment, refund and dispute webhook handlers) and reads the sponsor back
// from its row and through the public resolver. Stripe and the mail transport are the only seams replaced.
//
// Where each expected value comes from (never from deal-apply.ts):
//   - HAND: the placement this test sets by hand (Gold, on competition C, on the stream), so a reset cannot match it by accident;
//   - RESET: D8's "All deals ended: inactive, tier partner, scope null, on_stream false";
//   - the provenance column: the ruling's own words — set by the live write, cleared by the transition and by a hand PATCH of
//     tier / competition_id / on_stream, and ON DELETE SET NULL.
//
// The sequence (TEST-STRATEGY rule 1): (a) the empty case of provenance (a deal that never went live); (b) a deal that WAS live,
// swapped out by end_current, then the open one ends; (c) a second deal after a reset and a hand switch-back-on; (c2) each hand
// writer taking the placement over, with the name-only patch as the negative pair; (d) the other three exits; (e) a void —
// the deal provenance names deleted. "Another sport" is not applicable (sponsors read no sport key); every world is Pro, the
// one plan that lets the club hand-set a tier and a scope at all (spec §10 Q1).
//
// On HEAD 14c2997fa9: (a), (c), (c2) and (d) fail on the placement (the reset wiped it); (b) and (e) behave the same as HEAD on
// tier/scope/stream by construction (HEAD resets on every transition) and fail on the provenance column, which HEAD never
// writes. (b)'s behavioural teeth are against the naive fix ("reset only if the ended deal was live"): see the batch G report.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } },
    refunds: { create: stripe.refund },
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_test" })) }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stubOutboxEnv } from "./_invite-mail";
import {
  createSponsor,
  deleteSponsor,
  handleSponsorDispute,
  handleSponsorPaymentSucceeded,
  patchSponsor,
  resolveSponsors,
  type PatchSponsorInput,
} from "../sponsors";
import { createDeal, endDealNow, markDealPaid, refundDeal, sweepSponsorDeals, type CreateDealInput } from "../sponsor-deals";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[], userIds: [] as string[] };
const ORIGIN = "https://placement.test";
const DAY = 86_400_000;

beforeEach(() => {
  stubOutboxEnv();
  stripe.create.mockReset().mockImplementation(async () => ({
    id: `cs_${uniq()}`,
    url: `https://checkout.stripe.test/${uniq()}`,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
  }));
  stripe.retrieve.mockReset().mockImplementation(async () => ({ status: "open" }));
  stripe.expire.mockReset().mockImplementation(async () => ({ status: "expired" }));
  stripe.refund.mockReset().mockImplementation(async () => ({ id: `re_${uniq()}`, status: "succeeded" }));
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) {
    await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
    await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Org {
  orgId: string;
  auth: AuthCtx;
  /** Competition C: where the club hand-places its sponsor. */
  compId: string;
  /** Another competition: the positive pair of every scoped public read. */
  otherCompId: string;
  /** Gold, includes On stream, whole org: what a live deal writes on its sponsor (never the hand placement). */
  goldStreamPkg: string;
  /** Partner, no stream, whole org: the never-live invoice. */
  partnerPkg: string;
}

/** A Pro org (the plan that lets a club hand-set a tier and a scope, spec §10 Q1), Connect-live so it can sell online. */
async function org(): Promise<Org> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`placement-${uniq()}@test.local`}, 'Deal Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled)
    values (${`Placement ${s}`}, ${`placement-${s}`}, ${userId}, ${`acct_${s}`}, true) returning id`;
  made.orgIds.push(orgId);
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Placement Cup', ${`placement-cup-${s}`}) returning id`;
  const [{ id: otherCompId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Other Cup', ${`other-cup-${s}`}) returning id`;
  const pkg = async (tier: string, onStream: boolean) =>
    (
      await sql<{ id: string }[]>`
        insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier, includes_on_stream)
        values (${orgId}, ${null}, ${`Pkg ${tier} ${uniq()}`}, 25000, 'gbp', ${tier}, ${onStream}) returning id`
    )[0]!.id;
  return {
    orgId,
    compId,
    otherCompId,
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    goldStreamPkg: await pkg("gold", true),
    partnerPkg: await pkg("partner", false),
  };
}

interface Placement {
  status: string;
  tier: string;
  competition_id: string | null;
  on_stream: boolean;
  placement_from_deal_id: string | null;
}
const placement = async (id: string): Promise<Placement> =>
  (await sql<Placement[]>`
    select status, tier, competition_id, on_stream, placement_from_deal_id from sponsors where id = ${id}`)[0]!;

/** D8, typed: the transition into all-ended for a placement a deal wrote. */
const RESET = { status: "inactive", tier: "partner", competition_id: null, on_stream: false, placement_from_deal_id: null };

/** The club's own placement, set by hand: Gold, on competition C, on the stream. No deal wrote it. */
const hand = (o: Org) => ({ tier: "gold", competition_id: o.compId, on_stream: true });

/** A sponsor the club placed by hand through the real producers: created Gold on C, then ticked onto the stream. */
async function handPlaced(o: Org): Promise<string> {
  const row = await createSponsor(o.auth, { name: `Harbourside ${uniq()}`, tier: "gold", competition_id: o.compId, status: "active" });
  await patchSponsor(o.auth, row.id, { on_stream: true });
  expect(await placement(row.id), "premise: the hand placement, no deal behind it").toEqual({
    status: "active", ...hand(o), placement_from_deal_id: null,
  });
  return row.id;
}

/** A sponsor added by hand with nothing set: partner, whole org, off the stream (createSponsor's defaults). */
async function plainSponsor(o: Org): Promise<string> {
  return (await createSponsor(o.auth, { name: `Quay ${uniq()}`, tier: "partner", competition_id: null, status: "active" })).id;
}

const input = (packageId: string, over: Partial<CreateDealInput> = {}): CreateDealInput => ({
  package_id: packageId,
  competition_id: null,
  payment_method: "offline",
  go_live: "on_payment",
  sponsor_email: null,
  ends_on: null,
  end_current: false,
  ...over,
});

const dealRow = async (id: string) =>
  (await sql<{ deal_status: string; ended_reason: string | null; live_at: Date | null; status: string }[]>`
    select deal_status, ended_reason, live_at, status from sponsor_orders where id = ${id}`)[0];

const listed = async (o: Org, compId: string, opts: { onStream?: boolean } = {}): Promise<string[]> =>
  (await resolveSponsors(o.orgId, compId, opts)).map((s) => s.id);

/** A deal live at once and complimentary (every plan, no money): the deal that WRITES a placement — Gold, whole org, on the
 *  stream. */
async function liveGoldDeal(o: Org, sponsorId: string): Promise<string> {
  const { deal } = await createDeal(o.auth, sponsorId, input(o.goldStreamPkg, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN);
  expect(deal.deal_status, "premise: live at once").toBe("live");
  return deal.id;
}

/** An online "After I approve" deal, paid by a card at Stripe (the real payment webhook): paid, awaiting approval, never live. */
async function paidByCardNeverLive(o: Org, sponsorId: string): Promise<{ dealId: string; intent: string }> {
  const { deal } = await createDeal(
    o.auth,
    sponsorId,
    input(o.partnerPkg, { payment_method: "online", go_live: "on_approval", sponsor_email: `pay-${uniq()}@test.local` }),
    ORIGIN,
  );
  const intent = `pi_placement_${uniq()}`;
  await handleSponsorPaymentSucceeded({
    id: intent,
    metadata: { kind: "sponsor", order_id: deal.id, org_id: o.orgId },
  } as unknown as Stripe.PaymentIntent);
  expect(await dealRow(deal.id), "premise: paid at Stripe, waiting for approval, never live").toMatchObject({
    deal_status: "awaiting_approval", status: "paid", live_at: null,
  });
  return { dealId: deal.id, intent };
}

describe.skipIf(!HAS_DB)("(g) placement provenance: the D8 reset undoes only what a deal wrote", () => {
  it("(a) End now on an invoice that never went live leaves a hand-placed Gold sponsor on C and on the stream (inactive only); switched back on, it shows as Gold on C and on the stream", async () => {
    const o = await org();
    const id = await handPlaced(o);
    const { deal } = await createDeal(
      o.auth,
      id,
      input(o.partnerPkg, { payment_method: "online", sponsor_email: `pay-${uniq()}@test.local` }),
      ORIGIN,
    );
    expect(deal.deal_status, "premise: an invoice awaiting its payment").toBe("awaiting_payment");
    expect(await placement(id), "an open deal only hides the sponsor").toEqual({ status: "inactive", ...hand(o), placement_from_deal_id: null });

    const ended = await endDealNow(o.auth, deal.id);
    expect(ended).toMatchObject({ deal_status: "ended", ended_reason: "ended_now", live_at: null });
    expect(await placement(id), "the deal never wrote the placement, so it is the club's: kept").toEqual({
      status: "inactive", ...hand(o), placement_from_deal_id: null,
    });
    expect(await listed(o, o.compId), "inactive: off the public page").not.toContain(id);

    // Spec §10 Q3: the club switches it back on by hand, "as for a sponsor with no deal" — and gets back what it had.
    await patchSponsor(o.auth, id, { status: "active" });
    const onC = (await resolveSponsors(o.orgId, o.compId)).find((s) => s.id === id);
    expect(onC?.tier, "back on C as Gold").toBe("gold");
    expect(await listed(o, o.compId, { onStream: true }), "and in C's stream rotation").toContain(id);
    expect(await listed(o, o.otherCompId), "and still scoped to C: another competition does not list it").not.toContain(id);
  });

  it("(b) a live deal swapped out by end_current leaves its snapshot (and its id) on the sponsor while the new deal waits; when that one ends, the sponsor is reset to partner, whole org, off the stream", async () => {
    const o = await org();
    const id = await plainSponsor(o);
    const a = await liveGoldDeal(o, id);
    expect(await placement(id), "A is live: its snapshot, and its id as the provenance").toEqual({
      status: "active", tier: "gold", competition_id: null, on_stream: true, placement_from_deal_id: a,
    });

    const { deal: b } = await createDeal(o.auth, id, input(o.partnerPkg, { end_current: true }), ORIGIN);
    expect(b.deal_status).toBe("awaiting_payment");
    expect((await dealRow(a))?.deal_status, "end_current ended A").toBe("ended");
    expect(await placement(id), "B waits: hidden, A's snapshot still on the row, still A's").toEqual({
      status: "inactive", tier: "gold", competition_id: null, on_stream: true, placement_from_deal_id: a,
    });

    await endDealNow(o.auth, b.id);
    expect((await dealRow(b.id))?.live_at, "premise: B never went live").toBeNull();
    expect(await placement(id), "the last deal ended and the placement was a deal's: D8's reset").toEqual(RESET);
  });

  it("(c) after a reset the club hand-sets Gold and switches the sponsor back on; a later deal that never goes live ends and the Gold stays", async () => {
    const o = await org();
    const id = await plainSponsor(o);
    const a = await liveGoldDeal(o, id);
    await endDealNow(o.auth, a);
    expect(await placement(id), "premise: A was live, so its end resets").toEqual(RESET);

    await patchSponsor(o.auth, id, { tier: "gold", status: "active" });
    const { deal: b } = await createDeal(o.auth, id, input(o.partnerPkg), ORIGIN);
    expect(await placement(id), "B hides it, nothing else").toEqual({
      status: "inactive", tier: "gold", competition_id: null, on_stream: false, placement_from_deal_id: null,
    });
    await endDealNow(o.auth, b.id);
    expect(await placement(id), "B never wrote the placement: the club's Gold stays").toEqual({
      status: "inactive", tier: "gold", competition_id: null, on_stream: false, placement_from_deal_id: null,
    });
  });

  it("(c2) a hand PATCH of tier, competition_id or on_stream (the On-stream tick) takes the placement over from the swapped-out deal, so the open deal's end keeps it; a name-only patch does not (all four)", async () => {
    // A's snapshot is Gold / whole org / on the stream; each patch changes ONE field, and the expected row is the patch over A's
    // snapshot, inactive. The name-only patch leaves the provenance with A, so the end resets (the pair).
    const o = await org();
    const A = { tier: "gold", competition_id: null as string | null, on_stream: true };
    const CASES: [string, PatchSponsorInput, Omit<Placement, "status" | "placement_from_deal_id"> | null][] = [
      ["tier", { tier: "silver" }, { ...A, tier: "silver" }],
      ["competition_id", { competition_id: o.compId }, { ...A, competition_id: o.compId }],
      ["on_stream (the On-stream tick)", { on_stream: false }, { ...A, on_stream: false }],
      ["name only", { name: `Renamed ${uniq()}` }, null],
    ];
    let checked = 0;
    for (const [label, patch, kept] of CASES) {
      const id = await plainSponsor(o);
      const a = await liveGoldDeal(o, id);
      const { deal: b } = await createDeal(o.auth, id, input(o.partnerPkg, { end_current: true }), ORIGIN);
      expect((await placement(id)).placement_from_deal_id, `${label}: premise, A's snapshot is on the row`).toBe(a);

      await patchSponsor(o.auth, id, patch);
      expect((await placement(id)).placement_from_deal_id, `${label}: provenance after the patch`).toBe(kept === null ? a : null);
      await endDealNow(o.auth, b.id);
      expect(await placement(id), label).toEqual(kept === null ? RESET : { status: "inactive", ...kept, placement_from_deal_id: null });
      checked++;
    }
    expect(checked, "hand writers checked").toBe(CASES.length);
  });

  it("(d) the same as (a) through every other exit of a deal that never went live: the sweep, a card refund, a recorded refund, a lost dispute (all four)", async () => {
    const o = await org();
    type Exit = { label: string; reason: string; run: (id: string) => Promise<string> };
    const EXITS: Exit[] = [
      {
        label: "the sweep (its end date passed)",
        reason: "expired",
        run: async (id) => {
          const endsOn = new Date(Date.now() + DAY).toISOString().slice(0, 10);
          const { deal } = await createDeal(o.auth, id, input(o.partnerPkg, { ends_on: endsOn }), ORIGIN);
          const swept = await sweepSponsorDeals(new Date(Date.now() + 3 * DAY), { orgIds: [o.orgId] });
          expect(swept.expired, "the sweep ended it").toBeGreaterThanOrEqual(1);
          return deal.id;
        },
      },
      {
        label: "a refund of a deal paid by card at Stripe",
        reason: "refunded",
        run: async (id) => {
          const { dealId, intent } = await paidByCardNeverLive(o, id);
          await refundDeal(o.auth, dealId);
          expect(stripe.refund.mock.calls.map((c) => (c[0] as { payment_intent: string }).payment_intent), "one Stripe refund, for its intent").toEqual([intent]);
          return dealId;
        },
      },
      {
        label: "a refund recorded by hand (offline, marked paid)",
        reason: "refunded",
        run: async (id) => {
          const { deal } = await createDeal(o.auth, id, input(o.partnerPkg, { go_live: "on_approval" }), ORIGIN);
          await markDealPaid(o.auth, deal.id);
          expect(await dealRow(deal.id), "premise: paid, waiting for approval").toMatchObject({ deal_status: "awaiting_approval", status: "paid" });
          await refundDeal(o.auth, deal.id);
          return deal.id;
        },
      },
      {
        label: "a lost dispute",
        reason: "dispute_lost",
        run: async (id) => {
          const { dealId, intent } = await paidByCardNeverLive(o, id);
          await handleSponsorDispute(
            { id: `dp_placement_${uniq()}`, payment_intent: intent, amount: 25000, status: "lost" } as unknown as Stripe.Dispute,
            "closed",
          );
          return dealId;
        },
      },
    ];
    let checked = 0;
    for (const exit of EXITS) {
      const id = await handPlaced(o);
      const dealId = await exit.run(id);
      expect(await dealRow(dealId), exit.label).toMatchObject({ deal_status: "ended", ended_reason: exit.reason, live_at: null });
      expect(await placement(id), exit.label).toEqual({ status: "inactive", ...hand(o), placement_from_deal_id: null });
      checked++;
    }
    expect(checked, "exits checked").toBe(EXITS.length);
  });

  it("(e) deleting the deal the provenance names sets it null and apply carries on (no 23503, no throw: null reads as hand-set, so the placement stays); deleting a sponsor whose placement came from its own live deal deletes both", async () => {
    const o = await org();
    const id = await plainSponsor(o);
    const a = await liveGoldDeal(o, id);
    const { deal: b } = await createDeal(o.auth, id, input(o.partnerPkg, { end_current: true }), ORIGIN);
    expect((await placement(id)).placement_from_deal_id, "premise: A's id").toBe(a);

    await sql`delete from sponsor_orders where id = ${a}`;
    expect(await placement(id), "ON DELETE SET NULL: the sponsor stays, its placement untouched, the key null").toEqual({
      status: "inactive", tier: "gold", competition_id: null, on_stream: true, placement_from_deal_id: null,
    });
    await expect(endDealNow(o.auth, b.id), "apply after the delete").resolves.toMatchObject({ deal_status: "ended" });
    expect(await placement(id), "no provenance left: kept, inactive").toEqual({
      status: "inactive", tier: "gold", competition_id: null, on_stream: true, placement_from_deal_id: null,
    });

    // The product path that deletes a deal its sponsor's provenance names: deleteSponsor deletes the deals, then the sponsor.
    const other = await plainSponsor(o);
    const live = await liveGoldDeal(o, other);
    expect((await placement(other)).placement_from_deal_id, "premise: its own live deal").toBe(live);
    await expect(deleteSponsor(o.auth, other)).resolves.toBeUndefined();
    expect(await sql`select 1 from sponsors where id = ${other}`, "the sponsor is gone").toHaveLength(0);
    expect(await sql`select 1 from sponsor_orders where id = ${live}`, "and its deal").toHaveLength(0);
  });
});
