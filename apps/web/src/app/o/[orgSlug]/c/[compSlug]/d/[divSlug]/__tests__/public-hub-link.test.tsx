// T2 (owner approved 2026-09-17): the division page's "View Public Page"
// button goes to the HUB scoped to this division, not to the old standalone
// division page. `/shared/<org>/<comp>?tab=matches&division=<divSlug>` — both
// spellings read from the hub itself: "matches" is one of `deriveHubTabs`'
// ids (`lib/matches-hub.ts:212,243`) and `?division=` is what
// `readDivisionParam`/`useDivisionParam` (`use-tab-param.ts:172,192`) read and
// `competition-landing.tsx:328` seeds into the Matches tab.
//
// Match Day C5b (owner approved 2026-11-01): Slideshow, View Public Page and QR
// are no longer three buttons in the header - they are the items of ONE
// `DeskOpenMenu` (the competition page's "Open" menu, same component). So the
// public link is read off that element's `items` prop, not found as a host `<a>`
// in the page's own tree (the `<a>` is rendered inside the client island), and
// this file also pins what C5b decided about the division page: one menu at every
// width (it has no phone fold to defer to), no Match Day item, and nothing left
// top-level. Same mock scaffold and the same tree walk as
// registration-hub-link.test.tsx beside it: no jsdom in this workspace, so
// the async server component is called directly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
const competitionsSpy = vi.hoisted(() => ({ getCompetition: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);
vi.mock("@/server/usecases/competitions", () => competitionsSpy);

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async () => ({})),
  t: (_dict: unknown, key: string) => key,
}));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: "active",
    sport_key: "generic",
    variant_key: "score",
    module_version: "1.0.0",
    config: {},
    tiebreakers: undefined,
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({
  divisionConsumesSlotOnArchive: vi.fn(async () => false),
}));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
// Task 14 P1: the fixtures tab resolves the checkout's currency (`preferredCurrency` reads cookies/headers), which has
// no request scope in a direct page call. Not what this suite pins.
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "gbp") }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: null,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: () => [],
  })),
}));
vi.mock("@/server/usecases/discipline", () => ({
  getDisciplineRules: vi.fn(async () => null),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
}));
const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));
// Spec 2026-09-30 §2 (T6): the fixtures tab's one stream read is `openStreamStates` (the run sheet's chip) — this page
// test is not about streaming, so it is an empty double.
vi.mock("@/server/usecases/stream-sessions", () => ({
  openStreamStates: async () => ({}),
}));

import DivisionPage from "../page";
import Link from "@/components/ui/console-link";
import { DeskOpenMenu, type DeskOpenItem } from "@/components/v2/desk/desk-open-menu";
import { routes } from "@/lib/routes";

/** Depth-first search of a returned server-component tree, collecting EVERY
 *  element of the given type — copied from registration-hub-link.test.tsx in
 *  this same dir. */
function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, type, out);
  return out;
}

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

const renderPage = () =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "fixtures" }),
  });

/** Every element of the tree in document order, so "before" means before on screen. */
function walkAll(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) walkAll(child as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  walkAll((node.props as { children?: ReactNode }).children, out);
  return out;
}

/** The Open menu elements the page renders. */
const openMenus = (tree: ReactNode): ReactElement[] => findAll(tree, DeskOpenMenu);
const itemsOf = (menu: ReactElement): DeskOpenItem[] => (menu.props as { items: DeskOpenItem[] }).items;
const hrefOf = (id: DeskOpenItem["id"], items: DeskOpenItem[]): string | undefined => items.find((i) => i.id === id)?.href;

/** Every public-site `<a>` the page renders ITSELF (outside the Open menu's island). Since C5b there are none: the public
 *  page link and the poster PDF are menu items. */
const topLevelPublicLinks = (tree: ReactNode): string[] =>
  findAll(tree, "a")
    .map((el) => (el.props as { href?: string }).href ?? "")
    .filter((href) => href.startsWith("/shared/"));

const publicCompetition = { id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" };
const privateCompetition = { ...publicCompetition, visibility: "private" };

describe("division page — View Public Page opens the hub, this division selected", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
    competitionsSpy.getCompetition.mockReset().mockResolvedValue(publicCompetition);
  });

  it("points at the hub's Matches tab with ?division=, not at the old /shared/<org>/<comp>/<div> page", async () => {
    const menus = openMenus(await renderPage());
    expect(menus.length, "one Open menu").toBe(1);
    const items = itemsOf(menus[0]!);
    expect(hrefOf("public", items)).toBe("/shared/org/comp-one?tab=matches&division=div");
    // The OLD target, named so this test fails if the href goes back to it:
    // the standalone division page is slated for a 308 into the hub.
    expect(items.map((i) => i.href)).not.toContain("/shared/org/comp-one/div");
  });

  it("is absent on a private competition, like the other public links beside it", async () => {
    competitionsSpy.getCompetition.mockResolvedValue(privateCompetition);
    const menus = openMenus(await renderPage());
    expect(menus.length, "positive pair: the Open menu is still there, holding Slideshow").toBe(1);
    const items = itemsOf(menus[0]!);
    expect(items.filter((i) => i.href.includes("?tab=matches"))).toEqual([]);
    expect(items.map((i) => i.id)).toEqual(["slideshow"]);
  });
});

