// Sponsor deals, Task 6 (plan 2026-11-07-sponsor-deals; spec §5.2, §5.3, §8, §8a): the deal usecases with no Stripe —
// create, mark paid, approve, end now, offline refund, list and get — over real Postgres.
//
// What is under test, and where each expected value comes from:
//   - the §5.2 path of every offline and complimentary combination, the table typed BELOW from the spec (never read back
//     from lib/sponsor-deals.ts), after every step: the deal's status, its money status, its sponsor's status and whether the
//     public strip lists the sponsor (`resolveSponsors`);
//   - anti-goal 2 ("After I approve" never goes live on payment alone), Review Focus 2 (two Approves: one transition, one
//     409, one live_at) and 5 (a second deal queues behind a live one; "end the current deal" swaps them in one transaction);
//   - F2: two deals of one sponsor moved at once both commit (the one lock order, no 40P01);
//   - F12: no DealRuleError escapes a usecase — an action allowedActions does not offer is a 409 before any write, and a rule
//     refusal past it is still an HttpError (409 / 422), never a 500;
//   - every refusal next to its accepted twin, so an over-refusing guard cannot pass;
//   - "another sport" is not applicable (sponsors read no sport key); its substitute is another PLAN: community (offline and
//     complimentary partner deals on the whole org work; online and gold are 402) and Pro.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Stripe and the mail transport are the two network seams; nothing in Task 6 reaches either (an online deal is created as a
// draft), and Task 7's online create reaches both through these mocks.
const stripeMock = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripeMock.create, retrieve: stripeMock.retrieve, expire: stripeMock.expire } },
    refunds: { create: stripeMock.refund },
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_test" })) }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { allowedActions, endsOnOf, type DealStatus, type GoLiveRule, type PaymentMethod, type PaymentStatus } from "@/lib/sponsor-deals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stubOutboxEnv } from "./_invite-mail";
import { resolveSponsors } from "../sponsors";
import {
  approveDeal,
  createDeal,
  endDealNow,
  getDeal,
  listDeals,
  markDealPaid,
  refundDeal,
  type CreateDealInput,
} from "../sponsor-deals";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[], userIds: [] as string[] };
const ORIGIN = "https://deals.test";

