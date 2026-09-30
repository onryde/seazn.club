// An Event Pass grants MATCH credits too — once, when it is bought (Streaming R1
// Task 14b fix round 1, addendum P; owner decision 2026-09-29: "event passes
// grant their stream credits ONCE, when bought: event_pass 1, event_pass_l 5.
// Those credits never expire.").
//
// The amount is V426's `streaming.credits.monthly` row for the PASS key — for a
// pass key that value is a one-off amount, not a monthly rate. Every expected
// amount below is READ from plan_entitlements, never typed here, except the one
// literal pin of the owner's two numbers, which is what witnesses a change to
// the numbers themselves.
//
// Driven through the REAL producers and consumers: the pass is bought through
// `processStripeEvent` (the checkout webhook) and `reconcilePassCheckout` (the
// buyer's return render), and revoked through `processStripeEvent` on a
// `charge.refunded` / `charge.dispute.closed` event — the paths Stripe drives.
//
// A revoked pass KEEPS its match credits (Task 14b fix round 2 ruling,
// 2026-09-29): they sit in the pack beside any bought pack, so a
// `min(grant, pack)` claw-back could take a later-bought pack's paid credits,
// and forgiving one pass's grant (at most 5) is the better trade. The pass
// itself and its AI credits still go back, unchanged.
//
// Sequences, not features: buy → replay on either path; buy → buy pack →
// refund → refund again; buy → refund → buy again; a duplicate second charge;
// a pass with no payment intent; the monthly ensure after a pass.
//
// Mutant killers (task-14b-report.md, FIX ROUND 1 addendum P, FIX ROUND 2):
//   p1 recordPassPurchase never calls the stream grant        → "buying each rung grants ITS V426 amount"
//   p2 the grant's replay check deleted                        → "a replay on either path adds nothing"
//   p3 the grant reads the wrong rung (always event_pass)      → "buying each rung grants ITS V426 amount"
//   p8 the org-mismatch report deleted                         → "a key already held by ANOTHER org grants nothing …"
//   r1 the round-1 stream claw-back restored on both arms      → "every arm that revokes a pass keeps its match credits …"
//                                                                and "a RE-purchase … grants again"
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

