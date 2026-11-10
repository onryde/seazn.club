// Sponsor deals, Task 8 (plan 2026-11-07-sponsor-deals; spec §5.2, §5.3; D7, D8; seam S1): the webhook, refunds and disputes
// move DEALS, and a deal reaches its sponsor only through `applyDealsToSponsor`. The webhook never inserts a sponsor
// (anti-goal 1: "a paid deal that creates a second sponsor row").
//
// Every case drives the REAL dispatcher, `runEvent` (billing-events.ts: the ledger claim, then the dispatch the signed webhook
// route and the staff replay share), never a handler, and reads the REAL consumers: `resolveSponsors` (the public strip) and
// `resolveSponsors(…, { onStream: true })` (the stream's card source). Only the network seams are replaced: Stripe
// (`getStripe`), the outbox transport, and Sentry (`captureError`, which carries the owner alert until Task 23's outbox kind).
//
// Where each expected value comes from (never from sponsors.ts):
//   - spec §5.2 (Online when paid: Awaiting payment → Paid → Live; after approval: → Awaiting approval → Approve → Live; Refund →
//     Ended (refunded); a dispute hides the sponsor until it is resolved) and §5.3 (Live sets status active, the deal's tier,
//     scope and on_stream; the webhook stops inserting sponsors);
//   - D8 (a live deal: active, or pending while parked; open deals only: inactive; all ended: inactive, partner, whole org, off
//     the stream, ONLY on the transition — a late event on an old deal never undoes the club's hand switch-back-on, F7);
//   - Review Focus 1 (a late payment on an ended deal is recorded, the deal stays ended, the sponsor stays hidden, Refund is
//     offered), F2 (one lock order), F3 (a second intent is a refundable row plus an owner alert), F12 (no DealRuleError escapes
//     a webhook), F18 (a legacy row's money columns only), F35 (the dispute audit names the DEAL's competition), F17 (no
//     `insert into sponsors` below the webhook banner).
// "Another sport" is not applicable (sponsors read no sport key); its substitute is another plan: a Pro org's online deal paid
// after a downgrade to community.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } },
    refunds: { create: stripe.refund },
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_seam" })) }));
const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { allowedActions } from "@/lib/sponsor-deals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { runEvent } from "../billing-events";
import { createSponsor, createSponsorPackage, patchSponsor, resolveSponsors } from "../sponsors";
import { approveDeal, createDeal, endDealNow, getDeal, type CreateDealInput } from "../sponsor-deals";
import { stubOutboxEnv } from "./_invite-mail";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const uniq = () => randomUUID().slice(0, 8);
const ORIGIN = "https://seam.test";
const made = { orgIds: [] as string[], userIds: [] as string[], eventIds: [] as string[] };

