// R4 sponsors-on-stream S11 - the Sponsors hub page (/o/[orgSlug]/sponsors?tab=...), rendered.
//
// The page is an async server component, so it is awaited and prerendered (the settings suites' pattern). The two
// client islands it hosts (OrgSponsors, PackageList) are stubbed to markers that carry the props the page gave them
// - "did the org get the feature?" and "was it read-only?" become exact string checks. lib/entitlements is mocked at the
// two calls the page makes (`hasFeatureOnAnyPass`, and since the Add deal sheet's fix round `featureScopes` - WHERE a feature is on,
// which the Sponsors tab asks for sponsors.monetize) so the granted and the denied gate are both driven. By default `featureScopes`
// answers org-wide exactly when `hasFeatureOnAnyPass` does, so every gate case below drives both; the scope cases override it.
//
// What these cases pin, per the task brief and R19:
//   - no tab => Overview; an unknown tab => Overview
//   - every tab renders its own panel and ONLY its own (a sweep over `SPONSORS_TABS`, counted)
//   - Sponsors keeps `sponsors.tiers`; Packages (Task 18, D17) is on EVERY plan and only reads both flags as affordances - granted AND denied
//   - a non-editor gets the read-only view Settings gave (canEdit false, no Packages) - NOT a refusal (R19)
//   - the data each tab needs is loaded for that tab only, and never twice across a sequence
//   - On stream (S12): an editor gets the tab with the org's sponsors, tiers gate and the scope the URL names - kept only if it
//     is one of THIS org's competitions; a non-editor gets Overview and the On stream loader is never called (R19)
//   - Sponsors (sponsor deals PR 2, Task 13): the tab also reads the org's deals, packages, both plan flags, whether Stripe takes
//     charges, and the competitions' end dates; `?sponsor=` / `?deal=` select a sponsor's own page and a deal on it - kept only if
//     they are THIS org's (a deal: the selected sponsor's) - and the sponsor's report links are read only then, only for an editor
//   - Sponsors (Task 15): `?sponsor=<own>` renders the REAL sponsor page (`data-testid="sponsor-sheet"`, F23 - moved here from Task 13,
//     where nothing yet drew it), for that sponsor, with the Report link's opening dates read for an editor only
//   - The deal page (Task 17): `?sponsor=<own>&deal=<own>` renders the REAL deal page (`data-testid="deal-page"`) on top of its sponsor, and
//     the page makes the timeline's two server reads - the creator's name and "has the competition finished" - only while a deal is
//     selected (and the second only for an open deal that ends with its competition)
//   - Overview (S13): every member gets the numbers for the period the URL names (kept only if it is a period or one of THIS
//     org's competitions), all read at ONE `now`; only an editor's page loads the report links and the share form's defaults
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

/** Task 15: flip to render the page's island for real (the sponsor page is what a person sees behind `?sponsor=`); every other case
 *  reads the marker, which carries exactly what the page handed it. */
const real = vi.hoisted(() => ({ on: false }));

const h = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  resolveLocale: vi.fn(),
  listSponsorRows: vi.fn(),
  listSponsorPackages: vi.fn(),
  listDeals: vi.fn(),
  dealCreatorName: vi.fn(),
  isDealCompetitionFinished: vi.fn(),
  finishedPackageCompetitions: vi.fn(),
  hasFeatureOnAnyPass: vi.fn(),
  featureScopes: vi.fn(),
  sql: vi.fn(),
  loadOnStreamScope: vi.fn(),
  sponsorOverview: vi.fn(),
  listReportLinks: vi.fn(),
  reportLinkDefaults: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({ requireOrgPage: h.requireOrgPage }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: h.resolveLocale }));
vi.mock("@/server/usecases/sponsors", () => ({ listSponsorRows: h.listSponsorRows, listSponsorPackages: h.listSponsorPackages }));
vi.mock("@/server/usecases/sponsor-deals", () => ({
  finishedPackageCompetitions: h.finishedPackageCompetitions,
  listDeals: h.listDeals,
  dealCreatorName: h.dealCreatorName,
  isDealCompetitionFinished: h.isDealCompetitionFinished,
}));
vi.mock("@/lib/entitlements", () => ({ hasFeatureOnAnyPass: h.hasFeatureOnAnyPass, featureScopes: h.featureScopes }));
vi.mock("@/lib/db", () => ({ sql: h.sql }));
vi.mock("@/server/sponsors/on-stream", () => ({ loadOnStreamScope: h.loadOnStreamScope }));
vi.mock("@/server/sponsors/report", () => ({
  sponsorOverview: h.sponsorOverview,
  listReportLinks: h.listReportLinks,
  reportLinkDefaults: h.reportLinkDefaults,
}));

// The existing active-tab scroller (Settings and Directory use it): a marker, so the test can see WHAT it wraps. The real one is a
// client effect (`scrollIntoView` on `[aria-current="page"]`) that prerender never runs.
vi.mock("@/components/ui/scroll-active-tab-into-view", () => ({
  ScrollActiveTabIntoView: ({ children }: { children: React.ReactNode }) => <div data-active-tab-scroller>{children}</div>,
}));

// What the REAL island reaches for when it renders the sponsor page: the confirm dialog and the router (neither is mounted by a
// prerender of the page alone).
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

// The islands, as markers carrying exactly what the page handed them - except OrgSponsors while `real.on` (see above).
vi.mock("@/components/org-sponsors", async (importActual) => {
  const actual = await importActual<typeof import("@/components/org-sponsors")>();
  const Island = (p: Parameters<typeof actual.OrgSponsors>[0]) => <actual.OrgSponsors {...p} />;
  return { ...actual, OrgSponsors: (p: Parameters<typeof actual.OrgSponsors>[0]) => (real.on ? Island(p) : Marker(p)) };
});
function Marker(p: {
    orgId: string;
    initialSponsors: unknown[];
    competitions: { id: string; ends_on?: string | null }[];
    hasTiers: boolean;
    canEdit: boolean;
    billingHref: string;
    hub: {
      orgSlug: string;
      orgTimezone: string | null;
      deals: { id: string }[];
      packages: { id: string }[];
      tiersOrgWide: boolean;
      tiersCompetitionIds: readonly string[];
      hasMonetize: boolean;
      monetizeOrgWide: boolean;
      monetizeCompetitionIds: readonly string[];
      finishedCompetitionIds: readonly string[];
      chargesEnabled: boolean;
      sponsorId: string | null;
      editSponsor: boolean;
      dealId: string | null;
      dealCreatedByName: string | null;
      dealWrittenOffByName: string | null;
      dealCompetitionFinished: boolean;
      reportLinks: { id: string }[];
      reportDefaults: { from: string; to: string } | null;
    };
  }) {
  return (
    <div
      data-testid="org-sponsors"
      data-org={p.orgId}
      data-can-edit={String(p.canEdit)}
      data-has-tiers={String(p.hasTiers)}
      data-sponsors={p.initialSponsors.length}
      data-competitions={p.competitions.length}
      data-competition-ends={p.competitions.map((c) => `${c.id}:${c.ends_on ?? "-"}`).join("|")}
      data-billing={p.billingHref}
      data-hub-slug={p.hub.orgSlug}
      data-hub-org-tz={p.hub.orgTimezone ?? "-"}
      data-hub-deals={p.hub.deals.map((d) => d.id).join("|")}
      data-hub-packages={p.hub.packages.map((k) => k.id).join("|")}
      data-hub-tiers-wide={String(p.hub.tiersOrgWide)}
      data-hub-tiers-ids={p.hub.tiersCompetitionIds.join("|")}
      data-hub-monetize={String(p.hub.hasMonetize)}
      data-hub-monetize-wide={String(p.hub.monetizeOrgWide)}
      data-hub-monetize-ids={p.hub.monetizeCompetitionIds.join("|")}
      data-hub-finished={p.hub.finishedCompetitionIds.join("|")}
      data-hub-charges={String(p.hub.chargesEnabled)}
      data-hub-sponsor={p.hub.sponsorId ?? "-"}
      data-hub-edit={String(p.hub.editSponsor)}
      data-hub-deal={p.hub.dealId ?? "-"}
      data-hub-deal-by={p.hub.dealCreatedByName ?? "-"}
      data-hub-deal-written-off-by={p.hub.dealWrittenOffByName ?? "-"}
      data-hub-deal-finished={String(p.hub.dealCompetitionFinished)}
      data-hub-links={p.hub.reportLinks.map((l) => l.id).join("|")}
      data-hub-defaults={p.hub.reportDefaults === null ? "-" : `${p.hub.reportDefaults.from}..${p.hub.reportDefaults.to}`}
    />
  );
}
vi.mock("@/components/sponsors/on-stream-tab", () => ({
  OnStreamTab: (p: {
    orgId: string;
    orgSlug: string;
    sponsors: { id: string; on_stream: boolean; locked_by_deal: boolean }[];
    competitions: unknown[];
    scope: string | null;
    hasTiers: boolean;
    settings: { enabled: boolean; frequency: string } | null;
    ownRow: boolean;
    sports: unknown[];
  }) => (
    <div
      data-testid="on-stream-island"
      data-org={p.orgId}
      data-slug={p.orgSlug}
      data-sponsors={p.sponsors.map((s) => `${s.id}:${s.on_stream}`).join(",")}
      data-locked={p.sponsors.filter((s) => s.locked_by_deal).map((s) => s.id).join(",")}
      data-locked-flags={p.sponsors.map((s) => String(s.locked_by_deal)).join(",")}
      data-competitions={p.competitions.length}
      data-scope={p.scope ?? "org"}
      data-has-tiers={String(p.hasTiers)}
      data-settings={p.settings === null ? "none" : `${p.settings.enabled}/${p.settings.frequency}`}
      data-own-row={String(p.ownRow)}
      data-sports={p.sports.length}
    />
  ),
}));
vi.mock("@/components/sponsors/overview-tab", () => ({
  OverviewTab: (p: {
    orgId: string;
    orgSlug: string;
    period: { kind: string; competitionId?: string };
    nowIso: string;
    competitions: unknown[];
    rows: { sponsorId: string | null }[];
    canEdit: boolean;
    links: { id: string }[];
    shareDefaults: { from: string; to: string; competitionId: string | null } | null;
  }) => (
    <div
      data-testid="overview-island"
      data-org={p.orgId}
      data-slug={p.orgSlug}
      data-period={p.period.kind === "competition" ? `competition:${p.period.competitionId}` : p.period.kind}
      data-now={p.nowIso}
      data-competitions={p.competitions.length}
      data-rows={p.rows.map((r) => r.sponsorId ?? "gone").join(",")}
      data-can-edit={String(p.canEdit)}
      data-links={p.links.map((l) => l.id).join(",")}
      data-defaults={p.shareDefaults === null ? "none" : `${p.shareDefaults.from}..${p.shareDefaults.to}/${p.shareDefaults.competitionId ?? "-"}`}
    />
  ),
}));
// The Packages tab's island (Task 18): a marker carrying what the page handed it - the packages as the server listed them, the two plan
// flags (affordances), the competitions for the scope picker, which have finished, and whether the viewer may write.
vi.mock("@/components/sponsors/package-list", () => ({
  PackageList: (p: {
    orgId: string;
    initialPackages: { id: string }[];
    competitions: { id: string; name: string }[];
    tiersOrgWide: boolean;
    tiersCompetitionIds: readonly string[];
    hasMonetize: boolean;
    billingHref: string;
    finishedCompetitionIds: readonly string[];
    canEdit: boolean;
  }) => (
    <div
      data-testid="package-list-island"
      data-org={p.orgId}
      data-packages={p.initialPackages.map((k) => k.id).join("|")}
      data-competitions={p.competitions.map((c) => `${c.id}:${c.name}`).join("|")}
      data-tiers-wide={String(p.tiersOrgWide)}
      data-tiers-ids={p.tiersCompetitionIds.join("|")}
      data-has-monetize={String(p.hasMonetize)}
      data-billing={p.billingHref}
      data-finished={p.finishedCompetitionIds.join("|")}
      data-can-edit={String(p.canEdit)}
    />
  ),
}));

