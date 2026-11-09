// R4 sponsors-on-stream S11 - the Sponsors hub page (/o/[orgSlug]/sponsors?tab=...), rendered.
//
// The page is an async server component, so it is awaited and prerendered (the settings suites' pattern). The two
// client islands it hosts (OrgSponsors, SponsorPackages) are stubbed to markers that carry the props the page gave them
// - "did the org get the feature?" and "was it read-only?" become exact string checks. lib/entitlements is mocked at the
// ONE call the page makes (`hasFeatureOnAnyPass`) so the granted and the denied gate are both driven.
//
// What these cases pin, per the task brief and R19:
//   - no tab => Overview; an unknown tab => Overview
//   - every tab renders its own panel and ONLY its own (a sweep over `SPONSORS_TABS`, counted)
//   - Sponsors keeps `sponsors.tiers`, Packages keeps `sponsors.monetize` - granted AND denied
//   - a non-editor gets the read-only view Settings gave (canEdit false, no Packages) - NOT a refusal (R19)
//   - the data each tab needs is loaded for that tab only, and never twice across a sequence
//   - On stream (S12): an editor gets the tab with the org's sponsors, tiers gate and the scope the URL names - kept only if it
//     is one of THIS org's competitions; a non-editor gets Overview and the On stream loader is never called (R19)
//   - Overview (S13): every member gets the numbers for the period the URL names (kept only if it is a period or one of THIS
//     org's competitions), all read at ONE `now`; only an editor's page loads the report links and the share form's defaults
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const h = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  resolveLocale: vi.fn(),
  listSponsorRows: vi.fn(),
  hasFeatureOnAnyPass: vi.fn(),
  sql: vi.fn(),
  loadOnStreamScope: vi.fn(),
  sponsorOverview: vi.fn(),
  listReportLinks: vi.fn(),
  reportLinkDefaults: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({ requireOrgPage: h.requireOrgPage }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: h.resolveLocale }));
vi.mock("@/server/usecases/sponsors", () => ({ listSponsorRows: h.listSponsorRows }));
vi.mock("@/lib/entitlements", () => ({ hasFeatureOnAnyPass: h.hasFeatureOnAnyPass }));
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

// The islands, as markers carrying exactly what the page handed them.
vi.mock("@/components/org-sponsors", () => ({
  OrgSponsors: (p: { orgId: string; initialSponsors: unknown[]; competitions: unknown[]; hasTiers: boolean; canEdit: boolean; billingHref: string }) => (
    <div
      data-testid="org-sponsors"
      data-org={p.orgId}
      data-can-edit={String(p.canEdit)}
      data-has-tiers={String(p.hasTiers)}
      data-sponsors={p.initialSponsors.length}
      data-competitions={p.competitions.length}
      data-billing={p.billingHref}
    />
  ),
}));
vi.mock("@/components/sponsors/on-stream-tab", () => ({
  OnStreamTab: (p: {
    orgId: string;
    orgSlug: string;
    sponsors: { id: string; on_stream: boolean }[];
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
  SponsorPackages: (p: { orgId: string; competitions: unknown[]; hasMonetize: boolean; billingHref: string }) => (
    <div data-testid="sponsor-packages-island" data-org={p.orgId} data-has-monetize={String(p.hasMonetize)} data-competitions={p.competitions.length} />
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

async function render(tab?: string, scope?: string | string[], period?: string | string[]): Promise<string> {
  const element = await SponsorsHubPage({
    params: Promise.resolve({ orgSlug: ORG.slug }),
    searchParams: Promise.resolve({
      ...(tab === undefined ? {} : { tab }),
      ...(scope === undefined ? {} : { scope }),
      ...(period === undefined ? {} : { period }),
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
    { id: "s1", name: "Harbour", tier: "gold", status: "active", competition_id: null, on_stream: true },
    { id: "s2", name: "Ridge", tier: "partner", status: "active", competition_id: "c1", on_stream: false },
  ]);
  h.loadOnStreamScope.mockResolvedValue({ settings: { enabled: true, frequency: "busy" }, ownRow: true, sports: [{ sportKey: "cricket", kinds: [], sample: null, sampleCompetitionId: null }] });
  h.hasFeatureOnAnyPass.mockResolvedValue(true);
  h.sql.mockResolvedValue([{ id: "c1", name: "Spring Cup" }, { id: "c2", name: "Autumn Cup" }, { id: "c3", name: "Cup 3" }]);
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
    expect(attr(await render("sponsors"), "org-sponsors", "data-has-tiers")).toBe("false");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.tiers"]);
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
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.tiers"]);
    expect(h.listSponsorRows).toHaveBeenCalledTimes(1);
    h.hasFeatureOnAnyPass.mockClear();
    h.listSponsorRows.mockClear();
    await render("packages");
    expect(h.hasFeatureOnAnyPass.mock.calls.map((c) => c[1])).toEqual(["sponsors.monetize"]);
    expect(h.listSponsorRows).not.toHaveBeenCalled();
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
