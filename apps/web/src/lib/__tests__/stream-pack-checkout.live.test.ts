// LIVE sandbox test for MATCH-credit (stream) pack purchases and refunds — NOT a unit test.
//
// The unit suites around a pack mock Stripe or hand-build its objects — the webhook and claw-back suites
// (server/usecases/__tests__/stream-credits-webhook.test.ts, stream-credits-clawback.test.ts) fold fabricated sessions
// and charges — and the sandbox coverage there is, the walkthrough's B4 (e2e/walkthrough/stream-credits.spec.ts), runs
// on a push to main, never on a PR. This file asks the real test-mode Stripe account, on every PR, three things:
//
//   1. SYNC. `pnpm stripe:sync` (run by the CI step just before this file) left exactly one ACTIVE price per declared
//      pack, all on the one match-credits product, charging exactly `streamPackPriceAmounts` — the declared table —
//      in the base currency and every currency option. Counted: zero packs checked is a failure.
//   2. PURCHASE. `createRelayCheckout` — the use-case `/api/billing/relay-checkout` calls, not a hand-built
//      `checkout.sessions.create` — opens a payment-mode session on that synced price in EVERY currency the pack
//      declares (sessions only, nothing charged), each charging the declared amount for that currency, and Stripe holds
//      the metadata the fulfilment path reads (billing-events.ts dispatch + stream-credits-checkout.ts): `kind`,
//      `org_id`, `pack`, and the `credits` snapshot the grant is taken from. A real, still-open session handed to the
//      real fulfilment gate grants nothing. One pack (the 5-pack) is swept across currencies: the per-pack amounts are
//      already pinned in every currency by (1), so more packs here would re-ask the same checkout the same question.
//   3. REFUND. A REAL paid charge for a pack, REALLY refunded, and the REAL `charge.refunded` event Stripe recorded for
//      it, delivered to the app's own signed webhook route (`api/webhooks/stripe/route.ts` → runEvent →
//      handleStreamPackChargeRefunded → recordStreamPackRefund). The pack's credits are clawed back exactly ONCE: a
//      Stripe redelivery of the same event is stopped by runEvent's claim (its `processed_at` is left untouched), and a
//      re-claimed lease (a crash after the handler wrote but before `processed_at` was stamped — runEvent re-claims such
//      an event after ten minutes) changes nothing, even once the org holds a NEWER pack the claw-back could otherwise
//      reach into.
//
// HOW THE PURCHASE IN (3) IS MADE, EXACTLY. Stripe cannot complete a Checkout Session through the API: its
// `payment_intent` stays null until a browser pays on the hosted page (asserted in (2)), and nothing in this repo drives
// that. So each purchase is: a REAL session from `createRelayCheckout`, retrieved from Stripe with its line items; a REAL
// PaymentIntent for the session's own `amount_total`, confirmed with `pm_card_visa`; and the retrieved session with
// exactly three fields overlaid — `status: "complete"`, `payment_status: "paid"`, `payment_intent: <that real intent>` —
// its metadata and line items unchanged. That object goes through the REAL `fulfilStreamCreditsCheckout`, so the
// production link builder writes the purchase row. The intent is real but was not minted BY the session; that overlay is
// the one thing here that Stripe did not do. B4 overlays the same three fields but signs the completion with a
// fabricated `pi_e2e_*` intent, which no refund can reach.
//
// The probe PaymentIntents carry NO `kind: "stream_credits"` metadata, deliberately. The matched path never reads it;
// only the UNMATCHED path does, where it pages staff ("refunded but never granted"). Any other consumer of this shared
// sandbox's events — a deployed webhook destination, if one is ever attached — holds no purchase row for these intents,
// and would page on every run.
//
// Skipped when BILLING_LIVE is unset. Under BILLING_LIVE=1 a key that is not `sk_test_` — missing, restricted
// (`rk_test_`) or live — and a missing DATABASE_URL FAIL the run instead of skipping it: a skip there is a green run
// that tested nothing. Everything created is cleaned up: every session is expired, every probe charge is refunded, the
// throwaway orgs (and their ledger rows, by cascade) and the event ledger rows are deleted. The synced prices are only
// READ, never archived. Run from apps/web, against a fresh schema:
//   BILLING_LIVE=1 STRIPE_SECRET_KEY=sk_test_... DATABASE_URL=... \
//     npx vitest run src/lib/__tests__/stream-pack-checkout.live.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createRelayCheckout } from "@/lib/relay-checkout";
import { STREAM_CREDIT_PACKS, streamPack, streamPackPriceAmounts, type StreamCreditPack } from "@/lib/stream-credit-packs";
import { fulfilStreamCreditsCheckout } from "@/server/usecases/stream-credits-checkout";
import { creditBalance } from "@/server/usecases/stream-credits";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";