import SponsorsHubPage from "../page";
import { SPONSORS_EDITOR_ONLY_TABS, SPONSORS_TABS, sponsorsHref, type SponsorsTab } from "@/lib/sponsors-hub";
import { LOCALES } from "@/lib/i18n-constants";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const UI_BY_LOCALE = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;

const ORG = { id: "org-1", name: "Riverside", slug: "riverside", role: "owner", timezone: "America/Los_Angeles" as string | null };

async function render(
  tab?: string,
  scope?: string | string[],
  period?: string | string[],
  pick: { sponsor?: string | string[]; deal?: string | string[]; edit?: string | string[] } = {},
): Promise<string> {
  const element = await SponsorsHubPage({
    params: Promise.resolve({ orgSlug: ORG.slug }),
    searchParams: Promise.resolve({
      ...(tab === undefined ? {} : { tab }),
      ...(scope === undefined ? {} : { scope }),
      ...(period === undefined ? {} : { period }),
      ...(pick.sponsor === undefined ? {} : { sponsor: pick.sponsor }),
      ...(pick.deal === undefined ? {} : { deal: pick.deal }),
      ...(pick.edit === undefined ? {} : { edit: pick.edit }),
    }),
  });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Which panels (`data-testid="sponsors-tab-<tab>"`) the page rendered. Anchored on `="` so an omitted prop cannot satisfy it. */
const panels = (html: string): SponsorsTab[] =>
  SPONSORS_TABS.filter((tab) => html.includes(`data-testid="sponsors-tab-${tab}"`));

/** The tab bar's links, in document order, with their href and whether they are marked current. */
function tabLinks(html: string): { tab: string; href: string; current: boolean }[] {
  return [...html.matchAll(/<a\b([^>]*)>/g)]
    .map((m) => m[1] ?? "")
    .filter((attrs) => /data-testid="sponsors-tab-link-/.test(attrs))
    .map((attrs) => ({
      tab: /data-testid="sponsors-tab-link-([a-z_]+)"/.exec(attrs)?.[1] ?? "",
      href: /href="([^"]*)"/.exec(attrs)?.[1]?.replaceAll("&amp;", "&") ?? "",
      current: /aria-current="page"/.test(attrs),
    }));
}

const attr = (html: string, testid: string, name: string): string | undefined =>
  new RegExp(`data-testid="${testid}"[^>]*? ${name}="([^"]*)"`).exec(html)?.[1];

