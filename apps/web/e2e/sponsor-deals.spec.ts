// Sponsor deals PR 2, Task 14 — the Sponsors tab as a list of sponsors, each with its deal's chip and ONE next action
// (spec §6.1; plan 2026-11-07-sponsor-deals Task 14). Run by CI only (e2e.yml: the `parallel` project joins it by the default
// testMatch; never locally).
//
// What no vitest suite can see (apps/web vitest is environment "node": it reads markup, not a laid-out page):
//   - the REAL producers behind each row - deals created through the API, one by SQL the way Send invoice leaves it - read
//     back through the real list route into the real island, and the buttons on the row writing through the real routes
//     (`mark-paid`, `approve`) and the row following the answer;
//   - the ⋯ fold: below 768 the clicks count and the edit / move / delete controls sit behind it, from 768 they are inline,
//     and each tap target is 44px where a finger is the pointer;
//   - a 43-character sponsor name in a 320px row: cut with an ellipsis, inside the screen, no sideways scroll.
//
// Copy is read from the dictionary the page renders from, never retyped (this folder's idiom: sponsor-deals-api.spec.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, setBoolEntitlementOverrideSql, setOrgConnectSql, withDb } from "./helpers";
import {
  openSponsorRowTools, releaseSettingsOrg, seedCompetition, seedMemberIdentity, seedSettingsOrg, sponsorsUrl, sponsorUrl, type SeededOrg,
} from "./settings-support";

const UI: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
function ui(key: string, vars: Record<string, string> = {}): string {
  const raw = UI[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v), raw);
}

type Deal = { id: string; deal_status: string; payment_status: string; sponsor_id: string };

const seeded: SeededOrg[] = [];
test.afterAll(async ({ request }) => {
  for (const org of seeded) await releaseSettingsOrg(request, org);
});