beforeEach(() => {
  stubOutboxEnv();
  stripeMock.create.mockReset().mockImplementation(async () => ({ id: `cs_${uniq()}`, url: `https://checkout.stripe.test/${uniq()}`, expires_at: Math.floor(Date.now() / 1000) + 86_400 }));
  stripeMock.retrieve.mockReset();
  stripeMock.expire.mockReset();
  stripeMock.refund.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_invoice_counters where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) {
    // setOrgPlan bills a Pro org through a group its owner (our user) carries.
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
  userId: string;
  compId: string;
}

/** An org on `plan` whose editor is a real account (so `created_by`, `marked_paid_by` and `approved_by` can be read back),
 *  with one competition. `connect`: a Connect-onboarded account. `timezone`: the org's (null is the column's NULL). */
async function org(plan: "community" | "pro", o: { connect?: boolean; timezone?: string | null } = {}): Promise<Org> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`deals-${uniq()}@test.local`}, 'Deal Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled, timezone)
    values (${`Deals ${s}`}, ${`deals-${s}`}, ${userId}, ${o.connect ? `acct_${s}` : null}, ${o.connect ?? false}, ${o.timezone ?? null})
    returning id`;
  made.orgIds.push(orgId);
  if (plan === "pro") await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Deals Cup', ${`deals-cup-${s}`}) returning id`;
  return { orgId, userId, compId, auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

/** A package, written straight to its table (so a community org can hold a gold one: the state a downgrade leaves). */
async function pkg(
  o: Org,
  p: { tier?: string; competition_id?: string | null; includes_on_stream?: boolean; active?: boolean; price_cents?: number } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier, includes_on_stream, active)
    values (${o.orgId}, ${p.competition_id ?? null}, ${`Pkg ${uniq()}`}, ${p.price_cents ?? 25_000}, 'gbp', ${p.tier ?? "partner"},
            ${p.includes_on_stream ?? false}, ${p.active ?? true})
    returning id`;
  return row!.id;
}

/** A no-deal sponsor, live by hand (manual control) — what "add a sponsor" leaves. */
async function sponsor(o: Org, name = `Acme ${uniq()}`): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, status) values (${o.orgId}, ${name}, 'partner', 'active') returning id`;
  return row!.id;
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

const sponsorOf = async (id: string) =>
  (await sql<{ status: string; tier: string; competition_id: string | null; on_stream: boolean }[]>`
    select status, tier, competition_id, on_stream from sponsors where id = ${id}`)[0]!;
/** On the public strip (the org-wide read every public page makes). */
const listed = async (o: Org, sponsorId: string): Promise<boolean> =>
  (await resolveSponsors(o.orgId)).some((s) => s.id === sponsorId);
const dealBytes = async (id: string): Promise<string | null> =>
  (await sql<{ row: string }[]>`select to_jsonb(d)::text as row from sponsor_orders d where d.id = ${id}`)[0]?.row ?? null;
const dealCount = async (o: Org): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_orders where org_id = ${o.orgId}`)[0]!.n;

/** What a call refused with: the status and code of an HttpError, and whether it WAS one (a DealRuleError or a DB error is
 *  not, and reads as a 500 at the route). A call that succeeded answers `no_refusal`. */
async function refusal(fn: () => Promise<unknown>): Promise<{ http: boolean; status: number | undefined; code: string | undefined }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { http: err instanceof HttpError, status: e.status, code: e.code };
  }
  return { http: false, status: undefined, code: "no_refusal" };
}

describe.skipIf(!HAS_DB)("listDeals and getDeal (DB)", () => {
  it("empty first: a sponsor with no deals lists [], and so does an org with none", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    expect(await listDeals(o.auth, { sponsorId: id })).toEqual([]);
    expect(await listDeals(o.auth)).toEqual([]);
  });

  it("lists a sponsor's deals (newest first) without another sponsor's or another org's; get answers one, a foreign id 404", async () => {
    const o = await org("community");
    const other = await org("community");
    const p = await pkg(o);
    const a = await sponsor(o);
    const b = await sponsor(o);
    const first = (await createDeal(o.auth, a, input(p), ORIGIN)).deal;
    const second = (await createDeal(o.auth, a, input(p, { payment_method: "complimentary", go_live: "on_approval" }), ORIGIN)).deal;
    const elsewhere = (await createDeal(o.auth, b, input(p), ORIGIN)).deal;
    expect((await listDeals(o.auth, { sponsorId: a })).map((d) => d.id)).toEqual([second.id, first.id]);
    expect((await listDeals(o.auth)).map((d) => d.id).sort()).toEqual([first.id, second.id, elsewhere.id].sort());
    expect(await listDeals(other.auth, { sponsorId: a }), "another org reads none of them").toEqual([]);
    expect((await getDeal(o.auth, first.id)).id).toBe(first.id);
    expect(await refusal(() => getDeal(other.auth, first.id))).toMatchObject({ http: true, status: 404 });
    expect(await refusal(() => getDeal(o.auth, randomUUID()))).toMatchObject({ http: true, status: 404 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Spec §5.2, typed: each offline and complimentary combination, step by step.
// ---------------------------------------------------------------------------------------------------------------------------

type Step = {
  action: "create" | "mark_paid" | "approve";
  deal_status: DealStatus;
  payment_status: PaymentStatus;
  sponsor: "active" | "inactive";
  listed: boolean;
};
/** Spec §5.2: Offline is "the same three rules, with Mark as paid replacing the webhook"; Complimentary has "no payment
 *  states" and "When paid is not offered". A hidden deal hides its sponsor (§5.3, §8a). */
const TABLE: { method: PaymentMethod; rule: GoLiveRule; steps: Step[] | "refused_on_payment_needs_payment" }[] = [
  {
    method: "offline", rule: "on_payment", steps: [
      { action: "create", deal_status: "awaiting_payment", payment_status: "pending", sponsor: "inactive", listed: false },
      { action: "mark_paid", deal_status: "live", payment_status: "paid", sponsor: "active", listed: true },
    ],
  },
  {
    method: "offline", rule: "immediate", steps: [
      { action: "create", deal_status: "live", payment_status: "pending", sponsor: "active", listed: true },
      { action: "mark_paid", deal_status: "live", payment_status: "paid", sponsor: "active", listed: true },
    ],
  },
  {
    method: "offline", rule: "on_approval", steps: [
      { action: "create", deal_status: "awaiting_payment", payment_status: "pending", sponsor: "inactive", listed: false },
      { action: "mark_paid", deal_status: "awaiting_approval", payment_status: "paid", sponsor: "inactive", listed: false },
      { action: "approve", deal_status: "live", payment_status: "paid", sponsor: "active", listed: true },
    ],
  },
  { method: "complimentary", rule: "on_payment", steps: "refused_on_payment_needs_payment" },
  {
    method: "complimentary", rule: "immediate", steps: [
      { action: "create", deal_status: "live", payment_status: "none", sponsor: "active", listed: true },
    ],
  },
  {
    method: "complimentary", rule: "on_approval", steps: [
      { action: "create", deal_status: "awaiting_approval", payment_status: "none", sponsor: "inactive", listed: false },
      { action: "approve", deal_status: "live", payment_status: "none", sponsor: "active", listed: true },
    ],
  },
];

describe.skipIf(!HAS_DB)("every offline and complimentary combination follows spec §5.2 (DB, community)", () => {
  it("the six combinations, each step's deal, money, sponsor and public strip (counted)", async () => {
    const o = await org("community");
    const p = await pkg(o);
    let combos = 0;
    let steps = 0;
    for (const row of TABLE) {
      const label = `${row.method} + ${row.rule}`;
      const id = await sponsor(o);
      if (row.steps === "refused_on_payment_needs_payment") {
        const before = await dealCount(o);
        expect(await refusal(() => createDeal(o.auth, id, input(p, { payment_method: row.method, go_live: row.rule }), ORIGIN)), label)
          .toEqual({ http: true, status: 422, code: "on_payment_needs_payment" });
        expect(await dealCount(o), `${label}: no row`).toBe(before);
        combos++;
        continue;
      }
      let dealId = "";
      for (const step of row.steps) {
        const where = `${label} after ${step.action}`;
        if (step.action === "create") {
          const out = await createDeal(o.auth, id, input(p, { payment_method: row.method, go_live: row.rule }), ORIGIN);
          expect(out.invoice_url, `${where}: no invoice link for a deal that is not online - nothing was emailed (F11)`).toBeNull();
          dealId = out.deal.id;
        } else if (step.action === "mark_paid") {
          await markDealPaid(o.auth, dealId);
        } else {
          await approveDeal(o.auth, dealId);
        }
        const deal = await getDeal(o.auth, dealId);
        expect({ deal_status: deal.deal_status, payment_status: deal.payment_status }, where).toEqual({
          deal_status: step.deal_status,
          payment_status: step.payment_status,
        });
        expect((await sponsorOf(id)).status, `${where}: sponsor`).toBe(step.sponsor);
        expect(await listed(o, id), `${where}: public strip`).toBe(step.listed);
        if (step.deal_status === "live") expect(deal.live_at, `${where}: live_at stamped`).not.toBeNull();
        steps++;
      }
      combos++;
    }
    expect(combos, "combinations checked").toBe(6);
    expect(steps, "steps checked: 2 + 2 + 3 + 1 + 2 rows of TABLE").toBe(10);
  });

  it("the actors are stamped: created_by, marked_paid_by, approved_by are the editor; paid_at and approved_at are set", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const { deal } = await createDeal(o.auth, id, input(await pkg(o), { go_live: "on_approval" }), ORIGIN);
    expect(deal.created_by).toBe(o.userId);
    const paid = await markDealPaid(o.auth, deal.id);
    expect({ by: paid.marked_paid_by, at: paid.paid_at !== null }).toEqual({ by: o.userId, at: true });
    const approved = await approveDeal(o.auth, deal.id);
    expect({ by: approved.approved_by, at: approved.approved_at !== null }).toEqual({ by: o.userId, at: true });
  });

  it("the snapshot is the package's at creation (D4): tier, stream, name, scope and price; a later package edit moves nothing", async () => {
    const o = await org("pro");
    const p = await pkg(o, { tier: "gold", competition_id: o.compId, includes_on_stream: true, price_cents: 42_000 });
    const id = await sponsor(o);
    const { deal } = await createDeal(o.auth, id, input(p, { competition_id: o.compId, payment_method: "complimentary", go_live: "immediate" }), ORIGIN);
    const [pk] = await sql<{ name: string }[]>`select name from sponsor_packages where id = ${p}`;
    expect(deal).toMatchObject({ tier: "gold", includes_on_stream: true, package_name: pk!.name, competition_id: o.compId, amount_cents: 42_000, currency: "gbp" });
    await sql`update sponsor_packages set tier = 'silver', price_cents = 1, name = 'Renamed' where id = ${p}`;
    expect(await getDeal(o.auth, deal.id)).toMatchObject({ tier: "gold", amount_cents: 42_000, package_name: pk!.name });
    // And the live deal is on the sponsor (D8): its tier, scope and stream.
    expect(await sponsorOf(id)).toEqual({ status: "active", tier: "gold", competition_id: o.compId, on_stream: true });
  });
});

describe.skipIf(!HAS_DB)("the go-live rule decides, not the payment (DB)", () => {
  it("anti-goal 2: offline + After I approve, marked paid, is still NOT on the public strip; approved, it is", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const { deal } = await createDeal(o.auth, id, input(await pkg(o), { go_live: "on_approval" }), ORIGIN);
    await markDealPaid(o.auth, deal.id);
    expect(await listed(o, id), "paid is not approved").toBe(false);
    expect((await getDeal(o.auth, deal.id)).deal_status).toBe("awaiting_approval");
    await approveDeal(o.auth, deal.id);
    expect(await listed(o, id), "approved: live").toBe(true);
  });

  it("Review Focus 2: two Approves at once — one transition, one 409 deal_not_awaiting_approval, one live_at", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const { deal } = await createDeal(o.auth, id, input(await pkg(o), { go_live: "on_approval" }), ORIGIN);
    await markDealPaid(o.auth, deal.id);
    const results = await Promise.allSettled([approveDeal(o.auth, deal.id), approveDeal(o.auth, deal.id)]);
    expect(results.filter((r) => r.status === "fulfilled"), "exactly one transition").toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(HttpError);
    expect(rejected[0]!.reason).toMatchObject({ status: 409, code: "deal_not_awaiting_approval" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_orders where sponsor_id = ${id} and live_at is not null`;
    expect(n, "one live_at").toBe(1);
  });

  it("two Mark as paid at once — one transition, one 409 deal_already_paid", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const { deal } = await createDeal(o.auth, id, input(await pkg(o)), ORIGIN);
    const results = await Promise.allSettled([markDealPaid(o.auth, deal.id), markDealPaid(o.auth, deal.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r): r is PromiseRejectedResult => r.status === "rejected")!.reason).toMatchObject({ status: 409, code: "deal_already_paid" });
  });

  it("a second End now answers 409 deal_ended, and the first's end is not moved", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const { deal } = await createDeal(o.auth, id, input(await pkg(o), { payment_method: "complimentary", go_live: "immediate" }), ORIGIN);
    const ended = await endDealNow(o.auth, deal.id);
    expect({ s: ended.deal_status, r: ended.ended_reason }).toEqual({ s: "ended", r: "ended_now" });
    const before = await dealBytes(deal.id);
    expect(await refusal(() => endDealNow(o.auth, deal.id))).toEqual({ http: true, status: 409, code: "deal_ended" });
    expect(await dealBytes(deal.id), "the second call wrote nothing").toBe(before);
    // D8: the last live deal ended, so the sponsor is reset and hidden.
    expect(await sponsorOf(id)).toEqual({ status: "inactive", tier: "partner", competition_id: null, on_stream: false });
    expect(await listed(o, id)).toBe(false);
  });

  it("offline refund: ended/refunded, the sponsor hidden, nothing more offered, nothing mailed; an unpaid deal refuses", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const { deal } = await createDeal(o.auth, id, input(await pkg(o)), ORIGIN);
    expect(await refusal(() => refundDeal(o.auth, deal.id)), "unpaid: nothing to refund").toEqual({ http: true, status: 409, code: "deal_not_refundable" });
    await markDealPaid(o.auth, deal.id);
    expect(await listed(o, id), "premise: live").toBe(true);
    const refunded = await refundDeal(o.auth, deal.id);
    expect({ s: refunded.deal_status, p: refunded.payment_status, r: refunded.ended_reason }).toEqual({ s: "ended", p: "refunded", r: "refunded" });
    expect(await listed(o, id)).toBe(false);
    expect((await sponsorOf(id)).status).toBe("inactive");
    expect(allowedActions(refunded)).toEqual([]);
    expect(stripeMock.refund, "no money moves offline").not.toHaveBeenCalled();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where ref_id = ${deal.id}`;
    expect(n, "no email for an offline refund (§5.2: recorded only)").toBe(0);
    expect(await refusal(() => refundDeal(o.auth, deal.id)), "a second refund").toEqual({ http: true, status: 409, code: "deal_not_refundable" });
  });
});

describe.skipIf(!HAS_DB)("one live deal per sponsor: the queue and the swap (DB)", () => {
  it("Review Focus 5: live A, then B straight away is scheduled; End now on A puts B live", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const p = await pkg(o);
    const a = (await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN)).deal;
    const b = (await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN)).deal;
    expect(a.deal_status).toBe("live");
    expect(b.deal_status, "never a second live").toBe("scheduled");
    await endDealNow(o.auth, a.id);
    const after = await getDeal(o.auth, b.id);
    expect(after.deal_status).toBe("live");
    expect(after.live_at).not.toBeNull();
    expect(await listed(o, id)).toBe(true);
  });

  it("beside a live deal, Mark as paid (when paid) and Approve each QUEUE the deal (scheduled, no live_at); End now on the live one promotes the oldest", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const p = await pkg(o);
    const a = (await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN)).deal;
    const b = (await createDeal(o.auth, id, input(p), ORIGIN)).deal;
    const c = (await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "on_approval" }), ORIGIN)).deal;
    const paid = await markDealPaid(o.auth, b.id);
    expect({ s: paid.deal_status, live_at: paid.live_at }, "paid beside a live deal").toEqual({ s: "scheduled", live_at: null });
    const approved = await approveDeal(o.auth, c.id);
    expect({ s: approved.deal_status, live_at: approved.live_at }, "approved beside a live deal").toEqual({ s: "scheduled", live_at: null });
    expect((await getDeal(o.auth, a.id)).deal_status, "the live deal is untouched").toBe("live");
    await endDealNow(o.auth, a.id);
    expect((await getDeal(o.auth, b.id)).deal_status, "B was queued first").toBe("live");
    expect((await getDeal(o.auth, c.id)).deal_status).toBe("scheduled");
  });

  it("end_current: live A, then B straight away with end_current — A ended_now, B live, the sponsor's live deal is B", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const p = await pkg(o);
    const a = (await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN)).deal;
    const { deal: b } = await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate", end_current: true }), ORIGIN);
    expect(b.deal_status).toBe("live");
    expect(await getDeal(o.auth, a.id)).toMatchObject({ deal_status: "ended", ended_reason: "ended_now" });
    const live = await sql<{ id: string }[]>`select id from sponsor_orders where sponsor_id = ${id} and deal_status = 'live'`;
    expect(live.map((r) => r.id)).toEqual([b.id]);
    expect(await listed(o, id)).toBe(true);
  });

  it("a refused end_current deal leaves the current deal live and untouched (every refusal precedes the swap)", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const p = await pkg(o);
    const a = (await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN)).deal;
    const before = await dealBytes(a.id);
    // A gold package on community: refused by the placement gate before the transaction.
    const gold = await pkg(o, { tier: "gold" });
    expect(await refusal(() => createDeal(o.auth, id, input(gold, { payment_method: "complimentary", go_live: "immediate", end_current: true }), ORIGIN)))
      .toMatchObject({ status: 402 });
    expect(await dealBytes(a.id), "A untouched").toBe(before);
  });

  it("F2: two deals of one sponsor moved at once (End now on A, Mark as paid on B) both commit, with no deadlock (5 rounds)", async () => {
    const o = await org("community");
    const p = await pkg(o);
    let rounds = 0;
    for (let i = 0; i < 5; i++) {
      const id = await sponsor(o);
      const a = (await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN)).deal;
      const b = (await createDeal(o.auth, id, input(p), ORIGIN)).deal;
      expect(b.deal_status, "premise: B awaits payment").toBe("awaiting_payment");
      const results = await Promise.allSettled([endDealNow(o.auth, a.id), markDealPaid(o.auth, b.id)]);
      const reasons = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String((r.reason as Error)?.message ?? r.reason));
      expect(reasons, `round ${i}: both fulfil (no 40P01)`).toEqual([]);
      // Either order converges: A ended, B paid and live (End then pay: B goes live on payment; pay then End: B was
      // scheduled behind A and End promotes it).
      expect(await getDeal(o.auth, a.id)).toMatchObject({ deal_status: "ended", ended_reason: "ended_now" });
      expect(await getDeal(o.auth, b.id)).toMatchObject({ deal_status: "live", payment_status: "paid" });
      expect(await listed(o, id)).toBe(true);
      rounds++;
    }
    expect(rounds).toBe(5);
  });
});

describe.skipIf(!HAS_DB)("refusals, each beside its accepted twin (DB)", () => {
  it("createDeal: package, sponsor, scope, competition, email, rule and end date (counted)", async () => {
    const pro = await org("pro", { connect: true });
    const noConnect = await org("pro");
    const s = await sponsor(pro);
    const anyComp = await pkg(pro);
    const oneComp = await pkg(pro, { competition_id: pro.compId });
    const retired = await pkg(pro, { active: false });
    const foreignComp = (await org("pro")).compId;
    const ncSponsor = await sponsor(noConnect);
    const ncPkg = await pkg(noConnect);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const ONLINE = { payment_method: "online", sponsor_email: "pay@acme.test" } as const;
    // [label, refused, the refusal, the accepted twin, the org whose rows the refusal must not touch]
    const cases: [string, () => Promise<unknown>, { status: number; code?: string }, () => Promise<unknown>, Org][] = [
      ["unknown package 404", () => createDeal(pro.auth, s, input(randomUUID()), ORIGIN), { status: 404 }, () => createDeal(pro.auth, s, input(anyComp), ORIGIN), pro],
      ["retired package 422", () => createDeal(pro.auth, s, input(retired), ORIGIN), { status: 422, code: "package_retired" }, () => createDeal(pro.auth, s, input(anyComp), ORIGIN), pro],
      ["unknown sponsor 404", () => createDeal(pro.auth, randomUUID(), input(anyComp), ORIGIN), { status: 404 }, () => createDeal(pro.auth, s, input(anyComp), ORIGIN), pro],
      ["one-competition package, whole-org scope 422", () => createDeal(pro.auth, s, input(oneComp), ORIGIN), { status: 422, code: "scope_outside_package" },
        () => createDeal(pro.auth, s, input(oneComp, { competition_id: pro.compId }), ORIGIN), pro],
      ["another org's competition 404", () => createDeal(pro.auth, s, input(anyComp, { competition_id: foreignComp }), ORIGIN), { status: 404 },
        () => createDeal(pro.auth, s, input(anyComp, { competition_id: pro.compId }), ORIGIN), pro],
      ["online without a billing email 422", () => createDeal(pro.auth, s, input(anyComp, { payment_method: "online" }), ORIGIN), { status: 422, code: "sponsor_email_required" },
        () => createDeal(pro.auth, s, input(anyComp, ONLINE), ORIGIN), pro],
      ["online without Connect 409", () => createDeal(noConnect.auth, ncSponsor, input(ncPkg, ONLINE), ORIGIN), { status: 409, code: "connect_required" },
        async () => {
          await sql`update organizations set stripe_account_id = ${`acct_${uniq()}`}, stripe_charges_enabled = true where id = ${noConnect.orgId}`;
          return createDeal(noConnect.auth, ncSponsor, input(ncPkg, ONLINE), ORIGIN);
        }, noConnect],
      ["complimentary when paid 422", () => createDeal(pro.auth, s, input(anyComp, { payment_method: "complimentary", go_live: "on_payment" }), ORIGIN),
        { status: 422, code: "on_payment_needs_payment" }, () => createDeal(pro.auth, s, input(anyComp, { payment_method: "complimentary", go_live: "on_approval" }), ORIGIN), pro],
      ["ends on a past day 422", () => createDeal(pro.auth, s, input(anyComp, { ends_on: yesterday }), ORIGIN), { status: 422, code: "ends_on_in_past" },
        () => createDeal(pro.auth, s, input(anyComp, { ends_on: today }), ORIGIN), pro],
    ];
    let checked = 0;
    for (const [label, refused, want, accepted, owner] of cases) {
      const before = await dealCount(owner);
      expect(await refusal(refused), label).toMatchObject({ http: true, ...want });
      expect(await dealCount(owner), `${label}: no row`).toBe(before);
      expect(await refusal(accepted), `${label}: the accepted twin`).toMatchObject({ code: "no_refusal" });
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBe(9);
  });

  it("the actions: each offered state passes, each state allowedActions does not offer is a 409 with no write (counted)", async () => {
    const o = await org("community");
    const p = await pkg(o);
    const fresh = async (over: Partial<CreateDealInput>) => (await createDeal(o.auth, await sponsor(o), input(p, over), ORIGIN)).deal.id;
    const cases: [string, (id: string) => Promise<unknown>, Partial<CreateDealInput>, string, Partial<CreateDealInput>][] = [
      ["mark paid on a complimentary deal", (id) => markDealPaid(o.auth, id), { payment_method: "complimentary", go_live: "immediate" }, "deal_not_payable", {}],
      ["approve a deal not awaiting approval", (id) => approveDeal(o.auth, id), { payment_method: "complimentary", go_live: "immediate" }, "deal_not_awaiting_approval",
        { payment_method: "complimentary", go_live: "on_approval" }],
      ["refund an unpaid deal", (id) => refundDeal(o.auth, id), {}, "deal_not_refundable", { go_live: "immediate" }],
    ];
    let checked = 0;
    for (const [label, act, refusedShape, code, acceptedShape] of cases) {
      const refusedId = await fresh(refusedShape);
      const before = await dealBytes(refusedId);
      expect(await refusal(() => act(refusedId)), label).toEqual({ http: true, status: 409, code });
      expect(await dealBytes(refusedId), `${label}: byte-equal`).toBe(before);
      const acceptedId = await fresh(acceptedShape);
      if (label.startsWith("refund")) await markDealPaid(o.auth, acceptedId);
      expect(await refusal(() => act(acceptedId)), `${label}: the accepted twin`).toMatchObject({ code: "no_refusal" });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an unknown or foreign deal id is 404 on every action", async () => {
    const o = await org("community");
    const other = await org("community");
    const theirs = (await createDeal(other.auth, await sponsor(other), input(await pkg(other)), ORIGIN)).deal.id;
    let checked = 0;
    for (const act of [markDealPaid, approveDeal, endDealNow, refundDeal]) {
      for (const id of [randomUUID(), theirs]) {
        expect(await refusal(() => act(o.auth, id))).toMatchObject({ http: true, status: 404 });
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("a legacy row (D6: a pre-deals order, no sponsor) is found, not 404: listed, read, and each action it does not offer is a 409 that writes nothing", async () => {
    const o = await org("community");
    const p = await pkg(o);
    // Exactly as the deals migration left a paid pre-deals order: ended as legacy, no sponsor, its charge recorded.
    const [{ id }] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status, paid_at,
                                  payment_intent_id, sponsor_id, deal_status, payment_method, go_live, ended_at, ended_reason,
                                  tier, includes_on_stream, package_name, competition_id)
      values (${o.orgId}, ${p}, 'Old Sponsor', 'old@x.test', 25000, 'gbp', 'paid', now(), ${`pi_legacy_${uniq()}`}, null,
              'ended', 'online', 'on_payment', now(), 'legacy', 'partner', false, 'Partner', null)
      returning id`;
    expect((await listDeals(o.auth)).map((d) => d.id)).toContain(id);
    expect((await getDeal(o.auth, id)).ended_reason).toBe("legacy");
    const before = await dealBytes(id);
    const cases = [
      [markDealPaid, "deal_already_paid"],
      [approveDeal, "deal_not_awaiting_approval"],
      [endDealNow, "deal_ended"],
    ] as const;
    let checked = 0;
    for (const [act, code] of cases) {
      expect(await refusal(() => act(o.auth, id)), code).toEqual({ http: true, status: 409, code });
      checked++;
    }
    expect(checked).toBe(3);
    expect(await dealBytes(id), "nothing written").toBe(before);
  });
});

