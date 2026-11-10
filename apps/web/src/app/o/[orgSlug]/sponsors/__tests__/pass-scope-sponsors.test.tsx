// Phase 2 pass-scoping sweep — the Sponsors hub's two Event Pass keys.
//
// (Moved from settings/__tests__ with the Sponsors tab itself, R4 sponsors-on-stream S11: `sponsors.tiers` is now read
// by the hub's Sponsors tab and `sponsors.monetize` by its Packages and orders tab - one tab each where Settings had
// both on one. Same org-wide question, same pass overlay, same expectations.)
//
// `sponsors.tiers` and `sponsors.monetize` are lifted by the Event Pass
// (community=false, event_pass=true), but the page resolved both
// ORG-WIDE. lib/entitlements.ts only consults competition_passes when a
// competition is in scope, so a community org that bought a pass was shown the
// upsell for two features it had already paid for — the tier picker and the
// package composer never appeared, on any competition.
//
// These tabs are genuinely ORG-LEVEL: the competition list beside them is a PICKER,
// not a scope, so there is no single competition to thread. The right question
// for an affordance is therefore "is this reachable ANYWHERE?" — answered by
// `hasFeatureOnAnyPass`. Enforcement stays per-competition in
// usecases/sponsors.ts (requireFeature(..., competitionId)), which is what
// keeps the widened affordance honest, and is asserted below: showing the UI
// must NOT make an unpassed competition writable.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
// prerender, not renderToStaticMarkup: the page is an async server component
// (it awaits requireOrgPage, getDictionary, …) and the synchronous renderer
// cannot await those. Same reason as brand-gate-split.test.tsx.
import { prerender } from "react-dom/static";

const { requireOrgPage, resolveLocale } = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({ requireOrgPage }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));

// The two client islands are stubbed to markers carrying the gate's answer, so
// "did the org get the feature?" is an exact string check rather than a guess
// at some rendered input's class name. lib/db and lib/entitlements are NOT
// stubbed — the pass overlay is the thing under test.
// Sponsor deals PR 2, Task 13: the marker also carries what the REAL loaders handed the island (the deals, packages, the flags
// and the page's reading of ?sponsor= / ?deal=), so those are checked against a real database, not a mock.
vi.mock("@/components/org-sponsors", () => ({
  OrgSponsors: ({ hasTiers, hub, competitions }: {
    hasTiers: boolean;
    competitions: { ends_on: string | null }[];
    hub: {
      hasMonetize: boolean; chargesEnabled: boolean; deals: { id: string }[]; packages: { id: string }[];
      sponsorId: string | null; dealId: string | null;
    };
  }) => (
    <div
      data-testid={`sponsor-tiers-${hasTiers}`}
      data-hub-monetize={String(hub.hasMonetize)}
      data-hub-charges={String(hub.chargesEnabled)}
      data-hub-deals={hub.deals.map((d) => d.id).join("|")}
      data-hub-packages={hub.packages.map((k) => k.id).join("|")}
      data-hub-sponsor={hub.sponsorId ?? "-"}
      data-hub-deal={hub.dealId ?? "-"}
      data-ends={competitions.map((c) => c.ends_on ?? "-").sort().join("|")}
    />
  ),
}));
vi.mock("@/components/sponsor-packages", () => ({
  SponsorPackages: ({ hasMonetize }: { hasMonetize: boolean }) => (
    <div data-testid={`sponsor-monetize-${hasMonetize}`} />
  ),
}));

import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import SponsorsHubPage from "../page";
import type { SponsorsTab } from "@/lib/sponsors-hub";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Rig {
  orgId: string;
  orgSlug: string;
  passedId: string;
  plainId: string;
  /** Sponsor deals PR 2, Task 13: one sponsor with one awaiting-payment deal on one package. */
  sponsorId: string;
  dealId: string;
  packageId: string;
}

/** A COMMUNITY org (explicit subscriptions row — a raw org insert leaves none,
 *  and the pass arm only fires while the resolved plan is 'community') with two
 *  competitions, and a pass on at most one of them. */
