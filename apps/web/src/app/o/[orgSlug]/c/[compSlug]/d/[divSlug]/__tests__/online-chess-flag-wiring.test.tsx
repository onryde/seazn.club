// T20 — the division page asks the club's online-chess flag (PostHog `online-chess`, fallback off) and hands the
// answer to the island that renders online-chess START controls: DivisionSettings (`onlineChessOffered` — the Online
// play select and the camera control). The islands' own suite (online-chess-flag-controls.test.tsx) proves what the
// prop hides; this one proves the PAGE passes the flag's real answer, asked for this user in this club, and asks nothing
// for a division that is not chess. T16: the needs-a-result queue lost its Resend (the server refuses it for every held
// board, 409 BOARD_HELD) — what is left on it FINISHES play, so it never asks the flag. The one START control on the
// fixtures tab is the Open round control (D12): the flag is asked there only for a division that plays online, and the
// rounds are read and handed down only while the club is offered online chess.
//
// Same scaffold as public-hub-link.test.tsx beside it: no jsdom, the async server component called directly, its
// returned tree walked. The flag is asked through the REAL helper, PostHog doubled at its boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({ sport_key: "boardgame", onlinePlay: "off" as "off" | "lichess" }));
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
    status: "active",
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
import { DivisionSettings } from "@/components/v2/division-settings";
import { ExternalPlayNeedsResultQueue } from "@/components/v2/external-play-needs-result-queue";
import { StagesPanel } from "@/components/v2/stages-panel";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";

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
const renderPage = (tab: string) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

type FlagState = { label: string; offered: boolean; arm: () => void };
const FLAG_STATES: readonly FlagState[] = [
  { label: "flag ON", offered: true, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(true) },
  { label: "flag OFF", offered: false, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(false) },
  { label: "PostHog throws", offered: false, arm: () => flags.isServerFeatureEnabled.mockRejectedValue(new Error("down")) },
];
function flagIs(s: FlagState): void {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset();
  s.arm();
}
const ROW = {
  fixtureId: "f1",
  fixtureNo: 3,
  homeName: "Ann",
  awayName: "Bo",
  scheduledAt: null,
  lastError: null,
};

