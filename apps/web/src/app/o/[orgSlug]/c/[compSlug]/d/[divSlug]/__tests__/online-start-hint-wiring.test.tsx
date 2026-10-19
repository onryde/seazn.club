// Owner staging test 2026-10-19: on the Fixtures tab of an online (Lichess) chess division that has not been started,
// the organiser saw nothing where the Open round controls go, and no hint why. `listOpenRounds` answers [] until the
// division starts (a round cannot be opened before it), so the stage cards could not tell "not started" from "nothing
// left to open".
//
// The division page now hands the stage cards `onlineAwaitsStart`: the SAME gates that decide `openRounds` (an organiser
// who can act on a chess division's fixtures tab, online play = Lichess now, the club offered online chess) plus the
// shared "not started" predicate (`divisionScoringClosed`, division-phase.ts — what the Start button, the scoring door
// and the open-round guard ask). This suite drives the REAL page with each gate flipped alone, and the start itself.
// Same scaffold as online-chess-flag-wiring.test.tsx beside it: no jsdom, the async server component called directly,
// its returned tree walked, the flag asked through the real helper with PostHog doubled at its boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({
  sport_key: "boardgame",
  onlinePlay: "off" as "off" | "lichess",
  status: "setup" as "setup" | "scheduled" | "active" | "completed",
}));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
const queue = vi.hoisted(() => ({
  listNeedsOrganiserExternalPlay: vi.fn(),
  listFlaggedExternalPlay: vi.fn(),
  listRunSheetOnlinePlay: vi.fn(),
  listOpenRounds: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" })),
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
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: async () => ({}) }));
vi.mock("@/server/external-play/camera-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/camera-policy")>();
  return { ...actual, competitionCameraPolicy: vi.fn(async () => "off") };
});
// The queue's and the run sheet's reads are database reads; the flag helper beside them stays REAL.
vi.mock("@/server/usecases/external-play", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/external-play")>();
  return { ...actual, ...queue };
});
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: flags.isServerFeatureEnabled };
});


import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import type { DivisionStatus } from "@/lib/division-phase";

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
const renderPage = (tab = "fixtures") =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });
const panelProps = async (tab = "fixtures") => {
  const panels = findAll(await renderPage(tab), StagesPanel);
  expect(panels, `${tab}: the stage panel mounts once`).toHaveLength(1);
  return panels[0]!.props as { onlineAwaitsStart?: unknown; openRounds?: unknown };
};

function flagOn() {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockResolvedValue(true);
}
function flagOff() {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockResolvedValue(false);
}

beforeEach(() => {
  division.sport_key = "boardgame";
  division.onlinePlay = "lichess";
  division.status = "setup";
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listOpenRounds.mockReset().mockResolvedValue([]);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  queue.listFlaggedExternalPlay.mockReset().mockResolvedValue({ boards: [], ownBoards: 0 });
  queue.listRunSheetOnlinePlay.mockReset().mockResolvedValue({});
  forgetOnlineChessFlagCache();
  flagOn();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// The rulebook, not the predicate under test: a division is started once it is active (and stays so when completed);
// setup and scheduled have not been started (division-phase.ts: "scoring opens only after the explicit start").
const AWAITS_START: Record<DivisionStatus, boolean> = { setup: true, scheduled: true, active: false, completed: false };

describe("division page: the stage cards are told the online division has not started", () => {
  it("every status: the hint is wanted before the start and gone after it (and the rounds map follows the start)", async () => {
    let checked = 0;
    for (const status of Object.keys(AWAITS_START) as DivisionStatus[]) {
      division.status = status;
      const props = await panelProps();
      expect(props.onlineAwaitsStart, `${status}: told as a boolean, not left undefined`).toBe(AWAITS_START[status]);
      // The map is the existing gate's: handed down (empty or not) for every status of an online division.
      expect(props.openRounds, `${status}: the rounds map is still the existing gates' answer`).toEqual({});
      checked++;
    }
    expect(checked).toBe(Object.keys(AWAITS_START).length);
    expect(checked, "anti-vacuity: all four statuses swept").toBe(4);
  });

  it("the sequence: not started, then started — the same division, the hint goes and the rounds arrive", async () => {
    division.status = "scheduled";
    expect((await panelProps()).onlineAwaitsStart).toBe(true);
    division.status = "active";
    queue.listOpenRounds.mockResolvedValue([{ stageId: "s1", roundNo: 1 }]);
    const started = await panelProps();
    expect(started.onlineAwaitsStart).toBe(false);
    expect(started.openRounds).toEqual({ s1: [{ stageId: "s1", roundNo: 1 }] });
  });

  it("each gate alone: online play off, the club not offered online chess, PostHog down, a viewer, another sport — never told", async () => {
    const cells: [string, () => void][] = [
      ["online play is off", () => (division.onlinePlay = "off")],
      ["the club is not offered online chess", () => flagOff()],
      ["PostHog throws (fails closed)", () => {
        vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
        forgetOnlineChessFlagCache();
        flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("down"));
      }],
      ["a viewer who cannot edit", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false })],
      ["another sport", () => (division.sport_key = "generic")],
    ];
    let checked = 0;
    for (const [label, arm] of cells) {
      division.sport_key = "boardgame";
      division.onlinePlay = "lichess";
      division.status = "setup"; // not started: the hint WOULD show if the gates passed
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      flagOn();
      arm();
      const props = await panelProps();
      expect(props.onlineAwaitsStart, label).toBe(false);
      checked++;
    }
    expect(checked).toBe(cells.length);
  });

  it("the Settings tab mounts no stage panel at all (nothing to hint at)", async () => {
    division.status = "setup";
    expect(findAll(await renderPage("settings"), StagesPanel)).toHaveLength(0);
  });
});
