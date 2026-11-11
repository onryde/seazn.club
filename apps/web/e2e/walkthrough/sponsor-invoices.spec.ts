import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Response as PwResponse,
  type TestInfo,
} from "@playwright/test";
import { TAG, apiJson } from "../helpers";
import {
  dealUrl,
  releaseSettingsOrg,
  seedSettingsOrg,
  sponsorUrl,
  sponsorsUrl,
  tapUntil,
  type SeededOrg,
} from "../settings-support";
import { claimConnectAccount, releaseConnectAccount, withDb, type ConnectClaim } from "../rs007-money-kit";
import { fillHostedCheckout } from "../stripe-checkout-kit";
import { pdfTextRuns } from "../pdf-uris";
import { routes } from "../../src/lib/routes";

/**
 * Sponsor deals PR 3 — the invoices walkthrough. Task 21 wrote the first half (the club's invoice details on Settings → Connect);
 * Task 24 is the rest: what a SPONSOR sees. Two legs, run the way the people involved run them:
 *
 *  1. COMMUNITY (no Stripe, no paid plan — the plan that must be able to record a sponsor's cash payment and print the invoice for
 *     it, anti-goal 4). The club types its address and bank details on Settings → Connect, adds a sponsor and a package, and adds an
 *     OFFLINE deal with the sponsor's billing email from the Add deal sheet. The offline create emails nothing, so it answers no
 *     link; the club presses Resend invoice, which mints the invoice page's link (and the banner's copy button copies THAT link).
 *     The sponsor, signed out, opens it: the invoice's number, the club's address, the bank details and no pay button; the PDF says
 *     Unpaid. Resending again rotates the link (the old one is the one opaque 404, the new one opens). Mark as paid → the page and
 *     the PDF read Paid. A POST to Pay on the settled offline invoice answers 303 back to the invoice, never a dead-end screen. Two
 *     ENDED-still-due deals (an offline deal whose term ran out unpaid) carry Task 23's carries: the sponsor list's row says
 *     "Ended · unpaid" and offers Mark as paid, Write off asks first, and the invoice then reads Written off / Paid. Write off's
 *     button and confirm are captured at 320, 768 and 1280.
 *
 *  2. PRO + STRIPE CONNECT (the SANDBOX, the real connected account — opt-in, below). Add deal online sends the invoice and answers
 *     the invoice page's link, never a Checkout url. The sponsor opens it, presses Pay by card, and lands on a real Stripe Checkout
 *     session — read back at Stripe by the runner's own key, never taken on our word. A second visit pays it with the test card
 *     4242 4242 4242 4242 on Stripe's hosted page; the real PaymentIntent is then hand-delivered to our own webhook route as a
 *     correctly-signed event (the same mechanism settings-sponsor-monetize.spec.ts leg 3 documents: no forwarder is needed, and a
 *     forwarded copy is idempotent). The deal is paid and live, the invoice page reads Paid, the PDF reads Paid, the owner's one
 *     `sponsor_deal_paid` notice is queued, and Pay again answers 303 back to the invoice with no second session.
 *
 * FOUR THINGS THE BRIEF FOR THIS FILE GOT WRONG (each re-checked against the tree, AGENTS.md class 5):
 *  1. "A paid invoice's Pay -> 409 screen" is false. `pay/route.ts` turns every refusal of `payInvoice` into 303 back to the invoice
 *     page (a dead-end screen is what the route exists to avoid). Asserted as 303 + the invoice path, and the page then reads Paid.
 *  2. "The outbox row's invoice URL" cannot be read: the invoice email's body is sealed in the outbox and the console answers the
 *     link beside the deal (F11), so the link is read from the create's own answer (online) or the Resend's (offline).
 *  3. "Checkout -> a signed webhook" cannot rest on Stripe's own forwarder alone: a local run has none. The signed delivery is what
 *     makes the leg deterministic; CI's forwarder is a second, idempotent delivery of the same intent.
 *  4. Task 21's counted placeholder for the second half is replaced by the journey in leg 1 (nothing is left pending in this file).
 * Leg 2 shares the ONE Connect fixture account with registration-connect, the rs007 specs and settings-sponsor-monetize, so it claims
 * it behind the kit's advisory lock and hands it back (the afterAll's assertion), exactly like the monetize spec.
 *
 * OPT-IN (leg 2), the same gate as the other Connect walkthroughs — a counted, visible skip, never a silent green:
 *   eval "$(seazn-env env --label <l>)"; set -a; . ./apps/web/.env.local; set +a
 *   CONNECT_WALKTHROUGH=1 PLAYWRIGHT_BASE=http://localhost:<port> \
 *     npx playwright test e2e/walkthrough/sponsor-invoices.spec.ts --project=walkthrough
 *
 * `mode: "default"` for the file, for the reasons settings-org-tabs.spec.ts sets out at length: `fullyParallel: true` would run
 * each `beforeAll` — and so `seedSettingsOrg` — once per worker against a shared user bounded to five owned orgs; `serial` would
 * skip everything after the first red (AGENTS.md failure class 21). Leg 2 is the one `serial` describe: its three tests are one
 * money trail on one claimed account. Each community test makes its own sponsor, package and deal, so none leans on another.
 */
test.describe.configure({ mode: "default" });

// ---------------------------------------------------------------------------
// Gate (leg 2 only)
// ---------------------------------------------------------------------------

const ENABLED = process.env.CONNECT_WALKTHROUGH === "1";
const CONNECT_ACCOUNT = process.env.STRIPE_CONNECT_TEST_ACCOUNT ?? "";
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

/** Every missing precondition at once. Null means "nothing missing". */
const SKIP_REASON: string | null = (() => {
  const missing = [
    ENABLED ? null : "CONNECT_WALKTHROUGH=1",
    CONNECT_ACCOUNT ? null : "STRIPE_CONNECT_TEST_ACCOUNT (a fabricated account id is rejected by Stripe)",
    /^(sk|rk)_test_/.test(STRIPE_KEY) ? null : "STRIPE_SECRET_KEY (a test-mode sk_/rk_ key — the leg reads Checkout sessions back at Stripe)",
    WEBHOOK_SECRET ? null : "STRIPE_WEBHOOK_SECRET (the SAME value the server under test booted with — the leg signs the payment event)",
  ].filter((m): m is string => m !== null);
  return missing.length === 0 ? null : `opt-in: missing ${missing.join(", ")}`;
})();

// A skip is only honest if someone SEES it: Playwright's summary prints "3 skipped" with no reason attached.
if (SKIP_REASON) {
  console.warn(
    `\n  ⚠ sponsor-invoices walkthrough: the Pro + Stripe leg SKIPPED — the sponsor's card payment was NOT exercised.` +
      `\n    ${SKIP_REASON}` +
      `\n    Nothing else drives a sponsor from the invoice page's Pay by card through Stripe's hosted page to a Paid invoice.\n`,
  );
}

// ---------------------------------------------------------------------------
// Copy, budgets, small helpers
// ---------------------------------------------------------------------------

