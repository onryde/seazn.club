// Sponsor deals, Task 6 — seam S2 (plan 2026-11-07-sponsor-deals §6): "Offline mark-paid", from the REAL producer
// (`POST /sponsor-deals/{id}/mark-paid`) to the REAL consumer (the public competition page's HTML). Run by CI only (e2e.yml,
// the `parallel` project joins it by the default testMatch; never locally).
//
// Offline, complimentary and approval deals have no screen until PR 2 (§5: "reachable through the API only until PR 2"), so
// this drives them over HTTP with Playwright's `request` and reads the page a visitor gets. What no vitest seam can see: the
// console write and the public page are two requests to a real Next server, so the page reads what the write left only if
// the write expired the org's tag IN the request (F1, `expirePublicSponsors`) — a bust left to `after()` serves the cached
// page without the sponsor.
//
// Each test seeds its OWN community org (the plan this programme says must be able to record a sponsorship it was paid in
// cash: anti-goal 4) with a public competition, so no row here touches the shared Pro org.
//
// Task 9 — seam S3 through a real server: the hourly sweep's route, POSTed with the cron secret, takes a deal whose end date
// has passed off the public page (seed `ends_at` in SQL: the end-date INPUT is proven in Task 16).
//
// Task 10 — deleting a competition a deal is scoped to answers 409 with the archive hint (D18), never the 500 the RESTRICT keys gave.
//
// Task 8 — seam S1 through a real server: a SIGNED payment_intent.succeeded posted to the real webhook route
// (/api/webhooks/stripe → runEvent → the payment handler) puts the deal's OWN sponsor on the public page, and adds no sponsor.
//
// Task 12 — the one page-level test: today's console on a sponsor whose live deal owns its tier, scope and stream. The On stream
// tick is disabled and says why; the Sponsors tab's tier and competition selects are disabled with the same note; and the
// Packages tab's price list counts that sponsor under its package, and the deal's own page offers End now — each at 320, 768 and 1280
// with a 43-character name, no sideways scroll.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiJson, expectNoHorizontalScroll, withDb } from "./helpers";
import { postSignedEvent, stripeEvent, stripeUid } from "./_stripe-events";
import { dealUrl, releaseSettingsOrg, seedCompetition, seedSettingsOrg, sponsorsUrl, type SeededOrg } from "./settings-support";

/** Copy read from the dictionary the page renders from, never retyped (this folder's idiom: sponsors-hub.spec.ts). */
const UI: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);
function ui(key: string, vars: Record<string, string> = {}): string {
  const raw = UI[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v), raw);
}

type Deal = { id: string; deal_status: string; payment_status: string; sponsor_id: string };
type Sponsor = { id: string; name: string; status: string };

const seeded: SeededOrg[] = [];

test.afterAll(async ({ request }) => {
  for (const org of seeded) await releaseSettingsOrg(request, org);
});

/** A community org with a public competition, a partner package for the whole org and one sponsor with a link (a board's
 *  logo links through `/s/<sponsor id>`, so the page names the sponsor ROW, not just its name). */
async function setup(request: APIRequestContext, label: string) {
  const org = await seedSettingsOrg(request, { plan: "community", label });
  seeded.push(org);
  const comp = await seedCompetition(request, org.orgId, { name: `Deals ${label}`, visibility: "public" });
  const pkg = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsor-packages`, "POST", {
    name: "Partner board", price_cents: 25_000, currency: "gbp", tier: "partner",
  });
  expect(pkg.status, JSON.stringify(pkg.error)).toBe(201);
  const name = `Harbourside ${label} ${Math.random().toString(36).slice(2, 6)}`;
  const sp = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", { name, url: "https://harbourside.example/" });
  expect(sp.status, JSON.stringify(sp.error)).toBe(201);
  return { org, comp, packageId: pkg.data!.id, sponsorId: sp.data!.id, name };
}

async function publicPage(request: APIRequestContext, orgSlug: string, compSlug: string): Promise<string> {
  const res = await request.get(`/live/${orgSlug}/${compSlug}`);
  expect(res.status()).toBe(200);
  return res.text();
}

async function createDeal(request: APIRequestContext, orgId: string, sponsorId: string, over: Record<string, unknown>) {
  return apiJson<{ deal: Deal; invoice_url: string | null }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/deals`, "POST", {
    competition_id: null, payment_method: "offline", go_live: "on_payment", ...over,
  });
}

