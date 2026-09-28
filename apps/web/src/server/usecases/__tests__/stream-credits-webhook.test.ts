// The purchase lands on the webhook SYNCHRONOUSLY: the route calls
// runEvent → processStripeEvent → handleCheckoutCompleted (P6).
//
// The replay claim is driven through runEvent, which is the REAL claim, and
// never through the cron (FT0-5). `sweepStuckEvents` selects only rows with
// `processed_at is null` older than ten minutes, so a purchase the webhook
// already processed is never selected: "drive the cron, the balance is
// unchanged" stays green with the dedupe DELETED and witnesses nothing.
// runEvent does: its insert conflicts on the already-processed row, claims
// nothing, returns false, and the handler is never reached. The LEDGER ROW
// COUNT is asserted directly rather than inferred from the balance, because a
// second row carrying a compensating delta would leave the balance unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { seedOrg } from "./_rig";
import { runEvent } from "../billing-events";
import { creditBalance } from "../stream-credits";
import { type StreamCreditPack, streamPack } from "@/lib/stream-credit-packs";
import { buildRelayCheckoutParams } from "@/lib/relay-checkout";
import { sendStreamCreditGrantFailedAlertEmail } from "@/lib/email";

// The staff alert is the only thing that tells a HUMAN a customer paid and
// holds nothing — every other paid-but-ungranted branch in billing-events.ts
// pairs its `log.error` with one. Mocked rather than stubbed at the transport
// so the assertion is on the call the branch makes, not on whether an SMTP
// env happens to be configured in this process.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendStreamCreditGrantFailedAlertEmail: vi.fn(async () => true),
}));
const alertMock = vi.mocked(sendStreamCreditGrantFailedAlertEmail);

// Linking a Stripe customer onto a billing group re-derives the card flag, and
// that re-derivation makes a REAL Stripe round trip
// (billing.ts syncPaymentMethodFlagForSubscription → customers.retrieve). Its
// own try/catch swallows the failure, so the link itself is unaffected — this
// mock only keeps the suite off the network and off a 10s client timeout. The
// assertions below all read the DATABASE, never this mock.
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe")>()),
  getStripe: () => {
    throw new Error("stream-credits webhook suite makes no Stripe calls");
  },
}));

// The REAL writer for every test here but one. The branch's catch is scoped to
// the ONE terminal refusal (`stripe_event_org_mismatch`); a transient database
// fault must still reach the webhook's error path so Stripe redelivers. There
// is no natural way to make the real `recordPurchase` fail transiently — every
// other refusal it raises is unreachable from this branch — so exactly one
// session id is routed into a rejection and the rest delegate to the original.
vi.mock("../stream-credits", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stream-credits")>();
  return {
    ...real,
    recordPurchase: (args: Parameters<typeof real.recordPurchase>[0]) =>
      args.stripeEventId.includes("_boom_")
        ? Promise.reject(new Error("connection terminated unexpectedly"))
        : real.recordPurchase(args),
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

/** `seedOrg` leaves the org with NO billing group, and both
 *  `linkStripeCustomer` and `pinBillingCurrency` return early when there is
 *  none (billing.ts:611, :668) — so an org without one cannot witness either
 *  write, and a test built on a bare `seedOrg` passes with both calls deleted.
 *  This gives the org a real group to write THROUGH. */
async function seedOrgWithBillingGroup(): Promise<{ orgId: string; subscriptionId: string }> {
  const { auth } = await seedOrg();
  const suffix = auth.orgId.slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`stream-${suffix}@test.local`}, 'Stream', true) returning id`;
  const [{ id: subscriptionId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
    values (${userId}, 'community', 'active', 1) returning id`;
  await sql`update organizations set subscription_id = ${subscriptionId} where id = ${auth.orgId}`;
  return { orgId: auth.orgId, subscriptionId };
}