const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/** Copy read from the dictionary the page renders from, never retyped; a missing key reds loudly. `{name}` interpolates. */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sentence as a RegExp with named placeholders left open (`{amount}` is `Intl.NumberFormat` output from the BROWSER's locale,
 *  so retyping "£250.00" here would pin the runner's locale). Not anchored: a title sits inside its own element. */
function uiLike(key: string, wildcards: Record<string, string>): RegExp {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return new RegExp(escapeRe(raw).replace(/\\\{(\w+)\\\}/g, (m, k: string) => wildcards[k] ?? m));
}

/** A cold dynamic render (NAV), one authenticated round trip (SAVE), one real Stripe round trip through our server or from the runner
 *  (STRIPE) and a visit to Stripe's HOSTED page — the card form, the submit and the return — (HOSTED). A budget is derived from what a
 *  test does, never a flat literal beside a derived cost (AGENTS.md failure class 20). */
const NAV_MS = 20_000;
const SAVE_MS = 10_000;
const STRIPE_MS = 30_000;
const HOSTED_MS = 180_000;
const READ_MS = 20_000;
const budget = (c: { navs?: number; saves?: number; stripe?: number; hosted?: number }): number =>
  Math.max(
    60_000,
    15_000 + (c.navs ?? 0) * NAV_MS + (c.saves ?? 0) * SAVE_MS + (c.stripe ?? 0) * STRIPE_MS + (c.hosted ?? 0) * HOSTED_MS,
  );

/** The leg-2 `beforeAll`'s own budget (a hook carries its OWN timeout, and only `test.setTimeout` inside it raises it):
 *  `claimConnectAccount` blocks on an unbounded advisory lock, and every other holder budgets itself 600_000. */
const CONNECT_LOCK_WAIT_MS = 600_000;
const SETUP_WORK_MS = 90_000;
const SETUP_MS = CONNECT_LOCK_WAIT_MS + SETUP_WORK_MS;

const RUN = randomBytes(3).toString("hex");

interface SponsorRow {
  id: string;
  name: string;
  tier: string;
  status: string;
}
interface DealRow {
  id: string;
  sponsor_id: string | null;
  sponsor_email: string | null;
  invoice_number: number | null;
  payment_status: string;
  deal_status: string;
  ended_reason: string | null;
  amount_cents: number;
  currency: string;
}
interface DealAnswer {
  deal: DealRow;
  invoice_url: string | null;
}

const INVOICE_URL_RE = /\/r\/sponsor\/invoice\/[A-Za-z0-9_-]{20,}$/;
/** D11: "SP-" and at least four digits. The rule from the spec, not the app's own formatter. */
const numberText = (n: number): string => `SP-${String(n).padStart(4, "0")}`;
/** The path of an invoice link, so the page and the requests resolve it against the project's baseURL (AGENTS.md: BASE is localhost). */
const pathOf = (url: string): string => new URL(url).pathname;

async function createSponsor(request: APIRequestContext, orgId: string, name: string): Promise<SponsorRow> {
  const made = await apiJson<SponsorRow>(request, `/api/v1/orgs/${orgId}/sponsors`, "POST", { name, tier: "partner" });
  expect(made.status, `POST /sponsors answered ${made.status}: ${JSON.stringify(made.error)}`).toBe(201);
  return made.data!;
}

/** A Partner package, which every plan may sell (spec §10 Q1: on community every deal is Partner and org-wide). */
async function createPackage(request: APIRequestContext, orgId: string, name: string, priceCents: number): Promise<string> {
  const made = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", {
    name,
    price_cents: priceCents,
    currency: "gbp",
    tier: "partner",
  });
  expect(made.status, `POST /sponsor-packages answered ${made.status}: ${JSON.stringify(made.error)}`).toBe(201);
  return made.data!.id;
}

async function dealOf(request: APIRequestContext, orgId: string, dealId: string): Promise<DealRow> {
  const res = await apiJson<DealRow[]>(request, `/api/v1/orgs/${orgId}/sponsor-deals`);
  expect(res.status, "GET /sponsor-deals").toBe(200);
  const row = res.data?.find((d) => d.id === dealId);
  expect(row, `deal ${dealId} is readable through the API`).toBeDefined();
  return row!;
}