async function seedOrg(opts: { withPass: boolean }): Promise<Rig> {
  const s = uniq();
  const orgSlug = "spon-org-" + s;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Spon Org " + s}, ${orgSlug}) returning id`;
  await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  const [{ id: passedId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Passed Cup', ${"passed-" + s}, 'unlisted') returning id`;
  const [{ id: plainId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Plain Cup', ${"plain-" + s}, 'unlisted') returning id`;
  if (opts.withPass) {
    await sql`insert into competition_passes (competition_id, org_id)
              values (${passedId}, ${orgId}) on conflict (competition_id) do nothing`;
  }
  // One competition has an end date, one does not: the hub hands both to the island (the deal timeline's end hint).
  await sql`update competitions set ends_on = '2027-08-31' where id = ${passedId}`;
  // A sponsor with an online deal awaiting payment on an org-wide package.
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, name, price_cents, currency)
    values (${orgId}, ${"Pkg " + s}, 1000, 'gbp') returning id`;
  const [{ id: sponsorId }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, tier, status)
    values (${orgId}, ${null}, ${"Sponsor " + s}, 'partner', 'inactive') returning id`;
  const [{ id: dealId }] = await sql<{ id: string }[]>`
    insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status, sponsor_id,
                                deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
    values (${orgId}, ${packageId}, ${"Sponsor " + s}, ${"sponsor-" + s + "@test.local"}, 1000, 'gbp', 'pending', ${sponsorId},
            'awaiting_payment', 'online', 'on_payment', 'partner', false, ${"Pkg " + s}, ${null})
    returning id`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, passedId, plainId, sponsorId, dealId, packageId };
}

async function renderSponsorsTab(rig: Rig, tab: SponsorsTab, pick: { sponsor?: string; deal?: string } = {}): Promise<string> {
  const org = { id: rig.orgId, name: "Spon Org", slug: rig.orgSlug, role: "owner",
    logo_url: null, logo_storage_path: null, branding: {}, timezone: "Europe/London" };
  requireOrgPage.mockResolvedValue({
    user: { id: "u1", email: "owner@test.local", display_name: "Owner", timezone: null, locale: null },
    org,
    canEdit: true,
    auth: { orgId: rig.orgId, via: "session", userId: "u1", role: "owner", keyId: null },
  });
  resolveLocale.mockResolvedValue("en");

  const element = await SponsorsHubPage({
    params: Promise.resolve({ orgSlug: rig.orgSlug }),
    searchParams: Promise.resolve({ tab, ...pick }),
  });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!HAS_DB)("the Sponsors hub sees an Event Pass held on any competition", () => {
  it("turns the tier picker on for a pass holder, and keeps it off without one", async () => {
    const withPass = await seedOrg({ withPass: true });
    // RED before the fix: the gate resolved org-wide, so a community org's
    // pass was invisible and this rendered the upsell instead.
    expect(await renderSponsorsTab(withPass, "sponsors")).toContain("sponsor-tiers-true");

    // The control arm. Without it the assertion above would still pass if the
    // helper simply answered true for everyone.
    const noPass = await seedOrg({ withPass: false });
    expect(await renderSponsorsTab(noPass, "sponsors")).toContain("sponsor-tiers-false");

    // …and widening the AFFORDANCE must not widen ENFORCEMENT: the write path
    // in usecases/sponsors.ts is competition-scoped, so the unpassed sibling
    // is still denied while the passed one is allowed.
    expect(await hasFeature(withPass.orgId, "sponsors.tiers", withPass.passedId)).toBe(true);
    expect(await hasFeature(withPass.orgId, "sponsors.tiers", withPass.plainId)).toBe(false);
  });

  it("turns the package composer on for a pass holder, and keeps it off without one", async () => {
    const withPass = await seedOrg({ withPass: true });
    expect(await renderSponsorsTab(withPass, "packages")).toContain("sponsor-monetize-true");

    const noPass = await seedOrg({ withPass: false });
    expect(await renderSponsorsTab(noPass, "packages")).toContain("sponsor-monetize-false");

    expect(await hasFeature(withPass.orgId, "sponsors.monetize", withPass.passedId)).toBe(true);
    expect(await hasFeature(withPass.orgId, "sponsors.monetize", withPass.plainId)).toBe(false);
  });
});

// Sponsor deals PR 2, Task 13: the Sponsors tab's new reads, through the REAL page, loaders and database (the unit file stubs
// them all). Seeds are run-unique; each org is its own, so a leak between two orgs shows as the wrong id.
describe.skipIf(!HAS_DB)("the Sponsors tab reads the org's deals, packages, plan flags and competition dates for real (Task 13)", () => {
  const field = (html: string, name: string): string | undefined => new RegExp(`data-hub-${name}="([^"]*)"`).exec(html)?.[1];

  it("hands over THIS org's deal and package, and no other org's", async () => {
    const mine = await seedOrg({ withPass: false });
    const other = await seedOrg({ withPass: false });
    const html = await renderSponsorsTab(mine, "sponsors");
    expect(field(html, "deals")).toBe(mine.dealId);
    expect(field(html, "packages")).toBe(mine.packageId);
    expect(field(html, "deals")).not.toContain(other.dealId);
    expect(field(html, "packages")).not.toContain(other.packageId);
  });

  it("asks sponsors.monetize with the pass overlay, granted AND denied - the same answer the Packages tab gives", async () => {
    const withPass = await seedOrg({ withPass: true });
    const noPass = await seedOrg({ withPass: false });
    expect(field(await renderSponsorsTab(withPass, "sponsors"), "monetize")).toBe("true");
    expect(field(await renderSponsorsTab(noPass, "sponsors"), "monetize")).toBe("false");
    // The control arm: the Packages tab agrees about the same two orgs.
    expect(await renderSponsorsTab(withPass, "packages")).toContain("sponsor-monetize-true");
    expect(await renderSponsorsTab(noPass, "packages")).toContain("sponsor-monetize-false");
  });

  it("reads whether Stripe takes charges from the org row: off by default, on once the account is ready", async () => {
    const rig = await seedOrg({ withPass: false });
    expect(field(await renderSponsorsTab(rig, "sponsors"), "charges")).toBe("false");
    await sql`update organizations set stripe_charges_enabled = true where id = ${rig.orgId}`;
    expect(field(await renderSponsorsTab(rig, "sponsors"), "charges")).toBe("true");
  });

  it("hands the competitions' end dates over as YYYY-MM-DD text, null where none is set", async () => {
    const rig = await seedOrg({ withPass: false });
    expect(/data-ends="([^"]*)"/.exec(await renderSponsorsTab(rig, "sponsors"))?.[1]).toBe("-|2027-08-31");
  });

  it("?sponsor= and ?deal= select this org's sponsor and its deal - and another org's ids select nothing", async () => {
    const mine = await seedOrg({ withPass: false });
    const other = await seedOrg({ withPass: false });
    const own = await renderSponsorsTab(mine, "sponsors", { sponsor: mine.sponsorId, deal: mine.dealId });
    expect([field(own, "sponsor"), field(own, "deal")]).toEqual([mine.sponsorId, mine.dealId]);
    const foreignSponsor = await renderSponsorsTab(mine, "sponsors", { sponsor: other.sponsorId, deal: other.dealId });
    expect([field(foreignSponsor, "sponsor"), field(foreignSponsor, "deal")]).toEqual(["-", "-"]);
    // A real deal of another org on this org's own sponsor is still not a selection.
    const foreignDeal = await renderSponsorsTab(mine, "sponsors", { sponsor: mine.sponsorId, deal: other.dealId });
    expect([field(foreignDeal, "sponsor"), field(foreignDeal, "deal")]).toEqual([mine.sponsorId, "-"]);
    // The list, with neither.
    const list = await renderSponsorsTab(mine, "sponsors");
    expect([field(list, "sponsor"), field(list, "deal")]).toEqual(["-", "-"]);
  });
});
