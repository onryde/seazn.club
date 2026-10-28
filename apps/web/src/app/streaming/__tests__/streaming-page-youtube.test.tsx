// The Streaming page with its REAL destinations panel (T9): the join between what the connect round trip puts in the URL and what the
// page SHOWS. streaming-page.test.tsx stubs the panel to see what the page hands it; this file does not stub it, so a page that read the
// query into the wrong shape, forgot to pass it, or a panel that ignored it, reds here — a fixture on both ends would prove the fixture
// (AGENTS.md, recurring failure class 1: the inert seam).
//
// The URL values are literals typed from T7's callback (`/streaming?youtube=<code>[&pending=<id>]`); the sentences are read from the
// English dictionary by key. prerender, not renderToStaticMarkup: the page is an async server component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const m = vi.hoisted(() => ({
  hasFeature: vi.fn<(orgId: string, key: string, competitionId?: string) => Promise<boolean>>(),
  requirePageAuth: vi.fn(),
  listStreamTargets: vi.fn<() => Promise<unknown[]>>(async () => []),
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "pro" }));
vi.mock("@/server/page-auth", () => ({ requirePageAuth: m.requirePageAuth }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/base-url", () => ({ baseUrlFromHeaders: async () => "http://app.test" }));
vi.mock("@/server/usecases/stream-targets", () => ({ listStreamTargets: m.listStreamTargets }));
vi.mock("@/server/usecases/stream-sessions", () => ({ expireTargetHolders: async () => undefined, defaultDeps: () => ({}) }));
vi.mock("@/components/nav", () => ({ Nav: () => <nav data-testid="nav" /> }));
// The panel's own client dependencies, doubled; the panel itself is REAL.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/streaming",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => async () => true }));

import StreamingPage from "../page";
import { messages, type MessageKey } from "@/lib/messages";
import { YOUTUBE_LANDING_CODES } from "@/lib/youtube";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";

type Params = { youtube?: string | string[]; pending?: string | string[] };
const ORG = "org-1";
const PENDING = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const render = async (params: Params = {}): Promise<string> =>
  new Response((await prerender(await StreamingPage({ searchParams: Promise.resolve(params) }))).prelude).text();
/** A sentence as the English catalog renders it, HTML-escaped the way React writes it into markup. */
const sentence = (k: MessageKey): string =>
  (messages[k] as string).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const channelRow = {
  id: "t-yt", kind: "youtube", label: "Riverside FC", watchUrl: null, createdAt: "2026-10-20T10:00:00.000Z", keyHint: null, inUse: null,
  youtube: { connectionId: "c-1", channelTitle: "Riverside FC", privacy: "unlisted", madeForKids: false, status: "connected", liveState: "enabled", termsOutdated: false, openBroadcasts: 0 },
};

beforeEach(() => {
  m.requirePageAuth.mockReset().mockResolvedValue({ auth: { orgId: ORG, userId: "u-1", role: "owner", via: "session", keyId: null }, canEdit: true });
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.listStreamTargets.mockReset().mockResolvedValue([]);
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
});
afterEach(() => setRelayDriversForTest(null));

describe("Streaming page + real panel — the connect round trip's landing reaches the screen", () => {
  it("EVERY banner code in the URL shows ITS sentence (ten checked), and only that one", async () => {
    const banners = YOUTUBE_LANDING_CODES.filter((c) => c !== "pick");
    let checked = 0;
    for (const code of banners) {
      const html = await render({ youtube: code });
      expect(html, code).toContain(`data-code="${code}"`);
      expect(html, code).toContain(sentence(`streaming.youtube.landing.${code}` as MessageKey));
      expect(html.match(/data-testid="youtube-landing"/g), `${code}: exactly one banner`).toHaveLength(1);
      expect(html, `${code}: no picker`).not.toContain('data-testid="youtube-picker"');
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("a pick with a pending grant opens the channel picker, for the owner", async () => {
    const html = await render({ youtube: "pick", pending: PENDING });
    expect(html).toContain('data-testid="youtube-picker"');
    expect(html).toContain(sentence("streaming.youtube.picker.title"));
    expect(html, "a pick is not a banner").not.toContain('data-testid="youtube-landing"');
  });

  it("a pick with no usable pending grant reads as an expired request — never an empty picker", async () => {
    let checked = 0;
    for (const params of [{ youtube: "pick" }, { youtube: "pick", pending: "not-a-uuid" }, { youtube: "pick", pending: "" }]) {
      const html = await render(params);
      expect(html, JSON.stringify(params)).toContain('data-code="expired"');
      expect(html, JSON.stringify(params)).not.toContain('data-testid="youtube-picker"');
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("no outcome, or one that is not ours, shows nothing — the page is the plain Streaming page", async () => {
    let checked = 0;
    for (const params of [{}, { youtube: "<script>alert(1)</script>" }, { youtube: "" }, { pending: PENDING }]) {
      const html = await render(params);
      expect(html, JSON.stringify(params)).not.toContain('data-testid="youtube-landing"');
      expect(html, JSON.stringify(params)).not.toContain('data-testid="youtube-picker"');
      expect(html, JSON.stringify(params)).toContain('data-testid="stream-destinations"');
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a viewer is told the outcome but is never handed the picker or a way to connect", async () => {
    m.requirePageAuth.mockResolvedValue({ auth: { orgId: ORG, userId: "u-2", role: "viewer", via: "session", keyId: null }, canEdit: false });
    expect(await render({ youtube: "connected" })).toContain('data-code="connected"');
    const pick = await render({ youtube: "pick", pending: PENDING });
    expect(pick).not.toContain('data-testid="youtube-picker"');
    const plain = await render();
    for (const id of ["youtube-connect", "youtube-connect-empty", "stream-dest-add", "stream-dest-empty-add"]) expect(plain, id).not.toContain(`data-testid="${id}"`);
  });
});

describe("Streaming page + real panel — Connect YouTube is on the page", () => {
  it("the owner of an org with no destinations is offered Connect YouTube beside Add destination", async () => {
    const html = await render();
    expect(html).toContain('data-testid="youtube-connect-empty"');
    expect(html).toContain('data-testid="stream-dest-empty-add"');
    expect(html).toContain(sentence("streaming.youtube.connect"));
  });

  it("with destinations the owner is offered it at the top, and a connected channel lists as a channel row (the real list, the real panel)", async () => {
    m.listStreamTargets.mockResolvedValue([channelRow]);
    const html = await render();
    expect(html).toContain('data-testid="youtube-connect"');
    expect(html).toContain('data-testid="youtube-channel-row"');
    expect(html).toContain("Riverside FC");
    expect(html).not.toContain('data-testid="stream-dest-row"');
  });
});
