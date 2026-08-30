// The RS007 money matrix, played by hand against real Stripe Connect.
//
// The existing `rs007-invite-pay-cancel.spec.ts` witnesses ONE shape: a cart
// of two team entries, a promotion, and a cancel. That shape found two real
// money defects, which is the argument for widening it rather than for
// stopping. This file walks the rest of the matrix an organiser actually
// meets, one scenario per test:
//
//   S1  SINGLES        — an individual entry, paid, cancelled inside the
//                        refund window. The auto-refund must fire, in full.
//   S2  DOUBLES        — a pair entry, partner invited by join code and
//       + PRICE CHANGE   claimed off the status page, then the ORGANISER
//                        RAISES THE FEE, then the captain cancels. The refund
//                        must be the price actually PAID, never the new one.
//   S3  ORGANISER      — a team entry, paid, withdrawn from the ORGANISER's
//       CANCELLATION     side in the hub. Same core, different actor: the
//                        registrant must see it, and be refunded.
//   S4  REFUND LOCK    — an individual entry, paid, cancelled AFTER
//                        `refund_lock_at`. NO auto-refund may fire, the dialog
//                        must say so before the registrant confirms — and the
//                        organiser must have a way to refund at their own
//                        discretion afterwards, because that is what the copy
//                        promises them.
//
//   S5  MANUAL APPROVAL — the same journey as S4 on a division that VETS
//       + REFUND LOCK      entries. A paid entry waits at `status = 'paid'`
//                          for the organiser, so it is never materialised and
//                          carries no `entrant_id`. Cancelled past the lock,
//                          it must be refunded no more automatically than an
//                          auto-approval one.
//
// S4 IS CURRENTLY RED, DELIBERATELY. It is the reproduction for finding #18
// (`_INDEX.md`), a CRITICAL money defect it found on its first run: the dialog
// correctly promises no automatic refund, `withdrawCore` correctly issues
// none — and £40 is refunded three seconds later anyway, audited as
// `"mode": "late_payment"`. The organiser loses money their own published
// policy said they keep, with an audit trail that looks legitimate. Leave this
// failing until that is fixed; a green here would mean the assertion was
// weakened, not that the defect went away.
//
// WHY EACH OF THESE IS A DIFFERENT RISK, not the same journey four times:
//
//  - S1 is the only scenario where entrant_kind is `individual`. `entrant_kind`
//    is a per-DIVISION setting (registration-settings), and it changes which
//    control the entries step even renders ("Add an entry" vs "Add a team" vs
//    "Add a pair") — so a singles division is a genuinely different code path
//    through the stepper, not a cosmetic variant.
//  - S2 is the one that can only fail silently. Both refund paths read the
//    entry's stored `amount_cents` (registrations.ts `resolveRefundPolicy` and
//    `refundRegistration`), never the live `registration_settings.fee_cents` —
//    a design decision with no test that would notice it being reversed. A
//    future "read the current fee" refactor would look correct in review, pass
//    every unit test, and quietly refund the WRONG AMOUNT to real people.
//  - S3 exercises the actor split. There is exactly ONE exit path
//    (`withdrawCore`); organiser and registrant differ only by `actorId`, so
//    the risk is not the refund arithmetic but whether the registrant's own
//    page tells them what happened to their money when someone else acted.
//  - S4 is the boundary. `resolveRefundPolicy` is fail-CLOSED past the lock,
//    which is correct, and the whole question is what the product offers
//    instead. See the note on S4 itself.
//
// SETUP vs JOURNEY. Competitions, divisions and registration settings are
// server-authored resources with no click-through creation flow, so they are
// created through the API — the walkthrough charter's own "setup may use the
// API to REACH a state" allowance. Everything that IS the journey — typing,
// adding entries, paying, following the claim link, changing the price,
// cancelling, withdrawing — is done through the real UI.
//
// OPT-IN, same reason registration-connect.spec.ts is: the e2e workflow's
// hardcoded dummy Stripe key never reaches Stripe, so these can only run
// where a real test key does.
//
// Run them:
//   stripe listen --forward-to $PLAYWRIGHT_BASE/api/webhooks/stripe   # another shell
//   CONNECT_WALKTHROUGH=1 STRIPE_CONNECT_TEST_ACCOUNT=acct_... \
//     npx playwright test e2e/walkthrough/rs007-money-matrix.spec.ts --project=walkthrough
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { activeOrg, apiJson, TAG } from "../helpers";
import {
  CONNECT_ACCOUNT,
  ENABLED,
  WATCH,
  centsFromRenderedAmount,
  claimConnectAccount,
  openPaidDivision,
  payOnStripeCheckout,
  publicRegSnapshot,
  releaseConnectAccount,
  entryIdsInGroup,
  statusUrlParts,
  waitForRefund,
  waitForStatus,
  warnIfDisabled,
  withDb,
  type ConnectClaim,
} from "../rs007-money-kit";

warnIfDisabled(
  "rs007-money-matrix",
  "singles, doubles+price-change, organiser cancellation and the refund lock were NOT exercised against real money.",
);

test.use({
  headless: !WATCH,
  ...(WATCH
    ? { launchOptions: { slowMo: 650 }, video: { mode: "on" as const, size: { width: 1280, height: 900 } } }
    : {}),
  actionTimeout: 15_000,
  viewport: { width: 1280, height: 900 },
});

// SERIAL, and not merely for tidiness: every test in this file needs the ONE
// Connect fixture account, and `organizations.stripe_account_id` is UNIQUE.
// The kit's advisory lock makes a cross-FILE collision wait rather than
// corrupt; this keeps the tests within this file from queueing on that lock
// four deep and burning their own timeouts waiting.
test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// One scenario's worth of shared journey
// ---------------------------------------------------------------------------

