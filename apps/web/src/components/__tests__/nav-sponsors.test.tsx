// The console nav's Sponsors and Settings items (R4 sponsors-on-stream).
//
// OWNER RULING 2026-11-01 (replaces 2026-10-31 "a"): "instead of putting sponsor icon, can we put setting as a icon all time".
// Settings is its icon alone at every width (named by aria-label, with a title tooltip), and Sponsors is an ordinary
// labelled link on the SAME label rung as Dashboard, Directory and Streaming - the width Settings' label gave back pays for it.
// So the labelled links are the ones main had (Settings' label swapped for Sponsors'), and main's rung holds again: the org
// nav's labels at md, the dual-role nav's at lg (the owner's 2026-10-28 "tighten" ruling: tablets keep their labels).
// Phones are icon-only either way; there Sponsors is still `hidden min-[350px]:flex` and Player home still folds first. An org
// with a LOGO carries 38px more in the row (the 28px logo and its 10px gap), so both fold thresholds move up for it - never
// showing more than an org without a logo would at the same width.
//
// What a unit test CAN pin is the markup that makes the width budget true: which links are in the bar at which width, the
// label each one carries and the rung it is revealed at. That the budget really fits is measured in a browser at every
// width x locale x org shape: `youtube-streaming.shots.spec.ts` (the gantry-fit probes), `nav-org-chip-overflow.spec.ts`
// (the 38-character club name at 768 and 1280) and `mobile.spec.ts` (the seven width projects).
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

const DICTS = { en: dictEn, es: dictEs, fr: dictFr, nl: dictNl } as Record<string, Record<string, string>>;
const ORG = { id: "org-active", name: "Riverside BC", slug: "riverside", role: "owner", logo_storage_path: null, logo_url: null };
/** The same org with a logo: an https URL is what `orgLogoUrl` passes straight through, so the gantry renders it. */
const LOGO_URL = "https://cdn.example.test/riverside.png";
const ORG_LOGO = { ...ORG, logo_url: LOGO_URL };
const render = async (): Promise<string> => new Response((await prerender(await Nav())).prelude).text();
const tokens = (cls: string | undefined): string[] => (cls ?? "").split(/\s+/).filter(Boolean);

interface NavLink { href: string; testid: string; aria: string; title: string | null; cls: string; label: string | null; inner: string }
/** Every link inside the gantry's <nav>, in document order. `label` is the class of the link's OWN label span, or null when it has none
 *  (parsed per link, so a link without a span can never borrow the next link's). `title` is null when the attribute is absent. */
function navLinks(html: string): NavLink[] {
  const nav = html.match(/<nav class="[^"]*">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  return [...nav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((x) => ({
    href: x[1]!.match(/\bhref="([^"]*)"/)?.[1] ?? "",
    testid: x[1]!.match(/\bdata-testid="([^"]*)"/)?.[1] ?? "",
    aria: x[1]!.match(/\baria-label="([^"]*)"/)?.[1] ?? "",
    title: x[1]!.match(/\btitle="([^"]*)"/)?.[1] ?? null,
    cls: x[1]!.match(/\bclass="([^"]*)"/)?.[1] ?? "",
    label: x[2]!.match(/<span class="([^"]*)">/)?.[1] ?? null,
    inner: x[2]!,
  }));
}
const sponsorsLink = (html: string): NavLink | undefined => navLinks(html).find((l) => l.testid === "nav-sponsors");
const settingsLink = (html: string): NavLink | undefined => navLinks(html).find((l) => l.testid === "nav-settings");