beforeEach(() => {
  division.sport_key = "boardgame";
  division.onlinePlay = "off";
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listOpenRounds.mockReset().mockResolvedValue([]);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  queue.listFlaggedExternalPlay.mockReset().mockResolvedValue({ boards: [], ownBoards: 0 });
  queue.listRunSheetOnlinePlay.mockReset().mockResolvedValue({});
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("division page: the online-chess flag's answer reaches the islands", () => {
  it("Settings tab of a chess division: DivisionSettings gets the flag's answer, asked for this user in this club", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      const settings = findAll(await renderPage("settings"), DivisionSettings);
      expect(settings, `${s.label}: DivisionSettings mounted once`).toHaveLength(1);
      expect((settings[0]!.props as { onlineChessOffered: unknown }).onlineChessOffered, s.label).toBe(s.offered);
      expect(flags.isServerFeatureEnabled, s.label).toHaveBeenCalledWith("online-chess", "user-1", {
        orgId: "org-1",
        fallback: false,
      });
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("T16 — fixtures tab with a board held AND one flagged (online play off now): the queue gets both lists and the run sheet the chips, whatever the flag says — and the flag is never asked", async () => {
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([ROW]);
    const FLAGGED = { boards: [{ fixtureId: "f2" }], ownBoards: 1 };
    const SHEET = { f1: { cameraPolicy: "off", cameraFlagCount: 0, connectionProblemCount: 0, offSeaznFlagCount: 0, held: "aborted", live: false } };
    queue.listFlaggedExternalPlay.mockResolvedValue(FLAGGED);
    queue.listRunSheetOnlinePlay.mockResolvedValue(SHEET);
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      const tree = await renderPage("fixtures");
      const queues = findAll(tree, ExternalPlayNeedsResultQueue);
      expect(queues, `${s.label}: the queue mounted once`).toHaveLength(1);
      const props = queues[0]!.props as Record<string, unknown>;
      expect([props.held, props.flagged, props.ownFlagged, props.slugs], s.label).toEqual([
        [ROW],
        FLAGGED.boards,
        1,
        { org: "org", comp: "comp", div: "div" },
      ]);
      expect("resendOffered" in props, `${s.label}: no start control on the queue`).toBe(false);
      const panels = findAll(tree, StagesPanel);
      expect((panels[0]!.props as { onlinePlay: unknown }).onlinePlay, `${s.label}: the run sheet's chips`).toBe(SHEET);
      // Asked for THIS division by THIS organiser.
      for (const read of [queue.listNeedsOrganiserExternalPlay, queue.listFlaggedExternalPlay, queue.listRunSheetOnlinePlay]) {
        expect(read, s.label).toHaveBeenLastCalledWith(PAGE.auth, "div-1");
      }
      expect(flags.isServerFeatureEnabled, `${s.label}: never asked on the fixtures tab`).not.toHaveBeenCalled();
      expect(queue.listOpenRounds, `${s.label}: no round to open off-line`).not.toHaveBeenCalled();
      expect((panels[0]!.props as { openRounds?: unknown }).openRounds, s.label).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("T16 (D12) — fixtures tab of a division that plays ONLINE: the rounds to open reach the stage cards only while the club is offered online chess", async () => {
    division.onlinePlay = "lichess";
    const R1 = { stageId: "s1", roundNo: 2 };
    const R2 = { stageId: "s2", roundNo: 1 };
    const R3 = { stageId: "s1", roundNo: 3 };
    queue.listOpenRounds.mockResolvedValue([R1, R2, R3]);
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      queue.listOpenRounds.mockClear();
      const panels = findAll(await renderPage("fixtures"), StagesPanel);
      const openRounds = (panels[0]!.props as { openRounds?: unknown }).openRounds;
      expect(flags.isServerFeatureEnabled, s.label).toHaveBeenCalledWith("online-chess", "user-1", { orgId: "org-1", fallback: false });
      if (s.offered) {
        // Grouped by stage, each stage's rounds in the reader's order.
        expect(openRounds, s.label).toEqual({ s1: [R1, R3], s2: [R2] });
        expect(queue.listOpenRounds, s.label).toHaveBeenLastCalledWith(PAGE.auth, "div-1");
      } else {
        expect(openRounds, `${s.label}: no control, not even disabled`).toBeUndefined();
        expect(queue.listOpenRounds, `${s.label}: nothing read`).not.toHaveBeenCalled();
      }
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("T16 (D12) — the empty case: an online division with no round to open hands the stage cards an EMPTY map, not undefined", async () => {
    division.onlinePlay = "lichess";
    flagIs(FLAG_STATES[0]!);
    const panels = findAll(await renderPage("fixtures"), StagesPanel);
    expect((panels[0]!.props as { openRounds?: unknown }).openRounds).toEqual({});
  });

  it("T16 — the empty case: a chess fixtures tab with nothing held or flagged still mounts the queue (it renders nothing), and asks nothing", async () => {
    flagIs(FLAG_STATES[0]!);
    const queues = findAll(await renderPage("fixtures"), ExternalPlayNeedsResultQueue);
    expect(queues).toHaveLength(1);
    expect((queues[0]!.props as { held: unknown }).held).toEqual([]);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });

  it("T16 — not chess, or a viewer: no queue, and none of the three reads", async () => {
    const cells: [string, () => void][] = [
      ["another sport", () => (division.sport_key = "generic")],
      ["a viewer", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false })],
    ];
    let checked = 0;
    for (const [label, arm] of cells) {
      division.sport_key = "boardgame";
      division.onlinePlay = "lichess";
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      for (const read of Object.values(queue)) read.mockClear();
      arm();
      expect(findAll(await renderPage("fixtures"), ExternalPlayNeedsResultQueue), label).toHaveLength(0);
      for (const read of Object.values(queue)) expect(read, label).not.toHaveBeenCalled();
      expect(flags.isServerFeatureEnabled, `${label}: no flag asked`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(cells.length);
  });

  it("not chess: DivisionSettings gets false and the flag is never asked", async () => {
    division.sport_key = "generic";
    flagIs(FLAG_STATES[0]!);
    const settings = findAll(await renderPage("settings"), DivisionSettings);
    expect(settings).toHaveLength(1);
    expect((settings[0]!.props as { onlineChessOffered: unknown }).onlineChessOffered).toBe(false);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });

});
