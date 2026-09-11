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
//   CONNECT_WALKTHROUGH=1 STRIPE_CONNECT_TEST_ACCOUNT=acct_... \
//     npx playwright test e2e/walkthrough/registration-connect.spec.ts --project=walkthrough
//
// Add WALKTHROUGH_WATCH=1 to run it headed and slowed down, with video — it
// doubles as the demo of the flow. `stripe listen` is required, not optional:
// the webhook is registrations' ONLY fulfilment path (billing has
// `reconcileCheckout` as a missed-webhook fallback; registrations have no
// equivalent), so without a forwarder the entry stays `pending` after a
// successful charge.
import { expect, test } from "@playwright/test";
import { apiJson } from "../helpers";
import { fillHostedCheckout } from "../stripe-checkout-kit";
// The SHARED claim/release, not a private copy. This file used to define its
// own `claimConnectAccount`/`releaseConnectAccount` that took NO advisory
// lock, while rs007-money-kit's versions exist precisely to serialize access
// to the one Connect fixture — and a lock only works if every participant
// takes it. See the comment on the kit's `claimConnectAccount`.
import { claimConnectAccount, releaseConnectAccount, type ConnectClaim } from "../rs007-money-kit";

/** Never on by accident: absent the flag this skips visibly rather than
 *  silently passing, so a CI run that cannot reach Stripe reports a skip
 *  rather than a green that proves nothing. */
const ENABLED = process.env.CONNECT_WALKTHROUGH === "1";
const WATCH = process.env.WALKTHROUGH_WATCH === "1";

const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";

// A skip is only honest if someone SEES it. Playwright's own summary prints
// "1 skipped" with no reason attached, and a CI leg that silently skips its
// only real-Stripe proof is indistinguishable from one that ran it — the
// failure mode this repo has already paid for ("unrun e2e ships vacuous
// waits"). Say so on stdout, at collection time, where the job log keeps it.
if (!ENABLED || !CONNECT_ACCOUNT) {
  const missing = [
    ENABLED ? null : "CONNECT_WALKTHROUGH=1",
    CONNECT_ACCOUNT ? null : "STRIPE_CONNECT_TEST_ACCOUNT",
  ].filter(Boolean);
  console.warn(
    `\n  ⚠ registration-connect walkthrough SKIPPED — the real Stripe Connect money path was NOT exercised.` +
      `\n    missing: ${missing.join(", ")}` +
      `\n    Nothing else in the suite produces checkout.session.completed, so this run proves nothing about it.\n`,
  );
}
test("RS006 — organiser settings, team entry, Stripe Connect payment", async ({ page, browser, request }, testInfo) => {
  test.skip(!ENABLED, "opt-in: set CONNECT_WALKTHROUGH=1 (needs a real sk_test and `stripe listen`)");
  test.skip(!CONNECT_ACCOUNT, "STRIPE_CONNECT_TEST_ACCOUNT is unset — a fabricated account id is rejected by Stripe");
  test.setTimeout(600_000);

  // Screenshots land beside the run's other artifacts rather than a path
  // baked into the file.
  const SHOTS = testInfo.outputPath();
  let connect: ConnectClaim | null = null;

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
    // Blocks until any other worker holding the fixture gives it back.
    connect = await claimConnectAccount(org.id);
    console.log(
      `CONNECT>>> ${CONNECT_ACCOUNT} taken from ${connect.priorId ?? "nobody"} for ${org.slug}`,
    );

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
    // `storageState: { cookies: [], origins: [] }` is what makes this context
    // ACTUALLY anonymous. Bare `browser.newContext()` INHERITS the project's
    // `storageState: AUTH_STATE` (playwright.config.ts), so this "public
    // registrant" was submitting as the signed-in e2e organiser — and a
    // signed-in submitter registering THEMSELVES with an adult dob links the
    // entry to that account's own `(org_id, user_id, 'player')` person
    // (`deriveLinkUserId`, registrations.ts). That upsert keeps the EXISTING
    // name (`do update set full_name = persons.full_name`), so this spec was
    // naming the shared e2e account's player person "Priya Raman" for every
    // OTHER walkthrough in the same job — which is precisely how it broke
    // rs010-registration-cross-flow, whose captain then rendered under this
    // spec's name instead of its own. Everything below drives only public
    // `/shared/...` pages, so there is nothing here that wanted auth.
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: { width: 1280, height: 900 },
      ...(WATCH ? { recordVideo: { dir: SHOTS } } : {}),
    });
    const anon = await ctx.newPage();

    await anon.goto(`/shared/${org.slug}/${comp.data!.slug}/register`, { waitUntil: "load" });
    await expect(anon.locator("#reg-who-name")).toBeVisible({ timeout: 20_000 });

    // ---- BEAT 2 — WHO ----------------------------------------------------
    await anon.locator("#reg-who-name").fill("Priya Raman");
    await anon.locator("#reg-who-email").fill(`delivered+priya-${Date.now()}@resend.dev`);
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

    await fillHostedCheckout(anon, "Priya Raman");
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
    // `getByText("confirmed")` used to be unambiguous here and is not any
    // more: RS007's status page rebuild added a roster meter ("1 of 3
    // confirmed") and a per-player chip ("Confirmed"), so the loose locator
    // now resolves to three elements and fails strict mode — on a page where
    // the payment SUCCEEDED. Anchor on the entry's own status badge instead
    // (exact, so the capitalised per-player chip does not match).
    await expect(anon.getByText("confirmed", { exact: true })).toBeVisible({ timeout: 60_000 });
    // And assert the money actually settled rather than only that a word
    // appeared: a still-payable entry keeps its pay control, so the absence
    // of one is what distinguishes "webhook fulfilled this" from "the page
    // merely rendered". The webhook is registrations' ONLY fulfilment path —
    // there is no reconcile fallback — so this is the assertion that would
    // catch a broken `checkout.session.completed` dispatch.
    await expect(anon.getByRole("button", { name: /pay now/i })).toHaveCount(0);
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
    // UNCONDITIONAL, per the kit's contract: a claim that threw after taking
    // the lock but before its UPDATEs landed still holds the lock, and only an
    // unguarded call releases it.
    await releaseConnectAccount(connect);
  }
});
