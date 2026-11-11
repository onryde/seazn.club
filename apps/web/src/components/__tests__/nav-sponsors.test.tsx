// The console nav's Sponsors item and the bar's width budget (R4 sponsors-on-stream; the account menu, 2026-11-11).
//
// OWNER RULING 2026-11-01: Sponsors is an ordinary labelled link on the SAME label rung as Dashboard, Directory and Streaming.
// OWNER PICK 2026-11-11 (Option A, the account menu): the Settings icon, the display name, Sign out and Player home left the bar
// for one account trigger at its right end (components/account-menu.tsx; its own suite is account-menu.test.tsx and the bar-level
// facts are nav-account-menu.test.tsx). So the bar is the same for a claimed player as for anyone else: labels at md for every
// bar. Phones are icon-only; there Sponsors is still `hidden min-[350px]:flex`. An org with a LOGO carries 38px more in the row
// (the 28px logo and its 10px gap), so the Sponsors fold moves up for it - never showing more than an org without a logo would
// at the same width.
//
// What a unit test CAN pin is the markup that makes the width budget true: which links are in the bar at which width, the
// label each one carries and the rung it is revealed at. That the budget really fits is measured in a browser at every
// width x locale x org shape: `youtube-streaming.shots.spec.ts` (the gantry-fit probes), `nav-org-chip-overflow.spec.ts`
// (the 38-character club name at 768 and 1280) and `mobile.spec.ts` (the seven width projects).
//
// prerender, not renderToStaticMarkup: Nav is an async server component.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/** The org shapes the bar can take: streaming offered or not x a claimed player or not (a claimed player no longer changes the
 *  bar - Player home lives in the account menu - and the shapes keep both so that stays proven, not assumed). */
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
  it("is a link to the org's Sponsors hub, named, after Directory/Streaming - and it closes the links (Settings went to the account menu)", async () => {
    const html = await render();
    const a = sponsorsLink(html);
    expect(a, "the Sponsors link is in the nav").toBeDefined();
    expect(a!.href).toBe("/o/riverside/sponsors");
    expect(a!.aria).toBe("Sponsors");
    const order = navLinks(html).map((l) => l.href);
    expect(order).toEqual(["/o/riverside", "/directory", "/streaming", "/o/riverside/sponsors"]);
  });

  it("without Streaming the order is Dashboard, Directory, Sponsors", async () => {
    const order = navLinks(await renderShape({ streaming: false, player: false })).map((l) => l.href);
    expect(order).toEqual(["/o/riverside", "/directory", "/o/riverside/sponsors"]);
  });

  it("dual-role: a claimed player's links are the SAME links - Player home is in the account menu, not the bar", async () => {
    const player = navLinks(await renderShape({ streaming: true, player: true })).map((l) => l.href);
    const plain = navLinks(await renderShape({ streaming: true, player: false })).map((l) => l.href);
    expect(player).toEqual(["/o/riverside", "/directory", "/streaming", "/o/riverside/sponsors"]);
    expect(player).toEqual(plain);
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

  it("every other link is shown at every width, and a plain org (2 default links + Sponsors) has exactly one link that is hidden below 350", async () => {
    const links = navLinks(await renderShape({ streaming: false, player: false }));
    expect(links.length).toBe(3);
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
    expect(navLinks(html).map((l) => l.href)).toEqual(["/orgs/new", "/directory"]);
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

describe("Nav > one box height for every gantry control, icon or labelled (CI e2e 41298006103)", () => {
  // A labelled link is 32px tall (a 20px line of text-sm + py-1.5) and a bare 16px icon only 28, so in the `items-center` nav
  // an icon-only control sat 2px lower than its labelled neighbours wherever the labels were on - and the gantry probe in
  // youtube-streaming.shots.spec.ts read that as a wrap (tops 12,12,12,12,14 at 768 en and dual-role 1024). Every nav link and
  // the account trigger therefore carry the same `min-h-8` (32px): one height whether the words are painted or not, at every
  // width. `min-`, not a fixed `h-8`, so a label that ever wrapped would still grow the box and show as a second row.
  it("every nav link, in every org shape (with and without a logo), carries min-h-8 - 3+4+3+4 links x 2 = 28 counted", async () => {
    let checked = 0;
    for (const logo of [false, true]) {
      for (const shape of SHAPES) {
        for (const l of navLinks(await renderShape({ ...shape, logo }))) {
          expect(tokens(l.cls), `${JSON.stringify({ ...shape, logo })} ${l.href}`).toContain("min-h-8");
          checked++;
        }
      }
    }
    expect(checked).toBe(2 * (3 + 4 + 3 + 4));
  });

  it("the account trigger carries the same min-h-8", async () => {
    const cls = (await render()).match(/<button\b[^>]*\bdata-testid="account-menu-trigger"[^>]*>/)?.[0].match(/\bclass="([^"]*)"/)?.[1];
    expect(cls, "the gantry renders its account trigger").toBeDefined();
    expect(tokens(cls)).toContain("min-h-8");
  });
});

describe("Nav > one label rung for every bar: md (the dual-role lg rung went with Player home, 2026-11-11)", () => {
  // Main's rule was: a claimed player's bar waits for lg, every other bar shows its labels from md - because Player home added a
  // link. Player home is in the account menu now, so every bar has the same links and the same rung.
  it("each org shape: every link is labelled and takes `hidden md:inline` (four shapes, 3+4+3+4 = 14 labels counted)", async () => {
    let labels = 0;
    for (const shape of SHAPES) {
      for (const l of navLinks(await renderShape(shape))) {
        expect(l.label, `${JSON.stringify(shape)} ${l.href}`).toBe("hidden md:inline");
        labels++;
      }
    }
    expect(labels).toBe(3 + 4 + 3 + 4);
  });

  it("no link anywhere is revealed at lg or xl (no second rung survives)", async () => {
    let checked = 0;
    for (const shape of SHAPES) {
      const html = await renderShape(shape);
      expect(html, JSON.stringify(shape)).not.toMatch(/(?:^|[\s"])(?:lg|xl):inline(?:[\s"]|$)/);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
  });

  // The labelled links' spacing from md. The club name in the org chip is the row's only flexible item, so every px the links take
  // comes out of it (measured, nav-E report: the 38-character club name keeps its last characters at 1280 and 8+ characters at 768).
  //   bar with an org, labels on from md: md..lg 4px side padding and a 4px icon-to-word gap; from lg main's 12px and 6px gap.
  const spacing = (toks: string[]): string[] => toks.filter((t) => /^(md|lg|xl):(px|gap)-/.test(t)).sort();

  it("from md: every labelled link of a bar with an org takes md:px-1 md:gap-1 then main's lg:px-3 lg:gap-1.5 (14 links)", async () => {
    let md = 0;
    for (const shape of SHAPES) {
      for (const l of navLinks(await renderShape(shape))) {
        const toks = tokens(l.cls);
        expect(spacing(toks), `${JSON.stringify(shape)} ${l.href}`).toEqual(["lg:gap-1.5", "lg:px-3", "md:gap-1", "md:px-1"]);
        expect(toks, `${l.href}: sm's 12px everywhere it is not overridden`).toContain("sm:px-3");
        expect(toks, `${l.href}: not the 8px of the first 2026-11-01 build`).not.toContain("lg:px-2");
        md++;
      }
    }
    expect(md).toBe(3 + 4 + 3 + 4);
  });

  it("with no organisation (no chip to make room for) the bar keeps main's spacing: no md:gap-0 on the nav, no md:gap-1 on a link, B3's md:px-1 lg:px-3 - player or not (2 bars)", async () => {
    let checked = 0;
    for (const player of [false, true]) {
      m.getUserOrgs.mockResolvedValue([]);
      m.hasClaimedProfile.mockResolvedValue(player);
      const html = await render();
      const navToks = tokens(html.match(/<nav class="([^"]*)">/)?.[1]);
      expect(navToks, `player ${player}`).toEqual(expect.arrayContaining(["gap-0", "sm:gap-0.5"]));
      expect(navToks, `player ${player}: the links keep sm's 2px gap`).not.toContain("md:gap-0");
      const labelled = navLinks(html);
      expect(labelled.length, `player ${player}: Dashboard, Directory`).toBe(2);
      for (const l of labelled) expect(spacing(tokens(l.cls)), `player ${player} ${l.href}`).toEqual(["lg:px-3", "md:px-1"]);
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

describe("Nav > the phone budget: what is SHOWN at each width fits it", () => {
  it("Player home is never a bar link, in any org shape, with or without a logo (it lives in the account menu) - 8 bars", async () => {
    let checked = 0;
    for (const logo of [false, true]) {
      for (const shape of SHAPES) {
        const html = await renderShape({ ...shape, logo });
        expect(navLinks(html).map((l) => l.href), JSON.stringify({ ...shape, logo })).not.toContain("/me");
        checked++;
      }
    }
    expect(checked).toBe(2 * SHAPES.length);
  });

  // The phone budget, as a count of what is SHOWN at each width. Each icon-only link is 28px (a 16px icon + 6px of side
  // padding each side, `px-1.5`), the links touch (gap-0), and everything else in the row is fixed below `sm`: the 16px page
  // padding, the 80px wordmark, the header's two 16px gaps, the right group's two 4px gaps, the 32px "?" and the 32px account
  // trigger (a 28px avatar in `p-0.5`). The 2026-11-01 bar was measured in a browser with the 36px Sign-out icon where the
  // trigger now sits: its right edge at 28N + 204. The trigger is 4px narrower, so the last control's right edge is at 28N + 200
  // and must be <= the viewport. The real thing is measured by youtube-streaming.shots.spec.ts and mobile.spec.ts.
  const LINK_PX = 28;
  const SIGN_OUT_PX = 36;
  const TRIGGER_PX = 32;
  const FIXED_PX = 204 - SIGN_OUT_PX + TRIGGER_PX;
  const shownAt = (links: NavLink[], vw: number): NavLink[] =>
    links.filter((l) => {
      const toks = tokens(l.cls);
      if (!toks.includes("hidden")) return true;
      const min = toks.map((t) => t.match(/^min-\[(\d+)px\]:flex$/)?.[1]).find((x) => x !== undefined);
      return min !== undefined && vw >= Number(min);
    });

  it("the fullest bar (Streaming + Sponsors, a claimed player) fits every phone width, Sponsors folded below 350", async () => {
    const links = navLinks(await renderShape({ streaming: true, player: true }));
    expect(links.length).toBe(4);
    const widths = [320, 335, 349, 350, 360, 375, 389, 390, 430];
    const shown: Record<number, number> = {};
    for (const vw of widths) {
      const n = shownAt(links, vw).length;
      shown[vw] = n;
      expect(LINK_PX * n + FIXED_PX, `${vw}px: ${n} links need ${LINK_PX * n + FIXED_PX}px`).toBeLessThanOrEqual(vw);
    }
    // The fold is real, not vacuous: all four from 350, three below.
    expect(shown).toEqual({ 320: 3, 335: 3, 349: 3, 350: 4, 360: 4, 375: 4, 389: 4, 390: 4, 430: 4 });
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

  // An org logo sits in the row too: a 28px square (`h-7 w-7`) and the wordmark link's 10px gap (measured in a browser, nav-E
  // report). The rule a folding link must keep is relational: it only ever appears where the bar FITS with it, and a logo org never
  // shows more links than an org without one at the same width. The links that never fold (Dashboard, Directory, Streaming) still
  // overrun 320 with a logo (28 x 3 + 200 + 38 = 322) - which is what the wordmark fold the last two tests below pin is for.
  const LOGO_PX = 38;
  const PHONE_WIDTHS = [320, 335, 349, 350, 353, 354, 360, 375, 381, 382, 389, 390, 409, 410, 412, 429, 430, 500, 639];
  const isFolding = (l: NavLink): boolean => tokens(l.cls).includes("hidden");

  it("with a logo, the folding link (Sponsors) is shown only where the bar fits with it - every org shape x 19 phone widths", async () => {
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

  it("with a logo, the fullest bar (Streaming + Sponsors) shows three links below 390 and all four from 390", async () => {
    const links = navLinks(await renderShape({ streaming: true, player: true, logo: true }));
    expect(links.length).toBe(4);
    const shown = Object.fromEntries([320, 350, 389, 390, 429, 430].map((vw) => [vw, shownAt(links, vw).length]));
    expect(shown).toEqual({ 320: 3, 350: 3, 389: 3, 390: 4, 429: 4, 430: 4 });
  });

  // The Seazn wordmark is the row's other fixed width: its PNG drawn 28px tall (`h-7 w-auto`), so as wide as the asset's own aspect
  // ratio makes it - read here off the file's IHDR, never off nav.tsx. CI e2e 42438561906 (sponsors-capture, the top bar @320 for an
  // org with a logo and Streaming) measured the gantry's content 354px wide in a 320px box - 28 x 4 + 204 + 38, to the pixel - so the
  // last control sat wholly past the viewport, where html's `overflow-x: clip` cut it off. Below 360 a logo org's wordmark therefore
  // gives its place to the club's crest (`max-[360px]:sr-only`: out of the row, still in the home link's name), handing back its own
  // width and the crest's 10px gap beside it. The account menu's bar is narrower and still needs it at 320 (322px).
  const CREST_PX = 28;
  const WORDMARK_SRC = "/logo-wide-night.png";
  const wordmarkPx = (): number => {
    const png = readFileSync(fileURLToPath(new URL(`../../../public${WORDMARK_SRC}`, import.meta.url)));
    expect(png.subarray(12, 16).toString("latin1"), "premise: the wordmark is a PNG whose first chunk is IHDR").toBe("IHDR");
    return (28 * png.readUInt32BE(16)) / png.readUInt32BE(20);
  };
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** The class of the gantry's <img> with this src, or undefined when the bar has none. */
  const imgClass = (html: string, src: string): string | undefined =>
    html.match(new RegExp(`<img\\b[^>]*\\bsrc="${escapeRe(src)}"[^>]*>`))?.[0].match(/\bclass="([^"]*)"/)?.[1];
  /** The width the wordmark is out of the row BELOW (its max-width `sr-only` breakpoint), or null where it never folds. */
  const wordmarkFoldBelow = (cls: string | undefined): number | null => {
    const at = tokens(cls).map((t) => t.match(/^max-\[(\d+)px\]:sr-only$/)?.[1]).find((x) => x !== undefined);
    return at === undefined ? null : Number(at);
  };

  it("with a logo, the WHOLE bar fits every phone width - the account trigger never past the viewport: the wordmark yields its place where the links that never fold overrun (every org shape x 19 widths)", async () => {
    const wordmark = wordmarkPx();
    let checked = 0;
    let rescued = 0;
    for (const shape of SHAPES) {
      const html = await renderShape({ ...shape, logo: true });
      const below = wordmarkFoldBelow(imgClass(html, WORDMARK_SRC));
      const links = navLinks(html);
      for (const vw of PHONE_WIDTHS) {
        const n = shownAt(links, vw).length;
        const whole = LINK_PX * n + FIXED_PX + LOGO_PX;
        const folded = below !== null && vw < below;
        const need = folded ? whole - wordmark - (LOGO_PX - CREST_PX) : whole;
        expect(need, `${JSON.stringify(shape)} + logo at ${vw}px: ${n} links${folded ? ", the wordmark folded" : ""} - the trigger's right edge at ${need}px`).toBeLessThanOrEqual(vw);
        if (folded && whole > vw) rescued++;
        checked++;
      }
    }
    expect(checked).toBe(SHAPES.length * PHONE_WIDTHS.length);
    expect(rescued, "anti-vacuity: some width overruns WITH the wordmark and fits only because it folded").toBeGreaterThan(0);
  });

  it("the wordmark folds out of the ROW, never out of the home link's name (no display:none); the crest never folds; an org without a logo keeps main's wordmark at every width - its only mark; and no fold reaches sm (8 bars)", async () => {
    let checked = 0;
    for (const logo of [false, true]) {
      for (const shape of SHAPES) {
        const where = JSON.stringify({ ...shape, logo });
        const html = await renderShape({ ...shape, logo });
        const cls = imgClass(html, WORDMARK_SRC);
        expect(cls, `${where}: the wordmark is in the bar`).toBeDefined();
        expect(html, `${where}: named "Seazn Club"`).toMatch(new RegExp(`<img\\b[^>]*\\bsrc="${escapeRe(WORDMARK_SRC)}"[^>]*\\balt="Seazn Club"`));
        const toks = tokens(cls);
        expect(toks.filter((t) => /(?:^|:)hidden$/.test(t)), `${where}: never display:none - the screen reader still hears "Seazn Club"`).toEqual([]);
        if (logo) {
          expect(toks.filter((t) => /^max-\[\d+px\]:sr-only$/.test(t)), `${where}: exactly one fold`).toHaveLength(1);
          expect(toks, `${where}: still drawn 28px tall at its own ratio where it shows`).toEqual(expect.arrayContaining(["h-7", "w-auto"]));
          // Folds only where it must: the bar fits WITH the wordmark from 322 (28 x 3 + 200 + 38), so the fold stops by the 360
          // matrix width - a fold reaching further up (say `max-[639px]`) would take the mark from phones that have room for it.
          expect(wordmarkFoldBelow(cls), `${where}: the fold stops by 360 - from there the wordmark fits beside the crest`).toBeLessThanOrEqual(360);
          const crest = tokens(imgClass(html, LOGO_URL));
          expect(crest.length, `${where}: the crest is in the bar`).toBeGreaterThan(0);
          expect(crest.filter((t) => /(?:hidden|sr-only)$/.test(t)), `${where}: the crest never folds - it is the club's mark`).toEqual([]);
        } else {
          expect(toks, `${where}: main's class, untouched`).toEqual(["h-7", "w-auto"]);
        }
        checked++;
      }
    }
    expect(checked).toBe(2 * SHAPES.length);
  });
});