const BILLING_LIVE = process.env.BILLING_LIVE === "1";
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const HAS_DB = !!process.env.DATABASE_URL;

const uniq = (): string => randomUUID().slice(0, 12);

/** The declared pack for `size`, or a loud failure — never a silent undefined. */
function declared(size: number): StreamCreditPack {
  const pack = streamPack(size);
  if (!pack) throw new Error(`STREAM_CREDIT_PACKS declares no ${size}-pack; this suite's pack choice is stale`);
  return pack;
}

/** Every currency the pack's price declares, with the amount a checkout in it must charge — the declared table. */
function declaredAmounts(pack: StreamCreditPack): Array<[currency: string, amount: number]> {
  const want = streamPackPriceAmounts(pack);
  return [
    [want.currency, want.unit_amount],
    ...Object.entries(want.currency_options).map(([c, o]): [string, number] => [c, o.unit_amount]),
  ];
}

const cleanup: Array<() => Promise<unknown>> = [];
const seededOrgIds: string[] = [];
const deliveredEventIds: string[] = [];

afterAll(async () => {
  for (const fn of cleanup) await fn().catch(() => undefined);
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  if (deliveredEventIds.length) await sql`delete from billing_events where id = any(${deliveredEventIds})`;
  // org_stream_credits.org_id is `on delete cascade` (V410), so the ledger rows go with their org.
  if (seededOrgIds.length) await sql`delete from organizations where id = any(${seededOrgIds})`;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

async function seedOrg(): Promise<string> {
  const suffix = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Stream Pack Live " + suffix}, ${"stream-pack-live-" + suffix}) returning id`;
  seededOrgIds.push(id);
  return id;
}

// The same two preconditions as the throwing beforeAll below, as a TEST. A throwing hook marks the suite failed and exits
// 1, but counts its tests as SKIPPED — a JSON reader checking `numFailedTests` would read that as a clean skip. This one
// fails by count. It sits outside the block below because a hook failure there skips every test inside it.
describe.skipIf(!BILLING_LIVE)("match-credit packs live-run preconditions", () => {
  it("BILLING_LIVE=1 has an sk_test_ key and a database", () => {
    // A derived boolean, never the key: a failing `toContain` would print it.
    expect(KEY.startsWith("sk_test_"), "STRIPE_SECRET_KEY must be an sk_test_ key (not missing, rk_ or live)").toBe(true);
    expect(HAS_DB, "DATABASE_URL must be set (a fresh schema)").toBe(true);
  });
});

describe.skipIf(!BILLING_LIVE)("match-credit packs against live Stripe (test mode)", () => {
  // Constructed in beforeAll, not at describe-body scope: vitest evaluates the describe factory during COLLECTION even
  // when skipIf is true (see pass-credit-refund-reversal.live.test.ts).
  let stripe: Stripe;
  /** The route verifies with STRIPE_WEBHOOK_SECRET; Stripe cannot reach this process, so the REAL event is signed here
   *  with a secret this run owns. Stubbed rather than read, so CI's job-level value cannot drift from the signer. */
  const webhookSecret = `whsec_stream_pack_live_${randomBytes(12).toString("hex")}`;
  beforeAll(() => {
    // Asked to run live, so a wrong or missing precondition is a FAILURE (every test in this block reports it), never a
    // skip. The key itself is never put in a message.
    if (!KEY.startsWith("sk_test_")) {
      throw new Error(
        "BILLING_LIVE=1 needs STRIPE_SECRET_KEY to be an sk_test_ key — this suite writes (sessions, charges, refunds). " +
          "A missing, restricted (rk_) or live key is refused, not skipped.",
      );
    }
    if (!HAS_DB) throw new Error("BILLING_LIVE=1 needs DATABASE_URL (a fresh schema): this suite writes the credit ledger.");
    stripe = new Stripe(KEY);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", webhookSecret);
  });

  /** One delivery of `event` through the app's signed webhook route — the production ingress. */
  async function deliver(event: Stripe.Event): Promise<number> {
    const payload = JSON.stringify(event);
    const res = await stripeWebhook(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret }),
        },
      }),
    );
    if (!deliveredEventIds.includes(event.id)) deliveredEventIds.push(event.id);
    return res.status;
  }

  /** A session opened through the real use-case, then retrieved as STRIPE holds it — line items expanded (their price is
   *  inline on each line), the house form (lib/billing.ts reconcilePassCheckout). Expired in afterAll. */
  async function openSession(orgId: string, pack: StreamCreditPack, currency: string) {
    const fixtureId = randomUUID();
    const created = await createRelayCheckout({
      orgId,
      fixtureId,
      size: pack.size,
      returnUrl: "https://example.test/return?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      currency,
      customerId: null,
      customerEmail: `stream-pack-live-${uniq()}@example.com`,
    });
    cleanup.push(() => stripe.checkout.sessions.expire(created.id));
    expect(created.client_secret, "the secret the route hands the embedded sheet").toBeTruthy();
    const session = await stripe.checkout.sessions.retrieve(created.id, { expand: ["line_items"] });
    return { session, fixtureId };
  }

  /** A REAL succeeded charge. allow_redirects "never" so a test card confirms in one call. */
  async function paidIntent(amount: number, currency: string): Promise<Stripe.PaymentIntent> {
    const pi = await stripe.paymentIntents.create({
      amount,
      currency,
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: "stream-pack-checkout.live.test",
      metadata: { probe: "stream-pack-checkout.live.test" },
    });
    expect(pi.status, "the pack payment must have succeeded").toBe("succeeded");
    return pi;
  }

  it("stripe:sync left exactly one active price per declared pack, on the one match-credits product, at the declared amounts", async () => {
    let checked = 0;
    const products = new Set<string>();
    for (const pack of STREAM_CREDIT_PACKS) {
      const want = streamPackPriceAmounts(pack);
      const found = await stripe.prices.list({
        lookup_keys: [pack.lookupKey],
        active: true,
        limit: 10,
        expand: ["data.currency_options", "data.product"],
      });
      expect(found.data, `${pack.lookupKey}: one active price (run \`pnpm stripe:sync\` first)`).toHaveLength(1);
      const price = found.data[0]!;
      const product = price.product as Stripe.Product;
      products.add(product.id);
      expect(product.active, `${pack.lookupKey}: its product is active`).toBe(true);
      expect(product.metadata?.kind, `${pack.lookupKey}: hangs off the match-credits product`).toBe("stream_credits");
      expect(price.type, `${pack.lookupKey}: a one-time price`).toBe("one_time");
      expect(price.currency, `${pack.lookupKey}: base currency`).toBe(want.currency);
      expect(price.unit_amount, `${pack.lookupKey}: base amount`).toBe(want.unit_amount);
      // Every currency option, base included (Stripe echoes it once expanded): no option missing, none extra, none off.
      const live = Object.fromEntries(Object.entries(price.currency_options ?? {}).map(([c, o]) => [c, o.unit_amount]));
      expect(live, `${pack.lookupKey}: every currency option at the declared amount`).toEqual(
        Object.fromEntries(declaredAmounts(pack)),
      );
      checked++;
    }
    expect(checked, "packs checked against the sandbox").toBe(STREAM_CREDIT_PACKS.length);
    expect(checked, "zero packs checked is a failure, not a pass").toBeGreaterThan(0);
    expect(products.size, "every pack price hangs off ONE product").toBe(1);
  });

  it("createRelayCheckout opens a payment-mode session on the synced price in every declared currency, stamped with what fulfilment reads, and an open session grants nothing", async () => {
    // The 5-pack: credits != 1, so a grant or snapshot that fell back to "one credit" cannot pass as right.
    const pack = declared(5);
    const orgId = await seedOrg();
    const [synced] = (await stripe.prices.list({ lookup_keys: [pack.lookupKey], active: true, limit: 1 })).data;
    expect(synced, `${pack.lookupKey} is synced`).toBeTruthy();

    const currencies = declaredAmounts(pack);
    let checked = 0;
    for (const [currency, amount] of currencies) {
      const { session, fixtureId } = await openSession(orgId, pack, currency);
      expect(session.mode, currency).toBe("payment");
      expect(session.currency, currency).toBe(currency);
      expect(session.amount_subtotal, `${currency}: the declared amount`).toBe(amount);
      const items = session.line_items?.data ?? [];
      expect(items, `${currency}: exactly one line`).toHaveLength(1);
      expect(items[0]!.price?.id, `${currency}: the line charges the SYNCED price`).toBe(synced!.id);
      expect(items[0]!.quantity, currency).toBe(1);
      expect(items[0]!.currency, currency).toBe(currency);
      expect(items[0]!.amount_subtotal, `${currency}: the line's declared amount`).toBe(amount);
      // What the webhook dispatch (`kind`), its org gate (`org_id`) and fulfilStreamCreditsCheckout (`credits` snapshot,
      // `pack` fallback and ledger link) read — expected values from the DECLARED pack, never read back from the session.
      expect(session.metadata, currency).toMatchObject({
        kind: "stream_credits",
        org_id: orgId,
        fixture_id: fixtureId,
        pack: String(pack.size),
        credits: String(pack.credits),
      });
      // An API-created session is open, unpaid and has no PaymentIntent — nothing here can pay it. Handed as-is to the
      // fulfilment gate the webhook and the reconcile both end in, the REAL unpaid session grants nothing.
      expect(session.status, currency).toBe("open");
      expect(session.payment_status, currency).toBe("unpaid");
      expect(session.payment_intent, `${currency}: no PaymentIntent until a browser pays`).toBeNull();
      expect(await fulfilStreamCreditsCheckout(orgId, session, { alertStaff: false }), currency).toBe(false);
      checked++;
    }
    expect(checked, "currencies checked").toBe(1 + Object.keys(streamPackPriceAmounts(pack).currency_options).length);
    expect(checked, "the base currency alone is not a currency sweep").toBeGreaterThan(1);
    expect(await creditBalance(sql, orgId), "an unpaid session granted credits").toBe(0);
  }, 60_000); // live Stripe: a price lookup plus a create and a retrieve per currency

  it("a REAL refund of a paid pack charge claws the pack back exactly once — a redelivery and a re-claimed lease change nothing, even after a newer pack", async () => {
    const bought = declared(5);
    const later = declared(20);
    const orgId = await seedOrg();

    // Plain objects out of the postgres RowList, so toEqual compares rows and nothing the driver hangs on the array.
    const ledger = async () => ({
      balance: await creditBalance(sql, orgId),
      revokes: Array.from(
        await sql<{ delta: number; idempotency_key: string | null }[]>`
          select delta, idempotency_key from org_stream_credits
           where org_id = ${orgId} and reason = 'revoke' order by created_at`,
        (r) => ({ delta: r.delta, idempotency_key: r.idempotency_key }),
      ),
    });
    expect((await ledger()).balance, "a fresh org holds nothing").toBe(0);

    /** Buy `pack` in its base currency: the real session, a real charge for its total, the three-field overlay (see the
     *  header), through the real fulfilment. Returns the session and the charge's intent. */
    const buy = async (pack: StreamCreditPack) => {
      const [currency, amount] = declaredAmounts(pack)[0]!;
      const { session } = await openSession(orgId, pack, currency);
      expect(session.amount_total, "no address, no tax: the session's total is the declared amount").toBe(amount);
      const pi = await paidIntent(session.amount_total!, session.currency!);
      const completed: Stripe.Checkout.Session = { ...session, status: "complete", payment_status: "paid", payment_intent: pi.id };
      expect(await fulfilStreamCreditsCheckout(orgId, completed, { alertStaff: false }), "fulfilment granted it").toBe(true);
      return { session, pi, amount, currency };
    };

    const first = await buy(bought);
    // The row the production link builder wrote (stream-credits-checkout.ts) — keyed on the session, linked to the intent.
    const purchases = await sql<Record<string, unknown>[]>`
      select delta, bucket, stripe_event_id, stripe_checkout_session_id, stripe_payment_intent_id, pack_key, amount_minor, currency
        from org_stream_credits where org_id = ${orgId} and reason = 'purchase'`;
    expect(Array.from(purchases, (r) => ({ ...r }))).toEqual([
      {
        delta: bought.credits,
        bucket: "pack",
        stripe_event_id: first.session.id,
        stripe_checkout_session_id: first.session.id,
        stripe_payment_intent_id: first.pi.id,
        pack_key: bought.lookupKey,
        amount_minor: first.amount,
        currency: first.currency,
      },
    ]);
    expect((await ledger()).balance, "the bought pack").toBe(bought.credits);

    // Refund it the way a Dashboard refund does, then fetch the event STRIPE recorded for it.
    const since = Math.floor(Date.now() / 1000) - 60;
    const refund = await stripe.refunds.create({ payment_intent: first.pi.id });
    expect(refund.status).toBe("succeeded");
    let event: Stripe.Event | undefined;
    for (let attempt = 0; attempt < 30 && !event; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000));
      const page = await stripe.events.list({ type: "charge.refunded", created: { gte: since }, limit: 100 });
      event = page.data.find((e) => (e.data.object as Stripe.Charge).payment_intent === first.pi.id);
    }
    expect(event, "Stripe recorded a charge.refunded event for this intent within 30s").toBeTruthy();
    const charge = event!.data.object as Stripe.Charge;
    expect(charge.refunded, "a FULL refund — Stripe's own flag").toBe(true);
    expect(charge.amount_refunded).toBe(first.amount);

    const clawedOnce = [{ delta: -bought.credits, idempotency_key: `stream_pack_refund:${first.pi.id}` }];
    const processedAt = async () => {
      const [row] = await sql<{ processed_at: Date | null }[]>`select processed_at from billing_events where id = ${event!.id}`;
      return row?.processed_at ?? null;
    };

    // First delivery: the whole pack comes back out.
    expect(await deliver(event!), "the webhook accepted the refund").toBe(200);
    expect(await ledger()).toEqual({ balance: 0, revokes: clawedOnce });
    const stamped = await processedAt();
    expect(stamped, "the first delivery was processed").not.toBeNull();

    // Stripe's retry of the SAME event. At balance 0 the ledger cannot tell a stopped redelivery from a re-run one, so
    // the witness is runEvent's own ledger: a claim that held never re-runs the handler, and never re-stamps the row.
    expect(await deliver(event!), "a redelivery is still ACKed").toBe(200);
    expect((await processedAt())?.getTime(), "the redelivery re-ran the handler: the claim did not hold").toBe(
      stamped!.getTime(),
    );
    expect(await ledger(), "a redelivered refund clawed back twice").toEqual({ balance: 0, revokes: clawedOnce });

    // The org buys another pack, the same way. Its balance is no longer zero, so the balance cap can no longer stand in
    // for the claw-back's own idempotency key. Its charge is refunded in afterAll, never delivered here.
    const second = await buy(later);
    cleanup.push(() => stripe.refunds.create({ payment_intent: second.pi.id }));
    expect((await ledger()).balance, "the newer pack").toBe(later.credits);

    // A re-claimed lease: the first attempt "crashed" after the handler wrote and before processed_at was stamped,
    // and ten minutes on runEvent claims the event again and RE-RUNS the handler. Rewound on exactly this event's row.
    const rewound = await sql`
      update billing_events set processed_at = null, processing_started_at = now() - interval '11 minutes'
       where id = ${event!.id} returning id`;
    expect(rewound.length, "the event's ledger row was rewound").toBe(1);
    expect(await deliver(event!), "the re-claimed delivery is ACKed").toBe(200);
    expect(await processedAt(), "the handler really ran again (else the claim, not the claw-back, stopped it)").not.toBeNull();
    expect(await ledger(), "a replayed refund reached into the newer pack").toEqual({
      balance: later.credits,
      revokes: clawedOnce,
    });
  }, 120_000); // live Stripe: two sessions, two charges, a refund, an event poll of up to 30s and three webhook trips
});