async function newSponsor(request: APIRequestContext, orgId: string, name: string): Promise<string> {
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsors`, "POST", { name, tier: "partner", url: "https://sponsor.example/" });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.id;
}

async function newPackage(request: APIRequestContext, orgId: string, tier: string): Promise<string> {
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", {
    name: `${tier} board`, price_cents: 25_000, currency: "gbp", tier,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.id;
}

async function newDeal(request: APIRequestContext, orgId: string, sponsorId: string, over: Record<string, unknown>): Promise<string> {
  const res = await apiJson<{ deal: Deal }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/deals`, "POST", {
    competition_id: null, payment_method: "offline", go_live: "on_payment", ...over,
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.deal.id;
}

async function dealStatus(request: APIRequestContext, orgId: string, dealId: string): Promise<string> {
  const res = await apiJson<Deal>(request, `/api/v1/orgs/${orgId}/sponsor-deals/${dealId}`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!.deal_status;
}

const rowOf = (page: Page, sponsorId: string): Locator => page.locator(`[data-testid="sponsor-row"][data-sponsor-id="${sponsorId}"]`);

/** A row's chip words and its action words (null: the row offers none). */
async function expectRow(page: Page, sponsorId: string, chip: string, action: string | null, why: string): Promise<void> {
  const row = rowOf(page, sponsorId);
  await expect(row.getByTestId("deal-chip"), `${why}: its chip`).toHaveText(chip);
  const actions = row.getByTestId("sponsor-row-action");
  if (action === null) {
    await expect(actions, `${why}: no action`).toHaveCount(0);
  } else {
    await expect(actions, `${why}: exactly one action`).toHaveCount(1);
    await expect(actions, `${why}: the action's words`).toHaveText(action);
  }
}

/** No row offers two actions: a person is never asked to choose between two next steps. Returns how many rows it looked at. */
async function expectAtMostOneActionPerRow(page: Page): Promise<number> {
  const rows = page.getByTestId("sponsor-row");
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    expect(await rows.nth(i).getByTestId("sponsor-row-action").count(), `row ${i}: at most one next action`).toBeLessThanOrEqual(1);
  }
  return n;
}

async function postedTo(page: Page, suffix: string): Promise<Response> {
  return page.waitForResponse((r) => r.url().endsWith(suffix) && r.request().method() === "POST", { timeout: 20_000 });
}

/** The partner package every deal here is bought at (`newPackage`): £250.00, whole pounds on the row and in the confirm. */
const PRICE = "£250";

/** Taps a row's Mark as paid until the confirm is up, and returns the dialog. The FIRST tap on a page can land before React has
 *  attached (class 20: the click is then lost, not queued), so it is retried until the dialog shows - safe to repeat, because nothing
 *  is sent until the dialog's own button is pressed. */
async function openMarkPaidConfirm(page: Page, sponsorId: string, name: string): Promise<Locator> {
  const dialog = page.getByRole("alertdialog", { name: ui("sponsors.deal.markPaid.title", { amount: PRICE, name }) });
  await expect(async () => {
    // Never click while the dialog is open (T14 re-review m3): a tap that landed late opens it AFTER the 1s check below gave up, and the
    // retry would then click a button that sits behind the overlay and wait on it. Look first; and cap the click, so a retry that
    // still loses that race fails fast and the next pass finds the dialog open.
    if (await dialog.isVisible()) return;
    await rowOf(page, sponsorId).getByTestId("sponsor-row-action").click({ timeout: 2_000 });
    await expect(dialog, `${name}: Mark as paid asks first, naming the sponsor and the amount`).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(dialog).toContainText(ui("sponsors.deal.markPaid.body"));
  return dialog;
}

test("list: each row shows one next action and the chip its deal state names", async ({ page, request }) => {
  // Seeding (five sponsors, four deals) plus two page loads and four taps.
  test.setTimeout(180_000);
  const org = await seedSettingsOrg(request, { plan: "community", label: "list-actions" });
  seeded.push(org);
  const pkg = await newPackage(request, org.orgId, "partner");

  const live = await newSponsor(request, org.orgId, "Ridge Gold Physiotherapy");
  const unpaid = await newSponsor(request, org.orgId, "Quay Fisheries");
  const steps = await newSponsor(request, org.orgId, "Harbour Tyres");
  const online = await newSponsor(request, org.orgId, "Oakfield Dental");
  const none = await newSponsor(request, org.orgId, "Plain Sponsor");

  // A complimentary deal that goes live at once: the cheapest LIVE deal.
  const liveDeal = await newDeal(request, org.orgId, live, { package_id: pkg, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(request, org.orgId, liveDeal), "premise: live").toBe("live");
  // An offline deal waiting for its money, going live when it lands.
  const unpaidDeal = await newDeal(request, org.orgId, unpaid, { package_id: pkg });
  expect(await dealStatus(request, org.orgId, unpaidDeal), "premise: awaiting payment").toBe("awaiting_payment");
  // An offline deal that waits for the club's approval AFTER the money (two taps on one row).
  const stepsDeal = await newDeal(request, org.orgId, steps, { package_id: pkg, go_live: "on_approval" });
  expect(await dealStatus(request, org.orgId, stepsDeal), "premise: awaiting payment, approval after").toBe("awaiting_payment");
  // Selling online is `sponsors.monetize` plus Connect, which a community org has neither of, so the online deal is SQL-seeded
  // the way Send invoice leaves one: awaiting payment, its sponsor hidden (D8).
  await withDb(async (sql) => {
    await sql`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
      values (${org.orgId}, ${pkg}, ${online}, 'Oakfield Dental', 'pay@deals.e2e.test', 25000, 'gbp', 'pending',
              'awaiting_payment', 'online', 'on_payment', 'partner', false, 'Partner board', ${null})`;
    await sql`update sponsors set status = 'inactive' where id = ${online}`;
  });

  await page.goto(sponsorsUrl(org.slug, "sponsors"));
  await expect(page.getByTestId("sponsor-row"), "anti-vacuity: the five sponsors are listed").toHaveCount(5);
  await expectRow(page, live, ui("sponsors.deal.chip.live"), null, "a live deal needs nothing");
  await expectRow(page, unpaid, ui("sponsors.deal.chip.awaitingPayment"), ui("sponsors.deal.action.markPaid"), "an offline invoice waits for the club to say it was paid");
  await expectRow(page, steps, ui("sponsors.deal.chip.awaitingPayment"), ui("sponsors.deal.action.markPaid"), "the approval deal starts unpaid");
  await expectRow(page, online, ui("sponsors.deal.chip.awaitingPayment"), ui("sponsors.deal.action.resendInvoice"), "an online invoice is resent, not marked paid");
  await expectRow(page, none, ui("sponsors.deal.chip.none"), ui("sponsors.deal.action.addDeal"), "a sponsor with no deal is offered one");
  expect(await expectAtMostOneActionPerRow(page), "every row was looked at").toBe(5);
  // Add deal opens the Add deal sheet (Task 16): a button, not a link, and it writes nothing by itself. The first tap on a page can land
  // before React has attached, so it is retried until the sheet shows (opening is idempotent); Cancel puts it away.
  const addDeal = rowOf(page, none).getByTestId("sponsor-row-action");
  await expect(addDeal, "Add deal is a button now: no href to follow").not.toHaveAttribute("href", /.*/);
  await tapUntil(addDeal, page.getByTestId("add-deal-sheet"), "Add deal opens the sheet");
  await expect(page.locator(`[role="dialog"]:has([data-testid="add-deal-sheet"])`), "the sheet is a dialog").toBeVisible();
  await page.getByTestId("add-deal-cancel").click();
  await expect(page.getByTestId("add-deal-sheet"), "Cancel puts it away").toHaveCount(0);
  await expectRow(page, none, ui("sponsors.deal.chip.none"), ui("sponsors.deal.action.addDeal"), "Cancel wrote nothing: the sponsor still has no deal");

  // Mark as paid asks first. Cancelled, nothing is sent and the row does not move (the negative) ...
  const cancelDialog = await openMarkPaidConfirm(page, unpaid, "Quay Fisheries");
  await page.keyboard.press("Escape");
  await expect(cancelDialog, "cancelled: the dialog is gone").toHaveCount(0);
  await expectRow(page, unpaid, ui("sponsors.deal.chip.awaitingPayment"), ui("sponsors.deal.action.markPaid"), "cancelled: the row did not move");
  expect(await dealStatus(request, org.orgId, unpaidDeal), "cancelled: nothing was sent").toBe("awaiting_payment");
  // ... and confirmed (its pair), the row follows the deal the route answered with.
  const confirmDialog = await openMarkPaidConfirm(page, unpaid, "Quay Fisheries");
  const [paid] = await Promise.all([
    postedTo(page, `/sponsor-deals/${unpaidDeal}/mark-paid`),
    confirmDialog.getByRole("button", { name: ui("sponsors.deal.action.markPaid"), exact: true }).click(),
  ]);
  expect(paid.status(), `mark-paid answered ${paid.status()}: ${await paid.text()}`).toBe(200);
  await expectRow(page, unpaid, ui("sponsors.deal.chip.live"), null, "paid, it goes live and needs nothing");
  expect(await dealStatus(request, org.orgId, unpaidDeal), "the deal itself is live").toBe("live");

  // The approval deal: the same tap lands it on Approve, and Approve takes it live - in ONE tap (End now reverses it), no dialog.
  // One action at each step, never two. The page is hydrated by now (the dialog above opened), so Approve is not retried.
  const stepsDialog = await openMarkPaidConfirm(page, steps, "Harbour Tyres");
  const [paidSteps] = await Promise.all([
    postedTo(page, `/sponsor-deals/${stepsDeal}/mark-paid`),
    stepsDialog.getByRole("button", { name: ui("sponsors.deal.action.markPaid"), exact: true }).click(),
  ]);
  expect(paidSteps.status(), `mark-paid answered ${paidSteps.status()}: ${await paidSteps.text()}`).toBe(200);
  await expectRow(page, steps, ui("sponsors.deal.chip.awaitingApproval"), ui("sponsors.deal.action.approve"), "paid, it waits for the club's approval");
  const [approved] = await Promise.all([
    postedTo(page, `/sponsor-deals/${stepsDeal}/approve`),
    rowOf(page, steps).getByTestId("sponsor-row-action").click(),
  ]);
  expect(approved.status(), `approve answered ${approved.status()}: ${await approved.text()}`).toBe(200);
  await expect(page.getByRole("alertdialog"), "Approve asked nothing: one tap").toHaveCount(0);
  await expectRow(page, steps, ui("sponsors.deal.chip.live"), null, "approved, it is live");
  expect(await dealStatus(request, org.orgId, stepsDeal), "the deal itself is live").toBe("live");

  // The rows that were not tapped did not move (the negative's pair), and the sequence ended with one action per row at most.
  await expectRow(page, live, ui("sponsors.deal.chip.live"), null, "untouched: still live");
  await expectRow(page, online, ui("sponsors.deal.chip.awaitingPayment"), ui("sponsors.deal.action.resendInvoice"), "untouched: still awaiting payment");
  expect(await expectAtMostOneActionPerRow(page), "every row was looked at again").toBe(5);
});

test("list at 320: the ⋯ fold holds clicks, edit, move and delete; no sideways scroll; a 43-character name truncates", async ({ page, request }) => {
  // Three widths, each a page load with the fold opened and closed.
  test.setTimeout(150_000);
  // A competition-scoped or tiered sponsor is a Pro placement (`sponsors.tiers`), so this one org is Pro.
  const org = await seedSettingsOrg(request, { plan: "pro", label: "list-fold" });
  seeded.push(org);
  const LONG = "Harbourside Building Supplies and Timber Co";
  expect(LONG.length, "premise: the name is the 43-character one").toBe(43);
  const SHORT = "Ridge Cycles";
  const gold = await newPackage(request, org.orgId, "gold");
  const longId = await newSponsor(request, org.orgId, LONG);
  const shortId = await newSponsor(request, org.orgId, SHORT);
  const deal = await newDeal(request, org.orgId, longId, { package_id: gold, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(request, org.orgId, deal), "premise: live").toBe("live");

  const widths = [320, 768, 1280];
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(sponsorsUrl(org.slug, "sponsors"));
    const long = rowOf(page, longId);
    await expect(long, `${width}: the long-named sponsor is listed`).toBeVisible();

    // The group a row sits under is its deal's tier: the live gold deal puts this partner-added sponsor in Gold; the other stays Partner.
    await expect(page.locator('[data-testid="sponsor-group"][data-tier="gold"]').getByTestId("sponsor-row"), `${width}: the gold deal's sponsor is under Gold`).toHaveCount(1);
    await expect(page.locator('[data-testid="sponsor-group"][data-tier="gold"]').locator(`[data-sponsor-id="${longId}"]`)).toHaveCount(1);
    await expect(page.locator('[data-testid="sponsor-group"][data-tier="partner"]').locator(`[data-sponsor-id="${shortId}"]`), `${width}: the other stays under Partner`).toHaveCount(1);

    const more = long.getByTestId("sponsor-row-more");
    const tools = long.getByTestId("sponsor-row-tools");
    const controls = [
      long.getByRole("button", { name: ui("sponsors.edit", { name: LONG }), exact: true }),
      long.getByRole("button", { name: ui("settings.org.sponsors.moveUp", { name: LONG }), exact: true }),
      long.getByRole("button", { name: ui("settings.org.sponsors.moveDown", { name: LONG }), exact: true }),
      long.getByRole("button", { name: ui("settings.org.sponsors.remove", { name: LONG }), exact: true }),
    ];
    const clicks = long.getByTestId("sponsor-row-clicks");

    if (width < 768) {
      // Phone: the fold is shut, and the ⋯ is a 44px target that opens it.
      await expect(more, `${width}: the ⋯ is on the row`).toBeVisible();
      const moreBox = await more.boundingBox();
      expect(moreBox!.width, `${width}: the ⋯ is 44px wide`).toBeGreaterThanOrEqual(44);
      expect(moreBox!.height, `${width}: and 44px tall`).toBeGreaterThanOrEqual(44);
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await expect(tools, `${width}: folded, the tools are not on screen`).toBeHidden();
      await expect(clicks, `${width}: nor the clicks count`).toBeHidden();
      for (const c of controls) await expect(c, `${width}: nor the controls`).toBeHidden();
      await expectNoHorizontalScroll(page);

      await openSponsorRowTools(page, LONG);
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await expect(clicks, `${width}: open, the clicks count is there`).toBeVisible();
      for (const c of controls) {
        await expect(c, `${width}: open, every control is there`).toBeVisible();
        const box = await c.boundingBox();
        expect(box!.width, `${width}: a 44px target`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `${width}: a 44px target`).toBeGreaterThanOrEqual(44);
      }
      await expectNoHorizontalScroll(page);
      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await expect(tools, `${width}: shut again`).toBeHidden();
    } else {
      // From md the ⋯ is gone and the same controls are inline - one set of them, never a second phone copy.
      await expect(more, `${width}: no ⋯ from 768`).toBeHidden();
      await expect(tools, `${width}: the tools are inline`).toBeVisible();
      await expect(clicks).toBeVisible();
      for (const c of controls) await expect(c, `${width}: every control is inline`).toBeVisible();
      await expect(long.getByRole("button", { name: ui("sponsors.edit", { name: LONG }) }), `${width}: one Edit, not two`).toHaveCount(1);
    }

    // The 43-character name is cut with an ellipsis and stays inside the screen; it is clipped only where the row is that narrow.
    const name = long.getByTestId("sponsor-row-name-text");
    const box = await name.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { overflow: cs.overflowX, ellipsis: cs.textOverflow, clipped: el.scrollWidth > el.clientWidth, right: el.getBoundingClientRect().right };
    });
    expect({ overflow: box.overflow, ellipsis: box.ellipsis }, `${width}: the name is built to truncate`).toEqual({ overflow: "hidden", ellipsis: "ellipsis" });
    expect(box.right, `${width}: the name ends inside the screen`).toBeLessThanOrEqual(width);
    if (width === 320) expect(box.clipped, "320: the 43 characters do not fit, so they are cut").toBe(true);
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked, "every width was walked").toBe(widths.length);
});

test("a viewer sees the sponsors and their chips - and no action, no ⋯, no edit, move or delete", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const org = await seedSettingsOrg(request, { plan: "community", label: "list-viewer" });
  seeded.push(org);
  const pkg = await newPackage(request, org.orgId, "partner");
  const unpaidId = await newSponsor(request, org.orgId, "Quay Fisheries");
  const noneId = await newSponsor(request, org.orgId, "Plain Sponsor");
  await newDeal(request, org.orgId, unpaidId, { package_id: pkg });

  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    const page = await member.ctx.newPage();
    // The pair is the first test: the same kinds of row DO carry an action (and the ⋯) for someone who can edit.
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(sponsorsUrl(org.slug, "sponsors"));
    await expect(page.getByTestId("sponsor-row"), "anti-vacuity: the viewer sees both sponsors").toHaveCount(2);
    await expect(rowOf(page, unpaidId).getByTestId("deal-chip"), "the chip is for everyone").toHaveText(ui("sponsors.deal.chip.awaitingPayment"));
    await expect(rowOf(page, noneId).getByTestId("deal-chip")).toHaveText(ui("sponsors.deal.chip.none"));
    await expect(page.getByTestId("sponsor-row-action"), "a viewer is offered no next action").toHaveCount(0);
    await expect(page.getByTestId("sponsor-row-more"), "nor a ⋯ - there is nothing behind it").toHaveCount(0);
    await expect(page.getByRole("button", { name: ui("sponsors.edit", { name: "Quay Fisheries" }) }), "nor Edit").toHaveCount(0);
    await expect(page.getByRole("button", { name: ui("settings.org.sponsors.remove", { name: "Quay Fisheries" }) }), "nor Remove").toHaveCount(0);
    // With no controls to fold, the clicks count stays on the row at 320.
    await expect(rowOf(page, unpaidId).getByTestId("sponsor-row-clicks"), "the clicks count is not folded away for a viewer").toBeVisible();
    await expectNoHorizontalScroll(page);
  } finally {
    await member.release();
  }
});