describe.skipIf(!HAS_DB)("F12: no DealRuleError escapes a usecase (DB)", () => {
  it("Mark as paid on an online draft is a 409, never a 500, and the row is byte-equal", async () => {
    const o = await org("pro", { connect: true });
    const id = await sponsor(o);
    const p = await pkg(o);
    stripeMock.create.mockRejectedValue(new Error("stripe is down")); // Task 7: an online create then leaves the draft
    const created = await refusal(() => createDeal(o.auth, id, input(p, { payment_method: "online", sponsor_email: "pay@acme.test" }), ORIGIN));
    const [draft] = await sql<{ id: string; deal_status: string }[]>`select id, deal_status from sponsor_orders where sponsor_id = ${id}`;
    expect({ s: draft!.deal_status, created: created.code === "no_refusal" || created.status === 502 }, "premise: an online draft").toEqual({ s: "draft", created: true });
    const before = await dealBytes(draft!.id);
    expect(await refusal(() => markDealPaid(o.auth, draft!.id))).toMatchObject({ http: true, status: 409 });
    expect(await dealBytes(draft!.id)).toBe(before);
  });

  it("a rule refusal past allowedActions is still an HttpError: a hand-planted awaiting-payment deal on an immediate rule is a 409", async () => {
    // No producer makes this row (an immediate deal is created live), so it is planted: the state where allowedActions offers
    // Mark as paid and statusAfterPaid then refuses — the one place the boundary's 409 mapping answers on its own.
    const o = await org("community");
    const id = await sponsor(o);
    const p = await pkg(o);
    const { deal } = await createDeal(o.auth, id, input(p), ORIGIN);
    await sql`update sponsor_orders set go_live = 'immediate' where id = ${deal.id}`;
    const before = await dealBytes(deal.id);
    expect(await refusal(() => markDealPaid(o.auth, deal.id))).toEqual({ http: true, status: 409, code: "illegal_transition" });
    expect(await dealBytes(deal.id), "rolled back").toBe(before);
  });

  it("Approve on a live deal is a 409 and the row is byte-equal; complimentary when-paid is a 422 HttpError", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    const p = await pkg(o);
    const { deal } = await createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "immediate" }), ORIGIN);
    const before = await dealBytes(deal.id);
    expect(await refusal(() => approveDeal(o.auth, deal.id))).toEqual({ http: true, status: 409, code: "deal_not_awaiting_approval" });
    expect(await dealBytes(deal.id)).toBe(before);
    expect(await refusal(() => createDeal(o.auth, id, input(p, { payment_method: "complimentary", go_live: "on_payment" }), ORIGIN)))
      .toEqual({ http: true, status: 422, code: "on_payment_needs_payment" });
  });
});

