// Archive a sponsor (spec 2026-11-11-sponsor-archive, plan Task 8) - the journey in a real browser. Run by CI only (e2e.yml: the
// `parallel` project joins it by the default testMatch; never locally). The seven widths live in mobile.spec.ts (ruling R17: only that
// file runs in the seven width projects); this file holds its own default viewport.
//
// What no vitest suite can see (apps/web vitest is environment "node": markup, no router, no focus, no public cache):
//   A1 golden path   a Gold sponsor with an ended, PAID offline deal (numbered invoice) is archived from its page, announced; the list
//                    drops the row and offers "Show archived (1)"; the switch shows it greyed in the Archived group; signed out, the
//                    competition page no longer names it and carries no /s/ link, /s/<id> answers 404 - and the invoice link still opens
//                    with its number (D7). Every absence has its presence beside it (a live control sponsor on the same page).
//   A2 blocked       a sponsor holding a live deal shows a DISABLED Archive and "End or settle its deal first."; End now through the UI
//                    ends it and Archive then works (the pair).
//   A3 sequence      Archive -> focus lands on Unarchive; open the archived row from the switch, Unarchive -> focus lands back on Archive;
//                    the row is in its tier group again, clicks unchanged, public again; archive and unarchive once more, then Add deal
//                    (complimentary, immediate) through the sheet and the deal is live.
//   A4 no new deal   POST .../deals on an archived sponsor is 409 sponsor_archived, and its page offers no Add deal (pair: it did before).
//   A5 another plan  a Free org archives and unarchives through the UI, and its public strip drops and regains the row.
//   A6 a viewer      sees the banner and the list switch, never Archive or Unarchive.
//   A7 the trash     (batch B review I1) an archived row WITH deal history has no trash, one without keeps it, a live row with history
//                    keeps it - each beside its pair.
//
// Copy is read from the dictionary the page renders from, never retyped. Sponsor visibility is sport-agnostic: no sport sweep.
// Serial on purpose: "Show archived (N)" counts every archived sponsor of the ORG, so the tests share one org and must not interleave
// (a viewer + a Free org + this Pro org = three orgs, inside the five a user may own).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, withDb } from "./helpers";
import { releaseSettingsOrg, seedCompetition, seedMemberIdentity, seedSettingsOrg, sponsorsUrl, sponsorUrl, tapUntil, openSponsorRowTools, type SeededCompetition, type SeededOrg } from "./settings-support";

const UI: Record<string, string> = JSON.parse(readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"));
function ui(key: string, vars: Record<string, string> = {}): string {
  const raw = UI[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v), raw);
}

test.describe.configure({ mode: "serial" });

const RUN = Math.random().toString(36).slice(2, 6);
const seeded: SeededOrg[] = [];
let pro: SeededOrg;
let proComp: SeededCompetition;
/** A live partner sponsor on the Pro org's public page: the positive beside every absence. */
let control: { id: string; name: string };
let goldPackageId = "";

test.beforeAll(async ({ request }) => {
  pro = await seedSettingsOrg(request, { plan: "pro", label: "sponsor-archive" });
  seeded.push(pro);
  proComp = await seedCompetition(request, pro.orgId, { name: `Archive Cup ${RUN}`, visibility: "public" });
  control = await mkSponsor(request, pro.orgId, `Control Plumbing ${RUN}`, "partner");
  goldPackageId = await mkPackage(request, pro.orgId, "gold");
});
test.afterAll(async ({ request }) => {
  for (const org of seeded) await releaseSettingsOrg(request, org);
});

