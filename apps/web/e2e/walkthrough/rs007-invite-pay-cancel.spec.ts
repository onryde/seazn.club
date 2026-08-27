// A witness spec for TWO CONFIRMED RS007 defects, both on the status page's
// money surface. It is meant to FAIL — see "THE TWO DEFECTS" below.
//
// The journey: an organiser opens a PAID team division at capacity ONE, a
// public captain enters TWO team entries in one cart (so the second is
// waitlisted at submit — registration-submit.ts's own capacity contention,
// "two entries in one cart for the same division correctly contend for the
// same slots"), pays once for the cart's real subtotal (one entry's fee) via
// real Stripe Connect hosted checkout, a team-mate claims their spot off the
// status page's own claim link, the organiser PROMOTES the waitlisted sibling
// (still real production code — POST /api/v1/registrations/{id}/promote, the
// same route the hub's own "Promote" action calls), and the captain cancels
// that promoted-but-never-paid sibling through the status page's own Cancel
// control.
//
// WHY PROMOTE, RATHER THAN JUST CANCELLING THE PAID ENTRY DIRECTLY. Cancelling
// an entry that was genuinely part of the cart's one shared charge is NOT a
// defect — refunding its own portion out of that shared PaymentIntent is
// correct, dollar-accurate accounting. The real bug needs a sibling that was
// NEVER part of any charge at all: promoting a waitlisted entry sets its
// `amount_cents` to the division's real fee (promoteWaitlistedRow) while the
// cart's `payment_intent_id` still only ever points at whichever OTHER entry
// actually paid. That is exactly the "genuinely-uncharged sibling (the
// promotion path)" the dispatch names as the stronger case to aim for, so
// this spec drives it via the organiser's own promote action rather than
// settling for the weaker fallback.
//
// THE TWO DEFECTS this spec was written to witness:
//
//  (a) FIXED while this spec was being written, in `54b88fb9f`. The subtotal
//      filtered only `status !== "waitlisted"`, so a WITHDRAWN entry kept
//      contributing its full fee forever — on the very page that offers the
//      Cancel button. Now excluded via the shared `entryCountsTowardTotal`
//      predicate in `status/view-model.ts`, which the per-entry fee line uses
//      too, so the two cannot drift apart.
//      The assertion below is NOT obsolete: it asserts the CORRECT behaviour
//      (cancelling one of two £25 entries drops the footer to £25), so it is
//      now a regression guard rather than a reproduction. Its failure message
//      still describes the original defect, which is what a regression would
//      look like.
//
//  (b) registrations.ts's buildGroupStatusView (~line 3341) feeds the CART's
//      single `group.payment_intent_id` into resolveRefundPolicy for EVERY
//      entry in the cart, with no check that THIS entry was the one actually
//      covered by it. A promoted-but-unpaid entry inherits a nonzero
//      "refundable: true" from whichever sibling entry funded the group's one
//      PaymentIntent. The cancel dialog then promises a refund the entry
//      never earned, and confirming it makes withdrawCore (~line 3632) call a
//      REAL stripeRefund against that PaymentIntent — pulling money out of
//      the SIBLING's actual charge for an entry that paid nothing.
//
// Setup (organiser auth, division/competition creation, the promote call)
// goes through the API — the walkthrough charter's own "setup may use the API
// to REACH a state" allowance. Every step that IS the journey — typing,
// adding entries, paying, following the claim link, cancelling — is done
// through the real UI, against real Stripe.
//
// OPT-IN, same reason registration-connect.spec.ts is: the e2e workflow's
// hardcoded dummy Stripe key never reaches Stripe, so this can only run where
// a real test key does.
//
// Run it:
//   stripe listen --forward-to $BASE/api/webhooks/stripe   # in another shell
//   CONNECT_WALKTHROUGH=1 STRIPE_CONNECT_TEST_ACCOUNT=acct_... \
//     npx playwright test e2e/walkthrough/rs007-invite-pay-cancel.spec.ts --project=walkthrough
import { expect, test } from "@playwright/test";
import { apiJson, activeOrg, TAG } from "../helpers";