// --- PR 2, Task 15: a sponsor's own page -------------------------------------------------------------------------------------------
//
// What no vitest suite can see: ONE body in two wrappers (a page below 768, a right-hand panel over the list from 768), the swap when
// the window crosses 768, a real tap on the name, the back link's size and where it goes, and the real PATCHes behind the page's
// controls. A floor the page must hold at every width: no sideways scroll.

/** Taps `tap` until `done` shows. The first tap on a page can land before React has attached (class 20: it is lost, not queued), so
 *  the tap is retried until its effect is on screen - safe to repeat only where the tap itself is idempotent (open, never toggle). */
async function tapUntil(tap: Locator, done: Locator, why: string): Promise<void> {
  await expect(async () => {
    if (await done.isVisible()) return;
    await tap.click({ timeout: 2_000 });
    await expect(done, why).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}

test("sponsor page: phones get their own page with back; desktop a side sheet over the list", async ({ page, request }) => {
  // Two seeds, a page load per width and a live resize.
  test.setTimeout(150_000);
  const org = await seedSettingsOrg(request, { plan: "pro", label: "sheet-wrappers" });
  seeded.push(org);
  const NAME = "Harbourside Building Supplies and Timber Co";
  expect(NAME.length, "premise: the realistic 43-character name").toBe(43);
  const pkg = await newPackage(request, org.orgId, "gold");
  const sponsorId = await newSponsor(request, org.orgId, NAME);
  const other = await newSponsor(request, org.orgId, "Quay Fisheries");
  const dealId = await newDeal(request, org.orgId, sponsorId, { package_id: pkg });
  expect(await dealStatus(request, org.orgId, dealId), "premise: an offline deal waiting for its money").toBe("awaiting_payment");
  const listUrl = sponsorsUrl(org.slug, "sponsors");
  const sheet = page.getByTestId("sponsor-sheet");
  const dialog = page.getByRole("dialog");
  const listView = page.getByTestId("sponsors-list-view");

  // --- Desktop (1280): the name opens a side panel OVER the list; Escape closes it back to the list URL.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(listUrl);
  await expect(page.getByTestId("sponsor-row")).toHaveCount(2);
  const nameLink = rowOf(page, sponsorId).getByTestId("sponsor-row-name-link");
  await nameLink.click();
  await expect(page).toHaveURL(new RegExp(`sponsor=${sponsorId}`));
  await expect(dialog, "from 768 the sponsor's page is a panel").toBeVisible();
  await expect(sheet, "one body, inside the panel").toHaveCount(1);
  await expect(dialog.getByTestId("sponsor-sheet")).toHaveCount(1);
  await expect(listView, "the list is still there behind the panel").toBeVisible();
  await expect(page.getByTestId("sponsor-sheet-back"), "the panel has its own close, not a back link").toHaveCount(0);
  const panel = (await dialog.boundingBox())!;
  expect(panel.x + panel.width, "the panel sits against the right edge").toBeGreaterThanOrEqual(1280 - 1);
  expect(panel.height, "and runs the full height").toBeGreaterThanOrEqual(900 - 1);
  expect(panel.width, "a side panel, not the whole screen").toBeLessThanOrEqual(520);
  await expect(page.getByTestId("sponsor-sheet-name")).toHaveText(NAME);
  await expect(page.getByTestId("sponsor-sheet-deals").getByTestId("sponsor-sheet-deal")).toHaveCount(1);
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(dialog, "Escape closes the panel").toHaveCount(0);
  await expect(page, "and goes back to the list URL").toHaveURL(new RegExp(`${listUrl.replace(/[?]/g, "\\?")}$`));

  // --- Phone (390): the same URL is a PAGE with a back link; the list yields to it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${listUrl}&sponsor=${sponsorId}`);
  const pageBody = page.getByTestId("sponsor-sheet-page");
  await expect(pageBody, "below 768 the sponsor's page is the page").toBeVisible();
  await expect(dialog, "and not a dialog").toHaveCount(0);
  await expect(sheet).toHaveCount(1);
  await expect(listView, "the list is hidden, not removed").toBeHidden();
  const back = page.getByTestId("sponsor-sheet-back");
  await expect(back).toBeVisible();
  const backBox = (await back.boundingBox())!;
  expect(backBox.height, "the back link is a 44px target").toBeGreaterThanOrEqual(44);
  expect(await back.getAttribute("href"), "and goes to the list").toBe(listUrl);
  for (const id of ["sponsor-sheet-details", "sponsor-sheet-deals", "sponsor-sheet-report"]) {
    await expect(page.getByTestId(id), `${id} is on the page`).toBeVisible();
  }
  await expectNoHorizontalScroll(page);
  // 44px tap targets on the page's controls.
  for (const id of ["sponsor-sheet-edit", "sponsor-sheet-add-deal", "sponsor-sheet-share"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.height, `${id}: a 44px target`).toBeGreaterThanOrEqual(44);
  }
  for (const btn of await page.getByTestId("sponsor-sheet-deal-action").all()) {
    expect((await btn.boundingBox())!.height, "a deal's action: a 44px target").toBeGreaterThanOrEqual(44);
  }

  // --- Crossing 768 with the page open: the panel replaces the page, and there is STILL one body.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(dialog, "widened past 768: the panel").toBeVisible();
  await expect(pageBody, "and the phone wrapper is gone").toHaveCount(0);
  await expect(sheet, "one body, never two").toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toHaveCount(0);
  await expect(pageBody).toBeVisible();
  await expect(sheet).toHaveCount(1);

  // --- Back returns to the list (and its other sponsor), with the sponsor's page gone.
  await back.click();
  await expect(page).toHaveURL(new RegExp(`${listUrl.replace(/[?]/g, "\\?")}$`));
  await expect(sheet, "back: no sponsor page").toHaveCount(0);
  await expect(listView).toBeVisible();
  await expect(rowOf(page, other)).toBeVisible();

  // --- The name's tap area on a phone is a 44px target that the row does not pay for: hit-test it, do not just measure paint.
  const link = rowOf(page, sponsorId).getByTestId("sponsor-row-name-link");
  const hit = await link.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + 2);
    const bottom = document.elementFromPoint(r.left + r.width / 2, r.bottom - 2);
    return { height: r.height, top: top === el || el.contains(top), bottom: bottom === el || el.contains(bottom) };
  });
  expect(hit.height, "the name link's box is 44px tall on a phone").toBeGreaterThanOrEqual(44);
  expect(hit.top && hit.bottom, "and both ends of it hit the link").toBe(true);
  await expectNoHorizontalScroll(page);
});