const stripeMock = vi.hoisted(() => {
  const retrieve = vi.fn();
  return {
    retrieve,
    stripe: {
      checkout: { sessions: { retrieve, listLineItems: vi.fn(async () => ({ data: [] })) } },
      refunds: { create: vi.fn(async () => ({ id: "re_test" })) },
      paymentMethods: { list: vi.fn(async () => ({ data: [] })) },
      // The stream-PACK refund arm's unmatched branch asks Stripe whether the
      // intent was a pack; a pass intent is not, and says so with empty metadata.
      paymentIntents: { retrieve: vi.fn(async () => ({ metadata: {} })) },
      charges: { retrieve: vi.fn(async () => ({ customer: null })) },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

// Mocked at the function so no case depends on a mail transport being set.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendPassRevokedEmail: vi.fn(async () => true),
  sendStaffDisputeAlertEmail: vi.fn(async () => true),
  sendStreamCreditClawbackAlertEmail: vi.fn(async () => true),
}));

import { sql } from "@/lib/db";
import { reconcilePassCheckout, recordPassPurchase } from "@/lib/billing";
import { PASS_KEYS, type PassKey } from "@/lib/currency";
import { processStripeEvent } from "@/server/usecases/billing-events";
import {
  creditBalance,
  creditBreakdown,
  ensureMonthlyStreamGrant,
  grantPassStreamCredits,
} from "@/server/usecases/stream-credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const FEATURE = "streaming.credits.monthly";

/** V426's rows — the ONLY source of an expected amount in this file. */
async function v426(): Promise<Map<string, number>> {
  const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
    select plan_key, int_value from plan_entitlements where feature_key = ${FEATURE}`;
  return new Map(rows.map((r) => [r.plan_key, r.int_value ?? 0]));
}
async function amountOf(key: string): Promise<number> {
  const n = (await v426()).get(key);
  if (n === undefined) throw new Error(`no ${FEATURE} row for ${key}`);
  return n;
}

/** A fresh org + competition + the community subscription every org gets at
 *  creation (billing-pass-financial-trace.test.ts's seed). */
async function seedPassBuyer(): Promise<{ orgId: string; compId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Stream Pass Org " + suffix}, ${"stream-pass-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Stream Pass Cup " + suffix}, ${"stream-pass-cup-" + suffix}) returning id`;
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  return { orgId, compId };
}

/** A paid pass checkout session. When this database has a price configured for
 *  the rung, the session carries it as its one line item, so the webhook's rung
 *  guard (passSessionRungMatchesPrice) compares a real price rather than
 *  refusing a session with none. */
async function passSession(
  orgId: string,
  compId: string,
  passKey: PassKey,
  over?: { payment_intent?: string | null; payment_status?: string },
): Promise<Stripe.Checkout.Session> {
  const [plan] = await sql<{ price_id: string | null }[]>`
    select stripe_price_id_onetime as price_id from plans where key = ${passKey}`;
  return {
    id: "cs_stream_pass_" + uniq(),
    metadata: { org_id: orgId, competition_id: compId, pass_key: passKey },
    payment_status: over?.payment_status ?? "paid",
    payment_intent: over && "payment_intent" in over ? over.payment_intent : "pi_stream_pass_" + uniq(),
    customer: "cus_stream_pass_" + uniq(),
    currency: "gbp",
    ...(plan?.price_id ? { line_items: { data: [{ price: { id: plan.price_id } }] } } : {}),
  } as unknown as Stripe.Checkout.Session;
}

const completed = (session: Stripe.Checkout.Session) =>
  ({ id: "evt_" + uniq(), type: "checkout.session.completed", data: { object: session } }) as unknown as Stripe.Event;

const refunded = (intent: string) =>
  ({
    id: "evt_" + uniq(),
    type: "charge.refunded",
    data: { object: { id: "ch_" + uniq(), refunded: true, amount_refunded: 2900, payment_intent: intent, metadata: {} } },
  }) as unknown as Stripe.Event;

const disputeClosed = (intent: string, status: Stripe.Dispute["status"]) =>
  ({
    id: "evt_" + uniq(),
    type: "charge.dispute.closed",
    data: { object: { id: "dp_" + uniq(), payment_intent: intent, status, amount: 2900, currency: "gbp" } },
  }) as unknown as Stripe.Event;

interface Row { reason: string; bucket: string; delta: number; idempotency_key: string | null }
const rows = (orgId: string) =>
  sql<Row[]>`select reason, bucket, delta, idempotency_key from org_stream_credits
              where org_id = ${orgId} order by created_at, balance_after desc`;

async function passRow(compId: string) {
  const [row] = await sql<{ stripe_payment_intent: string | null }[]>`
    select stripe_payment_intent from competition_passes where competition_id = ${compId}`;
  return row;
}

beforeEach(() => {
  stripeMock.retrieve.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("an Event Pass grants its match credits once, when bought", () => {
  it("the owner's two amounts, as V426 declares them", async () => {
    const declared = await v426();
    // The one literal in this file: the owner's numbers, verbatim. Every other
    // assertion reads V426, so this line is what notices the numbers moving.
    expect(Object.fromEntries(PASS_KEYS.map((k) => [k, declared.get(k)]))).toEqual({ event_pass: 1, event_pass_l: 5 });
  });

  it("buying each rung grants ITS V426 amount — one never-expiring PACK grant, keyed on the pass", async () => {
    let checked = 0;
    const granted = new Map<string, number>();
    for (const passKey of PASS_KEYS) {
      const amount = await amountOf(passKey);
      const { orgId, compId } = await seedPassBuyer();
      const session = await passSession(orgId, compId, passKey);
      await processStripeEvent(completed(session));

      expect((await passRow(compId))?.stripe_payment_intent, `${passKey}: premise — the pass was recorded`).toBe(session.payment_intent);
      expect(await rows(orgId), passKey).toEqual([
        { reason: "grant", bucket: "pack", delta: amount, idempotency_key: `stream-pass:${session.payment_intent}` },
      ]);
      // Pack, not monthly: it never expires, and the monthly rollover never sweeps it.
      expect(await creditBreakdown(sql, orgId), passKey).toEqual({ monthly: 0, pack: amount, total: amount });
      granted.set(passKey, amount);
      checked++;
    }
    expect(checked).toBe(PASS_KEYS.length);
    expect(checked).toBeGreaterThan(0);
    // Per-rung, not flat: a grant that always read one rung's number would pass
    // every per-org assertion above if the two amounts were equal.
    expect(new Set(granted.values()).size).toBe(PASS_KEYS.length);
  });

  it("a replay on either path adds nothing — webhook, then reconcile-on-return, then the webhook again", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const amount = await amountOf("event_pass_l");
    const session = await passSession(orgId, compId, "event_pass_l");

    await processStripeEvent(completed(session));
    expect(await creditBalance(sql, orgId)).toBe(amount);

    stripeMock.retrieve.mockResolvedValue(session);
    expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
    await processStripeEvent(completed(session));
    // And the grant itself, called a second time for the same pass: +0.
    expect(await grantPassStreamCredits({ orgId, passKey: "event_pass_l", anchor: session.payment_intent as string })).toBe(0);

    expect(await creditBalance(sql, orgId)).toBe(amount);
    expect((await rows(orgId)).filter((r) => r.reason === "grant")).toHaveLength(1);
  });

  it("the reconcile-on-return path grants on its own when the webhook never arrived", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const amount = await amountOf("event_pass");
    const session = await passSession(orgId, compId, "event_pass");
    stripeMock.retrieve.mockResolvedValue(session);

    expect(await reconcilePassCheckout(orgId, session.id)).toBe(true);
    expect(await rows(orgId)).toEqual([
      { reason: "grant", bucket: "pack", delta: amount, idempotency_key: `stream-pass:${session.payment_intent}` },
    ]);
  });

  it("a promotion-code pass with NO payment intent is keyed on its competition, and grants once", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const amount = await amountOf("event_pass");
    const session = await passSession(orgId, compId, "event_pass", { payment_intent: null, payment_status: "no_payment_required" });

    await processStripeEvent(completed(session));
    await processStripeEvent(completed(session));
    expect(await rows(orgId)).toEqual([
      { reason: "grant", bucket: "pack", delta: amount, idempotency_key: `stream-pass:${compId}` },
    ]);
  });

  it("a duplicate SECOND charge for the same competition grants nothing", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const amount = await amountOf("event_pass");
    await recordPassPurchase({ orgId, competitionId: compId, passKey: "event_pass", paymentIntent: "pi_first_" + uniq() });
    const dup = await recordPassPurchase({ orgId, competitionId: compId, passKey: "event_pass", paymentIntent: "pi_dup_" + uniq() });

    expect(dup.duplicateIntent).not.toBeNull(); // premise: this IS the duplicate arm
    expect(await creditBalance(sql, orgId)).toBe(amount);
    expect(await rows(orgId)).toHaveLength(1);
  });

  it("a key already held by ANOTHER org grants nothing to the second org, and is REPORTED — never answered as a quiet replay", async () => {
    const a = await seedPassBuyer();
    const b = await seedPassBuyer();
    const anchor = "pi_shared_" + uniq();
    expect(await grantPassStreamCredits({ orgId: a.orgId, passKey: "event_pass", anchor })).toBe(await amountOf("event_pass"));
    sentry.captureError.mockClear();

    expect(await grantPassStreamCredits({ orgId: b.orgId, passKey: "event_pass", anchor })).toBe(0);
    expect(await rows(b.orgId)).toEqual([]);
    expect(sentry.captureError.mock.calls.map(([, ctx]) => [ctx?.route, ctx?.orgId])).toEqual([
      ["relay.credits.pass_grant_org_mismatch", b.orgId],
    ]);
    // …while the SAME org's replay is the quiet no-op it should be.
    sentry.captureError.mockClear();
    expect(await grantPassStreamCredits({ orgId: a.orgId, passKey: "event_pass", anchor })).toBe(0);
    expect(sentry.captureError).not.toHaveBeenCalled();
  });
});

