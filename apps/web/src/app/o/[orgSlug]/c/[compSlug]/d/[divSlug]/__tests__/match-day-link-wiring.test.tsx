// Match Day B2 (spec 2026-10-31 §9: "Unscheduled fixtures link to the free-court candidate list"). The run sheet's "Find a
// court" link is only as real as the prop the division page hands the stage panel: `matchDayHref`, set on a match day for an
// organiser, on the fixtures tab, and nowhere else. A row-level test proves the row; this drives the REAL page (the async server
// component called directly, its returned tree walked) with each gate flipped alone, and the day's count asked through the one
// rule the competition page's Open Match Day asks (`needsYouHome`, left REAL here; only the database read is doubled).
//
// The href reads the tab, the editing gate and the day's count, never the sport, so those cases run on one sport (generic). The
// sport enters the link by another road (fix round 1, I1: the word is the sport's playing area - pitch, board - chosen by the stage
// panel from the `sportKey` this page hands it), and the last describe drives that hand-off per sport. Same scaffold as
// online-start-hint-wiring.test.tsx beside it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({
  sport_key: "generic",
  onlinePlay: "off" as "off" | "lichess",
  status: "setup" as "setup" | "scheduled" | "active" | "completed",
}));
const comp = vi.hoisted(() => ({ frozen: false }));
const fx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const today = vi.hoisted(() => ({ count: vi.fn() }));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
// The helper itself, counted: its 60s PostHog cache hides a duplicated `await onlineChessOffered(...)` one layer down.
const asked = vi.hoisted(() => ({ offered: vi.fn() }));
const queue = vi.hoisted(() => ({
  listNeedsOrganiserExternalPlay: vi.fn(),
  listFlaggedExternalPlay: vi.fn(),
  listRunSheetOnlinePlay: vi.fn(),
  listOpenRounds: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => []),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: comp.frozen, visibility: "public", slug: "comp-one" })),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async () => ({})),
  t: (_dict: unknown, key: string) => key,
}));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: division.status,
    sport_key: division.sport_key,
    variant_key: division.sport_key === "boardgame" ? "classical" : "score",
    module_version: "1.0.0",
    config: division.sport_key === "boardgame" ? { variant: "classical", onlinePlay: division.onlinePlay } : {},
    tiebreakers: undefined,
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
    camera_policy: null,
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({ divisionConsumesSlotOnArchive: vi.fn(async () => false) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => fx.rows),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
// The Settings tab also reads who holds no Lichess link (the online-switch warning, online-chess-flag-wiring.test.tsx owns it).
vi.mock("@/server/usecases/entrants", () => ({
  listEntrants: vi.fn(async () => []),
  listLichessLinkGaps: vi.fn(async () => ({ unlinked: [], reconnect: [], empty: [] })),
}));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
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
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: async () => ({}) }));
vi.mock("@/server/external-play/camera-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/camera-policy")>();
  return { ...actual, competitionCameraPolicy: vi.fn(async () => "off") };
});
// The queue's and the run sheet's reads are database reads; the flag helper beside them stays REAL.
vi.mock("@/server/usecases/external-play", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/external-play")>();
  return {
    ...actual,
    ...queue,
    // The REAL helper, seen through a spy.
    onlineChessOffered: (asker: Parameters<typeof actual.onlineChessOffered>[0]) => {
      asked.offered(asker);
      return actual.onlineChessOffered(asker);
    },
  };
});
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: flags.isServerFeatureEnabled };
});


vi.mock("@/server/usecases/match-day", () => ({ competitionFixturesToday: today.count }));

import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";
import { routes } from "@/lib/routes";
import { needsYouHome } from "@/components/v2/desk/needs-you";

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
const MATCH_DAY = routes.competitionMatchDay("org", "comp");
const renderPage = (tab = "fixtures") =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });
const panelHref = async (tab = "fixtures") => {
  const panels = findAll(await renderPage(tab), StagesPanel);
  expect(panels, `${tab}: the stage panel mounts once`).toHaveLength(1);
  return (panels[0]!.props as { matchDayHref?: unknown }).matchDayHref;
};