/** The org shapes the bar can take: streaming offered or not x a claimed player or not. */
const SHAPES = [
  { streaming: false, player: false },
  { streaming: true, player: false },
  { streaming: false, player: true },
  { streaming: true, player: true },
] as const;
async function renderShape(s: { streaming: boolean; player: boolean; logo?: boolean }): Promise<string> {
  m.hasFeature.mockReset().mockResolvedValue(true);
  setRelayDriversForTest(s.streaming ? { ingest: new FakeIngest(), runner: new FakeRunner() } : disabledRelayDrivers());
  m.hasClaimedProfile.mockResolvedValue(s.player);
  m.getUserOrgs.mockResolvedValue([s.logo ? ORG_LOGO : ORG]);
  const html = await render();
  // The logo case is real, not assumed: the gantry painted the org's logo (or, without one, did not).
  expect(html.includes(`src="${LOGO_URL}"`), `${JSON.stringify(s)}: the org logo is in the gantry`).toBe(!!s.logo);
  return html;
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
  it("is a link to the org's Sponsors hub, named, after Directory/Streaming - and Settings, the icon, closes the bar", async () => {
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

  it("dual-role: Player home joins the labelled links and Settings stays LAST, beside the other icon-only controls (help, Sign out)", async () => {
    const order = navLinks(await renderShape({ streaming: true, player: true })).map((l) => l.href);
    expect(order).toEqual(["/o/riverside", "/directory", "/streaming", "/o/riverside/sponsors", "/me", "/o/riverside/settings"]);
  });

  it("carries a VISIBLE label, in the same span shape as its labelled siblings, in every locale (16 cells counted)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      for (const shape of SHAPES) {
        const html = await renderShape(shape);
        const a = sponsorsLink(html)!;
        const dashboard = navLinks(html)[0]!;
        expect(a.label, `${locale} ${JSON.stringify(shape)}: Sponsors has a label span`).not.toBeNull();
        expect(a.label, `${locale} ${JSON.stringify(shape)}: the same rung as Dashboard's`).toBe(dashboard.label);
        expect(a.inner, `${locale}: the label is this locale's word`).toContain(`>${DICTS[locale]!["nav.sponsors"]}</span>`);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * SHAPES.length);
  });

  it("the class is `hidden min-[350px]:flex` (the Player-home precedent) - `min-[390px]` for an org with a logo - and NO bare `flex` to fight it (8 cells)", async () => {
    let checked = 0;
    for (const logo of [false, true]) {
      for (const shape of SHAPES) {
        const where = JSON.stringify({ ...shape, logo });
        const cls = sponsorsLink(await renderShape({ ...shape, logo }))!.cls;
        const toks = tokens(cls);
        const [from, not] = logo ? ["390", "350"] : ["350", "390"];
        // Anchored on whole tokens: `/\bmd:hidden\b/` also matches inside `max-md:hidden`, and `flex` matches inside `min-[350px]:flex`.
        expect(cls, where).toMatch(new RegExp(`(?:^|\\s)hidden\\s+min-\\[${from}px\\]:flex(?:\\s|$)`));
        expect(toks, `${where}: hidden is a bare token`).toContain("hidden");
        expect(toks, `${where}: flex only from ${from}`).toContain(`min-[${from}px]:flex`);
        expect(toks, `${where}: never the other threshold`).not.toContain(`min-[${not}px]:flex`);
        expect(toks, `${where}: a bare \`flex\` would win or lose the cascade against \`hidden\` by CSS order`).not.toContain("flex");
        checked++;
      }
    }
    expect(checked).toBe(2 * SHAPES.length);
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
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const label = DICTS[locale]!["nav.sponsors"];
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

describe("Nav > Settings is its icon alone at every width (owner 2026-11-01)", () => {
  it("no label span at all, in any org shape or locale - named by aria-label AND a title tooltip in that locale's words (16 cells counted)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      m.locale.value = locale;
      const name = DICTS[locale]!["nav.settings"];
      expect(typeof name, locale).toBe("string");
      for (const shape of SHAPES) {
        const a = settingsLink(await renderShape(shape));
        expect(a, `${locale} ${JSON.stringify(shape)}: the Settings link is in the nav`).toBeDefined();
        expect(a!.href).toBe("/o/riverside/settings");
        expect(a!.label, `${locale} ${JSON.stringify(shape)}: no label span`).toBeNull();
        expect(a!.inner, `${locale}: no visible words inside the link`).not.toContain(name!);
        expect(a!.aria, `${locale}: the accessible name`).toBe(name);
        expect(a!.title, `${locale}: the mouse user's tooltip`).toBe(name);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * SHAPES.length);
    // Translated, not English everywhere: four locales, four words.
    expect(new Set(LOCALES.map((l) => DICTS[l]!["nav.settings"])).size).toBe(LOCALES.length);
  });

  it("is shown at every width (a bare `flex`, never `hidden`) and is the LAST link of every shape", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const links = navLinks(await renderShape(shape));
      const a = links.find((l) => l.testid === "nav-settings");
      expect(a, JSON.stringify(shape)).toBeDefined();
      expect(tokens(a!.cls), JSON.stringify(shape)).toContain("flex");
      expect(tokens(a!.cls), JSON.stringify(shape)).not.toContain("hidden");
      expect(links.at(-1)!.testid, JSON.stringify(shape)).toBe("nav-settings");
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  });

  it("its padding: 6px on phones (a 28px icon, as every phone link), 12px in the sm band, and 6px again from where the bar's labels come on - md for the org nav, lg for the dual-role nav - never the labelled links' 4px (a 24px target)", async () => {
    // Where the labels are on the bar is at its fullest, and the 12px a bare icon gets in the sm band would come straight out of the
    // org chip: the 38-character club name lost its last characters at 1280 with it (nav-E report). Below its labels' rung the
    // dual-role nav is all icons at sm's 12px (40px wide), and Settings matches them there (review of 2900e56916).
    let checked = 0;
    for (const shape of SHAPES) {
      const toks = tokens(settingsLink(await renderShape(shape))!.cls);
      const where = JSON.stringify(shape);
      expect(toks, where).toContain("px-1.5");
      expect(toks, where).toContain("sm:px-3");
      expect(toks, `${where}: never 4px`).not.toContain("md:px-1");
      expect(toks.filter((t) => /^(md|lg|xl):px-/.test(t)), `${where}: 6px from the labels' rung, through desktop`).toEqual([shape.player ? "lg:px-1.5" : "md:px-1.5"]);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  });

  it("with no organisation there is no club name to make room for: Settings keeps sm's 12px at every width from sm (player and not)", async () => {
    let checked = 0;
    for (const player of [false, true]) {
      m.getUserOrgs.mockResolvedValue([]);
      m.hasClaimedProfile.mockResolvedValue(player);
      const html = await render();
      expect(html, "no org chip").not.toContain('data-tour="org-chip"');
      const toks = tokens(settingsLink(html)!.cls);
      expect(toks, `player ${player}`).toEqual(expect.arrayContaining(["px-1.5", "sm:px-3"]));
      expect(toks.filter((t) => /^(md|lg|xl):px-/.test(t)), `player ${player}: no override`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("with no organisation yet it still opens /orgs/new and is still an icon (the empty case)", async () => {
    m.getUserOrgs.mockResolvedValue([]);
    const a = settingsLink(await render());
    expect(a).toBeDefined();
    expect(a!.href).toBe("/orgs/new");
    expect(a!.label).toBeNull();
    expect(a!.title).toBe("Settings");
  });
});

describe("Nav > one box height for every gantry control, icon or labelled (CI e2e 41298006103)", () => {
  // A labelled link is 32px tall (a 20px line of text-sm + py-1.5) and a bare 16px icon only 28, so in the `items-center` nav
  // the icon-only Settings sat 2px lower than its labelled neighbours wherever the labels were on - and the gantry probe in
  // youtube-streaming.shots.spec.ts read that as a wrap (tops 12,12,12,12,14 at 768 en and dual-role 1024). Every nav link and
  // the Sign-out button therefore carry the same `min-h-8` (32px): one height whether the words are painted or not, at every
  // width. `min-`, not a fixed `h-8`, so a label that ever wrapped would still grow the box and show as a second row.
  it("every nav link, in every org shape (with and without a logo), carries min-h-8 - 4+5+5+6 links x 2 = 40 counted", async () => {
    let checked = 0;
    for (const logo of [false, true]) {
      for (const shape of SHAPES) {
        for (const l of navLinks(await renderShape({ ...shape, logo }))) {
          expect(tokens(l.cls), `${JSON.stringify({ ...shape, logo })} ${l.href}`).toContain("min-h-8");
          checked++;
        }
      }
    }
    expect(checked).toBe(2 * (4 + 5 + 5 + 6));
  });

  it("the Sign-out button carries the same min-h-8", async () => {
    const cls = (await render()).match(/<button\b[^>]*\bclass="([^"]*)"/)?.[1];
    expect(cls, "the gantry renders its Sign-out button").toBeDefined();
    expect(tokens(cls)).toContain("min-h-8");
  });
});

describe("Nav > the label rung is main's again (owner 2026-10-28: md for the org nav's labels, lg for the dual-role nav's)", () => {
  // The rule's literal, from main: a claimed player's bar waits for lg, every other bar shows its labels from md. Settings no longer
  // has a label, so the labelled links are exactly main's set with Settings' word swapped for Sponsors'.
  const rungFor = (player: boolean): string => (player ? "hidden lg:inline" : "hidden md:inline");

  it("each org shape: every labelled link takes the shape's rung, and every link but Settings IS labelled (four shapes, 3+4+4+5 = 16 labels counted)", async () => {
    let labels = 0;
    for (const shape of SHAPES) {
      const links = navLinks(await renderShape(shape));
      for (const l of links) {
        if (l.testid === "nav-settings") continue;
        expect(l.label, `${JSON.stringify(shape)} ${l.href}`).toBe(rungFor(shape.player));
        labels++;
      }
    }
    expect(labels).toBe(3 + 4 + 4 + 5);
  });

  it("no link anywhere is revealed at xl (the six-label rung went with Settings' label)", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const html = await renderShape(shape);
      expect(html, JSON.stringify(shape)).not.toMatch(/(?:^|[\s"])xl:inline(?:[\s"]|$)/);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  });

  // The labelled links' spacing from md. The club name in the org chip is the row's only flexible item, so every px the links take
  // comes out of it; with one more link than main had, the links give the room back in their own padding and gaps (measured, nav-E
  // report: the 38-character club name keeps its last characters at 1280 and 8+ characters at 768, as on main).
  //   org nav, labels on from md: md..lg 4px side padding and a 4px icon-to-word gap; from lg main's 12px and 6px gap again.
  //   dual-role nav, icons until lg: main's 12px from sm, with no override at all.
  // From lg, Sign out paints no words (owner 2026-11-01, a second ruling the same day), and the width they took pays for main's 12px.
  const spacing = (toks: string[]): string[] => toks.filter((t) => /^(md|lg|xl):(px|gap)-/.test(t)).sort();

  it("from md: the org nav's labelled links take md:px-1 md:gap-1 then main's lg:px-3 lg:gap-1.5; the dual-role nav's keep main's padding, no override (16 labelled links)", async () => {
    let md = 0;
    let other = 0;
    for (const shape of SHAPES) {
      for (const l of navLinks(await renderShape(shape))) {
        if (l.testid === "nav-settings") continue;
        const toks = tokens(l.cls);
        if (l.label === "hidden md:inline") { expect(spacing(toks), l.href).toEqual(["lg:gap-1.5", "lg:px-3", "md:gap-1", "md:px-1"]); md++; }
        else { expect(spacing(toks), l.href).toEqual([]); other++; }
        expect(toks, `${l.href}: sm's 12px everywhere it is not overridden`).toContain("sm:px-3");
        expect(toks, `${l.href}: not the 8px of the first 2026-11-01 build`).not.toContain("lg:px-2");
      }
    }
    expect(md).toBe(3 + 4);
    expect(other).toBe(4 + 5);
  });

  it("with no organisation (no chip to make room for) the bar keeps main's spacing: no md:gap-0 on the nav, no md:gap-1 on a link - the non-player bar keeps B3's md:px-1 lg:px-3, the player bar none (2 bars)", async () => {
    let checked = 0;
    for (const player of [false, true]) {
      m.getUserOrgs.mockResolvedValue([]);
      m.hasClaimedProfile.mockResolvedValue(player);
      const html = await render();
      const navToks = tokens(html.match(/<nav class="([^"]*)">/)?.[1]);
      expect(navToks, `player ${player}`).toEqual(expect.arrayContaining(["gap-0", "sm:gap-0.5"]));
      expect(navToks, `player ${player}: the links keep sm's 2px gap`).not.toContain("md:gap-0");
      const labelled = navLinks(html).filter((l) => l.testid !== "nav-settings");
      expect(labelled.length, `player ${player}: Dashboard, Directory (+ Player home)`).toBe(player ? 3 : 2);
      for (const l of labelled) expect(spacing(tokens(l.cls)), `player ${player} ${l.href}`).toEqual(player ? [] : ["lg:px-3", "md:px-1"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the links touch from md (md:gap-0): the 2px gap of the sm band is gone where the bar is full (4 shapes)", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const navToks = tokens((await renderShape(shape)).match(/<nav class="([^"]*)">/)?.[1]);
      expect(navToks, JSON.stringify(shape)).toEqual(expect.arrayContaining(["gap-0", "sm:gap-0.5", "md:gap-0"]));
      expect(navToks.filter((t) => /^(lg|xl):gap-/.test(t)), JSON.stringify(shape)).toEqual([]);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
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

  it("an org with a logo moves each threshold up one step: 430 with Streaming, 390 without", async () => {
    const withStreaming = navLinks(await renderShape({ streaming: true, player: true, logo: true })).find((l) => l.href === "/me");
    const without = navLinks(await renderShape({ streaming: false, player: true, logo: true })).find((l) => l.href === "/me");
    expect(withStreaming!.cls).toMatch(/(?:^|\s)hidden\s+min-\[430px\]:flex(?:\s|$)/);
    expect(without!.cls).toMatch(/(?:^|\s)hidden\s+min-\[390px\]:flex(?:\s|$)/);
    for (const l of [withStreaming!, without!]) {
      expect(tokens(l.cls).filter((t) => /^min-\[\d+px\]:flex$/.test(t)), "exactly one threshold").toHaveLength(1);
      expect(tokens(l.cls)).not.toContain("flex");
    }
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

  // An org logo sits in the row too: a 28px square (`h-7 w-7`) and the wordmark link's 10px gap. Measured in a browser (nav-E report,
  // en, Streaming org): with the logo, five icon links fit from exactly 382px (= 28 x 5 + 204 + 38) and six from 410. The links that
  // never fold (Dashboard, Directory, Streaming, Settings) already overrun 320-353 with a logo - main did too (34px at 320, the same
  // four links) - so the rule a folding link must keep is relational: it only ever appears where the bar FITS with it, and a logo org
  // never shows more links than an org without one at the same width.
  const LOGO_PX = 38;
  const PHONE_WIDTHS = [320, 335, 349, 350, 353, 354, 360, 375, 381, 382, 389, 390, 409, 410, 412, 429, 430, 500, 639];
  const isFolding = (l: NavLink): boolean => tokens(l.cls).includes("hidden");

  it("with a logo, a folding link (Sponsors, Player home) is shown only where the bar fits with it - every org shape x 19 phone widths", async () => {
    let checked = 0;
    let foldingShown = 0;
    for (const shape of SHAPES) {
      const links = navLinks(await renderShape({ ...shape, logo: true }));
      const plain = navLinks(await renderShape({ ...shape, logo: false }));
      for (const vw of PHONE_WIDTHS) {
        const shown = shownAt(links, vw);
        const where = `${JSON.stringify(shape)} + logo at ${vw}px`;
        if (shown.some(isFolding)) {
          foldingShown++;
          expect(LINK_PX * shown.length + FIXED_PX + LOGO_PX, `${where}: ${shown.length} links need ${LINK_PX * shown.length + FIXED_PX + LOGO_PX}px`).toBeLessThanOrEqual(vw);
        }
        expect(shown.length, `${where}: never more links than the same org without a logo`).toBeLessThanOrEqual(shownAt(plain, vw).length);
        checked++;
      }
    }
    expect(checked).toBe(SHAPES.length * PHONE_WIDTHS.length);
    expect(foldingShown, "anti-vacuity: the fit rule ran where a folding link was shown").toBeGreaterThan(0);
  });

  it("with a logo, the worst case (Streaming + claimed player) shows four links below 390, five from 390, all six from 430", async () => {
    const links = navLinks(await renderShape({ streaming: true, player: true, logo: true }));
    expect(links.length).toBe(6);
    const shown = Object.fromEntries([320, 350, 389, 390, 429, 430].map((vw) => [vw, shownAt(links, vw).length]));
    expect(shown).toEqual({ 320: 4, 350: 4, 389: 4, 390: 5, 429: 5, 430: 6 });
  });
});
