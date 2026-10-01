// The Directory's Streaming tab (final review M-5 and M-3), through the REAL page and the REAL `relayOffer`.
//
// M-5: the tab holds relay destinations — a stream key is only ever used by Go live — so it is offered exactly when the
// fixture panel offers Go live: `relayOffer` (server/stream-panel-context.ts), the panel's own decision, asked org-wide.
// Not offered → no tab link, and `?tab=streaming` falls back to the first tab, reading no destination.
// M-3: before listing, the tab ticks every holder's lazy expiry (`expireTargetHolders(org, null)`), so an abandoned Go
// live cannot keep the "In use" lock — which disables exactly the buttons whose routes tick it — up indefinitely.
//
// prerender, not renderToStaticMarkup: the page is an async server component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const m = vi.hoisted(() => ({
  hasFeature: vi.fn<(orgId: string, key: string, competitionId?: string) => Promise<boolean>>(),
  requirePageAuth: vi.fn(),
  listStreamTargets: vi.fn(async () => []),
  expireTargetHolders: vi.fn(async () => undefined),
  defaultDeps: vi.fn((appUrl: string) => ({ appUrl, marker: "deps" })),
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "pro" }));
vi.mock("@/server/page-auth", () => ({ requirePageAuth: m.requirePageAuth }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/base-url", () => ({ baseUrlFromHeaders: async () => "http://app.test" }));
vi.mock("@/server/usecases/stream-targets", () => ({ listStreamTargets: m.listStreamTargets }));
vi.mock("@/server/usecases/stream-sessions", () => ({
  expireTargetHolders: m.expireTargetHolders, defaultDeps: m.defaultDeps, relayCredits: async () => ({ total: 0, monthly: 0, pack: 0, monthlyAllowance: 0 }),
}));
vi.mock("@/server/usecases/persons", () => ({ listPersons: async () => ({ items: [] }) }));
vi.mock("@/server/usecases/person-duplicates", () => ({ listDuplicateCandidates: async () => ({ items: [] }) }));
vi.mock("@/server/usecases/clubs", () => ({ listClubsWithMeta: async () => [] }));
vi.mock("@/server/usecases/teams", () => ({ listTeams: async () => [] }));
vi.mock("@/server/usecases/officials", () => ({ listOfficialsForConsole: async () => [] }));
vi.mock("@/server/usecases/venues", () => ({ listVenues: async () => [] }));
// Client islands → identifiable markers.
vi.mock("@/components/nav", () => ({ Nav: () => <nav data-testid="nav" /> }));
vi.mock("@/components/v2/stream-destinations-panel", () => ({ StreamDestinationsPanel: () => <div data-testid="stream-destinations-panel" /> }));
vi.mock("@/components/v2/persons-panel", () => ({ PersonsPanel: () => <div data-testid="players-tab" /> }));
vi.mock("@/components/v2/duplicates-panel", () => ({ DuplicatesPanel: () => <div /> }));
vi.mock("@/components/v2/clubs-teams-list", () => ({ ClubsTeamsList: () => <div /> }));
vi.mock("@/components/v2/officials-directory-panel", () => ({ OfficialsDirectoryPanel: () => <div /> }));
vi.mock("@/components/v2/venues-panel", () => ({ VenuesPanel: () => <div /> }));
vi.mock("@/components/ui/tip", () => ({ Tip: () => null }));
vi.mock("@/components/ui/scroll-active-tab-into-view", () => ({ ScrollActiveTabIntoView: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import DirectoryPage from "../page";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";

const ORG = "org-1";
const render = async (tab?: string) => {
  const { prelude } = await prerender(await DirectoryPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
  return new Response(prelude).text();
};
const STREAMING_LINK = 'href="/directory?tab=streaming"';
const PANEL = 'data-testid="stream-destinations-panel"';

beforeEach(() => {
  m.requirePageAuth.mockReset().mockResolvedValue({ auth: { orgId: ORG, userId: "u-1", role: "owner", via: "session", keyId: null }, canEdit: true });
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.listStreamTargets.mockClear();
  m.expireTargetHolders.mockClear();
  m.defaultDeps.mockClear();
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });   // a deployment that can start a stream
});
afterEach(() => setRelayDriversForTest(null));

describe("Directory › Streaming tab — offered exactly when the fixture panel offers Go live (M-5)", () => {
  it("OFFERED (both keys, a running relay): the tab is listed and renders the destinations", async () => {
    const html = await render("streaming");
    expect(html).toContain(STREAMING_LINK);
    expect(html).toContain(PANEL);
    expect(m.hasFeature.mock.calls.map((c) => [c[0], c[1], c[2]]), "the panel's two keys, org-wide (no competition)").toEqual([
      [ORG, "streaming.overlay", undefined], [ORG, "streaming.relay", undefined],
    ]);
    expect(m.listStreamTargets).toHaveBeenCalledTimes(1);
  });

  it("NOT offered, for each of the three reasons the panel would not offer Go live: no tab link, `?tab=streaming` falls back to Players, and no destination is read or ticked", async () => {
    const reasons: [string, () => void][] = [
      ["streaming.overlay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.overlay")],
      ["streaming.relay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay")],
      ["the deployment cannot start a stream", () => setRelayDriversForTest(disabledRelayDrivers())],
    ];
    let checked = 0;
    for (const [why, apply] of reasons) {
      m.hasFeature.mockReset().mockResolvedValue(true);
      setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
      m.listStreamTargets.mockClear();
      m.expireTargetHolders.mockClear();
      apply();
      const html = await render("streaming");
      expect(html, why).not.toContain(STREAMING_LINK);
      expect(html, `${why}: the other tabs stay`).toContain('href="/directory?tab=venues"');
      expect(html, why).not.toContain(PANEL);
      expect(html, `${why}: the first tab instead`).toContain('data-testid="players-tab"');
      expect(m.listStreamTargets, why).not.toHaveBeenCalled();
      expect(m.expireTargetHolders, why).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("another tab: the Streaming link follows the same gate, and nothing streaming is read", async () => {
    const shown = await render("venues");
    expect(shown).toContain(STREAMING_LINK);
    m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay");
    const hidden = await render("venues");
    expect(hidden).not.toContain(STREAMING_LINK);
    expect(m.listStreamTargets).not.toHaveBeenCalled();
    expect(m.expireTargetHolders).not.toHaveBeenCalled();
  });
});
