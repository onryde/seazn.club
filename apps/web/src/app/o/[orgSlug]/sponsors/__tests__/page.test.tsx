// R4 sponsors-on-stream S11 - the Sponsors hub page (/o/[orgSlug]/sponsors?tab=...), rendered.
//
// The page is an async server component, so it is awaited and prerendered (the settings suites' pattern). The two
// client islands it hosts (OrgSponsors, SponsorPackages) are stubbed to markers that carry the props the page gave them
// - "did the org get the feature?" and "was it read-only?" become exact string checks. lib/entitlements is mocked at the
// two calls the page makes (`hasFeatureOnAnyPass`, and since the Add deal sheet's fix round `featureScopes` - WHERE a feature is on,
// which the Sponsors tab asks for sponsors.monetize) so the granted and the denied gate are both driven. By default `featureScopes`
// answers org-wide exactly when `hasFeatureOnAnyPass` does, so every gate case below drives both; the scope cases override it.
//
// What these cases pin, per the task brief and R19:
//   - no tab => Overview; an unknown tab => Overview
//   - every tab renders its own panel and ONLY its own (a sweep over `SPONSORS_TABS`, counted)
//   - Sponsors keeps `sponsors.tiers`, Packages keeps `sponsors.monetize` - granted AND denied
//   - a non-editor gets the read-only view Settings gave (canEdit false, no Packages) - NOT a refusal (R19)
//   - the data each tab needs is loaded for that tab only, and never twice across a sequence
//   - On stream (S12): an editor gets the tab with the org's sponsors, tiers gate and the scope the URL names - kept only if it
//     is one of THIS org's competitions; a non-editor gets Overview and the On stream loader is never called (R19)
//   - Sponsors (sponsor deals PR 2, Task 13): the tab also reads the org's deals, packages, both plan flags, whether Stripe takes
//     charges, and the competitions' end dates; `?sponsor=` / `?deal=` select a sponsor's own page and a deal on it - kept only if
//     they are THIS org's (a deal: the selected sponsor's) - and the sponsor's report links are read only then, only for an editor
//   - Sponsors (Task 15): `?sponsor=<own>` renders the REAL sponsor page (`data-testid="sponsor-sheet"`, F23 - moved here from Task 13,
//     where nothing yet drew it), for that sponsor, with the Report link's opening dates read for an editor only
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

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
      deals: { id: string }[];
      packages: { id: string }[];
      hasMonetize: boolean;
      monetizeOrgWide: boolean;
      monetizeCompetitionIds: readonly string[];
      finishedCompetitionIds: readonly string[];
      chargesEnabled: boolean;
      sponsorId: string | null;
      dealId: string | null;
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
      data-hub-deals={p.hub.deals.map((d) => d.id).join("|")}
      data-hub-packages={p.hub.packages.map((k) => k.id).join("|")}
      data-hub-monetize={String(p.hub.hasMonetize)}
      data-hub-monetize-wide={String(p.hub.monetizeOrgWide)}
      data-hub-monetize-ids={p.hub.monetizeCompetitionIds.join("|")}
      data-hub-finished={p.hub.finishedCompetitionIds.join("|")}
      data-hub-charges={String(p.hub.chargesEnabled)}
      data-hub-sponsor={p.hub.sponsorId ?? "-"}
      data-hub-deal={p.hub.dealId ?? "-"}
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
vi.mock("@/components/sponsor-packages", () => ({
  SponsorPackages: (p: {
    orgId: string;
    competitions: unknown[];
    sponsors: { id: string; name: string; display_order: number }[];
    hasMonetize: boolean;
    billingHref: string;
    sponsorsHref: string;
    finishedCompetitionIds?: readonly string[];
  }) => (
    <div
      data-testid="sponsor-packages-island"
      data-org={p.orgId}
      data-finished={p.finishedCompetitionIds === undefined ? "<absent>" : p.finishedCompetitionIds.join("|")}
      data-has-monetize={String(p.hasMonetize)}
      data-competitions={p.competitions.length}
      data-pick={p.sponsors.map((s) => `${s.id}:${s.name}:${s.display_order}`).join("|")}
      data-sponsors-href={p.sponsorsHref}
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

const ORG = { id: "org-1", name: "Riverside", slug: "riverside", role: "owner" };

async function render(
  tab?: string,
  scope?: string | string[],
  period?: string | string[],
  pick: { sponsor?: string | string[]; deal?: string | string[] } = {},
): Promise<string> {
  const element = await SponsorsHubPage({
    params: Promise.resolve({ orgSlug: ORG.slug }),
    searchParams: Promise.resolve({
      ...(tab === undefined ? {} : { tab }),
      ...(scope === undefined ? {} : { scope }),
      ...(period === undefined ? {} : { period }),
      ...(pick.sponsor === undefined ? {} : { sponsor: pick.sponsor }),
      ...(pick.deal === undefined ? {} : { deal: pick.deal }),
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
    expect(html).toMatch(/<h2 id="sponsors-tab-packages-heading"[^>]*>Packages and orders<\/h2>/);
  });
});

describe("the Sponsors tab keeps Settings' gates: sponsors.tiers, granted AND denied", () => {
  it("granted => OrgSponsors gets hasTiers true; the question is asked org-wide for sponsors.tiers", async () => {
    h.hasFeatureOnAnyPass.mockResolvedValue(true);
    const html = await render("sponsors");
    expect(attr(html, "org-sponsors", "data-has-tiers")).toBe("true");
    expect(h.hasFeatureOnAnyPass).toHaveBeenCalledWith(ORG.id, "sponsors.tiers");
  });

  it("denied => hasTiers false (the upsell arm), and the list is still the org's", async () => {
    h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => key !== "sponsors.tiers");
    const html = await render("sponsors");
    expect(attr(html, "org-sponsors", "data-has-tiers")).toBe("false");
    expect(attr(html, "org-sponsors", "data-sponsors")).toBe("2");
    expect(h.listSponsorRows).toHaveBeenCalledWith(ORG.id);
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

describe("the Packages tab keeps Settings' gate: sponsors.monetize, granted AND denied", () => {
  it("granted => SponsorPackages gets hasMonetize true; asked org-wide for sponsors.monetize", async () => {
    h.hasFeatureOnAnyPass.mockResolvedValue(true);
    const html = await render("packages");
    expect(attr(html, "sponsor-packages-island", "data-has-monetize")).toBe("true");
    expect(h.hasFeatureOnAnyPass).toHaveBeenCalledWith(ORG.id, "sponsors.monetize");
  });

  it("denied => hasMonetize false (the upsell arm)", async () => {
    h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => key !== "sponsors.monetize");
    const html = await render("packages");
    expect(attr(html, "sponsor-packages-island", "data-has-monetize")).toBe("false");
  });

  it("the two gates are independent: tiers denied does not deny monetize, and the Packages tab does not ask for tiers", async () => {
    h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => key === "sponsors.monetize");
    expect(attr(await render("packages"), "sponsor-packages-island", "data-has-monetize")).toBe("true");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.monetize"]);
    h.hasFeatureOnAnyPass.mockClear();
    // The Sponsors tab asks BOTH (Task 13: the Add deal sheet locks Send invoice by monetize), each answered on its own.
    const sponsors = await render("sponsors");
    expect(attr(sponsors, "org-sponsors", "data-has-tiers")).toBe("false");
    expect(attr(sponsors, "org-sponsors", "data-hub-monetize")).toBe("true");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.tiers", "sponsors.monetize"]);
    h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => key === "sponsors.tiers");
    const flipped = await render("sponsors");
    expect(attr(flipped, "org-sponsors", "data-has-tiers")).toBe("true");
    expect(attr(flipped, "org-sponsors", "data-hub-monetize")).toBe("false");
  });
});

describe("the Packages tab hands the invoice form its sponsor picker (sponsor deals T12)", () => {
  it("passes every sponsor row as { id, name, display_order } - the picker's whole input - and the Sponsors tab's URL for the empty case", async () => {
    const html = await render("packages");
    expect(attr(html, "sponsor-packages-island", "data-pick")).toBe("s1:Harbour:3|s2:Ridge:0");
    expect(attr(html, "sponsor-packages-island", "data-sponsors-href")).toBe(sponsorsHref(ORG.slug, "sponsors"));
  });

  it("a plan WITHOUT sponsors.monetize sees the upsell and reads no sponsors; the granted pair does read them", async () => {
    h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => key !== "sponsors.monetize");
    const denied = await render("packages");
    expect(attr(denied, "sponsor-packages-island", "data-has-monetize")).toBe("false");
    expect(attr(denied, "sponsor-packages-island", "data-pick")).toBe("");
    expect(h.listSponsorRows, "denied: nothing read").not.toHaveBeenCalled();
    h.hasFeatureOnAnyPass.mockResolvedValue(true);
    await render("packages");
    expect(h.listSponsorRows, "granted: the picker's sponsors are read").toHaveBeenCalledTimes(1);
  });

  it("an org with no sponsors hands an EMPTY picker (the form then says Add a sponsor first), not a missing one", async () => {
    h.listSponsorRows.mockResolvedValue([]);
    const html = await render("packages");
    expect(html).toContain('data-testid="sponsor-packages-island"');
    expect(attr(html, "sponsor-packages-island", "data-pick")).toBe("");
  });
});

describe("the Packages tab hands over which packages' competitions have finished (batch F review m4)", () => {
  // The client hides Send invoice on those packages; createDeal refuses them anyway (409 competition_finished). The ids are the
  // usecase's answer, handed over as they are.
  it("granted: asks finishedPackageCompetitions for THIS org and hands its answer over as it is", async () => {
    const html = await render("packages");
    expect(h.finishedPackageCompetitions).toHaveBeenCalledWith(ORG.id);
    expect(attr(html, "sponsor-packages-island", "data-finished")).toBe("c2");
  });

  it("nothing finished: an EMPTY list, not a missing one", async () => {
    h.finishedPackageCompetitions.mockResolvedValue([]);
    expect(attr(await render("packages"), "sponsor-packages-island", "data-finished")).toBe("");
  });

  it("a plan WITHOUT sponsors.monetize asks nothing (it sees the upsell, no packages)", async () => {
    h.hasFeatureOnAnyPass.mockImplementation(async (_org: string, key: string) => key !== "sponsors.monetize");
    expect(attr(await render("packages"), "sponsor-packages-island", "data-finished")).toBe("");
    expect(h.finishedPackageCompetitions).not.toHaveBeenCalled();
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

  it("asks featureScopes for sponsors.monetize for THIS org, and for nothing else's scope (tiers stay org-wide)", async () => {
    await render("sponsors");
    expect(h.featureScopes).toHaveBeenCalledTimes(1);
    expect(h.featureScopes).toHaveBeenCalledWith(ORG.id, "sponsors.monetize");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1]).filter((k) => k === "sponsors.tiers")).toEqual(["sponsors.tiers"]);
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

  it("the Packages tab is unchanged: it still asks hasFeatureOnAnyPass for monetize (the featureScopes read is the Sponsors tab's)", async () => {
    await render("packages");
    expect(h.hasFeatureOnAnyPass).toHaveBeenCalledWith(ORG.id, "sponsors.monetize");
    expect(h.featureScopes).not.toHaveBeenCalled();
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

  it("another tab reads none of it (the page loads only what its tab shows)", async () => {
    let checked = 0;
    for (const tab of ["overview", "packages", "on_stream"]) {
      await render(tab, undefined, undefined, { sponsor: "s1", deal: "d1" });
      checked++;
    }
    expect(checked).toBe(3);
    expect(h.listDeals).not.toHaveBeenCalled();
    expect(h.listSponsorPackages).not.toHaveBeenCalled();
    expect(h.sql.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?")).filter((t) => t.includes("stripe_charges_enabled"))).toEqual([]);
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
    id: "s1", name: "Harbour Print", competition_id: null, url: "https://harbour-print.example/", logo_path: null, tier: "gold", display_order: 0,
    status: "active", click_count: 4, on_stream: false, paid_order_id: null, deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null,
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

  it("the marker case still reports the dates the page passed (null without a sponsor, this year's with one)", async () => {
    real.on = false;
    expect(attr(await render("sponsors"), "org-sponsors", "data-hub-defaults")).toBe("-");
    expect(attr(await render("sponsors", undefined, undefined, { sponsor: "s1" }), "org-sponsors", "data-hub-defaults")).toBe("2026-01-01..2026-12-31");
    asMember("viewer", false);
    expect(attr(await render("sponsors", undefined, undefined, { sponsor: "s1" }), "org-sponsors", "data-hub-defaults")).toBe("-");
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

  it("?tab=packages gives a non-editor Overview: SponsorPackages is never mounted and its gate is never even asked", async () => {
    const html = await render("packages");
    expect(panels(html)).toEqual(["overview"]);
    expect(html).not.toContain('data-testid="sponsor-packages-island"');
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

  it("Sponsors then Packages in sequence: each render asks for its own gate once, so a second call carries nothing over", async () => {
    await render("sponsors");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.tiers", "sponsors.monetize"]);
    expect(h.listSponsorRows).toHaveBeenCalledTimes(1);
    h.hasFeatureOnAnyPass.mockClear();
    h.listSponsorRows.mockClear();
    await render("packages");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.monetize"]);
    expect(h.listSponsorRows, "the Packages tab reads the org's sponsors once, for its picker").toHaveBeenCalledTimes(1);
    expect(h.listSponsorRows).toHaveBeenCalledWith(ORG.id);
  });

  it("authorises from the URL (requireOrgPage with the hub's rename tail), before anything is read", async () => {
    await render("sponsors");
    expect(h.requireOrgPage).toHaveBeenCalledWith(ORG.slug, { tail: "/sponsors" });
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