/** The pass's AI-credit rows (lib/credits.ts): its one-time grant, and the claw-back a revoke writes. */
const aiPassRows = (intent: string) =>
  sql<{ source: string; delta: number; idempotency_key: string | null }[]>`
    select source, delta, idempotency_key from ai_credit_ledger
     where ref = ${intent} and source in ('pass_grant', 'refund') order by created_at`;

describe.skipIf(!HAS_DB)("a refunded or lost-disputed Event Pass KEEPS its match credits", () => {
  const ARMS: { name: string; revoke: (intent: string) => Stripe.Event }[] = [
    { name: "a full refund", revoke: (intent) => refunded(intent) },
    { name: "a lost dispute", revoke: (intent) => disputeClosed(intent, "lost") },
  ];

  it("every arm that revokes a pass keeps its match credits — only the pass and its AI credits go back, unchanged; a second event writes nothing, even with a bought pack to take", async () => {
    let checked = 0;
    for (const arm of ARMS) {
      const { orgId, compId } = await seedPassBuyer();
      const amount = await amountOf("event_pass_l");
      const session = await passSession(orgId, compId, "event_pass_l");
      const intent = session.payment_intent as string;
      await processStripeEvent(completed(session));
      // A pack bought AFTER the pass: the credits a min(grant, pack) claw-back would have taken first.
      await sql`
        insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, stripe_event_id)
        values (${orgId}, 5, 'purchase', 'pack', ${amount + 5}, ${"cs_later_" + uniq()})`;
      const [aiGrant] = await aiPassRows(intent);
      expect(aiGrant, `${arm.name}: premise — the pass granted AI credits`).toMatchObject({ source: "pass_grant" });
      expect(aiGrant!.delta).toBeGreaterThan(0);

      for (let i = 0; i < 2; i++) await processStripeEvent(arm.revoke(intent));   // the second is a redelivery / later event

      expect(await passRow(compId), `${arm.name}: the pass itself is revoked`).toBeUndefined();
      expect(await aiPassRows(intent), `${arm.name}: the AI claw-back is unchanged — the whole unspent grant, once`).toEqual([
        { source: "pass_grant", delta: aiGrant!.delta, idempotency_key: aiGrant!.idempotency_key },
        { source: "refund", delta: -aiGrant!.delta, idempotency_key: `pass_refund:${intent}` },
      ]);
      expect((await rows(orgId)).map((r) => r.reason), `${arm.name}: no match-credit row after the grant and the pack`).toEqual(["grant", "purchase"]);
      expect(await creditBreakdown(sql, orgId), arm.name).toEqual({ monthly: 0, pack: amount + 5, total: amount + 5 });
      checked++;
    }
    expect(checked).toBe(ARMS.length);
  });

  it("a WON dispute takes nothing back", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const amount = await amountOf("event_pass");
    const session = await passSession(orgId, compId, "event_pass");
    await processStripeEvent(completed(session));

    await processStripeEvent(disputeClosed(session.payment_intent as string, "won"));
    expect(await passRow(compId), "premise: a won dispute keeps the pass").toBeDefined();
    expect(await creditBalance(sql, orgId)).toBe(amount);
    expect((await rows(orgId)).map((r) => r.reason)).toEqual(["grant"]);
  });

  it("a RE-purchase of the same competition after a refund grants again — the key is the payment, not the competition — and the refunded pass's credits are still there", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const amount = await amountOf("event_pass");
    const first = await passSession(orgId, compId, "event_pass");
    await processStripeEvent(completed(first));
    await processStripeEvent(refunded(first.payment_intent as string));
    expect(await passRow(compId), "premise: the refund revoked the pass").toBeUndefined();
    expect(await creditBalance(sql, orgId)).toBe(amount);

    const second = await passSession(orgId, compId, "event_pass");
    await processStripeEvent(completed(second));
    expect(await creditBalance(sql, orgId)).toBe(2 * amount);
    expect((await rows(orgId)).map((r) => r.idempotency_key)).toEqual([
      `stream-pass:${first.payment_intent}`,
      `stream-pass:${second.payment_intent}`,
    ]);
  });
});

describe.skipIf(!HAS_DB)("the monthly grant never reads a pass key", () => {
  it("a pass-only org's monthly ensure grants its SUBSCRIPTION plan's rate, not the pass's amount", async () => {
    const { orgId, compId } = await seedPassBuyer();
    const passAmount = await amountOf("event_pass_l");
    const communityRate = await amountOf("community");
    // The discriminator: were the ensure to read the pass, it would grant a
    // different number.
    expect(passAmount).not.toBe(communityRate);

    await processStripeEvent(completed(await passSession(orgId, compId, "event_pass_l")));
    expect(await ensureMonthlyStreamGrant(orgId)).toBe(communityRate);
    expect(await creditBreakdown(sql, orgId)).toEqual({ monthly: communityRate, pack: passAmount, total: communityRate + passAmount });
    // …and the pass's credits are not re-granted monthly: a second ensure this month is owed nothing.
    expect(await ensureMonthlyStreamGrant(orgId)).toBe(0);
  });
});
