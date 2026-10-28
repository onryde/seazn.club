// The org's Streaming page (final review M-5 and M-3, moved from the Directory's tab by the owner, 2026-10-27), through the REAL
// page and the REAL `relayOffer`.
//
// M-5: the page holds relay destinations — a stream key is only ever used by Go live — so it exists exactly when the fixture panel
// offers Go live: `relayOffer` (server/stream-panel-context.ts), the panel's own decision, asked org-wide. Not offered → a real
// 404 (`notFound()`), and no destination is read.
// M-3: before listing, the page ticks every holder's lazy expiry (`expireTargetHolders(org, null)`), so an abandoned Go live
// cannot keep the "In use" lock — which disables exactly the buttons whose routes tick it — up indefinitely.
//
// prerender, not renderToStaticMarkup: the page is an async server component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const m = vi.hoisted(() => ({
  hasFeature: vi.fn<(orgId: string, key: string, competitionId?: string) => Promise<boolean>>(),
  requirePageAuth: vi.fn(),
  listStreamTargets: vi.fn<() => Promise<{ id: string; label: string }[]>>(async () => []),
  expireTargetHolders: vi.fn(async () => undefined),
  defaultDeps: vi.fn((appUrl: string) => ({ appUrl, marker: "deps" })),
  captureError: vi.fn(),
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "pro" }));
vi.mock("@/server/page-auth", () => ({ requirePageAuth: m.requirePageAuth }));
vi.mock("@/lib/sentry", () => ({ captureError: m.captureError }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/base-url", () => ({ baseUrlFromHeaders: async () => "http://app.test" }));
vi.mock("@/server/usecases/stream-targets", () => ({ listStreamTargets: m.listStreamTargets }));
vi.mock("@/server/usecases/stream-sessions", () => ({
  expireTargetHolders: m.expireTargetHolders, defaultDeps: m.defaultDeps, relayCredits: async () => ({ total: 0, monthly: 0, pack: 0, monthlyAllowance: 0 }),
}));
// Client islands → identifiable markers.
vi.mock("@/components/nav", () => ({ Nav: () => <nav data-testid="nav" /> }));
// The panel renders the labels it is handed, so a test can see the LIST arrive, not only the panel.
vi.mock("@/components/v2/stream-destinations-panel", () => ({
  StreamDestinationsPanel: ({ targets, canEdit, landing }: { targets: { id: string; label: string }[]; canEdit: boolean; landing?: { code: string; pendingId: string | null } | null }) => (
    <div
      data-testid="stream-destinations-panel"
      data-can-edit={String(canEdit)}
      data-landing-code={landing ? landing.code : "none"}
      data-landing-pending={landing?.pendingId ?? "none"}
    >
      {targets.map((t) => <span key={t.id} data-target-label={t.label} />)}
    </div>
  ),
}));

import StreamingPage from "../page";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";

const ORG = "org-1";
type Params = { youtube?: string | string[]; pending?: string | string[] };
const page = (params: Params = {}) => StreamingPage({ searchParams: Promise.resolve(params) });
const render = async (params: Params = {}) => {
  const { prelude } = await prerender(await page(params));
  return new Response(prelude).text();
};
const PANEL = 'data-testid="stream-destinations-panel"';
/** What Next throws for `notFound()` — the digest the framework turns into the 404 page. */
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

beforeEach(() => {
  m.requirePageAuth.mockReset().mockResolvedValue({ auth: { orgId: ORG, userId: "u-1", role: "owner", via: "session", keyId: null }, canEdit: true });
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.listStreamTargets.mockReset().mockResolvedValue([]);
  m.expireTargetHolders.mockReset().mockResolvedValue(undefined);
  m.defaultDeps.mockClear();
  m.captureError.mockClear();
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });   // a deployment that can start a stream
});
afterEach(() => setRelayDriversForTest(null));