describe.skipIf(!HAS_DB)("ends_on is a day in the org's timezone (DB)", () => {
  /** The org-local calendar date of `at` in `tz` (Intl, not the code under test). */
  const localDate = (at: Date, tz: string): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  it("no timezone: today is accepted and stored as the next UTC midnight; yesterday is refused", async () => {
    const o = await org("community", { timezone: null });
    const id = await sponsor(o);
    const today = localDate(new Date(), "UTC");
    const p = await pkg(o);
    const { deal } = await createDeal(o.auth, id, input(p, { ends_on: today }), ORIGIN);
    expect(deal.ends_at).toBe(new Date(`${addDays(today, 1)}T00:00:00Z`).toISOString());
    // The seam with the deal page: it reads the typed day back with `endsOnOf` over exactly what the producer wrote.
    expect(endsOnOf(deal.ends_at!, "UTC"), "the day the club typed, read back").toBe(today);
    expect(await refusal(() => createDeal(o.auth, id, input(p, { ends_on: addDays(today, -1) }), ORIGIN))).toMatchObject({ status: 422, code: "ends_on_in_past" });
  });

  it("an org at UTC+14: its local today is accepted and ends at its local midnight; its local yesterday is refused", async () => {
    const tz = "Pacific/Kiritimati"; // UTC+14 all year, no DST
    const o = await org("community", { timezone: tz });
    const id = await sponsor(o);
    const p = await pkg(o);
    const today = localDate(new Date(), tz);
    const { deal } = await createDeal(o.auth, id, input(p, { ends_on: today }), ORIGIN);
    expect(deal.ends_at, "the start of the NEXT local day").toBe(new Date(`${addDays(today, 1)}T00:00:00+14:00`).toISOString());
    expect(endsOnOf(deal.ends_at!, tz), "the day the club typed, read back in the org's zone").toBe(today);
    expect(await refusal(() => createDeal(o.auth, id, input(p, { ends_on: addDays(today, -1) }), ORIGIN))).toMatchObject({ status: 422, code: "ends_on_in_past" });
  });
});