async function mkSponsor(request: APIRequestContext, orgId: string, name: string, tier: "partner" | "gold" = "partner"): Promise<{ id: string; name: string }> {
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsors`, "POST", { name, tier, url: `https://${tier}.example/${RUN}` });
  expect(res.status, `POST sponsors -> ${res.status} ${JSON.stringify(res.error)}`).toBe(201);
  return { id: res.data!.id, name };
}
async function mkPackage(request: APIRequestContext, orgId: string, tier: "partner" | "gold"): Promise<string> {
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", { name: `${tier} board ${RUN}`, price_cents: 25_000, currency: "gbp", tier });
  expect(res.status, `POST sponsor-packages -> ${res.status} ${JSON.stringify(res.error)}`).toBe(201);
  return res.data!.id;
}
type Deal = { id: string; deal_status: string; payment_status: string; invoice_number: number | null };
async function mkDeal(request: APIRequestContext, orgId: string, sponsorId: string, packageId: string, over: Record<string, unknown>): Promise<Deal> {
  const res = await apiJson<{ deal: Deal; invoice_url: string | null }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/deals`, "POST", {
    package_id: packageId, competition_id: null, payment_method: "complimentary", go_live: "immediate", end_current: false, ...over,
  });
  expect(res.status, `POST deals -> ${res.status} ${JSON.stringify(res.error)}`).toBe(201);
  return res.data!.deal;
}
async function readDeal(request: APIRequestContext, orgId: string, dealId: string): Promise<Deal> {
  const res = await apiJson<Deal>(request, `/api/v1/orgs/${orgId}/sponsor-deals/${dealId}`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!;
}
/** An offline deal that went live, was invoiced and paid, and has since ended: the sponsor's history (settled: it does not block). */
async function mkPaidEndedDeal(request: APIRequestContext, orgId: string, sponsorId: string, packageId: string, email: string): Promise<{ deal: Deal; invoicePath: string }> {
  const made = await mkDeal(request, orgId, sponsorId, packageId, { payment_method: "offline", sponsor_email: email });
  const sent = await apiJson<{ invoice_url: string | null }>(request, `/api/v1/orgs/${orgId}/sponsor-deals/${made.id}/send-invoice`, "POST");
  expect(sent.status, `send-invoice -> ${sent.status} ${JSON.stringify(sent.error)}`).toBeLessThan(300);
  expect(sent.data?.invoice_url, "the send answers the invoice page's link").toMatch(/\/r\/sponsor\/invoice\/[A-Za-z0-9_-]{20,}$/);
  const paid = await apiJson(request, `/api/v1/orgs/${orgId}/sponsor-deals/${made.id}/mark-paid`, "POST");
  expect(paid.status, `mark-paid -> ${paid.status} ${JSON.stringify(paid.error)}`).toBe(200);
  const ended = await withDb(
    (sql) => sql`update sponsor_orders set deal_status = 'ended', ended_reason = 'expired', ended_at = now() where id = ${made.id} and deal_status = 'live' returning id`,
  );
  expect(ended, "the term ran out on the one live deal").toHaveLength(1);
  const deal = await readDeal(request, orgId, made.id);
  expect([deal.deal_status, deal.payment_status], "premise: ended and paid").toEqual(["ended", "paid"]);
  expect(deal.invoice_number, "premise: the deal is numbered").not.toBeNull();
  return { deal, invoicePath: new URL(sent.data!.invoice_url!).pathname };
}
async function archiveByApi(request: APIRequestContext, orgId: string, sponsorId: string): Promise<void> {
  const res = await apiJson(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/archive`, "POST");
  expect(res.status, `archive -> ${res.status} ${JSON.stringify(res.error)}`).toBe(200);
}
/** How many of the org's sponsors are archived, read from the list route (the expected "(N)" of the switch, never counted from the page). */
async function archivedCount(request: APIRequestContext, orgId: string): Promise<number> {
  const res = await apiJson<{ archived_at: string | null }[]>(request, `/api/v1/orgs/${orgId}/sponsors?archived=1`);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data!.filter((s) => s.archived_at !== null).length;
}
async function clickCount(request: APIRequestContext, orgId: string, sponsorId: string): Promise<number> {
  const res = await apiJson<{ id: string; click_count: number }[]>(request, `/api/v1/orgs/${orgId}/sponsors?archived=1`);
  const row = res.data!.find((s) => s.id === sponsorId);
  expect(row, "the sponsor is in the org's list").toBeDefined();
  return row!.click_count;
}

