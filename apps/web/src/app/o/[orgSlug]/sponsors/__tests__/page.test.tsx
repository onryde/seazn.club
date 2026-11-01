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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const h = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  resolveLocale: vi.fn(),
  listSponsorRows: vi.fn(),
  hasFeatureOnAnyPass: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({ requireOrgPage: h.requireOrgPage }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: h.resolveLocale }));
vi.mock("@/server/usecases/sponsors", () => ({ listSponsorRows: h.listSponsorRows }));
vi.mock("@/lib/entitlements", () => ({ hasFeatureOnAnyPass: h.hasFeatureOnAnyPass }));
vi.mock("@/lib/db", () => ({ sql: h.sql }));

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

async function render(tab?: string): Promise<string> {
  const element = await SponsorsHubPage({
    params: Promise.resolve({ orgSlug: ORG.slug }),
    searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
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
  h.listSponsorRows.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
  h.hasFeatureOnAnyPass.mockResolvedValue(true);
  h.sql.mockResolvedValue([{ id: "c1", name: "Spring Cup" }, { id: "c2", name: "Autumn Cup" }, { id: "c3", name: "Cup 3" }]);
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
  it("Overview and On stream read no sponsor rows and ask no sponsor gate (their bodies are S13's and S12's)", async () => {
    await render();
    await render("on_stream");
    expect(h.listSponsorRows).not.toHaveBeenCalled();
    expect(h.hasFeatureOnAnyPass).not.toHaveBeenCalled();
    expect(h.sql).not.toHaveBeenCalled();
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

describe("the placeholder bodies S12 and S13 drop into", () => {
  it("Overview and On stream mount a labelled, otherwise empty panel (no feature claims) for an editor", async () => {
    for (const tab of ["overview", "on_stream"] as const) {
      const html = await render(tab);
      const panel = new RegExp(`<section[^>]*data-testid="sponsors-tab-${tab}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];
      expect(panel, `${tab} panel`).toBeDefined();
      // A heading carrying the tab's own label, and nothing a person could read as a promise.
      expect(panel).toMatch(/<h2[^>]*>[^<]+<\/h2>/);
      expect(panel!.replace(/<[^>]+>/g, "").trim().length, `${tab}: only its label`).toBeLessThan(40);
    }
  });
});