interface Scenario {
  page: Page;
  browser: Browser;
  request: APIRequestContext;
  shots: string;
}

/** Everything a scenario needs to reach "paid, sitting on the status page". */
interface PaidEntry {
  anon: Page;
  ctx: import("@playwright/test").BrowserContext;
  statusUrl: string;
  /** The CART id, which is what the status URL's `rid` param actually holds. */
  groupId: string;
  /** THIS entry's registration id — what every public money endpoint takes. */
  rid: string;
  token: string;
  pageErrors: string[];
  badResponses: string[];
}

/** Drive the public stepper from cold to a paid entry, through the UI.
 *
 *  `entrantKind` picks the entries-step control, which is genuinely different
 *  copy per kind (register.entries.add.{team,pair,individual}) — the reason
 *  singles and doubles are separate scenarios rather than one parameterised
 *  one with an `if`. */
async function enterAndPay(
  s: Scenario,
  opts: {
    orgSlug: string;
    compSlug: string;
    entrantKind: "team" | "pair" | "individual";
    /** Team name, or the pair's partner name. Ignored for `individual`. */
    entryName?: string;
    captainName: string;
    captainEmail: string;
    /** Extra roster rows the captain ADDS with "+ Add player" (team only). */
    mates?: string[];
    /** The names to type into the details step's own pre-rendered player
     *  rows, in order. A pair's second row is NOT seeded from the partner
     *  name typed at the entries step (RS007 finding #17), so a doubles
     *  scenario must name both halves here or the roster ends up with two
     *  identically-named players and the join page cannot be used. */
    roster?: string[];
    shotPrefix: string;
  },
): Promise<PaidEntry> {
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  const ctx = await s.browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(WATCH ? { recordVideo: { dir: s.shots } } : {}),
  });
  const anon = await ctx.newPage();
  anon.on("pageerror", (e) => pageErrors.push(`[registrant] ${String(e).slice(0, 200)}`));
  // React swallows a render error inside an error boundary and reports it on
  // the CONSOLE, not as a pageerror — so a stepper that silently stops
  // advancing shows up here and nowhere else.
  anon.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`[console] ${m.text().slice(0, 300)}`);
  });
  anon.on("response", (res) => {
    if (res.url().includes("/api/") && res.status() >= 400) {
      badResponses.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
    }
  });
  const shot = async (name: string) =>
    anon.screenshot({ path: `${s.shots}/${opts.shotPrefix}-${name}.png`, fullPage: true });

  await anon.goto(`/shared/${opts.orgSlug}/${opts.compSlug}/register`, { waitUntil: "load" });
  await anon.getByRole("button", { name: /^accept$/i }).click({ timeout: 3000 }).catch(() => {});
  await expect(anon.locator("#reg-who-name")).toBeVisible({ timeout: 20_000 });

  // ---- WHO ---------------------------------------------------------------
  await anon.locator("#reg-who-name").fill(opts.captainName);
  await anon.locator("#reg-who-email").fill(opts.captainEmail);
  await shot("01-who");
  await anon.getByRole("button", { name: /^next$/i }).click();
  // Fail HERE if the stepper did not advance, rather than eighteen seconds
  // later on whichever locator the next step owns — a swallowed Next reads
  // as "the consent checkbox is missing", which sends the reader to the
  // wrong screen entirely.
  await expect(
    anon.locator("#reg-who-name"),
    `the WHO step did not advance when Next was clicked. Page errors so far: ${
      pageErrors.length ? pageErrors.join(" | ") : "(none)"
    }`,
  ).toBeHidden({ timeout: 15_000 });

  // ---- ENTRIES -----------------------------------------------------------
  // This step is NOT always rendered. RS006 design §4 collapses it when a
  // competition has one open division, and RS007's own ruling (2026-08-27,
  // `_INDEX.md` — "the entries-step collapse is entrant-kind dependent")
  // narrowed that to `entrant_kind === "individual"` ONLY: team and pair keep
  // the step, because it is the only surface that renders a team-name input
  // or the "sign up solo" choice, and collapsing it shipped a captain into an
  // unrecoverable `422 A team name is required` with no field to answer it.
  //
  // So a singles division with one division walks WHO -> (collapsed) ->
  // CONSENT, with `cart.ts` auto-seeding the entry. Detected rather than
  // assumed: hard-coding either branch would make this helper wrong for one
  // of the three kinds the matrix exists to cover.
  const entriesHeading = anon.getByRole("heading", { name: "Choose your divisions", exact: true });
  const entriesRendered = await entriesHeading.isVisible({ timeout: 10_000 }).catch(() => false);
  if (entriesRendered) {
    const addLabel =
      opts.entrantKind === "team" ? "Add a team" : opts.entrantKind === "pair" ? "Add a pair" : "Add an entry";
    await anon.getByRole("button", { name: addLabel, exact: true }).first().click();
    await anon.waitForTimeout(600);
    if (opts.entrantKind === "team" && opts.entryName) {
      await anon.getByPlaceholder("Team name").first().fill(opts.entryName);
    }
    if (opts.entrantKind === "pair" && opts.entryName) {
      // A pair's roster is fixed at two and the partner is optional at this
      // step — typing the name here is what mints a claimable second row,
      // which S2 then needs a real join_code for.
      await anon.getByPlaceholder("Partner's name (optional for now)").first().fill(opts.entryName);
    }
    await anon.waitForTimeout(600);
    await shot("02-entries");
    await anon.getByRole("button", { name: /^next$/i }).click();
  } else {
    // The collapse is only legal for `individual`. If a team or pair division
    // ever lands here it is the exact defect that ruling was written for, and
    // it must fail loudly rather than walk on into an unnameable entry.
    expect(
      opts.entrantKind,
      "the entries step collapsed for a team/pair division — RS007's ruling says only `individual` may collapse, " +
        "because this step is the ONLY place a team name can be typed (a collapsed one submits and 422s with no " +
        "field anywhere in the flow to fix it)",
    ).toBe("individual");
    await shot("02-entries-collapsed");
  }

  // ---- DETAILS -----------------------------------------------------------
  // An `individual` entry with no extra roster rows can skip this step
  // entirely — the stepper only renders "Player details" when there is a
  // roster to fill, so waiting for that heading unconditionally would hang
  // the singles scenario on a screen it never shows.
  const detailsHeading = anon.getByRole("heading", { name: "Player details", exact: true });
  if (await detailsHeading.isVisible({ timeout: 8000 }).catch(() => false)) {
    for (const name of opts.mates ?? []) {
      await anon.getByRole("button", { name: /\+ add player/i }).first().click();
      await anon.waitForTimeout(300);
      const boxes = anon.getByPlaceholder("Full name");
      await boxes.nth((await boxes.count()) - 1).fill(name);
      await anon.waitForTimeout(200);
    }
    // Every entrant kind arrives here with its own pre-rendered, EMPTY player
    // rows — one for `individual`, two for `pair` — and the step refuses to
    // advance with "Fill in the missing details above before continuing".
    // Nothing above filled them: notably, the partner name typed on the
    // entries step feeds only the pair's DISPLAY name, never its roster
    // (finding #17), so a doubles scenario must name both rows explicitly.
    //
    // `opts.roster` is positional. Falling back to the captain's name for an
    // unnamed row is right for a singles entry (the row IS the captain) and
    // is exactly what must NOT happen for a pair — hence the explicit list.
    const nameBoxes = anon.getByPlaceholder("Full name");
    for (let i = 0; i < (await nameBoxes.count()); i += 1) {
      const box = nameBoxes.nth(i);
      if (((await box.inputValue()) ?? "").trim() === "") {
        await box.fill(opts.roster?.[i] ?? opts.captainName);
        await anon.waitForTimeout(150);
      }
    }
    await shot("03-details");
    await anon.getByRole("button", { name: /^next$/i }).click();
  }

  // ---- CONSENT -----------------------------------------------------------
  await anon.waitForTimeout(600);
  await anon.locator("#reg-consent-privacy").check();
  await shot("04-consent");
  await anon.getByRole("button", { name: /^next$/i }).click();

  // ---- REVIEW, then real Stripe -----------------------------------------
  await anon.waitForTimeout(1000);
  await shot("05-review");
  await anon
    .getByRole("button", { name: /Continue to payment|Enter the competition|Enter —/ })
    .first()
    .click();

  const statusUrl = await payOnStripeCheckout(anon, opts.captainName, async (n) => {
    await anon.screenshot({ path: `${s.shots}/${opts.shotPrefix}-06-${n}.png`, fullPage: true });
  });
  const { groupId, token } = statusUrlParts(statusUrl);
  // The status URL names the CART; every scenario here submits exactly one
  // entry, so its single id is the one under test.
  const ids = await entryIdsInGroup(groupId);
  expect(ids, `expected one entry in cart ${groupId}, found ${ids.length}`).toHaveLength(1);
  return { anon, ctx, statusUrl, groupId, rid: ids[0]!, token, pageErrors, badResponses };
}

