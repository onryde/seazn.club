import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedSettingsOrg, releaseSettingsOrg, type SeededOrg } from "../settings-support";
import { routes } from "../../src/lib/routes";

/**
 * Sponsor deals PR 3 — the invoices walkthrough. THIS FILE HOLDS TASK 21's HALF: the club's invoice details on Settings → Payments.
 * Task 24 extends it with the invoice page, the pay-by-card journey and the PDF (the legs that need Tasks 22 and 23's page).
 *
 * Task 21's leg is driven the way a club drives it — typing into the two textareas of the "Sponsor invoices" card and pressing
 * Save — and then read back from the COLUMNS, not from the island's own echo: the card says "Saved" on the strength of two PATCH
 * answers, and only the table says what a later invoice will print.
 *
 * The card is on EVERY plan, so the org is seeded COMMUNITY: the plan that must be able to record a sponsor's cash payment and
 * print the invoice for it (anti-goal 4). Nothing here needs Stripe.
 *
 * `mode: "default"`, for the reasons settings-org-tabs.spec.ts sets out at length: `fullyParallel: true` would otherwise run
 * `beforeAll` — and so `seedSettingsOrg` — once per worker against a shared user bounded to five owned orgs; `serial` would
 * skip everything after the first red (AGENTS.md failure class 21).
 */
test.describe.configure({ mode: "default" });

const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
/** Copy read from the dictionary the page renders from, never retyped; a missing key reds loudly. */
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw;
}

/** A cold dynamic render of a settings surface (NAV) and one authenticated round trip (SAVE) — the budget is derived from them
 *  (AGENTS.md failure class 20), never a flat literal beside a derived cost. */
const NAV_MS = 20_000;
const SAVE_MS = 10_000;
const budget = (navs: number, saves: number): number => Math.max(60_000, 15_000 + navs * NAV_MS + saves * SAVE_MS);
const READ_MS = 20_000;

let org: SeededOrg;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    org = await seedSettingsOrg(ctx.request, { plan: "community", label: "T21-invoices" });
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

/** A short-lived direct connection (settings-connect-gates.spec.ts's shape): `/api/orgs/[id]` has PATCH and nothing else, so the
 *  read-back goes to the columns themselves. Not `src/lib/db`: importing it drags the app's DB/auth graph into Playwright. */
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

interface InvoiceDetailsRow {
  sponsor_invoice_address: string | null;
  sponsor_invoice_bank_details: string | null;
  payment_instructions: string | null;
}

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

test("invoice details save on Settings → Payments, persist across a reload, change one field at a time, and clear", async ({
  page,
}: {
  page: Page;
}) => {
  test.setTimeout(budget(3, 4));
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

// OWED TO TASK 24 (needs Task 22's invoice page and Task 23's offline invoice email): the second half of the brief's row
// "invoice details save on Settings → Payments and appear on the next offline invoice" — create an offline deal with an email
// on this org after saving the details above, open the invoice page from the queued email's link, and assert the saved address
// and bank details are printed on it and there is no pay button. A counted, visible fixme rather than a green test that claims
// the leg and does not drive it. Task 24 replaces this body (and may fold the leg into one journey with the one above).
test.fixme("invoice details appear on the next offline invoice", async () => {
  // Intentionally empty: see the note above.
});