/** The sponsor's emails go through the outbox; the console shows none of them, so the rows are counted from the table. */
async function outboxCount(kind: string, refId: string): Promise<number> {
  return withDb(async (sql) => {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox
       where kind = ${kind} and ref_type = 'sponsor_order' and ref_id = ${refId}`;
    return row!.n;
  });
}

interface InvoiceDetailsRow {
  sponsor_invoice_address: string | null;
  sponsor_invoice_bank_details: string | null;
  payment_instructions: string | null;
}

/** `/api/orgs/[id]` has PATCH and nothing else, so the read-back goes to the columns themselves. */
async function readDetails(orgId: string): Promise<InvoiceDetailsRow> {
  return withDb(async (sql) => {
    const [row] = await sql`
      select sponsor_invoice_address, sponsor_invoice_bank_details, payment_instructions
      from organizations where id = ${orgId}`;
    if (!row) throw new Error(`readDetails: no organization ${orgId}`);
    return row as InvoiceDetailsRow;
  });
}

function card(page: Page) {
  return {
    root: page.getByTestId("sponsor-invoices-card"),
    address: page.getByTestId("sponsor-invoice-address"),
    bank: page.getByTestId("sponsor-invoice-bank-details"),
    save: page.getByTestId("sponsor-invoices-save"),
    status: page.getByTestId("sponsor-invoices-status"),
  };
}

/** A sponsor's own browser: SIGNED OUT. A bare `newContext()` inherits the project's `storageState` and would be the shared Pro
 *  organiser, who must not be the one reading the sponsor's page. Closed after each test (a `finally` inside a test never runs on a
 *  timeout). */
const opened: BrowserContext[] = [];
async function sponsorBrowser(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  opened.push(ctx);
  return { ctx, page: await ctx.newPage() };
}
test.afterEach(async () => {
  for (const ctx of opened.splice(0)) await ctx.close().catch(() => {});
});

/** No sideways scroll: the page's own scroll width never exceeds its client width, and the viewport really is the width claimed
 *  (anti-vacuity: a scan at the wrong width proves nothing). */
async function expectNoSidewaysScroll(page: Page, width: number, what: string): Promise<void> {
  const m = await page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(m.inner, `${what}: the viewport is ${width} wide`).toBe(width);
  expect(m.scroll, `${what}: scrollWidth ${m.scroll} must not exceed clientWidth ${m.client} at ${width}`).toBeLessThanOrEqual(m.client);
}

/** The invoice's PDF, fetched as the sponsor fetches it (the same token), and its text runs. */
async function pdfTexts(request: APIRequestContext, invoicePath: string): Promise<string[]> {
  const res = await request.get(`${invoicePath}/pdf`);
  expect(res.status(), "GET the invoice's /pdf").toBe(200);
  expect(res.headers()["content-type"], "the invoice PDF is a PDF").toContain("application/pdf");
  const body = await res.body();
  expect(body.subarray(0, 5).toString("latin1"), "a real PDF").toBe("%PDF-");
  const texts = pdfTextRuns(body).map((r) => r.text);
  expect(texts.length, "anti-vacuity: the PDF's text was read").toBeGreaterThan(0);
  return texts;
}

/** A POST to Pay by card, as the invoice page's form posts it, WITHOUT following the redirect. */
async function postPay(request: APIRequestContext, invoicePath: string): Promise<{ status: number; location: string }> {
  const res = await request.post(`${invoicePath}/pay`, { maxRedirects: 0, timeout: STRIPE_MS });
  return { status: res.status(), location: res.headers()["location"] ?? "" };
}

const dealAction = (page: Page, action: string): Locator =>
  page.locator(`[data-testid="deal-page-action"][data-action="${action}"]`);
const rowOf = (page: Page, sponsorId: string): Locator =>
  page.locator(`[data-testid="sponsor-row"][data-sponsor-id="${sponsorId}"]`);

/** A screenshot to the test's own output dir (never the repo), attached to the report, and proven to be a picture. */
async function capture(page: Page, testInfo: TestInfo, name: string): Promise<Buffer> {
  const path = testInfo.outputPath(`${name}.png`);
  const buf = await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
  expect(statSync(path).size, `${name}.png is a real picture`).toBeGreaterThan(1_000);
  return buf;
}

// ---------------------------------------------------------------------------
// Leg 1 — COMMUNITY: an offline invoice from the club's own details
// ---------------------------------------------------------------------------

test.describe("community: an offline invoice printed from the club's own details", () => {
  test.use({ actionTimeout: 15_000, viewport: { width: 1280, height: 900 } });

  let org: SeededOrg;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      org = await seedSettingsOrg(ctx.request, { plan: "community", label: "T24-invoices" });
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    // Released here, never in a `finally` inside a test: a Playwright `test.setTimeout` does not unwind the test function, so a
    // `finally` there never runs and a leaked seed spends one of the shared user's five owner slots for the rest of the leg.
    if (!org) return;
    const ctx = await browser.newContext();
    try {
      await releaseSettingsOrg(ctx.request, org);
    } finally {
      await ctx.close();
    }
  });

  test("invoice details save on Settings → Connect, persist across a reload, change one field at a time, and clear", async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(budget({ navs: 3, saves: 4 }));
    const c = card(page);
    const ADDRESS = "Riverside Cricket Club\n12 Mill Lane\nLeeds LS1 4AB";
    const BANK = "Riverside CC\nSort code 12-34-56\nAccount 12345678";

    // The page: a community org (no Stripe, no paid plan) still has the card, and it opens empty.
    await page.goto(routes.connect(org.slug));
    await expect(c.root, "the card is on a community org's Payments page").toBeVisible({ timeout: READ_MS });
    await expect(page.getByRole("heading", { name: ui("settings.sponsorInvoices.title") })).toBeVisible();
    await expect(page.getByText(ui("settings.sponsorInvoices.hint")), "the brief's hint").toBeVisible();
    // The accessible name is the visible label (a <label for>), so a screen reader reads the same words.
    await expect(page.getByRole("textbox", { name: ui("settings.sponsorInvoices.addressLabel") })).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: ui("settings.sponsorInvoices.bankLabel") })).toHaveCount(1);
    await expect(c.address, "opens empty: nothing stored").toHaveValue("");
    await expect(c.bank).toHaveValue("");
    await expect(c.save, "Save waits for an edit").toBeDisabled();
    expect(await readDetails(org.orgId), "precondition: both columns are null").toMatchObject({
      sponsor_invoice_address: null,
      sponsor_invoice_bank_details: null,
    });

    // Fill both. Save enabling is the proof the island has hydrated: a fill before hydration is overwritten by it, so the first
    // edit retries until the button reacts.
    await expect(async () => {
      await c.address.fill(ADDRESS);
      await expect(c.save).toBeEnabled({ timeout: 2_000 });
    }, "the first edit reaches the hydrated island").toPass({ timeout: READ_MS });
    await c.bank.fill(BANK);
    await c.save.click();
    await expect(c.status, "Saved appears when both PATCHes have answered").toHaveText(ui("settings.sponsorInvoices.saved"), {
      timeout: SAVE_MS * 2,
    });
    await expect(c.save, "pristine again after the save").toBeDisabled();

    // Not the island's echo: the columns. The registrants' offline instructions are a DIFFERENT setting and stay untouched (Q2).
    expect(await readDetails(org.orgId), "both fields stored").toEqual({
      sponsor_invoice_address: ADDRESS,
      sponsor_invoice_bank_details: BANK,
      payment_instructions: null,
    });

    // A reload opens at what was saved (the page's own read, not client state).
    await page.reload();
    await expect(c.address, "the address survives a reload").toHaveValue(ADDRESS, { timeout: READ_MS });
    await expect(c.bank, "…and so do the bank details").toHaveValue(BANK);
    await expect(c.save).toBeDisabled();

    // One field at a time: change only the bank details, and the address column is left exactly as it was.
    const NEW_BANK = "Riverside CC\nIBAN GB29 NWBK 6016 1331 9268 19\nBIC NWBKGB2L";
    await c.bank.fill(NEW_BANK);
    await expect(c.save).toBeEnabled();
    await c.save.click();
    await expect(c.status).toHaveText(ui("settings.sponsorInvoices.saved"), { timeout: SAVE_MS * 2 });
    expect(await readDetails(org.orgId), "only the bank details moved").toMatchObject({
      sponsor_invoice_address: ADDRESS,
      sponsor_invoice_bank_details: NEW_BANK,
    });

    // Clearing a field stores nothing (null), never an empty string, and the other field stays.
    await c.address.fill("");
    await expect(c.save).toBeEnabled();
    await c.save.click();
    await expect(c.status).toHaveText(ui("settings.sponsorInvoices.saved"), { timeout: SAVE_MS * 2 });
    expect(await readDetails(org.orgId), "the address is cleared to null, the bank details stay").toMatchObject({
      sponsor_invoice_address: null,
      sponsor_invoice_bank_details: NEW_BANK,
    });
    await page.reload();
    await expect(c.address, "a cleared address reopens empty").toHaveValue("", { timeout: READ_MS });
    await expect(c.bank).toHaveValue(NEW_BANK);
  });

  test("an offline deal's invoice: the saved details print on it, there is no pay button, Resend rotates the link, Mark as paid reads Paid", async ({
    page,
    browser,
    request,
  }: {
    page: Page;
    browser: Browser;
    request: APIRequestContext;
  }) => {
    test.setTimeout(budget({ navs: 9, saves: 10 }));
    // Unique to this run and to this test, so the Save below is a real change whatever an earlier test left on the org.
    const ADDRESS = `Marsh Lane Cricket Club ${RUN}\n7 Quay Road\nBristol BS1 5TT`;
    const BANK = `Marsh Lane CC ${RUN}\nSort code 20-45-45\nAccount 87654321`;
    const SPONSOR_NAME = `Harbour Chandlers ${RUN}`;
    const SPONSOR_EMAIL = `delivered+inv-offline-${TAG}-${RUN}@resend.dev`;
    const PACKAGE_NAME = `Partner board ${TAG}-${RUN}`;
    const PRICE_CENTS = 25_000;

    // 1. Settings → Connect: the club's details, typed into the card and saved, then read back from the COLUMNS.
    const c = card(page);
    await page.goto(routes.connect(org.slug));
    await expect(c.root).toBeVisible({ timeout: READ_MS });
    await expect(async () => {
      await c.address.fill(ADDRESS);
      await expect(c.save).toBeEnabled({ timeout: 2_000 });
    }, "the first edit reaches the hydrated island").toPass({ timeout: READ_MS });
    await c.bank.fill(BANK);
    await c.save.click();
    await expect(c.status).toHaveText(ui("settings.sponsorInvoices.saved"), { timeout: SAVE_MS * 2 });
    expect(await readDetails(org.orgId), "the details are stored").toMatchObject({
      sponsor_invoice_address: ADDRESS,
      sponsor_invoice_bank_details: BANK,
    });

    // 2. A sponsor and a package (the API: their own forms are other specs' subject), then Add deal on the sponsor's page.
    const sponsor = await createSponsor(request, org.orgId, SPONSOR_NAME);
    const packageId = await createPackage(request, org.orgId, PACKAGE_NAME, PRICE_CENTS);
    await page.goto(sponsorUrl(org.slug, sponsor.id));
    const sheet = page.getByTestId("add-deal-sheet");
    await tapUntil(page.getByTestId("sponsor-sheet-add-deal"), sheet, "Add deal opens the sheet over the sponsor's page");
    await expect(page.getByTestId(`add-deal-package-${packageId}`), "the one package on sale is the one picked").toBeChecked();
    await expect(page.getByTestId("add-deal-payment-offline"), "a community org opens on Offline").toBeChecked();
    await expect(page.getByTestId("add-deal-payment-online"), "…with Online locked").toBeDisabled();
    await expect(page.getByTestId("add-deal-payment-link-online"), "…and the way to unlock it").toBeVisible();
    const submit = page.getByTestId("add-deal-submit");
    await expect(submit, "an offline deal that waits for its payment is saved, not sent").toHaveText(
      ui("sponsors.dealSheet.primary.saveDeal"),
    );
    await page.getByTestId("add-deal-email").fill(SPONSOR_EMAIL);
    await expect(submit).toBeEnabled();
    const [created] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${sponsor.id}/deals`) && r.request().method() === "POST",
        { timeout: SAVE_MS * 2 },
      ),
      submit.click(),
    ]);
    expect(created.status(), `POST /sponsors/{id}/deals answered ${created.status()}: ${await created.text()}`).toBe(201);
    const createdBody = (await created.json()) as { data?: DealAnswer };
    expect(createdBody.data?.invoice_url, "an offline create emails nothing, so it answers no link").toBeNull();
    const dealId = createdBody.data?.deal.id ?? "";
    expect(dealId, "the create answers its deal").not.toBe("");

    const numbered = await dealOf(request, org.orgId, dealId);
    expect(
      Number.isInteger(numbered.invoice_number) && (numbered.invoice_number ?? 0) >= 1,
      "an offline deal is numbered at create",
    ).toBe(true);
    const invoiceNo = numberText(numbered.invoice_number!);
    expect(numbered.sponsor_email).toBe(SPONSOR_EMAIL);
    expect(numbered.payment_status, "nothing is paid yet").toBe("pending");
    expect(await outboxCount("sponsor_invoice", dealId), "an offline create sent no invoice email").toBe(0);

    await expect(sheet, "the deal is made: the sheet closes").toHaveCount(0);
    await expect(page.getByTestId("sponsor-notice")).toHaveText(ui("sponsors.dealSheet.notice.saved", { name: SPONSOR_NAME }));
    const deal = page.locator(`[data-testid="sponsor-sheet-deal"][data-deal-id="${dealId}"]`);
    await expect(deal.getByTestId("deal-chip")).toHaveText(ui("sponsors.deal.chip.awaitingPayment"));
    await expect(page.getByTestId("sponsor-pay-link"), "no link yet: nothing was sent").toHaveCount(0);
    const resend = deal.locator('[data-testid="sponsor-sheet-deal-action"][data-action="resend_invoice"]');
    await expect(resend, "an offline deal with a billing email offers Resend invoice").toHaveText(ui("sponsors.deal.action.resendInvoice"));

    // 3. Resend invoice: the first send of an offline deal. It answers the invoice page's link; the banner shows it and its copy
    //    button copies THAT link (T23 review I1: never a Checkout url).
    const sendResponse = (): Promise<PwResponse> =>
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-deals/${dealId}/send-invoice`) && r.request().method() === "POST",
        { timeout: SAVE_MS * 2 },
      );
    const [firstSend] = await Promise.all([sendResponse(), resend.click()]);
    expect(firstSend.status(), `POST send-invoice answered ${firstSend.status()}`).toBeLessThan(300);
    const firstUrl = ((await firstSend.json()) as { data?: DealAnswer }).data?.invoice_url ?? "";
    expect(firstUrl, "the send answers the invoice page's link").toMatch(INVOICE_URL_RE);
    await expect(page.getByTestId("sponsor-notice"), "an offline deal's first send replaces nothing").toHaveText(
      ui("sponsors.deal.notice.invoiceSent", { name: SPONSOR_NAME }),
    );
    await expect(page.getByTestId("sponsor-pay-link-url"), "the banner shows the invoice page's link").toHaveText(firstUrl);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: ui("sponsors.deal.payLink.copy") }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { message: "Copy invoice link copies the invoice page's link" })
      .toBe(firstUrl);
    expect(await outboxCount("sponsor_invoice", dealId), "the send queued one invoice email").toBe(1);

    // 4. The sponsor, signed out: the invoice page.
    const firstPath = pathOf(firstUrl);
    const sponsorSide = await sponsorBrowser(browser);
    const inv = sponsorSide.page;
    const firstOpen = await inv.goto(firstPath);
    expect(firstOpen?.status(), "the invoice link opens").toBe(200);
    await expect(inv.getByTestId("sponsor-invoice")).toBeVisible({ timeout: READ_MS });
    await expect(inv.getByTestId("invoice-number"), "numbered SP- and four digits, from the deal's own number").toHaveText(invoiceNo);
    await expect(inv.getByTestId("invoice-org"), "from the club").toHaveText(org.name);
    await expect(inv.getByTestId("sponsor-invoice"), "the club's saved address is printed").toContainText(ADDRESS);
    await expect(inv.getByTestId("invoice-billed-to")).toHaveText(SPONSOR_NAME);
    await expect(inv.getByTestId("invoice-line")).toContainText(PACKAGE_NAME);
    await expect(inv.getByTestId("invoice-total")).toContainText(/250[.,]00/);
    await expect(inv.getByTestId("invoice-state"), "unpaid").toHaveAttribute("data-state", "unpaid");
    await expect(inv.getByTestId("invoice-state")).toHaveText(ui("sponsors.invoice.state.unpaid"));
    await expect(inv.getByTestId("invoice-state-note"), "an unpaid invoice carries no state note").toHaveCount(0);
    await expect(inv.getByTestId("invoice-bank"), "the saved bank details are printed").toContainText(BANK);
    await expect(inv.getByTestId("invoice-bank"), "…with the number to pay against").toContainText(invoiceNo);
    await expect(inv.getByTestId("invoice-pay"), "an offline invoice has NO pay button").toHaveCount(0);
    await expect(inv.getByTestId("invoice-card-unavailable"), "…and no 'card isn't available' note: it was never a card invoice").toHaveCount(0);
    await expect(inv.getByTestId("invoice-pdf")).toHaveAttribute("href", /\/pdf$/);
    // At 320: no sideways scroll.
    await inv.setViewportSize({ width: 320, height: 740 });
    await inv.goto(firstPath);
    await expect(inv.getByTestId("invoice-bank")).toBeVisible({ timeout: READ_MS });
    await expectNoSidewaysScroll(inv, 320, "the unpaid offline invoice");
    // The PDF is the same invoice: its number and the Unpaid stamp.
    const unpaidTexts = await pdfTexts(sponsorSide.ctx.request, firstPath);
    expect(unpaidTexts, "the PDF prints the invoice number").toContain(invoiceNo);
    expect(unpaidTexts, "the PDF is stamped Unpaid").toContain(ui("sponsors.invoice.state.unpaid"));
    expect(unpaidTexts, "…and is not stamped Paid").not.toContain(ui("sponsors.invoice.state.paid"));
    // Pay by card on an offline invoice mints nothing: 303 back to the invoice page.
    const unpaidPay = await postPay(sponsorSide.ctx.request, firstPath);
    expect(unpaidPay.status, "Pay on an offline invoice answers 303").toBe(303);
    expect(new URL(unpaidPay.location, "http://x").pathname, "…back to the invoice page").toBe(firstPath);
    expect(unpaidPay.location, "…and never to Stripe").not.toContain("stripe.com");

    // 5. Rotation: the club sends it again; the earlier link now opens nothing and the new one opens.
    const [secondSend] = await Promise.all([sendResponse(), resend.click()]);
    expect(secondSend.status(), `POST send-invoice (again) answered ${secondSend.status()}`).toBeLessThan(300);
    const secondUrl = ((await secondSend.json()) as { data?: DealAnswer }).data?.invoice_url ?? "";
    expect(secondUrl, "the second send answers a link").toMatch(INVOICE_URL_RE);
    expect(secondUrl, "each send mints a NEW link").not.toBe(firstUrl);
    await expect(page.getByTestId("sponsor-notice"), "a deal already sent says 'sent again'").toHaveText(
      ui("sponsors.deal.notice.invoiceResent", { name: SPONSOR_NAME }),
    );
    await expect(page.getByTestId("sponsor-pay-link-url")).toHaveText(secondUrl);
    expect(await outboxCount("sponsor_invoice", dealId), "a resend is a new invoice email").toBe(2);
    const secondPath = pathOf(secondUrl);
    await inv.setViewportSize({ width: 1280, height: 900 });
    const stale = await inv.goto(firstPath);
    expect(stale?.status(), "the rotated link opens nothing: 404").toBe(404);
    await expect(inv.getByTestId("sponsor-invoice-not-found"), "…on the one opaque not-found page").toBeVisible();
    await expect(inv.getByTestId("sponsor-invoice"), "…and not the invoice").toHaveCount(0);
    const stalePdf = await sponsorSide.ctx.request.get(`${firstPath}/pdf`);
    expect(stalePdf.status(), "the rotated link's PDF is gone too").toBe(404);
    const fresh = await inv.goto(secondPath);
    expect(fresh?.status(), "the new link opens").toBe(200);
    await expect(inv.getByTestId("invoice-number"), "the same invoice, the same number").toHaveText(invoiceNo);
    await expect(inv.getByTestId("invoice-state")).toHaveAttribute("data-state", "unpaid");

    // 6. Mark as paid, behind its confirm: the deal follows its go-live rule (live) and the invoice reads Paid.
    await deal.locator('[data-testid="sponsor-sheet-deal-action"][data-action="mark_paid"]').click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText(uiLike("sponsors.deal.markPaid.title", { amount: ".+?", name: escapeRe(SPONSOR_NAME) }))).toBeVisible();
    await expect(dialog.getByText(ui("sponsors.deal.markPaid.body"))).toBeVisible();
    const [marked] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-deals/${dealId}/mark-paid`) && r.request().method() === "POST",
        { timeout: SAVE_MS * 2 },
      ),
      dialog.getByRole("button", { name: ui("sponsors.deal.action.markPaid") }).click(),
    ]);
    expect(marked.status(), `POST mark-paid answered ${marked.status()}`).toBeLessThan(300);
    await expect(deal.getByTestId("deal-chip"), "a paid on-payment deal is live").toHaveText(ui("sponsors.deal.chip.live"));
    await expect(page.getByTestId("sponsor-pay-link"), "a paid deal has no link left to share").toHaveCount(0);
    const paidRow = await dealOf(request, org.orgId, dealId);
    expect([paidRow.payment_status, paidRow.deal_status]).toEqual(["paid", "live"]);

    await inv.reload();
    await expect(inv.getByTestId("invoice-state"), "the page now reads Paid").toHaveAttribute("data-state", "paid");
    await expect(inv.getByTestId("invoice-state")).toHaveText(ui("sponsors.invoice.state.paid"));
    await expect(inv.getByTestId("invoice-state-note")).toHaveText(ui("sponsors.invoice.stateNote.paid"));
    await expect(inv.getByTestId("invoice-bank"), "a paid invoice no longer asks for a transfer").toHaveCount(0);
    await expect(inv.getByTestId("invoice-pay")).toHaveCount(0);
    const paidTexts = await pdfTexts(sponsorSide.ctx.request, secondPath);
    expect(paidTexts, "the PDF reads Paid").toContain(ui("sponsors.invoice.state.paid"));
    expect(paidTexts, "…and no longer Unpaid").not.toContain(ui("sponsors.invoice.state.unpaid"));
    const settledPay = await postPay(sponsorSide.ctx.request, secondPath);
    expect(settledPay.status, "Pay on a settled offline invoice answers 303, never a dead-end screen").toBe(303);
    expect(new URL(settledPay.location, "http://x").pathname, "…back to the invoice").toBe(secondPath);
    await inv.setViewportSize({ width: 320, height: 740 });
    await inv.goto(secondPath);
    await expect(inv.getByTestId("invoice-state")).toBeVisible({ timeout: READ_MS });
    await expectNoSidewaysScroll(inv, 320, "the paid offline invoice");
  });

  /** An OFFLINE deal that went live and then ended unpaid because its term ran out: the invoice is still due (Task 23's carries 1
   *  and 4). Made the way a club makes it — sponsor, package, deal, an invoice sent — and then the term ends. There is no UI for the
   *  term running out (the daily sweep ends it), so that one step is SQL, named as such. */
  async function seedEndedDueDeal(request: APIRequestContext, label: string) {
    const name = `${label} ${RUN}`;
    const email = `delivered+inv-${label.toLowerCase().replace(/\W+/g, "")}-${TAG}-${RUN}@resend.dev`;
    const sponsor = await createSponsor(request, org.orgId, name);
    const packageId = await createPackage(request, org.orgId, `${label} board ${TAG}-${RUN}`, 18_000);
    const made = await apiJson<DealAnswer>(request, `/api/v1/orgs/${org.orgId}/sponsors/${sponsor.id}/deals`, "POST", {
      package_id: packageId,
      competition_id: null,
      payment_method: "offline",
      go_live: "immediate",
      sponsor_email: email,
      end_current: false,
    });
    expect(made.status, `POST deals answered ${made.status}: ${JSON.stringify(made.error)}`).toBe(201);
    const dealId = made.data!.deal.id;
    expect(made.data!.deal.deal_status, "premise: an immediate offline deal is live at once").toBe("live");
    const sent = await apiJson<DealAnswer>(request, `/api/v1/orgs/${org.orgId}/sponsor-deals/${dealId}/send-invoice`, "POST");
    expect(sent.status, `POST send-invoice answered ${sent.status}`).toBeLessThan(300);
    const invoiceUrl = sent.data?.invoice_url ?? "";
    expect(invoiceUrl, "the send answers the invoice page's link").toMatch(INVOICE_URL_RE);
    const ended = await withDb(
      (sql) => sql`
        update sponsor_orders set deal_status = 'ended', ended_reason = 'expired', ended_at = now()
         where id = ${dealId} and deal_status = 'live'
        returning id`,
    );
    expect(ended, "the term ran out on the one live deal").toHaveLength(1);
    const row = await dealOf(request, org.orgId, dealId);
    expect([row.deal_status, row.payment_status, row.ended_reason], "premise: ended, unpaid, expired").toEqual(["ended", "pending", "expired"]);
    return { sponsor, name, dealId, invoicePath: pathOf(invoiceUrl) };
  }

  test("an offline deal that ended unpaid: the row says so, Write off asks first, and the invoice then reads Written off", async (
    { page, browser, request }: { page: Page; browser: Browser; request: APIRequestContext },
    testInfo: TestInfo,
  ) => {
    test.setTimeout(budget({ navs: 9, saves: 6 }));
    const { sponsor, name, dealId, invoicePath } = await seedEndedDueDeal(request, "Wharf Printers");
    const sponsorSide = await sponsorBrowser(browser);
    const inv = sponsorSide.page;

    // The sponsor's view before: still due, and says the sponsorship has ended. A card cannot pay an offline invoice.
    await inv.goto(invoicePath);
    await expect(inv.getByTestId("invoice-state"), "an ended deal still due reads Unpaid").toHaveAttribute("data-state", "unpaid");
    await expect(inv.getByTestId("invoice-state-note")).toHaveText(ui("sponsors.invoice.stateNote.endedDue"));
    await expect(inv.getByTestId("invoice-pay")).toHaveCount(0);

    // The club's sponsor list: the row names it (Task 23 carry: not just "Ended") and offers Mark as paid.
    await page.goto(sponsorsUrl(org.slug, "sponsors"));
    const row = rowOf(page, sponsor.id);
    await expect(row, "the sponsor is on the list").toBeVisible({ timeout: READ_MS });
    await expect(row.getByTestId("deal-chip"), "the row's chip says it ended unpaid").toHaveText(ui("sponsors.deal.chip.endedUnpaid"));
    await expect(row.getByTestId("sponsor-row-action"), "the row's one next step is Mark as paid").toHaveAttribute("data-action", "mark_paid");
    await expect(row.getByTestId("sponsor-row-action")).toHaveText(ui("sponsors.deal.action.markPaid"));

    // The deal's page, at 320, 768 and 1280: Write off is there, asks first, and its confirm is tappable.
    const shots: Buffer[] = [];
    for (const [width, height] of [[320, 740], [768, 1000], [1280, 900]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(dealUrl(org.slug, sponsor.id, dealId));
      await expect(page.getByTestId("deal-page"), `the deal's page opens at ${width}`).toBeVisible({ timeout: READ_MS });
      await expect(page.getByTestId("deal-page").getByTestId("deal-chip")).toHaveText(ui("sponsors.deal.chip.endedUnpaid"));
      const writeOff = dealAction(page, "write_off");
      await expect(writeOff, `Write off is on the page at ${width}`).toBeVisible();
      await expect(dealAction(page, "mark_paid"), "…beside Mark as paid").toBeVisible();
      await expectNoSidewaysScroll(page, width, "the deal's page");
      shots.push(await capture(page, testInfo, `deal-write-off-button-${width}`));

      const dialog = page.getByRole("alertdialog");
      await tapUntil(writeOff, dialog, "Write off asks before it does anything");
      await expect(dialog.getByText(uiLike("sponsors.deal.confirm.writeOff.title", { amount: ".+?", name: escapeRe(name) }))).toBeVisible();
      await expect(dialog.getByText(ui("sponsors.deal.confirm.writeOff.body", { name }))).toBeVisible();
      const confirmButton = dialog.getByRole("button", { name: uiLike("sponsors.deal.confirm.writeOff.label", { amount: ".+?" }) });
      await expect(confirmButton, `the confirm button is on screen at ${width}`).toBeVisible();
      const tappable = await confirmButton.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top !== null && el.contains(top);
      });
      expect(tappable, `the confirm button is tappable (hit-tested) at ${width}`).toBe(true);
      shots.push(await capture(page, testInfo, `deal-write-off-confirm-${width}`));
      await page.keyboard.press("Escape");
      await expect(dialog, "Escape declines").toHaveCount(0);
    }
    expect(shots, "anti-vacuity: three widths, a button and a confirm each").toHaveLength(6);
    expect(new Set(shots.map((b) => b.toString("base64"))).size, "the six pictures all differ (the confirm really opened)").toBe(6);
    expect((await dealOf(request, org.orgId, dealId)).ended_reason, "declining wrote nothing off").toBe("expired");

    // Now do it, at 1280: confirm, and the invoice stops asking.
    const dialog = page.getByRole("alertdialog");
    await tapUntil(dealAction(page, "write_off"), dialog, "Write off asks first");
    const [wrote] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-deals/${dealId}/write-off`) && r.request().method() === "POST",
        { timeout: SAVE_MS * 2 },
      ),
      dialog.getByRole("button", { name: uiLike("sponsors.deal.confirm.writeOff.label", { amount: ".+?" }) }).click(),
    ]);
    expect(wrote.status(), `POST write-off answered ${wrote.status()}`).toBeLessThan(300);
    await expect(dealAction(page, "write_off"), "nothing left to write off").toHaveCount(0);
    await expect(page.getByTestId("deal-page").getByTestId("deal-chip")).toHaveText(ui("sponsors.deal.chip.ended"));
    const after = [
      ...(await withDb(
        (sql) => sql<{ ended_reason: string; status: string }[]>`select ended_reason, status from sponsor_orders where id = ${dealId}`,
      )),
    ];
    expect(after, "the money stays unpaid, and the reason says why nothing is owed").toEqual([{ ended_reason: "written_off", status: "pending" }]);

    await inv.reload();
    await expect(inv.getByTestId("invoice-state"), "the invoice reads Written off").toHaveAttribute("data-state", "written_off");
    await expect(inv.getByTestId("invoice-state")).toHaveText(ui("sponsors.invoice.state.writtenOff"));
    await expect(inv.getByTestId("invoice-state-note")).toHaveText(ui("sponsors.invoice.stateNote.writtenOff", { club: org.name }));
    await expect(inv.getByTestId("invoice-bank"), "a written-off invoice asks for nothing").toHaveCount(0);
    await expect(inv.getByTestId("invoice-pay")).toHaveCount(0);
    const texts = await pdfTexts(sponsorSide.ctx.request, invoicePath);
    expect(texts, "the PDF reads Written off").toContain(ui("sponsors.invoice.state.writtenOff"));
    expect(texts, "…and no longer Unpaid").not.toContain(ui("sponsors.invoice.state.unpaid"));
  });

  test("an offline deal that ended unpaid: Mark as paid keeps it ended, and the invoice reads Paid", async ({
    page,
    browser,
    request,
  }: {
    page: Page;
    browser: Browser;
    request: APIRequestContext;
  }) => {
    test.setTimeout(budget({ navs: 5, saves: 4 }));
    const { sponsor, name, dealId, invoicePath } = await seedEndedDueDeal(request, "Dockside Marine");

    await page.goto(sponsorsUrl(org.slug, "sponsors"));
    const row = rowOf(page, sponsor.id);
    await expect(row.getByTestId("deal-chip")).toHaveText(ui("sponsors.deal.chip.endedUnpaid"), { timeout: READ_MS });
    const action = row.getByTestId("sponsor-row-action");
    await expect(action).toHaveAttribute("data-action", "mark_paid");
    const dialog = page.getByRole("alertdialog");
    await tapUntil(action, dialog, "the row's Mark as paid asks first");
    await expect(dialog.getByText(uiLike("sponsors.deal.markPaid.title", { amount: ".+?", name: escapeRe(name) }))).toBeVisible();
    await expect(dialog.getByText(ui("sponsors.deal.markPaid.bodyEnded")), "an ended deal is told it stays ended").toBeVisible();
    const [marked] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsor-deals/${dealId}/mark-paid`) && r.request().method() === "POST",
        { timeout: SAVE_MS * 2 },
      ),
      dialog.getByRole("button", { name: ui("sponsors.deal.action.markPaid") }).click(),
    ]);
    expect(marked.status(), `POST mark-paid answered ${marked.status()}`).toBeLessThan(300);

    const paid = await dealOf(request, org.orgId, dealId);
    expect([paid.deal_status, paid.payment_status], "it stays ended, and is now paid").toEqual(["ended", "paid"]);
    await expect(row.getByTestId("deal-chip"), "the row reads plain Ended once paid").toHaveText(ui("sponsors.deal.chip.ended"));
    await expect(row.getByTestId("deal-chip"), "the row no longer says unpaid").not.toHaveText(ui("sponsors.deal.chip.endedUnpaid"));

    const sponsorSide = await sponsorBrowser(browser);
    await sponsorSide.page.goto(invoicePath);
    await expect(sponsorSide.page.getByTestId("invoice-state"), "the invoice reads Paid").toHaveAttribute("data-state", "paid");
    await expect(sponsorSide.page.getByTestId("invoice-state-note")).toHaveText(ui("sponsors.invoice.stateNote.paid"));
    const texts = await pdfTexts(sponsorSide.ctx.request, invoicePath);
    expect(texts, "the PDF reads Paid").toContain(ui("sponsors.invoice.state.paid"));
    expect(texts).not.toContain(ui("sponsors.invoice.state.unpaid"));
  });
});