async function sponsors(request: APIRequestContext, orgId: string): Promise<Sponsor[]> {
  const res = await apiJson<Sponsor[]>(request, `/api/v1/orgs/${orgId}/sponsors`);
  expect(res.status).toBe(200);
  return res.data!;
}

test("community: add sponsor → offline when-paid deal hides it → mark paid → public /live page shows it, sponsor id unchanged, sponsor count unchanged", async ({ request }) => {
  const s = await setup(request, "when-paid");
  const visible = await publicPage(request, s.org.slug, s.comp.slug);
  expect(visible, "premise: a sponsor added by hand shows").toContain(s.name);

  const made = await createDeal(request, s.org.orgId, s.sponsorId, { package_id: s.packageId });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  expect(made.data!.invoice_url, "an offline create emails nothing, so it answers no invoice link (F11)").toBeNull();
  expect(made.data!.deal.deal_status).toBe("awaiting_payment");
  const hidden = await publicPage(request, s.org.slug, s.comp.slug);
  expect(hidden, "a deal waiting for its money hides the sponsor").not.toContain(s.name);
  const countBefore = (await sponsors(request, s.org.orgId)).length;

  const paid = await apiJson<Deal>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${made.data!.deal.id}/mark-paid`, "POST");
  expect(paid.status, JSON.stringify(paid.error)).toBe(200);
  expect(paid.data!.deal_status).toBe("live");
  const shown = await publicPage(request, s.org.slug, s.comp.slug);
  expect(shown, "marked paid: on the public page at once").toContain(s.name);
  expect(shown, "the SAME sponsor row: its tracked link").toContain(`/s/${s.sponsorId}`);
  const after = await sponsors(request, s.org.orgId);
  expect(after.length, "no second sponsor row (anti-goal 1)").toBe(countBefore);
  expect(after.find((x) => x.id === s.sponsorId)?.status).toBe("active");
});

test("community: signed payment_intent.succeeded on an online deal shows the SAME sponsor on the public page, sponsor count unchanged", async ({ request }) => {
  const s = await setup(request, "paid-online");
  // Selling online is `sponsors.monetize` plus Connect, which a community org has neither of, so the online deal is SQL-seeded the
  // way Send invoice leaves one: awaiting payment, its sponsor hidden (D8).
  const dealId = await withDb(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
      values (${s.org.orgId}, ${s.packageId}, ${s.sponsorId}, ${s.name}, 'pay@deals.e2e.test', 25000, 'gbp', 'pending',
              'awaiting_payment', 'online', 'on_payment', 'partner', false, 'Partner board', ${null})
      returning id`;
    await sql`update sponsors set status = 'inactive' where id = ${s.sponsorId}`;
    return row!.id;
  });
  expect(await publicPage(request, s.org.slug, s.comp.slug), "premise: a deal waiting for its money hides the sponsor").not.toContain(s.name);
  const countBefore = (await sponsors(request, s.org.orgId)).length;

  const intent = stripeUid("pi");
  const res = await postSignedEvent(
    request,
    stripeEvent("payment_intent.succeeded", {
      id: intent,
      object: "payment_intent",
      amount: 25_000,
      amount_received: 25_000,
      currency: "gbp",
      status: "succeeded",
      metadata: { kind: "sponsor", order_id: dealId, org_id: s.org.orgId },
    }),
  );
  expect(res.status(), "the signed event is accepted").toBe(200);

  const deal = await apiJson<Deal>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${dealId}`);
  expect(deal.status, JSON.stringify(deal.error)).toBe(200);
  expect(deal.data!).toMatchObject({ deal_status: "live", payment_status: "paid", sponsor_id: s.sponsorId });
  // The webhook's bust is tail work (F1: nobody reads a webhook's answer back), so the page is polled, not read once.
  await expect
    .poll(async () => (await request.get(`/live/${s.org.slug}/${s.comp.slug}`)).text(), { timeout: 40_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] })
    .toContain(`/s/${s.sponsorId}`);
  const after = await sponsors(request, s.org.orgId);
  expect(after.length, "no second sponsor row (anti-goal 1)").toBe(countBefore);
  expect(after.find((x) => x.id === s.sponsorId)?.status).toBe("active");
});

test("complimentary straight away is live at once", async ({ request }) => {
  const s = await setup(request, "comp-now");
  const made = await createDeal(request, s.org.orgId, s.sponsorId, { package_id: s.packageId, payment_method: "complimentary", go_live: "immediate" });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  expect(made.data!.deal).toMatchObject({ deal_status: "live", payment_status: "none" });
  expect(made.data!.invoice_url).toBeNull();
  const page = await publicPage(request, s.org.slug, s.comp.slug);
  expect(page).toContain(s.name);
  expect(page).toContain(`/s/${s.sponsorId}`);
});

test("after-I-approve stays hidden after mark paid until Approve", async ({ request }) => {
  const s = await setup(request, "approve");
  const made = await createDeal(request, s.org.orgId, s.sponsorId, { package_id: s.packageId, go_live: "on_approval" });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const dealId = made.data!.deal.id;
  const paid = await apiJson<Deal>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${dealId}/mark-paid`, "POST");
  expect(paid.status).toBe(200);
  expect(paid.data!).toMatchObject({ deal_status: "awaiting_approval", payment_status: "paid" });
  expect(await publicPage(request, s.org.slug, s.comp.slug), "paid is not approved (anti-goal 2)").not.toContain(s.name);
  const approved = await apiJson<Deal>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${dealId}/approve`, "POST");
  expect(approved.status).toBe(200);
  expect(approved.data!.deal_status).toBe("live");
  expect(await publicPage(request, s.org.slug, s.comp.slug)).toContain(s.name);
  const again = await apiJson(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${dealId}/approve`, "POST");
  expect(again.status, "a second Approve").toBe(409);
});