const ENABLED = process.env.CONNECT_WALKTHROUGH === "1";
const WATCH = process.env.WALKTHROUGH_WATCH === "1";
const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";

// Loud skip at collection time — Playwright's own summary prints "1 skipped"
// with no reason, and a CI leg that silently skips its only real-money
// witness looks exactly like one that ran it (registration-connect.spec.ts's
// own convention, copied verbatim).
if (!ENABLED || !CONNECT_ACCOUNT) {
  const missing = [
    ENABLED ? null : "CONNECT_WALKTHROUGH=1",
    CONNECT_ACCOUNT ? null : "STRIPE_CONNECT_TEST_ACCOUNT",
  ].filter(Boolean);
  console.warn(
    `\n  ⚠ rs007-invite-pay-cancel walkthrough SKIPPED — the two RS007 money defects were NOT exercised.` +
      `\n    missing: ${missing.join(", ")}` +
      `\n    This is the only spec that drives a promoted-but-unpaid sibling through real Stripe; a run that skips it proves nothing about either defect.\n`,
  );
}

/** `organizations.stripe_account_id` is UNIQUE — take the fixture account for
 *  the duration and give it back. Copied verbatim from registration-connect.spec.ts:
 *  deliberately NOT helpers' `setOrgConnectSql`, which writes a fabricated
 *  `acct_e2e_<id>` that Stripe rejects as a transfer destination. */
async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { connection: { search_path: "seazn_club" }, ssl: false });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function claimConnectAccount(orgId: string): Promise<string | null> {
  return withDb(async (sql) => {
    const prior = await sql`
      select id from organizations where stripe_account_id = ${CONNECT_ACCOUNT}`;
    const priorId = (prior[0]?.id as string | undefined) ?? null;
    if (priorId) {
      await sql`
        update organizations
        set stripe_account_id = null, stripe_charges_enabled = false
        where id = ${priorId}`;
    }
    await sql`
      update organizations
      set stripe_account_id = ${CONNECT_ACCOUNT}, stripe_charges_enabled = true
      where id = ${orgId}`;
    return priorId;
  });
}