// ---------------------------------------------------------------------------
// Leg 2 — PRO + STRIPE CONNECT: Pay by card on the sandbox
// ---------------------------------------------------------------------------

test.describe("Pro + Stripe Connect: Pay by card on the invoice page, through Stripe's sandbox, to a Paid invoice", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ actionTimeout: 15_000, viewport: { width: 1280, height: 900 } });

  const PRICE_CENTS = 250;
  const ADDRESS = `Quayside Sports Club ${RUN}\n3 Dock Road\nLiverpool L3 4BP`;
  const BANK = `Quayside SC ${RUN}\nSort code 40-11-22\nAccount 11223344`;
  const SPONSOR_NAME = `Pier Outfitters ${RUN}`;
  const SPONSOR_EMAIL = `delivered+inv-online-${TAG}-${RUN}@resend.dev`;
  const PACKAGE_NAME = `Pro partner board ${TAG}-${RUN}`;

  let org: SeededOrg;
  let claim: ConnectClaim | null = null;
  let restoredHolder: string | null = null;
  let restoreRan = false;
  /** `billing_events` has no org FK and `releaseSeededOrgSql` only SOFT-deletes, so the delivered event outlives the org. */
  const strayEventIds: string[] = [];

  // The money trail's state, written by test 1 and read by tests 2 and 3 (serial).
  let sponsorId = "";
  let dealId = "";
  let invoiceLink = "";
  let invoiceNo = "";
  let firstSessionId = "";

  const runnerStripe = (): Stripe => new Stripe(STRIPE_KEY);

  test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
    // FIRST STATEMENT, before the skip and before any await: the hook's default 60s cannot outlast a lock holder that budgets 600s.
    test.setTimeout(SETUP_MS);
    test.skip(SKIP_REASON !== null, SKIP_REASON ?? "");
    org = await seedSettingsOrg(request, { plan: "pro", label: "T24-invoices-pro" });
    claim = await claimConnectAccount(org.orgId);
    console.log(`CONNECT>>> ${CONNECT_ACCOUNT} taken from ${claim.priorId ?? "nobody"} for ${org.slug}`);
    // The club's details: BOTH set, so the online invoice's page proves the address prints and the bank details do NOT (a card
    // invoice asks for a card, not a transfer). One PATCH per field, as the Settings card sends them.
    for (const body of [{ sponsor_invoice_address: ADDRESS }, { sponsor_invoice_bank_details: BANK }]) {
      const saved = await apiJson(request, `/api/orgs/${org.orgId}`, "PATCH", body);
      expect(saved.status, `PATCH /api/orgs/{id} ${Object.keys(body)[0]} answered ${saved.status}`).toBe(200);
    }
  });

  test.afterAll(async ({ request }: { request: APIRequestContext }) => {
    // ORDER IS LOAD-BEARING (settings-sponsor-monetize.spec.ts): the fixture is detached BEFORE the org is released, or a
    // soft-deleted org keeps the account forever. Each step is independently guarded so one failure cannot strand the next.
    restoredHolder = await releaseConnectAccount(claim);
    if (claim) restoreRan = true;
    for (const id of strayEventIds) {
      await withDb((sql) => sql`delete from billing_events where id = ${id}`).catch(() => {});
    }
    if (org) await releaseSettingsOrg(request, org).catch(() => {});
    // Asserted LAST, so a broken restoration is reported without having skipped the rest of the teardown.
    if (restoreRan) {
      expect(
        restoredHolder,
        `the Connect fixture ${CONNECT_ACCOUNT} was NOT handed back to its prior holder — every other Connect spec in this repo is now broken until this is repaired by hand`,
      ).toBe(claim?.priorId ?? null);
    }
  });

  test("online: Add deal sends the invoice page's link; the page prints the club's address and no bank details; Pay by card reaches a real Stripe Checkout session", async ({
    page,
    browser,
    request,
  }: {
    page: Page;
    browser: Browser;
    request: APIRequestContext;
  }) => {
    test.setTimeout(budget({ navs: 5, saves: 2, stripe: 3 }));
    const sponsor = await createSponsor(request, org.orgId, SPONSOR_NAME);
    sponsorId = sponsor.id;
    const packageId = await createPackage(request, org.orgId, PACKAGE_NAME, PRICE_CENTS);

    await page.goto(sponsorUrl(org.slug, sponsorId));
    const sheet = page.getByTestId("add-deal-sheet");
    await tapUntil(page.getByTestId("sponsor-sheet-add-deal"), sheet, "Add deal opens the sheet over the sponsor's page");
    await expect(page.getByTestId(`add-deal-package-${packageId}`), "the one package on sale is the one picked").toBeChecked();
    await expect(page.getByTestId("add-deal-payment-online"), "Pro + a charge-ready account opens on Online").toBeChecked();
    const send = page.getByTestId("add-deal-submit");
    await expect(send, "the button names what it does").toHaveText(ui("sponsors.deal.action.sendInvoice"));
    await page.getByTestId("add-deal-email").fill(SPONSOR_EMAIL);
    await expect(send).toBeEnabled();
    const [sent] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${sponsorId}/deals`) && r.request().method() === "POST",
        { timeout: STRIPE_MS },
      ),
      send.click(),
    ]);
    expect(sent.status(), `POST /sponsors/{id}/deals answered ${sent.status()}: ${await sent.text()}`).toBe(201);
    const answer = ((await sent.json()) as { data?: DealAnswer }).data;
    invoiceLink = answer?.invoice_url ?? "";
    dealId = answer?.deal.id ?? "";
    expect(invoiceLink, "the create answers the invoice page's link").toMatch(INVOICE_URL_RE);
    expect(invoiceLink, "never a Checkout url: no raw Stripe link reaches the club or the sponsor").not.toContain("checkout.stripe");
    expect(dealId).not.toBe("");
    const row = await dealOf(request, org.orgId, dealId);
    expect(row.invoice_number, "an online deal is numbered at create").not.toBeNull();
    invoiceNo = numberText(row.invoice_number!);
    expect([row.deal_status, row.payment_status], "an unpaid on-payment deal awaits its payment").toEqual(["awaiting_payment", "pending"]);

    // The console's "copy link" copies the INVOICE PAGE (T23 review I1), and the page says an invoice was sent.
    await expect(page.getByTestId("sponsor-notice")).toHaveText(ui("sponsors.deal.notice.invoiceSent", { name: SPONSOR_NAME }));
    await expect(page.getByTestId("sponsor-pay-link-url"), "the banner shows the invoice page's link").toHaveText(invoiceLink);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: ui("sponsors.deal.payLink.copy") }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { message: "Copy invoice link copies the invoice page's link" })
      .toBe(invoiceLink);

    // The sponsor, signed out: an UNPAID invoice with a Pay by card button, the club's address, and no bank details.
    const path = pathOf(invoiceLink);
    const sponsorSide = await sponsorBrowser(browser);
    const inv = sponsorSide.page;
    await inv.goto(path);
    await expect(inv.getByTestId("sponsor-invoice")).toBeVisible({ timeout: READ_MS });
    await expect(inv.getByTestId("invoice-number")).toHaveText(invoiceNo);
    await expect(inv.getByTestId("invoice-state")).toHaveAttribute("data-state", "unpaid");
    await expect(inv.getByTestId("invoice-billed-to")).toHaveText(SPONSOR_NAME);
    await expect(inv.getByTestId("invoice-line")).toContainText(PACKAGE_NAME);
    await expect(inv.getByTestId("invoice-total")).toContainText(/2[.,]50/);
    await expect(inv.getByTestId("sponsor-invoice"), "the club's saved address is printed").toContainText(ADDRESS);
    await expect(inv.getByTestId("invoice-bank"), "bank details are set and still NOT printed on a card invoice").toHaveCount(0);
    await expect(inv.getByTestId("invoice-pay"), "a card invoice has Pay by card").toBeVisible();
    await expect(inv.getByRole("button", { name: ui("sponsors.invoice.payByCard") })).toBeEnabled();
    await expect(inv.getByTestId("invoice-card-unavailable")).toHaveCount(0);
    await inv.setViewportSize({ width: 320, height: 740 });
    await inv.goto(path);
    await expect(inv.getByTestId("invoice-pay")).toBeVisible({ timeout: READ_MS });
    await expectNoSidewaysScroll(inv, 320, "the unpaid online invoice");
    await inv.setViewportSize({ width: 1280, height: 900 });
    await inv.goto(path);

    // Pay by card, in the browser: the form posts, the route answers 303 to Stripe, and the browser lands on the hosted page.
    await Promise.all([
      inv.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { waitUntil: "commit", timeout: STRIPE_MS }),
      inv.getByRole("button", { name: ui("sponsors.invoice.payByCard") }).click(),
    ]);
    firstSessionId = /\/(cs_test_[A-Za-z0-9]+)/.exec(inv.url())?.[1] ?? "";
    expect(firstSessionId, "the hosted page names a test-mode Checkout session").not.toBe("");

    // Read back AT STRIPE, by the runner's own key, never taken on our word: open, one payment, the package's price in its currency,
    // addressed to the typed email, and carrying the metadata the webhook finds the deal by.
    const session = await runnerStripe().checkout.sessions.retrieve(firstSessionId);
    expect(session.status, "the session is open: payable").toBe("open");
    expect(session.mode, "one payment").toBe("payment");
    expect(session.amount_total, "priced from the package").toBe(PRICE_CENTS);
    expect(session.currency).toBe("gbp");
    expect(session.customer_email, "addressed to the email the sheet sent").toBe(SPONSOR_EMAIL);
    expect(session.metadata, "the metadata the payment webhook reads").toMatchObject({ kind: "sponsor", order_id: dealId, org_id: org.orgId });
    expect((await dealOf(request, org.orgId, dealId)).payment_status, "visiting Checkout paid nothing").toBe("pending");
  });

  test("paid: the test card on Stripe's hosted page, a signed webhook, and the invoice reads Paid", async ({
    browser,
    request,
  }: {
    browser: Browser;
    request: APIRequestContext;
  }) => {
    test.setTimeout(budget({ navs: 5, saves: 2, stripe: 4, hosted: 1 }));
    expect(dealId, "test 1 must have sent the invoice").not.toBe("");
    const stripe = runnerStripe();
    const path = pathOf(invoiceLink);
    const sponsorSide = await sponsorBrowser(browser);
    const inv = sponsorSide.page;

    // The sponsor presses Pay by card AGAIN: the open session is reused (one reuse-or-mint rule, F32), so the hosted page is the same.
    await inv.goto(path);
    await Promise.all([
      inv.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { waitUntil: "commit", timeout: STRIPE_MS }),
      inv.getByRole("button", { name: ui("sponsors.invoice.payByCard") }).click(),
    ]);
    const sessionId = /\/(cs_test_[A-Za-z0-9]+)/.exec(inv.url())?.[1] ?? "";
    expect(sessionId, "the second Pay by card reuses the open session instead of minting another").toBe(firstSessionId);

    // The test card on the hosted page (stripe-checkout-kit pins currency and billing country, so the page renders the same on every
    // runner), then Stripe returns the sponsor to the club's public hub.
    await fillHostedCheckout(inv, "Pier Outfitters");
    await inv.locator(".SubmitButton, button[type=submit]").first().click();
    await inv.waitForURL(/sponsorship=success/, { waitUntil: "commit", timeout: HOSTED_MS });

    // The payment, read at Stripe: complete, paid, and a succeeded PaymentIntent carrying the deal's metadata.
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
    expect([session.status, session.payment_status], "Stripe took the payment").toEqual(["complete", "paid"]);
    const intent = session.payment_intent;
    if (intent === null || typeof intent === "string") throw new Error(`session ${sessionId} carries no expanded payment_intent: ${String(intent)}`);
    expect(intent.status, `payment_intent ${intent.id}`).toBe("succeeded");
    expect(intent.metadata, "the intent carries the deal it pays for").toMatchObject({ kind: "sponsor", order_id: dealId, org_id: org.orgId });

    // Hand the REAL intent to our OWN webhook route, correctly signed: the production fulfilment path, never a SQL flip. A forwarded
    // copy from `stripe listen` is a second delivery of the same intent and changes nothing (mirrors settings-sponsor-monetize leg 3).
    const eventId = `evt_t24_sponsor_${RUN}_${randomBytes(4).toString("hex")}`;
    strayEventIds.push(eventId);
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      api_version: "2024-06-20",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: "payment_intent.succeeded",
      data: { object: intent },
    });
    const delivered = await request.post("/api/webhooks/stripe", {
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
      data: payload,
    });
    // 400 here is a signature the server would not accept: the runner and the server booted with different STRIPE_WEBHOOK_SECRETs.
    expect(delivered.status(), `POST /api/webhooks/stripe answered ${delivered.status()}: ${await delivered.text()}`).toBe(200);

    // The deal: paid, and live (the on-payment rule), and the sponsor it was made for is on the pages.
    await expect
      .poll(async () => (await dealOf(request, org.orgId, dealId)).payment_status, { timeout: STRIPE_MS, message: "the event marks the deal paid" })
      .toBe("paid");
    const paid = await dealOf(request, org.orgId, dealId);
    expect(paid.deal_status, "a paid on-payment deal is live").toBe("live");
    const sponsors = await apiJson<SponsorRow[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
    expect(sponsors.data?.find((s) => s.id === sponsorId)?.status, "a paid deal takes the sponsor from hidden to live").toBe("active");

    // The invoice page and the PDF read Paid.
    await inv.setViewportSize({ width: 1280, height: 900 });
    await inv.goto(path);
    await expect(inv.getByTestId("invoice-state"), "the page reads Paid").toHaveAttribute("data-state", "paid");
    await expect(inv.getByTestId("invoice-state")).toHaveText(ui("sponsors.invoice.state.paid"));
    await expect(inv.getByTestId("invoice-state-note")).toHaveText(ui("sponsors.invoice.stateNote.paid"));
    await expect(inv.getByTestId("invoice-number")).toHaveText(invoiceNo);
    await expect(inv.getByTestId("invoice-pay"), "a paid invoice has no Pay by card").toHaveCount(0);
    await expect(inv.getByTestId("invoice-recording"), "…and is not 'being recorded'").toHaveCount(0);
    const texts = await pdfTexts(sponsorSide.ctx.request, path);
    expect(texts, "the PDF prints the number").toContain(invoiceNo);
    expect(texts, "the PDF reads Paid").toContain(ui("sponsors.invoice.state.paid"));
    expect(texts, "…and not Unpaid").not.toContain(ui("sponsors.invoice.state.unpaid"));

    // The owner's notice is queued once for this payment (once-key: the intent), however many times the event arrived; so is the
    // sponsor's receipt.
    expect(await outboxCount("sponsor_deal_paid", dealId), "one `sponsor_deal_paid` notice for the payment").toBe(1);
    expect(await outboxCount("sponsor_receipt", dealId), "one receipt for the payment").toBe(1);

    // Pay by card on the paid invoice: 303 back to the invoice page, never a dead-end screen, and no second session.
    const again = await postPay(sponsorSide.ctx.request, path);
    expect(again.status, "Pay on a paid invoice answers 303").toBe(303);
    expect(new URL(again.location, "http://x").pathname, "…back to the invoice page").toBe(path);
    expect(again.location, "…and never to Stripe").not.toContain("stripe.com");
    const sessions = await stripe.checkout.sessions.list({ payment_intent: intent.id });
    expect(sessions.data.map((s) => s.id), "the payment still belongs to the one session").toEqual([sessionId]);

    // At 320: the paid invoice has no sideways scroll.
    await inv.setViewportSize({ width: 320, height: 740 });
    await inv.goto(path);
    await expect(inv.getByTestId("invoice-state")).toBeVisible({ timeout: READ_MS });
    await expectNoSidewaysScroll(inv, 320, "the paid online invoice");
  });

  test("the club's own pages agree: the deal is Live with a refund on offer and nothing left to resend", async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(budget({ navs: 2 }));
    expect(dealId, "test 1 must have sent the invoice").not.toBe("");
    await page.goto(dealUrl(org.slug, sponsorId, dealId));
    await expect(page.getByTestId("deal-page"), "the deal's own page opens").toBeVisible({ timeout: READ_MS });
    await expect(page.getByTestId("deal-page").getByTestId("deal-chip"), "a paid on-payment deal is live").toHaveText(ui("sponsors.deal.chip.live"));
    await expect(dealAction(page, "refund"), "a paid card deal offers a refund").toBeVisible();
    await expect(dealAction(page, "resend_invoice"), "…and has nothing left to resend").toHaveCount(0);
    await expect(dealAction(page, "mark_paid"), "…or to mark paid").toHaveCount(0);
    await page.goto(sponsorsUrl(org.slug, "sponsors"));
    await expect(rowOf(page, sponsorId).getByTestId("deal-chip"), "the sponsor's row reads Live").toHaveText(ui("sponsors.deal.chip.live"), {
      timeout: READ_MS,
    });
  });
});