test("sponsor page: a live deal's tier and stream are read-only; name and link save", async ({ page, request }) => {
  // Seeding plus two page loads and three writes.
  test.setTimeout(150_000);
  const org = await seedSettingsOrg(request, { plan: "pro", label: "sheet-details" });
  seeded.push(org);
  const gold = await newPackage(request, org.orgId, "gold");
  const liveId = await newSponsor(request, org.orgId, "Ridge Gold Physiotherapy");
  const freeId = await newSponsor(request, org.orgId, "Plain Sponsor");
  const liveDeal = await newDeal(request, org.orgId, liveId, { package_id: gold, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(request, org.orgId, liveDeal), "premise: live").toBe("live");
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- The live-deal sponsor: the deal's tier is read-only, with the reason; the stream box is disabled; the editor has no tier or competition.
  await page.goto(`${sponsorsUrl(org.slug, "sponsors")}&sponsor=${liveId}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("sponsor-sheet-detail-tier"), "the deal's tier").toContainText(ui("sponsors.tier.gold"));
  await expect(dialog.getByTestId("sponsor-sheet-locked-note")).toHaveText(ui("sponsors.deal.lockedNote"));
  await expect(dialog.getByTestId("sponsor-sheet-tier-now"), "a live deal changes nothing later: no 'Tier now' line").toHaveCount(0);
  await expect(dialog.getByTestId("sponsor-sheet-stream"), "a live deal owns the stream").toBeDisabled();
  const edit = dialog.getByTestId("sponsor-sheet-edit");
  const editor = dialog.getByTestId("sponsor-sheet-editor");
  await tapUntil(edit, editor, "Edit opens the editor");
  await expect(editor.locator("select"), "no tier or competition control while the deal is live").toHaveCount(0);

  // Name and link save: exactly the two fields, nothing about the tier.
  const NEW_NAME = "Ridge Gold Physio & Sports";
  await editor.getByRole("textbox").nth(0).fill(NEW_NAME);
  await editor.getByRole("textbox").nth(1).fill("ridge-gold.example.com");
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${liveId}`) && r.request().method() === "PATCH"),
    editor.getByRole("button", { name: ui("sponsors.save"), exact: true }).click(),
  ]);
  expect(saved.status(), `PATCH answered ${saved.status()}: ${await saved.text()}`).toBe(200);
  expect(JSON.parse(saved.request().postData() ?? "null"), "only what changed").toEqual({ name: NEW_NAME, url: "https://ridge-gold.example.com" });
  await expect(editor, "saved: the editor closes").toHaveCount(0);
  await expect(dialog.getByTestId("sponsor-sheet-name")).toHaveText(NEW_NAME);
  const readBack = await apiJson<{ id: string; name: string; url: string | null; tier: string }[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  const row = readBack.data!.find((s) => s.id === liveId)!;
  expect({ name: row.name, url: row.url, tier: row.tier }, "the server agrees, and the deal's tier is untouched").toEqual({
    name: NEW_NAME, url: "https://ridge-gold.example.com", tier: "gold",
  });

  // --- The pair: a sponsor with NO deal keeps its tier and competition controls, and its stream box works.
  await page.goto(`${sponsorsUrl(org.slug, "sponsors")}&sponsor=${freeId}`);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("sponsor-sheet-locked-note"), "no deal, no lock").toHaveCount(0);
  const stream = dialog.getByTestId("sponsor-sheet-stream");
  await expect(stream).toBeEnabled();
  await tapUntil(dialog.getByTestId("sponsor-sheet-edit"), dialog.getByTestId("sponsor-sheet-editor"), "Edit opens the editor");
  await expect(dialog.getByTestId("sponsor-sheet-editor").locator("select"), "tier and competition are the club's to set").toHaveCount(2);
  await dialog.getByTestId("sponsor-sheet-editor").getByRole("button", { name: ui("confirm.cancel"), exact: true }).click();
  await expect(dialog.getByTestId("sponsor-sheet-editor")).toHaveCount(0);
  const [toggled] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/v1/orgs/${org.orgId}/sponsors/${freeId}`) && r.request().method() === "PATCH"),
    stream.click(),
  ]);
  expect(toggled.status(), `PATCH answered ${toggled.status()}: ${await toggled.text()}`).toBe(200);
  expect(JSON.parse(toggled.request().postData() ?? "null"), "exactly the stream flag").toEqual({ on_stream: true });
  const after = await apiJson<{ id: string; on_stream: boolean }[]>(request, `/api/v1/orgs/${org.orgId}/sponsors`);
  expect(after.data!.find((s) => s.id === freeId)!.on_stream, "the server agrees").toBe(true);
  await expect(stream, "and the box reads back checked").toBeChecked();
  await expectNoHorizontalScroll(page);
});


// --- PR 2, Task 16: the Add deal sheet ---------------------------------------------------------------------------------------------
//
// What no vitest suite can see: the sheet's openings come from the REAL hub flags (the plan, the Connect account) the page loaded,
// the real POST behind its button and the real server's answer, the public page a deal moves a sponsor on and off, and the sheet's
// layout in a bottom sheet at 320. Money note: an ONLINE deal's invoice is a Stripe Checkout Session, which this server (a dummy test
// key, a fabricated connected account) cannot make - the online test below asserts what the real server then does (502
// `stripe_unavailable`, a saved draft) and the settings-sponsor-monetize walkthrough, run with real Stripe, owns the paid half.

/** A community org with a public competition, one partner package for the whole organisation (£250), and one sponsor with a link. */
async function dealSetup(request: APIRequestContext, label: string, plan: "community" | "pro") {
  const org = await seedSettingsOrg(request, { plan, label });
  seeded.push(org);
  const comp = await seedCompetition(request, org.orgId, { name: `Deals ${label}`, visibility: "public" });
  const pkg = await newPackage(request, org.orgId, "partner");
  const name = `Harbourside ${label} ${Math.random().toString(36).slice(2, 6)}`;
  const sponsorId = await newSponsor(request, org.orgId, name);
  return { org, comp, pkg, sponsorId, name };
}

/** Whether the public competition page names the sponsor. Polled to the wanted answer: the page is cached per org and busted by the
 *  write, and a bust that is tail work lands a beat after the response - so "it changed" is waited for, never read once. */
async function expectPublic(request: APIRequestContext, s: { org: SeededOrg; comp: { slug: string }; name: string }, shown: boolean, why: string): Promise<void> {
  await expect
    .poll(async () => {
      const res = await request.get(`/live/${s.org.slug}/${s.comp.slug}`);
      return res.status() === 200 && (await res.text()).includes(s.name);
    }, { message: why, timeout: 40_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] })
    .toBe(shown);
}

/** Opens the Add deal sheet from the sponsor's row (a sponsor with no live deal has an Add deal on its row). */
async function openAddDealFromRow(page: Page, sponsorId: string): Promise<Locator> {
  const sheet = page.getByTestId("add-deal-sheet");
  await tapUntil(rowOf(page, sponsorId).getByTestId("sponsor-row-action"), sheet, "Add deal opens the sheet");
  return sheet;
}

/** Presses the sheet's primary button and returns the create's response (the sheet closes itself on success). */
async function saveDeal(page: Page, sponsorId: string): Promise<Response> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/sponsors/${sponsorId}/deals`) && r.request().method() === "POST", { timeout: 60_000 }),
    page.getByTestId("add-deal-submit").click(),
  ]);
  return res;
}

