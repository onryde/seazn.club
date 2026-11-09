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
// Task 8 — seam S1 through a real server: a SIGNED payment_intent.succeeded posted to the real webhook route
// (/api/webhooks/stripe → runEvent → the payment handler) puts the deal's OWN sponsor on the public page, and adds no sponsor.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiJson, withDb } from "./helpers";
import { postSignedEvent, stripeEvent, stripeUid } from "./_stripe-events";
import { releaseSettingsOrg, seedCompetition, seedSettingsOrg, type SeededOrg } from "./settings-support";

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
  return apiJson<{ deal: Deal; checkout_url: string | null }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/deals`, "POST", {
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
  expect(made.data!.checkout_url, "an offline deal has no pay link (F11)").toBeNull();
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
  expect(made.data!.checkout_url).toBeNull();
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
