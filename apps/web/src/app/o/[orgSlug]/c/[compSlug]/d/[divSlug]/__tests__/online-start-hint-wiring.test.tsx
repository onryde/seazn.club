// Owner staging test 2026-10-19: on the Fixtures tab of an online (Lichess) chess division that has not been started,
// the organiser saw nothing where the Open round controls go, and no hint why. `listOpenRounds` answers [] until the
// division starts (a round cannot be opened before it), so the stage cards could not tell "not started" from "nothing
// left to open".
//
// The division page hands the stage cards `onlineAwaitsStart`: an organiser who can act on a chess division's fixtures tab,
// online play = Lichess now, the club offered online chess, plus the shared "not started" predicate (`divisionScoringClosed`,
// division-phase.ts - what the Start button, the scoring door and the open-round guard ask). Phase 2 (spec
// 2026-10-24-arbiter-round-column-design.md §8) moved the Open round control into the Arbiter Panel, so the cards no longer
// get the rounds map; the hint STAYS, because the Start button is on this tab. This suite drives the REAL page with each gate
// flipped alone, and the start itself. Same scaffold as online-chess-flag-wiring.test.tsx beside it: no jsdom, the async
// server component called directly, its returned tree walked, the flag asked through the real helper with PostHog doubled at
// its boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({
  sport_key: "boardgame",
  onlinePlay: "off" as "off" | "lichess",
  status: "setup" as "setup" | "scheduled" | "active" | "completed",
}));
const comp = vi.hoisted(() => ({ frozen: false }));
const fx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
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


import DivisionPage from "../page";
import { ArbiterEntryCard } from "@/components/v2/arbiter-entry-card";
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
  return panels[0]!.props as { onlineAwaitsStart?: unknown };
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
  asked.offered.mockReset();
  division.sport_key = "boardgame";
  division.onlinePlay = "lichess";
  division.status = "setup";
  comp.frozen = false;
  fx.rows = [];
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
const FIXTURE = {
  id: "f1",
  stage_id: "st-1",
  status: "scheduled",
  scheduled_at: null,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  home_slot_label: null,
  away_slot_label: null,
  outcome: null,
  round_no: 1,
  seq_in_round: 1,
};

describe("division page: the stage cards are told the online division has not started", () => {
  it("the start hint stays on the stage card when the division has not started: every status, the hint is wanted before the start and gone after it - and no rounds map is handed down in any of them", async () => {
    let checked = 0;
    for (const status of Object.keys(AWAITS_START) as DivisionStatus[]) {
      division.status = status;
      const props = await panelProps();
      expect(props.onlineAwaitsStart, `${status}: told as a boolean, not left undefined`).toBe(AWAITS_START[status]);
      // The Open round control moved into the panel: there is no such prop to hand down, even an empty one.
      expect("openRounds" in props, `${status}: the stage cards take no rounds`).toBe(false);
      checked++;
    }
    expect(checked).toBe(Object.keys(AWAITS_START).length);
    expect(checked, "anti-vacuity: all four statuses swept").toBe(4);
  });

  it("the sequence: not started, then started - the same division, the hint goes and the entry card names the round to open", async () => {
    fx.rows = [FIXTURE];
    division.status = "scheduled";
    expect((await panelProps()).onlineAwaitsStart).toBe(true);
    division.status = "active";
    queue.listOpenRounds.mockResolvedValue([{ stageId: "s1", roundNo: 1, deadlineAt: null, press: "open" }]);
    const tree = await renderPage();
    expect((findAll(tree, StagesPanel)[0]!.props as { onlineAwaitsStart?: unknown }).onlineAwaitsStart).toBe(false);
    const entry = findAll(tree, ArbiterEntryCard);
    expect(entry).toHaveLength(1);
    expect((entry[0]!.props as { line: unknown }).line).toEqual({ kind: "ready", roundNo: 1 });
  });

  it("one flag answer feeds both: a not-started division with fixtures asks the flag helper once, and gets the hint AND the card", async () => {
    fx.rows = [FIXTURE];
    division.status = "setup";
    const tree = await renderPage();
    expect(asked.offered, "the helper, once per render (PostHog's own cache would hide a second ask)").toHaveBeenCalledTimes(1);
    expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(1);
    expect((findAll(tree, StagesPanel)[0]!.props as { onlineAwaitsStart?: unknown }).onlineAwaitsStart).toBe(true);
    expect(findAll(tree, ArbiterEntryCard)).toHaveLength(1);
  });

  it("not started and nothing generated yet: the hint (there is a Start to press), but no entry card - there is no board to watch", async () => {
    fx.rows = [];
    division.status = "setup";
    const tree = await renderPage();
    expect((findAll(tree, StagesPanel)[0]!.props as { onlineAwaitsStart?: unknown }).onlineAwaitsStart).toBe(true);
    expect(findAll(tree, ArbiterEntryCard)).toHaveLength(0);
    expect(asked.offered, "asked for the hint alone, once").toHaveBeenCalledTimes(1);
    expect(flags.isServerFeatureEnabled).toHaveBeenCalledTimes(1);
  });

  it("each gate alone: online play off, the club not offered online chess, PostHog down, a viewer, a billing-frozen organiser, another sport - never told", async () => {
    const cells: [string, () => void][] = [
      ["online play is off", () => (division.onlinePlay = "off")],
      ["the club is not offered online chess", () => flagOff()],
      ["PostHog throws (fails closed)", () => {
        vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
        forgetOnlineChessFlagCache();
        flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("down"));
      }],
      ["a viewer who cannot edit", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false })],
      ["a billing-frozen organiser (the stage cards' controls are editable's)", () => (comp.frozen = true)],
      ["another sport", () => (division.sport_key = "generic")],
    ];
    let checked = 0;
    for (const [label, arm] of cells) {
      division.sport_key = "boardgame";
      division.onlinePlay = "lichess";
      division.status = "setup"; // not started: the hint WOULD show if the gates passed
      comp.frozen = false;
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
