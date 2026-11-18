// The Directory has FOUR tabs (owner, 2026-10-27: Streaming moved to its own top-nav page, `app/streaming`). There is no streaming
// tab link, no streaming panel, and NO forward: `/directory?tab=streaming` is an unknown tab like any other, and opens the first
// tab. Whether the org is offered streaming makes no difference to the Directory — it no longer asks.
//
// prerender, not renderToStaticMarkup: the page is an async server component.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const m = vi.hoisted(() => ({
  hasFeature: vi.fn<(orgId: string, key: string, competitionId?: string) => Promise<boolean>>(),
  requirePageAuth: vi.fn(),
  listStreamTargets: vi.fn(async () => []),
  expireTargetHolders: vi.fn(async () => undefined),
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "pro" }));
vi.mock("@/server/page-auth", () => ({ requirePageAuth: m.requirePageAuth }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/server/usecases/stream-targets", () => ({ listStreamTargets: m.listStreamTargets }));
vi.mock("@/server/usecases/stream-sessions", () => ({
  expireTargetHolders: m.expireTargetHolders, defaultDeps: () => ({}), relayCredits: async () => ({ total: 0, monthly: 0, pack: 0, monthlyAllowance: 0 }),
}));
vi.mock("@/server/usecases/persons", () => ({ listPersons: async () => ({ items: [] }) }));
vi.mock("@/server/usecases/person-duplicates", () => ({ listDuplicateCandidates: async () => ({ items: [] }) }));
vi.mock("@/server/usecases/clubs", () => ({ listClubsWithMeta: async () => [] }));
vi.mock("@/server/usecases/teams", () => ({ listTeams: async () => [] }));
vi.mock("@/server/usecases/officials", () => ({ listOfficialsForConsole: async () => [] }));
vi.mock("@/server/usecases/venues", () => ({ listVenues: async () => [] }));
// Client islands → identifiable markers.
vi.mock("@/components/nav", () => ({ Nav: () => <nav data-testid="nav" /> }));
vi.mock("@/components/v2/persons-panel", () => ({ PersonsPanel: () => <div data-testid="players-tab" /> }));
vi.mock("@/components/v2/duplicates-panel", () => ({ DuplicatesPanel: () => <div /> }));
vi.mock("@/components/v2/clubs-teams-list", () => ({ ClubsTeamsList: () => <div data-testid="clubs-tab" /> }));
vi.mock("@/components/v2/officials-directory-panel", () => ({ OfficialsDirectoryPanel: () => <div data-testid="officials-tab" /> }));
vi.mock("@/components/v2/venues-panel", () => ({ VenuesPanel: () => <div data-testid="venues-tab" /> }));
vi.mock("@/components/ui/tip", () => ({ Tip: () => null }));
vi.mock("@/components/ui/scroll-active-tab-into-view", () => ({ ScrollActiveTabIntoView: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import DirectoryPage from "../page";

const render = async (tab?: string) => {
  const { prelude } = await prerender(await DirectoryPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
  return new Response(prelude).text();
};
/** The four tab links the Directory keeps, in order — the owner's list, not read back from the page. */
const TAB_LINKS = ["players", "clubs", "officials", "venues"].map((k) => `href="/directory?tab=${k}"`);

beforeEach(() => {
  m.requirePageAuth.mockReset().mockResolvedValue({ auth: { orgId: "org-1", userId: "u-1", role: "owner", via: "session", keyId: null }, canEdit: true });
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.listStreamTargets.mockClear();
  m.expireTargetHolders.mockClear();
});

describe("Directory — four tabs, no Streaming (the Streaming page is top-nav)", () => {
  it("lists exactly the four tabs, and no streaming link, for an org that IS offered streaming", async () => {
    const html = await render();
    let checked = 0;
    for (const link of TAB_LINKS) {
      expect(html, link).toContain(link);
      checked++;
    }
    expect(checked).toBe(4);
    expect(html).not.toContain("tab=streaming");
    expect(html).not.toContain('data-testid="stream-destinations"');
  });

  it("`?tab=streaming` is an unknown tab: it opens the first tab, forwards nowhere, and reads no destination — for an org that IS offered streaming", async () => {
    const html = await render("streaming");
    expect(html, "the first tab instead").toContain('data-testid="players-tab"');
    expect(html).not.toContain('data-testid="stream-destinations"');
    expect(html, "no forward: the page rendered, it did not redirect").toContain("<h1");
    expect(m.listStreamTargets).not.toHaveBeenCalled();
    expect(m.expireTargetHolders).not.toHaveBeenCalled();
  });

  it("the Directory no longer asks whether streaming is offered: it reads neither streaming entitlement", async () => {
    await render();
    await render("streaming");
    await render("venues");
    const asked = m.hasFeature.mock.calls.map((c) => c[1]).filter((k) => k.startsWith("streaming."));
    expect(asked).toEqual([]);
  });

  it("the other tabs still render (the positive pair: removing one tab did not break the rest)", async () => {
    let checked = 0;
    for (const [tab, marker] of [["players", "players-tab"], ["clubs", "clubs-tab"], ["officials", "officials-tab"], ["venues", "venues-tab"]] as const) {
      expect(await render(tab), tab).toContain(`data-testid="${marker}"`);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