async function releaseConnectAccount(orgId: string, priorId: string | null): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      update organizations
      set stripe_account_id = null, stripe_charges_enabled = false
      where id = ${orgId}`;
    if (priorId) {
      await sql`
        update organizations
        set stripe_account_id = ${CONNECT_ACCOUNT}, stripe_charges_enabled = true
        where id = ${priorId}`;
    }
    const back = await sql`
      select id from organizations where stripe_account_id = ${CONNECT_ACCOUNT}`;
    console.log(`RESTORE>>> fixture now held by ${(back[0]?.id as string) ?? "NOBODY"} (expected ${priorId})`);
  });
}

/** A rendered "£25.00"/"$25.00" -> 2500. Currency- and locale-format
 *  agnostic on purpose: GBP/USD/EUR all render exactly two minor-unit
 *  digits, so stripping every non-digit character from the matched amount
 *  IS the cents value — no need to know the org's currency to assert on it. */
function centsFromRenderedAmount(text: string): number {
  const match = text.match(/\d[\d.,]*\d|\d/);
  if (!match) throw new Error(`no monetary amount found in "${text}"`);
  return Number(match[0].replace(/[^\d]/g, ""));
}

interface PublicRegSnapshot {
  id: string;
  status: string;
  amount_cents: number;
  refunded_cents: number;
}

/** GET /api/v1/public/registrations/{id}?token= — publicRegistrationStatus's
 *  wire shape (registrations.ts). The read-back the dispatch requires: "the
 *  system's own record", not the rendered pixels. */
async function publicRegSnapshot(
  request: import("@playwright/test").APIRequestContext,
  regId: string,
  token: string,
): Promise<PublicRegSnapshot> {
  const res = await apiJson<PublicRegSnapshot>(
    request,
    `/api/v1/public/registrations/${regId}?token=${encodeURIComponent(token)}`,
    "GET",
  );
  if (res.status !== 200 || !res.data) {
    throw new Error(`publicRegSnapshot(${regId}): GET -> ${res.status}`);
  }
  return res.data;
}

test.use({
  headless: !WATCH,
  ...(WATCH ? { launchOptions: { slowMo: 650 }, video: { mode: "on" as const, size: { width: 1280, height: 900 } } } : {}),
  actionTimeout: 15_000,
  viewport: { width: 1280, height: 900 },
});

test("RS007 witness — cancelling one of two cart entries: the subtotal keeps the withdrawn fee, and a promoted-but-unpaid sibling's cancel dialog offers to refund a stranger's card", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.skip(!ENABLED, "opt-in: set CONNECT_WALKTHROUGH=1 (needs a real sk_test and `stripe listen`)");
  test.skip(!CONNECT_ACCOUNT, "STRIPE_CONNECT_TEST_ACCOUNT is unset — a fabricated account id is rejected by Stripe");
  test.setTimeout(600_000);

  const SHOTS = testInfo.outputPath();
  let priorHolder: string | null = null;
  let claimedFor: string | null = null;

  const CAPTAIN_NAME = `Test Captain ${TAG}`;
  const CAPTAIN_EMAIL = `captain-${TAG}@example.com`;
  // A survives (first added -> gets the ONE capacity slot -> pays).
  // B is waitlisted at submit (second added -> capacity already taken),
  // then promoted by the organiser WITHOUT ever paying -> the uncharged
  // sibling defect (b) needs.
  const TEAM_A = `Harbourside Hawks ${TAG}`;
  const TEAM_B = `Meridian Wanderers ${TAG}`;
  const MATES_A = [`Priti Shah ${TAG}`, `Owen Clarke ${TAG}`];
  const MATES_B = [`Dana Fox ${TAG}`, `Leo Park ${TAG}`];
  const FEE_CENTS = 2500;

  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(`[organiser] ${String(e).slice(0, 200)}`));

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Cross-Entry Cup ${TAG}`,
    visibility: "public",
    // A future starts_on gives resolveRefundPolicy's fallback deadline
    // (registrations.ts) something real to compute against — without it (and
    // no explicit refund_lock_at) the policy is fail-CLOSED, and defect (b)'s
    // wrongly-promised refund could never surface at all.
    starts_on: "2030-11-01",
    ends_on: "2030-12-31",
  });
  expect(comp.status, "could not create the competition this witness needs").toBeLessThan(300);

  try {
    const org = await activeOrg(page);
    priorHolder = await claimConnectAccount(org.id);
    claimedFor = org.id;
    console.log(`CONNECT>>> ${CONNECT_ACCOUNT} taken from ${priorHolder ?? "nobody"} for ${org.slug}`);

    // ---- SETUP: one PAID team division at capacity ONE --------------------
    // "Through the hub UI where practical" — practical here means the same
    // thing registration-connect.spec.ts already established: there is no
    // click-through competition/division CREATION flow to drive (it is a
    // server-authored resource), so setup goes through the API and the hub UI
    // is visited for the organiser's own view of it (BEAT 1 below), matching
    // that spec's own precedent.
    const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Championship Teams",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    expect(div.status).toBeLessThan(300);

    const settings = await apiJson(request, `/api/v1/divisions/${div.data!.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "team",
      // Capacity ONE is the whole mechanism: two team entries submitted in
      // ONE cart correctly contend for the same slot (registration-submit.ts,
      // counted inside the row lock, seeing the cart's own earlier insert) —
      // the first-added entry pays, the second waitlists with NO fee at all
      // (feeCents = waitlisted ? 0 : live.fee_cents), so it cannot read
      // refundable:true until something later gives it a real amount_cents.
      capacity: 1,
      fee_cents: FEE_CENTS,
      payment_method: "stripe",
      form_fields: [],
    });
    expect(settings.status, "team registration-settings PUT").toBeLessThan(300);

    // ---- BEAT 01 — the organiser's hub, before anyone has entered ---------
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/01-hub-settings.png`, fullPage: true });

    // ---- the public side ----------------------------------------------
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(WATCH ? { recordVideo: { dir: SHOTS } } : {}),
    });
    const anon = await ctx.newPage();
    anon.on("pageerror", (e) => pageErrors.push(`[captain] ${String(e).slice(0, 200)}`));
    anon.on("response", (res) => {
      if (res.url().includes("/api/") && res.status() >= 400) {
        badResponses.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
      }
    });

    await anon.goto(`/shared/${org.slug}/${comp.data!.slug}/register`, { waitUntil: "load" });
    await anon.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});
    await expect(anon.locator("#reg-who-name")).toBeVisible({ timeout: 20_000 });

    // ---- STEP 1/BEAT 02 — WHO. Deliberately no self-link: neither entry
    // needs the captain ON its own roster for this witness, and skipping "I'm
    // playing" avoids the self-row-picker entirely (registering_self defaults
    // false, and autoLinkObviousSelf only ever auto-links when the cart holds
    // exactly ONE entry — cart.ts). Both rosters stay pure captain_entered.
    await anon.locator("#reg-who-name").fill(CAPTAIN_NAME);
    await anon.locator("#reg-who-email").fill(CAPTAIN_EMAIL);
    await anon.screenshot({ path: `${SHOTS}/02-who.png`, fullPage: true });
    await anon.getByRole("button", { name: /^next$/i }).click();

    // ---- STEP 2/BEATS 03-04 — ENTRIES: two team entries, ONE division -----
    await expect(anon.getByRole("heading", { name: "Choose your divisions", exact: true })).toBeVisible({
      timeout: 20_000,
    });

    await anon.getByRole("button", { name: "Add a team", exact: true }).first().click();
    await anon.waitForTimeout(500);
    // Filled immediately, before the second "Add a team" click exists — at
    // this instant there is exactly one "Team name" input in the DOM, so
    // `.first()` is unambiguous (entry-cart.tsx renders one per cart line).
    await anon.getByPlaceholder("Team name").first().fill(TEAM_A);
    await anon.waitForTimeout(500);
    await anon.screenshot({ path: `${SHOTS}/03-entries-first-team.png`, fullPage: true });

    await anon.getByRole("button", { name: "Add a team", exact: true }).first().click();
    await anon.waitForTimeout(500);
    // Now two inputs exist; `.last()` is the one just added.
    await anon.getByPlaceholder("Team name").last().fill(TEAM_B);
    await anon.waitForTimeout(700);
    // NOTE: the cart panel shows BOTH fees as payable here (subtotal £50, no
    // "not charged now" note on either line) — confirmed live, not assumed.
    // summarizeCart (cart.ts) predicts waitlisting from `division.closed_reason
    // === "full"`, and `division` is the STATIC page-load snapshot
    // (taken=0/capacity=1, still "open"), never re-derived against the cart's
    // own contents. So the CLIENT is optimistic about a low-capacity division
    // holding two of its own entries — a real UX quirk, but a DIFFERENT one
    // from the two this spec exists to witness, so not asserted on here. The
    // SERVER'S submit-time count is what actually governs (registration-
    // submit.ts, verified by direct read: "counting happens INSIDE the lock,
    // after every earlier entry in THIS SAME cart is already inserted"), and
    // that is what the rest of this journey depends on and verifies below —
    // Stripe checkout charges only entry A's fee, and B posts as waitlisted.
    await anon.screenshot({ path: `${SHOTS}/04-entries-both-teams.png`, fullPage: true });
    await anon.getByRole("button", { name: /^next$/i }).click();

    // ---- STEP 3/BEAT 05 — DETAILS: a roster per entry, captain_entered ----
    // Both cards render the SAME division heading text (one division, two
    // entries) — there is no team-name label at this step (entry-details.tsx
    // shows only the division name), so cards are scoped by DOM position via
    // each card's own "+ Add player" button, in cart/insertion order (A, then
    // B — StepDetails maps cart.entries in that exact order).
    await expect(anon.getByRole("heading", { name: "Player details", exact: true })).toBeVisible({ timeout: 20_000 });
    const addPlayerButtons = anon.getByRole("button", { name: /\+ add player/i });
    await expect(addPlayerButtons).toHaveCount(2);
    const cardFor = (index: number) =>
      addPlayerButtons.nth(index).locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]");

    const rosterPlan: { index: number; mates: string[] }[] = [
      { index: 0, mates: MATES_A },
      { index: 1, mates: MATES_B },
    ];
    for (const { index, mates } of rosterPlan) {
      const card = cardFor(index);
      for (const name of mates) {
        await card.getByRole("button", { name: /\+ add player/i }).click();
        await anon.waitForTimeout(300);
        const boxes = card.getByLabel(/Player \d+ — Your name/);
        await boxes.nth((await boxes.count()) - 1).fill(name);
        await anon.waitForTimeout(200);
      }
    }
    await anon.screenshot({ path: `${SHOTS}/05-details-both-rosters.png`, fullPage: true });
    await anon.getByRole("button", { name: /^next$/i }).click();

    // ---- STEP 4/BEAT 06 — CONSENT ------------------------------------------
    await anon.waitForTimeout(600);
    await anon.locator("#reg-consent-privacy").check();
    await anon.screenshot({ path: `${SHOTS}/06-consent.png`, fullPage: true });
    await anon.getByRole("button", { name: /^next$/i }).click();

    // ---- STEP 5/BEAT 07 — REVIEW. step-review.tsx shares summarizeCart with
    // the cart panel (same doc comment as above), so this ALSO shows the
    // optimistic £50 pre-submit — the button below is clicked for whatever
    // it says, not a hardcoded amount. What actually reaches Stripe is the
    // SERVER's own submit-time computation, checked at BEAT 08 (the real
    // checkout page) and BEAT 10 (the real post-payment entry statuses).
    await anon.waitForTimeout(1000);
    await anon.screenshot({ path: `${SHOTS}/07-review-both-fees-optimistic.png`, fullPage: true });
    await anon
      .getByRole("button", { name: /Continue to payment|Enter the competition|Enter —/ })
      .first()
      .click();

    // ---- STEP 5 (cont.)/BEATS 08-09 — real Stripe Connect hosted checkout,
    // interaction copied verbatim from registration-connect.spec.ts --------
    await anon.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    await anon.waitForTimeout(2000);
    await anon.screenshot({ path: `${SHOTS}/08-stripe-checkout.png`, fullPage: true });

    await anon.locator("#cardNumber").fill("4242424242424242");
    await anon.locator("#cardExpiry").fill("12/34");
    await anon.locator("#cardCvc").fill("123");
    const holder = anon.locator("#billingName");
    if (await holder.count()) await holder.fill(CAPTAIN_NAME);
    const postal = anon.locator("#billingPostalCode");
    if (await postal.count()) await postal.fill("SW1A 1AA");
    await anon.waitForTimeout(1000);
    await anon.screenshot({ path: `${SHOTS}/09-card-filled.png`, fullPage: true });
    await anon.locator(".SubmitButton, button[type=submit]").first().click();

    // ---- back on /register/status?..., BEAT 10 -----------------------
    await anon.waitForURL(/\/register\/status\?/, { timeout: 120_000, waitUntil: "commit" });
    await anon.waitForTimeout(2500);
    const statusUrl = anon.url();
    const token = (() => {
      const u = new URL(statusUrl);
      const t = u.searchParams.get("token");
      if (!u.searchParams.get("rid") || !t) throw new Error("status page URL carries no rid/token");
      return t;
    })();

    const teamACard = anon.locator("li", { hasText: TEAM_A });
    const teamBCard = anon.locator("li", { hasText: TEAM_B });
    // EXACT match, not a substring `.first()` — status-page.test.tsx's own
    // trap (see registration-connect.spec.ts's comment on the identical
    // check): the roster meter reads "N of M confirmed" and a claimed
    // player's chip reads "Confirmed", both of which a loose /confirmed/i
    // would also match. Neither is EXACTLY "confirmed" or "paid", so exact
    // text disambiguates without depending on DOM order.
    const aStatusBadge = teamACard.getByText("confirmed", { exact: true }).or(teamACard.getByText("paid", { exact: true }));
    await expect(aStatusBadge).toBeVisible({ timeout: 20_000 });
    await expect(teamACard.getByRole("button", { name: /pay now/i })).toHaveCount(0);
    await expect(teamBCard.getByText("waitlisted", { exact: true })).toBeVisible();
    await anon.screenshot({ path: `${SHOTS}/10-status-paid-and-waitlisted.png`, fullPage: true });

    // ---- STEP 4/BEATS 11-12 — the claim link, FOLLOWED (rs007-registration-
    // journey.spec.ts's idiom): read the anchor the page emits, click it,
    // never construct the URL. Scoped to entry A, the surviving one.
    const claim = teamACard.locator('a[href*="/register/join"]').first();
    await expect(claim, "team A's card emits no claim link").toBeVisible();
    const href = await claim.getAttribute("href");
    expect(href, "the claim link carries no join_code").toContain("join_code=");
    const [claimResponse] = await Promise.all([
      anon.waitForResponse((r) => r.url().includes("/register/join") && r.request().isNavigationRequest()),
      claim.click(),
    ]);
    expect(claimResponse.status(), `claim link resolved to ${claimResponse.status()}`).toBeLessThan(400);
    await expect(anon.getByText(MATES_A[0]!).first()).toBeVisible();
    await anon.screenshot({ path: `${SHOTS}/11-claim-join-form.png`, fullPage: true });

    await anon.getByRole("radio", { name: MATES_A[0]! }).check();
    await anon.locator("#reg-who-name").fill(MATES_A[0]!);
    await anon.locator("#reg-who-email").fill(`mate-${TAG}@example.com`);
    await anon.locator("#reg-consent-privacy").check();
    await anon.getByRole("button", { name: /confirm my spot/i }).click();
    await expect(
      anon.getByText(/you're in|confirmed|spot confirmed/i).first(),
      "the join form submitted but nothing confirmed the claim",
    ).toBeVisible({ timeout: 20_000 });
    await anon.screenshot({ path: `${SHOTS}/12-claimed.png`, fullPage: true });

    // Back to the status page for the cancel beat.
    await anon.goto(statusUrl, { waitUntil: "load" });
    await anon.waitForTimeout(1000);

    // ---- SETUP FOR THE STRONGER WITNESS: promote B without ever paying,
    // TAPPED through the organiser's own hub — the real "Promote from
    // waitlist" control (registration-hub-registrant-actions.tsx), not the
    // API directly. It calls the identical POST route, but clicking it is
    // what a real organiser does, and reaching this state is still setup
    // (the charter's own allowance) rather than the thing under test — the
    // cancel + its consequences, next. B is left `pending` afterward, never
    // paid: promoteWaitlistedRow sets its real amount_cents but the group's
    // payment_intent_id still only ever names entry A's charge.
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration?tab=registrants`, { waitUntil: "load" });
    await page.waitForTimeout(1000);
    // Each row IS a native <details data-registration-id="..."> — reading the
    // id off the rendered row rather than a separate list call. Scoped to
    // each row's own <summary> text, NOT the whole <details> (a plain
    // `hasText` on the details element is a trap here: A and B share one
    // cart, so each row's DETAIL body unconditionally renders the OTHER as
    // a "cart sibling" — `hasText: TEAM_A` against the whole element would
    // match both rows, since B's own detail panel mentions A's name too).
    const rowB = page
      .locator("details[data-registration-hub-registrant-row]")
      .filter({ has: page.locator("summary", { hasText: TEAM_B }) });
    const rowA = page
      .locator("details[data-registration-hub-registrant-row]")
      .filter({ has: page.locator("summary", { hasText: TEAM_A }) });
    await expect(rowB).toBeVisible({ timeout: 15_000 });
    // The row's summary renders TWO copies of its status pill unconditionally
    // (a phone card, `sm:hidden`, and a desktop grid, `hidden sm:grid`) — a
    // bare .first()/getByText resolves to the hidden card block at this
    // desktop viewport and times out on a pill that is genuinely there.
    // `:visible` self-selects whichever copy CSS actually shows.
    await expect(rowB.locator('[data-registration-hub-registrant-status="waitlisted"]:visible')).toBeVisible({
      timeout: 15_000,
    });
    const entryBId = await rowB.getAttribute("data-registration-id");
    const entryAId = await rowA.getAttribute("data-registration-id");
    if (!entryBId || !entryAId) throw new Error("registrant row carries no data-registration-id");
    const entryA = { id: entryAId };
    const entryB = { id: entryBId };

    // Expand B's row (native <details>/<summary> — click opens it) and tap
    // its real Promote control.
    await rowB.locator("summary").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/13a-hub-before-promote.png`, fullPage: true });
    await rowB.getByRole("button", { name: "Promote from waitlist", exact: true }).click();
    // The success feedback and the button itself live in the DETAIL body
    // (RegistrationHubRegistrantDetail), which is NOT duplicated the way the
    // summary scan line is — a plain text match is safe here.
    await expect(rowB.getByText("Promoted", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await expect(rowB.locator('[data-registration-hub-registrant-status="pending"]:visible')).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: `${SHOTS}/13b-hub-after-promote.png`, fullPage: true });

    // The captain's own snapshot BEFORE cancelling anything — the ledger
    // baseline defect (b)'s "surviving entry unaffected" check compares
    // against. This read-back (not an action) is the one place the public
    // API stands in for "the system's own record", per the dispatch.
    const aBefore = await publicRegSnapshot(request, entryA.id, token);
    const bBefore = await publicRegSnapshot(request, entryB.id, token);
    expect(aBefore.status, "A should be paid/confirmed before the cancel").toMatch(/paid|confirmed/);
    expect(bBefore.status, "B should be pending after promotion, still unpaid").toBe("pending");
    expect(bBefore.amount_cents, "promotion should have set B's real fee").toBe(FEE_CENTS);
    expect(bBefore.refunded_cents, "B has never been charged, so nothing can be refunded from it yet").toBe(0);

    await anon.reload({ waitUntil: "load" });
    await anon.waitForTimeout(1200);
    await expect(teamBCard.getByRole("button", { name: /pay now/i })).toBeVisible({ timeout: 15_000 });
    await anon.screenshot({ path: `${SHOTS}/13-status-after-promote.png`, fullPage: true });

    // ---- STEP 5 — cancel B (the promoted, never-charged entry) through the
    // status page's own Cancel control ---------------------------------
    await teamBCard.getByRole("button", { name: "Cancel this entry", exact: true }).click();
    const dialog = anon.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const dialogText = (await dialog.textContent()) ?? "";
    // BEFORE the confirmation — required shot.
    await anon.screenshot({ path: `${SHOTS}/14-before-cancel-confirm-dialog.png` });

    // ---- ASSERTION (b): the dialog must not promise a refund for an entry
    // that was never charged. B's own actual charge is £0 — resolveRefundPolicy
    // (registrations.ts) instead reads TRUE off the CART's shared
    // payment_intent_id, which only ever names entry A's real PaymentIntent. ----
    expect(
      dialogText,
      `DEFECT (b) witness: entry "${TEAM_B}" was promoted from the waitlist and has NEVER been charged a cent ` +
        `(own charge: £0.00), yet the cancel dialog reads "${dialogText.trim()}" — a refund promise sourced from ` +
        `the group's shared payment_intent_id, which actually belongs to sibling entry "${TEAM_A}"'s real charge. ` +
        `Confirming this issues a REAL stripeRefund against A's PaymentIntent for money B never paid.`,
    ).not.toMatch(/refunded automatically/);

    // Confirm anyway — the dispatch wants the real consequences observed.
    await dialog.getByRole("button", { name: "Cancel entry", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(teamBCard.getByText("withdrawn", { exact: true })).toBeVisible({ timeout: 20_000 });
    await anon.waitForTimeout(1000);
    // AFTER the confirmation — required shot.
    await anon.screenshot({ path: `${SHOTS}/15-after-cancel.png`, fullPage: true });

    // ---- ASSERTION (a): the rendered subtotal must drop to what is still
    // owed/paid (A alone) — status/page.tsx's subtotal only excludes
    // "waitlisted", never "withdrawn". ----------------------------------
    const subtotalLabel = anon.getByText("Subtotal", { exact: true });
    const subtotalAmountText = (await subtotalLabel.locator("xpath=following-sibling::span[1]").textContent()) ?? "";
    const renderedSubtotalCents = centsFromRenderedAmount(subtotalAmountText);
    expect(
      renderedSubtotalCents,
      `DEFECT (a) witness: after withdrawing "${TEAM_B}" (£${(FEE_CENTS / 100).toFixed(2)}), the footer should read ` +
        `£${(aBefore.amount_cents / 100).toFixed(2)} (A alone, still paid) but rendered "${subtotalAmountText.trim()}" ` +
        `— status/page.tsx's subtotal filter excludes only "waitlisted", never "withdrawn", so B's fee keeps counting.`,
    ).toBe(aBefore.amount_cents);

    // B's card must also have lost its Cancel control (canCancelEntry is
    // false for withdrawn) — a re-cancel dead end would be its own defect.
    await expect(teamBCard.getByRole("button", { name: "Cancel this entry" })).toHaveCount(0);

    // ---- Ledger check: the SURVIVING entry (A) must be untouched. The
    // weaker property the dispatch allows as a floor even where the stronger
    // per-charge mismatch isn't independently queryable from this API
    // (Stripe's own ledger is the only place that would show A's PaymentIntent
    // actually lost money to B's phantom refund — out of scope for this
    // spec's assertions, but the real-money consequence is exactly why this
    // is exercised against live Stripe rather than mocked). ----------------
    const aAfter = await publicRegSnapshot(request, entryA.id, token);
    const bAfter = await publicRegSnapshot(request, entryB.id, token);
    expect(aAfter.status, "surviving entry A's status must not change").toBe(aBefore.status);
    expect(aAfter.amount_cents, "surviving entry A's amount must not change").toBe(aBefore.amount_cents);
    expect(aAfter.refunded_cents, "entry A's OWN row must show no refund — the money left Stripe, not this row").toBe(
      aBefore.refunded_cents,
    );
    expect(bAfter.status, "the cancelled entry itself should read withdrawn").toBe("withdrawn");

    // ---- BEAT 16 — the organiser's own final view --------------------
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/16-organiser-hub-final.png`, fullPage: true });

    expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toEqual([]);
    expect(badResponses, `unexpected HTTP >= 400 responses: ${badResponses.join(" | ")}`).toEqual([]);

    await ctx.close();
  } finally {
    await apiJson(request, `/api/v1/competitions/${comp.data!.id}`, "DELETE");
    if (claimedFor) await releaseConnectAccount(claimedFor, priorHolder);
  }
});
