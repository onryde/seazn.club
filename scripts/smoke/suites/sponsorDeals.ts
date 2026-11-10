// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE,
  type Session,
  call,
  check,
  html,
  newSession,
  postSignedStripeWebhook,
  signIn,
  smokeDb,
  tag,
  v1,
  v1data,
} from "../harness.ts";

type Deal = { id: string; deal_status: string; payment_status: string; sponsor_id: string };

/**
 * Sponsor deals (plan 2026-11-07-sponsor-deals, Task 6): offline, complimentary and approval deals over the real API and the
 * real public page, on a FRESH community owner — the plan that must be able to record a sponsorship it was paid in cash
 * (anti-goal 4) — plus the console-only door: a viewer of the Pro org cannot mark a deal paid.
 *
 * F33: every deal row here creates its OWN sponsor. A deal attached to the sponsors suite's gold sponsor would hide it (D8),
 * and the Pro org is shared with later suites.
 */
export async function sponsorDealsSuite(admin: Session, proOrgId: string, viewer: Session): Promise<void> {
  const free = newSession();
  const ver = await signIn(free, `delivered+sponsor_deals_${tag}@resend.dev`);
  const orgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const org = orgs.find((o) => o.id === ver.org_id)!;
  const comp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Deals Cup ${tag}`, visibility: "public" }),
  );
  const pkg = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${org.id}/sponsor-packages`, "POST", { name: "Partner board", price_cents: 25_000, currency: "gbp", tier: "partner" }),
  );
  const addSponsor = async (name: string): Promise<string> =>
    v1data<{ id: string }>(await v1(free, `/api/v1/orgs/${org.id}/sponsors`, "POST", { name, url: "https://deals.example/" })).id;
  const createDeal = (sponsorId: string, over: Record<string, unknown>) =>
    v1(free, `/api/v1/orgs/${org.id}/sponsors/${sponsorId}/deals`, "POST", {
      package_id: pkg.id, competition_id: null, payment_method: "offline", go_live: "on_payment", ...over,
    });
  const publicPage = async () => (await html(newSession(), `/live/${org.slug}/${comp.slug}`)).body;
  const sponsorCount = async () => v1data<unknown[]>(await v1(free, `/api/v1/orgs/${org.id}/sponsors`)).length;

  // --- When paid: hidden until marked paid, then the SAME sponsor row is on the public page.
  const paidName = `Deal Paid ${tag}`;
  const paidSponsor = await addSponsor(paidName);
  const made = await createDeal(paidSponsor, {});
  const madeData = made.status === 201 ? v1data<{ deal: Deal; checkout_url: string | null }>(made) : null;
  const hiddenPage = await publicPage();
  check(
    "sd offline deal created hidden (201)",
    made.status === 201 && madeData?.checkout_url === null && madeData.deal.deal_status === "awaiting_payment" && !hiddenPage.includes(paidName),
  );
  const before = await sponsorCount();
  const paid = madeData ? await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${madeData.deal.id}/mark-paid`, "POST") : null;
  const shownPage = await publicPage();
  check(
    "sd mark-paid puts the SAME sponsor on the public page",
    paid?.status === 200 && v1data<Deal>(paid).deal_status === "live" && shownPage.includes(paidName) &&
      shownPage.includes(`/s/${paidSponsor}`) && (await sponsorCount()) === before,
  );

  // --- After I approve: marked paid is not enough (anti-goal 2).
  const approveName = `Deal Approve ${tag}`;
  const approveSponsor = await addSponsor(approveName);
  const pending = await createDeal(approveSponsor, { go_live: "on_approval" });
  const pendingId = pending.status === 201 ? v1data<{ deal: Deal }>(pending).deal.id : "";
  const marked = pendingId ? await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${pendingId}/mark-paid`, "POST") : null;
  const stillHidden = !(await publicPage()).includes(approveName);
  const approved = pendingId ? await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${pendingId}/approve`, "POST") : null;
  check(
    "sd approve required: still hidden after mark-paid",
    marked?.status === 200 && v1data<Deal>(marked).deal_status === "awaiting_approval" && stillHidden &&
      approved?.status === 200 && (await publicPage()).includes(approveName),
  );

  // --- Task 8 (anti-goal 1): a signed payment_intent.succeeded moves its deal and puts the deal's OWN sponsor live — the webhook
  // never inserts a sponsor. Community cannot sell online, so the online deal is SQL-seeded the way Send invoice leaves one
  // (awaiting payment, its sponsor hidden), on its own sponsor (F33). Signing needs the server's STRIPE_WEBHOOK_SECRET.
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.DATABASE_URL) {
    check(
      "sd paid webhook: skipped (no STRIPE_WEBHOOK_SECRET or DATABASE_URL — cannot sign a webhook or seed the deal); deals-webhook-seam.test.ts covers it",
      true,
    );
  } else {
    const webhookSponsor = await addSponsor(`Deal Webhook ${tag}`);
    const db = smokeDb();
    let dealId = "";
    try {
      const [row] = await db<{ id: string }[]>`
        insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                    deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
        values (${org.id}, ${pkg.id}, ${webhookSponsor}, ${`Deal Webhook ${tag}`}, ${`delivered+deal_webhook_${tag}@resend.dev`},
                25000, 'gbp', 'pending', 'awaiting_payment', 'online', 'on_payment', 'partner', false, 'Partner board', ${null})
        returning id`;
      await db`update sponsors set status = 'inactive' where id = ${webhookSponsor}`;
      dealId = row?.id ?? "";
    } finally {
      await db.end();
    }
    const countBefore = await sponsorCount();
    const status = await postSignedStripeWebhook("payment_intent.succeeded", {
      id: `pi_smoke_${tag}_sd_webhook`,
      object: "payment_intent",
      amount: 25_000,
      amount_received: 25_000,
      currency: "gbp",
      status: "succeeded",
      metadata: { kind: "sponsor", order_id: dealId, org_id: org.id },
    });
    const deal = await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals/${dealId}`);
    const after = v1data<{ id: string; status: string }[]>(await v1(free, `/api/v1/orgs/${org.id}/sponsors`));
    check(
      "sd paid webhook never adds a sponsor row",
      status === 200 && deal.status === 200 && v1data<Deal>(deal).deal_status === "live" &&
        v1data<Deal>(deal).payment_status === "paid" && after.length === countBefore &&
        after.find((x) => x.id === webhookSponsor)?.status === "active",
    );
  }

  // --- Online selling is `sponsors.monetize`: refused on community before any row.
  const onlineSponsor = await addSponsor(`Deal Online ${tag}`);
  const online = await createDeal(onlineSponsor, { payment_method: "online", sponsor_email: `delivered+deal_online_${tag}@resend.dev` });
  const onlineDeals = v1data<Deal[]>(await v1(free, `/api/v1/orgs/${org.id}/sponsor-deals?sponsor_id=${onlineSponsor}`));
  check(
    "sd community online deal refused (402)",
    online.status === 402 && (online.json.error as { feature_key?: string } | undefined)?.feature_key === "sponsors.monetize" &&
      Array.isArray(onlineDeals) && onlineDeals.length === 0,
  );

  // --- D21: every deal write is an editor's. The viewer (a member of the Pro org) reads, and cannot mark paid.
  const viewerSponsor = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", { name: `Deal Viewer ${tag}` }),
  ).id;
  const proPkg = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-packages`, "POST", { name: `Deal Viewer Package ${tag}`, price_cents: 1_000, currency: "gbp", tier: "partner" }),
  );
  const viewerDeal = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors/${viewerSponsor}/deals`, "POST", {
    package_id: proPkg.id, competition_id: null, payment_method: "offline", go_live: "on_payment",
  });
  const viewerDealId = viewerDeal.status === 201 ? v1data<{ deal: Deal }>(viewerDeal).deal.id : "";
  const refused = viewerDealId ? await v1(viewer, `/api/v1/orgs/${proOrgId}/sponsor-deals/${viewerDealId}/mark-paid`, "POST") : null;
  const read = viewerDealId ? await v1(viewer, `/api/v1/orgs/${proOrgId}/sponsor-deals/${viewerDealId}`) : null;
  check(
    "sd viewer cannot mark paid (403)",
    refused?.status === 403 && read?.status === 200 && v1data<Deal>(read).payment_status === "pending",
  );

  // --- PR 2 Task 13: the hub's ?sponsor= is trusted for nothing. A REAL sponsor id of another org (the Pro org's, made above) on this
  // org's hub answers 200 with the Sponsors tab's list - this org's sponsor in it, the foreign one's name nowhere. That is ALL this
  // row proves: nothing reads `hub.sponsorId` until the sponsor page (Task 15) renders it, so a page that ACCEPTED the foreign id
  // would pass too (review M1). The row is named for its floor; the foreign-id refusal itself is pinned by sponsors-hub.test.ts
  // (`resolveSponsorParam`) and page.test.tsx / pass-scope-sponsors.test.tsx (the id handed to the island), and Task 15 owns the
  // sponsor-sheet assertion (`data-testid="sponsor-sheet"` present for the OWN id, absent for the foreign one).
  const foreignHub = await html(free, `/o/${org.slug}/sponsors?tab=sponsors&sponsor=${viewerSponsor}`);
  check(
    "sd hub ?sponsor=<foreign> answers the list and leaks no foreign name (floor until the sponsor page)",
    foreignHub.status === 200 &&
      foreignHub.body.includes('data-testid="sponsors-tab-sponsors"') &&
      foreignHub.body.includes(paidName) &&
      !foreignHub.body.includes(`Deal Viewer ${tag}`) &&
      !foreignHub.body.includes('data-testid="sponsor-sheet"'),
  );

  // --- PR 2 Task 14: the Sponsors tab's list, rendered by the real server for a Pro owner. The row of the sponsor whose offline deal
  // waits for its money (made above for the viewer check) carries that deal's chip and exactly ONE action - Mark as paid - and the
  // ADD form above the list asks no tier or scope any more (a deal sets them; the hint says so). A Pro org is the meaningful place for
  // the second half: a community org never had a tier select to remove. The edit form still has them, and is not open here.
  const proOrgs = (await call(admin, "/api/orgs")) as { id: string; slug: string }[];
  const proSlug = proOrgs.find((o) => o.id === proOrgId)?.slug;
  const proHub = proSlug ? await html(admin, `/o/${proSlug}/sponsors?tab=sponsors`) : null;
  const rowStart = proHub ? proHub.body.indexOf(`data-sponsor-id="${viewerSponsor}"`) : -1;
  const row = proHub && rowStart >= 0 ? proHub.body.slice(rowStart, proHub.body.indexOf("</li>", rowStart)) : "";
  const hintAt = proHub ? proHub.body.indexOf("Add a deal afterwards to set their tier and where they show.") : -1;
  const listAt = proHub ? proHub.body.indexOf('data-testid="sponsor-group"') : -1;
  const addForm = proHub && hintAt >= 0 && listAt > hintAt ? proHub.body.slice(hintAt, listAt) : "";
  check(
    "sd hub Sponsors tab: a row shows its deal's chip and one next action; the add form asks no tier",
    proHub?.status === 200 &&
      viewerDealId !== "" &&
      row.includes('data-testid="deal-chip"') &&
      row.includes("Awaiting payment") &&
      (row.match(/data-testid="sponsor-row-action"/g) ?? []).length === 1 &&
      row.includes('data-action="mark_paid"') &&
      addForm.length > 0 &&
      !addForm.includes("<select"),
  );

  // --- T9, the hourly sweep's route (D20): the cron secret guards it, and the right one answers the sweep's counts. CI sets
  // CRON_SECRET for the smoke job and its server alike (ci.yml), so a wrong secret is exactly a 401.
  const wrongCron = await fetch(`${BASE}/api/cron/sponsor-deals`, { method: "POST", headers: { "x-cron-secret": "definitely-wrong-sponsor-deals" } });
  check("sd cron route refuses a wrong secret (401)", wrongCron.status === 401);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    check("sd cron route right-secret shape skipped (no CRON_SECRET in smoke env)", true);
  } else {
    const rightCron = await fetch(`${BASE}/api/cron/sponsor-deals`, { method: "POST", headers: { "x-cron-secret": cronSecret } });
    const cron = (await rightCron.json().catch(() => ({}))) as { ok?: boolean; data?: Record<string, unknown> };
    const KEYS = ["checked", "expired", "finished", "promoted", "failed"] as const;
    check(
      "sd cron route answers counts (200)",
      rightCron.status === 200 && cron.ok === true && KEYS.every((k) => typeof cron.data?.[k] === "number"),
    );
  }
}