/** Create the competition every scenario hangs its divisions off. A future
 *  `starts_on` matters: `resolveRefundPolicy` falls back to it when
 *  `refund_lock_at` is unset, and with NEITHER the policy is fail-closed and
 *  no refund can ever be offered — which would make S1/S2/S3 pass for the
 *  wrong reason. */
async function createCompetition(request: APIRequestContext, name: string) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `${name} ${TAG}`,
    visibility: "public",
    starts_on: "2030-11-01",
    ends_on: "2030-12-31",
  });
  expect(comp.status, `could not create the competition "${name}"`).toBeLessThan(300);
  return comp.data!;
}

/** Set `KEEP_FIXTURES=1` to leave the competition (and every row hanging off
 *  it) in the database after a run. Money defects here are diagnosed from the
 *  audit ledger — `competition_events` names which path moved the money and
 *  on whose behalf — and the cleanup below otherwise deletes exactly the
 *  evidence a failure needs. */
const KEEP_FIXTURES = process.env.KEEP_FIXTURES === "1";

async function cleanupCompetition(request: APIRequestContext, competitionId: string): Promise<void> {
  if (KEEP_FIXTURES) {
    console.log(`KEEP_FIXTURES=1 — leaving competition ${competitionId} in place`);
    return;
  }
  await apiJson(request, `/api/v1/competitions/${competitionId}`, "DELETE");
}

function skipUnlessEnabled() {
  test.skip(!ENABLED, "opt-in: set CONNECT_WALKTHROUGH=1 (needs a real sk_test and `stripe listen`)");
  test.skip(!CONNECT_ACCOUNT, "STRIPE_CONNECT_TEST_ACCOUNT is unset — a fabricated account id is rejected by Stripe");
}

// ===========================================================================
// S1 — SINGLES: paid, cancelled inside the window, refunded in full
// ===========================================================================