function asMember(role: "owner" | "admin" | "viewer", canEdit: boolean): void {
  h.requireOrgPage.mockResolvedValue({
    user: { id: "u1" },
    org: { ...ORG, role },
    canEdit,
    auth: { orgId: ORG.id, via: "session", userId: "u1", role, keyId: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveLocale.mockResolvedValue("en");
  h.listSponsorRows.mockResolvedValue([
    { id: "s1", name: "Harbour", tier: "gold", status: "active", competition_id: null, on_stream: true, display_order: 3, locked_by_deal: false },
    { id: "s2", name: "Ridge", tier: "partner", status: "active", competition_id: "c1", on_stream: false, display_order: 0, locked_by_deal: true },
  ]);
  h.listDeals.mockResolvedValue([
    { id: "d1", sponsor_id: "s1" },
    { id: "d2", sponsor_id: "s1" },
    { id: "d3", sponsor_id: "s2" },
  ]);
  h.listSponsorPackages.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
  h.dealCreatorName.mockResolvedValue("Sam Patel");
  h.isDealCompetitionFinished.mockResolvedValue(false);
  h.finishedPackageCompetitions.mockResolvedValue(["c2"]);
  h.loadOnStreamScope.mockResolvedValue({ settings: { enabled: true, frequency: "busy" }, ownRow: true, sports: [{ sportKey: "cricket", kinds: [], sample: null, sampleCompetitionId: null }] });
  h.hasFeatureOnAnyPass.mockResolvedValue(true);
  h.featureScopes.mockImplementation(async (org: string, key: string) => ({ orgWide: await h.hasFeatureOnAnyPass(org, key), competitionIds: [] }));
  // The page makes two reads through `sql`: the org's competitions, and whether its Stripe account takes charges. One mock cannot
  // answer both the same way, so it answers by the query's own text.
  h.sql.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join("?").includes("stripe_charges_enabled")
      ? [{ stripe_account_id: "acct_1", stripe_charges_enabled: true }]
      : [
          { id: "c1", name: "Spring Cup", ends_on: "2027-08-31" },
          { id: "c2", name: "Autumn Cup", ends_on: null },
          { id: "c3", name: "Cup 3", ends_on: "2026-12-01" },
        ],
  );
  h.sponsorOverview.mockResolvedValue([{ sponsorId: "s1" }, { sponsorId: null }]);
  h.listReportLinks.mockResolvedValue([{ id: "l1" }, { id: "l2" }]);
  h.reportLinkDefaults.mockResolvedValue({ from: "2026-01-01", to: "2026-12-31", competitionId: null });
  asMember("owner", true);
});

describe("the Sponsors hub - which tab opens", () => {
  it("no tab => Overview, marked current, and nothing else rendered", async () => {
    const html = await render();
    expect(panels(html)).toEqual(["overview"]);
    expect(tabLinks(html).filter((l) => l.current).map((l) => l.tab)).toEqual(["overview"]);
  });

  it("an unknown tab, an empty tab and an inherited object key => Overview (never a blank page, never a 404)", async () => {
    let checked = 0;
    for (const raw of ["bogus", "", "__proto__", "constructor", "Sponsors", "settings"]) {
      const html = await render(raw);
      expect(panels(html), JSON.stringify(raw)).toEqual(["overview"]);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("every declared tab renders its own panel and ONLY its own - an editor sees all four (counted)", async () => {
    let checked = 0;
    for (const tab of SPONSORS_TABS) {
      const html = await render(tab);
      expect(panels(html), `?tab=${tab}`).toEqual([tab]);
      expect(tabLinks(html).filter((l) => l.current).map((l) => l.tab), `?tab=${tab} current`).toEqual([tab]);
      checked++;
    }
    expect(checked).toBe(SPONSORS_TABS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the Sponsors hub - the tab bar", () => {
  it("an editor is offered every declared tab, in declared order, each linking to the hub's own URL for it", async () => {
    const links = tabLinks(await render());
    expect(links.map((l) => l.tab)).toEqual([...SPONSORS_TABS]);
    for (const l of links) expect(l.href, l.tab).toBe(sponsorsHref(ORG.slug, l.tab as SponsorsTab));
  });

  it("the bar the page draws reads Overview, Sponsors, Packages, On stream (owner, 2026-11-11), whatever order the declaration is read in", async () => {
    const links = tabLinks(await render());
    expect(links.map((l) => l.tab), "the editor's bar, left to right").toEqual(["overview", "sponsors", "packages", "on_stream"]);
    asMember("viewer", false);
    expect(tabLinks(await render()).map((l) => l.tab), "a viewer's bar keeps the same relative order").toEqual(["overview", "sponsors"]);
  });

  it("a non-editor is offered every tab EXCEPT the editor-only ones (the read-only view)", async () => {
    asMember("viewer", false);
    const links = tabLinks(await render());
    expect(links.length).toBeGreaterThan(0);
    expect(links.map((l) => l.tab)).toEqual(SPONSORS_TABS.filter((t) => !SPONSORS_EDITOR_ONLY_TABS.includes(t)));
  });

  it("has an h1 for the hub and a labelled tab navigation", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Sponsors<\/h1>/);
    expect(html).toMatch(/<nav[^>]*aria-label="Sponsors sections"/);
  });
});

// The Sponsors hub's back link (owner, 2026-11-11: "we should have back button in sponsor page like in streaming page"). The Streaming
// page renders `<BackLink href="/dashboard" label={t(ui, "common.dashboard")} />` above its heading; the hub renders the same. The
// label is the existing `common.dashboard` key, so every expected string below is read from the dictionary files - never typed here.
// The page has ONE return (`requireOrgPage` redirects or 404s before it), so there is no early-return branch to carry the link: "every
// branch" is every tab, every reader and every locale, each counted.
describe("the Sponsors hub - the back link to the dashboard (the Streaming page's)", () => {
  /** Every anchor whose href is exactly `/dashboard` (anchored on `="`, so an omitted href cannot satisfy it), with its inner text. */
  const dashboardLinks = (html: string): { tag: string; text: string; at: number }[] =>
    [...html.matchAll(/<a\b([^>]*\bhref="\/dashboard"[^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
      tag: m[0].slice(0, m[0].indexOf(">") + 1),
      text: m[2]!.replace(/<[^>]+>/g, "").trim(),
      at: m.index ?? -1,
    }));

  it("every tab an editor can open has exactly ONE link to /dashboard, labelled from common.dashboard (counted)", async () => {
    let checked = 0;
    for (const tab of SPONSORS_TABS) {
      const links = dashboardLinks(await render(tab));
      expect(links, `?tab=${tab}: exactly one back link`).toHaveLength(1);
      expect(links[0]!.text, `?tab=${tab}: its label`).toBe(uiEn["common.dashboard"]);
      checked++;
    }
    expect(checked).toBe(SPONSORS_TABS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a viewer has it too - on the tabs they are offered AND on an editor-only tab that falls back to Overview (counted)", async () => {
    asMember("viewer", false);
    let checked = 0;
    for (const tab of SPONSORS_TABS) {
      const html = await render(tab);
      expect(dashboardLinks(html), `viewer ?tab=${tab}`).toHaveLength(1);
      checked++;
    }
    // The pair: the editor-only tabs really did fall back (so the loop reached the fall-back branch, not only the offered tabs).
    expect(SPONSORS_EDITOR_ONLY_TABS.length, "anti-vacuity: the hub declares editor-only tabs").toBeGreaterThan(0);
    expect(panels(await render(SPONSORS_EDITOR_ONLY_TABS[0]!)), "an editor-only tab falls back to Overview").toEqual(["overview"]);
    expect(checked).toBe(SPONSORS_TABS.length);
  });

  it("every locale: the label is that locale's common.dashboard, and the locales do not all say the same word (counted)", async () => {
    const seen = new Set<string>();
    let checked = 0;
    for (const locale of LOCALES) {
      h.resolveLocale.mockResolvedValue(locale);
      const want = UI_BY_LOCALE[locale]!["common.dashboard"];
      expect(typeof want, `${locale}: the dictionary has the key`).toBe("string");
      const links = dashboardLinks(await render());
      expect(links, locale).toHaveLength(1);
      expect(links[0]!.text, locale).toBe(want);
      seen.add(want!);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(seen.size, "a hardcoded English label would collapse these to one").toBeGreaterThan(1);
  });

  it("it sits in <main>, above the h1, the tab bar and the panel - and is NOT one of the tab bar's links or inside the panel", async () => {
    let checked = 0;
    for (const tab of SPONSORS_TABS) {
      const html = await render(tab);
      expect(dashboardLinks(html), `?tab=${tab}: the back link is there`).toHaveLength(1);
      const link = dashboardLinks(html)[0]!;
      const main = html.indexOf("<main");
      const h1 = html.indexOf("<h1");
      const nav = html.indexOf('aria-label="Sponsors sections"');
      const panel = html.indexOf(`data-testid="sponsors-tab-${tab}"`);
      expect(main, `?tab=${tab}: <main> is in the markup`).toBeGreaterThanOrEqual(0);
      expect([main, link.at, h1, nav, panel].every((n, i, a) => i === 0 || n > a[i - 1]!), `?tab=${tab}: main < back link < h1 < tab bar < panel`).toBe(true);
      // The negative pair: the tab bar still holds exactly the declared tabs (the e2e counts its anchors), none of them /dashboard.
      expect(tabLinks(html).map((l) => l.tab), `?tab=${tab}: the tab bar is unchanged`).toEqual([...SPONSORS_TABS]);
      expect(tabLinks(html).filter((l) => l.href === "/dashboard"), `?tab=${tab}: the back link is not a tab`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(SPONSORS_TABS.length);
  });

  it("it is the Streaming page's quiet link, not a button, and it names its destination in words (no bare arrow)", async () => {
    const links = dashboardLinks(await render());
    expect(links, "the back link is there").toHaveLength(1);
    const link = links[0]!;
    expect(link.text.length, "the link says where it goes").toBeGreaterThan(0);
    expect(link.tag, "quiet emphasis").toMatch(/class="[^"]*\btext-slate-500\b/);
    expect(link.tag, "not the ghost-button chrome").not.toMatch(/class="[^"]*\bbtn\b/);
  });

  it("with a sponsor's page open it is still the ONE link to /dashboard, and the sheet keeps its own 'Back to sponsors'", async () => {
    real.on = true;
    try {
      h.listSponsorRows.mockResolvedValue([
        { id: "s1", name: "Harbour Print", competition_id: null, url: null, logo_path: null, tier: "gold", display_order: 0, status: "active", click_count: 0, on_stream: false, archived_at: null, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null },
      ]);
      h.listDeals.mockResolvedValue([]);
      const html = await render("sponsors", undefined, undefined, { sponsor: "s1" });
      expect(html, "premise: the sponsor's own page is what rendered").toContain('data-testid="sponsor-sheet"');
      expect(dashboardLinks(html), "the page's back link").toHaveLength(1);
      expect(html, "the sheet's own back control is untouched").toContain(`aria-label="${uiEn["sponsors.sheet.backLabel"]}"`);
    } finally {
      real.on = false;
    }
  });
});

// The page header matches Streaming's (owner, 2026-11-11: "we don't have lime board under sponsor", Streaming screenshot confirmed
// "right"): the lime-bar eyebrow (`app-eyebrow`) above the title and a one-line description under it, then the tabs. Streaming's markup is
// `<p class="app-eyebrow mb-1">` / `<h1 class="page-title">` / `<p class="mt-1 max-w-xl text-sm text-slate-500">`. Expected words come from the
// dictionary files, never typed here; the HTML is entity-decoded first (`&` is `&amp;`, an apostrophe is `&#x27;`).
describe("the Sponsors hub - the page header matches Streaming's: eyebrow, title, description, then the tabs", () => {
  const decode = (s: string): string =>
    s.replace(/<[^>]+>/g, "").replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").trim();
  /** Every `<p>` whose class list holds `cls` (anchored on `class="`, so an omitted class cannot satisfy it), with its decoded text and position. */
  const paragraphs = (html: string, cls: string): { tag: string; text: string; at: number }[] =>
    [...html.matchAll(/<p\b([^>]*\bclass="([^"]*)"[^>]*)>([\s\S]*?)<\/p>/g)]
      .filter((m) => m[2]!.split(/\s+/).includes(cls))
      .map((m) => ({ tag: m[0].slice(0, m[0].indexOf(">") + 1), text: decode(m[3]!), at: m.index ?? -1 }));
  const eyebrows = (html: string) => paragraphs(html, "app-eyebrow");
  const descriptions = (html: string) => paragraphs(html, "max-w-xl");

  it("every locale: the eyebrow and the description are that locale's sponsors.eyebrow and sponsors.desc, each exactly once (counted)", async () => {
    const eyebrowWords = new Set<string>();
    const descWords = new Set<string>();
    let checked = 0;
    for (const locale of LOCALES) {
      h.resolveLocale.mockResolvedValue(locale);
      const wantEyebrow = UI_BY_LOCALE[locale]!["sponsors.eyebrow"];
      const wantDesc = UI_BY_LOCALE[locale]!["sponsors.desc"];
      expect(typeof wantEyebrow, `${locale}: the dictionary has sponsors.eyebrow`).toBe("string");
      expect(typeof wantDesc, `${locale}: the dictionary has sponsors.desc`).toBe("string");
      const html = await render();
      expect(eyebrows(html).map((p) => p.text), `${locale}: one eyebrow`).toEqual([wantEyebrow]);
      expect(descriptions(html).map((p) => p.text), `${locale}: one description`).toEqual([wantDesc]);
      eyebrowWords.add(wantEyebrow!);
      descWords.add(wantDesc!);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(eyebrowWords.size, "hardcoded English would collapse the eyebrows to one").toBe(LOCALES.length);
    expect(descWords.size, "hardcoded English would collapse the descriptions to one").toBe(LOCALES.length);
  });

  it("the eyebrow is the lime-bar one (`app-eyebrow`) at Streaming's `mb-1`; the description is Streaming's quiet line", async () => {
    const html = await render();
    const [eyebrow] = eyebrows(html);
    const [desc] = descriptions(html);
    expect(eyebrow, "the eyebrow is there").toBeDefined();
    expect(desc, "the description is there").toBeDefined();
    expect(eyebrow!.tag).toMatch(/class="app-eyebrow mb-1"/);
    expect(desc!.tag).toMatch(/class="[^"]*\bmt-1\b[^"]*\bmax-w-xl\b[^"]*\btext-sm\b[^"]*\btext-slate-500\b/);
  });

  it("every tab, editor and viewer: back link -> eyebrow -> h1 -> description -> tab bar -> panel, in that order (counted)", async () => {
    let checked = 0;
    for (const canEdit of [true, false]) {
      asMember(canEdit ? "owner" : "viewer", canEdit);
      for (const tab of SPONSORS_TABS) {
        const html = await render(tab);
        const back = /<a\b[^>]*\bhref="\/dashboard"/.exec(html)?.index ?? -1;
        const eyebrow = eyebrows(html)[0]?.at ?? -1;
        const h1 = html.indexOf("<h1");
        const desc = descriptions(html)[0]?.at ?? -1;
        const nav = html.indexOf('aria-label="Sponsors sections"');
        // The panel that opened: a viewer asking for an editor-only tab is shown Overview, so read WHICH panel rendered (exactly one).
        const shown = panels(html);
        expect(shown, `${canEdit ? "editor" : "viewer"} ?tab=${tab}: one panel`).toHaveLength(1);
        const panel = html.indexOf(`data-testid="sponsors-tab-${shown[0]}"`);
        const order = [back, eyebrow, h1, desc, nav, panel];
        const who = `${canEdit ? "editor" : "viewer"} ?tab=${tab}`;
        expect(order.every((n) => n >= 0), `${who}: all six parts are in the markup (${order.join(",")})`).toBe(true);
        expect(order.every((n, i, a) => i === 0 || n > a[i - 1]!), `${who}: order is back, eyebrow, h1, description, tabs, panel (${order.join(",")})`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(SPONSORS_TABS.length * 2);
  });

  it("the gap above the tab bar is unchanged: it sits BELOW the description on the header's wrapper, not on the h1 any more", async () => {
    const html = await render();
    const h1Tag = /<h1\b[^>]*>/.exec(html)?.[0] ?? "";
    expect(h1Tag, "the title is still the page title").toMatch(/class="[^"]*\bpage-title\b/);
    expect(h1Tag, "the title no longer carries the gap").not.toMatch(/\bmb-4\b|\bmd:mb-6\b/);
    // The wrapper is the element holding the eyebrow, the title and the description.
    const wrapper = /<div class="([^"]*)">\s*<p class="app-eyebrow/.exec(html)?.[1];
    expect(wrapper, "eyebrow, title and description share one wrapper").toBeDefined();
    expect(wrapper!.split(/\s+/), "the old h1 gap, intact").toEqual(expect.arrayContaining(["mb-4", "md:mb-6"]));
    // And nothing sits between the wrapper and the tab bar's scroller: the gap is the only thing separating them.
    expect(html, "the wrapper closes straight into the tab bar").toMatch(/<\/p><\/div><div data-active-tab-scroller/);
  });
});

describe("the tab bar scrolls its active tab into view (the Settings and Directory precedent; at 320 the 4th tab is off-screen)", () => {
  it("the nav sits inside the active-tab scroller and the current tab is inside it too, for every tab (counted)", async () => {
    let checked = 0;
    for (const tab of SPONSORS_TABS) {
      const html = await render(tab);
      const scroller = /<div data-active-tab-scroller[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
      expect(scroller, `?tab=${tab}: the nav is wrapped`).toBeDefined();
      expect(scroller, `?tab=${tab}: the wrapper holds the tab bar`).toContain('aria-label="Sponsors sections"');
      // The scroller finds its target with `[aria-current="page"]`: the current tab must carry it, inside the wrapper.
      expect(scroller, `?tab=${tab}: the current tab is inside it`).toMatch(new RegExp(`data-testid="sponsors-tab-link-${tab}"[^>]*aria-current="page"|aria-current="page"[^>]*data-testid="sponsors-tab-link-${tab}"`));
      expect(scroller!.match(/aria-current="page"/g), `?tab=${tab}: exactly one current tab`).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(SPONSORS_TABS.length);
  });
});

describe("a panel's heading IS its tab's label - one declaration, so the two cannot disagree (m2)", () => {
  /** The visible text of an element found by its exact attribute, tags stripped. */
  const textOf = (html: string, re: RegExp): string | undefined => re.exec(html)?.[1]?.replace(/<[^>]+>/g, "").trim();

  it("every tab, in every locale: the tab link, the panel heading and the dictionary label are the same string (counted)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      h.resolveLocale.mockResolvedValue(locale);
      for (const tab of SPONSORS_TABS) {
        const label = UI_BY_LOCALE[locale]![`sponsors.hub.tab.${tab}`];
        expect(typeof label, `${locale}/${tab}: the dictionary has the label`).toBe("string");
        const html = await render(tab);
        const link = textOf(html, new RegExp(`<a[^>]*data-testid="sponsors-tab-link-${tab}"[^>]*>([\\s\\S]*?)</a>`));
        const heading = textOf(html, new RegExp(`<h2 id="sponsors-tab-${tab}-heading"[^>]*>([\\s\\S]*?)</h2>`));
        expect(link, `${locale}/${tab}: tab link`).toBe(label);
        expect(heading, `${locale}/${tab}: panel heading`).toBe(label);
        // ...and the section is labelled BY that heading, so a screen reader announces the same words as the tab.
        expect(html, `${locale}/${tab}: aria-labelledby`).toContain(`aria-labelledby="sponsors-tab-${tab}-heading"`);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * SPONSORS_TABS.length);
    expect(checked).toBeGreaterThanOrEqual(16);
  });

  it("the Packages panel no longer says 'Sell sponsorship' (the retired heading) - it says what its tab says", async () => {
    h.resolveLocale.mockResolvedValue("en");
    const html = await render("packages");
    expect(html).not.toContain("Sell sponsorship");
    expect(html).toMatch(/<h2 id="sponsors-tab-packages-heading"[^>]*>Packages<\/h2>/);
    expect(html, "orders are deals now and live on the Sponsors tab").not.toMatch(/Packages and orders/);
  });
});

describe("the Sponsors tab keeps Settings' gates: sponsors.tiers, granted AND denied", () => {
  it("granted => OrgSponsors gets hasTiers true; the question is asked per scope (featureScopes) for sponsors.tiers", async () => {
    h.hasFeatureOnAnyPass.mockResolvedValue(true);
    const html = await render("sponsors");
    expect(attr(html, "org-sponsors", "data-has-tiers")).toBe("true");
    expect(h.featureScopes).toHaveBeenCalledWith(ORG.id, "sponsors.tiers");
  });

  it("denied => hasTiers false (the upsell arm), and the list is still the org's", async () => {
    h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => key !== "sponsors.tiers");
    const html = await render("sponsors");
    expect(attr(html, "org-sponsors", "data-has-tiers")).toBe("false");
    expect(attr(html, "org-sponsors", "data-sponsors")).toBe("2");
    expect(h.listSponsorRows).toHaveBeenCalledWith(ORG.id, { includeArchived: true });
  });

  it("archive spec §6.2: the Sponsors tab reads archived rows too (its switch needs N and the rows); the On stream tab reads none", async () => {
    await render("sponsors");
    expect(h.listSponsorRows.mock.calls, "the Sponsors tab").toEqual([[ORG.id, { includeArchived: true }]]);
    h.listSponsorRows.mockClear();
    await render("on_stream");
    expect(h.listSponsorRows.mock.calls, "the On stream tab: the default, archived rows left out").toEqual([[ORG.id]]);
  });

  it("hands the composer the org's competitions as its picker, and the billing URL for the upsell", async () => {
    const html = await render("sponsors");
    expect(attr(html, "org-sponsors", "data-org")).toBe(ORG.id);
    expect(attr(html, "org-sponsors", "data-competitions")).toBe("3");
    expect(attr(html, "org-sponsors", "data-billing")).toBe("/o/riverside/settings/billing");
  });

  it("an editor gets canEdit true", async () => {
    expect(attr(await render("sponsors"), "org-sponsors", "data-can-edit")).toBe("true");
  });
});

describe("the Packages tab is the price list, on every plan (sponsor deals PR 2, Task 18; D17)", () => {
  const auth = { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null };

  it("hands the island the org's packages as the server listed them, its competitions for the scope picker, and the billing URL", async () => {
    const html = await render("packages");
    expect(h.listSponsorPackages).toHaveBeenCalledTimes(1);
    expect(h.listSponsorPackages).toHaveBeenCalledWith(auth);
    expect(attr(html, "package-list-island", "data-org")).toBe(ORG.id);
    expect(attr(html, "package-list-island", "data-packages")).toBe("p1|p2");
    expect(attr(html, "package-list-island", "data-competitions")).toBe("c1:Spring Cup|c2:Autumn Cup|c3:Cup 3");
    expect(attr(html, "package-list-island", "data-billing")).toBe("/o/riverside/settings/billing");
    expect(attr(html, "package-list-island", "data-can-edit")).toBe("true");
  });

  it("the empty case: an org with no packages still gets the list, with an EMPTY package list (not a missing one) - and Create", async () => {
    h.listSponsorPackages.mockResolvedValue([]);
    const html = await render("packages");
    expect(html).toContain('data-testid="package-list-island"');
    expect(attr(html, "package-list-island", "data-packages")).toBe("");
    expect(attr(html, "package-list-island", "data-can-edit")).toBe("true");
  });

  it("a community org - NEITHER flag granted - still gets the list and its packages: the page is not gated, only the tier and scope inside it", async () => {
    h.hasFeatureOnAnyPass.mockResolvedValue(false);
    const html = await render("packages");
    expect(html).toContain('data-testid="package-list-island"');
    expect(attr(html, "package-list-island", "data-packages")).toBe("p1|p2");
    expect(attr(html, "package-list-island", "data-tiers-wide")).toBe("false");
    expect(attr(html, "package-list-island", "data-tiers-ids")).toBe("");
    expect(attr(html, "package-list-island", "data-has-monetize")).toBe("false");
  });

  it("both plan flags are affordances, each answered on its own: the four combinations (counted), asked org-wide for each key", async () => {
    let checked = 0;
    for (const tiers of [true, false]) {
      for (const monetize of [true, false]) {
        h.hasFeatureOnAnyPass.mockClear();
        h.featureScopes.mockClear();
        h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => (key === "sponsors.tiers" ? tiers : key === "sponsors.monetize" ? monetize : false));
        const html = await render("packages");
        const label = `tiers=${tiers} monetize=${monetize}`;
        expect(attr(html, "package-list-island", "data-tiers-wide"), label).toBe(String(tiers));
        expect(attr(html, "package-list-island", "data-has-monetize"), label).toBe(String(monetize));
        expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1]).sort(), label).toEqual(["sponsors.monetize", "sponsors.tiers"]);
        expect(h.featureScopes.mock.calls.map((c) => c[1]), `${label}: tiers are asked per scope, monetize is the any-pass question`).toEqual(["sponsors.tiers"]);
        expect(h.hasFeatureOnAnyPass).toHaveBeenCalledWith(ORG.id, "sponsors.monetize");
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("the competitions the scope picker offers are THIS org's only: the org id is bound into the read, and only that read", async () => {
    await render("packages");
    const reads = h.sql.mock.calls.map((c) => ({ text: (c[0] as TemplateStringsArray).join("?"), values: c.slice(1) }));
    const comps = reads.filter((r) => r.text.includes("from competitions"));
    expect(comps, "exactly one competitions read").toHaveLength(1);
    expect(comps[0]!.values).toEqual([ORG.id]);
    expect(reads.filter((r) => r.text.includes("stripe_charges_enabled")), "the Add deal sheet's Stripe read is the Sponsors tab's").toEqual([]);
  });

  it("reads no sponsors: the invoice form and its picker are gone (a deal is added from a sponsor)", async () => {
    await render("packages");
    expect(h.listSponsorRows).not.toHaveBeenCalled();
    expect(h.listDeals, "and no orders list: deals live on the Sponsors tab").not.toHaveBeenCalled();
    expect(h.featureScopes.mock.calls.map((c) => c[1]), "the only per-scope read is the tiers one").toEqual(["sponsors.tiers"]);
  });
});

describe("the Packages tab hands over which packages' competitions have finished (batch F review m4)", () => {
  // The card marks those packages as not sold; createDeal refuses them anyway (409 competition_finished). The ids are the usecase's
  // answer, handed over as they are - on every plan, since the tab is.
  it("asks finishedPackageCompetitions for THIS org and hands its answer over as it is", async () => {
    const html = await render("packages");
    expect(h.finishedPackageCompetitions).toHaveBeenCalledWith(ORG.id);
    expect(attr(html, "package-list-island", "data-finished")).toBe("c2");
  });

  it("nothing finished: an EMPTY list, not a missing one", async () => {
    h.finishedPackageCompetitions.mockResolvedValue([]);
    expect(attr(await render("packages"), "package-list-island", "data-finished")).toBe("");
  });

  it("a community org reads it too (the pair of the old 'a plan without the feature asks nothing')", async () => {
    h.hasFeatureOnAnyPass.mockResolvedValue(false);
    expect(attr(await render("packages"), "package-list-island", "data-finished")).toBe("c2");
    expect(h.finishedPackageCompetitions).toHaveBeenCalledTimes(1);
  });

  it("a tab that shows neither packages nor deals never asks (the page loads only what its tab shows)", async () => {
    await render("on_stream");
    await render("overview");
    expect(h.finishedPackageCompetitions).not.toHaveBeenCalled();
    expect(h.featureScopes).not.toHaveBeenCalled();
  });
});

describe("the Sponsors tab hands the Add deal sheet WHERE online selling is on, and which packages' competitions have finished (batch H fix round 1: m1, m2)", () => {
  // The server gates sponsors.monetize PER SCOPE (an Event Pass lifts its own competition, not the organisation), so a boolean "has
  // it anywhere" cannot say which packages may be invoiced online. The page hands over the answer `featureScopes` gave, as it is.
  const monetize = (html: string) => ({
    anywhere: attr(html, "org-sponsors", "data-hub-monetize"),
    wide: attr(html, "org-sponsors", "data-hub-monetize-wide"),
    ids: attr(html, "org-sponsors", "data-hub-monetize-ids"),
  });

  it("asks featureScopes for sponsors.tiers and sponsors.monetize for THIS org, and for nothing else", async () => {
    await render("sponsors");
    expect(h.featureScopes).toHaveBeenCalledTimes(2);
    expect(h.featureScopes).toHaveBeenCalledWith(ORG.id, "sponsors.tiers");
    expect(h.featureScopes).toHaveBeenCalledWith(ORG.id, "sponsors.monetize");
  });

  it("tiers arrive as featureScopes answered, in every shape (4 checked, both tabs): the Event Pass lifts its own competition and never the whole organisation", async () => {
    const SHAPES: [string, { orgWide: boolean; competitionIds: string[] }, { wide: string; ids: string; hasTiers: string }][] = [
      ["a paid plan", { orgWide: true, competitionIds: [] }, { wide: "true", ids: "", hasTiers: "true" }],
      ["an Event Pass on one competition", { orgWide: false, competitionIds: ["c1"] }, { wide: "false", ids: "c1", hasTiers: "true" }],
      ["Event Passes on two", { orgWide: false, competitionIds: ["c1", "c3"] }, { wide: "false", ids: "c1|c3", hasTiers: "true" }],
      ["no plan and no pass", { orgWide: false, competitionIds: [] }, { wide: "false", ids: "", hasTiers: "false" }],
    ];
    let checked = 0;
    for (const [label, answer, want] of SHAPES) {
      h.featureScopes.mockImplementation(async (_org: string, key: string) => (key === "sponsors.tiers" ? answer : { orgWide: false, competitionIds: [] }));
      const sponsors = await render("sponsors");
      expect(
        { wide: attr(sponsors, "org-sponsors", "data-hub-tiers-wide"), ids: attr(sponsors, "org-sponsors", "data-hub-tiers-ids"), hasTiers: attr(sponsors, "org-sponsors", "data-has-tiers") },
        `${label}: Sponsors tab`,
      ).toEqual(want);
      const packages = await render("packages");
      expect({ wide: attr(packages, "package-list-island", "data-tiers-wide"), ids: attr(packages, "package-list-island", "data-tiers-ids") }, `${label}: Packages tab`).toEqual({
        wide: want.wide,
        ids: want.ids,
      });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the answer arrives as it is, in every shape the entitlement can take (4 checked): org-wide, a pass on one competition, passes on two, none", async () => {
    const CASES: [string, { orgWide: boolean; competitionIds: string[] }, { anywhere: string; wide: string; ids: string }][] = [
      ["a paid plan", { orgWide: true, competitionIds: [] }, { anywhere: "true", wide: "true", ids: "" }],
      ["an Event Pass on one competition", { orgWide: false, competitionIds: ["c1"] }, { anywhere: "true", wide: "false", ids: "c1" }],
      ["Event Passes on two", { orgWide: false, competitionIds: ["c1", "c3"] }, { anywhere: "true", wide: "false", ids: "c1|c3" }],
      ["no plan and no pass", { orgWide: false, competitionIds: [] }, { anywhere: "false", wide: "false", ids: "" }],
    ];
    let checked = 0;
    for (const [label, answer, want] of CASES) {
      h.featureScopes.mockResolvedValue(answer);
      expect(monetize(await render("sponsors")), label).toEqual(want);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("asks finishedPackageCompetitions for THIS org and hands its answer over as it is; nothing finished is an EMPTY list", async () => {
    expect(attr(await render("sponsors"), "org-sponsors", "data-hub-finished")).toBe("c2");
    expect(h.finishedPackageCompetitions).toHaveBeenCalledWith(ORG.id);
    h.finishedPackageCompetitions.mockResolvedValue([]);
    expect(attr(await render("sponsors"), "org-sponsors", "data-hub-finished")).toBe("");
    h.finishedPackageCompetitions.mockResolvedValue(["c1", "c3"]);
    expect(attr(await render("sponsors"), "org-sponsors", "data-hub-finished")).toBe("c1|c3");
  });

});

describe("the Sponsors tab loads what the sponsor and deal screens read (sponsor deals PR 2, Task 13)", () => {
  const auth = { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null };

  it("reads the org's deals and packages as the signed-in member, and hands over what it read, in order", async () => {
    const html = await render("sponsors");
    expect(h.listDeals).toHaveBeenCalledTimes(1);
    expect(h.listDeals).toHaveBeenCalledWith(auth);
    expect(h.listSponsorPackages).toHaveBeenCalledTimes(1);
    expect(h.listSponsorPackages).toHaveBeenCalledWith(auth);
    expect(attr(html, "org-sponsors", "data-hub-deals")).toBe("d1|d2|d3");
    expect(attr(html, "org-sponsors", "data-hub-packages")).toBe("p1|p2");
    expect(attr(html, "org-sponsors", "data-hub-slug")).toBe(ORG.slug);
    // The org's own zone crosses the page: the deal page reads a deal's "Ends on" day back in it (the club typed it there), never in the viewer's.
    expect(attr(html, "org-sponsors", "data-hub-org-tz")).toBe("America/Los_Angeles");
  });

  it("an org with no timezone (V305 allows NULL) hands over null, not a guess - the deal page reads it as UTC, the producer's own fallback", async () => {
    h.requireOrgPage.mockResolvedValue({
      user: { id: "u1" },
      org: { ...ORG, role: "owner", timezone: null },
      canEdit: true,
      auth: { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null },
    });
    expect(attr(await render("sponsors"), "org-sponsors", "data-hub-org-tz")).toBe("-");
  });

  it("the empty case: an org with no deals and no packages hands over EMPTY lists (not missing ones)", async () => {
    h.listDeals.mockResolvedValue([]);
    h.listSponsorPackages.mockResolvedValue([]);
    const html = await render("sponsors");
    expect(html).toContain('data-testid="org-sponsors"');
    expect(attr(html, "org-sponsors", "data-hub-deals")).toBe("");
    expect(attr(html, "org-sponsors", "data-hub-packages")).toBe("");
  });

  it("whether the org can take charges is read from the org: a connected account AND charges enabled, each denied on its own (review M4)", async () => {
    // The server's checkoutOrg refuses a deal's Checkout unless the org has BOTH a Stripe account and charges enabled
    // (`!org.stripe_account_id || !org.stripe_charges_enabled` -> 409 connect_required), so the Add deal sheet's Send invoice
    // must be offered on exactly that, not on the flag alone.
    const CASES: [string, Record<string, unknown>[], string][] = [
      ["connected and charges enabled", [{ stripe_account_id: "acct_1", stripe_charges_enabled: true }], "true"],
      ["connected, charges not enabled yet", [{ stripe_account_id: "acct_1", stripe_charges_enabled: false }], "false"],
      ["charges flag set but NO connected account", [{ stripe_account_id: null, stripe_charges_enabled: true }], "false"],
      ["no account and no charges", [{ stripe_account_id: null, stripe_charges_enabled: false }], "false"],
      ["an org row the read cannot find", [], "false"],
    ];
    let checked = 0;
    for (const [label, rows, expected] of CASES) {
      h.sql.mockImplementation(async (strings: TemplateStringsArray) =>
        strings.join("?").includes("stripe_charges_enabled") ? rows : [],
      );
      expect(attr(await render("sponsors"), "org-sponsors", "data-hub-charges"), label).toBe(expected);
      checked++;
    }
    expect(checked).toBe(5);
    // The read names BOTH columns (a query that selected only the flag could never answer the second case).
    const read = h.sql.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?")).find((t) => t.includes("stripe_charges_enabled"));
    expect(read).toMatch(/stripe_account_id/);
  });

  it("asks for THIS org's charges and competitions only (the org id is bound into both reads)", async () => {
    await render("sponsors");
    const reads = h.sql.mock.calls.map((c) => ({ text: (c[0] as TemplateStringsArray).join("?"), values: c.slice(1) }));
    const charges = reads.find((r) => r.text.includes("stripe_charges_enabled"));
    const comps = reads.find((r) => r.text.includes("from competitions"));
    expect(charges?.values).toEqual([ORG.id]);
    expect(comps?.values).toEqual([ORG.id]);
  });

  it("hands the competitions over WITH their end dates (YYYY-MM-DD or none) - the deal timeline's end hint", async () => {
    const html = await render("sponsors");
    expect(attr(html, "org-sponsors", "data-competition-ends")).toBe("c1:2027-08-31|c2:-|c3:2026-12-01");
    const comps = h.sql.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?")).find((t) => t.includes("from competitions"));
    expect(comps, "the read selects ends_on as text, so a date column cannot reach the client as a Date").toMatch(/ends_on::text/);
  });

  it("another tab reads none of it (the page loads only what its tab shows); Packages reads its packages and no deals", async () => {
    let checked = 0;
    for (const tab of ["overview", "on_stream"]) {
      await render(tab, undefined, undefined, { sponsor: "s1", deal: "d1" });
      checked++;
    }
    expect(checked).toBe(2);
    expect(h.listDeals).not.toHaveBeenCalled();
    expect(h.listSponsorPackages).not.toHaveBeenCalled();
    expect(h.sql.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?")).filter((t) => t.includes("stripe_charges_enabled"))).toEqual([]);
    // The one tab besides Sponsors that lists packages reads them - and still no deals, whatever the URL says.
    h.listSponsorPackages.mockClear();
    await render("packages", undefined, undefined, { sponsor: "s1", deal: "d1" });
    expect(h.listSponsorPackages).toHaveBeenCalledTimes(1);
    expect(h.listDeals).not.toHaveBeenCalled();
  });
});

// Batch J, the perf carry: PR 2 grew the Sponsors tab's one `Promise.all` from three reads to eight, and the connection pool holds five
// (`connectionOptions`, lib/db.ts). Three of the reads pin a connection for a whole transaction, so a sixth just queues. The bound is
// the pool's own declared size, read from the module that declares it - never a 5 typed here - and what is counted is reads IN FLIGHT
// at once: each mocked read stays open for one macrotask, so every read a `Promise.all` starts together is open together. It counts the
// reads THE PAGE starts (each mocked usecase is one read): a usecase that fans out inside itself - `finishedPackageCompetitions` asks one
// desk per competition - is outside what this can see, and the title says so (batch J review m7).
describe("no tab STARTS more top-level reads at once than the connection pool holds (batch J perf carry; reads inside a usecase are not counted)", () => {
  it("each tab's peak of top-level reads in flight is within the pool, with the reads counted and the Sponsors tab shown to overlap (anti-vacuity)", async () => {
    const { connectionOptions } = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
    const POOL = connectionOptions("postgres://u@localhost/x", {}).max;
    expect(POOL, "the pool's declared size").toBeGreaterThan(0);

    const flight = { now: 0, peak: 0, started: 0 };
    /** A read that stays open for one macrotask, so reads started together are open together. */
    async function open<T>(value: () => T): Promise<T> {
      flight.started++;
      flight.now++;
      flight.peak = Math.max(flight.peak, flight.now);
      try {
        await new Promise<void>((done) => setTimeout(done, 0));
        return value();
      } finally {
        flight.now--;
      }
    }
    h.listSponsorRows.mockImplementation(() => open(() => []));
    h.listDeals.mockImplementation(() => open(() => []));
    h.listSponsorPackages.mockImplementation(() => open(() => []));
    h.finishedPackageCompetitions.mockImplementation(() => open(() => []));
    // `featureScopes` stands alone here: its default (the file's beforeEach) calls `hasFeatureOnAnyPass`, which would count one read twice.
    h.featureScopes.mockImplementation(() => open(() => ({ orgWide: true, competitionIds: [] })));
    h.hasFeatureOnAnyPass.mockImplementation(() => open(() => true));
    h.sql.mockImplementation((strings: TemplateStringsArray) =>
      open(() => (strings.join("?").includes("stripe_charges_enabled") ? [{ stripe_account_id: "acct_1", stripe_charges_enabled: true }] : [])),
    );
    h.loadOnStreamScope.mockImplementation(() => open(() => ({ settings: null, ownRow: false, sports: [] })));
    h.sponsorOverview.mockImplementation(() => open(() => []));
    h.listReportLinks.mockImplementation(() => open(() => []));
    h.reportLinkDefaults.mockImplementation(() => open(() => ({ from: "2026-01-01", to: "2026-12-31", competitionId: null })));

    const peaks: Record<string, { peak: number; started: number }> = {};
    for (const tab of SPONSORS_TABS) {
      flight.now = 0;
      flight.peak = 0;
      flight.started = 0;
      const html = await render(tab, undefined, undefined, { sponsor: "s1" });
      expect(panels(html), `?tab=${tab}: the tab really rendered, so its reads completed`).toEqual([tab]);
      expect(flight.now, `?tab=${tab}: every read has finished`).toBe(0);
      peaks[tab] = { peak: flight.peak, started: flight.started };
    }
    console.info(`reads in flight (pool ${POOL}): ${SPONSORS_TABS.map((t) => `${t} peak ${peaks[t]!.peak} of ${peaks[t]!.started}`).join(", ")}`);

    let checked = 0;
    for (const tab of SPONSORS_TABS) {
      expect(peaks[tab]!.started, `?tab=${tab}: reads were counted`).toBeGreaterThan(0);
      expect(peaks[tab]!.peak, `?tab=${tab}: reads in flight at once, against a pool of ${POOL}`).toBeLessThanOrEqual(POOL);
      checked++;
    }
    expect(checked).toBe(SPONSORS_TABS.length);
    // The Sponsors tab is the heavy one: it reads MORE than the pool holds (so the bound means something - a tab with fewer reads than
    // the pool could never break it), and a counter that never saw two open at once was not counting.
    expect(peaks.sponsors!.started, "the Sponsors tab starts more reads than the pool holds").toBeGreaterThan(POOL);
    expect(peaks.sponsors!.peak, "and the counter saw them overlap").toBeGreaterThan(1);
  });

  // The review (m7): the SLOWEST read is `finishedPackageCompetitions` (one desk read per competition that has a package), so it
  // starts with the org's own rows in the FIRST wave and overlaps them, and the second wave is only the cheap plan questions and
  // the Stripe flag. Read from the order the reads open and close in - not from the source - so a read slipped into the wrong wave,
  // or the two waves collapsed into one `Promise.all` of eight, both show.
  it("the Sponsors tab reads in two waves: the slowest read starts in the first, the plan questions and the Stripe flag only after it", async () => {
    const log: string[] = [];
    async function logged<T>(name: string, value: () => T): Promise<T> {
      log.push(`${name}:start`);
      await new Promise<void>((done) => setTimeout(done, 0));
      log.push(`${name}:end`);
      return value();
    }
    h.listSponsorRows.mockImplementation(() => logged("rows", () => []));
    h.listDeals.mockImplementation(() => logged("deals", () => []));
    h.listSponsorPackages.mockImplementation(() => logged("packages", () => []));
    h.finishedPackageCompetitions.mockImplementation(() => logged("finished", () => []));
    h.featureScopes.mockImplementation(() => logged("scopes", () => ({ orgWide: true, competitionIds: [] })));
    h.sql.mockImplementation((strings: TemplateStringsArray) => {
      const stripe = strings.join("?").includes("stripe_charges_enabled");
      return logged(stripe ? "stripe" : "competitions", () => (stripe ? [{ stripe_account_id: "acct_1", stripe_charges_enabled: true }] : []));
    });
    await render("sponsors", undefined, undefined, undefined);

    const at = (e: string): number[] => log.flatMap((x, i) => (x === e ? [i] : []));
    const FIRST = ["rows", "deals", "packages", "competitions", "finished"];
    const SECOND = ["scopes", "stripe"];
    let checked = 0;
    for (const name of [...FIRST, ...SECOND]) {
      expect(at(`${name}:start`).length, `${name} was read (and the log saw it)`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(FIRST.length + SECOND.length);
    const lastFirstEnd = Math.max(...FIRST.flatMap((n) => at(`${n}:end`)));
    const firstSecondStart = Math.min(...SECOND.flatMap((n) => at(`${n}:start`)));
    const lastFirstStart = Math.max(...FIRST.flatMap((n) => at(`${n}:start`)));
    const firstFirstEnd = Math.min(...FIRST.flatMap((n) => at(`${n}:end`)));
    expect(lastFirstStart, "the whole first wave is open together: every first-wave read starts before any of them ends").toBeLessThan(firstFirstEnd);
    expect(lastFirstEnd, "the second wave starts only after the first has finished").toBeLessThan(firstSecondStart);
    expect(at("finished:start")[0], "the slowest read opens with the org's own rows, before the first of them ends").toBeLessThan(at("rows:end")[0]!);
  });
});

describe("?sponsor= and ?deal= on the Sponsors tab: this org's, else the list (Task 13)", () => {
  const sel = (html: string) => ({
    sponsor: attr(html, "org-sponsors", "data-hub-sponsor"),
    deal: attr(html, "org-sponsors", "data-hub-deal"),
    links: attr(html, "org-sponsors", "data-hub-links"),
  });

  beforeEach(() => {
    h.listReportLinks.mockResolvedValue([
      { id: "l1", sponsorId: "s1" },
      { id: "l2", sponsorId: "s2" },
      { id: "l3", sponsorId: "s1" },
    ]);
  });

  it("no ?sponsor= is the list: nothing selected and no report link read", async () => {
    const html = await render("sponsors");
    expect(sel(html)).toEqual({ sponsor: "-", deal: "-", links: "" });
    expect(h.listReportLinks).not.toHaveBeenCalled();
    expect(panels(html)).toEqual(["sponsors"]);
  });

  it("?sponsor=<own> resolves: the page passes that id on and reads the report links (this sponsor's only)", async () => {
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1" });
    expect(sel(html)).toEqual({ sponsor: "s1", deal: "-", links: "l1|l3" });
    expect(h.listReportLinks).toHaveBeenCalledTimes(1);
    expect(h.listReportLinks).toHaveBeenCalledWith(auth0(), ORG.id);
    // ...and the second sponsor, so the first is not just "the first row".
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s2" }))).toEqual({ sponsor: "s2", deal: "-", links: "l2" });
  });

  it("?sponsor=<foreign> renders the list as if absent - no crash, no 404, no report link read (counted)", async () => {
    let checked = 0;
    for (const raw of ["other-orgs-sponsor", "", "S1", "__proto__", "constructor", ["s1", "s2"], ["s1"]]) {
      h.listReportLinks.mockClear();
      const html = await render("sponsors", undefined, undefined, { sponsor: raw });
      expect(panels(html), JSON.stringify(raw)).toEqual(["sponsors"]);
      expect(sel(html), JSON.stringify(raw)).toEqual({ sponsor: "-", deal: "-", links: "" });
      expect(h.listReportLinks, JSON.stringify(raw)).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("?deal=<own> on its own sponsor resolves; a deal of ANOTHER sponsor of the same org, a foreign deal and a repeated deal do not", async () => {
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d2" })).deal).toBe("d2");
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s2", deal: "d3" })).deal).toBe("d3");
    let refused = 0;
    for (const raw of ["d3", "not-mine", "", "__proto__", ["d1", "d2"]]) {
      const got = sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: raw }));
      expect(got.deal, JSON.stringify(raw)).toBe("-");
      expect(got.sponsor, `${JSON.stringify(raw)}: the sponsor stays selected`).toBe("s1");
      refused++;
    }
    expect(refused).toBe(5);
  });

  it("a LEGACY deal (a pre-deals order: no sponsor) is selectable by no URL - with no sponsor, a foreign one or an own one", async () => {
    h.listDeals.mockResolvedValue([
      { id: "d1", sponsor_id: "s1" },
      { id: "dL", sponsor_id: null },
    ]);
    expect(sel(await render("sponsors", undefined, undefined, { deal: "dL" })).deal, "no sponsor").toBe("-");
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "not-mine", deal: "dL" })).deal, "foreign sponsor").toBe("-");
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "dL" })).deal, "own sponsor").toBe("-");
    // The positive pair: the same page does select an own deal.
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" })).deal).toBe("d1");
  });

  it("a ?deal= without a valid sponsor selects nothing (a deal lives on its sponsor's page)", async () => {
    expect(sel(await render("sponsors", undefined, undefined, { deal: "d1" }))).toEqual({ sponsor: "-", deal: "-", links: "" });
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "not-mine", deal: "d1" }))).toEqual({
      sponsor: "-", deal: "-", links: "",
    });
  });

  it("a sponsor with no deals selects no deal, and no deal id of another sponsor leaks in", async () => {
    h.listDeals.mockResolvedValue([{ id: "d3", sponsor_id: "s2" }]);
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d3" }))).toEqual({ sponsor: "s1", deal: "-", links: "l1|l3" });
  });

  it("an org with no sponsors has nothing to select, whatever the URL says", async () => {
    h.listSponsorRows.mockResolvedValue([]);
    h.listDeals.mockResolvedValue([]);
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" }))).toEqual({ sponsor: "-", deal: "-", links: "" });
  });

  it("a non-editor resolves the sponsor (the read-only view) but never reads report links - the read refuses a non-editor", async () => {
    asMember("viewer", false);
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
    expect(sel(html)).toEqual({ sponsor: "s1", deal: "d1", links: "" });
    expect(h.listReportLinks).not.toHaveBeenCalled();
  });

  it("each render stands alone: a selection is not carried into the next render", async () => {
    await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
    expect(sel(await render("sponsors"))).toEqual({ sponsor: "-", deal: "-", links: "" });
  });

  /** The member `asMember("owner", true)` signs in as. */
  function auth0() {
    return { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null };
  }
});

describe("?sponsor=<own> draws the sponsor's own page (Task 15 - F23, moved here from Task 13), and the Report link's opening dates ride with it", () => {
  const SPONSOR = {
    id: "s1", name: "Harbour Print", competition_id: null, url: "https://harbour-print.example/", logo_path: null, poster_path: null, tier: "gold", display_order: 0,
    status: "active", click_count: 4, on_stream: false, archived_at: null, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null,
  };
  const DEAL = {
    id: "d1", sponsor_id: "s1", package_id: "p1", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline",
    go_live: "on_payment", package_name: "Gold Season", tier: "gold", includes_on_stream: false, competition_id: null, amount_cents: 60_000,
    currency: "gbp", sponsor_name: "Harbour Print", sponsor_email: null, ends_at: null, created_at: "2026-10-01T09:00:00.000Z", created_by: null,
    invoice_sent_at: null, paid_at: null, marked_paid_by: null, approved_at: null, approved_by: null, live_at: null, ended_at: null,
    ended_reason: null, parked_at: null, disputed_at: null, dispute_id: null, has_payment_intent: false, invoice_number: null,
  };
  /** The sheet's opening tag (anchored on `="`, so an omitted prop cannot satisfy it). */
  const sheetsIn = (html: string) => [...html.matchAll(/<section\b[^>]*data-testid="sponsor-sheet"[^>]*>/g)].map((m) => m[0]);

  beforeEach(() => {
    real.on = true;
    h.listSponsorRows.mockResolvedValue([SPONSOR, { ...SPONSOR, id: "s2", name: "Ridge Kitchens" }]);
    h.listDeals.mockResolvedValue([DEAL]);
    h.listReportLinks.mockResolvedValue([{ id: "l1", sponsorId: "s1", competitionId: null, competitionName: null, from: "2026-01-01", to: "2026-02-01", createdAt: "2026-02-02T00:00:00.000Z" }]);
  });
  afterEach(() => {
    real.on = false;
  });

  it("the OWN id renders the page for THAT sponsor, with its deal and its report link; the list is still in the page (hidden below md by a class)", async () => {
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1" });
    const sheets = sheetsIn(html);
    expect(sheets, "exactly one sponsor page").toHaveLength(1);
    expect(sheets[0]).toContain('data-sponsor-id="s1"');
    expect(html).toContain("Harbour Print");
    expect(html).toContain('data-testid="sponsor-sheet-deals"');
    expect(html).toContain('data-deal-id="d1"');
    // The pair for the viewer case below: an editor's page carries every control a viewer's does not.
    for (const id of ["sponsor-sheet-report", "sponsor-sheet-edit", "sponsor-sheet-add-deal", "sponsor-sheet-deal-action"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html, "the report link counts the sponsor's own links").toContain("Active links: 1");
    const wrap = /<div\b[^>]*data-testid="sponsors-list-view"[^>]*>/.exec(html)![0];
    expect(/class="[^"]*\bmax-md:hidden\b/.test(wrap), "the list yields to the page below md").toBe(true);
  });

  it("the SERVER render is the phone body hidden from md up, never the side panel: the viewport is unknown on the server (useMdUp's null)", async () => {
    // `prerender` reads `useMdUp`'s SERVER snapshot - `null`, "not known yet" - so what it serves is what a visitor gets before
    // hydration: a desktop must not flash the phone body, and no dialog may be in the markup (a side panel the server guessed at).
    // Nothing else sees this: every unit mounts the sheet with `useMdUp` mocked to a boolean. Anchored on the wrapper's own tag and on
    // `\sclass="md:hidden"`: a bare `md:hidden` also matches inside `max-md:hidden`, and an omitted class prop would not satisfy `="`.
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1" });
    const wrappers = [...html.matchAll(/<div\b[^>]*data-testid="sponsor-sheet-page"[^>]*>/g)].map((m) => m[0]);
    expect(wrappers, "exactly one page wrapper").toHaveLength(1);
    expect(wrappers[0]).toMatch(/\sclass="md:hidden"/);
    expect(html, "no side-panel dialog in the server markup").not.toContain('role="dialog"');
    expect(html, "the body is inside the wrapper, so the hidden class hides something real").toContain('data-testid="sponsor-sheet-back"');
    // The sponsor page is not the list: without a selection there is no wrapper at all.
    expect(await render("sponsors")).not.toContain('data-testid="sponsor-sheet-page"');
  });

  it("the second sponsor's id renders the SECOND sponsor's page (not the first row)", async () => {
    const html = await render("sponsors", undefined, undefined, { sponsor: "s2" });
    expect(sheetsIn(html)[0]).toContain('data-sponsor-id="s2"');
  });

  it("no ?sponsor=, a foreign one and a repeated one: no sponsor page, and the list is not hidden (7 checked)", async () => {
    let checked = 0;
    for (const raw of [undefined, "other-orgs-sponsor", "", "__proto__", "constructor", ["s1", "s2"], "S1"]) {
      const html = await render("sponsors", undefined, undefined, raw === undefined ? {} : { sponsor: raw });
      expect(sheetsIn(html), JSON.stringify(raw)).toHaveLength(0);
      expect(html, JSON.stringify(raw)).not.toContain('data-testid="sponsor-sheet"');
      const wrap = /<div\b[^>]*data-testid="sponsors-list-view"[^>]*>/.exec(html)![0];
      expect(/\bmax-md:hidden\b/.test(wrap), `${JSON.stringify(raw)}: the list is not hidden`).toBe(false);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("an editor's page reads the opening dates for THIS YEAR (the Overview's landing window), once, at the same `now` it hands the island", async () => {
    await render("sponsors", undefined, undefined, { sponsor: "s1" });
    expect(h.reportLinkDefaults).toHaveBeenCalledTimes(1);
    const [auth, orgId, period, now] = h.reportLinkDefaults.mock.calls[0]!;
    expect(auth).toMatchObject({ orgId: ORG.id, userId: "u1" });
    expect(orgId).toBe(ORG.id);
    expect(period, "no ?period= is this year").toEqual({ kind: "this_year" });
    expect(now).toBeInstanceOf(Date);
  });

  it("a page with no sponsor selected reads no opening dates (the list needs none)", async () => {
    await render("sponsors");
    expect(h.reportLinkDefaults).not.toHaveBeenCalled();
  });

  it("a viewer's sponsor page is read-only: it renders, with NO report link, NO Edit, NO Add deal, and the dates are never read", async () => {
    asMember("viewer", false);
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1" });
    expect(sheetsIn(html)).toHaveLength(1);
    expect(h.reportLinkDefaults).not.toHaveBeenCalled();
    expect(h.listReportLinks).not.toHaveBeenCalled();
    for (const id of ["sponsor-sheet-report", "sponsor-sheet-edit", "sponsor-sheet-add-deal", "sponsor-sheet-deal-action"]) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
  });

  it("?edit=1 (the list's pencil) opens the sponsor page with its Details editor open; the same URL without it is read-only until Edit is pressed (the pair)", async () => {
    const opened = await render("sponsors", undefined, undefined, { sponsor: "s1", edit: "1" });
    expect(sheetsIn(opened)).toHaveLength(1);
    expect(opened, "the editor is the page's").toContain('data-testid="sponsor-sheet-editor"');
    expect(opened, "and the read-only rows it replaces are gone").not.toContain('data-testid="sponsor-sheet-detail-name"');
    const plain = await render("sponsors", undefined, undefined, { sponsor: "s1" });
    expect(plain).not.toContain('data-testid="sponsor-sheet-editor"');
    expect(plain, "the plain page shows the read-only rows").toContain('data-testid="sponsor-sheet-detail-name"');
    // the second sponsor's own pencil: not the first row's editor
    const second = await render("sponsors", undefined, undefined, { sponsor: "s2", edit: "1" });
    expect(sheetsIn(second)[0]).toContain('data-sponsor-id="s2"');
    expect(second).toContain('data-testid="sponsor-sheet-editor"');
  });

  it("only edit=1 opens it: another value, an empty one and a repeated one leave the page read-only (5 checked)", async () => {
    let checked = 0;
    for (const raw of ["0", "", "true", "yes", ["1", "1"]]) {
      const html = await render("sponsors", undefined, undefined, { sponsor: "s1", edit: raw });
      expect(sheetsIn(html), JSON.stringify(raw)).toHaveLength(1);
      expect(html, JSON.stringify(raw)).not.toContain('data-testid="sponsor-sheet-editor"');
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("?edit=1 with no sponsor, or a foreign one, opens nothing - the list (the empty case)", async () => {
    for (const pick of [{ edit: "1" }, { sponsor: "other-orgs-sponsor", edit: "1" }]) {
      const html = await render("sponsors", undefined, undefined, pick);
      expect(sheetsIn(html), JSON.stringify(pick)).toHaveLength(0);
      expect(html, JSON.stringify(pick)).not.toContain('data-testid="sponsor-sheet-editor"');
    }
  });

  it("a viewer who follows an edit link gets the read-only page: no editor, no Edit button", async () => {
    asMember("viewer", false);
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1", edit: "1" });
    expect(sheetsIn(html)).toHaveLength(1);
    expect(html).not.toContain('data-testid="sponsor-sheet-editor"');
    expect(html).not.toContain('data-testid="sponsor-sheet-edit"');
    expect(html, "the read-only rows are shown").toContain('data-testid="sponsor-sheet-detail-name"');
  });

  it("the marker case still reports the dates the page passed (null without a sponsor, this year's with one)", async () => {
    real.on = false;
    expect(attr(await render("sponsors"), "org-sponsors", "data-hub-defaults")).toBe("-");
    expect(attr(await render("sponsors", undefined, undefined, { sponsor: "s1" }), "org-sponsors", "data-hub-defaults")).toBe("2026-01-01..2026-12-31");
    const edit = async (pick: { sponsor?: string; edit?: string }) => attr(await render("sponsors", undefined, undefined, pick), "org-sponsors", "data-hub-edit");
    expect(await edit({ sponsor: "s1", edit: "1" }), "an editor with a sponsor and ?edit=1").toBe("true");
    expect(await edit({ sponsor: "s1" }), "no ?edit=").toBe("false");
    expect(await edit({ edit: "1" }), "no sponsor").toBe("false");
    asMember("viewer", false);
    expect(attr(await render("sponsors", undefined, undefined, { sponsor: "s1" }), "org-sponsors", "data-hub-defaults")).toBe("-");
    expect(await edit({ sponsor: "s1", edit: "1" }), "a viewer is never handed the editor").toBe("false");
  });
});

describe("?deal=<own> draws the deal's own page (Task 17), and the timeline's two server reads ride with it", () => {
  const SPONSOR = {
    id: "s1", name: "Harbour Print", competition_id: null, url: null, logo_path: null, poster_path: null, tier: "gold", display_order: 0,
    status: "active", click_count: 4, on_stream: false, archived_at: null, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null,
  };
  const DEAL = {
    id: "d1", sponsor_id: "s1", package_id: "p1", deal_status: "awaiting_payment", payment_status: "pending", payment_method: "offline",
    go_live: "on_payment", package_name: "Gold Season", tier: "gold", includes_on_stream: false, competition_id: "c1", amount_cents: 60_000,
    currency: "gbp", sponsor_name: "Harbour Print", sponsor_email: null, ends_at: null, created_at: "2026-10-01T09:00:00.000Z", created_by: "u-creator",
    invoice_sent_at: null, paid_at: null, marked_paid_by: null, approved_at: null, approved_by: null, live_at: null, ended_at: null,
    ended_reason: null, parked_at: null, disputed_at: null, dispute_id: null, has_payment_intent: false, invoice_number: null,
    written_off_at: null, written_off_by: null,
  };
  const OTHER = { ...DEAL, id: "d9", sponsor_id: "s2", package_name: "Silver Season" };
  const sel = (html: string) => ({
    by: attr(html, "org-sponsors", "data-hub-deal-by"),
    writtenOffBy: attr(html, "org-sponsors", "data-hub-deal-written-off-by"),
    finished: attr(html, "org-sponsors", "data-hub-deal-finished"),
  });

  beforeEach(() => {
    h.listSponsorRows.mockResolvedValue([SPONSOR, { ...SPONSOR, id: "s2", name: "Ridge Kitchens" }]);
    h.listDeals.mockResolvedValue([DEAL, OTHER]);
    h.listReportLinks.mockResolvedValue([]);
  });

  it("a selected deal: the creator's name is read for THIS org and the deal's creator, and handed over (the seam, through the marker)", async () => {
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
    expect(h.dealCreatorName).toHaveBeenCalledTimes(1);
    expect(h.dealCreatorName).toHaveBeenCalledWith(ORG.id, "u-creator");
    expect(sel(html).by).toBe("Sam Patel");
    expect(sel(html).writtenOffBy, "a deal not written off hands over no writer, and reads none").toBe("-");
    // the pair: the name the read returned is what is handed over, not a constant
    h.dealCreatorName.mockResolvedValue(null);
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" })).by).toBe("-");
  });

  it("a written-off deal: the writer's name is read for THIS org and the deal's writer, beside the creator's, and handed over (final review m3)", async () => {
    h.listDeals.mockResolvedValue([
      { ...DEAL, deal_status: "ended", ended_reason: "written_off", ended_at: "2026-11-05T10:00:00.000Z",
        written_off_at: "2026-11-05T10:00:00.000Z", written_off_by: "u-writer" },
      OTHER,
    ]);
    h.dealCreatorName.mockImplementation(async (_org: string, id: string | null) => (id === "u-writer" ? "Ana Ruiz" : id === "u-creator" ? "Sam Patel" : null));
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
    expect(h.dealCreatorName).toHaveBeenCalledTimes(2);
    expect(h.dealCreatorName).toHaveBeenCalledWith(ORG.id, "u-creator");
    expect(h.dealCreatorName).toHaveBeenCalledWith(ORG.id, "u-writer");
    expect(sel(html)).toMatchObject({ by: "Sam Patel", writtenOffBy: "Ana Ruiz" });
    // the pair: a writer whose account is gone (ON DELETE SET NULL) reads as no name, and the page still renders
    h.dealCreatorName.mockImplementation(async (_org: string, id: string | null) => (id === "u-creator" ? "Sam Patel" : null));
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" })).writtenOffBy).toBe("-");
  });

  it("an open deal that ends with its competition asks the desk about THAT competition, and hands the answer over", async () => {
    h.isDealCompetitionFinished.mockResolvedValue(true);
    const html = await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
    expect(h.isDealCompetitionFinished).toHaveBeenCalledTimes(1);
    expect(h.isDealCompetitionFinished).toHaveBeenCalledWith(ORG.id, "c1");
    expect(sel(html).finished).toBe("true");
    h.isDealCompetitionFinished.mockResolvedValue(false);
    expect(sel(await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" })).finished).toBe("false");
  });

  it("no desk read when the answer would not be used: no deal selected, an ended deal, or a deal with its own end date (4 checked)", async () => {
    const CASES: [string, Record<string, unknown>[], Record<string, string>][] = [
      ["no deal selected", [DEAL], { sponsor: "s1" }],
      ["a foreign deal id", [DEAL], { sponsor: "s1", deal: "d9" }],
      ["an ended deal", [{ ...DEAL, deal_status: "ended", ended_reason: "expired", ended_at: "2026-10-31T10:00:00.000Z" }], { sponsor: "s1", deal: "d1" }],
      ["an end date of its own", [{ ...DEAL, ends_at: "2027-03-31T12:00:00.000Z" }], { sponsor: "s1", deal: "d1" }],
    ];
    let checked = 0;
    for (const [label, deals, query] of CASES) {
      h.isDealCompetitionFinished.mockClear();
      h.listDeals.mockResolvedValue(deals);
      const html = await render("sponsors", undefined, undefined, query);
      expect(h.isDealCompetitionFinished, label).not.toHaveBeenCalled();
      expect(sel(html).finished, label).toBe("false");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("no creator read without a deal selected (the list and the sponsor's page need none), and none on another tab", async () => {
    await render("sponsors");
    await render("sponsors", undefined, undefined, { sponsor: "s1" });
    await render("packages", undefined, undefined, { sponsor: "s1", deal: "d1" });
    expect(h.dealCreatorName).not.toHaveBeenCalled();
    expect(h.isDealCompetitionFinished).not.toHaveBeenCalled();
  });

  describe("the REAL page", () => {
    beforeEach(() => {
      real.on = true;
    });
    afterEach(() => {
      real.on = false;
    });
    const dealPages = (html: string) => [...html.matchAll(/<section\b[^>]*data-testid="deal-page"[^>]*>/g)].map((m) => m[0]);

    it("?deal=<own> draws that deal's page for its package, with its creator on the timeline - and not the sponsor's page", async () => {
      const html = await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
      const pages = dealPages(html);
      expect(pages, "exactly one deal page").toHaveLength(1);
      expect(pages[0]).toContain('data-deal-id="d1"');
      expect(html).toContain("Gold Season");
      expect(html, "the creator the server read, on the timeline's Created step").toContain("Sam Patel");
      expect(html).not.toContain('data-testid="sponsor-sheet"');
    });

    it("a foreign deal id, or none, draws the SPONSOR's page (never a stranger's deal)", async () => {
      for (const query of [{ sponsor: "s1", deal: "d9" }, { sponsor: "s1" }]) {
        const html = await render("sponsors", undefined, undefined, query);
        expect(dealPages(html), JSON.stringify(query)).toHaveLength(0);
        expect(html, JSON.stringify(query)).toContain('data-testid="sponsor-sheet"');
      }
    });

    it("a viewer reads the deal page too, with no button on it", async () => {
      asMember("viewer", false);
      const html = await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
      expect(dealPages(html)).toHaveLength(1);
      expect(html).not.toContain('data-testid="deal-page-action"');
      expect(html).toContain('data-testid="deal-page-timeline"');
    });

    it("an editor's deal page carries the buttons the deal offers (Mark as paid, End now for an offline deal awaiting payment)", async () => {
      const html = await render("sponsors", undefined, undefined, { sponsor: "s1", deal: "d1" });
      const actions = [...html.matchAll(/data-testid="deal-page-action"[^>]*data-action="([a-z_]+)"/g)].map((m) => m[1]);
      expect(actions).toEqual(["mark_paid", "end_now"]);
    });
  });
});

describe("a non-editor gets the same read-only view Settings gave - canEdit false, no Packages (R19; Settings never refused)", () => {
  beforeEach(() => asMember("viewer", false));

  it("Sponsors renders READ-ONLY: OrgSponsors with canEdit false, the list intact", async () => {
    const html = await render("sponsors");
    expect(panels(html)).toEqual(["sponsors"]);
    expect(attr(html, "org-sponsors", "data-can-edit")).toBe("false");
    expect(attr(html, "org-sponsors", "data-sponsors")).toBe("2");
  });

  it("?tab=packages gives a non-editor Overview: the price list is never mounted, its packages are never read and its gates are never even asked", async () => {
    const html = await render("packages");
    expect(panels(html)).toEqual(["overview"]);
    expect(html).not.toContain('data-testid="package-list-island"');
    expect(h.listSponsorPackages).not.toHaveBeenCalled();
    expect(h.finishedPackageCompetitions).not.toHaveBeenCalled();
    expect(h.hasFeatureOnAnyPass).not.toHaveBeenCalled();
    expect(h.listSponsorRows).not.toHaveBeenCalled();
  });

  it("?tab=on_stream gives a non-editor Overview, never the On stream panel", async () => {
    expect(panels(await render("on_stream"))).toEqual(["overview"]);
  });

  it("every editor-only tab is turned away the same way (counted), every readable one opens", async () => {
    let denied = 0;
    let granted = 0;
    for (const tab of SPONSORS_TABS) {
      const got = panels(await render(tab));
      if (SPONSORS_EDITOR_ONLY_TABS.includes(tab)) { expect(got, tab).toEqual(["overview"]); denied++; }
      else { expect(got, tab).toEqual([tab]); granted++; }
    }
    expect(denied).toBe(SPONSORS_EDITOR_ONLY_TABS.length);
    expect(granted).toBe(SPONSORS_TABS.length - SPONSORS_EDITOR_ONLY_TABS.length);
    expect(denied).toBeGreaterThan(0);
    expect(granted).toBeGreaterThan(0);
  });
});

describe("the page loads only what the tab it shows needs, and nothing is carried between renders", () => {
  it("Overview reads its own numbers once (and the org's competitions for its picker) - no sponsor rows, no sponsor gate, no stream scope", async () => {
    await render();
    expect(h.sponsorOverview).toHaveBeenCalledTimes(1);
    expect(h.sql).toHaveBeenCalledTimes(1);
    expect(h.listSponsorRows).not.toHaveBeenCalled();
    expect(h.hasFeatureOnAnyPass).not.toHaveBeenCalled();
    expect(h.loadOnStreamScope).not.toHaveBeenCalled();
  });

  it("every other tab reads no Overview numbers and no report links (counted)", async () => {
    let checked = 0;
    for (const tab of ["sponsors", "packages", "on_stream"]) {
      await render(tab);
      checked++;
    }
    expect(checked).toBe(3);
    expect(h.sponsorOverview).not.toHaveBeenCalled();
    expect(h.listReportLinks).not.toHaveBeenCalled();
    expect(h.reportLinkDefaults).not.toHaveBeenCalled();
  });

  it("Sponsors then Packages in sequence: each render asks for its own reads once, so a second call carries nothing over", async () => {
    await render("sponsors");
    // (the featureScopes stub delegates to hasFeatureOnAnyPass, so monetize shows up in both - the second assertion is the one that
    // says WHO asked)
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.tiers", "sponsors.monetize"]);
    expect(h.featureScopes.mock.calls.map((c) => c[1])).toEqual(["sponsors.tiers", "sponsors.monetize"]);
    expect(h.listSponsorRows).toHaveBeenCalledTimes(1);
    expect(h.listSponsorPackages).toHaveBeenCalledTimes(1);
    h.hasFeatureOnAnyPass.mockClear();
    h.featureScopes.mockClear();
    h.listSponsorRows.mockClear();
    h.listSponsorPackages.mockClear();
    await render("packages");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1]).sort()).toEqual(["sponsors.monetize", "sponsors.tiers"]);
    expect(h.featureScopes.mock.calls.map((c) => c[1]), "the Packages tab asks WHERE tiers are on, and only that per scope (monetize is the any-pass note)").toEqual(["sponsors.tiers"]);
    expect(h.listSponsorRows, "and reads no sponsors").not.toHaveBeenCalled();
    expect(h.listSponsorPackages, "its packages once").toHaveBeenCalledTimes(1);
  });

  it("authorises from the URL (requireOrgPage with the hub's rename tail and its query), before anything is read", async () => {
    await render("sponsors", undefined, undefined, { sponsor: "s1" });
    expect(h.requireOrgPage).toHaveBeenCalledWith(ORG.slug, { tail: "/sponsors", search: "?tab=sponsors&sponsor=s1" });
  });

  it("a refused page (not a member) reads nothing", async () => {
    h.requireOrgPage.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(render("sponsors")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.listSponsorRows).not.toHaveBeenCalled();
    expect(h.hasFeatureOnAnyPass).not.toHaveBeenCalled();
  });
});

describe("the On stream tab (S12)", () => {
  it("an editor gets the island with the org's sponsors, its competitions, the tiers gate and the loader's answer", async () => {
    const html = await render("on_stream");
    expect(panels(html)).toEqual(["on_stream"]);
    expect(attr(html, "on-stream-island", "data-org")).toBe(ORG.id);
    expect(attr(html, "on-stream-island", "data-slug")).toBe(ORG.slug);
    expect(attr(html, "on-stream-island", "data-sponsors")).toBe("s1:true,s2:false");
    // F24: the page maps the tab's fields ONE BY ONE, so a field it does not name never reaches the tick.
    expect(attr(html, "on-stream-island", "data-locked-flags"), "locked_by_deal crosses the page's map, per sponsor").toBe("false,true");
    expect(attr(html, "on-stream-island", "data-locked")).toBe("s2");
    expect(attr(html, "on-stream-island", "data-competitions")).toBe("3");
    expect(attr(html, "on-stream-island", "data-has-tiers")).toBe("true");
    expect(attr(html, "on-stream-island", "data-settings")).toBe("true/busy");
    expect(attr(html, "on-stream-island", "data-own-row")).toBe("true");
    expect(attr(html, "on-stream-island", "data-sports")).toBe("1");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.tiers"]);
    expect(h.listSponsorRows).toHaveBeenCalledWith(ORG.id);
  });

  it("no ?scope= is the organisation-wide scope; the loader is asked about null", async () => {
    const html = await render("on_stream");
    expect(attr(html, "on-stream-island", "data-scope")).toBe("org");
    expect(h.loadOnStreamScope).toHaveBeenCalledWith(ORG.id, null);
  });

  it("?scope= naming one of the org's competitions is that scope - and ONLY one of the org's: a foreign, empty, repeated or inherited-key value is the org scope (counted)", async () => {
    expect(attr(await render("on_stream", "c2"), "on-stream-island", "data-scope")).toBe("c2");
    expect(h.loadOnStreamScope).toHaveBeenLastCalledWith(ORG.id, "c2");
    let refused = 0;
    for (const raw of ["not-mine", "", "__proto__", ["c1", "c2"]]) {
      h.loadOnStreamScope.mockClear();
      const html = await render("on_stream", raw);
      expect(attr(html, "on-stream-island", "data-scope"), JSON.stringify(raw)).toBe("org");
      expect(h.loadOnStreamScope, JSON.stringify(raw)).toHaveBeenCalledWith(ORG.id, null);
      refused++;
    }
    expect(refused).toBe(4);
  });

  it("a non-editor gets Overview: the island is never mounted and the loader and the sponsor reads never run (R19)", async () => {
    asMember("viewer", false);
    const html = await render("on_stream", "c1");
    expect(panels(html)).toEqual(["overview"]);
    expect(html).not.toContain('data-testid="on-stream-island"');
    expect(h.loadOnStreamScope).not.toHaveBeenCalled();
    expect(h.listSponsorRows).not.toHaveBeenCalled();
  });

  it("the scope belongs to On stream only: ?scope= on any other tab reads no stream scope", async () => {
    for (const tab of ["overview", "sponsors", "packages"]) await render(tab, "c1");
    expect(h.loadOnStreamScope).not.toHaveBeenCalled();
  });
});

describe("the Overview tab (S13)", () => {
  it("an editor gets the island with the numbers, the org's competitions, the links and the share defaults, all asked about ONE `now`", async () => {
    const html = await render();
    expect(panels(html)).toEqual(["overview"]);
    expect(attr(html, "overview-island", "data-org")).toBe(ORG.id);
    expect(attr(html, "overview-island", "data-slug")).toBe(ORG.slug);
    expect(attr(html, "overview-island", "data-period")).toBe("this_year");
    expect(attr(html, "overview-island", "data-competitions")).toBe("3");
    expect(attr(html, "overview-island", "data-rows")).toBe("s1,gone");
    expect(attr(html, "overview-island", "data-can-edit")).toBe("true");
    expect(attr(html, "overview-island", "data-links")).toBe("l1,l2");
    expect(attr(html, "overview-island", "data-defaults")).toBe("2026-01-01..2026-12-31/-");
    const auth = { orgId: ORG.id, via: "session", userId: "u1", role: "owner", keyId: null };
    expect(h.sponsorOverview).toHaveBeenCalledWith(auth, ORG.id, { kind: "this_year" }, expect.any(Date));
    expect(h.listReportLinks).toHaveBeenCalledWith(auth, ORG.id);
    expect(h.reportLinkDefaults).toHaveBeenCalledWith(auth, ORG.id, { kind: "this_year" }, expect.any(Date));
    const now = h.sponsorOverview.mock.calls[0]![3] as Date;
    expect(h.reportLinkDefaults.mock.calls[0]![3], "the same instant").toBe(now);
    expect(attr(html, "overview-island", "data-now"), "the island captions the same window").toBe(now.toISOString());
  });

  it("?period= names last_30_days or one of the org's competitions; anything else (foreign, repeated, inherited key) is This year (counted)", async () => {
    const cases: [string | string[], string, unknown][] = [
      ["last_30_days", "last_30_days", { kind: "last_30_days" }],
      ["c2", "competition:c2", { kind: "competition", competitionId: "c2" }],
      ["not-mine", "this_year", { kind: "this_year" }],
      ["", "this_year", { kind: "this_year" }],
      ["__proto__", "this_year", { kind: "this_year" }],
      [["last_30_days", "c2"], "this_year", { kind: "this_year" }],
    ];
    let checked = 0;
    for (const [raw, shown, asked] of cases) {
      h.sponsorOverview.mockClear();
      const html = await render(undefined, undefined, raw);
      expect(attr(html, "overview-island", "data-period"), JSON.stringify(raw)).toBe(shown);
      expect(h.sponsorOverview.mock.calls[0]![2], JSON.stringify(raw)).toEqual(asked);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("R19: a viewer gets the same numbers READ-ONLY - canEdit false, and the links and share defaults are never even loaded", async () => {
    asMember("viewer", false);
    const html = await render(undefined, undefined, "last_30_days");
    expect(panels(html)).toEqual(["overview"]);
    expect(attr(html, "overview-island", "data-rows")).toBe("s1,gone");
    expect(attr(html, "overview-island", "data-can-edit")).toBe("false");
    expect(attr(html, "overview-island", "data-links")).toBe("");
    expect(attr(html, "overview-island", "data-defaults")).toBe("none");
    expect(h.sponsorOverview).toHaveBeenCalledTimes(1);
    expect(h.listReportLinks).not.toHaveBeenCalled();
    expect(h.reportLinkDefaults).not.toHaveBeenCalled();
  });

  it("the panel keeps its tab-labelled heading around the island", async () => {
    const html = await render("overview");
    const panel = /<section[^>]*data-testid="sponsors-tab-overview"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
    expect(panel, "overview panel").toBeDefined();
    expect(panel).toMatch(/<h2[^>]*>[^<]+<\/h2>/);
    expect(panel).toContain('data-testid="overview-island"');
  });
});
