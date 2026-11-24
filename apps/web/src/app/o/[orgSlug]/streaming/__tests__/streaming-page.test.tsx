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
  seaznOfferOf: vi.fn<(orgId: string) => Promise<{ offered: boolean }>>(async () => ({ offered: true })),
  hasLiveConnection: vi.fn<(orgId: string) => Promise<boolean>>(async () => false),
  expireTargetHolders: vi.fn(async () => undefined),
  defaultDeps: vi.fn((appUrl: string) => ({ appUrl, marker: "deps" })),
  captureError: vi.fn(),
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "pro" }));
vi.mock("@/server/page-auth", () => ({ requireOrgPage: m.requirePageAuth }));
vi.mock("@/lib/sentry", () => ({ captureError: m.captureError }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/base-url", () => ({ baseUrlFromHeaders: async () => "http://app.test" }));
vi.mock("@/server/usecases/stream-targets", () => ({ listStreamTargets: m.listStreamTargets, seaznOfferOf: m.seaznOfferOf }));
// The one read the disconnect-only page adds; the real query is DB-tested in youtube-connections-routes.test.ts.
vi.mock("@/server/youtube/connections", () => ({ hasLiveConnection: m.hasLiveConnection }));
vi.mock("@/server/usecases/stream-sessions", () => ({
  expireTargetHolders: m.expireTargetHolders, defaultDeps: m.defaultDeps, relayCredits: async () => ({ total: 0, monthly: 0, pack: 0, monthlyAllowance: 0 }),
}));
// Client islands → identifiable markers.
vi.mock("@/components/nav", () => ({ Nav: () => <nav data-testid="nav" /> }));
// The panel renders the labels it is handed, so a test can see the LIST arrive, not only the panel.
vi.mock("@/components/v2/stream-destinations-panel", () => ({
  StreamDestinationsPanel: ({ targets, canEdit, landing, seazn }: { targets: { id: string; label: string }[]; canEdit: boolean; landing?: { code: string; pendingId: string | null } | null; seazn?: { offered: boolean } | null }) => (
    <div
      data-testid="stream-destinations-panel"
      data-can-edit={String(canEdit)}
      data-seazn={seazn ? String(seazn.offered) : "none"}
      data-landing-code={landing ? landing.code : "none"}
      data-landing-pending={landing?.pendingId ?? "none"}
    >
      {targets.map((t) => <span key={t.id} data-target-label={t.label} />)}
    </div>
  ),
}));

// The restricted page's panel, identifiable and showing the channels it was handed.
vi.mock("@/components/v2/youtube-disconnect-only-panel", () => ({
  YoutubeDisconnectOnlyPanel: ({ orgId, targets }: { orgId: string; targets: { id: string; label: string }[] }) => (
    <div data-testid="disconnect-only-panel" data-org-id={orgId}>
      {targets.map((t) => <span key={t.id} data-target-label={t.label} />)}
    </div>
  ),
}));

import StreamingPage from "../page";
import { HttpError } from "@/lib/errors";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";

const ORG = "org-1";
type Params = { youtube?: string | string[]; pending?: string | string[]; disconnected?: string | string[] };
const page = (params: Params = {}) => StreamingPage({ params: Promise.resolve({ orgSlug: "riverside" }), searchParams: Promise.resolve(params) });
const render = async (params: Params = {}) => {
  const { prelude } = await prerender(await page(params));
  return new Response(prelude).text();
};
const PANEL = 'data-testid="stream-destinations-panel"';
const DISCONNECT_ONLY = 'data-testid="disconnect-only-panel"';
/** What Next throws for `notFound()` — the digest the framework turns into the 404 page. */
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

beforeEach(() => {
  m.requirePageAuth.mockReset().mockResolvedValue({ auth: { orgId: ORG, userId: "u-1", role: "owner", via: "session", keyId: null }, org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: "owner" }, canEdit: true });
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.listStreamTargets.mockReset().mockResolvedValue([]);
  m.seaznOfferOf.mockReset().mockResolvedValue({ offered: true });
  m.hasLiveConnection.mockReset().mockResolvedValue(false);
  m.expireTargetHolders.mockReset().mockResolvedValue(undefined);
  m.defaultDeps.mockClear();
  m.captureError.mockClear();
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });   // a deployment that can start a stream
});
afterEach(() => setRelayDriversForTest(null));