function completed(orgId: string, sessionId: string, credits: string): Stripe.Event {
  return {
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        currency: "gbp",
        // The pack-5 sandbox price in pence. The branch copies it to the ledger
        // row's amount_minor, so the fixture MUST carry it — a missing
        // amount_total would make the link assertion pass on null.
        amount_total: 2500,
        customer: null,
        payment_intent: `pi_${sessionId}`,
        metadata: { kind: "stream_credits", org_id: orgId, fixture_id: "00000000-0000-4000-8000-000000000000", pack: "5", credits },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("checkout.session.completed → stream credits", () => {
  beforeEach(() => {
    alertMock.mockClear();
    vi.stubEnv("STAFF_ALERT_EMAIL", "billing-ops@example.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes ONE purchase row for the snapshotted credits, carrying the Stripe link; a redelivery claims nothing and writes none", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_stream_${auth.orgId.slice(0, 8)}`;
    const ev = completed(auth.orgId, sid, "5");
    expect(await runEvent(ev)).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    // The SAME event delivered again — the claim finds a processed row.
    expect(await runEvent(ev)).toBe(false);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    const rows = await sql<
      { reason: string; delta: number; stripe_event_id: string; stripe_checkout_session_id: string | null; stripe_payment_intent_id: string | null; pack_key: string | null; amount_minor: number | null; currency: string | null }[]
    >`
      select reason, delta, stripe_event_id, stripe_checkout_session_id, stripe_payment_intent_id, pack_key, amount_minor, currency
      from org_stream_credits where org_id = ${auth.orgId}`;
    // Exactly one row, and the link on it — ids and amounts, never card data.
    // `pack_key` is read off the CATALOGUE rather than retyped (S10), so a
    // renamed lookup key moves the test with the source of truth.
    expect(rows).toEqual([
      {
        reason: "purchase", delta: 5, stripe_event_id: sid,
        stripe_checkout_session_id: sid,
        // The durable "which charge paid for this" reference — a refund or a
        // dispute arrives keyed on the INTENT, not the session, so a null here
        // is a row nobody can reconcile. Asserted by value: the branch copies
        // it out of the session, and nothing else in the suite would notice it
        // becoming null.
        stripe_payment_intent_id: `pi_${sid}`,
        pack_key: streamPack(5)!.lookupKey,
        amount_minor: 2500, currency: "gbp",
      },
    ]);
    // The positive pair for the two alert assertions below: a purchase that
    // GRANTED must page nobody, or the alert is noise and gets filtered.
    expect(alertMock).not.toHaveBeenCalled();
  });

  // Disjointness, PROVED rather than read. The two currencies are structurally
  // separated by the `credit_pack` arm returning before the `stream_credits`
  // arm is reached, which is a property of the SOURCE — and a reader can be
  // wrong about it, or a later edit can reorder the arms without any test
  // noticing. Both directions, because either one alone is satisfied by a
  // branch that writes to both tables.
  it("a match-credit session never touches the AI credit wallet, and an AI credit_pack session never touches the match ledger", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_disjoint_${auth.orgId.slice(0, 8)}`;
    expect(await runEvent(completed(auth.orgId, sid, "5"))).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    // walletIdFor is `coalesce(subscription_id, id)` (lib/credits.ts:79), which
    // for an org with no billing group is the org id itself — so this is the
    // wallet a mis-routed grant would have landed in.
    const wallet = await sql<{ n: string }[]>`
      select count(*)::text as n from ai_credit_ledger where wallet_id = ${auth.orgId}`;
    expect(wallet[0]!.n).toBe("0");

    // The other direction, same org: an AI credit pack must leave the match
    // ledger exactly as it was.
    const packEv = completed(auth.orgId, `cs_test_aipack_${auth.orgId.slice(0, 8)}`, "40");
    (packEv as unknown as { id: string }).id = `evt_aipack_${auth.orgId.slice(0, 8)}`;
    (packEv.data.object as unknown as { metadata: Record<string, string> }).metadata = {
      kind: "credit_pack", org_id: auth.orgId, pack_key: "small", credits: "40",
    };
    expect(await runEvent(packEv)).toBe(true);
    const walletAfter = await sql<{ n: string }[]>`
      select count(*)::text as n from ai_credit_ledger where wallet_id = ${auth.orgId}`;
    expect(walletAfter[0]!.n).toBe("1");
    // Unmoved: still the one match-credit row, still 5.
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    const match = await sql<{ n: string }[]>`
      select count(*)::text as n from org_stream_credits where org_id = ${auth.orgId}`;
    expect(match[0]!.n).toBe("1");
  });

  // `allow_promotion_codes: true` is set on this checkout
  // (relay-checkout.ts:59), so a 100%-off code is reachable TODAY. Stripe
  // completes such a session with `payment_status: "no_payment_required"` and
  // no PaymentIntent at all — it is a settled, fulfil-now session, not an
  // unpaid one. A gate that only knows "paid" drops it silently: the buyer
  // redeems a code, sees the success return, and holds nothing.
  it("grants a fully-discounted session (no_payment_required) — a 100% promo code is settled, not unpaid", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_promo_${auth.orgId.slice(0, 8)}`;
    const ev = completed(auth.orgId, sid, "5");
    const obj = ev.data.object as unknown as {
      payment_status: string; amount_total: number; payment_intent: string | null;
    };
    obj.payment_status = "no_payment_required";
    // Nothing was charged, so there is no intent and the total is zero — both
    // ride onto the ledger row exactly as Stripe reports them.
    obj.amount_total = 0;
    obj.payment_intent = null;
    expect(await runEvent(ev)).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    const [row] = await sql<
      { delta: number; amount_minor: number | null; stripe_payment_intent_id: string | null }[]
    >`select delta, amount_minor, stripe_payment_intent_id
        from org_stream_credits where org_id = ${auth.orgId}`;
    expect(row).toEqual({ delta: 5, amount_minor: 0, stripe_payment_intent_id: null });
  });

  // A delayed-notification method (bank debit, Blik, P24 …) completes the
  // session UNPAID and sends the outcome minutes or days later as
  // `async_payment_succeeded`. That dispatch handled `registration_group`
  // only, so a match-credit pack bought that way was charged and never
  // granted — the `completed` event's payment_status gate correctly refuses
  // it, and nothing ever came back.
  //
  // MEASURED, not assumed: the sandbox's only payment method configuration
  // (`pmc_…BLxmC9Aq`, active) enables apple_pay, bancontact, blik, card, eps,
  // giropay, link, p24 and upi — of which NONE is delayed-notification today,
  // and a real GBP pack session came back `payment_method_types:
  // ["card","link"]`. So this is unreachable on the account as configured;
  // enabling one method in the Dashboard is what makes it reachable, which is
  // a change nobody would think to pair with a webhook edit.
  it("grants on async_payment_succeeded — a delayed-notification pack is not charged and forgotten", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_async_${auth.orgId.slice(0, 8)}`;
    // Exactly how Stripe sends it: the session completed UNPAID, so the
    // `completed` event granted nothing, and the later event carries "paid".
    const pending = completed(auth.orgId, sid, "5");
    (pending.data.object as unknown as { payment_status: string }).payment_status = "unpaid";
    expect(await runEvent(pending)).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);

    const settled = completed(auth.orgId, sid, "5");
    (settled as unknown as { id: string; type: string }).id = `evt_async_${auth.orgId.slice(0, 8)}`;
    (settled as unknown as { type: string }).type = "checkout.session.async_payment_succeeded";
    expect(await runEvent(settled)).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    // ONE row: the ledger is keyed on the session id, which both events carry,
    // so the pair cannot double-grant even if the earlier one had been paid.
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from org_stream_credits where org_id = ${auth.orgId}`;
    expect(rows[0]!.n).toBe("1");
  });

  // Class 1, the repo's most-repeated defect: every OTHER test here — and the
  // producer's own suite — agrees with a HAND-TYPED metadata literal, so a
  // renamed key reds one side, gets "fixed" there, and the other side keeps
  // passing while production falls back to the catalogue on every purchase.
  // This is the only test in which the keys are typed ZERO times: the real
  // builder's output is folded straight onto the session the real handler
  // reads.
  //
  // The pack is SYNTHETIC on one field only. Every catalogue pack has
  // `size === credits`, so a fold-through built on a real pack could not tell
  // `metadata.credits` from `metadata.pack` — the grant would be 5 either way
  // and a swapped key would pass. 7 credits on the 5-pack makes the two
  // answers different, which is the whole point (class 19).
  it("folds the REAL builder's metadata into the REAL webhook branch — the keys are typed on neither end", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_fold_${auth.orgId.slice(0, 8)}`;
    const soldPack: StreamCreditPack = { ...streamPack(5)!, credits: 7 };
    const params = buildRelayCheckoutParams({
      priceId: "price_fold_test",
      orgId: auth.orgId,
      fixtureId: "00000000-0000-4000-8000-0000000000ff",
      pack: soldPack,
      returnUrl: "https://example.test/return",
    });
    const ev = completed(auth.orgId, sid, "ignored");
    (ev.data.object as unknown as { metadata: unknown }).metadata = params.metadata;
    expect(await runEvent(ev)).toBe(true);
    // 7, not 5: the SNAPSHOT the builder stamped, read through the builder's
    // own key name. A rename on either side makes this the only red.
    expect(await creditBalance(sql, auth.orgId)).toBe(soldPack.credits);
    const [row] = await sql<{ delta: number; pack_key: string | null }[]>`
      select delta, pack_key from org_stream_credits where org_id = ${auth.orgId}`;
    expect(row).toEqual({ delta: 7, pack_key: streamPack(5)!.lookupKey });
  });

  // The two writes that follow a successful grant. Neither is observable
  // through the credit ledger, so nothing in this suite noticed them being
  // deleted: the customer link is what lets the buyer manage the card they
  // just used, and the currency pin is what stops an org that paid in GBP
  // being quoted USD for its next purchase (billing.ts:648 comment).
  it("a granted purchase links the Stripe customer onto the billing group and pins the org's currency", async () => {
    const { orgId, subscriptionId } = await seedOrgWithBillingGroup();
    const sid = `cs_test_link_${orgId.slice(0, 8)}`;
    const ev = completed(orgId, sid, "5");
    (ev.data.object as unknown as { customer: string }).customer = `cus_link_${orgId.slice(0, 8)}`;
    expect(await runEvent(ev)).toBe(true);
    expect(await creditBalance(sql, orgId)).toBe(5);
    const [sub] = await sql<{ stripe_customer_id: string | null; currency: string | null }[]>`
      select stripe_customer_id, currency from subscriptions where id = ${subscriptionId}`;
    expect(sub).toEqual({
      stripe_customer_id: `cus_link_${orgId.slice(0, 8)}`,
      currency: "gbp",
    });
  });

  // The branch's trailing `return` is not dead code: without it a
  // stream_credits session falls through to the SUBSCRIPTION checkout handling
  // below, which links `session.customer` onto the billing group for any
  // session carrying one. An UNPAID session granted nothing, so it has no
  // business stamping a customer anywhere — and unpaid is the only state that
  // can tell the two apart, because a PAID session links the same id by the
  // branch's own hand.
  it("an UNPAID session carrying a customer does not fall through — nothing is stamped on the billing group", async () => {
    const { orgId, subscriptionId } = await seedOrgWithBillingGroup();
    const sid = `cs_test_unpaidlink_${orgId.slice(0, 8)}`;
    const ev = completed(orgId, sid, "5");
    (ev.data.object as unknown as { payment_status: string }).payment_status = "unpaid";
    (ev.data.object as unknown as { customer: string }).customer = `cus_unpaid_${orgId.slice(0, 8)}`;
    expect(await runEvent(ev)).toBe(true);
    const [sub] = await sql<{ stripe_customer_id: string | null; currency: string | null }[]>`
      select stripe_customer_id, currency from subscriptions where id = ${subscriptionId}`;
    expect(sub).toEqual({ stripe_customer_id: null, currency: null });
  });

  it("an unpaid session is claimed and handled, and writes nothing", async () => {
    const { auth } = await seedOrg();
    const ev = completed(auth.orgId, `cs_test_unpaid_${auth.orgId.slice(0, 8)}`, "5");
    (ev.data.object as unknown as { payment_status: string }).payment_status = "unpaid";
    // true: the event IS claimed and dispatched. The refusal is the branch's
    // payment_status check, not a missing claim — asserting the claim here is
    // what keeps this from passing for the wrong reason.
    expect(await runEvent(ev)).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
  });

  // The test above cannot witness snapshot authority: its snapshot is "5" and
  // the pack-5 catalogue entry is ALSO 5, so a branch that ignored the snapshot
  // and re-derived from the catalogue would grant the same number and pass. The
  // whole reason the snapshot exists is that the two CAN disagree — a deploy
  // between "buyer opens checkout" and "buyer finishes paying" moves the
  // catalogue, and what was SOLD is what must be granted.
  it("grants the SNAPSHOT, not the live catalogue, when a deploy has moved the pack under an open session", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_snap_${auth.orgId.slice(0, 8)}`;
    // Sold as 3 credits; the catalogue now says pack 5 is worth 5.
    expect(streamPack(5)!.credits).toBe(5);
    expect(await runEvent(completed(auth.orgId, sid, "3"))).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(3);
    const rows = await sql<{ delta: number; pack_key: string | null }[]>`
      select delta, pack_key from org_stream_credits where org_id = ${auth.orgId}`;
    // The LINK still names the pack that was bought — only the granted amount
    // comes from the snapshot.
    expect(rows).toEqual([{ delta: 3, pack_key: streamPack(5)!.lookupKey }]);
  });

  // S8, empty input: `Number("")` is 0 and `Number(undefined)` is NaN, so a
  // session that never got a snapshot (or got an unusable one) must NOT grant
  // zero silently. It falls back to the catalogue by pack size, loudly.
  it.each([["", "an empty snapshot"], ["nope", "a non-numeric snapshot"], ["0", "a zero snapshot"], ["2.5", "a fractional snapshot"]])(
    "falls back to the catalogue when the session carries %s (%s)",
    async (credits) => {
      const { auth } = await seedOrg();
      const sid = `cs_test_fb_${auth.orgId.slice(0, 8)}`;
      expect(await runEvent(completed(auth.orgId, sid, credits))).toBe(true);
      expect(await creditBalance(sql, auth.orgId)).toBe(streamPack(5)!.credits);
    },
  );

  it("a paid session with neither a usable snapshot nor a resolvable pack is ACKed and grants NOTHING — never a zero-credit row", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_nopack_${auth.orgId.slice(0, 8)}`;
    const ev = completed(auth.orgId, sid, "");
    (ev.data.object as unknown as { metadata: Record<string, string> }).metadata.pack = "7";
    // Claimed and dispatched — a retry cannot turn this into a grant, so the
    // event is acknowledged and a human grants it by hand (the staff panel).
    expect(await runEvent(ev)).toBe(true);
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from org_stream_credits where org_id = ${auth.orgId}`;
    expect(rows[0]!.n).toBe("0");
    // …and a HUMAN is told, because nothing else will ever notice. The log line
    // alone is what the donor branch (credit_pack, :267) was given an alert to
    // stop relying on.
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]![0]).toMatchObject({
      to: "billing-ops@example.test",
      sessionId: sid,
      orgId: auth.orgId,
      packRaw: "7",
    });
  });

  // The guard the donor carries, mutatable on its own: no address configured is
  // not a reason to fail the webhook, and it must not attempt a send to
  // `undefined`. Paired with the positive above so "never sends" cannot pass.
  it("sends no alert when STAFF_ALERT_EMAIL is unset, and still ACKs the ungranted session", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "");
    const { auth } = await seedOrg();
    const sid = `cs_test_noalert_${auth.orgId.slice(0, 8)}`;
    const ev = completed(auth.orgId, sid, "");
    (ev.data.object as unknown as { metadata: Record<string, string> }).metadata.pack = "7";
    expect(await runEvent(ev)).toBe(true);
    expect(alertMock).not.toHaveBeenCalled();
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
  });

  // recordPurchase THROWS a 409 `stripe_event_org_mismatch` when the Checkout
  // Session id it is keyed on is already recorded against a DIFFERENT org
  // (the column is unique TABLE-wide). That refusal is TERMINAL: nothing about
  // retrying it can succeed, so it must be ACKed. Let it reach the webhook's
  // generic error path and Stripe redelivers the same event for days while the
  // ledger stays unchanged and nobody is paged by anything but the volume.
  it("a Checkout Session id already recorded for ANOTHER org is acknowledged, not retried, and writes nothing", async () => {
    const first = (await seedOrg()).auth;
    const second = (await seedOrg()).auth;
    const sid = `cs_test_crossorg_${first.orgId.slice(0, 8)}`;
    expect(await runEvent(completed(first.orgId, sid, "5"))).toBe(true);
    expect(await creditBalance(sql, first.orgId)).toBe(5);

    // A DIFFERENT Stripe event (so runEvent's own claim does not swallow it)
    // carrying the SAME session id but the second org's metadata.
    const collide = completed(second.orgId, sid, "5");
    (collide as unknown as { id: string }).id = `evt_crossorg_${second.orgId.slice(0, 8)}`;
    await expect(runEvent(collide)).resolves.toBe(true);
    expect(await creditBalance(sql, second.orgId)).toBe(0);
    expect(await creditBalance(sql, first.orgId)).toBe(5);
    // `processed_at` set is what tells Stripe to stop: runEvent stamps it only
    // after the handler returned without throwing.
    const [row] = await sql<{ processed_at: string | null }[]>`
      select processed_at from billing_events where id = ${`evt_crossorg_${second.orgId.slice(0, 8)}`}`;
    expect(row!.processed_at).not.toBeNull();
    // ACKed means Stripe stops asking — so this limb is the OTHER
    // paid-but-ungranted exit, and it owes the same staff alert. Exactly once,
    // and for the SECOND org: the first org's purchase succeeded.
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]![0]).toMatchObject({
      to: "billing-ops@example.test",
      sessionId: sid,
      orgId: second.orgId,
    });
  });

  // The OTHER direction of the same guard, and the reason it is scoped to one
  // code rather than swallowing everything: a database blip is retryable, and
  // acknowledging it would lose a paid purchase with nothing left to replay.
  it("a transient writer failure is NOT acknowledged — it reaches the webhook's error path and leaves the event unprocessed", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_boom_${auth.orgId.slice(0, 8)}`;
    await expect(runEvent(completed(auth.orgId, sid, "5"))).rejects.toThrow(/connection terminated/);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    // processed_at still NULL: Stripe will redeliver, and the stuck-event sweep
    // can see it. A swallowed error would have stamped it and lost the sale.
    const [row] = await sql<{ processed_at: string | null }[]>`
      select processed_at from billing_events where id = ${`evt_${sid}`}`;
    expect(row!.processed_at).toBeNull();
  });
});