/** A visitor with NO session: a bare `newContext()` would inherit the signed-in Pro state (mobile.spec.ts says so), so the jar is emptied. */
async function anonymous(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}
/** What the public competition page names. Polled to the wanted answer: the page is cached and busted by the write, and the bust may land a
 *  beat after the response. The page must ANSWER 200 either way (a 404 or 500 names nobody and would pass "absent"). */
async function expectPublic(anon: BrowserContext, org: SeededOrg, comp: SeededCompetition, want: { present: { name: string; id: string }[]; absent: { name: string; id: string }[] }, why: string): Promise<number> {
  expect(want.present.length, `${why}: anti-vacuity: a positive is named beside the absence`).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const res = await anon.request.get(`/live/${org.slug}/${comp.slug}`);
        if (res.status() !== 200) return `HTTP ${res.status()}`;
        const body = await res.text();
        const seen = (s: { name: string; id: string }): boolean => body.includes(s.name) || body.includes(`/s/${s.id}`);
        return JSON.stringify({ present: want.present.map(seen), absent: want.absent.map(seen) });
      },
      { message: why, timeout: 40_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] },
    )
    .toBe(JSON.stringify({ present: want.present.map(() => true), absent: want.absent.map(() => false) }));
  return want.present.length + want.absent.length;
}

/** The VISIBLE copy of a testid: the sponsor page is in the DOM twice (the phone body and the side panel) and only one is laid out. */
const vis = (page: Page, testId: string): Locator => page.locator(`[data-testid="${testId}"]:visible`);
const focusedTestId = (page: Page): Promise<string | null> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null);
const groupRow = (page: Page, tier: string, name: string): Locator =>
  page.locator(`[data-testid="sponsor-group"][data-tier="${tier}"] [data-testid="sponsor-row"]`).filter({ hasText: name });

/** Opens a sponsor's own page and waits for it to be the editor's (the hub's island attached). */
async function openSponsor(page: Page, slug: string, sponsorId: string): Promise<void> {
  await page.goto(sponsorUrl(slug, sponsorId));
  await expect(vis(page, "sponsor-sheet"), "the sponsor's page opens").toBeVisible();
}
/** The Archive tap: retried until the archived banner shows (the first tap on a page can land before React attaches; the write is
 *  idempotent, and once the banner is up the button is gone, so a repeat cannot double-fire). */
async function tapArchive(page: Page): Promise<void> {
  await tapUntil(vis(page, "sponsor-sheet-archive-button"), vis(page, "sponsor-sheet-archived"), "Archive archives the sponsor and the page shows its banner");
}
async function tapUnarchive(page: Page): Promise<void> {
  await tapUntil(vis(page, "sponsor-sheet-unarchive"), vis(page, "sponsor-sheet-archive-button"), "Unarchive restores the sponsor and the page shows its Archive card");
}
/** Turns "Show archived" on, retried to the archived group being on the page (the switch is a toggle: only a tap that took shows the group). */
async function showArchived(page: Page): Promise<void> {
  const group = page.locator('[data-testid="sponsor-group"][data-tier="archived"]');
  await tapUntil(page.getByTestId("sponsors-archived-switch"), group, "the switch shows the Archived group");
  await expect(page.getByTestId("sponsors-archived-switch")).toHaveAttribute("aria-checked", "true");
}

