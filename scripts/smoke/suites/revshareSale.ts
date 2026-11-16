// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, postSignedStripeWebhook, smokeDb } from "../harness.ts";

/**
 * Revshare affiliate sale reporting, server half.
 *
 * A signed `invoice.payment_succeeded` for a group whose org carries a
 * revshare_ref_code goes through the app's REAL webhook route -> runEvent ->
 * handleInvoicePaymentSucceeded -> reportSale. Smoke cannot see the outbound
 * POST (the server dials www.revshare.so itself), so what is pinned here is the
 * half that CAN regress in a deployed build: reporting is best-effort, so an
 * attributed first charge AND a renewal both still get a 200, are marked
 * processed in the ledger, and leave the subscription active. The request body
 * (cents, GBP, invoice-id transaction, oldest ref_code) is pinned against the
 * real handler by revshare-sale-seam.test.ts.
 *
 * Skips, loudly, in two cases:
 *  - no STRIPE_WEBHOOK_SECRET: cannot sign an event this server will accept
 *    (same convention as addonChurnWebhook);
 *  - REVSHARE_API_KEY present in THIS process: the server under test is then
 *    almost certainly holding the same live key, and the attributed leg would
 *    POST a synthetic sale to the real Revshare program. CI has no key, so the
 *    leg runs there with reporting inert (a no-op by design without a key).
 */
export async function revshareSaleSuite(): Promise<void> {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    check(
      "revshare sale: skipped (no STRIPE_WEBHOOK_SECRET — cannot sign a webhook this server will accept); revshare-sale-seam.test.ts covers the handler",
      true,
    );
    return;
  }
  if (process.env.REVSHARE_API_KEY) {
    check(
      "revshare sale: skipped (REVSHARE_API_KEY is set — the server under test would POST a synthetic sale to the LIVE Revshare program); unset it to run this leg",
      true,
    );
    return;
  }

  const db = smokeDb();
  try {
    const s = newSession();
    const email = `delivered+revshare_${tag}@resend.dev`;
    const orgId = (await signIn(s, email)).org_id;
    const subId = `sub_smoke_rs_${tag}`;
    const cusId = `cus_smoke_rs_${tag}`;
    const [row] = await db<{ wallet_id: string }[]>`
      select coalesce(subscription_id::text, id::text) as wallet_id
        from organizations where id = ${orgId}`;
    await db`
      update subscriptions
         set stripe_subscription_id = ${subId}, stripe_customer_id = ${cusId}
       where id = ${row.wallet_id}`;
    await db`update subscriptions set revshare_ref_code = ${`smoke_${tag}`} where id = ${row.wallet_id}`;

    const [fixture] = await db<{ ref: string | null; sub: string | null }[]>`
      select revshare_ref_code as ref, stripe_subscription_id as sub
        from subscriptions where id = ${row.wallet_id}`;
    check(
      "revshare sale: fixture built — a paying group stamped with a ref_code that Stripe can match",
      fixture?.ref === `smoke_${tag}` && fixture?.sub === subId,
    );

    const invoice = (id: string) => ({
      object: "invoice",
      id,
      customer: cusId,
      amount_paid: 4900,
      currency: "gbp",
      billing_reason: "subscription_cycle",
      metadata: {},
      lines: { data: [] },
      parent: { subscription_details: { subscription: subId } },
    });

    for (const [label, invoiceId] of [
      ["first charge", `in_smoke_rs_a_${tag}`],
      ["renewal", `in_smoke_rs_b_${tag}`],
    ] as const) {
      const eventId = `evt_smoke_${tag}_rs_${label.replace(" ", "_")}`;
      const status = await postSignedStripeWebhook("invoice.payment_succeeded", invoice(invoiceId), eventId);
      check(`revshare sale: the app accepts the signed ${label} invoice for an attributed group (200)`, status === 200);
      const [ev] = await db<{ processed_at: Date | null }[]>`
        select processed_at from billing_events where id = ${eventId}`;
      check(
        `revshare sale: the ${label} event is marked processed — reporting never leaves the ledger row stuck at 'received'`,
        !!ev?.processed_at,
      );
    }

    const [sub] = await db<{ status: string }[]>`select status from subscriptions where id = ${row.wallet_id}`;
    check("revshare sale: the subscription is still active after both attributed invoices", sub?.status === "active");
  } finally {
    await db.end();
  }
}
