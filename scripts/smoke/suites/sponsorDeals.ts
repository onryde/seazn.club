// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, call, check, html, newSession, signIn, tag, v1, v1data } from "../harness.ts";

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
}
