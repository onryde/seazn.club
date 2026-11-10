// Phase 2 pass-scoping sweep — the Sponsors hub's two Event Pass keys.
//
// (Moved from settings/__tests__ with the Sponsors tab itself, R4 sponsors-on-stream S11: `sponsors.tiers` is now read
// by the hub's Sponsors tab and `sponsors.monetize` by its Packages tab (an affordance in the price list since Task 18; the
// deals themselves moved to the Sponsors tab) - one tab each where Settings had both on one. Same org-wide question, same pass overlay, same expectations.)
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
      hasMonetize: boolean; monetizeOrgWide: boolean; monetizeCompetitionIds: readonly string[]; finishedCompetitionIds: readonly string[];
      chargesEnabled: boolean; deals: { id: string }[]; packages: { id: string }[];
      sponsorId: string | null; dealId: string | null;
      dealCreatedByName: string | null; dealCompetitionFinished: boolean;
    };
  }) => (
    <div
      data-testid={`sponsor-tiers-${hasTiers}`}
      data-hub-monetize={String(hub.hasMonetize)}
      data-hub-monetize-wide={String(hub.monetizeOrgWide)}
      data-hub-monetize-ids={hub.monetizeCompetitionIds.join("|")}
      data-hub-finished={hub.finishedCompetitionIds.join("|")}
      data-hub-charges={String(hub.chargesEnabled)}
      data-hub-deals={hub.deals.map((d) => d.id).join("|")}
      data-hub-packages={hub.packages.map((k) => k.id).join("|")}
      data-hub-sponsor={hub.sponsorId ?? "-"}
      data-hub-deal={hub.dealId ?? "-"}
      data-hub-creator={hub.dealCreatedByName ?? "-"}
      data-hub-comp-finished={String(hub.dealCompetitionFinished)}
      data-ends={competitions.map((c) => c.ends_on ?? "-").sort().join("|")}
    />
  ),
}));
// Task 18: the Packages tab is a price list on every plan; its island gets both plan flags as affordances, the org's packages and
// competitions (the scope picker) - the marker carries what the REAL loaders handed it.
vi.mock("@/components/sponsors/package-list", () => ({
  PackageList: ({ hasMonetize, hasTiers, initialPackages, competitions }: {
    hasMonetize: boolean; hasTiers: boolean; initialPackages: { id: string }[]; competitions: { id: string }[];
  }) => (
    <div
      data-testid={`sponsor-monetize-${hasMonetize}`}
      data-pkg-tiers={String(hasTiers)}
      data-pkg-packages={initialPackages.map((k) => k.id).join("|")}
      data-pkg-competitions={competitions.map((c) => c.id).sort().join("|")}
    />
  ),
}));

