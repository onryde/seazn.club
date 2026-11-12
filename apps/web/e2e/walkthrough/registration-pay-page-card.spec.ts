// Player payment page (plan 2026-11-11-player-payment-page, Task 7): the card golden path, in a browser, through a REAL Stripe
// Connect hosted checkout: a public card registration that is NOT paid -> the organiser presses "Send payment reminder" in the
// registrant panel -> the chase mail's link -> `/r/pay/<token>` (every detail asserted, the fee compared with the total Stripe's own
// page shows) -> Pay -> card on checkout.stripe.com -> back on the page -> "Paid". And the Back-from-Stripe case: a second press of
// Pay lands on the SAME Checkout session (reuse), not a second payable one.
//
// It lives in e2e/walkthrough/ and is OPT-IN, exactly as registration-connect.spec.ts is: the parallel project runs a dummy Stripe
// key that never reaches Stripe, and the walkthrough leg is the one e2e.yml hands the real key, the Connect fixture account and
// `stripe listen`. Run it locally the same way:
//   seazn-env up --label <l> --server && eval "$(seazn-env env --label <l>)"      # server needs EMAIL_OUTBOX_KEK + CRON_SECRET
//   EMAIL_OUTBOX_KEK=<same 64-hex the server runs with> CONNECT_WALKTHROUGH=1 STRIPE_CONNECT_TEST_ACCOUNT=acct_... \
//     npx playwright test e2e/walkthrough/registration-pay-page-card.spec.ts --project=walkthrough
// `stripe listen` is NOT needed for the "Paid" assertion: the page's own return reconciles the paid session (that is the point of
// it), so a missing forwarder cannot hide a defect here - nor can a present one paper over a missing reconcile (the pay-page route
// is asserted to have flipped the row before the webhook is awaited).
//
// Which mail the link comes from: the SWEEP's T-24h reminder (`POST /api/cron/registrations`). The organiser's own press is driven
// and proven (audit row, one more token) but its mail is attempted at once, and with no Resend key that ends the row `dead` with its
// body dropped, so its link cannot be read back (e2e/outbox-body-open.ts header). The sweep's row is the worker's and keeps its body.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiJson, TAG, withDb } from "../helpers";
import { fillHostedCheckout } from "../stripe-checkout-kit";
import { claimConnectAccount, centsFromRenderedAmount, releaseConnectAccount, type ConnectClaim } from "../rs007-money-kit";
import { FEE, noHorizontalScroll, sweepAndOpenLink, tokensFor, WIDTHS, seedRig, type Rig } from "../pay-page-kit";

const ENABLED = process.env.CONNECT_WALKTHROUGH === "1";
const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";
if (!ENABLED || !CONNECT_ACCOUNT) {
  const missing = [ENABLED ? null : "CONNECT_WALKTHROUGH=1", CONNECT_ACCOUNT ? null : "STRIPE_CONNECT_TEST_ACCOUNT"].filter(Boolean);
  console.warn(
    `\n  ⚠ registration-pay-page-card walkthrough SKIPPED - the real Stripe card path of the payment page was NOT exercised.` +
      `\n    missing: ${missing.join(", ")}\n`,
  );
}

const enUi = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

// The clock, spelled out: every wait below is a named constant and the test budget is derived from them, so moving one moves the
// budget (a flat literal beside a derived cost is a latent red, and a blown budget reports itself as a data defect).
const STRIPE_REDIRECT_MS = 60_000; // the Pay press -> checkout.stripe.com
const STRIPE_FORM_MS = 60_000; // fillHostedCheckout's own wait for the card field (stripe-checkout-kit)
const STRIPE_RETURN_MS = 120_000; // the card submit -> back on the page
const PAID_POLL_MS = 45_000; // "confirming" -> "Paid"
const SETUP_MS = 120_000; // org + competition + registration + panel + sweep
const budget = (...waits: number[]) => SETUP_MS + waits.reduce((a, b) => a + b, 0) + 60_000;