beforeEach(() => {
  stubOutboxEnv();
  stripe.create
    .mockReset()
    .mockImplementation(async () => ({ id: `cs_${uniq()}`, url: `https://checkout.stripe.test/${uniq()}`, expires_at: Math.floor(Date.now() / 1000) + 86_400 }));
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  stripe.refund.mockReset().mockImplementation(async () => ({ id: `re_${uniq()}` }));
  sentry.captureError.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from billing_events where id = any(${made.eventIds}::text[])`;
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

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures: a Pro org that sells online (Connect live), its competition C, packages, sponsors and deals made by the real usecases
// ---------------------------------------------------------------------------------------------------------------------------------

interface Org {
  orgId: string;
  slug: string;
  compId: string;
  auth: AuthCtx;
}

async function org(): Promise<Org> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`seam-${uniq()}@test.local`}, 'Deal Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const slug = `seam-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled)
    values (${`Seam ${s}`}, ${slug}, ${userId}, ${`acct_${s}`}, true) returning id`;
  made.orgIds.push(orgId);
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Seam Cup', ${`seam-cup-${s}`}) returning id`;
  return { orgId, slug, compId, auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

async function pkg(
  o: Org,
  p: { tier?: "title" | "gold" | "silver" | "partner"; competition_id?: string | null; includes_on_stream?: boolean } = {},
): Promise<string> {
  return (
    await createSponsorPackage(o.auth, {
      name: `Pkg ${uniq()}`,
      price_cents: 25_000,
      currency: "gbp",
      tier: p.tier ?? "partner",
      competition_id: p.competition_id ?? null,
      includes_on_stream: p.includes_on_stream ?? false,
    })
  ).id;
}

/** A sponsor the club added by hand, with a logo and a link (what "add a sponsor" leaves: live, partner, the whole org). */
async function sponsor(o: Org): Promise<string> {
  return (
    await createSponsor(o.auth, {
      name: `Harbourside ${uniq()}`,
      url: "https://harbourside.example/",
      logo_path: `sponsor-logos/${uniq()}.png`,
      tier: "partner",
      competition_id: null,
      status: "active",
    })
  ).id;
}

const dealInput = (packageId: string, over: Partial<CreateDealInput> = {}): CreateDealInput => ({
  package_id: packageId,
  competition_id: null,
  payment_method: "online",
  go_live: "on_payment",
  sponsor_email: `pay-${uniq()}@test.local`,
  ends_on: null,
  end_current: false,
  ...over,
});

/** An online deal with its invoice sent (one Checkout session minted): awaiting payment. */
async function onlineDeal(o: Org, sponsorId: string, packageId: string, over: Partial<CreateDealInput> = {}): Promise<string> {
  const out = await createDeal(o.auth, sponsorId, dealInput(packageId, over), ORIGIN);
  return out.deal.id;
}

async function offlineDeal(o: Org, sponsorId: string, packageId: string, over: Partial<CreateDealInput> = {}): Promise<string> {
  const out = await createDeal(o.auth, sponsorId, dealInput(packageId, { payment_method: "offline", sponsor_email: null, ...over }), ORIGIN);
  return out.deal.id;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Stripe events, as the signed webhook hands them to runEvent (a fresh event id each, removed from the ledger after the file)
// ---------------------------------------------------------------------------------------------------------------------------------

let evSeq = 0;
function ev(type: string, object: Record<string, unknown>, id = `evt_seam_${RUN}_${++evSeq}`): Stripe.Event {
  made.eventIds.push(id);
  return { id, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } } as unknown as Stripe.Event;
}
const newIntent = () => `pi_seam_${RUN}_${uniq()}`;
const newDispute = () => `dp_seam_${RUN}_${uniq()}`;
/** payment_intent.succeeded with the metadata `mintDealCheckout` stamps on the intent. */
const succeeded = (o: Org, dealId: string, intent: string, amount = 25_000) =>
  ev("payment_intent.succeeded", {
    id: intent,
    object: "payment_intent",
    amount,
    amount_received: amount,
    currency: "gbp",
    status: "succeeded",
    metadata: { kind: "sponsor", order_id: dealId, org_id: o.orgId },
  });
const failed = (o: Org, dealId: string, intent: string) =>
  ev("payment_intent.payment_failed", {
    id: intent,
    object: "payment_intent",
    amount: 25_000,
    currency: "gbp",
    status: "requires_payment_method",
    metadata: { kind: "sponsor", order_id: dealId, org_id: o.orgId },
  });
const refunded = (intent: string) =>
  ev("charge.refunded", { id: `ch_${uniq()}`, object: "charge", payment_intent: intent, refunded: true, amount: 25_000, amount_refunded: 25_000 });
const disputed = (phase: "created" | "funds_withdrawn" | "closed", disputeId: string, intent: string, status: string) =>
  ev(`charge.dispute.${phase}`, { id: disputeId, object: "dispute", payment_intent: intent, amount: 25_000, status });

/** Pay a deal through the real dispatcher; answers the intent that paid it. */
async function pay(o: Org, dealId: string, intent = newIntent()): Promise<string> {
  expect(await runEvent(succeeded(o, dealId, intent)), "premise: the dispatcher claimed and ran the payment").toBe(true);
  return intent;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------------------------------------------

type SponsorRow = {
  id: string;
  name: string;
  url: string | null;
  logo_path: string | null;
  status: string;
  tier: string;
  competition_id: string | null;
  on_stream: boolean;
  display_order: number;
};
const sponsorRow = async (id: string): Promise<SponsorRow> =>
  (await sql<SponsorRow[]>`
    select id, name, url, logo_path, status, tier, competition_id, on_stream, display_order from sponsors where id = ${id}`)[0]!;
const sponsorBytes = async (id: string): Promise<string> =>
  (await sql<{ row: string }[]>`select to_jsonb(s)::text as row from sponsors s where s.id = ${id}`)[0]!.row;
const sponsorCount = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsors where org_id = ${orgId}`)[0]!.n;

type DealRow = {
  deal_status: string;
  status: string;
  ended_reason: string | null;
  payment_intent_id: string | null;
  parked_at: Date | null;
  live_at: Date | null;
  paid_at: Date | null;
  disputed_at: Date | null;
};
const dealRow = async (id: string): Promise<DealRow> =>
  (await sql<DealRow[]>`
    select deal_status, status, ended_reason, payment_intent_id, parked_at, live_at, paid_at, disputed_at
      from sponsor_orders where id = ${id}`)[0]!;
const dealBytes = async (id: string): Promise<string> =>
  (await sql<{ row: string }[]>`select to_jsonb(d)::text as row from sponsor_orders d where d.id = ${id}`)[0]!.row;
/** The deal columns a legacy row's money path must never touch (F18). */
const dealShape = async (id: string) =>
  (await sql`
    select deal_status, ended_reason, ended_at, sponsor_id, live_at, parked_at, payment_method, go_live, tier, competition_id
      from sponsor_orders where id = ${id}`)[0]!;
const receipts = async (dealId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'sponsor_receipt' and ref_id = ${dealId}`)[0]!.n;

/** On the public strip of competition C (org-wide and C-scoped rows). */
const listed = async (o: Org, sponsorId: string, opts: { onStream?: boolean; tiered?: boolean } = {}) =>
  (await resolveSponsors(o.orgId, o.compId, opts)).some((s) => s.id === sponsorId);

/** The owner alerts raised so far (the Sentry stand-in), by reason. */
const alerts = (reason: string) =>
  sentry.captureError.mock.calls.filter((c) => (c[1] as { extra?: { reason?: string } } | undefined)?.extra?.reason === reason);

/** The backends waiting on a lock held by backend `pid`. */
const waitersOf = async (pid: number): Promise<number> =>
  (await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database() and ${pid}::int = any(pg_blocking_pids(pid))`)[0]!.n;

/** Hold a sponsor row's lock on a connection of its own until `release()`. */
async function holdSponsor(sponsorId: string): Promise<{ pid: number; release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let ready!: (pid: number) => void;
  const locked = new Promise<number>((r) => (ready = r));
  const done = sql.begin(async (tx) => {
    await tx`select 1 from sponsors where id = ${sponsorId} for update`;
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    ready(pid);
    await gate;
  });
  const pid = await locked;
  return {
    pid,
    release: async () => {
      open();
      await done;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// S1: a payment makes the deal's own sponsor live
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S1: payment_intent.succeeded → the deal's OWN sponsor goes live (DB)", () => {
  it("S1: through runEvent, the SAME sponsor id is active, gold, scoped to C and on the stream, keeps its logo and link, is on the public strip and the stream, and no sponsor row is added", async () => {
    const o = await org();
    const p = await pkg(o, { tier: "gold", competition_id: null, includes_on_stream: true });
    const sp = await sponsor(o);
    const before = await sponsorRow(sp);
    const dealId = await onlineDeal(o, sp, p, { competition_id: o.compId });
    expect(await listed(o, sp), "premise: a deal waiting for its money hides its sponsor (D8)").toBe(false);
    const count = await sponsorCount(o.orgId);

    const intent = await pay(o, dealId);

    expect(await sponsorCount(o.orgId), "anti-goal 1: the payment adds no sponsor row").toBe(count);
    // §5.3: status active, tier and scope from the deal's snapshot, on_stream when the package includes it; nothing else moves.
    expect(await sponsorRow(sp)).toEqual({ ...before, status: "active", tier: "gold", competition_id: o.compId, on_stream: true });
    expect(await listed(o, sp), "the public strip lists it").toBe(true);
    expect(await listed(o, sp, { onStream: true }), "the stream's card source lists it").toBe(true);
    expect(await dealRow(dealId)).toMatchObject({ deal_status: "live", status: "paid", payment_intent_id: intent, ended_reason: null });
    expect((await dealRow(dealId)).live_at, "live_at is stamped").not.toBeNull();
    // R12: an on-stream deal turns the org's rotation on, as the first tick does.
    const [settings] = await sql<{ enabled: boolean }[]>`
      select enabled from sponsor_stream_settings where org_id = ${o.orgId} and competition_id is null`;
    expect(settings?.enabled).toBe(true);
    expect(await receipts(dealId), "one receipt for the payment").toBe(1);
    expect(sentry.captureError, "a payment that lands where it should alerts nobody").not.toHaveBeenCalled();
  });

  it("second call: the same event is claimed once; a redelivery under a new event id changes nothing and queues no second receipt", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const dealId = await onlineDeal(o, sp, await pkg(o, { tier: "silver" }));
    const intent = newIntent();
    const event = succeeded(o, dealId, intent);
    expect(await runEvent(event)).toBe(true);
    const deal = await dealBytes(dealId);
    const sponsorAfter = await sponsorBytes(sp);

    expect(await runEvent(event), "the ledger claims an event once").toBe(false);
    expect(await runEvent(succeeded(o, dealId, intent)), "a redelivery under a new event id runs the handler").toBe(true);

    expect(await dealBytes(dealId), "the deal is unchanged").toBe(deal);
    expect(await sponsorBytes(sp), "the sponsor is unchanged").toBe(sponsorAfter);
    expect(await receipts(dealId), "one receipt").toBe(1);
    expect(sentry.captureError, "a redelivery of the SAME intent is no duplicate payment").not.toHaveBeenCalled();
  });

  it("another plan: a Pro org's gold deal paid after the org went down to community goes live (the money was taken); the free strip shows it un-tiered", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const dealId = await onlineDeal(o, sp, await pkg(o, { tier: "gold" }));
    await setOrgPlan(o.orgId, "community");
    await invalidateOrgEntitlements(o.orgId);

    await pay(o, dealId);

    expect(await sponsorRow(sp)).toMatchObject({ status: "active", tier: "gold" });
    const strip = await resolveSponsors(o.orgId, o.compId, { tiered: false });
    expect(strip.find((s) => s.id === sp)?.tier, "community's strip collapses every tier to partner").toBe("partner");
  });

  it("a success on a NEW intent after a failed one records the intent that took the money, so its refund finds the deal", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const dealId = await onlineDeal(o, sp, await pkg(o));
    const declined = newIntent();
    expect(await runEvent(failed(o, dealId, declined))).toBe(true);
    expect(await dealRow(dealId), "payment failed: pending → failed, the deal status unchanged").toMatchObject({
      status: "failed",
      deal_status: "awaiting_payment",
      payment_intent_id: declined,
    });

    // The session expired; Resend invoice minted a new one, and the sponsor paid on its intent.
    const paidOn = await pay(o, dealId);
    expect(await dealRow(dealId)).toMatchObject({ status: "paid", deal_status: "live", payment_intent_id: paidOn });

    expect(await runEvent(refunded(paidOn))).toBe(true);
    expect(await dealRow(dealId), "the refund of the charge that paid it ends the deal").toMatchObject({
      status: "refunded",
      deal_status: "ended",
      ended_reason: "refunded",
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The go-live rule decides, never the payment alone
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the go-live rule decides what a payment does (DB)", () => {
  it("anti-goal 2: an After-I-approve deal paid online stays hidden; Approve puts it on the strip", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const dealId = await onlineDeal(o, sp, await pkg(o), { go_live: "on_approval" });

    await pay(o, dealId);

    expect(await dealRow(dealId)).toMatchObject({ deal_status: "awaiting_approval", status: "paid" });
    expect(await listed(o, sp), "paid is not approved").toBe(false);
    await approveDeal(o.auth, dealId);
    expect(await listed(o, sp), "approved: live").toBe(true);
  });

  it("late payment (Review Focus 1): End now, then the payment lands — recorded, the deal stays ended, the sponsor stays hidden, Refund is offered, the owner is alerted", async () => {
    const warn = vi.spyOn(log, "warn");
    try {
      const o = await org();
      const sp = await sponsor(o);
      const dealId = await onlineDeal(o, sp, await pkg(o));
      // The sponsor has paid at Stripe; the webhook has not landed yet. End now ends the deal anyway.
      stripe.retrieve.mockImplementation(async (id: string) => ({ id, status: "complete" }));
      await endDealNow(o.auth, dealId);
      const hidden = await sponsorBytes(sp);
      expect(await listed(o, sp), "premise: ended, the sponsor is hidden").toBe(false);

      const intent = await pay(o, dealId);

      expect(await dealRow(dealId)).toMatchObject({ deal_status: "ended", ended_reason: "ended_now", status: "paid", payment_intent_id: intent });
      expect(await sponsorBytes(sp), "the sponsor is not touched").toBe(hidden);
      expect(await listed(o, sp)).toBe(false);
      expect(allowedActions(await getDeal(o.auth, dealId)), "the club can refund it").toContain("refund");
      expect(warn.mock.calls.filter(([obj, msg]) => (obj as { dealId?: string }).dealId === dealId && msg === "sponsors: payment on an ended deal")).toHaveLength(1);
      expect(alerts("deal_ended"), "the owner is alerted").toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("F12: a payment on a deal its rule cannot move (a draft: the invoice never went out) is recorded, the deal stays a draft, and nothing escapes the webhook", async () => {
    const err = vi.spyOn(log, "error");
    try {
      const o = await org();
      const sp = await sponsor(o);
      stripe.create.mockRejectedValueOnce(new Error("stripe down"));
      await expect(createDeal(o.auth, sp, dealInput(await pkg(o)), ORIGIN)).rejects.toMatchObject({ status: 502 });
      const [draft] = await sql<{ id: string }[]>`select id from sponsor_orders where sponsor_id = ${sp}`;
      expect((await dealRow(draft!.id)).deal_status, "premise: the deal is a draft").toBe("draft");
      const sponsorBefore = await sponsorBytes(sp);

      const intent = newIntent();
      await expect(runEvent(succeeded(o, draft!.id, intent)), "the webhook answers: no throw, so Stripe does not retry forever").resolves.toBe(true);

      expect(await dealRow(draft!.id)).toMatchObject({ deal_status: "draft", status: "paid", payment_intent_id: intent });
      expect(await sponsorBytes(sp), "nothing applied").toBe(sponsorBefore);
      expect(allowedActions(await getDeal(o.auth, draft!.id))).toContain("refund");
      expect(err.mock.calls.some(([obj]) => (obj as { dealId?: string }).dealId === draft!.id), "logged with the deal id").toBe(true);
      expect(alerts("deal_not_payable")).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });

  it("T8 review m1: a payment on a deal that is not there (deleted after its session completed) is never quiet — logged as an error and the owner alerted once, no row and no sponsor made; a redelivery adds no alert", async () => {
    const err = vi.spyOn(log, "error");
    try {
      const o = await org();
      const count = await sponsorCount(o.orgId);
      const gone = randomUUID();
      expect(await sql`select 1 from sponsor_orders where id = ${gone}`, "premise: no such deal").toHaveLength(0);
      const intent = newIntent();
      const event = succeeded(o, gone, intent);

      await expect(runEvent(event), "answered, never a throw").resolves.toBe(true);

      expect(alerts("deal_missing"), "the owner is alerted").toHaveLength(1);
      expect(alerts("deal_missing")[0]![1]).toMatchObject({ orgId: o.orgId, extra: { dealId: gone, intentId: intent, recordedOn: null } });
      expect(
        err.mock.calls.filter(([obj, msg]) => (obj as { dealId?: string }).dealId === gone && msg === "sponsors: payment on a deal that is not there"),
        "logged as an error, not a warning",
      ).toHaveLength(1);
      expect(await sql`select 1 from sponsor_orders where payment_intent_id = ${intent}`, "recorded nowhere").toHaveLength(0);
      expect(await sponsorCount(o.orgId), "and no sponsor made (anti-goal 1)").toBe(count);

      await expect(runEvent(event), "a redelivery of the same event").resolves.toBe(false);
      expect(alerts("deal_missing"), "no second alert").toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F3: a second, different payment on a paid deal
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("F3: a second payment on a paid deal is a refundable row and an owner alert (DB)", () => {
  it("records its own ended, paid row (duplicate_payment) the club can refund, alerts the owner once, leaves the deal and its sponsor as they were; a replay adds nothing", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const p = await pkg(o, { tier: "gold", competition_id: o.compId });
    const dealId = await onlineDeal(o, sp, p, { competition_id: o.compId });
    await pay(o, dealId);
    const deal = await dealBytes(dealId);
    const live = await sponsorBytes(sp);
    const second = newIntent();

    expect(await runEvent(succeeded(o, dealId, second, 12_345))).toBe(true);

    expect(await dealBytes(dealId), "the paid deal is unchanged").toBe(deal);
    expect(await sponsorBytes(sp), "and so is its sponsor").toBe(live);
    const rows = await sql`
      select id, sponsor_id, package_id, deal_status, ended_reason, status, payment_method, payment_intent_id, amount_cents, currency,
             tier, competition_id, ended_at, paid_at
        from sponsor_orders where payment_intent_id = ${second}`;
    expect(rows, "one row carries the second payment").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sponsor_id: sp,
      package_id: p,
      deal_status: "ended",
      ended_reason: "duplicate_payment",
      status: "paid",
      payment_method: "online",
      amount_cents: 12_345,
      currency: "gbp",
      tier: "gold",
      competition_id: o.compId,
    });
    expect(rows[0]!.ended_at).not.toBeNull();
    expect(rows[0]!.paid_at).not.toBeNull();
    expect(allowedActions(await getDeal(o.auth, rows[0]!.id as string)), "the club can refund it").toContain("refund");
    expect(alerts("duplicate_payment"), "one owner alert").toHaveLength(1);

    expect(await runEvent(succeeded(o, dealId, second, 12_345)), "a redelivery of the second payment").toBe(true);
    expect(await sql`select 1 from sponsor_orders where payment_intent_id = ${second}`, "still one row").toHaveLength(1);
    expect(alerts("duplicate_payment"), "still one alert").toHaveLength(1);

    // The club refunds it: that money goes back; the deal it duplicated stays live.
    expect(await runEvent(refunded(second))).toBe(true);
    expect((await dealRow(rows[0]!.id as string)).status).toBe("refunded");
    expect(await dealBytes(dealId)).toBe(deal);
    expect(await sponsorBytes(sp)).toBe(live);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Refunds and disputes end or park the deal, and the deal applies to its sponsor
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("refunds and disputes move deals, never sponsors (DB)", () => {
  it("refund: charge.refunded on live A, with B scheduled behind it → A ended (refunded), B live, the sponsor takes B's snapshot", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const a = await onlineDeal(o, sp, await pkg(o, { tier: "gold" }));
    const intent = await pay(o, a);
    const b = await offlineDeal(o, sp, await pkg(o, { tier: "silver" }), { go_live: "immediate" });
    expect((await dealRow(b)).deal_status, "premise: B queues behind live A").toBe("scheduled");

    expect(await runEvent(refunded(intent))).toBe(true);

    expect(await dealRow(a)).toMatchObject({ deal_status: "ended", ended_reason: "refunded", status: "refunded" });
    expect((await dealRow(b)).deal_status, "Review Focus 5: B goes live when A ends by any exit").toBe("live");
    expect(await sponsorRow(sp)).toMatchObject({ status: "active", tier: "silver" });
    expect(await listed(o, sp)).toBe(true);
  });

  it("refund of the only deal: the sponsor is reset (inactive, partner, whole org, off the stream) — never left live", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const a = await onlineDeal(o, sp, await pkg(o, { tier: "gold", competition_id: o.compId, includes_on_stream: true }), { competition_id: o.compId });
    const intent = await pay(o, a);

    expect(await runEvent(refunded(intent))).toBe(true);

    expect(await sponsorRow(sp)).toMatchObject({ status: "inactive", tier: "partner", competition_id: null, on_stream: false });
    expect(await listed(o, sp)).toBe(false);
  });

  it("old-deal dispute: a dispute created on an ENDED old deal leaves the sponsor live on its newer deal (D8 reads only the live deal)", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const old = await onlineDeal(o, sp, await pkg(o, { tier: "gold" }));
    const intent = await pay(o, old);
    await offlineDeal(o, sp, await pkg(o, { tier: "silver" }), { go_live: "immediate", end_current: true });
    expect((await dealRow(old)).deal_status, "premise: the old deal ended").toBe("ended");
    const live = await sponsorBytes(sp);

    expect(await runEvent(disputed("created", newDispute(), intent, "needs_response"))).toBe(true);

    expect((await dealRow(old)).disputed_at, "the old deal carries the dispute").not.toBeNull();
    expect(await sponsorBytes(sp), "the sponsor stays live on its newer deal").toBe(live);
    expect(await listed(o, sp)).toBe(true);
  });

  it("park: a formal dispute hides the sponsor (pending) and a win brings it back; an inquiry leaves it live until the money is taken (funds_withdrawn)", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const dealId = await onlineDeal(o, sp, await pkg(o));
    const intent = await pay(o, dealId);
    const formal = newDispute();

    expect(await runEvent(disputed("created", formal, intent, "needs_response"))).toBe(true);
    expect(await dealRow(dealId)).toMatchObject({ deal_status: "live", status: "paid" });
    expect((await dealRow(dealId)).parked_at, "the deal is parked").not.toBeNull();
    expect((await sponsorRow(sp)).status).toBe("pending");
    expect(await listed(o, sp)).toBe(false);

    expect(await runEvent(disputed("closed", formal, intent, "won"))).toBe(true);
    expect((await dealRow(dealId)).parked_at, "a win unparks it").toBeNull();
    expect((await sponsorRow(sp)).status).toBe("active");
    expect(await listed(o, sp)).toBe(true);

    const sp2 = await sponsor(o);
    const deal2 = await onlineDeal(o, sp2, await pkg(o));
    const intent2 = await pay(o, deal2);
    const inquiry = newDispute();
    expect(await runEvent(disputed("created", inquiry, intent2, "warning_needs_response"))).toBe(true);
    expect((await dealRow(deal2)).parked_at, "an inquiry takes no money: not parked").toBeNull();
    expect((await sponsorRow(sp2)).status).toBe("active");
    expect(await listed(o, sp2)).toBe(true);
    expect(await runEvent(disputed("funds_withdrawn", inquiry, intent2, "needs_response"))).toBe(true);
    expect((await dealRow(deal2)).parked_at, "the money taken parks it").not.toBeNull();
    expect((await sponsorRow(sp2)).status).toBe("pending");
  });

  it("lost: the deal ends (dispute_lost), its money is written off, and the sponsor goes down (reset: it was the only deal)", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const dealId = await onlineDeal(o, sp, await pkg(o, { tier: "gold" }));
    const intent = await pay(o, dealId);
    const d = newDispute();
    await runEvent(disputed("created", d, intent, "needs_response"));

    expect(await runEvent(disputed("closed", d, intent, "lost"))).toBe(true);

    expect(await dealRow(dealId)).toMatchObject({ deal_status: "ended", ended_reason: "dispute_lost", status: "refunded" });
    expect(await sponsorRow(sp)).toMatchObject({ status: "inactive", tier: "partner", competition_id: null, on_stream: false });
    expect(await listed(o, sp)).toBe(false);
  });

  it("F7: once every deal has ended and the club switched the sponsor back on by hand, a late event on the old deal leaves the sponsor byte-equal (4 late events)", async () => {
    const o = await org();
    const lateEvents: [string, (intent: string) => Stripe.Event[]][] = [
      ["dispute created", (i) => [disputed("created", newDispute(), i, "needs_response")]],
      ["dispute closed lost", (i) => { const d = newDispute(); return [disputed("created", d, i, "needs_response"), disputed("closed", d, i, "lost")]; }],
      ["dispute closed won", (i) => { const d = newDispute(); return [disputed("created", d, i, "needs_response"), disputed("closed", d, i, "won")]; }],
      ["charge refunded", (i) => [refunded(i)]],
    ];
    let checked = 0;
    for (const [what, events] of lateEvents) {
      const sp = await sponsor(o);
      const dealId = await onlineDeal(o, sp, await pkg(o, { tier: "gold" }));
      const intent = await pay(o, dealId);
      await endDealNow(o.auth, dealId);
      expect((await sponsorRow(sp)).status, `${what}: premise: every deal ended, the sponsor is down`).toBe("inactive");
      await patchSponsor(o.auth, sp, { status: "active" });
      const switchedOn = await sponsorBytes(sp);

      for (const e of events(intent)) expect(await runEvent(e), `${what}: dispatched`).toBe(true);

      expect(await sponsorBytes(sp), `${what}: the hand switch-back-on survives`).toBe(switchedOn);
      checked++;
    }
    expect(checked, "anti-vacuity: every late event was checked").toBe(4);
  });

  it("F35: the dispute audit names the DEAL's competition: a deal scoped to C on an any-competition package audits on C", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const dealId = await onlineDeal(o, sp, await pkg(o, { competition_id: null }), { competition_id: o.compId });
    const intent = await pay(o, dealId);
    const d = newDispute();
    await runEvent(disputed("created", d, intent, "needs_response"));

    // No charge on the dispute: the recovery is skipped, and its breadcrumb is audited on the order's competition.
    expect(await runEvent(disputed("closed", d, intent, "lost"))).toBe(true);

    const audits = await sql<{ competition_id: string }[]>`
      select competition_id from competition_events
       where type = 'sponsor.dispute_recovery_skipped' and payload->>'order_id' = ${dealId}`;
    expect(audits.map((a) => a.competition_id)).toEqual([o.compId]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F18: a legacy row's money moves; nothing else does
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("F18: a legacy order's refund and dispute flip its money columns only (DB)", () => {
  it("a legacy row with no sponsor: refunded, then disputed and lost — its deal columns byte-equal, every event answered; a legacy-activated sponsor is not taken down", async () => {
    const o = await org();
    const p = await pkg(o);
    const legacyRow = async (sponsorId: string | null, intent: string): Promise<string> => {
      const [row] = await sql<{ id: string }[]>`
        insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                    payment_intent_id, paid_at, deal_status, ended_reason, ended_at, payment_method, go_live,
                                    tier, includes_on_stream, package_name, competition_id)
        values (${o.orgId}, ${p}, ${sponsorId}, 'Old Co', 'old@test.local', 25000, 'gbp', 'paid',
                ${intent}, now() - interval '30 days', 'ended', 'legacy', now() - interval '30 days', 'online', 'on_payment',
                'partner', false, 'Old package', ${null})
        returning id`;
      return row!.id;
    };
    const orphan = newIntent();
    const orphanId = await legacyRow(null, orphan);
    const shape = await dealShape(orphanId);

    expect(await runEvent(refunded(orphan)), "refund answered").toBe(true);
    expect((await dealRow(orphanId)).status).toBe("refunded");
    expect(await dealShape(orphanId), "refund: deal columns unchanged").toEqual(shape);

    const d = newDispute();
    expect(await runEvent(disputed("created", d, orphan, "needs_response")), "created answered").toBe(true);
    expect((await dealRow(orphanId)).disputed_at).not.toBeNull();
    expect(await runEvent(disputed("closed", d, orphan, "lost")), "lost answered").toBe(true);
    expect((await dealRow(orphanId)).status).toBe("refunded");
    expect(await dealShape(orphanId), "dispute: deal columns unchanged").toEqual(shape);

    // A legacy order whose sponsor the old webhook made: that sponsor is no longer taken down by its legacy refund.
    const [{ id: legacySponsor }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, name, tier, status) values (${o.orgId}, 'Old Co', 'gold', 'active') returning id`;
    const kept = newIntent();
    const keptId = await legacyRow(legacySponsor, kept);
    const before = await sponsorBytes(legacySponsor);
    const keptShape = await dealShape(keptId);
    expect(await runEvent(refunded(kept))).toBe(true);
    expect((await dealRow(keptId)).status).toBe("refunded");
    expect(await dealShape(keptId)).toEqual(keptShape);
    expect(await sponsorBytes(legacySponsor), "the legacy-activated sponsor is untouched").toBe(before);
  });

  it("a legacy row WITH a sponsor: a formal dispute never parks it and its loss never ends it — deal columns and the sponsor byte-equal", async () => {
    const o = await org();
    const p = await pkg(o);
    const [{ id: legacySponsor }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, name, tier, status) values (${o.orgId}, 'Old Co', 'gold', 'active') returning id`;
    const intent = newIntent();
    const [{ id: legacyId }] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  payment_intent_id, paid_at, deal_status, ended_reason, ended_at, payment_method, go_live,
                                  tier, includes_on_stream, package_name)
      values (${o.orgId}, ${p}, ${legacySponsor}, 'Old Co', 'old@test.local', 25000, 'gbp', 'paid',
              ${intent}, now() - interval '30 days', 'ended', 'legacy', now() - interval '30 days', 'online', 'on_payment',
              'gold', false, 'Old package')
      returning id`;
    const shape = await dealShape(legacyId!);
    const before = await sponsorBytes(legacySponsor!);
    const d = newDispute();

    expect(await runEvent(disputed("created", d, intent, "needs_response")), "created answered").toBe(true);
    expect((await dealRow(legacyId!)).disputed_at, "the dispute is recorded").not.toBeNull();
    expect(await dealShape(legacyId!), "created: not parked (F18)").toEqual(shape);
    expect(await sponsorBytes(legacySponsor!)).toBe(before);

    expect(await runEvent(disputed("closed", d, intent, "lost")), "lost answered").toBe(true);
    expect((await dealRow(legacyId!)).status, "its money is written off").toBe("refunded");
    expect(await dealShape(legacyId!), "lost: still a legacy row, never dispute_lost (F18)").toEqual(shape);
    expect(await sponsorBytes(legacySponsor!), "the sponsor is not taken down").toBe(before);
  });

  it("payments on legacy rows: a pre-deals order still unpaid is paid (money only, ended stays, the owner alerted); a second payment on a sponsor-less one cannot carry a row and alerts — every event answered", async () => {
    const o = await org();
    const p = await pkg(o);
    const count = await sponsorCount(o.orgId);
    // A pre-deals checkout still open when V495 ran: the legacy rewrite kept its money pending, and it has no sponsor (the old
    // webhook made one on payment).
    const [{ id: unpaid }] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, ended_reason, ended_at, payment_method, go_live, tier, includes_on_stream, package_name)
      values (${o.orgId}, ${p}, ${null}, 'Old Co', 'old@test.local', 25000, 'gbp', 'pending',
              'ended', 'legacy', now() - interval '1 day', 'online', 'on_payment', 'partner', false, 'Old package')
      returning id`;
    const shape = await dealShape(unpaid!);

    const intent = newIntent();
    await expect(runEvent(succeeded(o, unpaid!, intent)), "answered, never a throw").resolves.toBe(true);
    expect(await dealRow(unpaid!)).toMatchObject({ status: "paid", payment_intent_id: intent });
    expect(await dealShape(unpaid!), "its deal columns unchanged (F18)").toEqual(shape);
    expect(await sponsorCount(o.orgId), "and no sponsor made (anti-goal 1)").toBe(count);
    expect(alerts("deal_ended"), "the owner is alerted").toHaveLength(1);

    // A second, different payment on it: a sponsor-less row cannot carry a duplicate_payment row (sponsor_or_legacy), so the
    // alert alone carries the money.
    const second = newIntent();
    await expect(runEvent(succeeded(o, unpaid!, second, 9_900)), "answered, never a throw").resolves.toBe(true);
    expect(await sql`select 1 from sponsor_orders where payment_intent_id = ${second}`, "no row").toHaveLength(0);
    expect(alerts("duplicate_payment"), "the owner is alerted").toHaveLength(1);
    expect((alerts("duplicate_payment")[0]![1] as { extra: { recordedOn: unknown } }).extra.recordedOn, "recorded nowhere").toBeNull();
    expect(await dealShape(unpaid!)).toEqual(shape);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F2: one lock order — the sponsor, then its deals
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("F2: a webhook locks the sponsor before any deal (DB)", () => {
  it("two deals, one sponsor, at once: End now on A and a payment on B through runEvent both succeed, in some order, with no deadlock (3 rounds)", async () => {
    const o = await org();
    const p = await pkg(o, { tier: "silver" });
    let rounds = 0;
    for (let i = 0; i < 3; i++) {
      const sp = await sponsor(o);
      const a = await offlineDeal(o, sp, await pkg(o), { go_live: "immediate" });
      const b = await onlineDeal(o, sp, p);
      expect((await dealRow(a)).deal_status, "premise: A is live").toBe("live");

      const [ended, paid] = await Promise.allSettled([endDealNow(o.auth, a), runEvent(succeeded(o, b, newIntent()))]);

      expect(ended.status, `round ${i}: End now ${ended.status === "rejected" ? String((ended as PromiseRejectedResult).reason) : ""}`).toBe("fulfilled");
      expect(paid.status, `round ${i}: payment ${paid.status === "rejected" ? String((paid as PromiseRejectedResult).reason) : ""}`).toBe("fulfilled");
      expect((await dealRow(a)).deal_status).toBe("ended");
      expect(await dealRow(b)).toMatchObject({ deal_status: "live", status: "paid" });
      expect(await sponsorRow(sp)).toMatchObject({ status: "active", tier: "silver" });
      rounds++;
    }
    expect(rounds).toBe(3);
  });

  it("a sponsor PATCH racing a refund, and one racing a dispute, both succeed in some order", async () => {
    const o = await org();
    const sp = await sponsor(o);
    const intent = await pay(o, await onlineDeal(o, sp, await pkg(o)));
    const [patched, refund] = await Promise.allSettled([patchSponsor(o.auth, sp, { name: "Harbourside Renamed" }), runEvent(refunded(intent))]);
    expect([patched.status, refund.status]).toEqual(["fulfilled", "fulfilled"]);
    expect(await sponsorRow(sp)).toMatchObject({ name: "Harbourside Renamed", status: "inactive" });

    const sp2 = await sponsor(o);
    const intent2 = await pay(o, await onlineDeal(o, sp2, await pkg(o)));
    const [patched2, dispute] = await Promise.allSettled([
      patchSponsor(o.auth, sp2, { url: "https://renamed.example/" }),
      runEvent(disputed("created", newDispute(), intent2, "needs_response")),
    ]);
    expect([patched2.status, dispute.status]).toEqual(["fulfilled", "fulfilled"]);
    expect(await sponsorRow(sp2)).toMatchObject({ url: "https://renamed.example/", status: "pending" });
  });

  it("lock witness: while the sponsor is held, a waiting payment, refund and every dispute phase (created, funds_withdrawn, closed won and lost) each hold NO lock on their deal (6 events)", async () => {
    const o = await org();
    const cases: [string, () => Promise<{ sponsorId: string; dealId: string; event: Stripe.Event }>][] = [
      ["payment_intent.succeeded", async () => {
        const sponsorId = await sponsor(o);
        const dealId = await onlineDeal(o, sponsorId, await pkg(o));
        return { sponsorId, dealId, event: succeeded(o, dealId, newIntent()) };
      }],
      ["charge.refunded", async () => {
        const sponsorId = await sponsor(o);
        const dealId = await onlineDeal(o, sponsorId, await pkg(o));
        const intent = await pay(o, dealId);
        return { sponsorId, dealId, event: refunded(intent) };
      }],
      ["charge.dispute.created", async () => {
        const sponsorId = await sponsor(o);
        const dealId = await onlineDeal(o, sponsorId, await pkg(o));
        const intent = await pay(o, dealId);
        return { sponsorId, dealId, event: disputed("created", newDispute(), intent, "needs_response") };
      }],
      // T8 review m5: the three later dispute phases, each from the state it moves (an inquiry for funds_withdrawn, a formal
      // dispute for both closes). `lost` writes its money off and ends the deal in one transaction, so it locks too.
      ["charge.dispute.funds_withdrawn", async () => {
        const sponsorId = await sponsor(o);
        const dealId = await onlineDeal(o, sponsorId, await pkg(o));
        const intent = await pay(o, dealId);
        const dispute = newDispute();
        expect(await runEvent(disputed("created", dispute, intent, "warning_needs_response")), "premise: the inquiry ran").toBe(true);
        return { sponsorId, dealId, event: disputed("funds_withdrawn", dispute, intent, "needs_response") };
      }],
      ["charge.dispute.closed (won)", async () => {
        const sponsorId = await sponsor(o);
        const dealId = await onlineDeal(o, sponsorId, await pkg(o));
        const intent = await pay(o, dealId);
        const dispute = newDispute();
        expect(await runEvent(disputed("created", dispute, intent, "needs_response")), "premise: the dispute ran").toBe(true);
        expect((await dealRow(dealId)).parked_at, "premise: the deal is parked").not.toBeNull();
        return { sponsorId, dealId, event: disputed("closed", dispute, intent, "won") };
      }],
      ["charge.dispute.closed (lost)", async () => {
        const sponsorId = await sponsor(o);
        const dealId = await onlineDeal(o, sponsorId, await pkg(o));
        const intent = await pay(o, dealId);
        const dispute = newDispute();
        expect(await runEvent(disputed("created", dispute, intent, "needs_response")), "premise: the dispute ran").toBe(true);
        return { sponsorId, dealId, event: disputed("closed", dispute, intent, "lost") };
      }],
    ];
    let checked = 0;
    for (const [what, make] of cases) {
      const { sponsorId, dealId, event } = await make();
      const held = await holdSponsor(sponsorId);
      let running: Promise<unknown> | null = null;
      try {
        running = runEvent(event);
        await vi.waitFor(
          async () => {
            if ((await waitersOf(held.pid)) < 1) throw new Error(`${what}: the handler is not waiting on the sponsor yet`);
          },
          { timeout: 10_000, interval: 25 },
        );
        // The handler waits on the sponsor. Its deal must be free: a handler that locked the deal first would deadlock against
        // any deal writer that holds the sponsor and then locks the sponsor's deals (End now, apply).
        const probe = await sql
          .begin((tx) => tx`select 1 from sponsor_orders where id = ${dealId} for update nowait`)
          .then(() => "free", (err: { code?: string }) => err.code ?? "error");
        expect(probe, `${what}: the deal is not locked while the handler waits on its sponsor`).toBe("free");
      } finally {
        await held.release();
        await running?.catch(() => undefined);
      }
      await expect(running, `${what}: the handler then completes`).resolves.toBe(true);
      checked++;
    }
    expect(checked).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F17: the source guard
// ---------------------------------------------------------------------------------------------------------------------------------

describe("F17: no `insert into sponsors` below the Webhook activation banner (source)", () => {
  it("the banner splits sponsors.ts once; createSponsor's insert sits above it and nothing below inserts a sponsor", () => {
    const src = readFileSync(fileURLToPath(new URL("../sponsors.ts", import.meta.url)), "utf8");
    const parts = src.split("// Webhook activation");
    expect(parts, "the banner is there, once").toHaveLength(2);
    const [above, below] = parts as [string, string];
    const INSERT = /insert\s+into\s+sponsors\b/i;
    expect(above, "positive pair: createSponsor's insert is above the banner").toMatch(INSERT);
    expect(below, "the webhook, refund and dispute paths never insert a sponsor").not.toMatch(INSERT);
  });
});