test("S1 singles — an individual entrant who cancels inside the refund window is told the exact amount, and gets all of it back", async ({
  page,
  browser,
  request,
}, testInfo) => {
  skipUnlessEnabled();
  test.setTimeout(600_000);
  const s: Scenario = { page, browser, request, shots: testInfo.outputPath() };

  const FEE_CENTS = 3000;
  const NAME = `Solo Entrant ${TAG}`;
  const comp = await createCompetition(request, "Singles Open");
  let claim: ConnectClaim | null = null;
  let entry: PaidEntry | null = null;

  try {
    const org = await activeOrg(page);
    claim = await claimConnectAccount(org.id);
    await openPaidDivision(request, comp.id, {
      name: "Singles Main Draw",
      entrant_kind: "individual",
      fee_cents: FEE_CENTS,
    });

    entry = await enterAndPay(s, {
      orgSlug: org.slug,
      compSlug: comp.slug,
      entrantKind: "individual",
      captainName: NAME,
      captainEmail: `solo-${TAG}@example.com`,
      shotPrefix: "s1",
    });
    const { anon, rid, token } = entry;

    // The webhook is what makes this paid, and it races the redirect — poll
    // the system's own record rather than trusting a fixed wait.
    const paid = await waitForStatus(request, rid, token, ["paid", "confirmed"]);
    expect(paid.amount_cents, "the singles entrant was charged the division fee").toBe(FEE_CENTS);
    expect(paid.refunded_cents, "nothing is refunded yet").toBe(0);

    await anon.reload({ waitUntil: "load" });
    await anon.waitForTimeout(1200);
    await anon.screenshot({ path: `${s.shots}/s1-07-status-paid.png`, fullPage: true });

    // ---- the cancel, through the page's own control --------------------
    await anon.getByRole("button", { name: "Cancel this entry", exact: true }).first().click();
    const dialog = anon.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const dialogText = (await dialog.textContent()) ?? "";
    await anon.screenshot({ path: `${s.shots}/s1-08-cancel-dialog.png` });

    // Inside the window (refund_lock_at unset -> starts_on 2030 is the
    // fallback deadline), so the dialog must PROMISE a refund, and the amount
    // it names must be the amount actually charged. A dialog that promises
    // "will be refunded automatically" without naming the right figure is how
    // a registrant finds out days later that they were told wrong.
    expect(
      dialogText,
      `S1: the refund window is open (competition starts 2030-11-01) and this entry paid ` +
        `£${(FEE_CENTS / 100).toFixed(2)}, but the cancel dialog reads "${dialogText.trim()}" — no automatic-refund promise.`,
    ).toMatch(/refunded automatically/);
    expect(
      centsFromRenderedAmount(dialogText),
      `S1: the dialog promises a refund but names the wrong amount in "${dialogText.trim()}" ` +
        `— the entrant paid ${FEE_CENTS} cents.`,
    ).toBe(FEE_CENTS);

    await dialog.getByRole("button", { name: "Cancel entry", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(anon.getByText("withdrawn", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await anon.screenshot({ path: `${s.shots}/s1-09-after-cancel.png`, fullPage: true });

    // The refund is a real Stripe call made OUTSIDE the withdraw transaction,
    // so it lands after the page has already re-rendered — poll for it.
    const refunded = await waitForRefund(request, rid, token, FEE_CENTS);
    expect(refunded.status, "the cancelled entry reads withdrawn").toBe("withdrawn");
    expect(
      refunded.refunded_cents,
      `S1: a full refund was promised for a cancellation inside the window, but only ` +
        `${refunded.refunded_cents} of ${FEE_CENTS} cents came back.`,
    ).toBe(FEE_CENTS);

    expect(entry.pageErrors, `page errors: ${entry.pageErrors.join(" | ")}`).toEqual([]);
    expect(entry.badResponses, `HTTP >= 400: ${entry.badResponses.join(" | ")}`).toEqual([]);
  } finally {
    await entry?.ctx.close();
    await cleanupCompetition(request, comp.id);
    await releaseConnectAccount(claim);
  }
});

// ===========================================================================
// S2 — DOUBLES, an invited partner, and a price rise after the money moved
// ===========================================================================

test("S2 doubles — a partner joins by invite link, then the organiser raises the fee, and the cancelled pair is refunded the price it actually paid", async ({
  page,
  browser,
  request,
}, testInfo) => {
  skipUnlessEnabled();
  test.setTimeout(600_000);
  const s: Scenario = { page, browser, request, shots: testInfo.outputPath() };

  const PAID_CENTS = 2000;
  const RAISED_CENTS = 4500;
  const CAPTAIN = `Pair Captain ${TAG}`;
  const PARTNER = `Pair Partner ${TAG}`;
  const comp = await createCompetition(request, "Doubles Open");
  let claim: ConnectClaim | null = null;
  let entry: PaidEntry | null = null;

  try {
    const org = await activeOrg(page);
    claim = await claimConnectAccount(org.id);
    const divId = await openPaidDivision(request, comp.id, {
      name: "Mixed Doubles",
      entrant_kind: "pair",
      fee_cents: PAID_CENTS,
    });

    entry = await enterAndPay(s, {
      orgSlug: org.slug,
      compSlug: comp.slug,
      entrantKind: "pair",
      entryName: PARTNER,
      captainName: CAPTAIN,
      captainEmail: `paircap-${TAG}@example.com`,
      // Both halves, by name: the pair's roster rows are empty at the details
      // step regardless of what was typed on the entries step (#17), and the
      // partner must be individually pickable on the join page for the invite
      // half of this scenario to mean anything.
      roster: [CAPTAIN, PARTNER],
      shotPrefix: "s2",
    });
    const { anon, rid, token } = entry;

    const paid = await waitForStatus(request, rid, token, ["paid", "confirmed"]);
    expect(paid.amount_cents, "the pair was charged the fee in force at submit").toBe(PAID_CENTS);

    await anon.reload({ waitUntil: "load" });
    await anon.waitForTimeout(1200);
    await anon.screenshot({ path: `${s.shots}/s2-07-status-paid.png`, fullPage: true });

    // ---- the INVITE: read the anchor the page emits and CLICK it -------
    // Never construct the join URL. RS007's review found every claim link on
    // this page 404'ing while 3098 unit tests stayed green, because a
    // constructed URL proves the route exists and a rendered anchor proves
    // nothing at all. Only following the one the product emitted catches it.
    const claimLink = anon.locator('a[href*="/register/join"]').first();
    await expect(claimLink, "the pair's card emits no claim link for the partner").toBeVisible({ timeout: 15_000 });
    const href = await claimLink.getAttribute("href");
    expect(href, "the claim link carries no join_code").toContain("join_code=");
    const [claimResponse] = await Promise.all([
      anon.waitForResponse((r) => r.url().includes("/register/join") && r.request().isNavigationRequest()),
      claimLink.click(),
    ]);
    expect(claimResponse.status(), `the invite link resolved to ${claimResponse.status()}`).toBeLessThan(400);
    await anon.screenshot({ path: `${s.shots}/s2-08-join-form.png`, fullPage: true });

    await anon.getByRole("radio", { name: PARTNER }).check();
    await anon.locator("#reg-who-name").fill(PARTNER);
    await anon.locator("#reg-who-email").fill(`partner-${TAG}@example.com`);
    await anon.locator("#reg-consent-privacy").check();
    await anon.getByRole("button", { name: /confirm my spot/i }).click();
    await expect(
      anon.getByText(/you're in|confirmed|spot confirmed/i).first(),
      "the partner submitted the join form but nothing confirmed the claim",
    ).toBeVisible({ timeout: 20_000 });
    await anon.screenshot({ path: `${s.shots}/s2-09-partner-claimed.png`, fullPage: true });

    // ---- THE PRICE RISE, through the organiser's own settings UI -------
    await page.goto(`/o/${org.slug}/c/${comp.slug}/registration`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    // The Settings tab opens on a COLLAPSED division row — status, entrant
    // kind, current fee and the share link, no editable fields. The config
    // panel (and with it the fee input) is behind the row's own configure
    // control, so an organiser raising a price taps that first.
    await page
      .locator("[data-registration-hub-row-configure]")
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${s.shots}/s2-10a-config-open.png`, fullPage: true });

    // The panel is an accordion of native <details> sections, and `money` is
    // the one that starts CLOSED (DEFAULT_OPEN in registration-hub-config-
    // panel.tsx: eligibility/schedule/capacity open, money/form shut). The
    // fee input therefore exists in the DOM but is genuinely `hidden` until
    // an organiser opens the section — so this is a real click in the
    // journey, not a workaround for the test.
    await page.locator('[data-accordion-section="money"] summary').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${s.shots}/s2-10b-money-section.png`, fullPage: true });

    // `data-field="fee_cents"` sits on the <input> ITSELF (registration-hub-
    // config-panel.tsx) — not on a wrapper — and the field takes POUNDS, not
    // cents: its onChange does `Math.round(pounds * 100)`.
    const feeField = page.locator('input[data-field="fee_cents"]').first();
    await expect(feeField, "the hub's registration settings expose no entry-fee field to change").toBeVisible({
      timeout: 20_000,
    });
    await feeField.fill(String(RAISED_CENTS / 100));
    // The input's own onBlur reformats the draft ("45" -> "45.00") and is
    // what settles `fee_cents` — clicking Save while focus is still in the
    // field would submit whatever the last keystroke left behind.
    await feeField.blur();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Save changes", exact: true }).first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${s.shots}/s2-10-fee-raised.png`, fullPage: true });

    // Confirm the rise actually landed — otherwise the assertion below would
    // pass simply because nothing changed, which is the vacuous version of
    // this whole scenario.
    const live = await apiJson<{ fee_cents: number }>(
      request,
      `/api/v1/divisions/${divId}/registration-settings`,
      "GET",
    );
    expect(
      live.data?.fee_cents,
      `S2 is vacuous unless the fee really rose: expected ${RAISED_CENTS}, division reads ${live.data?.fee_cents}`,
    ).toBe(RAISED_CENTS);

    // The paid entry must NOT have been re-priced by the change.
    const afterRise = await publicRegSnapshot(request, rid, token);
    expect(
      afterRise.amount_cents,
      `S2: raising the division fee to ${RAISED_CENTS} re-priced an ALREADY PAID entry to ` +
        `${afterRise.amount_cents} — the entrant's charge is a historical fact and must not move.`,
    ).toBe(PAID_CENTS);

    // ---- the cancel: the refund must be the OLD price -------------------
    await anon.goto(entry.statusUrl, { waitUntil: "load" });
    await anon.waitForTimeout(1200);
    await anon.getByRole("button", { name: "Cancel this entry", exact: true }).first().click();
    const dialog = anon.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const dialogText = (await dialog.textContent()) ?? "";
    await anon.screenshot({ path: `${s.shots}/s2-11-cancel-dialog.png` });
    expect(
      centsFromRenderedAmount(dialogText),
      `S2: the pair paid £${(PAID_CENTS / 100).toFixed(2)} and the organiser has since raised the fee to ` +
        `£${(RAISED_CENTS / 100).toFixed(2)}. The cancel dialog reads "${dialogText.trim()}" — a refund quoted at ` +
        `the CURRENT price, not the price this entrant was actually charged.`,
    ).toBe(PAID_CENTS);

    await dialog.getByRole("button", { name: "Cancel entry", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    const refunded = await waitForRefund(request, rid, token, PAID_CENTS);
    await anon.screenshot({ path: `${s.shots}/s2-12-after-cancel.png`, fullPage: true });
    expect(
      refunded.refunded_cents,
      `S2: refund of ${refunded.refunded_cents} against a ${PAID_CENTS} charge. Over-refunding to the NEW price ` +
        `pays the entrant money they never handed over (and pulls it off the organiser's connected account); ` +
        `under-refunding short-changes them.`,
    ).toBe(PAID_CENTS);

    expect(entry.pageErrors, `page errors: ${entry.pageErrors.join(" | ")}`).toEqual([]);
    expect(entry.badResponses, `HTTP >= 400: ${entry.badResponses.join(" | ")}`).toEqual([]);
  } finally {
    await entry?.ctx.close();
    await cleanupCompetition(request, comp.id);
    await releaseConnectAccount(claim);
  }
});

// ===========================================================================
// S3 — the ORGANISER cancels, and the registrant has to find out
// ===========================================================================

test("S3 organiser cancellation — a team withdrawn from the hub is refunded, and the registrant's own page says so without being told", async ({
  page,
  browser,
  request,
}, testInfo) => {
  skipUnlessEnabled();
  test.setTimeout(600_000);
  const s: Scenario = { page, browser, request, shots: testInfo.outputPath() };

  const FEE_CENTS = 1500;
  const TEAM = `Withdrawn Wanderers ${TAG}`;
  const CAPTAIN = `Team Captain ${TAG}`;
  const comp = await createCompetition(request, "Organiser Cancellation Cup");
  let claim: ConnectClaim | null = null;
  let entry: PaidEntry | null = null;

  try {
    const org = await activeOrg(page);
    claim = await claimConnectAccount(org.id);
    await openPaidDivision(request, comp.id, {
      name: "Team Division",
      entrant_kind: "team",
      fee_cents: FEE_CENTS,
    });

    entry = await enterAndPay(s, {
      orgSlug: org.slug,
      compSlug: comp.slug,
      entrantKind: "team",
      entryName: TEAM,
      captainName: CAPTAIN,
      captainEmail: `teamcap-${TAG}@example.com`,
      mates: [`Rowan Vale ${TAG}`],
      shotPrefix: "s3",
    });
    const { anon, rid, token } = entry;
    await waitForStatus(request, rid, token, ["paid", "confirmed"]);

    // ---- the ORGANISER withdraws, from the hub's own control -----------
    await page.goto(`/o/${org.slug}/c/${comp.slug}/registration?tab=registrants`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const row = page
      .locator("details[data-registration-hub-registrant-row]")
      .filter({ has: page.locator("summary", { hasText: TEAM }) });
    await expect(row, "the paid team never appeared in the organiser's registrants tab").toBeVisible({
      timeout: 20_000,
    });
    await row.locator("summary").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${s.shots}/s3-07-hub-before-withdraw.png`, fullPage: true });

    await row.getByRole("button", { name: "Withdraw", exact: true }).click();
    // The hub's own confirm step — copy: "Withdraw this registration?"
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${s.shots}/s3-08-hub-withdraw-confirm.png` });
    await confirm.getByRole("button", { name: "Withdraw", exact: true }).click();
    await expect(row.locator('[data-registration-hub-registrant-status="withdrawn"]:visible')).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({ path: `${s.shots}/s3-09-hub-after-withdraw.png`, fullPage: true });

    // Same core (`withdrawCore`), different actor — the refund policy must not
    // depend on WHO pressed the button.
    const refunded = await waitForRefund(request, rid, token, FEE_CENTS);
    expect(refunded.status, "an organiser withdrawal leaves the entry withdrawn").toBe("withdrawn");
    expect(
      refunded.refunded_cents,
      `S3: the organiser withdrew a paid entry inside the refund window and ${refunded.refunded_cents} of ` +
        `${FEE_CENTS} cents came back. A registrant who did not choose this must not be worse off than one who did.`,
    ).toBe(FEE_CENTS);

    // ---- and the registrant, who was never told, opens their page ------
    await anon.goto(entry.statusUrl, { waitUntil: "load" });
    await anon.waitForTimeout(1500);
    await anon.screenshot({ path: `${s.shots}/s3-10-registrant-sees-it.png`, fullPage: true });
    await expect(
      anon.getByText("withdrawn", { exact: true }).first(),
      "S3: the organiser withdrew this entry and the registrant's own status page still does not say so.",
    ).toBeVisible({ timeout: 20_000 });
    // Cancelling something already withdrawn would be a dead end.
    await expect(anon.getByRole("button", { name: "Cancel this entry" })).toHaveCount(0);

    expect(entry.pageErrors, `page errors: ${entry.pageErrors.join(" | ")}`).toEqual([]);
    expect(entry.badResponses, `HTTP >= 400: ${entry.badResponses.join(" | ")}`).toEqual([]);
  } finally {
    await entry?.ctx.close();
    await cleanupCompetition(request, comp.id);
    await releaseConnectAccount(claim);
  }
});

// ===========================================================================
// S4 — past the refund lock: no automatic refund, and what is offered instead
// ===========================================================================

test("S4 refund lock — cancelling after the lock refunds nothing automatically, says so first, and leaves the organiser a way to refund by hand", async ({
  page,
  browser,
  request,
}, testInfo) => {
  skipUnlessEnabled();
  test.setTimeout(600_000);
  const s: Scenario = { page, browser, request, shots: testInfo.outputPath() };

  const FEE_CENTS = 4000;
  const NAME = `Late Canceller ${TAG}`;
  const comp = await createCompetition(request, "Refund Lock Open");
  let claim: ConnectClaim | null = null;
  let entry: PaidEntry | null = null;

  try {
    const org = await activeOrg(page);
    claim = await claimConnectAccount(org.id);
    const divId = await openPaidDivision(request, comp.id, {
      name: "Locked Singles",
      entrant_kind: "individual",
      fee_cents: FEE_CENTS,
    });

    // The lock is set in the PAST, which the settings PUT will not accept
    // (and should not — an organiser cannot retroactively close a window
    // through the UI). Writing it directly is setup, reaching a state the
    // clock reaches on its own the moment a real competition's deadline
    // passes; it is not the thing under test.
    await withDb(async (sql) => {
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const rows = await sql`
        update registration_settings
        set refund_lock_at = ${past}
        where division_id = ${divId}
        returning division_id`;
      if (rows.length !== 1) {
        throw new Error(`could not backdate refund_lock_at for division ${divId} (updated ${rows.length} rows)`);
      }
    });

    entry = await enterAndPay(s, {
      orgSlug: org.slug,
      compSlug: comp.slug,
      entrantKind: "individual",
      captainName: NAME,
      captainEmail: `late-${TAG}@example.com`,
      shotPrefix: "s4",
    });
    const { anon, rid, token } = entry;
    const paid = await waitForStatus(request, rid, token, ["paid", "confirmed"]);
    expect(paid.amount_cents).toBe(FEE_CENTS);

    await anon.reload({ waitUntil: "load" });
    await anon.waitForTimeout(1200);
    await anon.screenshot({ path: `${s.shots}/s4-07-status-paid.png`, fullPage: true });

    // ---- cancel, past the lock -----------------------------------------
    await anon.getByRole("button", { name: "Cancel this entry", exact: true }).first().click();
    const dialog = anon.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const dialogText = (await dialog.textContent()) ?? "";
    await anon.screenshot({ path: `${s.shots}/s4-08-cancel-dialog.png` });

    // The registrant must learn this BEFORE they confirm, not after. Being
    // shown "£40 will be refunded automatically" and then receiving nothing is
    // the single worst outcome this whole matrix can produce.
    expect(
      dialogText,
      `S4: the refund window closed an hour ago, but the cancel dialog reads "${dialogText.trim()}" — ` +
        `it promises an automatic refund that resolveRefundPolicy will refuse to issue.`,
    ).not.toMatch(/refunded automatically/);
    expect(
      dialogText,
      `S4: past the lock the dialog must say what actually happens — that any refund is now the organiser's ` +
        `decision. It reads "${dialogText.trim()}".`,
    ).toMatch(/organiser's discretion/i);

    await dialog.getByRole("button", { name: "Cancel entry", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(anon.getByText("withdrawn", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await anon.screenshot({ path: `${s.shots}/s4-09-after-cancel.png`, fullPage: true });

    // Give a wrong auto-refund time to land before declaring none did — an
    // immediate read would pass even if the refund were merely slow.
    await anon.waitForTimeout(6000);
    const after = await publicRegSnapshot(request, rid, token);
    expect(after.status, "the entry is withdrawn either way").toBe("withdrawn");
    expect(
      after.refunded_cents,
      `S4: ${after.refunded_cents} cents were refunded automatically for a withdrawal AFTER refund_lock_at. ` +
        `Past the lock the organiser decides, and money must not leave their connected account on its own.`,
    ).toBe(0);

    // ---- and now the organiser's side of that promise ------------------
    // The copy the product shows the registrant says any refund is "at the
    // organiser's discretion". `POST /api/v1/registrations/{id}/refund`
    // exists to honour that, and `confirm.refundRegistration.{title,body,label}`
    // is written in all four locales for its confirm dialog. If no control
    // renders it, the sentence above is a promise the product cannot keep:
    // the organiser's only remaining option is a refund from the Stripe
    // dashboard, which never writes `registrations.refunded_cents` — so the
    // hub, this status page and Stripe disagree permanently, with nothing in
    // the app able to reconcile them.
    await page.goto(`/o/${org.slug}/c/${comp.slug}/registration?tab=registrants`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const row = page
      .locator("details[data-registration-hub-registrant-row]")
      .filter({ has: page.locator("summary", { hasText: NAME }) });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator("summary").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${s.shots}/s4-10-hub-detail.png`, fullPage: true });

    const refundBtn = row.getByRole("button", { name: "Refund", exact: true });
    await expect(
      refundBtn,
      `S4 (finding #16): this entrant was told at the moment they cancelled that "any refund is at the ` +
        `organiser's discretion". The organiser's registrant panel offers no Refund control, so there is no ` +
        `discretion to exercise — POST /api/v1/registrations/{id}/refund has no caller anywhere in apps/web/src, ` +
        `and confirm.refundRegistration.* sits unused in all four dictionaries.`,
    ).toBeVisible({ timeout: 15_000 });

    await refundBtn.click();
    const refundConfirm = page.getByRole("alertdialog");
    await expect(refundConfirm).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${s.shots}/s4-11-refund-confirm.png` });
    await refundConfirm.getByRole("button", { name: "Refund", exact: true }).click();

    const discretionary = await waitForRefund(request, rid, token, FEE_CENTS);
    expect(
      discretionary.refunded_cents,
      `S4: the organiser exercised their discretion and ${discretionary.refunded_cents} of ${FEE_CENTS} cents ` +
        `reached the entrant.`,
    ).toBe(FEE_CENTS);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${s.shots}/s4-12-hub-after-refund.png`, fullPage: true });

    expect(entry.pageErrors, `page errors: ${entry.pageErrors.join(" | ")}`).toEqual([]);
    expect(entry.badResponses, `HTTP >= 400: ${entry.badResponses.join(" | ")}`).toEqual([]);
  } finally {
    await entry?.ctx.close();
    await cleanupCompetition(request, comp.id);
    await releaseConnectAccount(claim);
  }
});

// ===========================================================================
// S5 — the refund lock on a division that VETS entries (finding #18b)
// ===========================================================================

test("S5 manual approval — a vetted entry that pays and then cancels past the lock is refunded no more automatically than any other", async ({
  page,
  browser,
  request,
}, testInfo) => {
  skipUnlessEnabled();
  test.setTimeout(600_000);
  const s: Scenario = { page, browser, request, shots: testInfo.outputPath() };

  const FEE_CENTS = 3500;
  const NAME = `Vetted Entrant ${TAG}`;
  const comp = await createCompetition(request, "Vetted Open");
  let claim: ConnectClaim | null = null;
  let entry: PaidEntry | null = null;

  try {
    const org = await activeOrg(page);
    claim = await claimConnectAccount(org.id);
    const divId = await openPaidDivision(request, comp.id, {
      name: "Vetted Singles",
      entrant_kind: "individual",
      fee_cents: FEE_CENTS,
      // The whole point of this scenario. On a `manual` division
      // confirmPaidRegistration stops at `status = 'paid'` awaiting the
      // organiser and never calls materialise(), so the entry carries NO
      // entrant_id — the signal #18's first fix keyed its guard on. #18b is
      // that the identical reconcile replay therefore still read the entry
      // as "never confirmed" and refunded it in full, past the lock.
      approval: "manual",
    });

    // Same backdating as S4, same reason: the settings PUT will not accept a
    // past lock (an organiser cannot retroactively close a window through the
    // UI), and this is a state the clock reaches on its own.
    await withDb(async (sql) => {
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const rows = await sql`
        update registration_settings
        set refund_lock_at = ${past}
        where division_id = ${divId}
        returning division_id`;
      if (rows.length !== 1) {
        throw new Error(`could not backdate refund_lock_at for division ${divId} (updated ${rows.length} rows)`);
      }
    });

    entry = await enterAndPay(s, {
      orgSlug: org.slug,
      compSlug: comp.slug,
      entrantKind: "individual",
      captainName: NAME,
      captainEmail: `vetted-${TAG}@example.com`,
      shotPrefix: "s5",
    });
    const { anon, rid, token } = entry;

    // 'paid', NOT 'confirmed' — an organiser still has to say yes. If this
    // ever reads 'confirmed' the division is not actually on manual approval
    // and the rest of this scenario would be a second copy of S4.
    const paid = await waitForStatus(request, rid, token, ["paid"]);
    expect(
      paid.status,
      "S5 needs an entry that is PAID but not yet confirmed — otherwise it is not exercising the manual-approval path #18b lives on",
    ).toBe("paid");
    expect(paid.amount_cents).toBe(FEE_CENTS);

    await anon.reload({ waitUntil: "load" });
    await anon.waitForTimeout(1200);
    await anon.screenshot({ path: `${s.shots}/s5-07-status-paid-awaiting-approval.png`, fullPage: true });

    // ---- cancel, past the lock -----------------------------------------
    await anon.getByRole("button", { name: "Cancel this entry", exact: true }).first().click();
    const dialog = anon.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const dialogText = (await dialog.textContent()) ?? "";
    await anon.screenshot({ path: `${s.shots}/s5-08-cancel-dialog.png` });
    expect(
      dialogText,
      `S5: the refund window closed an hour ago, but the cancel dialog reads "${dialogText.trim()}".`,
    ).not.toMatch(/refunded automatically/);

    await dialog.getByRole("button", { name: "Cancel entry", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(anon.getByText("withdrawn", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await anon.screenshot({ path: `${s.shots}/s5-09-after-cancel.png`, fullPage: true });

    // The replay #18b rides on is fired by cancel-entry.tsx's own
    // router.refresh() immediately above, so by the time this settles the
    // wrong refund would already have happened. The wait is for a SLOW wrong
    // refund, not for a right one.
    await anon.waitForTimeout(6000);
    const after = await publicRegSnapshot(request, rid, token);
    expect(after.status, "the entry is withdrawn either way").toBe("withdrawn");
    expect(
      after.refunded_cents,
      `S5 (finding #18b): ${after.refunded_cents} cents were refunded automatically past refund_lock_at on a ` +
        `MANUAL-approval division. This entry was never materialised, so it carries no entrant_id — and a guard ` +
        `that reads entrant_id alone cannot tell "never charged" from "charged, awaiting approval, then withdrawn". ` +
        `The organiser's own refund policy was overruled.`,
    ).toBe(0);

    expect(entry.pageErrors, `page errors: ${entry.pageErrors.join(" | ")}`).toEqual([]);
    expect(entry.badResponses, `HTTP >= 400: ${entry.badResponses.join(" | ")}`).toEqual([]);
  } finally {
    await entry?.ctx.close();
    await cleanupCompetition(request, comp.id);
    await releaseConnectAccount(claim);
  }
});