describe("Streaming page — offered exactly when the fixture panel offers Go live (M-5)", () => {
  it("OFFERED (both keys, a running relay): renders the page chrome and the destinations — after ticking every holder's expiry, org-wide (M-3)", async () => {
    const html = await render();
    expect(html, "the /o layout owns the nav; the page renders none (a second, cookie-led one showed another org)").not.toContain('data-testid="nav"');
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
    m.requirePageAuth.mockResolvedValue({ auth: { orgId: ORG, userId: "u-2", role: "viewer", via: "session", keyId: null }, org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: "owner" }, canEdit: false });
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
      ["the picker's already-connected landing", { youtube: "already_connected" }, "already_connected", "none"],
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

// T18 (Google API Services User Data Policy, DP III): an org that can no longer go live must still be able to disconnect a channel.
describe("Streaming page — the disconnect-only page for an org that is not offered Go live but holds a YouTube connection (T18)", () => {
  const reasons: [string, () => void][] = [
    ["streaming.overlay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.overlay")],
    ["streaming.relay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay")],
    ["the deployment cannot start a stream", () => setRelayDriversForTest(disabledRelayDrivers())],
  ];
  const reset = (apply: () => void) => {
    m.hasFeature.mockReset().mockResolvedValue(true);
    setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
    m.listStreamTargets.mockClear();
    m.expireTargetHolders.mockClear();
    m.hasLiveConnection.mockClear();
    apply();
  };

  it("for each of the three reasons, an editor WITH a connection gets the restricted page: the channels only, no key read, no holder expiry, never the full panel", async () => {
    m.hasLiveConnection.mockResolvedValue(true);
    m.listStreamTargets.mockResolvedValue([{ id: "t-1", label: "Riverside FC" }]);
    let checked = 0;
    for (const [why, apply] of reasons) {
      reset(apply);
      const html = await render();
      expect(html, why).toContain(DISCONNECT_ONLY);
      expect(html, why).toContain('data-target-label="Riverside FC"');
      expect(html, why).toContain(`data-org-id="${ORG}"`);
      expect(html, `${why}: not the full panel`).not.toContain(PANEL);
      expect(html, `${why}: the page chrome`).toContain("<h1");
      expect(m.hasLiveConnection, why).toHaveBeenCalledWith(ORG);
      // the list is asked for the CHANNELS ONLY: that option is what keeps the pasted keys unread
      expect((m.listStreamTargets.mock.calls as unknown[][])[0]!.slice(1), why).toEqual([ORG, { channelsOnly: true }]);
      expect(m.expireTargetHolders, `${why}: no holder expiry`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  // Court stream follow-up (2026-11-18): the full page's no-second-Nav guard had no twin on the restricted page. The /o layout owns
  // the nav; a second one here was the cookie-led nav that showed another org. Both restricted states are checked: with a channel,
  // and the emptied ?disconnected=1 page an editor lands on after the last disconnect.
  it("the disconnect-only page renders no Nav of its own — with a channel and emptied (?disconnected=1), for each of the three reasons (count reported)", async () => {
    let checked = 0;
    for (const [why, apply] of reasons) {
      for (const [state, connected, params] of [["with a channel", true, {}], ["emptied", false, { disconnected: "1" }]] as const) {
        reset(apply);
        m.hasLiveConnection.mockResolvedValue(connected);
        m.listStreamTargets.mockResolvedValue(connected ? [{ id: "t-1", label: "Riverside FC" }] : []);
        const html = await render(params);
        expect(html, `${why}, ${state}: premise, the restricted page`).toContain(DISCONNECT_ONLY);
        expect(html, `${why}, ${state}: the page's own chrome`).toContain("<h1");
        expect(html, `${why}, ${state}: the /o layout owns the nav; the page renders none`).not.toContain('data-testid="nav"');
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("an editor with NO connection is still a 404 for each reason (the empty case), then gets the page the moment a connection exists (the sequence)", async () => {
    let checked = 0;
    for (const [why, apply] of reasons) {
      reset(apply);
      m.hasLiveConnection.mockResolvedValue(false);
      await expect(page(), why).rejects.toMatchObject(NOT_FOUND);
      expect(m.listStreamTargets, why).not.toHaveBeenCalled();
      m.hasLiveConnection.mockResolvedValue(true);
      await expect(page(), `${why}: with a connection`).resolves.toBeDefined();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a viewer is a 404 even WITH a connection (only an owner or admin can disconnect), and the connection is not even looked up for them", async () => {
    m.requirePageAuth.mockResolvedValue({ auth: { orgId: ORG, userId: "u-2", role: "viewer", via: "session", keyId: null }, org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: "owner" }, canEdit: false });
    m.hasLiveConnection.mockResolvedValue(true);
    let checked = 0;
    for (const [why, apply] of reasons) {
      reset(apply);
      await expect(page(), why).rejects.toMatchObject(NOT_FOUND);
      expect(m.hasLiveConnection, why).not.toHaveBeenCalled();
      expect(m.listStreamTargets, why).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("F7: an editor who has just disconnected the LAST channel (nothing offered, no connection left) and arrives with ?disconnected=1 stays on the restricted page - empty, nothing read - while the same org without it, a viewer with it, and any other value are the 404 they always were (anti-vacuity: 3 reasons)", async () => {
    let checked = 0;
    for (const [why, apply] of reasons) {
      reset(apply);
      m.hasLiveConnection.mockResolvedValue(false);
      const html = await render({ disconnected: "1" });
      expect(html, `${why}: the restricted page`).toContain(DISCONNECT_ONLY);
      expect(html, `${why}: nothing to list`).not.toContain("data-target-label");
      expect(html, `${why}: not the full panel`).not.toContain(PANEL);
      expect(m.listStreamTargets, `${why}: no destination is read for an org with nothing`).not.toHaveBeenCalled();
      expect(m.expireTargetHolders, why).not.toHaveBeenCalled();
      // the negative pairs: without the param, with another value, as a list, and for a viewer - the 404
      await expect(page(), `${why}: no param`).rejects.toMatchObject(NOT_FOUND);
      await expect(page({ disconnected: "0" }), `${why}: another value`).rejects.toMatchObject(NOT_FOUND);
      await expect(page({ disconnected: ["1", "1"] }), `${why}: a list`).rejects.toMatchObject(NOT_FOUND);
      m.requirePageAuth.mockResolvedValueOnce({ auth: { orgId: ORG, userId: "u-2", role: "viewer", via: "session", keyId: null }, org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: "owner" }, canEdit: false });
      await expect(page({ disconnected: "1" }), `${why}: a viewer`).rejects.toMatchObject(NOT_FOUND);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("F7: ?disconnected=1 changes nothing for an org that is OFFERED the page (the full panel, the unrestricted list) or that still has a channel (the channels are listed)", async () => {
    const offered = await render({ disconnected: "1" });
    expect(offered).toContain(PANEL);
    expect(offered).not.toContain(DISCONNECT_ONLY);
    reset(reasons[0]![1]);
    m.hasLiveConnection.mockResolvedValue(true);
    m.listStreamTargets.mockResolvedValue([{ id: "t-1", label: "Riverside FC" }]);
    const restricted = await render({ disconnected: "1" });
    expect(restricted).toContain(DISCONNECT_ONLY);
    expect(restricted, "a channel that is still there is still listed").toContain('data-target-label="Riverside FC"');
  });

  it("an OFFERED org keeps the full page even with a connection: the full panel, the holder expiry, the unrestricted list, and no connection lookup", async () => {
    m.hasLiveConnection.mockResolvedValue(true);
    const html = await render();
    expect(html).toContain(PANEL);
    expect(html).not.toContain(DISCONNECT_ONLY);
    expect(m.hasLiveConnection).not.toHaveBeenCalled();
    expect(m.expireTargetHolders).toHaveBeenCalledTimes(1);
    expect((m.listStreamTargets.mock.calls as unknown[][])[0]!.slice(1)).toEqual([ORG]);
  });

  // Owner, 2026-11-18: the ADDRESS decides the org (a cookie never does), and the page says which org it is showing at every width.
  it("the address decides the org: the page asks requireOrgPage for the URL's slug (with its query, for a renamed org) and lists THAT org's destinations only", async () => {
    await render({ youtube: "connected" });
    expect(m.requirePageAuth).toHaveBeenCalledWith("riverside", { tail: "/streaming", search: "?youtube=connected" });
    expect((m.listStreamTargets.mock.calls as unknown[][])[0]!.slice(1)).toEqual([ORG]);
  });

  it("names the org in the page itself, not only in the nav chip that is hidden on a phone", async () => {
    const html = await render();
    expect(html).toMatch(/data-testid="streaming-org"[^>]*>Riverside CC</);
  });

  it("a non-member is refused as every other /o page refuses one: the page throws the 404 and reads no destination", async () => {
    m.requirePageAuth.mockRejectedValue(NOT_FOUND);
    await expect(render()).rejects.toMatchObject(NOT_FOUND);
    expect(m.listStreamTargets).not.toHaveBeenCalled();
    expect(m.expireTargetHolders).not.toHaveBeenCalled();
  });
});

// Task 33b: the Seazn Hosted card reads the org's switch through the page — never the list, which leaves Seazn out while the switch is
// off (T33's `seaznWhere`): the card would otherwise vanish with the one control that turns it back on.
describe("Streaming page — the org's Seazn switch reaches the panel (Task 33b)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const live = (v: string) => vi.stubEnv("SEAZN_HOSTED_LIVE", v);

  it("LIVE on: the switch is read for THIS org, once, and handed to the panel — on and off (2 checked)", async () => {
    live("true");
    let checked = 0;
    for (const offered of [true, false]) {
      m.seaznOfferOf.mockClear().mockResolvedValue({ offered });
      const html = await render();
      expect(m.seaznOfferOf, String(offered)).toHaveBeenCalledTimes(1);
      expect(m.seaznOfferOf, String(offered)).toHaveBeenCalledWith(ORG);
      expect(html, String(offered)).toContain(`data-seazn="${offered}"`);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("OFF with nothing of the org's own: the list is empty (as the server sends it while off) and the switch still reaches the panel, off", async () => {
    live("true");
    m.listStreamTargets.mockResolvedValue([]);
    m.seaznOfferOf.mockResolvedValue({ offered: false });
    expect(await render()).toContain('data-seazn="false"');
  });

  it("LIVE off (the default, and every deployment until the owner turns it on): the switch is not read and the panel draws no card", async () => {
    let checked = 0;
    for (const v of ["", "false"]) {
      live(v);
      m.seaznOfferOf.mockClear();
      const html = await render();
      expect(m.seaznOfferOf, JSON.stringify(v)).not.toHaveBeenCalled();
      expect(html, JSON.stringify(v)).toContain('data-seazn="none"');
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a viewer gets the switch too (the card shows it read-only) — canEdit stays false", async () => {
    live("true");
    m.requirePageAuth.mockResolvedValue({ auth: { orgId: ORG, userId: "u-2", role: "viewer", via: "session", keyId: null }, org: { id: "org-1", name: "Riverside CC", slug: "riverside", role: "owner" }, canEdit: false });
    const html = await render();
    expect(html).toContain('data-seazn="true"');
    expect(html).toContain('data-can-edit="false"');
  });

  it("an org with no Seazn row (no product path makes one, so it is reported): the page still renders, without the card", async () => {
    live("true");
    const missing = new HttpError(404, "the Seazn destination was not found");
    m.seaznOfferOf.mockRejectedValue(missing);
    const html = await render();
    expect(html).toContain(PANEL);
    expect(html).toContain('data-seazn="none"');
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError).toHaveBeenCalledWith(missing, expect.objectContaining({ orgId: ORG, route: "streaming.seazn_offer" }));
  });

  it("any OTHER failure reading the switch is not swallowed: the page fails as it does when the list fails", async () => {
    live("true");
    const boom = new Error("connection terminated");
    m.seaznOfferOf.mockRejectedValue(boom);
    await expect(page()).rejects.toBe(boom);
    expect(m.captureError, "not reported as the missing row").not.toHaveBeenCalled();
  });

  it("the restricted page (an org that cannot go live) draws no card and never reads the switch", async () => {
    live("true");
    m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay");
    m.hasLiveConnection.mockResolvedValue(true);
    const html = await render();
    expect(html, "premise: the restricted page").toContain(DISCONNECT_ONLY);
    expect(m.seaznOfferOf).not.toHaveBeenCalled();
  });
});
