// The console nav's Sponsors item (R4 sponsors-on-stream S11; OWNER RULING §6.1 "a", 2026-10-31): Sponsors is a top-bar
// icon that is `hidden min-[350px]:flex`, and the org Dashboard carries a Sponsors entry at every width. If the bar
// overflows, Player home folds first.
//
// What a unit test CAN pin is the markup that makes the width budget true: which links are in the bar at which width,
// and the label rung each link count gets. That the budget really fits is measured in a browser at every width x
// locale x org shape: `youtube-streaming.shots.spec.ts` (the gantry-fit probes, the 350 width and the six-link org) and
// `mobile.spec.ts` (the seven width projects). See the S11 report for the arithmetic.
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
vi.mock("@/server/youtube/connections", () => ({ hasLiveConnection: m.hasLiveConnection }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: m.getCurrentUser, getUserOrgs: m.getUserOrgs, getActiveOrgId: m.getActiveOrgId }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => m.locale.value }));
vi.mock("@/server/usecases/me", () => ({ hasClaimedProfile: m.hasClaimedProfile }));
vi.mock("@/lib/activation", () => ({ needsTourAfterOnboarding: async () => false }));
vi.mock("@/server/usecases/competitions", () => ({ hasAnyCompetitions: async () => false }));
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
const tokens = (cls: string | undefined): string[] => (cls ?? "").split(/\s+/).filter(Boolean);

interface NavLink { href: string; testid: string; aria: string; cls: string; label: string }
/** Every link inside the gantry's <nav>, in document order. */
function navLinks(html: string): NavLink[] {
  const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  return [...nav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((x) => ({
    href: x[1]!.match(/\bhref="([^"]*)"/)?.[1] ?? "",
    testid: x[1]!.match(/\bdata-testid="([^"]*)"/)?.[1] ?? "",
    aria: x[1]!.match(/\baria-label="([^"]*)"/)?.[1] ?? "",
    cls: x[1]!.match(/\bclass="([^"]*)"/)?.[1] ?? "",
    label: x[2]!.match(/<span class="([^"]*)">/)?.[1] ?? "",
  }));
}
const sponsorsLink = (html: string): NavLink | undefined => navLinks(html).find((l) => l.testid === "nav-sponsors");

/** The org shapes the bar can take: streaming offered or not x a claimed player or not. */
const SHAPES = [
  { streaming: false, player: false },
  { streaming: true, player: false },
  { streaming: false, player: true },
  { streaming: true, player: true },
] as const;
async function renderShape(s: { streaming: boolean; player: boolean }): Promise<string> {
  m.hasFeature.mockReset().mockResolvedValue(true);
  setRelayDriversForTest(s.streaming ? { ingest: new FakeIngest(), runner: new FakeRunner() } : disabledRelayDrivers());
  m.hasClaimedProfile.mockResolvedValue(s.player);
  return render();
}

beforeEach(() => {
  m.locale.value = "en";
  m.hasFeature.mockReset().mockResolvedValue(true);
  m.getCurrentUser.mockReset().mockResolvedValue({ id: "u-1", display_name: "Alex" });
  m.getUserOrgs.mockReset().mockResolvedValue([ORG]);
  m.getActiveOrgId.mockReset().mockResolvedValue(ORG.id);
  m.hasClaimedProfile.mockReset().mockResolvedValue(false);
  m.captureError.mockClear();
  m.hasLiveConnection.mockReset().mockResolvedValue(false);
  setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
});
afterEach(() => setRelayDriversForTest(null));

