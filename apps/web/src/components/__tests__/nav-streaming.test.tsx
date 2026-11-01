// The console nav's Streaming item (owner, 2026-10-27: Streaming is its own top-nav page, between Directory and Settings).
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
// Client islands → nothing (they are not what this file is about) — except the REAL Sign-out button, which the gantry-budget tests
// below read in the nav's own markup (its router hook is the only thing it needs).
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
  it("OFFERED: a link to /streaming, labelled, between Directory and Settings — the label hidden under md like its siblings, the aria-label always there", async () => {
    const html = await render();
    const a = streamingLink(html);
    expect(a, "the Streaming link is in the nav").not.toBeNull();
    expect(a).toContain('href="/streaming"');
    expect(a).toContain('aria-label="Streaming"');
    const at = (needle: string) => html.indexOf(needle);
    expect(at('href="/directory"')).toBeGreaterThan(-1);
    expect(at('href="/directory"'), "after Directory").toBeLessThan(at('data-testid="nav-streaming"'));
    expect(at('data-testid="nav-streaming"'), "before Settings").toBeLessThan(at('href="/o/riverside/settings"'));
    // The label collapses to the icon below `md`, exactly like Dashboard / Directory / Sponsors (the dual-role case uses `lg`). Settings is
    // its icon alone at every width (owner 2026-11-01), so the org nav's labelled links are four again and main's rung holds.
    const label = html.slice(at('data-testid="nav-streaming"')).match(/<span class="([^"]*)">Streaming<\/span>/);
    expect(label?.[1]).toBe("hidden md:inline");
  });

  it("the label follows the dual-role rule too: a claimed player keeps `lg`, as every other label does", async () => {
    m.hasClaimedProfile.mockResolvedValue(true);
    const html = await render();
    const label = html.slice(html.indexOf('data-testid="nav-streaming"')).match(/<span class="([^"]*)">Streaming<\/span>/);
    expect(label?.[1]).toBe("hidden lg:inline");
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
      expect(html, `${why}: Settings stays`).toContain('href="/o/riverside/settings"');
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

// The gantry's width budget (T9 fix round 2, owner chose "tighten", 2026-10-28). Five items did not fit: Sign-out was pushed past the
// viewport at 320-335 (every locale), at fr 768-836 and nl 768, and with a claimed player at 350-389. What a unit test CAN pin is the
// markup that makes the measured budget true; that the budget really fits is measured in a browser at every width x locale x both
// navs (the report's table) and by the shots spec's gantry-fit test.
describe("Nav › the width budget", () => {
  const tokens = (cls: string | undefined): string[] => (cls ?? "").split(/\s+/).filter(Boolean);
  /** The class TOKENS of every nav link's own class attribute, in order (the <a>s inside <nav>). */
  const linkClasses = (html: string): string[][] => {
    const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...nav.matchAll(/<a\b[^>]*\bclass="([^"]*)"/g)].map((x) => tokens(x[1]));
  };
  /** Each nav link's OWN label-span class tokens, in order, or null for a link with no label (Settings, owner 2026-11-01). Parsed per
   *  `<a>…</a>`, so a link without a span can never borrow the next link's. */
  const labelClasses = (html: string): (string[] | null)[] => {
    const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((x) => {
      const cls = x[1]!.match(/<span class="([^"]*)">/)?.[1];
      return cls === undefined ? null : tokens(cls);
    });
  };
  /** The index of the Settings link in the nav (the one link with no label). */
  const settingsIndex = (html: string): number => {
    const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    return [...nav.matchAll(/<a\b([^>]*)>/g)].findIndex((x) => /\bdata-testid="nav-settings"/.test(x[1]!));
  };
  /** The Sign-out button as the NAV renders it: its attributes and its label span's classes. */
  const signOut = (html: string) => {
    const b = html.match(/<button\b([^>]*)>([\s\S]*?)<\/button>/);
    return {
      found: b !== null,
      inner: b?.[2] ?? "",
      aria: b?.[1]?.match(/\baria-label="([^"]*)"/)?.[1],
      title: b?.[1]?.match(/\btitle="([^"]*)"/)?.[1],
      labelClass: tokens(b?.[2]?.match(/<span class="([^"]*)">/)?.[1]),
      labelText: b?.[2]?.match(/<span class="[^"]*">([^<]*)<\/span>/)?.[1],
    };
  };
  const dicts = { en: dictEn, es: dictEs, fr: dictFr, nl: dictNl } as Record<string, Record<string, string>>;

  it("Sign-out is its ICON alone at every width (owner 2026-11-01): no label span at all, named by aria-label with the same words as its title tooltip, in all four locales", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const expected = dicts[locale]!["nav.signOut"];
      expect(typeof expected, locale).toBe("string");
      const so = signOut(await render());
      expect(so.found, `${locale}: the gantry renders its Sign-out button`).toBe(true);
      expect(so.labelClass, `${locale}: no label span, hidden or shown, at any width`).toEqual([]);
      expect(so.labelText, `${locale}: no painted words`).toBeUndefined();
      expect(so.inner, `${locale}: the words appear nowhere inside the button`).not.toContain(expected!);
      expect(so.aria, `${locale}: the icon-only button is still named`).toBe(expected);
      expect(so.title, `${locale}: and the tooltip says the same`).toBe(expected);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the ACCESSIBLE NAME of Sign-out is a translation, not English: es/fr/nl differ from en", async () => {
    const names = new Set<string>();
    for (const locale of LOCALES) {
      m.locale.value = locale;
      names.add(signOut(await render()).aria ?? "");
    }
    expect(names.size, "four distinct names").toBe(4);
    expect(names.has(""), "none missing").toBe(false);
  });

  /** The org shapes the bar takes: Streaming offered or not x a claimed player or not (the Sponsors link, R4 S11, is in all of them). */
  const SHAPES = [
    { streaming: false, claimed: false, links: 4 },
    { streaming: true, claimed: false, links: 5 },
    { streaming: false, claimed: true, links: 5 },
    { streaming: true, claimed: true, links: 6 },
  ] as const;
  async function renderShape(shape: { streaming: boolean; claimed: boolean }): Promise<string> {
    m.hasFeature.mockReset().mockResolvedValue(true);
    setRelayDriversForTest(shape.streaming ? { ingest: new FakeIngest(), runner: new FakeRunner() } : disabledRelayDrivers());
    m.hasClaimedProfile.mockResolvedValue(shape.claimed);
    return render();
  }

  it("phones: every nav link takes 6px of side padding (px-1.5) until sm, and the links touch (gap-0) until sm — all four org shapes, 4 + 5 + 5 + 6 = twenty links checked", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const html = await renderShape(shape);
      const links = linkClasses(html);
      expect(links.length, `${JSON.stringify(shape)}: Dashboard, Directory, Sponsors, Settings + Streaming / Player home where they apply`).toBe(shape.links);
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
    expect(checked, "anti-vacuity: twenty links looked at").toBe(20);
  });

  it("md..lg: where the labels are ON (the org nav) the labelled links take 4px of side padding (md:px-1) and get 12px back at lg (lg:px-3), so the org chip keeps room for the club name; the dual-role nav is icon-only at md, keeps its 12px and has no md override", async () => {
    // B3 (CI e2e: the chip showed 37px of a 38-character club name at 768, 8 characters needing 64). Measured in a browser: 8px and 6px
    // leave fr/nl at 768 short of 8 characters, 4px clears every width x locale cell (the report's table). Settings has no label (owner
    // 2026-11-01) and its own padding rule (nav-sponsors.test.tsx); it is skipped here BY INDEX and counted, never silently.
    let checked = 0;
    let labelsOnAtMd = 0;
    let settingsSkipped = 0;
    for (const shape of SHAPES) {
      const html = await renderShape(shape);
      const links = linkClasses(html);
      const labels = labelClasses(html);
      expect(links.length, JSON.stringify(shape)).toBe(labels.length);
      const skip = settingsIndex(html);
      expect(skip, `${JSON.stringify(shape)}: the Settings link is found`).toBeGreaterThan(-1);
      for (let i = 0; i < links.length; i++) {
        const l = links[i]!;
        if (i === skip) { expect(labels[i], "Settings has no label").toBeNull(); settingsSkipped++; continue; }
        expect(labels[i], `${JSON.stringify(shape)} link ${i}: every other link is labelled`).not.toBeNull();
        if (labels[i]!.includes("md:inline")) {
          labelsOnAtMd++;
          expect(l, `link ${i}: labels on at md, so tight padding there`).toContain("md:px-1");
          expect(l, `link ${i}: 12px returns at lg`).toContain("lg:px-3");
          // Not the 8px / 6px that measurement showed too wide for fr and nl at 768.
          expect(l, `link ${i}: not md:px-2`).not.toContain("md:px-2");
          expect(l, `link ${i}: not md:px-1.5`).not.toContain("md:px-1.5");
        } else {
          expect(l.filter((t) => /^md:px-/.test(t)), `${JSON.stringify(shape)} link ${i}: icon-only at md, no padding override`).toEqual([]);
          expect(l, `link ${i}: keeps sm:px-3`).toContain("sm:px-3");
        }
        checked++;
      }
    }
    expect(checked, "anti-vacuity: sixteen labelled links looked at (twenty links less the four Settings icons)").toBe(16);
    expect(settingsSkipped, "anti-vacuity: one Settings icon per shape, skipped by name").toBe(SHAPES.length);
    expect(labelsOnAtMd, "anti-vacuity: the md branch ran - the labelled links of the two org-nav shapes (3 + 4)").toBe(7);
  });

  it("tablets KEEP their labels (owner 2026-10-28): md..lg shows every label of the org nav, and the dual-role nav's wait for lg - Settings, its icon alone, has none to show (owner 2026-11-01)", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const html = await renderShape(shape);
      const labels = labelClasses(html);
      expect(labels.length, JSON.stringify(shape)).toBe(shape.links);
      const skip = settingsIndex(html);
      labels.forEach((l, i) => {
        if (i === skip) expect(l, `${JSON.stringify(shape)}: Settings`).toBeNull();
        else expect(l, JSON.stringify(shape)).toEqual(["hidden", shape.claimed ? "lg:inline" : "md:inline"]);
      });
      checked++;
    }
    expect(checked).toBe(4);
  });
});