test("add deal (Pro): online is the opening, a billing email is required, Send invoice is the button; with Stripe unreachable the deal is kept as a draft and the page says so", async ({ page, request }) => {
  // Seeding, one page load and a create that waits on a failing Stripe call.
  test.setTimeout(240_000);
  const s = await dealSetup(request, "add-online", "pro");
  await setBoolEntitlementOverrideSql(s.org.orgId, "sponsors.monetize", true);
  await setOrgConnectSql(s.org.orgId, true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(sponsorsUrl(s.org.slug, "sponsors"));
  const sheet = await openAddDealFromRow(page, s.sponsorId);
  // D22 (a), from the REAL hub flags: a plan that sells invoices with Stripe taking charges opens on Online, when paid.
  await expect(page.getByTestId("add-deal-payment-online"), "Pro with Connect opens on Online").toBeChecked();
  await expect(page.getByTestId("add-deal-golive-on_payment")).toBeChecked();
  await expect(page.getByTestId("add-deal-payment-link-online"), "and Online is not locked").toHaveCount(0);
  // The billing email is required for an online deal: no address, no button.
  const submit = page.getByTestId("add-deal-submit");
  await expect(submit, "Send invoice is the button").toHaveText(ui("sponsors.deal.action.sendInvoice"));
  await expect(submit, "no billing email yet: it waits").toBeDisabled();
  await page.getByTestId("add-deal-email").fill("pay@deals.e2e.test");
  await expect(submit).toBeEnabled();
  await expect(page.getByTestId("add-deal-summary")).toContainText("We email an invoice for £250 to pay@deals.e2e.test.");
  await expect(sheet.getByTestId("add-deal-ends-on"), "the whole organisation: an end date is offered").toBeVisible();

  const res = await saveDeal(page, s.sponsorId);
  const answer = (await res.json()) as { error?: { code?: string } };
  expect(res.status(), `create answered ${res.status()}: ${JSON.stringify(answer)}`).toBe(502);
  expect(answer.error?.code).toBe("stripe_unavailable");
  // The refusal closes the sheet (a second tap would make a second deal) and the PAGE says what is true: the deal is saved.
  await expect(sheet, "the sheet closes: the deal exists").toHaveCount(0);
  await expect(page.getByText(ui("sponsors.error.invoiceSavedNoLink")), "the page says the deal is saved and no invoice went out").toBeVisible();
  const deals = await apiJson<Deal[]>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals`);
  const mine = deals.data!.filter((d) => d.sponsor_id === s.sponsorId);
  expect(mine, "exactly one deal was made").toHaveLength(1);
  expect(mine[0]!.deal_status, "kept as a draft: Send invoice retries it").toBe("draft");
  await expectRow(page, s.sponsorId, ui("sponsors.deal.chip.draft"), ui("sponsors.deal.action.openDeal"), "the list was re-read: the draft shows");
});

test("add deal (community): offline, after I approve -> Save deal -> Mark as paid -> still hidden -> Approve -> on the public page", async ({ page, request }) => {
  test.setTimeout(240_000);
  const s = await dealSetup(request, "add-approve", "community");
  await expectPublic(request, s, true, "premise: a sponsor added by hand shows");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(sponsorsUrl(s.org.slug, "sponsors"));
  const sheet = await openAddDealFromRow(page, s.sponsorId);

  // D22 (b)/(c), from the real flags: community opens on Offline; Online is locked with its upgrade way out.
  await expect(page.getByTestId("add-deal-payment-offline"), "community opens on Offline").toBeChecked();
  await expect(page.getByTestId("add-deal-payment-online")).toBeDisabled();
  await expect(page.getByTestId("add-deal-payment-lock-online")).toContainText(ui("sponsors.dealSheet.pay.lockedPlanLink"));
  // F29: the partner package for the whole org is open; the competitions are not offered to a plan without tiers.
  await expect(page.getByTestId(`add-deal-package-${s.pkg}`)).toBeChecked();
  await expect(page.getByTestId("add-deal-scope-hint"), "competitions need a paid plan").toContainText(ui("sponsors.dealSheet.scopeTiersHint"));
  expect(await page.getByTestId("add-deal-scope").locator("option:not([disabled])").count(), "only the whole organisation is open").toBe(1);

  await page.getByTestId("add-deal-golive-on_approval-card").click();
  await expect(page.getByTestId("add-deal-golive-on_approval")).toBeChecked();
  await expect(page.getByTestId("add-deal-submit")).toHaveText(ui("sponsors.dealSheet.primary.saveDeal"));
  await expect(page.getByTestId("add-deal-summary"), "a sponsor on the pages is told it comes off until the deal is live").toContainText(
    ui("sponsors.dealSheet.summary.hidden", { name: s.name }),
  );

  const res = await saveDeal(page, s.sponsorId);
  expect(res.status(), `create answered ${res.status()}: ${await res.text()}`).toBe(201);
  const created = ((await res.json()) as { data: { deal: Deal & { go_live: string; payment_method: string }; checkout_url: string | null } }).data;
  expect({ status: created.deal.deal_status, go_live: created.deal.go_live, method: created.deal.payment_method }, "what was shown is what was made").toEqual({
    status: "awaiting_payment", go_live: "on_approval", method: "offline",
  });
  expect(created.checkout_url, "an offline deal has no pay link").toBeNull();
  await expect(sheet, "saved: the sheet closes").toHaveCount(0);
  await expect(page.getByTestId("sponsor-notice")).toHaveText(ui("sponsors.dealSheet.notice.saved", { name: s.name }));
  await expectRow(page, s.sponsorId, ui("sponsors.deal.chip.awaitingPayment"), ui("sponsors.deal.action.markPaid"), "a saved offline deal waits for the club's money");
  await expectPublic(request, s, false, "waiting for payment: hidden");

  const dialog = await openMarkPaidConfirm(page, s.sponsorId, s.name);
  const [paid] = await Promise.all([
    postedTo(page, `/sponsor-deals/${created.deal.id}/mark-paid`),
    dialog.getByRole("button", { name: ui("sponsors.deal.action.markPaid"), exact: true }).click(),
  ]);
  expect(paid.status(), `mark-paid answered ${paid.status()}: ${await paid.text()}`).toBe(200);
  await expectRow(page, s.sponsorId, ui("sponsors.deal.chip.awaitingApproval"), ui("sponsors.deal.action.approve"), "paid, it waits for approval");
  await expectPublic(request, s, false, "paid is not approved: still hidden");

  const [approved] = await Promise.all([postedTo(page, `/sponsor-deals/${created.deal.id}/approve`), rowOf(page, s.sponsorId).getByTestId("sponsor-row-action").click()]);
  expect(approved.status(), `approve answered ${approved.status()}: ${await approved.text()}`).toBe(200);
  await expectRow(page, s.sponsorId, ui("sponsors.deal.chip.live"), null, "approved, it is live");
  await expectPublic(request, s, true, "approved: on the public page");
  const html = await (await request.get(`/live/${s.org.slug}/${s.comp.slug}`)).text();
  expect(html, "the SAME sponsor row: its tracked link").toContain(`/s/${s.sponsorId}`);
});

test("add deal: complimentary, straight away -> Save and go live -> on the public page at once", async ({ page, request }) => {
  test.setTimeout(180_000);
  const s = await dealSetup(request, "add-free", "community");
  // Take the sponsor off the pages first, so "on the public page at once" is the deal's doing and not the sponsor's starting state.
  const off = await apiJson(request, `/api/v1/orgs/${s.org.orgId}/sponsors/${s.sponsorId}`, "PATCH", { status: "inactive" });
  expect(off.status, JSON.stringify(off.error)).toBe(200);
  await expectPublic(request, s, false, "premise: off the public pages");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(sponsorsUrl(s.org.slug, "sponsors"));
  // A sponsor switched off by hand has no deal, so its row offers Add deal; the sheet is the same from the sponsor's page.
  await openAddDealFromRow(page, s.sponsorId);

  // The positive pair of the absence below: a community org opens on Offline, and an offline deal asks for the sponsor's address, so
  // "no address" after the switch is the switch's doing and not a field that was never drawn.
  await expect(page.getByTestId("add-deal-payment-offline"), "premise: a community org opens on Offline").toBeChecked();
  await expect(page.getByTestId("add-deal-email"), "premise: an offline deal asks for the sponsor's address").toBeVisible();
  await page.getByTestId("add-deal-payment-complimentary-card").click();
  await expect(page.getByTestId("add-deal-golive-immediate"), "complimentary moves go-live off 'when paid'").toBeChecked();
  await expect(page.getByTestId("add-deal-golive-on_payment"), "and 'When paid' is gone").toHaveCount(0);
  await expect(page.getByTestId("add-deal-email"), "no invoice, no address").toHaveCount(0);
  await expect(page.getByTestId("add-deal-submit")).toHaveText(ui("sponsors.dealSheet.primary.saveAndGoLive"));
  await expect(page.getByTestId("add-deal-summary")).toContainText(ui("sponsors.dealSheet.summary.live.onSave"));

  const res = await saveDeal(page, s.sponsorId);
  expect(res.status(), `create answered ${res.status()}: ${await res.text()}`).toBe(201);
  const created = ((await res.json()) as { data: { deal: Deal } }).data.deal;
  expect(created.deal_status, "live on save").toBe("live");
  expect(created.payment_status, "a complimentary deal has no payment").toBe("none");
  await expect(page.getByTestId("add-deal-sheet")).toHaveCount(0);
  await expectRow(page, s.sponsorId, ui("sponsors.deal.chip.live"), null, "live, nothing more to do");
  await expectPublic(request, s, true, "live: on the public page at once");
});

test("add deal: an org-wide Ends on date is saved as the deal's end (read back through GET /sponsor-deals/{id}); a competition scope offers none", async ({ page, request }) => {
  test.setTimeout(180_000);
  const s = await dealSetup(request, "add-ends", "pro");
  // The org's zone is pinned so the stored end can be typed out: `ends_on` is a day IN THE ORG'S ZONE, stored as the start of the next day.
  await withDb((sql) => sql`update organizations set timezone = 'UTC' where id = ${s.org.orgId}`);
  const day = new Date(Date.now() + 30 * 86_400_000);
  const endsOn = day.toISOString().slice(0, 10);
  const next = new Date(day.getTime() + 86_400_000).toISOString().slice(0, 10);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(sponsorsUrl(s.org.slug, "sponsors"));
  await openAddDealFromRow(page, s.sponsorId);

  await page.getByTestId("add-deal-payment-complimentary-card").click();
  await page.getByTestId("add-deal-ends-on").fill(endsOn);
  const res = await saveDeal(page, s.sponsorId);
  expect(res.status(), `create answered ${res.status()}: ${await res.text()}`).toBe(201);
  const created = ((await res.json()) as { data: { deal: Deal } }).data.deal;
  expect(JSON.parse(res.request().postData() ?? "null"), "the typed date is what was sent").toMatchObject({ competition_id: null, ends_on: endsOn });
  const read = await apiJson<{ ends_at: string | null }>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${created.id}`);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  expect(read.data!.ends_at, "the end is the start of the day after the typed one").toBe(`${next}T00:00:00.000Z`);

  // The pair: a competition scope has no date field and sends none - the deal ends with the competition.
  const other = await newSponsor(request, s.org.orgId, "Quay Fisheries");
  await page.goto(sponsorsUrl(s.org.slug, "sponsors"));
  await openAddDealFromRow(page, other);
  await page.getByTestId("add-deal-scope").selectOption(s.comp.id);
  await expect(page.getByTestId("add-deal-ends-on"), "a competition's deal ends with it: no date to type").toHaveCount(0);
  await expect(page.getByTestId("add-deal-runs-hint")).toBeVisible();
  await page.getByTestId("add-deal-payment-complimentary-card").click();
  const res2 = await saveDeal(page, other);
  expect(res2.status(), `create answered ${res2.status()}: ${await res2.text()}`).toBe(201);
  const sent = JSON.parse(res2.request().postData() ?? "null") as Record<string, unknown>;
  expect(sent.competition_id).toBe(s.comp.id);
  expect("ends_on" in sent, "no ends_on for a competition").toBe(false);
});