test("A1 golden path: archive from the page, the list drops it, the public page and /s/ lose it, the invoice link still opens with its number", async ({ page, request, browser }) => {
  test.setTimeout(240_000);
  const name = `Harbourside Gold ${RUN}`;
  const gold = await mkSponsor(request, pro.orgId, name, "gold");
  const { deal, invoicePath } = await mkPaidEndedDeal(request, pro.orgId, gold.id, goldPackageId, `delivered+archive-a1-${RUN}@resend.dev`);
  const anon = await anonymous(browser);
  try {
    let checked = await expectPublic(anon, pro, proComp, { present: [gold, control], absent: [] }, "premise: the public page names the gold sponsor and the control");
    const premise = await anon.request.get(`/s/${gold.id}`, { maxRedirects: 0 });
    expect(premise.status(), "premise: /s/<id> redirects to the sponsor while it is live").toBe(302);
    const baseline = await archivedCount(request, pro.orgId);

    await openSponsor(page, pro.slug, gold.id);
    await expect(vis(page, "sponsor-sheet-archive-button"), "its only deal is settled: Archive is offered and enabled").toBeEnabled();
    await expect(vis(page, "sponsor-sheet-archive-blocked"), "...and no blocked line").toHaveCount(0);
    await tapArchive(page);
    await expect(page.getByRole("status").filter({ hasText: ui("sponsors.archive.done", { name }) }).first(), "the notice is announced").toBeVisible();
    await expect(vis(page, "sponsor-sheet-archive"), "the Archive card is replaced by the banner").toHaveCount(0);

    // The list: the row is gone and the switch counts it (N from the list route, not from the page).
    await page.goto(sponsorsUrl(pro.slug, "sponsors"));
    await expect(page.getByTestId("sponsors-list-view")).toBeVisible();
    await expect(page.getByTestId("sponsor-row").filter({ hasText: control.name }), "the control sponsor's row is on the list").toHaveCount(1);
    await expect(page.getByTestId("sponsor-row").filter({ hasText: name }), "the archived sponsor's row is gone").toHaveCount(0);
    expect(await archivedCount(request, pro.orgId), "this sponsor is the one more archived").toBe(baseline + 1);
    await expect(page.locator('[data-testid="sponsors-archived-filter"] label'), "Show archived (N)").toHaveText(ui("sponsors.archive.show", { count: String(baseline + 1) }));
    await showArchived(page);
    const archivedRow = groupRow(page, "archived", name);
    await expect(archivedRow, "the switch puts the row in the Archived group").toHaveCount(1);
    await expect(archivedRow).toHaveAttribute("data-archived", "true");
    await expect(archivedRow.getByTestId("sponsor-row-archived-chip")).toHaveText(ui("sponsors.archive.chip"));
    await expect(page.locator('[data-testid="sponsor-group"][data-tier="archived"] [data-testid="sponsor-group-header"]')).toHaveText(new RegExp(ui("sponsors.archive.group")));

    // Signed out: the public page, the redirect, and the invoice.
    checked += await expectPublic(anon, pro, proComp, { present: [control], absent: [gold] }, "archived: the competition page names neither the sponsor nor its /s/ link");
    const gone = await anon.request.get(`/s/${gold.id}`, { maxRedirects: 0 });
    expect(gone.status(), "archived: /s/<id> is a 404").toBe(404);
    const still = await anon.request.get(`/s/${control.id}`, { maxRedirects: 0 });
    expect(still.status(), "pair: the control's /s/ still redirects").toBe(302);
    const inv = await anon.newPage();
    const invRes = await inv.goto(invoicePath);
    expect(invRes?.status(), "D7: the invoice link still answers 200 after archive").toBe(200);
    await expect(inv.getByTestId("sponsor-invoice")).toBeVisible();
    await expect(inv.getByTestId("invoice-number"), "...with its own number (SP- and four digits, from the deal's stored number)").toHaveText(`SP-${String(deal.invoice_number).padStart(4, "0")}`);
    await expect(inv.getByTestId("sponsor-invoice-not-found")).toHaveCount(0);
    await inv.close();
    expect(checked, "anti-vacuity: the public page was read in both states (2 present, then 1 present + 1 absent)").toBe(2 + 2);
  } finally {
    await anon.close();
  }
});

