// The registration money path, end to end, through a REAL Stripe Connect
// hosted checkout: organiser settings -> public TEAM entry on a PAID division
// -> card on checkout.stripe.com -> webhook -> confirmed on /r/<ref>.
//
// OPT-IN, and it has to be. The e2e workflow runs with a hardcoded dummy key
// (`sk_test_ci_e2e_dummy`) that never reaches Stripe, so this can only run
// where a real test key does — locally, or a job wired for it. It is also the
// only place `checkout.session.completed` is genuinely produced: a Checkout
// Session's `payment_intent` stays null until a browser actually visits it,
// so the headless smoke legs pay through an independent PaymentIntent and
// cannot exercise that dispatch at all.
//
// Run it:
//   seazn-env up --label <l> --server && eval "$(seazn-env env --label <l>)"
//   stripe listen --forward-to $SMOKE_BASE/api/webhooks/stripe   # in another shell
//   RS006_CONNECT_WALKTHROUGH=1 STRIPE_CONNECT_TEST_ACCOUNT=acct_... \
//     npx playwright test e2e/registration-connect-walkthrough.spec.ts --project=parallel
//
// Add WALKTHROUGH_WATCH=1 to run it headed and slowed down, with video — it
// doubles as the demo of the flow. `stripe listen` is required, not optional:
// the webhook is registrations' ONLY fulfilment path (billing has
// `reconcileCheckout` as a missed-webhook fallback; registrations have no
// equivalent), so without a forwarder the entry stays `pending` after a
// successful charge.
import { expect, test } from "@playwright/test";
import { apiJson } from "./helpers";

/** Never on by accident: absent the flag this skips visibly rather than
 *  silently passing, so a CI run that cannot reach Stripe reports a skip
 *  rather than a green that proves nothing. */
const ENABLED = process.env.RS006_CONNECT_WALKTHROUGH === "1";
const WATCH = process.env.WALKTHROUGH_WATCH === "1";

const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";

/** `organizations.stripe_account_id` is UNIQUE, so exactly one org can hold
 *  the fixture account at a time. Take it for the duration and give it back —
 *  the smoke sponsor suite crashes if it finds the account already claimed.
 *  Deliberately NOT helpers' `setOrgConnectSql`: that writes a fabricated
 *  `acct_e2e_<id>`, which Stripe rejects as a transfer destination, so the
 *  card path never actually runs. */
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

test.use({
  headless: !WATCH,
  ...(WATCH ? { launchOptions: { slowMo: 650 }, video: { mode: "on" as const, size: { width: 1280, height: 900 } } } : {}),
  // A wrong selector should fail in seconds, not ride the test timeout — the
  // first run of this sat 8 minutes on a button that never existed. Stripe's
  // own page and the post-payment redirect get explicit, longer waits.
  actionTimeout: 15_000,
  viewport: { width: 1280, height: 900 },
});

