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
import { apiJson, expectNoHorizontalScroll, withDb } from "./helpers";
import { openSponsorRowTools, releaseSettingsOrg, seedMemberIdentity, seedSettingsOrg, sponsorsUrl, type SeededOrg } from "./settings-support";

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
  // Add deal goes to the sponsor's own page: a link, not a write.
  await expect(rowOf(page, none).getByTestId("sponsor-row-action"), "Add deal is a link to the sponsor's page").toHaveAttribute("href", new RegExp(`sponsor=${none}`));

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