import { sql } from "@/lib/db";
import { featureScopes, hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
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

  it("turns the package list's online-selling note on for a pass holder, and keeps it off without one", async () => {
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

  // Task 18 (D17): the Packages tab is on EVERY plan. A community org with no pass still gets the list, its own packages and its own
  // competitions - only the tier / scope / online affordances inside it follow the plan, and each follows its own flag.
  it("the Packages tab renders for an org with NO pass: THIS org's packages and competitions only, both flags false (empty case of the gate)", async () => {
    const mine = await seedOrg({ withPass: false });
    const other = await seedOrg({ withPass: false });
    const html = await renderSponsorsTab(mine, "packages");
    const pkg = (name: string) => new RegExp(`data-pkg-${name}="([^"]*)"`).exec(html)?.[1];
    expect(html).toContain("sponsor-monetize-false");
    expect(pkg("tiers")).toBe("false");
    expect(pkg("packages")).toBe(mine.packageId);
    expect(pkg("packages")).not.toContain(other.packageId);
    expect(pkg("competitions")).toBe([mine.passedId, mine.plainId].sort().join("|"));
    expect(pkg("competitions")).not.toContain(other.passedId);
  });

  it("the Packages tab's two plan flags follow the pass independently and for real: a pass turns BOTH affordances on", async () => {
    const withPass = await seedOrg({ withPass: true });
    const html = await renderSponsorsTab(withPass, "packages");
    expect(html).toContain("sponsor-monetize-true");
    expect(new RegExp('data-pkg-tiers="([^"]*)"').exec(html)?.[1]).toBe("true");
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

  it("hands over WHERE online selling is on, through the real entitlements: an Event Pass lifts its own competition and never the whole organisation (batch H fix round 1: m2)", async () => {
    const withPass = await seedOrg({ withPass: true });
    const noPass = await seedOrg({ withPass: false });
    const passHtml = await renderSponsorsTab(withPass, "sponsors");
    expect([field(passHtml, "monetize"), field(passHtml, "monetize-wide"), field(passHtml, "monetize-ids")], "an Event Pass on one competition").toEqual([
      "true", "false", withPass.passedId,
    ]);
    // The enforcement side the sheet mirrors: the passed competition is allowed, its unpassed sibling is not.
    expect(await hasFeature(withPass.orgId, "sponsors.monetize", withPass.passedId)).toBe(true);
    expect(await hasFeature(withPass.orgId, "sponsors.monetize", withPass.plainId)).toBe(false);
    expect(field(passHtml, "monetize-ids"), "the unpassed competition is not offered").not.toContain(withPass.plainId);
    // The control arm: no pass, no plan - nowhere.
    const noneHtml = await renderSponsorsTab(noPass, "sponsors");
    expect([field(noneHtml, "monetize"), field(noneHtml, "monetize-wide"), field(noneHtml, "monetize-ids")]).toEqual(["false", "false", ""]);
  });

  it("a plan that sells online everywhere is org-wide with no per-competition list - and a pass beside it changes nothing (batch H fix round 1: m2)", async () => {
    const rig = await seedOrg({ withPass: true });
    await setOrgPlan(rig.orgId, "pro");
    await invalidateOrgEntitlements(rig.orgId);
    // Premise from the entitlement engine itself, not a plan name typed here: the plan lifts the feature with no competition in scope.
    expect(await hasFeature(rig.orgId, "sponsors.monetize"), "premise: the plan has it org-wide").toBe(true);
    const html = await renderSponsorsTab(rig, "sponsors");
    expect([field(html, "monetize"), field(html, "monetize-wide"), field(html, "monetize-ids")]).toEqual(["true", "true", ""]);
    expect(await featureScopes(rig.orgId, "sponsors.monetize")).toEqual({ orgWide: true, competitionIds: [] });
  });

  it("featureScopes lists EVERY passed competition and only those (two passes, one unpassed sibling)", async () => {
    const rig = await seedOrg({ withPass: true });
    await sql`insert into competition_passes (competition_id, org_id) values (${rig.plainId}, ${rig.orgId}) on conflict (competition_id) do nothing`;
    await invalidateOrgEntitlements(rig.orgId);
    const third = (await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility) values (${rig.orgId}, 'Third Cup', ${"third-" + uniq()}, 'unlisted') returning id`)[0]!.id;
    const got = await featureScopes(rig.orgId, "sponsors.monetize");
    expect(got.orgWide).toBe(false);
    expect([...got.competitionIds].sort()).toEqual([rig.passedId, rig.plainId].sort());
    expect(got.competitionIds, "a competition with no pass is not listed").not.toContain(third);
    // Another org's passes never leak in.
    const other = await seedOrg({ withPass: true });
    expect((await featureScopes(other.orgId, "sponsors.monetize")).competitionIds).toEqual([other.passedId]);
  });

  it("featureScopes lists only passes that still APPLY: a competition that is completed, archived or ended past the grace stops offering Online (batch H fix round 1: m2)", async () => {
    // The enforcement side re-resolves the pass with its lock (`hasFeature` -> `passLockReason`), so an affordance that offered Online
    // on a competition whose pass no longer applies would be refused by the server (402) after the organiser had filled the sheet in.
    const rig = await seedOrg({ withPass: true });
    const dead: { label: string; set: () => Promise<void> }[] = [
      { label: "completed", set: async () => { await sql`update competitions set status = 'completed' where id = ${rig.plainId}`; } },
      { label: "archived", set: async () => { await sql`update competitions set status = 'archived' where id = ${rig.plainId}`; } },
      { label: "ended long ago", set: async () => { await sql`update competitions set status = 'published', ends_on = (now() at time zone 'utc')::date - 60 where id = ${rig.plainId}`; } },
    ];
    await sql`insert into competition_passes (competition_id, org_id) values (${rig.plainId}, ${rig.orgId}) on conflict (competition_id) do nothing`;
    await invalidateOrgEntitlements(rig.orgId);
    // The pair first: while the second pass applies, both are listed.
    expect([...(await featureScopes(rig.orgId, "sponsors.monetize")).competitionIds].sort(), "premise: both passes apply").toEqual([rig.passedId, rig.plainId].sort());
    let checked = 0;
    for (const arm of dead) {
      await arm.set();
      await invalidateOrgEntitlements(rig.orgId);
      expect(await hasFeature(rig.orgId, "sponsors.monetize", rig.plainId), `${arm.label}: the server no longer lifts it`).toBe(false);
      expect((await featureScopes(rig.orgId, "sponsors.monetize")).competitionIds, `${arm.label}: so the sheet does not offer it`).toEqual([rig.passedId]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  // The positive case (a competition that HAS finished) needs the division rig of sponsor-deals-sweep.test.ts, which drives
  // `finishedPackageCompetitions` itself; here the real loader is proven wired into the real page: it runs for a competition-scoped
  // package without throwing and answers "not finished" for a competition that is still going.
  it("the real finishedPackageCompetitions loader is wired into the Sponsors tab: a package on a competition still going is not listed, and the field is present (batch H fix round 1: m1)", async () => {
    const rig = await seedOrg({ withPass: false });
    await sql`insert into sponsor_packages (org_id, competition_id, name, price_cents, currency)
              values (${rig.orgId}, ${rig.passedId}, 'Cup package', 500, 'gbp')`;
    // The competition has no fixtures and an end date in the future: not finished, so the list is EMPTY (and present, not missing).
    expect(field(await renderSponsorsTab(rig, "sponsors"), "finished")).toBe("");
  });

  it("reads whether Stripe takes charges from the org row: off by default, and on only with a connected account AND charges enabled (review M4)", async () => {
    const rig = await seedOrg({ withPass: false });
    expect(field(await renderSponsorsTab(rig, "sponsors"), "charges")).toBe("false");
    // The flag alone is not charge-ready: the server's checkoutOrg also needs the account (409 connect_required without it).
    await sql`update organizations set stripe_charges_enabled = true where id = ${rig.orgId}`;
    expect(field(await renderSponsorsTab(rig, "sponsors"), "charges")).toBe("false");
    // The account alone is not either.
    await sql`update organizations set stripe_charges_enabled = false, stripe_account_id = ${`acct_t14_${rig.orgId}`} where id = ${rig.orgId}`;
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

  // Sponsor deals PR 2, Task 17: the deal page's two own reads, through the real page and database. The creator is read only
  // when a deal is selected; the "competition finished" answer only for a non-ended deal with no end date of its own.
  it("a selected deal carries its creator's display name, read from the database; the list and a deal with no creator carry none (Task 17)", async () => {
    const rig = await seedOrg({ withPass: false });
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values ('creator-' || gen_random_uuid() || '@test.local', 'Dana Creator', true) returning id`;
    // dealCreatorName names a creator only while they are still a member of THIS org.
    await sql`insert into org_members (org_id, user_id, role) values (${rig.orgId}, ${userId}, 'admin')`;
    await sql`update sponsor_orders set created_by = ${userId} where id = ${rig.dealId}`;
    const picked = await renderSponsorsTab(rig, "sponsors", { sponsor: rig.sponsorId, deal: rig.dealId });
    expect(field(picked, "creator")).toBe("Dana Creator");
    // The control arms: no deal selected reads nothing; a deal nobody created has no name.
    expect(field(await renderSponsorsTab(rig, "sponsors"), "creator")).toBe("-");
    await sql`update sponsor_orders set created_by = null where id = ${rig.dealId}`;
    expect(field(await renderSponsorsTab(rig, "sponsors", { sponsor: rig.sponsorId, deal: rig.dealId }), "creator")).toBe("-");
  });

  // The positive case (every division finished) needs the division rig of sponsor-deals-sweep.test.ts, which drives
  // `isDealCompetitionFinished` itself and counts its three phases; here the real loader is proven wired into the real page: the
  // field is present and false for an org-wide deal and for a competition still going (a `completed` STATUS alone is not finished -
  // the desk's derived phase decides, never the stored column).
  it("a selected deal's competition-finished field is wired and false for an org-wide deal and for a competition still going, even one marked completed (Task 17)", async () => {
    const rig = await seedOrg({ withPass: false });
    const at = () => renderSponsorsTab(rig, "sponsors", { sponsor: rig.sponsorId, deal: rig.dealId });
    expect(field(await at(), "comp-finished"), "org-wide: no competition to have finished").toBe("false");
    await sql`update sponsor_orders set competition_id = ${rig.passedId} where id = ${rig.dealId}`;
    expect(field(await at(), "comp-finished"), "a competition with no divisions has not begun").toBe("false");
    await sql`update competitions set status = 'completed' where id = ${rig.passedId}`;
    expect(field(await at(), "comp-finished"), "the stored status is not the desk's phase").toBe("false");
  });
});