describe.skipIf(!HAS_DB)("the stored end reads back as the typed day for every org zone (DB, the deal page's seam)", () => {
  const localDate = (at: Date, tz: string): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  it("typed today and a week on, at orgs behind and ahead of UTC (6 counted): the producer's stored instant, read with `endsOnOf` in the org's zone, is the typed day", async () => {
    let checked = 0;
    for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "Europe/London"]) {
      const o = await org("community", { timezone: tz });
      const id = await sponsor(o);
      const p = await pkg(o);
      for (const offset of [0, 7]) {
        const typed = addDays(localDate(new Date(), tz), offset);
        const { deal } = await createDeal(o.auth, id, input(p, { ends_on: typed }), ORIGIN);
        expect(endsOnOf(deal.ends_at!, tz), `${tz}: typed ${typed}`).toBe(typed);
        checked++;
      }
    }
    expect(checked).toBe(6);
  });
});

describe.skipIf(!HAS_DB)("another plan: community and Pro (DB)", () => {
  it("community: an offline partner whole-org deal is created; online is 402 sponsors.monetize; gold is 402 sponsors.tiers", async () => {
    const o = await org("community", { connect: true });
    const id = await sponsor(o);
    const partner = await pkg(o);
    const gold = await pkg(o, { tier: "gold" });
    expect((await createDeal(o.auth, id, input(partner), ORIGIN)).deal.deal_status).toBe("awaiting_payment");
    const before = await dealCount(o);
    expect(await refusal(() => createDeal(o.auth, id, input(partner, { payment_method: "online", sponsor_email: "pay@acme.test" }), ORIGIN)))
      .toMatchObject({ status: 402 });
    await expect(createDeal(o.auth, id, input(partner, { payment_method: "online", sponsor_email: "pay@acme.test" }), ORIGIN)).rejects.toMatchObject({ featureKey: "sponsors.monetize" });
    await expect(createDeal(o.auth, id, input(gold), ORIGIN)).rejects.toMatchObject({ status: 402, featureKey: "sponsors.tiers" });
    await expect(createDeal(o.auth, id, input(partner, { competition_id: o.compId }), ORIGIN), "a competition scope is tiered too").rejects.toMatchObject({ status: 402, featureKey: "sponsors.tiers" });
    expect(await dealCount(o), "no row for any refusal").toBe(before);
  });

  it("Pro: the same gold competition deal is created and puts the sponsor live at its tier and scope", async () => {
    const o = await org("pro");
    const id = await sponsor(o);
    const gold = await pkg(o, { tier: "gold" });
    const { deal } = await createDeal(o.auth, id, input(gold, { competition_id: o.compId, payment_method: "complimentary", go_live: "immediate" }), ORIGIN);
    expect(deal.deal_status).toBe("live");
    expect(await sponsorOf(id)).toMatchObject({ status: "active", tier: "gold", competition_id: o.compId });
  });
});