beforeEach(() => {
  division.sport_key = "generic";
  division.status = "active";
  comp.frozen = false;
  fx.rows = [];
  today.count.mockReset().mockResolvedValue(0);
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listOpenRounds.mockReset().mockResolvedValue([]);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  queue.listFlaggedExternalPlay.mockReset().mockResolvedValue({ boards: [], ownBoards: 0 });
  queue.listRunSheetOnlinePlay.mockReset().mockResolvedValue({});
  flags.isServerFeatureEnabled.mockReset().mockResolvedValue(false);
});

describe("division page: the run sheet is told where Match Day is, only on a match day", () => {
  // The empty case first: a day with no match is today's page - no href, no link.
  it("no match today: no href", async () => {
    today.count.mockResolvedValue(0);
    expect(await panelHref()).toBeNull();
    expect(today.count, "positive pair: the day WAS asked, so the null is an answer and not a skipped read").toHaveBeenCalledTimes(1);
  });

  it("a match today: Match Day's address, asked of the competition this division belongs to", async () => {
    today.count.mockResolvedValue(3);
    expect(await panelHref()).toBe(MATCH_DAY);
    expect(today.count.mock.calls[0]![1]).toBe("comp-1");
  });

  it("the boundary is the competition page's: every count the one rule calls a match day gets the href, none other does", async () => {
    let checked = 0;
    for (const n of [0, 1, 2, 7, 100]) {
      today.count.mockResolvedValue(n);
      // Expected from the rule itself, not retyped: the competition page's Open Match Day asks this same function.
      expect(await panelHref(), `fixtures today = ${n}`).toBe(needsYouHome(n) === "match_day" ? MATCH_DAY : null);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("a viewer is handed nothing and the day is not even read for them (Match Day 404s for anyone who cannot edit)", async () => {
    today.count.mockResolvedValue(3);
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    expect(await panelHref()).toBeNull();
    expect(today.count).not.toHaveBeenCalled();
  });

  it("a billing-frozen competition is read-only, as Set time beside the link is: nothing to hand down", async () => {
    today.count.mockResolvedValue(3);
    comp.frozen = true;
    expect(await panelHref()).toBeNull();
    expect(today.count).not.toHaveBeenCalled();
  });

  it("the sequence: no match, then a match - the same page reads the day afresh each time", async () => {
    today.count.mockResolvedValue(0);
    expect(await panelHref()).toBeNull();
    today.count.mockResolvedValue(1);
    expect(await panelHref()).toBe(MATCH_DAY);
    today.count.mockResolvedValue(0);
    expect(await panelHref()).toBeNull();
  });

  it("no other tab draws the run sheet, so none asks the day", async () => {
    today.count.mockResolvedValue(3);
    await renderPage("standings");
    expect(today.count).not.toHaveBeenCalled();
  });
});

describe("division page: the run sheet's Find link is worded for the division's sport", () => {
  // The page's whole part is handing the panel the division's sport; the panel picks the noun (stages-panel-find-court-noun.test.tsx
  // renders the real panel per registered sport). A page that dropped or mis-keyed `sportKey` would say "court" in a football
  // division with every other test here green.
  it("football and chess (boardgame) divisions: the panel is handed that sport and the match day's href", async () => {
    today.count.mockResolvedValue(3);
    const seen: Array<{ sportKey: unknown; matchDayHref: unknown }> = [];
    for (const sport of ["football", "boardgame", "generic"]) {
      division.sport_key = sport;
      const panels = findAll(await renderPage("fixtures"), StagesPanel);
      expect(panels, sport).toHaveLength(1);
      const props = panels[0]!.props as { sportKey?: unknown; matchDayHref?: unknown };
      seen.push({ sportKey: props.sportKey, matchDayHref: props.matchDayHref });
    }
    expect(seen).toEqual([
      { sportKey: "football", matchDayHref: MATCH_DAY },
      { sportKey: "boardgame", matchDayHref: MATCH_DAY },
      { sportKey: "generic", matchDayHref: MATCH_DAY },
    ]);
  });
});