test("A2 blocked: a live deal disables Archive and says why; End now through the UI, then Archive works", async ({ page, request }) => {
  test.setTimeout(240_000);
  const name = `Blocked Roofing ${RUN}`;
  const sponsor = await mkSponsor(request, pro.orgId, name, "partner");
  const partnerPkg = await mkPackage(request, pro.orgId, "partner");
  const deal = await mkDeal(request, pro.orgId, sponsor.id, partnerPkg, {});
  expect(deal.deal_status, "premise: a complimentary deal is live at once").toBe("live");

  await openSponsor(page, pro.slug, sponsor.id);
  const button = vis(page, "sponsor-sheet-archive-button");
  await expect(button, "Archive is shown").toBeVisible();
  await expect(button, "...and disabled").toBeDisabled();
  await expect(vis(page, "sponsor-sheet-archive-blocked"), "the reason").toHaveText(ui("sponsors.archive.blocked"));
  await expect(button, "the button points at its reason").toHaveAttribute("aria-describedby", `sponsor-sheet-archive-blocked-${sponsor.id}`);

  // End the deal through the UI (it asks first).
  const endNow = page.locator('[data-testid="sponsor-sheet-deal-action"][data-action="end_now"]:visible');
  const dialog = page.getByRole("alertdialog", { name: ui("sponsors.deal.confirm.end.title") });
  await tapUntil(endNow, dialog, "End now asks first");
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/sponsor-deals/${deal.id}/end`) && r.request().method() === "POST", { timeout: 30_000 }),
    dialog.getByRole("button", { name: ui("sponsors.deal.confirm.end.label"), exact: true }).click(),
  ]);
  await expect(vis(page, "sponsor-sheet-archive-blocked"), "the deal is over: no blocked line").toHaveCount(0);
  await expect(vis(page, "sponsor-sheet-archive-button"), "...and Archive is enabled").toBeEnabled();
  await tapArchive(page);
  await expect(vis(page, "sponsor-sheet-archived")).toBeVisible();
  expect((await readDeal(request, pro.orgId, deal.id)).deal_status, "the ended deal is kept").toBe("ended");
});

test("A3 the sequence: archive, unarchive from the switch, focus both ways, clicks and tier kept, public again; again, then Add deal goes live", async ({ page, request, browser }) => {
  test.setTimeout(300_000);
  const name = `Sequence Dental ${RUN}`;
  const sponsor = await mkSponsor(request, pro.orgId, name, "gold");
  const anon = await anonymous(browser);
  try {
    // One real click through the real route, so "clicks unchanged" is a count above zero.
    expect((await anon.request.get(`/s/${sponsor.id}`, { maxRedirects: 0 })).status(), "premise: the live /s/ link redirects").toBe(302);
    await expect.poll(() => clickCount(request, pro.orgId, sponsor.id), { message: "premise: the click was counted", timeout: 20_000 }).toBe(1);
    await expectPublic(anon, pro, proComp, { present: [sponsor, control], absent: [] }, "premise: public before");
    const baseline = await archivedCount(request, pro.orgId);

    await openSponsor(page, pro.slug, sponsor.id);
    await tapArchive(page);
    await expect.poll(() => focusedTestId(page), { message: "after Archive, focus is on Unarchive (batch B I2)" }).toBe("sponsor-sheet-unarchive");
    await expectPublic(anon, pro, proComp, { present: [control], absent: [sponsor] }, "archived: off the public page");

    // Back to the list, the switch, the archived row's read-only way in, and Unarchive from its page.
    await page.goto(sponsorsUrl(pro.slug, "sponsors"));
    await showArchived(page);
    await groupRow(page, "archived", name).getByTestId("sponsor-row-open").click();
    await expect(vis(page, "sponsor-sheet-archived"), "the archived page: its banner").toBeVisible();
    await tapUnarchive(page);
    await expect.poll(() => focusedTestId(page), { message: "after Unarchive, focus is back on Archive (batch B I2)" }).toBe("sponsor-sheet-archive-button");
    await expect(page.getByRole("status").filter({ hasText: ui("sponsors.archive.unarchived", { name }) }).first(), "the notice is announced").toBeVisible();

    // The list: back in its TIER group, with its clicks unchanged; the public page shows it again.
    await page.goto(sponsorsUrl(pro.slug, "sponsors"));
    const row = groupRow(page, "gold", name);
    await expect(row, "the row is back in the Gold group").toHaveCount(1);
    await expect(row).not.toHaveAttribute("data-archived", "true");
    expect(await clickCount(request, pro.orgId, sponsor.id), "the click count survived archive and unarchive").toBe(1);
    await expect(row.getByTestId("sponsor-row-clicks"), "...and the row shows it").toHaveText(ui("sponsors.row.clicks.one", { count: "1" }));
    await expectPublic(anon, pro, proComp, { present: [sponsor, control], absent: [] }, "unarchived: public again");
    expect((await anon.request.get(`/s/${sponsor.id}`, { maxRedirects: 0 })).status(), "unarchived: /s/<id> redirects again").toBe(302);

    // Again, both ways, on the page; then a new deal through the sheet.
    await openSponsor(page, pro.slug, sponsor.id);
    await tapArchive(page);
    await tapUnarchive(page);
    expect(await archivedCount(request, pro.orgId), "archived and unarchived again: the org's archived count is back at its baseline").toBe(baseline);
    await tapUntil(vis(page, "sponsor-sheet-add-deal"), page.getByTestId("add-deal-sheet"), "Add deal opens the sheet");
    await page.getByTestId(`add-deal-package-card-${goldPackageId}`).click();
    await page.getByTestId("add-deal-payment-complimentary-card").click();
    await page.getByTestId("add-deal-golive-immediate-card").click();
    const [made] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/sponsors/${sponsor.id}/deals`) && r.request().method() === "POST", { timeout: 60_000 }),
      page.getByTestId("add-deal-submit").click(),
    ]);
    expect(made.status(), `Add deal answered ${made.status()}: ${await made.text()}`).toBe(201);
    const dealId = ((await made.json()) as { data: { deal: { id: string } } }).data.deal.id;
    expect((await readDeal(request, pro.orgId, dealId)).deal_status, "the new deal is live").toBe("live");
  } finally {
    await anon.close();
  }
});