// Match Day C5b: the division page's three "look at it" tools are ONE Open menu, the competition page's component.
describe("division page — Slideshow, View Public Page and QR fold into one Open menu (C5b)", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
    competitionsSpy.getCompetition.mockReset().mockResolvedValue(publicCompetition);
  });

  it("the menu holds the three tools in order, each with the href, new tab, name, arrow and element it had as a button", async () => {
    const tree = await renderPage();
    const menus = openMenus(tree);
    expect(menus.length).toBe(1);
    const items = itemsOf(menus[0]!);
    // t() is the identity in this suite, so a label IS its dictionary key: the existing keys, no new copy.
    expect(items).toEqual([
      {
        id: "slideshow",
        label: "action.slideshow",
        ariaLabel: "aria.slideshowNewTab",
        href: routes.slideshowDivision("div-1"),
        newTab: true,
        arrow: true,
      },
      {
        id: "public",
        label: "action.viewPublic",
        ariaLabel: "aria.viewPublic",
        href: "/shared/org/comp-one?tab=matches&division=div",
        newTab: true,
        arrow: true,
        plainAnchor: true,
      },
      {
        id: "qr",
        label: "action.qr",
        ariaLabel: "aria.qrPoster",
        href: "/shared/org/comp-one/poster.pdf?division=div",
        newTab: true,
        arrow: true,
        plainAnchor: true,
      },
    ]);
    expect((menus[0]!.props as { label: string }).label).toBe("desk.tools.open");
  });

  // Owner 2026-11-01: QR opens a new tab like the other two but was the one item without the ↗ mark. The rule is stated as
  // "new tab => marked", not as three literals, so a fourth new-tab item cannot be added unmarked.
  it("every item that opens a new tab carries the ↗ mark, QR included", async () => {
    const items = itemsOf(openMenus(await renderPage())[0]!);
    const newTab = items.filter((i) => i.newTab);
    expect(newTab.map((i) => i.id), "anti-vacuity: all three tools open a new tab").toEqual(["slideshow", "public", "qr"]);
    for (const i of newTab) expect(i.arrow, `${i.id} is marked`).toBe(true);
  });

  it("leaves NOTHING top-level: no public-site <a>, no Slideshow Link beside the menu (each destination once, at every width)", async () => {
    const tree = await renderPage();
    expect(openMenus(tree).length, "positive pair: the menu rendered").toBe(1);
    expect(topLevelPublicLinks(tree)).toEqual([]);
    const slideshowLinks = findAll(tree, Link).filter((el) => ((el.props as { href: string }).href ?? "").includes("/slideshow/"));
    expect(slideshowLinks).toEqual([]);
  });

  it("is visible at every width: the division page has no phone fold to defer to, so the menu carries no hide class", async () => {
    const menus = openMenus(await renderPage());
    const className = String((menus[0]!.props as { className?: string }).className ?? "");
    expect(className).not.toMatch(/(^|\s)(max-[a-z]+:)?hidden(\s|$)/);
    expect(className).not.toMatch(/\bmd:hidden\b/);
  });

  it("on a phone the panel opens as a full-width sheet under the header row, because the trigger's x depends on how the title wraps", async () => {
    const menus = openMenus(await renderPage());
    const p = menus[0]!.props as { className?: string; panelClassName?: string };
    expect(p.className).toContain("max-md:static");
    expect(p.panelClassName).toContain("max-md:inset-x-0");
    expect(p.panelClassName).toContain("max-md:w-auto");
  });

  it("Open takes Slideshow's place: before the Registration link, which stays its own button", async () => {
    const all = walkAll(await renderPage());
    const openAt = all.findIndex((el) => el.type === DeskOpenMenu);
    const regAt = all.findIndex((el) => el.type === Link && String((el.props as { href?: string }).href ?? "").includes("/registration"));
    expect(openAt, "Open is in the page").toBeGreaterThanOrEqual(0);
    expect(regAt, "Registration is in the page").toBeGreaterThanOrEqual(0);
    expect(openAt, "Open leads Registration").toBeLessThan(regAt);
  });

  it("invents no Match Day item: the division page never linked Match Day from its header", async () => {
    const items = itemsOf(openMenus(await renderPage())[0]!);
    expect(items.map((i) => i.id)).not.toContain("matchday");
    expect(items.some((i) => i.href.includes("/match-day"))).toBe(false);
  });

  // Gated exactly as before: Slideshow always, the public page and the QR poster only with a non-private competition; none of it on
  // canEdit (a view-only member saw all three buttons).
  it.each([
    { visibility: "public", canEdit: true, want: ["slideshow", "public", "qr"] },
    { visibility: "public", canEdit: false, want: ["slideshow", "public", "qr"] },
    { visibility: "private", canEdit: true, want: ["slideshow"] },
    { visibility: "private", canEdit: false, want: ["slideshow"] },
  ])("a $visibility competition for canEdit=$canEdit offers $want", async ({ visibility, canEdit, want }) => {
    competitionsSpy.getCompetition.mockResolvedValue({ ...publicCompetition, visibility });
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit });
    const menus = openMenus(await renderPage());
    expect(menus.length).toBe(1);
    expect(itemsOf(menus[0]!).map((i) => i.id)).toEqual(want);
  });
});
