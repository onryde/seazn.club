// The console nav's Streaming item (owner, 2026-10-27: Streaming is its own top-nav page, after Directory; Sponsors follows it).
//
// It is shown to exactly the orgs the page exists for — `streamingPageOffered`, the ONE predicate the page, the nav and the connect
// start ask — evaluated for the org the chrome is showing. Run through the REAL predicate (real `relayOffer`, real relay drivers),
// so a nav that read a different question would disagree with the page and be caught here. What a unit test cannot see — whether
// five items FIT the gantry at 640-1023 and on a 320 phone — is measured in a browser, not here (see the report / mobile.spec).
//
// prerender, not renderToStaticMarkup: Nav is an async server component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const m = vi.hoisted(() => ({
  hasFeature: vi.fn<(orgId: string, key: string, competitionId?: string) => Promise<boolean>>(),
  getCurrentUser: vi.fn(),
  getUserOrgs: vi.fn(),
  getActiveOrgId: vi.fn(),
  hasClaimedProfile: vi.fn(async () => false),
  captureError: vi.fn(),
  locale: { value: "en" as string },
  hasLiveConnection: vi.fn<(orgId: string) => Promise<boolean>>(),
}));

vi.mock("@/lib/entitlements", () => ({ hasFeature: m.hasFeature, orgPlanKey: async () => "pro" }));
vi.mock("@/lib/sentry", () => ({ captureError: m.captureError }));
// The one DB read the disconnect-only page adds (an org that can no longer go live but still holds a YouTube connection): doubled, so the
// real predicate (`streamingPageAccess`, real `relayOffer`, real relay drivers) runs over it. The real query is route-tested with the DB.
vi.mock("@/server/youtube/connections", () => ({ hasLiveConnection: m.hasLiveConnection }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: m.getCurrentUser, getUserOrgs: m.getUserOrgs, getActiveOrgId: m.getActiveOrgId }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => m.locale.value }));
vi.mock("@/server/usecases/me", () => ({ hasClaimedProfile: m.hasClaimedProfile }));
vi.mock("@/lib/activation", () => ({ needsTourAfterOnboarding: async () => false }));
vi.mock("@/server/usecases/competitions", () => ({ hasAnyCompetitions: async () => false }));
// Client islands → nothing (they are not what this file is about) — except the REAL account trigger, which the gantry-budget tests
// below read in the nav's own markup (its router and pathname hooks are the only things it needs).
vi.mock("@/components/help-menu", () => ({ HelpMenu: () => null }));
vi.mock("@/components/product-tour", () => ({ ProductTour: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/streaming" }));

import { Nav } from "../nav";
import { LOCALES } from "@/lib/i18n-constants";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import dictEn from "@/dictionaries/en/console.json";
import dictEs from "@/dictionaries/es/console.json";
import dictFr from "@/dictionaries/fr/console.json";
import dictNl from "@/dictionaries/nl/console.json";

const ORG = { id: "org-active", name: "Riverside BC", slug: "riverside", role: "owner", logo_storage_path: null, logo_url: null };
const render = async (): Promise<string> => new Response((await prerender(await Nav())).prelude).text();
/** The nav item's anchor, or null. Anchored on `data-testid="nav-streaming"` and its `="` so an omitted prop cannot satisfy it. */
const streamingLink = (html: string): string | null => html.match(/<a[^>]*data-testid="nav-streaming"[^>]*>/)?.[0] ?? null;

beforeEach(() => {
  m.locale.value = "en";
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.getCurrentUser.mockReset().mockResolvedValue({ id: "u-1", display_name: "Alex" });
  m.getUserOrgs.mockReset().mockResolvedValue([ORG]);
  m.getActiveOrgId.mockReset().mockResolvedValue(ORG.id);
  m.hasClaimedProfile.mockReset().mockResolvedValue(false);
  m.captureError.mockClear();
  m.hasLiveConnection.mockReset().mockResolvedValue(false);
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });   // a deployment that can start a stream
});
afterEach(() => setRelayDriversForTest(null));

describe("Nav › Streaming item", () => {
  it("OFFERED: a link to /streaming, labelled, between Directory and Sponsors — the label hidden under md like its siblings, the aria-label always there", async () => {
    const html = await render();
    const a = streamingLink(html);
    expect(a, "the Streaming link is in the nav").not.toBeNull();
    expect(a).toContain('href="/streaming"');
    expect(a).toContain('aria-label="Streaming"');
    const at = (needle: string) => html.indexOf(needle);
    expect(at('href="/directory"')).toBeGreaterThan(-1);
    expect(at('href="/directory"'), "after Directory").toBeLessThan(at('data-testid="nav-streaming"'));
    expect(at('data-testid="nav-streaming"'), "before Sponsors").toBeLessThan(at('data-testid="nav-sponsors"'));
    // The label collapses to the icon below `md`, exactly like Dashboard / Directory / Sponsors - for every bar (the account menu,
    // 2026-11-11, took Player home out of the bar, and with it the dual-role `lg` rung).
    const label = html.slice(at('data-testid="nav-streaming"')).match(/<span class="([^"]*)">Streaming<\/span>/);
    expect(label?.[1]).toBe("hidden md:inline");
  });

  it("a claimed player's bar is the same bar: the label comes on at `md` too (Player home is in the account menu now)", async () => {
    m.hasClaimedProfile.mockResolvedValue(true);
    const html = await render();
    const label = html.slice(html.indexOf('data-testid="nav-streaming"')).match(/<span class="([^"]*)">Streaming<\/span>/);
    expect(label?.[1]).toBe("hidden md:inline");
  });

  it("asks the predicate for the org the chrome is SHOWING (both streaming keys, org-wide), not some other org", async () => {
    await render();
    expect(m.hasFeature.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [ORG.id, "streaming.overlay", undefined], [ORG.id, "streaming.relay", undefined],
    ]);
  });

  it("NOT offered, for each of the three reasons the page would 404: no link — and the rest of the nav stays (a link that vanished with the whole nav would pass otherwise)", async () => {
    const reasons: [string, () => void][] = [
      ["streaming.overlay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.overlay")],
      ["streaming.relay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay")],
      ["the deployment cannot start a stream", () => setRelayDriversForTest(disabledRelayDrivers())],
    ];
    let checked = 0;
    for (const [why, apply] of reasons) {
      m.hasFeature.mockReset().mockResolvedValue(true);
      setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
      apply();
      const html = await render();
      expect(streamingLink(html), why).toBeNull();
      expect(html, `${why}: Directory stays`).toContain('href="/directory"');
      expect(html, `${why}: the account trigger stays`).toContain('data-testid="account-menu-trigger"');
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("OFFERED: the connection question is never asked (the whole page is there; a second read would be waste)", async () => {
    expect(streamingLink(await render())).not.toBeNull();
    expect(m.hasLiveConnection).not.toHaveBeenCalled();
  });

  it("a failed entitlement read hides the item, reports once, and does NOT take the chrome down", async () => {
    const boom = new Error("db down");
    m.hasFeature.mockRejectedValue(boom);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(html, "the rest of the nav rendered").toContain('href="/directory"');
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError).toHaveBeenCalledWith(boom, expect.objectContaining({ orgId: ORG.id, route: "nav.streaming_offered" }));
    // The next render, with the read healthy again, offers it: nothing was cached from the failure.
    m.hasFeature.mockReset().mockResolvedValue(true);
    expect(streamingLink(await render())).not.toBeNull();
  });

  it("signed out: no link, and nothing about streaming is read", async () => {
    m.getCurrentUser.mockResolvedValue(null);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(m.hasFeature).not.toHaveBeenCalled();
  });

  it("signed in with no organisation yet: no link, and nothing is read for an org that does not exist", async () => {
    m.getUserOrgs.mockResolvedValue([]);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(m.hasFeature).not.toHaveBeenCalled();
  });

  it("every locale has its own label (no English fallback leaking into es/fr/nl), and the rendered link carries it", async () => {
    const dicts = { en: dictEn, es: dictEs, fr: dictFr, nl: dictNl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const label = dicts[locale]!["nav.streaming"];
      expect(typeof label, locale).toBe("string");
      expect(label!.length, locale).toBeGreaterThan(0);
      const a = streamingLink(await render());
      expect(a, locale).toContain(`aria-label="${label}"`);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});

describe("Nav › Streaming item for an org that can no longer go live (T18: Disconnect stays reachable)", () => {
  const reasons: [string, () => void][] = [
    ["streaming.overlay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.overlay")],
    ["streaming.relay switched off", () => m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay")],
    ["the deployment cannot start a stream", () => setRelayDriversForTest(disabledRelayDrivers())],
  ];
  const asRole = (role: string) => m.getUserOrgs.mockResolvedValue([{ ...ORG, role }]);

  it("an editor whose org holds a YouTube connection keeps the link, for each of the three reasons the whole page is gone - and the question is asked for the org the chrome shows", async () => {
    let checked = 0;
    for (const [why, apply] of reasons) {
      m.hasLiveConnection.mockClear().mockResolvedValue(true);
      m.hasFeature.mockReset().mockResolvedValue(true);
      setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
      apply();
      const a = streamingLink(await render());
      expect(a, why).not.toBeNull();
      expect(a, why).toContain('href="/streaming"');
      expect(m.hasLiveConnection, why).toHaveBeenCalledTimes(1);
      expect(m.hasLiveConnection, why).toHaveBeenCalledWith(ORG.id);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an owner AND an admin get it; a viewer, a scorer and any other role do not - and for them the connection is never even looked up", async () => {
    m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay");
    m.hasLiveConnection.mockResolvedValue(true);
    const seen: Record<string, boolean> = {};
    for (const role of ["owner", "admin", "viewer", "scorer", "member"]) {
      m.hasLiveConnection.mockClear();
      asRole(role);
      seen[role] = streamingLink(await render()) !== null;
      if (role === "owner" || role === "admin") expect(m.hasLiveConnection, role).toHaveBeenCalledTimes(1);
      else expect(m.hasLiveConnection, role).not.toHaveBeenCalled();
    }
    expect(seen).toEqual({ owner: true, admin: true, viewer: false, scorer: false, member: false });
  });

  it("an editor with NO connection gets no link (the empty case - the page would be a 404), then does once a connection exists (the sequence)", async () => {
    m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay");
    m.hasLiveConnection.mockResolvedValue(false);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(html, "the rest of the nav stays").toContain('href="/directory"');
    m.hasLiveConnection.mockResolvedValue(true);
    expect(streamingLink(await render())).not.toBeNull();
  });

  it("a failed connection read hides the item, reports once under the nav's own route, and does not take the chrome down", async () => {
    m.hasFeature.mockImplementation(async (_o, key) => key !== "streaming.relay");
    const boom = new Error("db down");
    m.hasLiveConnection.mockRejectedValue(boom);
    const html = await render();
    expect(streamingLink(html)).toBeNull();
    expect(html).toContain('href="/directory"');
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(m.captureError).toHaveBeenCalledWith(boom, expect.objectContaining({ orgId: ORG.id, route: "nav.streaming_offered" }));
  });
});

// The gantry's width budget (T9 fix round 2, owner chose "tighten", 2026-10-28; the account menu, 2026-11-11). What a unit test CAN
// pin is the markup that makes the measured budget true; that the budget really fits is measured in a browser at every width x
// locale x org shape (the shots spec's gantry-fit test, nav-org-chip-overflow, mobile).
describe("Nav › the width budget", () => {
  const tokens = (cls: string | undefined): string[] => (cls ?? "").split(/\s+/).filter(Boolean);
  /** The class TOKENS of every nav link's own class attribute, in order (the <a>s inside <nav>). */
  const linkClasses = (html: string): string[][] => {
    const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...nav.matchAll(/<a\b[^>]*\bclass="([^"]*)"/g)].map((x) => tokens(x[1]));
  };
  /** Each nav link's OWN label-span class tokens, in order, or null for a link with no label. Parsed per `<a>…</a>`, so a link
   *  without a span can never borrow the next link's. */
  const labelClasses = (html: string): (string[] | null)[] => {
    const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((x) => {
      const cls = x[1]!.match(/<span class="([^"]*)">/)?.[1];
      return cls === undefined ? null : tokens(cls);
    });
  };
  /** The account trigger as the NAV renders it. */
  const trigger = (html: string) => {
    const b = html.match(/<button\b([^>]*\bdata-testid="account-menu-trigger"[^>]*)>([\s\S]*?)<\/button>/);
    return { found: b !== null, aria: b?.[1]?.match(/\baria-label="([^"]*)"/)?.[1], cls: tokens(b?.[1]?.match(/\bclass="([^"]*)"/)?.[1]) };
  };
  const dicts = { en: dictEn, es: dictEs, fr: dictFr, nl: dictNl } as Record<string, Record<string, string>>;

  it("the bar ends in the account trigger, named in each locale's words - and no Sign-out button is left in the bar (4 locales)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const expected = dicts[locale]!["nav.account.menu"];
      expect(typeof expected, locale).toBe("string");
      const html = await render();
      const tr = trigger(html);
      expect(tr.found, `${locale}: the gantry renders its account trigger`).toBe(true);
      expect(tr.aria, `${locale}: named by the translated label`).toBe(expected);
      expect(html, `${locale}: Sign out lives in the menu, not the bar`).not.toContain(`aria-label="${dicts[locale]!["nav.signOut"]}"`);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the ACCESSIBLE NAME of the trigger is a translation, not English: es/fr/nl differ from en", async () => {
    const names = new Set<string>();
    for (const locale of LOCALES) {
      m.locale.value = locale;
      names.add(trigger(await render()).aria ?? "");
    }
    expect(names.size, "four distinct names").toBe(4);
    expect(names.has(""), "none missing").toBe(false);
  });

  /** The org shapes the bar takes: Streaming offered or not x a claimed player or not (the Sponsors link, R4 S11, is in all of
   *  them; a claimed player adds nothing since the account menu took Player home). */
  const SHAPES = [
    { streaming: false, claimed: false, links: 3 },
    { streaming: true, claimed: false, links: 4 },
    { streaming: false, claimed: true, links: 3 },
    { streaming: true, claimed: true, links: 4 },
  ] as const;
  async function renderShape(shape: { streaming: boolean; claimed: boolean }): Promise<string> {
    m.hasFeature.mockReset().mockResolvedValue(true);
    setRelayDriversForTest(shape.streaming ? { ingest: new FakeIngest(), runner: new FakeRunner() } : disabledRelayDrivers());
    m.hasClaimedProfile.mockResolvedValue(shape.claimed);
    return render();
  }

  it("phones: every nav link takes 6px of side padding (px-1.5) until sm, and the links touch (gap-0) until sm — all four org shapes, 3 + 4 + 3 + 4 = fourteen links checked", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const html = await renderShape(shape);
      const links = linkClasses(html);
      expect(links.length, `${JSON.stringify(shape)}: Dashboard, Directory, Sponsors + Streaming where it applies`).toBe(shape.links);
      for (const l of links) {
        expect(l, "tightened on phones").toContain("px-1.5");
        expect(l, "not the old 8px").not.toContain("px-2");
        expect(l, "sm and up is untouched").toContain("sm:px-3");
        checked++;
      }
      const navTokens = tokens(html.match(/<nav class="([^"]*)">/)?.[1]);
      expect(navTokens, "no gap on phones").toContain("gap-0");
      expect(navTokens, "the old 2px gap returns at sm").toContain("sm:gap-0.5");
      expect(navTokens, "the bare old gap is gone").not.toContain("gap-0.5");
    }
    expect(checked, "anti-vacuity: fourteen links looked at").toBe(14);
  });

  it("md..lg: with the labels ON (every bar, from md) the labelled links take 4px of side padding (md:px-1) and get 12px back at lg (lg:px-3), so the org chip keeps room for the club name", async () => {
    // B3 (CI e2e: the chip showed 37px of a 38-character club name at 768, 8 characters needing 64). Measured in a browser: 8px and 6px
    // leave fr/nl at 768 short of 8 characters, 4px clears every width x locale cell (the report's table).
    let checked = 0;
    for (const shape of SHAPES) {
      const html = await renderShape(shape);
      const links = linkClasses(html);
      const labels = labelClasses(html);
      expect(links.length, JSON.stringify(shape)).toBe(labels.length);
      for (let i = 0; i < links.length; i++) {
        const l = links[i]!;
        expect(labels[i], `${JSON.stringify(shape)} link ${i}: every link is labelled, from md`).toEqual(["hidden", "md:inline"]);
        expect(l, `link ${i}: labels on at md, so tight padding there`).toContain("md:px-1");
        expect(l, `link ${i}: 12px returns at lg`).toContain("lg:px-3");
        // Not the 8px / 6px that measurement showed too wide for fr and nl at 768.
        expect(l, `link ${i}: not md:px-2`).not.toContain("md:px-2");
        expect(l, `link ${i}: not md:px-1.5`).not.toContain("md:px-1.5");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: fourteen labelled links looked at").toBe(14);
  });

  it("the trigger is one 32px box like every gantry control (min-h-8), the avatar alone below lg and a bordered pill from lg", async () => {
    const tr = trigger(await render());
    expect(tr.cls).toContain("min-h-8");
    expect(tr.cls, "a pill only where the name shows").toContain("lg:border");
    expect(tr.cls.filter((t) => /^(sm|md):border/.test(t)), "no border below lg").toEqual([]);
  });
});