test("community creates a partner package (201) and is refused a gold one (402)", async ({ request }) => {
  const org = await seedSettingsOrg(request, { plan: "community", label: "pkg-gate" });
  seeded.push(org);
  const partner = await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsor-packages`, "POST", {
    name: "Partner", price_cents: 1_000, currency: "gbp", tier: "partner",
  });
  expect(partner.status, JSON.stringify(partner.error)).toBe(201);
  const gold = await apiJson(request, `/api/v1/orgs/${org.orgId}/sponsor-packages`, "POST", {
    name: "Gold", price_cents: 1_000, currency: "gbp", tier: "gold",
  });
  expect(gold.status).toBe(402);
});

test("an org-wide deal whose end date has passed comes off the public page after the cron route runs", async ({ request }) => {
  const cronSecret = process.env.CRON_SECRET;
  expect(cronSecret, "the e2e job must set CRON_SECRET (one value for the server and this runner)").toBeTruthy();
  const s = await setup(request, "sweep-expiry");
  const made = await createDeal(request, s.org.orgId, s.sponsorId, { package_id: s.packageId, payment_method: "complimentary", go_live: "immediate" });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const dealId = made.data!.deal.id;
  expect(await publicPage(request, s.org.slug, s.comp.slug), "premise: the live deal's sponsor is on the page").toContain(`/s/${s.sponsorId}`);

  // An unauthenticated run changes nothing: the deal is still live and still shown.
  const refused = await request.post("/api/cron/sponsor-deals", { headers: { "x-cron-secret": "definitely-wrong" } });
  expect(refused.status()).toBe(401);

  await withDb(async (sql) => {
    await sql`update sponsor_orders set ends_at = now() - interval '1 minute' where id = ${dealId}`;
  });
  const run = await request.post("/api/cron/sponsor-deals", { headers: { "x-cron-secret": cronSecret! } });
  expect(run.status()).toBe(200);
  const counts = ((await run.json()) as { data: { checked: number; expired: number; failed: number } }).data;
  expect(counts.checked, "the sweep examined deals (anti-vacuity)").toBeGreaterThanOrEqual(1);
  expect(counts.expired, "and ended this one").toBeGreaterThanOrEqual(1);
  expect(counts.failed).toBe(0);

  const deal = await apiJson<Deal & { ended_reason: string | null }>(request, `/api/v1/orgs/${s.org.orgId}/sponsor-deals/${dealId}`);
  expect(deal.status, JSON.stringify(deal.error)).toBe(200);
  expect(deal.data!).toMatchObject({ deal_status: "ended", ended_reason: "expired" });
  // The sweep's bust is tail work (F1: nobody reads a sweep back at once), so the page is polled, not read once.
  await expect
    .poll(async () => (await request.get(`/live/${s.org.slug}/${s.comp.slug}`)).text(), { timeout: 40_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] })
    .not.toContain(`/s/${s.sponsorId}`);
  const after = await sponsors(request, s.org.orgId);
  expect(after.find((x) => x.id === s.sponsorId)?.status).toBe("inactive");
});

test("deleting a competition a deal is scoped to answers 409 with the archive hint", async ({ request }) => {
  // A competition scope is a Pro placement (`sponsors.tiers`), so this one org is Pro.
  const org = await seedSettingsOrg(request, { plan: "pro", label: "delete-guard" });
  seeded.push(org);
  const comp = await seedCompetition(request, org.orgId, { name: "Deals delete-guard", visibility: "public" });
  const spare = await seedCompetition(request, org.orgId, { name: "Deals delete-guard spare", visibility: "public" });
  const pkg = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsor-packages`, "POST", {
    name: "Partner board", price_cents: 25_000, currency: "gbp", tier: "partner",
  });
  expect(pkg.status, JSON.stringify(pkg.error)).toBe(201);
  const sp = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", { name: `Harbourside delete ${Math.random().toString(36).slice(2, 6)}` });
  expect(sp.status, JSON.stringify(sp.error)).toBe(201);
  const made = await createDeal(request, org.orgId, sp.data!.id, {
    package_id: pkg.data!.id, competition_id: comp.id, payment_method: "complimentary", go_live: "immediate",
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);

  const refused = await apiJson(request, `/api/v1/competitions/${comp.id}`, "DELETE");
  expect(refused.status, "a refusal in words, not a 500").toBe(409);
  expect(refused.error?.message ?? "").toContain("sponsor deals");
  expect(refused.error?.message ?? "").toContain("archive it instead");
  const deal = await apiJson<Deal>(request, `/api/v1/orgs/${org.orgId}/sponsor-deals/${made.data!.deal.id}`);
  expect(deal.status, JSON.stringify(deal.error)).toBe(200);
  expect(deal.data!.deal_status, "the refused delete changed nothing").toBe("live");

  // Its positive pair: a competition of the same org with no deal deletes.
  const deleted = await apiJson(request, `/api/v1/competitions/${spare.id}`, "DELETE");
  expect(deleted.status, JSON.stringify(deleted.error)).toBe(200);
});