test("A4 no new deal while archived: the API refuses 409 sponsor_archived and the page offers no Add deal", async ({ page, request }) => {
  test.setTimeout(180_000);
  const sponsor = await mkSponsor(request, pro.orgId, `Refused Garage ${RUN}`, "gold");
  await openSponsor(page, pro.slug, sponsor.id);
  await expect(vis(page, "sponsor-sheet-add-deal"), "pair: a live sponsor's page offers Add deal").toBeVisible();

  await archiveByApi(request, pro.orgId, sponsor.id);
  const refused = await apiJson(request, `/api/v1/orgs/${pro.orgId}/sponsors/${sponsor.id}/deals`, "POST", {
    package_id: goldPackageId, competition_id: null, payment_method: "complimentary", go_live: "immediate", end_current: false,
  });
  expect(refused.status, JSON.stringify(refused.error)).toBe(409);
  expect((refused.error as { code?: string } | undefined)?.code).toBe("sponsor_archived");
  const orders = await withDb((sql) => sql`select count(*)::int as n from sponsor_orders where sponsor_id = ${sponsor.id}`);
  expect(orders[0]!.n, "the refusal wrote no deal").toBe(0);

  await openSponsor(page, pro.slug, sponsor.id);
  await expect(vis(page, "sponsor-sheet-archived"), "the archived page: its banner").toBeVisible();
  await expect(vis(page, "sponsor-sheet-add-deal"), "...and no Add deal").toHaveCount(0);
});