const compose = (c: number) => `£${(c / 100).toFixed(2)}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Card = { rig: Rig; who: string; regId: string; refCode: string; cartSessionId: string; path: string };

/** The rig with the REAL Connect account, a real public card registration that stays unpaid, the organiser's panel press, the sweep,
 *  and the link out of the sweep's mail. */
async function unpaidCardEntry(browser: Browser, claim: { current: ConnectClaim | null }): Promise<Card> {
  const rig = await seedRig(browser);
  // Real account in place BEFORE the card registration mints a Checkout (a fabricated acct id is rejected by Stripe).
  claim.current = await claimConnectAccount(rig.orgId);
  const who = `Card Payer ${TAG}`;
  const anon = (await browser.newContext()).request;
  const reg = await apiJson<{ group_id: string; checkout_url: string | null; entries: unknown[] }>(
    anon,
    `/api/v1/public/orgs/${rig.orgSlug}/competitions/${rig.compSlug}/register`,
    "POST",
    {
      contact: { name: who, email: `delivered+paycard-${randomBytes(4).toString("hex")}@resend.dev` },
      privacy_consent: true,
      entries: [{ division_id: rig.divisionId, entrant_kind: "individual", players: [{ full_name: who }] }],
    },
  );
  expect(reg.status, JSON.stringify(reg.error)).toBe(201);
  expect(reg.data!.checkout_url, "the registration minted a REAL Checkout session").toMatch(/checkout\.stripe\.com/);
  const cartSessionId = /cs_(?:test|live)_[A-Za-z0-9]+/.exec(reg.data!.checkout_url!)?.[0];
  expect(cartSessionId, "the cart's Checkout session id").toBeTruthy();
  let regId = "";
  const refCode = await withDb(async (sql) => {
    const rows = await sql<{ id: string }[]>`select id from registrations where group_id = ${reg.data!.group_id}`;
    expect(rows.length, "one entry in the cart").toBe(1);
    regId = rows[0]!.id;
    // Not paid, and due inside the sweep's T-24h window.
    await sql`update registration_groups set expires_at = now() + interval '10 hours' where id = ${reg.data!.group_id}`;
    const [g] = await sql<{ ref_code: string }[]>`select ref_code from registration_groups where id = ${reg.data!.group_id}`;
    return g!.ref_code;
  });

  // The organiser's press, in the panel (1280): one audit row, one more token. Its mail is not readable (see the header).
  await rig.owner.setViewportSize({ width: 1280, height: 900 });
  await rig.owner.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/registration?tab=registrants`, { waitUntil: "load" });
  const row = rig.owner.locator(`[data-registration-hub-registrant-row][data-registration-id="${regId}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  if (!(await row.evaluate((el) => (el as HTMLDetailsElement).open))) await row.locator("summary").click();
  const button = row.locator('[data-registration-hub-registrant-action="remind"]');
  await expect(button).toHaveText(enUi["reg.action.remind"]!);
  await button.click();
  await expect(row.locator("[data-registration-hub-registrant-actions-feedback]")).toHaveText(
    new RegExp(`^(${[enUi["reg.remind.sent"]!, enUi["reg.remind.notSent"]!].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`),
    { timeout: 20_000 },
  );
  const audit = await withDb(async (sql) =>
    Number((await sql<{ n: string }[]>`
      select count(*)::text as n from competition_events
       where type = 'registration.payment_reminded' and payload->>'registration_id' = ${regId}`)[0]!.n));
  expect(audit, "the organiser's press is on the ledger once").toBe(1);
  expect(await tokensFor(regId), "...and issued its token").toBe(1);

  const path = await sweepAndOpenLink(rig.owner, regId);
  expect(await tokensFor(regId), "the sweep's reminder issued a token of its own").toBe(2);
  return { rig, who, regId, refCode, cartSessionId: cartSessionId!, path };
}

/** The total on Stripe's hosted page, in cents - the source of truth for what the player is charged. */
async function stripeTotalCents(page: Page): Promise<number> {
  const total = page.getByTestId("product-summary-total-amount").first();
  await expect(total).toBeVisible({ timeout: STRIPE_FORM_MS });
  return centsFromRenderedAmount((await total.textContent()) ?? "");
}

const sessionIdOf = (url: string) => /cs_(?:test|live)_[A-Za-z0-9]+/.exec(url)?.[0] ?? null;

test.describe("player payment page - card", () => {
  test("card golden path: organiser reminder -> page -> Stripe -> Paid", async ({ browser }) => {
    test.skip(!ENABLED, "opt-in: set CONNECT_WALKTHROUGH=1 (needs a real sk_test)");
    test.skip(!CONNECT_ACCOUNT, "STRIPE_CONNECT_TEST_ACCOUNT is unset - a fabricated account id is rejected by Stripe");
    test.setTimeout(budget(STRIPE_REDIRECT_MS, STRIPE_FORM_MS, STRIPE_RETURN_MS, PAID_POLL_MS));
    const claim: { current: ConnectClaim | null } = { current: null };
    try {
      const c = await unpaidCardEntry(browser, claim);
      const visitor = await (await browser.newContext()).newPage();

      // The deadline is the cart's expires_at, read back from the DB (the date the page must print).
      const due = await withDb(async (sql) =>
        (await sql<{ d: Date }[]>`select g.expires_at as d from registrations r join registration_groups g on g.id = r.group_id where r.id = ${c.regId}`)[0]!.d);

      // Every detail, at every width, with no horizontal scroll; the page is public so the full bar applies.
      let checked = 0;
      for (const width of WIDTHS) {
        await visitor.setViewportSize({ width, height: 900 });
        const res = await visitor.goto(c.path);
        expect(res?.status(), `${width}: the page answers 200`).toBe(200);
        const page = visitor.getByTestId("pay-page");
        await expect(page).toBeVisible();
        await expect(visitor.getByTestId("pay-org"), `${width}: org name`).toContainText(`Pay Page Club ${TAG}`);
        await expect(page).toContainText(c.rig.compName);
        await expect(page).toContainText(c.rig.divName);
        await expect(page).toContainText(c.who);
        await expect(visitor.getByTestId("pay-total"), `${width}: the fee`).toHaveText(compose(FEE));
        await expect(page).toContainText(enUi["regPay.deadline"]!);
        const deadlineText = await page.locator("dt", { hasText: enUi["regPay.deadline"]! }).locator("xpath=following-sibling::dd[1]").innerText();
        expect(deadlineText, `${width}: the deadline names the day, month, year and zone`).toContain(String(due.getUTCDate()));
        expect(deadlineText).toContain(MONTHS[due.getUTCMonth()]!);
        expect(deadlineText).toContain(String(due.getUTCFullYear()));
        expect(deadlineText).toContain("UTC");
        await expect(page.locator("dt", { hasText: enUi["regPay.reference"]! }).locator("xpath=following-sibling::dd[1]")).toHaveText(c.refCode);
        await expect(visitor.getByTestId("pay-form"), `${width}: Pay is offered`).toBeVisible();
        await expect(visitor.getByRole("button", { name: enUi["regPay.pay"]!.replace("{amount}", compose(FEE)) })).toBeVisible();
        await noHorizontalScroll(visitor, `card page @${width}`);
        checked += 1;
      }
      expect(checked, "all three widths were checked").toBe(WIDTHS.length);

      // Pay -> Stripe. The fee on our page must equal the total Stripe itself shows.
      await visitor.setViewportSize({ width: 1280, height: 900 });
      await visitor.goto(c.path);
      await visitor.getByTestId("pay-form").getByRole("button").click();
      await visitor.waitForURL(/checkout\.stripe\.com/, { timeout: STRIPE_REDIRECT_MS });
      const stripeCents = await stripeTotalCents(visitor);
      expect(stripeCents, "the page's fee equals Stripe's hosted total (a processing fee passed on would break this)").toBe(FEE);
      const dbCents = await withDb(async (sql) => Number((await sql<{ a: number }[]>`select amount_cents as a from registrations where id = ${c.regId}`)[0]!.a));
      expect(stripeCents, "...and the entry's charged amount").toBe(dbCents);
      const paySession = sessionIdOf(visitor.url());
      expect(paySession, "the page minted its OWN session for this entry, not the cart's").not.toBe(c.cartSessionId);

      await fillHostedCheckout(visitor, c.who);
      await visitor.waitForTimeout(1000);
      await visitor.locator(".SubmitButton, button[type=submit]").first().click();
      await visitor.waitForURL(/\/r\/pay\/[A-Za-z0-9_-]+/, { timeout: STRIPE_RETURN_MS, waitUntil: "commit" });
      expect(new URL(visitor.url()).pathname, "back on the same pay page").toBe(c.path);

      // "confirming" then "Paid", or "Paid" directly (the return reconciles the paid session).
      const state = visitor.getByTestId("pay-state");
      await expect
        .poll(
          async () => {
            if (await state.count()) return (await state.getAttribute("data-state")) ?? "?";
            if (await visitor.getByTestId("pay-confirming").count()) {
              await visitor.reload();
              return "confirming";
            }
            return "none";
          },
          { timeout: PAID_POLL_MS, intervals: [1000, 2000, 3000] },
        )
        .toBe("paid");
      await expect(state).toContainText(/^Paid/);
      await expect(visitor.getByTestId("pay-form"), "Pay is gone once paid").toHaveCount(0);
      await expect(visitor.getByTestId("pay-confirming")).toHaveCount(0);
      await noHorizontalScroll(visitor, "card page paid");

      const status = await withDb(async (sql) => (await sql<{ s: string }[]>`select status as s from registrations where id = ${c.regId}`)[0]!.s);
      expect(["paid", "confirmed"], `the row is paid or confirmed (was ${status})`).toContain(status);
    } finally {
      await releaseConnectAccount(claim.current);
    }
  });

  test("Back from Stripe then Pay again lands on the same Checkout session", async ({ browser }) => {
    test.skip(!ENABLED, "opt-in: set CONNECT_WALKTHROUGH=1 (needs a real sk_test)");
    test.skip(!CONNECT_ACCOUNT, "STRIPE_CONNECT_TEST_ACCOUNT is unset - a fabricated account id is rejected by Stripe");
    test.setTimeout(budget(STRIPE_REDIRECT_MS, STRIPE_FORM_MS, STRIPE_REDIRECT_MS));
    const claim: { current: ConnectClaim | null } = { current: null };
    try {
      const c = await unpaidCardEntry(browser, claim);
      const visitor = await (await browser.newContext()).newPage();
      await visitor.setViewportSize({ width: 1280, height: 900 });
      await visitor.goto(c.path);

      await visitor.getByTestId("pay-form").getByRole("button").click();
      await visitor.waitForURL(/checkout\.stripe\.com/, { timeout: STRIPE_REDIRECT_MS });
      await stripeTotalCents(visitor); // the hosted page rendered
      const first = sessionIdOf(visitor.url());
      expect(first, "a Checkout session id in the first URL").toBeTruthy();
      expect(first, "not the cart's own session").not.toBe(c.cartSessionId);

      // Back from Stripe, the player's way: the browser's Back button, to the pay page with its Pay form.
      await visitor.goBack({ waitUntil: "commit" });
      await visitor.waitForURL((u) => u.pathname === c.path, { timeout: STRIPE_REDIRECT_MS });
      await expect(visitor.getByTestId("pay-form"), "back on the page with Pay offered").toBeVisible();
      await expect(visitor.getByTestId("pay-confirming")).toHaveCount(0);

      await visitor.getByTestId("pay-form").getByRole("button").click();
      await visitor.waitForURL(/checkout\.stripe\.com/, { timeout: STRIPE_REDIRECT_MS });
      expect(sessionIdOf(visitor.url()), "the second press reuses the first Checkout session").toBe(first);
      expect(await stripeTotalCents(visitor)).toBe(FEE);

      const pointer = await withDb(async (sql) => (await sql<{ p: string | null }[]>`select pay_session_id as p from registrations where id = ${c.regId}`)[0]!.p);
      expect(pointer, "the entry's reuse pointer is that session").toBe(first);
    } finally {
      await releaseConnectAccount(claim.current);
    }
  });
});