test("a sponsor under a live deal: On stream tick, tier and competition are locked with a note, the invoice picker names it and says the new deal queues, and the live deal's order offers End now, at 320 / 768 / 1280", async ({ page, request }) => {
  // Nine page loads (three tabs at three widths) plus the seeding.
  test.setTimeout(180_000);
  const org = await seedSettingsOrg(request, { plan: "pro", label: "deal-locks" });
  seeded.push(org);
  const PACKAGE_TIER = "gold";
  const pkg = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsor-packages`, "POST", {
    name: "Gold board", price_cents: 25_000, currency: "gbp", tier: PACKAGE_TIER,
  });
  expect(pkg.status, JSON.stringify(pkg.error)).toBe(201);
  // The 43-character name is the realistic one: a short name hides a missing `min-w-0` up the chain (AGENTS.md, phone composition).
  const LONG = "Harbourside Building Supplies and Timber Co";
  expect(LONG.length, "premise: the name is the 43-character one").toBe(43);
  const FREE = "Ridge Cycles";
  const made = async (name: string) => {
    const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${org.orgId}/sponsors`, "POST", { name, tier: "partner" });
    expect(res.status, JSON.stringify(res.error)).toBe(201);
    return res.data!.id;
  };
  const lockedId = await made(LONG);
  const freeId = await made(FREE);
  // A complimentary deal that is live at once: the cheapest way to a LIVE deal, which is what owns the sponsor's fields.
  const deal = await createDeal(request, org.orgId, lockedId, { package_id: pkg.data!.id, payment_method: "complimentary", go_live: "immediate" });
  expect(deal.status, JSON.stringify(deal.error)).toBe(201);
  expect(deal.data!.deal.deal_status, "premise: the deal is live").toBe("live");
  const rows = await sponsors(request, org.orgId);
  expect(rows.length, "premise: both sponsors exist").toBe(2);

  const widths = [320, 768, 1280];
  let checked = 0;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });

    // On stream: the locked sponsor's tick is disabled and says why; the free sponsor's is not (the negative's positive pair).
    await page.goto(sponsorsUrl(org.slug, "on_stream"));
    const tick = page.getByTestId(`on-stream-tick-${lockedId}`);
    await expect(tick, `${width}: a sponsor whose live deal owns the stream flag cannot be ticked by hand`).toBeDisabled();
    await expect(page.getByTestId(`on-stream-locked-${lockedId}`), `${width}: and says why`).toHaveText(ui("sponsors.deal.lockedNote"));
    await expect(page.getByTestId(`on-stream-tick-${freeId}`), `${width}: a sponsor with no deal still ticks`).toBeEnabled();
    await expect(page.getByTestId(`on-stream-locked-${freeId}`), `${width}: and carries no note`).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Sponsors tab: the edit form is a name, a link and a logo - no tier or competition control at all, so no lock note either
    // (owner, 2026-11-11: "why showing tier in sponsor edit?"; a deal sets those two, the sponsor's page shows them read-only). It
    // used to draw both as selects, disabled for this sponsor with a note.
    await page.goto(sponsorsUrl(org.slug, "sponsors"));
    // The pencil is a link to the sponsor's own page with its editor open - a side panel from 768, a page below it (owner, 2026-11-11).
    await page.getByRole("link", { name: ui("sponsors.edit", { name: LONG }) }).click();
    const panel = width >= 768 ? page.getByRole("dialog") : page;
    // The editor is the one holding a Cancel, inside the sponsor's page: counted, so the negatives below are never asserted on nothing.
    const editRow = panel.getByTestId("sponsor-sheet-editor");
    await expect(editRow, `${width}: exactly one editor is open`).toHaveCount(1);
    await expect(editRow.getByRole("button", { name: ui("confirm.cancel"), exact: true }), `${width}: and it is the editor (it has a Cancel)`).toHaveCount(1);
    await expect(editRow.getByLabel(ui("settings.org.sponsors.name")), `${width}: the name is editable`).toBeEnabled();
    await expect(editRow.getByLabel(ui("settings.org.sponsors.link")), `${width}: the link is editable`).toBeEnabled();
    await expect(editRow.locator("select"), `${width}: no tier or competition select, even for a sponsor a live deal owns`).toHaveCount(0);
    await expect(editRow.getByTestId("sponsor-locked-note"), `${width}: and no note about locked fields that are not there`).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Packages tab (the price list since Task 18): the package is a card, and counts this sponsor - the one with the long name - as
    // holding a deal on it. The invoice form this leg used to open is the Add deal sheet now, whose hidden-until-paid and
    // "starts after the current one" lines are pinned in sponsor-deals.spec.ts ("Add deal ..." legs), where a deal is added.
    await page.goto(sponsorsUrl(org.slug, "packages"));
    const dealId = deal.data!.deal.id;
    const card = page.locator(`[data-testid="package-card"][data-package-id="${pkg.data!.id}"]`);
    await expect(card, `${width}: the package is on the price list`).toBeVisible();
    await expect(card.getByTestId("package-used-by"), `${width}: one sponsor holds a deal on it`).toHaveText(ui("sponsors.pkg.usedBy.one", { count: "1" }));
    await expectNoHorizontalScroll(page);

    // The live deal's own page offers End now, with its 43-character sponsor name; a complimentary deal has no invoice to resend.
    await page.goto(dealUrl(org.slug, lockedId, dealId));
    const endNow = page.locator('[data-testid="deal-page-action"][data-action="end_now"]');
    await expect(endNow, `${width}: the live deal can be ended from its page`).toBeVisible();
    await expect(endNow).toHaveText(ui("sponsors.deal.action.endNow"));
    await expect(page.locator('[data-testid="deal-page-action"][data-action="resend_invoice"]'), `${width}: nothing to resend on a complimentary deal`).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked, "every width was walked").toBe(widths.length);
});