test("add deal on a live sponsor: it queues behind the live deal; 'End the current deal now' swaps them", async ({ page, request }) => {
  test.setTimeout(240_000);
  const s = await dealSetup(request, "add-queue", "community");
  const liveDeal = await newDeal(request, s.org.orgId, s.sponsorId, { package_id: s.pkg, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(request, s.org.orgId, liveDeal), "premise: live").toBe("live");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(sponsorUrl(s.org.slug, s.sponsorId));
  const sheet = page.getByTestId("add-deal-sheet");

  // --- Queued: the note says so, the summary says the sponsor stays, the button does NOT promise to go live.
  await tapUntil(page.getByTestId("sponsor-sheet-add-deal"), sheet, "Add deal opens the sheet over the sponsor's page");
  await expect(page.getByTestId("add-deal-queue-note")).toHaveText(ui("sponsors.dealSheet.queueNote"));
  await page.getByTestId("add-deal-golive-immediate-card").click();
  await expect(page.getByTestId("add-deal-submit"), "behind a live deal 'straight away' queues: Save deal").toHaveText(ui("sponsors.dealSheet.primary.saveDeal"));
  await expect(page.getByTestId("add-deal-summary")).toContainText(ui("sponsors.dealSheet.summary.queued", { name: s.name }));
  const res = await saveDeal(page, s.sponsorId);
  expect(res.status(), `create answered ${res.status()}: ${await res.text()}`).toBe(201);
  const queued = ((await res.json()) as { data: { deal: Deal } }).data.deal;
  expect(queued.deal_status, "queued behind the live deal").toBe("scheduled");
  expect(await dealStatus(request, s.org.orgId, liveDeal), "the live deal is untouched").toBe("live");
  expect(JSON.parse(res.request().postData() ?? "null"), "end_current is sent false").toMatchObject({ end_current: false });
  await expect(sheet).toHaveCount(0);
  await expectPublic(request, s, true, "the sponsor stays on the pages");

  // --- Swapped: ticking 'End the current deal now' ends the live deal and the new one is live in its place.
  await tapUntil(page.getByTestId("sponsor-sheet-add-deal"), sheet, "Add deal opens the sheet again");
  await page.getByTestId("add-deal-golive-immediate-card").click();
  await page.getByTestId("add-deal-end-current-label").click();
  await expect(page.getByTestId("add-deal-end-current")).toBeChecked();
  await expect(page.getByTestId("add-deal-queue-note"), "the note no longer applies").toHaveCount(0);
  await expect(page.getByTestId("add-deal-submit"), "with the current deal ended it goes live on save").toHaveText(ui("sponsors.dealSheet.primary.saveAndGoLive"));
  const res2 = await saveDeal(page, s.sponsorId);
  expect(res2.status(), `create answered ${res2.status()}: ${await res2.text()}`).toBe(201);
  const swapped = ((await res2.json()) as { data: { deal: Deal } }).data.deal;
  expect(JSON.parse(res2.request().postData() ?? "null"), "end_current is sent true").toMatchObject({ end_current: true });
  expect(swapped.deal_status, "the new deal is live").toBe("live");
  const ended = await apiJson<{ deal_status: string; ended_reason: string | null }>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${liveDeal}`);
  expect({ status: ended.data!.deal_status, reason: ended.data!.ended_reason }, "the old live deal was ended now").toEqual({ status: "ended", reason: "ended_now" });
  expect(await dealStatus(request, s.org.orgId, queued.id), "the earlier queued deal waits its turn").toBe("scheduled");
  await expectPublic(request, s, true, "and the sponsor never left the pages");
});

test("add deal sheet: a bottom sheet on a phone, a panel from sm - the cards fit, no sideways scroll, every control a 44px target, the buttons stay on screen (320 / 390 / 768 / 1280)", async ({ page, request }) => {
  test.setTimeout(240_000);
  const s = await dealSetup(request, "add-layout", "pro");
  await setBoolEntitlementOverrideSql(s.org.orgId, "sponsors.monetize", true);
  await setOrgConnectSql(s.org.orgId, true);
  // The realistic long names: a 43-character sponsor, a package named to the same length, both on a live deal so the queue box shows.
  const LONG = "Harbourside Building Supplies and Timber Co";
  const longSponsor = await newSponsor(request, s.org.orgId, LONG);
  const pk = await apiJson<{ id: string }>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-packages`, "POST", {
    name: "Harbourside Title Season Sponsorship Package", price_cents: 150_000, currency: "gbp", tier: "title", includes_on_stream: true,
  });
  expect(pk.status, JSON.stringify(pk.error)).toBe(201);
  const liveDeal = await newDeal(request, s.org.orgId, longSponsor, { package_id: pk.data!.id, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(request, s.org.orgId, liveDeal), "premise: live").toBe("live");

  const widths = [320, 390, 768, 1280];
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 700 : 900 });
    await page.goto(sponsorUrl(s.org.slug, longSponsor));
    const sheet = page.getByTestId("add-deal-sheet");
    await tapUntil(page.getByTestId("sponsor-sheet-add-deal"), sheet, `${width}: Add deal opens the sheet`);
    const dialog = page.locator(`[role="dialog"]:has([data-testid="add-deal-sheet"])`);
    await expect(page.getByTestId("add-deal-end-current"), `${width}: the queue box shows`).toBeVisible();
    await expectNoHorizontalScroll(page);
    // Nothing in the sheet pokes out sideways: its own scroll width is its width.
    const fits = await dialog.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fits.scroll, `${width}: the sheet has no sideways overflow`).toBeLessThanOrEqual(fits.client + 1);
    // The buttons are in the sheet's footer, on screen, 44px where a finger is the pointer.
    const box = (await page.getByTestId("add-deal-submit").boundingBox())!;
    expect(box.y + box.height, `${width}: the primary button is on screen`).toBeLessThanOrEqual((page.viewportSize()!.height) + 1);
    if (width < 768) {
      for (const id of ["add-deal-submit", "add-deal-cancel", "add-deal-email", "add-deal-scope"]) {
        expect((await page.getByTestId(id).boundingBox())!.height, `${width}: ${id} is a 44px target`).toBeGreaterThanOrEqual(44);
      }
      // A card is tapped on its body: hit-test the middle of the card, do not trust the paint.
      for (const id of ["add-deal-payment-offline-card", "add-deal-golive-immediate-card"]) {
        const hit = await page.getByTestId(id).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { height: r.height, inside: at === el || el.contains(at) };
        });
        expect(hit.inside, `${width}: ${id} takes the tap`).toBe(true);
        expect(hit.height, `${width}: ${id} is at least 44px tall`).toBeGreaterThanOrEqual(44);
      }
    }
    await page.getByTestId("add-deal-cancel").click();
    await expect(sheet).toHaveCount(0);
    checked++;
  }
  expect(checked, "every width was walked").toBe(widths.length);
});