describe("Nav > Sponsors item", () => {
  it("is a link to the org's Sponsors hub, named, between Directory/Streaming and Settings", async () => {
    const html = await render();
    const a = sponsorsLink(html);
    expect(a, "the Sponsors link is in the nav").toBeDefined();
    expect(a!.href).toBe("/o/riverside/sponsors");
    expect(a!.aria).toBe("Sponsors");
    const order = navLinks(html).map((l) => l.href);
    expect(order).toEqual(["/o/riverside", "/directory", "/streaming", "/o/riverside/sponsors", "/o/riverside/settings"]);
  });

  it("without Streaming the order is Dashboard, Directory, Sponsors, Settings", async () => {
    const order = navLinks(await renderShape({ streaming: false, player: false })).map((l) => l.href);
    expect(order).toEqual(["/o/riverside", "/directory", "/o/riverside/sponsors", "/o/riverside/settings"]);
  });

  it("the class is `hidden min-[350px]:flex` (the Player-home precedent): hidden under 350, flex from 350 - and NO bare `flex` to fight it", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const cls = sponsorsLink(await renderShape(shape))!.cls;
      const toks = tokens(cls);
      // Anchored on whole tokens: `/\bmd:hidden\b/` also matches inside `max-md:hidden`, and `flex` matches inside `min-[350px]:flex`.
      expect(cls, JSON.stringify(shape)).toMatch(/(?:^|\s)hidden\s+min-\[350px\]:flex(?:\s|$)/);
      expect(toks, "hidden is a bare token").toContain("hidden");
      expect(toks, "flex only from 350").toContain("min-[350px]:flex");
      expect(toks, "a bare `flex` would win or lose the cascade against `hidden` by CSS order").not.toContain("flex");
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  });

  it("every other link is shown at every width, and a plain org (3 default links + Sponsors) has exactly one link that is hidden below 350", async () => {
    const links = navLinks(await renderShape({ streaming: false, player: false }));
    expect(links.length).toBe(4);
    const hiddenBelow350 = links.filter((l) => tokens(l.cls).includes("hidden"));
    expect(hiddenBelow350.map((l) => l.testid)).toEqual(["nav-sponsors"]);
    for (const l of links.filter((x) => x.testid !== "nav-sponsors")) expect(tokens(l.cls), l.href).toContain("flex");
  });

  it("every role that has a member nav gets it (owner, admin, viewer, scorer) - the hub's own gate decides what they see", async () => {
    let checked = 0;
    for (const role of ["owner", "admin", "viewer", "scorer"]) {
      m.getUserOrgs.mockResolvedValue([{ ...ORG, role }]);
      expect(sponsorsLink(await render()), role).toBeDefined();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("asks nothing of the entitlement resolver for itself (Streaming's two keys are the only reads)", async () => {
    await render();
    expect(m.hasFeature.mock.calls.map((c) => c[1]).sort()).toEqual(["streaming.overlay", "streaming.relay"]);
  });

  it("signed out: no link", async () => {
    m.getCurrentUser.mockResolvedValue(null);
    expect(sponsorsLink(await render())).toBeUndefined();
  });

  it("signed in with no organisation yet: no link (there is no hub to open), while the rest of the nav stays", async () => {
    m.getUserOrgs.mockResolvedValue([]);
    const html = await render();
    expect(sponsorsLink(html)).toBeUndefined();
    expect(navLinks(html).map((l) => l.href)).toEqual(["/orgs/new", "/directory", "/orgs/new"]);
  });

  it("every locale has its own label (no English fallback leaking into es/fr/nl) and the rendered link carries it", async () => {
    const dicts = { en: dictEn, es: dictEs, fr: dictFr, nl: dictNl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const label = dicts[locale]!["nav.sponsors"];
      expect(typeof label, locale).toBe("string");
      expect(label!.length, locale).toBeGreaterThan(0);
      expect(sponsorsLink(await render())!.aria, locale).toBe(label);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    // The accessible name is a translation where the language has its own word for it.
    expect(dictEs["nav.sponsors"]).not.toBe(dictEn["nav.sponsors"]);
  });
});

describe("Nav > the label rung follows the link count (owner: md for four links, lg for five; six wait for xl)", () => {
  // The rule's literal, from the owner's 2026-10-28 "tighten" ruling (nav.tsx): four links keep labels at md, five wait
  // for lg. Six is the same rule one rung up: measured, six labelled links overflow the gantry at 1024-1100 (es, fr, nl).
  const rungFor = (count: number): string => (count <= 4 ? "md" : count === 5 ? "lg" : "xl");

  it("each org shape gets the rung its OWN rendered link count asks for - all four shapes (counted), all links the same rung", async () => {
    let checked = 0;
    const counts = new Set<number>();
    for (const shape of SHAPES) {
      const links = navLinks(await renderShape(shape));
      const expected = `hidden ${rungFor(links.length)}:inline`;
      for (const l of links) expect(l.label, `${JSON.stringify(shape)} ${l.href}`).toBe(expected);
      counts.add(links.length);
      checked++;
    }
    expect(checked).toBe(4);
    // Anti-vacuity: the four shapes really span three different link counts, so all three rungs were exercised.
    expect([...counts].sort()).toEqual([4, 5, 6]);
  });

  it("the md padding hack (md:px-1 until lg:px-3) rides ONLY with md labels - the 4-link org nav", async () => {
    let md = 0;
    let other = 0;
    for (const shape of SHAPES) {
      const links = navLinks(await renderShape(shape));
      const onAtMd = links[0]!.label === "hidden md:inline";
      for (const l of links) {
        const toks = tokens(l.cls);
        if (onAtMd) { expect(toks, l.href).toContain("md:px-1"); expect(toks, l.href).toContain("lg:px-3"); md++; }
        else { expect(toks.filter((t) => /^(md|lg):px-/.test(t)), l.href).toEqual([]); other++; }
      }
    }
    expect(md).toBe(4);
    expect(other).toBe(5 + 5 + 6);
  });
});

describe("Nav > Player home folds first (OWNER RULING 6.1), and only where the bar needs it", () => {
  it("a streaming org's Player home is `hidden min-[390px]:flex`; without Streaming it keeps the precedent `min-[350px]:flex`", async () => {
    const withStreaming = navLinks(await renderShape({ streaming: true, player: true })).find((l) => l.href === "/me");
    const without = navLinks(await renderShape({ streaming: false, player: true })).find((l) => l.href === "/me");
    expect(tokens(withStreaming!.cls)).toContain("min-[390px]:flex");
    expect(tokens(withStreaming!.cls)).not.toContain("min-[350px]:flex");
    expect(withStreaming!.cls).toMatch(/(?:^|\s)hidden\s+min-\[390px\]:flex(?:\s|$)/);
    expect(tokens(without!.cls)).toContain("min-[350px]:flex");
    expect(tokens(without!.cls)).not.toContain("min-[390px]:flex");
    for (const l of [withStreaming!, without!]) expect(tokens(l.cls)).not.toContain("flex");
  });

  // The phone budget, as a count of what is SHOWN at each width. Each icon-only link is 28px (a 16px icon + 6px of side
  // padding each side, `px-1.5`), the links touch (gap-0), and everything else in the row is fixed below `sm`: the
  // wordmark, the "?" and Sign-out icons, the gaps and the 16px page padding. Calibrated on what was measured in a browser
  // (nav.tsx): the 4-link nav fits 320 with 4px to spare, the 5-link nav fits 350 with 6 - so Sign-out's right edge is at
  // 28N + 204 and must be <= the viewport. The real thing is measured by youtube-streaming.shots.spec.ts and mobile.spec.ts.
  const LINK_PX = 28;
  const FIXED_PX = 204;
  const shownAt = (links: NavLink[], vw: number): NavLink[] =>
    links.filter((l) => {
      const toks = tokens(l.cls);
      if (!toks.includes("hidden")) return true;
      const min = toks.map((t) => t.match(/^min-\[(\d+)px\]:flex$/)?.[1]).find((x) => x !== undefined);
      return min !== undefined && vw >= Number(min);
    });

  it("the worst case (Streaming + claimed player + Sponsors) fits every phone width with Player home folded where it must be", async () => {
    const links = navLinks(await renderShape({ streaming: true, player: true }));
    expect(links.length).toBe(6);
    const widths = [320, 335, 349, 350, 360, 375, 389, 390, 430];
    const shown: Record<number, number> = {};
    for (const vw of widths) {
      const n = shownAt(links, vw).length;
      shown[vw] = n;
      expect(LINK_PX * n + FIXED_PX, `${vw}px: ${n} links need ${LINK_PX * n + FIXED_PX}px`).toBeLessThanOrEqual(vw);
    }
    // The fold is real, not vacuous: all six only from 390, five from 350, four below.
    expect(shown).toEqual({ 320: 4, 335: 4, 349: 4, 350: 5, 360: 5, 375: 5, 389: 5, 390: 6, 430: 6 });
  });

  it("every other org shape fits the same widths with nothing folded but Sponsors", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const links = navLinks(await renderShape(shape));
      for (const vw of [320, 350, 360, 375, 390, 430]) {
        const n = shownAt(links, vw).length;
        expect(LINK_PX * n + FIXED_PX, `${JSON.stringify(shape)} at ${vw}`).toBeLessThanOrEqual(vw);
        checked++;
      }
    }
    expect(checked).toBe(24);
  });
});