describe("Streaming page — offered exactly when the fixture panel offers Go live (M-5)", () => {
  it("OFFERED (both keys, a running relay): renders the page chrome and the destinations — after ticking every holder's expiry, org-wide (M-3)", async () => {
    const html = await render();
    expect(html).toContain('data-testid="nav"');
    expect(html, "the page's own title").toContain("<h1");
    expect(html).toContain(PANEL);
    expect(m.hasFeature.mock.calls.map((c) => [c[0], c[1], c[2]]), "the panel's two keys, org-wide (no competition)").toEqual([
      [ORG, "streaming.overlay", undefined], [ORG, "streaming.relay", undefined],
    ]);
    expect(m.expireTargetHolders).toHaveBeenCalledTimes(1);
    expect(m.expireTargetHolders).toHaveBeenCalledWith(ORG, null, { appUrl: "http://app.test", marker: "deps" });
    expect(m.listStreamTargets).toHaveBeenCalledTimes(1);
    expect(m.expireTargetHolders.mock.invocationCallOrder[0]!, "the expiry runs BEFORE the list it unlocks")
      .toBeLessThan(m.listStreamTargets.mock.invocationCallOrder[0]!);
  });

  it("R-3 (re-review): the expiry tick is best-effort — when it THROWS (a due expiry's provider effect failing), the error is reported once and the destinations are still listed; a stuck holder simply stays until the next load", async () => {
    const boom = new Error("cloudflare removeOutput: HTTP 502");
    const destinations = [{ id: "t-1", label: "Club YouTube" }, { id: "t-2", label: "Club Facebook" }];
    m.listStreamTargets.mockResolvedValue(destinations);
    m.expireTargetHolders.mockRejectedValueOnce(boom);
    const html = await render();
    expect(html, "the page renders, not an error page").toContain(PANEL);
    let checked = 0;
    for (const t of destinations) {
      expect(html, `${t.label} is listed after the failed tick`).toContain(`data-target-label="${t.label}"`);
      checked++;
    }
    expect(checked).toBe(2);
    expect(m.expireTargetHolders, "PREMISE: the tick ran, and threw").toHaveBeenCalledTimes(1);
    expect(m.listStreamTargets, "listed anyway").toHaveBeenCalledTimes(1);
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError).toHaveBeenCalledWith(boom, expect.objectContaining({ orgId: ORG, route: "streaming.expire_holders" }));
    // The positive pair, and the second call: a tick that succeeds reports nothing and lists the same destinations.
    const again = await render();
    expect(again).toContain('data-target-label="Club YouTube"');
    expect(m.captureError, "a clean tick reports nothing").toHaveBeenCalledTimes(1);
    expect(m.expireTargetHolders).toHaveBeenCalledTimes(2);
    expect(m.listStreamTargets).toHaveBeenCalledTimes(2);
  });

  it("NOT offered, for each of the three reasons the panel would not offer Go live: a real 404, and no destination is read or ticked", async () => {
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
      await expect(page(), why).rejects.toMatchObject(NOT_FOUND);
      expect(m.listStreamTargets, why).not.toHaveBeenCalled();
      expect(m.expireTargetHolders, why).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the positive pair of the three refusals: the same org, with both keys on and a running relay, is NOT a 404 (a guard that 404s everyone would pass the test above)", async () => {
    await expect(page()).resolves.toBeDefined();
  });

  it("a viewer (not an editor) is offered the page too — every member sees the list; only the actions are an editor's (the panel takes canEdit)", async () => {
    m.requirePageAuth.mockResolvedValue({ auth: { orgId: ORG, userId: "u-2", role: "viewer", via: "session", keyId: null }, canEdit: false });
    const html = await render();
    expect(html).toContain(PANEL);
    expect(html, "canEdit reaches the panel as false").toContain('data-can-edit="false"');
    expect(m.listStreamTargets).toHaveBeenCalledTimes(1);
  });

  it("the owner's canEdit reaches the panel as true (the positive pair of the viewer case)", async () => {
    expect(await render()).toContain('data-can-edit="true"');
  });

  it("hands the panel the connect round trip's landing — what the callback put in the query — in the one shape the panel takes", async () => {
    const PENDING = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const cases: [string, Params, string, string][] = [
      ["no query", {}, "none", "none"],
      ["a banner code", { youtube: "denied" }, "denied", "none"],
      ["connected", { youtube: "connected" }, "connected", "none"],
      ["a pick carries its pending grant", { youtube: "pick", pending: PENDING }, "pick", PENDING],
      ["a pick with no pending id cannot open a picker: it reads as expired", { youtube: "pick" }, "expired", "none"],
      ["a pick with a junk pending id reads as expired too", { youtube: "pick", pending: "not-a-uuid" }, "expired", "none"],
      ["a code that is not one of ours shows nothing", { youtube: "<script>" }, "none", "none"],
      ["a repeated parameter reads its first value", { youtube: ["unavailable", "denied"] }, "unavailable", "none"],
    ];
    let checked = 0;
    for (const [why, params, code, pending] of cases) {
      const html = await render(params);
      expect(html, why).toContain(`data-landing-code="${code}"`);
      expect(html, why).toContain(`data-landing-pending="${pending}"`);
      checked++;
    }
    expect(checked, "every case ran").toBe(cases.length);
  });

  it("a landing never changes what the page reads or whether it exists: a 404 stays a 404, the list is still read", async () => {
    setRelayDriversForTest(disabledRelayDrivers());
    await expect(page({ youtube: "connected" })).rejects.toMatchObject(NOT_FOUND);
    expect(m.listStreamTargets).not.toHaveBeenCalled();
    setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
    await render({ youtube: "connected" });
    expect(m.listStreamTargets).toHaveBeenCalledTimes(1);
  });
});
