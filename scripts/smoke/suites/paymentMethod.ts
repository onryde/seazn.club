// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, raw, check, signIn, tag, setStaff, smokeDb } from "../harness.ts";

/** Task 11: staffRemovePaymentMethod (staff can remove even the DEFAULT card)
 *  and the customer-facing removePaymentMethod's default-card refusal, both
 *  new user-visible rails with no prior smoke arm. Needs a REAL Stripe
 *  test-mode customer + card — no app route mints one headless, since the
 *  actual "add a card" flow mounts Stripe's own Elements iframe
 *  (AddCardForm). Stripe's `pm_card_visa` token exists exactly for this:
 *  attaching it to a customer in test mode creates a real PaymentMethod with
 *  no client-side confirmation step needed. Keyless-safe: skips (rather than
 *  fails) without STRIPE_SECRET_KEY, the same convention as the sponsor
 *  Connect checkout suite. */
export async function paymentMethodSuite(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) {
    check("pm: skipped (no STRIPE_SECRET_KEY — cannot attach a real test card)", true);
    return;
  }
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const staffEmail = `delivered+pm_staff_${tag}@resend.dev`;
  const staff = newSession();
  await signIn(staff, staffEmail);

  const owner = newSession();
  const ownerOrg = (await signIn(owner, `delivered+pm_owner_${tag}@resend.dev`)).org_id;

  const customer = await stripe.customers.create({
    email: `delivered+pm_owner_${tag}@resend.dev`,
  });
  const pm = await stripe.paymentMethods.attach("pm_card_visa", {
    customer: customer.id,
  });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  const readFlag = async (): Promise<boolean | null> => {
    const d = smokeDb();
    try {
      // Through organizations.subscription_id — see readSub; V310 dropped
      // subscriptions.org_id.
      const [row] = await d<{ has_payment_method: boolean | null }[]>`
        select s.has_payment_method from subscriptions s
        join organizations o on o.subscription_id = s.id
        where o.id = ${ownerOrg}`;
      return row ? row.has_payment_method : null;
    } finally {
      await d.end();
    }
  };

  const db = smokeDb();
  try {
    // Through organizations.subscription_id — V310 dropped subscriptions.org_id.
    await db`
      update subscriptions
      set stripe_customer_id = ${customer.id}, has_payment_method = true
      where id = (select subscription_id from organizations where id = ${ownerOrg})`;
  } finally {
    await db.end();
  }

  await setStaff(staffEmail, "superadmin");
  try {
    // The org's only card is also its default — the customer-facing path
    // refuses exactly that (400), before Stripe is ever called.
    const customerAttempt = await raw(owner, "/api/billing/remove-payment-method", "POST", {
      payment_method_id: pm.id,
    });
    check(
      "pm/customer: removing the DEFAULT card is refused (400)",
      customerAttempt.status === 400,
    );

    // Staff CAN remove it — the audited exception (Task 6C) — and the mirror
    // re-reads Stripe rather than assuming, so it flips false once no cards
    // remain (this org had exactly one).
    const staffRemove = await raw(
      staff,
      `/api/admin/orgs/${ownerOrg}/remove-payment-method`,
      "POST",
      {
        payment_method_id: pm.id,
        reason: "smoke: staff can remove the default card",
      },
    );
    check(
      "pm/staff: staff removes the default card (200) and has_payment_method re-mirrors false",
      staffRemove.status === 200 && (await readFlag()) === false,
    );
  } finally {
    await setStaff(staffEmail, null);
  }
}
