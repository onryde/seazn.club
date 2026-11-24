// The Streaming page with its REAL destinations panel and REAL Seazn Hosted card (Task 33b): the join between the org's switch, read by
// the page, and what an organiser SEES. streaming-page.test.tsx stubs the panel to see what the page hands it; this file does not, so a
// page that read the switch from the wrong place, forgot to pass it, or a panel that drew the card from the list would red here (AGENTS.md
// recurring failure class 1: the inert seam).
//
// The pin the T33 review asked for: with the switch OFF, the list the server sends has no Seazn row (`seaznWhere`), and the card is still
// on the page with its switch in the off position — the one control that turns it back on. Only the server reads are doubled, with the
// shapes their own suites pin (`seazn-offered.test.ts`: `seaznOfferOf` answers `{ offered }`; the list leaves Seazn out while off).
// prerender, not renderToStaticMarkup: the page is an async server component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const m = vi.hoisted(() => ({
  requirePageAuth: vi.fn(),
  listStreamTargets: vi.fn<() => Promise<unknown[]>>(async () => []),
  seaznOfferOf: vi.fn<(orgId: string) => Promise<{ offered: boolean }>>(async () => ({ offered: true })),
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: async () => true, orgPlanKey: async () => "pro" }));
vi.mock("@/server/page-auth", () => ({ requireOrgPage: m.requirePageAuth }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/base-url", () => ({ baseUrlFromHeaders: async () => "http://app.test" }));
vi.mock("@/server/usecases/stream-targets", () => ({ listStreamTargets: m.listStreamTargets, seaznOfferOf: m.seaznOfferOf }));
vi.mock("@/server/usecases/stream-sessions", () => ({ expireTargetHolders: async () => undefined, defaultDeps: () => ({}) }));
vi.mock("@/components/nav", () => ({ Nav: () => <nav data-testid="nav" /> }));
// The panel's own client dependencies, doubled; the panel and the card are REAL.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/o/riverside/streaming",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => async () => true }));

import StreamingPage from "../page";
import { messages } from "@/lib/messages";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";

const ORG = "org-1";
const render = async (): Promise<string> =>
  new Response((await prerender(await StreamingPage({ params: Promise.resolve({ orgSlug: "riverside" }), searchParams: Promise.resolve({}) }))).prelude).text();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const pasted = {
  id: "t-key", kind: "youtube", label: "Club key", watchUrl: null, createdAt: "2026-10-20T10:00:00.000Z", keyHint: "8hd", inUse: null, youtube: null,
};
const seaznRow = { ...pasted, id: "t-seazn", kind: "seazn", label: "Seazn", keyHint: null };
const owner = { auth: { orgId: ORG, userId: "u-1", role: "owner", via: "session", keyId: null }, org: { id: ORG, name: "Riverside CC", slug: "riverside", role: "owner" }, canEdit: true };
const viewer = { ...owner, auth: { ...owner.auth, userId: "u-2", role: "viewer" }, canEdit: false };

beforeEach(() => {
  vi.stubEnv("SEAZN_HOSTED_LIVE", "true");
  m.requirePageAuth.mockReset().mockResolvedValue(owner);
  m.seaznOfferOf.mockReset();
  m.listStreamTargets.mockReset();
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
});
afterEach(() => {
  setRelayDriversForTest(null);
  vi.unstubAllEnvs();
});

describe("Streaming page + real panel + real card — the switch the page read is the switch on screen", () => {
  it("OFF: the list (as the server sends it while off) has no Seazn row, and the card is there with its switch OFF and the off line — for the org with a key and for the org with nothing (2 checked)", async () => {
    m.seaznOfferOf.mockResolvedValue({ offered: false });
    let checked = 0;
    for (const list of [[pasted], []]) {
      m.listStreamTargets.mockResolvedValue(list);
      const html = await render();
      expect(m.seaznOfferOf).toHaveBeenCalledWith(ORG);
      expect(html).toContain('data-testid="seazn-card"');
      expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
      expect(html).toContain(esc((messages["streaming.seazn.off"] as string).replaceAll("{name}", "Seazn Hosted" /* the owner's brand, 2026-11-23 */)));
      expect(html, "the switch is reachable: an owner's button").toMatch(/<button[^>]*role="switch"/);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("ON: the list's Seazn row is NOT drawn as a row — the card is, with its switch on, above the 'Your own channels' divider and the org's key", async () => {
    m.seaznOfferOf.mockResolvedValue({ offered: true });
    m.listStreamTargets.mockResolvedValue([seaznRow, pasted]);
    const html = await render();
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(html).not.toContain('data-target-id="t-seazn"');
    const card = html.indexOf('data-testid="seazn-card"');
    const divider = html.indexOf('data-testid="stream-own-divider"');
    const key = html.indexOf('data-target-id="t-key"');
    expect([card, divider, key].every((i) => i > -1), "premise: all three on the page").toBe(true);
    expect(card).toBeLessThan(divider);
    expect(divider).toBeLessThan(key);
  });

  it("a viewer sees the card read-only: the state in words, no switch", async () => {
    m.requirePageAuth.mockResolvedValue(viewer);
    m.seaznOfferOf.mockResolvedValue({ offered: false });
    m.listStreamTargets.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain('data-testid="seazn-card"');
    expect(html).not.toContain('role="switch"');
    expect(html).toMatch(new RegExp(`data-testid="seazn-card-state"[^>]*>${messages["streaming.seazn.state.off"]}<`));
  });

  it("LIVE off: no card and no divider, and the switch is never read", async () => {
    vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
    m.listStreamTargets.mockResolvedValue([pasted]);
    const html = await render();
    expect(html).not.toContain('data-testid="seazn-card"');
    expect(html).not.toContain('data-testid="stream-own-divider"');
    expect(html, "premise: the page and its list rendered").toContain('data-target-id="t-key"');
    expect(m.seaznOfferOf).not.toHaveBeenCalled();
  });
});
