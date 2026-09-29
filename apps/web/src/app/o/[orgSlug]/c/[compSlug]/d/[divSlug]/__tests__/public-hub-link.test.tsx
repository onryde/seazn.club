// T2 (owner approved 2026-09-17): the division page's "View Public Page"
// button goes to the HUB scoped to this division, not to the old standalone
// division page. `/shared/<org>/<comp>?tab=matches&division=<divSlug>` — both
// spellings read from the hub itself: "matches" is one of `deriveHubTabs`'
// ids (`lib/matches-hub.ts:212,243`) and `?division=` is what
// `readDivisionParam`/`useDivisionParam` (`use-tab-param.ts:172,192`) read and
// `competition-landing.tsx:328` seeds into the Matches tab.
//
// The button is a plain `<a target="_blank">`, NOT the console `Link` the
// registration-hub test walks for, so this finder asks for the "a" type and
// filters on `/shared/`. Same mock scaffold and the same tree walk as
// registration-hub-link.test.tsx beside it: no jsdom in this workspace, so
// the async server component is called directly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
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
    defaultTiebreakers: [],
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

import DivisionPage from "../page";

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

/** Every public-site link on the page. The poster PDF (`poster.pdf?division=`)
 *  is one of them, so the assertions below name the href they want rather
 *  than taking the first hit. */
const publicLinks = (tree: ReactNode): string[] =>
  findAll(tree, "a")
    .map((el) => (el.props as { href?: string }).href ?? "")
    .filter((href) => href.startsWith("/shared/"));

describe("division page — View Public Page opens the hub, this division selected", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
    competitionsSpy.getCompetition
      .mockReset()
      .mockResolvedValue({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" });
  });

  it("points at the hub's Matches tab with ?division=, not at the old /shared/<org>/<comp>/<div> page", async () => {
    const links = publicLinks(await renderPage());
    expect(links).toContain("/shared/org/comp-one?tab=matches&division=div");
    // The OLD target, named so this test fails if the href goes back to it:
    // the standalone division page is slated for a 308 into the hub.
    expect(links).not.toContain("/shared/org/comp-one/div");
  });

  it("is absent on a private competition, like the other public links beside it", async () => {
    competitionsSpy.getCompetition.mockResolvedValue({
      id: "comp-1",
      frozen: false,
      visibility: "private",
      slug: "comp-one",
    });
    const links = publicLinks(await renderPage());
    expect(links.filter((href) => href.includes("?tab=matches"))).toEqual([]);
  });
});
