// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { BASE, newSession, check, html, signIn, setPlan, smokeDb, tag, v1, v1data } from "../harness.ts";
import { latestOutboxBody, payLinkFrom } from "../../../apps/web/e2e/outbox-body-open.ts";

/** Player payment page (plan 2026-11-11-player-payment-page, Task 4) - what only the served app can prove.
 *
 *  `GET /r/pay/<unknown token>` is the ONE opaque not-found, in the reader's language, and does not fall into `/r/[ref]`
 *  (a six-character reference lookup): the static `pay` segment must win.
 *
 *  Task 5: the chase mails link the page. The organiser's reminder (the real API) answers, queues one mail and records one
 *  token; the sweep's reminder, opened from the outbox, links `/r/pay/<token>` and no Checkout url; and Pay on that entry, once
 *  the organiser has marked it paid, answers 409 and leaves the cart's Checkout pointer exactly as it was (nothing minted).
 *  That part needs DATABASE_URL, CRON_SECRET and EMAIL_OUTBOX_KEK (the server's own values) and skips by name without them.
 *
 *  The not-found part is keyless-safe; no org, no Stripe. */
export async function registrationPayPageSuite() {
  const en = JSON.parse(readFileSync(new URL("../../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8")) as Record<string, string>;
  const body = en["regPay.notFound.body"];
  // React escapes text nodes: `isn't` is served as `isn&#x27;t`.
  const served = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  check("pay page smoke: the not-found copy exists in en/ui.json", typeof body === "string" && body.length > 0);

  const token = randomBytes(32).toString("base64url"); // 43 characters, well-formed, unknown
  check("pay page smoke: the probe token is 43 characters", token.length === 43);
  const page = await html(newSession(), `/r/pay/${token}`);
  check("pay page smoke: an unknown token answers 404", page.status === 404);
  check("pay page smoke: the 404 carries the opaque not-found copy", page.body.includes(served(body)));
  // (The 404's flight payload does echo the visitor's own URL back to them; that leaks nothing, so it is not asserted either way.)
  check("pay page smoke: the 404 is noindex", /<meta name="robots" content="noindex/.test(page.body));

  await chaseMailsLinkThePage();
}

/** Task 5: the reminder smoke row and "Pay on a paid entry answers 409", with a token a real producer issued. */
async function chaseMailsLinkThePage(): Promise<void> {
  const missing = ["DATABASE_URL", "CRON_SECRET", "EMAIL_OUTBOX_KEK"].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    check(`pay page smoke: chase-mail and paid-409 checks skipped (no ${missing.join(", ")} in the smoke env)`, true);
    return;
  }
  const fee = 1500;
  const owner = newSession();
  const who = await signIn(owner, `delivered+paypage_${tag}@resend.dev`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner);
  const db = smokeDb();
  try {
    // Connect on with a test account id: the sweep reminds only when charges are enabled; nothing here calls Stripe.
    await db`update organizations set stripe_charges_enabled = true, stripe_account_id = ${`acct_smoke_pp_${tag}`} where id = ${orgId}`;
    const comp = v1data<{ id: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Pay Page ${tag}`, visibility: "public" }),
    );
    const div = v1data<{ id: string }>(
      await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
    const put = await v1(owner, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: fee,
      payment_method: "stripe",
    });
    check("pay page smoke: a card-paid division is set up", put.status === 200);

    // One pending card entry whose cart is due within the sweep's T-24h window.
    const [g] = await db<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, amount_cents, currency, payment_method, expires_at,
         locale, ref_code, privacy_consent_at, privacy_consent_version)
      values (${comp.id}, 'Pay Page Entrant', ${`delivered+paypage_entry_${tag}@resend.dev`}, ${randomBytes(32).toString("hex")},
              ${fee}, 'gbp', 'stripe', now() + interval '10 hours', 'en', ${`PP${tag.slice(-4).toUpperCase()}`}, now(), 'smoke')
      returning id`;
    const [r] = await db<{ id: string }[]>`
      insert into registrations (group_id, division_id, display_name, status, amount_cents)
      values (${g.id}, ${div.id}, 'Pay Page Entrant', 'pending', ${fee}) returning id`;
    const regId = r.id;
    const tokens = async () =>
      Number((await db<{ n: string }[]>`select count(*)::text as n from registration_pay_tokens where registration_id = ${regId}`)[0].n);

    // The organiser's reminder through the real API: one mail queued (and attempted at once), one token recorded.
    const remind = await v1(owner, `/api/v1/registrations/${regId}/remind`, "POST");
    check("pay page smoke: the organiser's reminder answers 200", remind.status === 200);
    const manual = await db<{ n: string }[]>`
      select count(*)::text as n from email_outbox where kind = 'payment_reminder' and ref_type = 'registration' and ref_id = ${regId}`;
    check("pay page smoke: the organiser's reminder queued one mail", Number(manual[0].n) === 1);
    check("pay page smoke: the organiser's reminder recorded one pay-page token", (await tokens()) === 1);

    // The sweep's reminder (left to the worker, so its sealed body is still on the row): our link, never Checkout.
    const sweep = await fetch(`${BASE}/api/cron/registrations`, { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET! } });
    check("pay page smoke: the registrations sweep answers 200", sweep.status === 200);
    const body = await latestOutboxBody("payment_reminder", "registration", regId);
    check("pay page smoke: the reminder body links /r/pay/", body.html.includes("/r/pay/") && body.text.includes("/r/pay/"));
    check(
      "pay page smoke: the reminder body carries no Checkout url",
      !body.html.includes("checkout.stripe.com") && !body.text.includes("checkout.stripe.com"),
    );
    check("pay page smoke: the sweep recorded its own token", (await tokens()) === 2);
    const path = new URL(payLinkFrom(body.html)).pathname;
    const open = await html(newSession(), path);
    check("pay page smoke: the mailed link opens the page with Pay", open.status === 200 && open.body.includes('data-testid="pay-form"'));

    // Task 6: the organiser's reminder is capped at five per entry per 24 h. One went out above; four more are accepted and the
    // sixth answers 429 with its own code, queueing nothing.
    let accepted = 1;
    for (let i = 0; i < 4; i++) accepted += (await v1(owner, `/api/v1/registrations/${regId}/remind`, "POST")).status === 200 ? 1 : 0;
    check(`pay page smoke: five organiser reminders are accepted (got ${accepted})`, accepted === 5);
    const mailsBefore = await db<{ n: string }[]>`
      select count(*)::text as n from email_outbox where kind = 'payment_reminder' and ref_type = 'registration' and ref_id = ${regId}`;
    const sixth = await v1(owner, `/api/v1/registrations/${regId}/remind`, "POST");
    check(`pay page smoke: the sixth reminder answers 429 (got ${sixth.status})`, sixth.status === 429);
    check(
      "pay page smoke: the sixth reminder carries PAYMENT_REMINDER_LIMIT",
      (sixth.json as { error?: { code?: string } }).error?.code === "PAYMENT_REMINDER_LIMIT",
    );
    const mailsAfter = await db<{ n: string }[]>`
      select count(*)::text as n from email_outbox where kind = 'payment_reminder' and ref_type = 'registration' and ref_id = ${regId}`;
    check("pay page smoke: the refused sixth queued no mail", mailsAfter[0].n === mailsBefore[0].n);

    // Marked paid by the organiser, then Pay: 409, and the cart's Checkout pointer is untouched.
    const paid = await v1(owner, `/api/v1/registrations/${regId}/mark-paid`, "POST");
    check("pay page smoke: the organiser marked the entry paid", paid.status === 200);
    const pointer = async () =>
      (await db<{ checkout_session_id: string | null }[]>`select checkout_session_id from registration_groups where id = ${g.id}`)[0]
        .checkout_session_id;
    const before = await pointer();
    const pay = await fetch(`${BASE}${path}/pay`, { method: "POST", redirect: "manual" });
    check(`pay page smoke: Pay on a paid entry answers 409 (got ${pay.status})`, pay.status === 409);
    check("pay page smoke: Pay on a paid entry leaves checkout_session_id unchanged", (await pointer()) === before);
    const after = await html(newSession(), path);
    check("pay page smoke: the page now reads paid, with no Pay form", after.status === 200 && !after.body.includes('data-testid="pay-form"'));
  } finally {
    await db.end();
  }
}