test("A5 another plan: a Free org archives and unarchives through the UI, and its public strip drops and regains the row", async ({ page, request, browser }) => {
  test.setTimeout(240_000);
  const free = await seedSettingsOrg(request, { plan: "community", label: "sponsor-archive-free" });
  seeded.push(free);
  const comp = await seedCompetition(request, free.orgId, { name: `Free Archive Cup ${RUN}`, visibility: "public" });
  const sponsor = await mkSponsor(request, free.orgId, `Corner Bakery ${RUN}`, "partner");
  const stay = await mkSponsor(request, free.orgId, `Stay Florist ${RUN}`, "partner");
  const anon = await anonymous(browser);
  try {
    let checked = await expectPublic(anon, free, comp, { present: [sponsor, stay], absent: [] }, "premise: the free strip carries both");
    await openSponsor(page, free.slug, sponsor.id);
    await tapArchive(page);
    checked += await expectPublic(anon, free, comp, { present: [stay], absent: [sponsor] }, "archived: the free strip drops the row");
    await tapUnarchive(page);
    checked += await expectPublic(anon, free, comp, { present: [sponsor, stay], absent: [] }, "unarchived: the free strip regains it");
    expect(checked, "anti-vacuity: the strip was read three times").toBe(2 + 2 + 2);
  } finally {
    await anon.close();
  }
});

test("A6 a viewer sees the archived banner and the list switch, and no Archive or Unarchive", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const archived = await mkSponsor(request, pro.orgId, `Viewer Archived ${RUN}`, "partner");
  const live = await mkSponsor(request, pro.orgId, `Viewer Live ${RUN}`, "partner");
  await archiveByApi(request, pro.orgId, archived.id);
  const member = await seedMemberIdentity(browser, request, pro.orgId, "viewer");
  try {
    const page = await member.ctx.newPage();
    await openSponsor(page, pro.slug, archived.id);
    await expect(vis(page, "sponsor-sheet-archived"), "the viewer sees the banner").toBeVisible();
    await expect(page.locator('[data-testid="sponsor-sheet-unarchive"]'), "...and no Unarchive").toHaveCount(0);
    await expect(page.locator('[data-testid="sponsor-sheet-archive"]'), "...and no Archive card").toHaveCount(0);
    await openSponsor(page, pro.slug, live.id);
    await expect(vis(page, "sponsor-sheet"), "pair: a live sponsor's page opens").toBeVisible();
    await expect(page.locator('[data-testid="sponsor-sheet-archive-button"]'), "a viewer has no Archive on a live sponsor either").toHaveCount(0);
    await page.goto(sponsorsUrl(pro.slug, "sponsors"));
    await expect(page.getByTestId("sponsors-archived-filter"), "the switch is a view filter: a viewer has it").toBeVisible();
    await showArchived(page);
    await expect(groupRow(page, "archived", archived.name), "...and sees the archived row").toHaveCount(1);
  } finally {
    await member.release();
  }
});

test("A7 the trash: an archived row with deal history has none, one without keeps it, a live one with history keeps it", async ({ page, request }) => {
  test.setTimeout(240_000);
  const history = await mkSponsor(request, pro.orgId, `History Tyres ${RUN}`, "gold");
  const clean = await mkSponsor(request, pro.orgId, `Clean Tyres ${RUN}`, "partner");
  await mkPaidEndedDeal(request, pro.orgId, history.id, goldPackageId, `delivered+archive-a7-${RUN}@resend.dev`);
  const trash = (row: Locator, name: string): Locator => row.getByRole("button", { name: ui("settings.org.sponsors.remove", { name }), exact: true });

  // Live, with history: the trash is there (a refused delete is the server's word, not the row's).
  await page.goto(sponsorsUrl(pro.slug, "sponsors"));
  let row = await openSponsorRowTools(page, history.name);
  await expect(trash(row, history.name), "a LIVE row with history keeps its trash").toBeVisible();

  await archiveByApi(request, pro.orgId, history.id);
  await archiveByApi(request, pro.orgId, clean.id);
  await page.goto(sponsorsUrl(pro.slug, "sponsors"));
  await showArchived(page);
  row = await openSponsorRowTools(page, history.name);
  await expect(trash(row, history.name), "an ARCHIVED row with history has no trash").toHaveCount(0);
  await expect(row.getByTestId("sponsor-row-trash-spacer"), "...it keeps the room instead").toBeAttached();
  row = await openSponsorRowTools(page, clean.name);
  await expect(trash(row, clean.name), "an ARCHIVED row without history keeps its trash").toBeVisible();
  await expect(row.getByTestId("sponsor-row-trash-spacer")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