test("RS006 — organiser settings, team entry, Stripe Connect payment", async ({ page, browser, request }, testInfo) => {
  test.skip(!ENABLED, "opt-in: set RS006_CONNECT_WALKTHROUGH=1 (needs a real sk_test and `stripe listen`)");
  test.skip(!CONNECT_ACCOUNT, "STRIPE_CONNECT_TEST_ACCOUNT is unset — a fabricated account id is rejected by Stripe");
  test.setTimeout(600_000);

  // Screenshots land beside the run's other artifacts rather than a path
  // baked into the file.
  const SHOTS = testInfo.outputPath();
  let priorHolder: string | null = null;
  let claimedFor: string | null = null;

  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Winter Doubles Cup ${Date.now().toString().slice(-5)}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);

  try {
    // The Connect account must be in place BEFORE any division asks for
    // `payment_method: "stripe"` — that settings write is rejected outright
    // when the org has no connected account, leaving the division Closed/Free
    // with a blank entrant kind and no error anywhere the run can see.
    const org = (await apiJson<{ id: string; slug: string }[]>(page.request, "/api/orgs")).data![0]!;
    priorHolder = await claimConnectAccount(org.id);
    claimedFor = org.id;
    console.log(`CONNECT>>> ${CONNECT_ACCOUNT} taken from ${priorHolder ?? "nobody"} for ${org.slug}`);

    // A team division with a real fee — this is the one we pay for.
    const team = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Mixed Team Championship",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const teamSettings = await apiJson(request, `/api/v1/divisions/${team.data!.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "team",
      capacity: 16,
      fee_cents: 2500,
      // WITHOUT this the field defaults to "offline" (schemas.ts:2181) and the
      // cart never mints a checkout — submit succeeds, the entry sits at
      // "pending £25", and nothing ever redirects to Stripe.
      payment_method: "stripe",
      // NOTE: the field key is `kind`, not `type` — the schema is .strict(),
      // so `type` is rejected and the division silently stays unconfigured.
      form_fields: [{ key: "club", label: "Which club do you represent?", kind: "text", required: false }],
    });
    // Assert it, or a rejected write leaves the division silently unconfigured
    // and the failure surfaces four steps later as a missing heading.
    expect(teamSettings.status, "team registration-settings PUT").toBeLessThan(300);

    // A second open division keeps the ENTRIES step from collapsing
    // (shouldCollapseEntries, steps.ts folds it away when only one is open).
    const solo = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
      name: "Open Singles",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const soloSettings = await apiJson(request, `/api/v1/divisions/${solo.data!.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      capacity: 20,
      fee_cents: 0,
      form_fields: [],
    });
    expect(soloSettings.status, "solo registration-settings PUT").toBeLessThan(300);

    // ---- BEAT 1 — the organiser's registration hub -----------------------
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration`, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}/1-hub-settings.png`, fullPage: true });
    await page.waitForTimeout(1500);

    // ---- the public side -------------------------------------------------
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(WATCH ? { recordVideo: { dir: SHOTS } } : {}),
    });
    const anon = await ctx.newPage();

    await anon.goto(`/shared/${org.slug}/${comp.data!.slug}/register`, { waitUntil: "load" });
    await expect(anon.locator("#reg-who-name")).toBeVisible({ timeout: 20_000 });

    // ---- BEAT 2 — WHO ----------------------------------------------------
    await anon.locator("#reg-who-name").fill("Priya Raman");
    await anon.locator("#reg-who-email").fill(`priya-${Date.now()}@example.com`);
    await anon.getByRole("checkbox").first().check(); // "I'm playing"
    await expect(anon.locator("#reg-who-dob")).toBeVisible();
    await anon.locator("#reg-who-dob").fill("1994-03-22");
    await anon.screenshot({ path: `${SHOTS}/2-who.png`, fullPage: true });
    await anon.waitForTimeout(1200);
    await anon.getByRole("button", { name: "Next", exact: true }).click();

    // ---- BEAT 3 — ENTRIES: pick the paid TEAM division -------------------
    await expect(anon.getByRole("heading", { name: "Choose your divisions", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // A team division's control is "Add a team" — NOT "Add an entry", which is
    // the individual-kind label (register.entries.add.team vs .individual).
    await anon.getByRole("button", { name: "Add a team", exact: true }).first().click();
    await anon.waitForTimeout(900);

    // The team's name is captured in the CART on this step, not on the roster
    // step — it is a placeholder, so there is no label to match on.
    const teamName = anon.getByPlaceholder("Team name").first();
    await expect(teamName).toBeVisible();
    await teamName.fill("Riverside Racquets");
    await anon.waitForTimeout(700);
    await anon.screenshot({ path: `${SHOTS}/3-entries-team-added.png`, fullPage: true });
    await anon.waitForTimeout(1200);
    await anon.getByRole("button", { name: "Next", exact: true }).click();

    // ---- BEAT 4 — DETAILS: name the team, build the roster ---------------
    await expect(anon.getByRole("heading", { name: "Player details", exact: true })).toBeVisible({ timeout: 20_000 });

    // A team roster starts EMPTY (blankPlayers: individual=1, pair=2, team=0)
    // and grows one row at a time. Each row's name input is reachable by its
    // aria-label, "Player <n> — Your name" (roster-table.tsx).
    const roster = ["Priya Raman", "Arun Menon", "Sofia Alves"];
    for (let i = 0; i < roster.length; i++) {
      await anon.getByRole("button", { name: "+ Add player", exact: true }).first().click();
      await anon.waitForTimeout(450);
      await anon
        .getByRole("textbox", { name: new RegExp(`Player ${i + 1}\\b`) })
        .first()
        .fill(roster[i]!);
      await anon.waitForTimeout(350);
    }
    // "I'm playing" at step 1 self-links the entry, and a self-linked TEAM
    // entry needs an EXPLICIT self_player_index — leaving this select on
    // "None of these" blocks Next with a step-wide "fill in the missing
    // details above" that marks no field (validateDetails returns one flat
    // `error` for the whole step, so nothing can point at this control).
    await anon
      .getByRole("combobox", { name: "Which player are you?" })
      .selectOption({ label: "Priya Raman" });
    await anon.waitForTimeout(600);

    await anon.screenshot({ path: `${SHOTS}/4-details-roster.png`, fullPage: true });
    await anon.waitForTimeout(1500);
    await anon.getByRole("button", { name: "Next", exact: true }).click();

    // ---- BEAT 5 — CONSENT ------------------------------------------------
    await anon.waitForTimeout(900);
    const privacy = anon.locator("#reg-consent-privacy");
    if (await privacy.count()) await privacy.check();
    await anon.screenshot({ path: `${SHOTS}/5-consent.png`, fullPage: true });
    await anon.waitForTimeout(1200);
    await anon.getByRole("button", { name: "Next", exact: true }).click();

    // ---- BEAT 6 — REVIEW: the subtotal is real money now -----------------
    await anon.waitForTimeout(1200);
    await anon.screenshot({ path: `${SHOTS}/6-review-with-fee.png`, fullPage: true });
    await anon.waitForTimeout(2000);

    // A paid, card-enabled cart labels the submit "Continue to payment — £25.00"
    // (register.submit.card). The free label is "Enter the competition"; the
    // pay-later label is "Enter — {fee}". Match all three.
    await anon
      .getByRole("button", { name: /Continue to payment|Enter the competition|Enter —/ })
      .first()
      .click();

    // ---- BEAT 7 — Stripe Connect hosted checkout -------------------------
    await anon.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    await anon.waitForTimeout(3000);
    await anon.screenshot({ path: `${SHOTS}/7-stripe-checkout.png`, fullPage: true });

    await anon.locator("#cardNumber").fill("4242424242424242");
    await anon.locator("#cardExpiry").fill("12/34");
    await anon.locator("#cardCvc").fill("123");
    const holder = anon.locator("#billingName");
    if (await holder.count()) await holder.fill("Priya Raman");
    const postal = anon.locator("#billingPostalCode");
    if (await postal.count()) await postal.fill("SW1A 1AA");
    await anon.waitForTimeout(1200);
    await anon.screenshot({ path: `${SHOTS}/8-card-filled.png`, fullPage: true });
    await anon.waitForTimeout(1000);

    await anon.locator(".SubmitButton, button[type=submit]").first().click();

    // ---- BEAT 8 — back on /r/<ref>, paid --------------------------------
    // NOT `/r/<ref>`: `createRegistrationCheckout`'s `returnBase` takes the
    // TOKEN branch whenever a token exists — which a cart submit always has —
    // so checkout returns to the group STATUS page. (`/r/<ref>` is the
    // token-less, from-an-email route.) `waitUntil: "commit"` because the
    // default "load" does not fire reliably on the hop back from Stripe.
    await anon.waitForURL(/\/register\/status\?/, { timeout: 120_000, waitUntil: "commit" });
    await expect(anon.getByText("confirmed")).toBeVisible({ timeout: 60_000 });
    await anon.waitForTimeout(4000);
    await anon.screenshot({ path: `${SHOTS}/9-paid-confirmation.png`, fullPage: true });
    await anon.waitForTimeout(2500);

    // ---- BEAT 9 — the organiser sees the paid registrant -----------------
    await page.goto(`/o/${org.slug}/c/${comp.data!.slug}/registration`, { waitUntil: "load" });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SHOTS}/10-hub-registrant.png`, fullPage: true });
    await page.waitForTimeout(2000);

    await ctx.close();
  } finally {
    await apiJson(request, `/api/v1/competitions/${comp.data!.id}`, "DELETE");
    if (claimedFor) await releaseConnectAccount(claimedFor, priorHolder);
  }
});
