// T20 - the division page asks the club's online-chess flag (PostHog `online-chess`, fallback off) and hands the
// answer to the island that renders online-chess START controls: DivisionSettings (`onlineChessOffered` - the Online
// play select and the camera control). The islands' own suite (online-chess-flag-controls.test.tsx) proves what the
// prop hides; this one proves the PAGE passes the flag's real answer, asked for this user in this club, and asks nothing
// for a division that is not chess. T16: the needs-a-result queue lost its Resend (the server refuses it for every held
// board, 409 BOARD_HELD) - what is left on it FINISHES play, so it never asks the flag.
//
// Phase 2 (spec 2026-10-24-arbiter-round-column-design.md §7, §8): the round is opened in the Arbiter Panel now. Where the panel
// would answer (a chess division that plays online, has fixtures, and whose club is offered online chess) the fixtures tab
// carries ONE entry card and neither the queue nor an Open round on any stage card; where it would not (online play off, or the
// flag off), the queue stays on the tab (T20: a board held before online play was switched off is still owed its decision),
// without its link into the panel, and the flag is asked only where it can decide something.
//
// Same scaffold as public-hub-link.test.tsx beside it: no jsdom, the async server component called directly, its
// returned tree walked. The flag is asked through the REAL helper, PostHog doubled at its boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({ sport_key: "boardgame", onlinePlay: "off" as "off" | "lichess" }));
const fx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
// The division's resolved venue zone, as `getScheduleSettings` serves it (the division's own override, else the club's).
const schedule = vi.hoisted(() => ({ tz: "UTC" }));
// Who holds no Lichess link (the online-switch warning): the real page hands DivisionSettings a summary of this list.
const unlinked = vi.hoisted(() => ({ read: vi.fn() }));
const NO_GAPS = { unlinked: [], reconnect: [], empty: [] };
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
  listDivisionFixtures: vi.fn(async () => fx.rows),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", () => ({
  listEntrants: vi.fn(async () => []),
  listLichessLinkGaps: unlinked.read,
}));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: schedule.tz })),
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
  return { ...actual, ...queue };
});
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: flags.isServerFeatureEnabled };
});

import DivisionPage from "../page";
import { ArbiterEntryCard } from "@/components/v2/arbiter-entry-card";
import { DivisionSettings } from "@/components/v2/division-settings";
import { ExternalPlayNeedsResultQueue } from "@/components/v2/external-play-needs-result-queue";
import { StagesPanel } from "@/components/v2/stages-panel";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { log } from "@/server/logger";

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
  schedule.tz = "UTC";
  fx.rows = [];
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listOpenRounds.mockReset().mockResolvedValue([]);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  queue.listFlaggedExternalPlay.mockReset().mockResolvedValue({ boards: [], ownBoards: 0 });
  queue.listRunSheetOnlinePlay.mockReset().mockResolvedValue({});
  unlinked.read.mockReset().mockResolvedValue(NO_GAPS);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("not offered: the queue stays, with no panel link - online play off now, a board held AND one flagged: the queue gets both lists and the run sheet the chips, whatever the flag says, and the flag is never asked", async () => {
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([ROW]);
    const FLAGGED = { boards: [{ fixtureId: "f2" }], ownBoards: 1 };
    const SHEET = { f1: { cameraPolicy: "off", cameraFlagCount: 0, connectionProblemCount: 0, offSeaznFlagCount: 0, held: "aborted", live: false } };
    queue.listFlaggedExternalPlay.mockResolvedValue(FLAGGED);
    queue.listRunSheetOnlinePlay.mockResolvedValue(SHEET);
    fx.rows = [FIXTURE];
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      const tree = await renderPage("fixtures");
      const queues = findAll(tree, ExternalPlayNeedsResultQueue);
      expect(queues, `${s.label}: the queue mounted once`).toHaveLength(1);
      const props = queues[0]!.props as Record<string, unknown>;
      expect([props.held, props.flagged, props.ownFlagged], s.label).toEqual([[ROW], FLAGGED.boards, 1]);
      expect("slugs" in props, `${s.label}: nothing to build a panel link from`).toBe(false);
      expect("resendOffered" in props, `${s.label}: no start control on the queue`).toBe(false);
      const panels = findAll(tree, StagesPanel);
      expect((panels[0]!.props as { onlinePlay: unknown }).onlinePlay, `${s.label}: the run sheet's chips`).toBe(SHEET);
      expect((panels[0]!.props as { arbiterHref: unknown }).arbiterHref, `${s.label}: the chips lead nowhere`).toBeNull();
      expect(findAll(tree, ArbiterEntryCard), `${s.label}: no entry card`).toHaveLength(0);
      // Asked for THIS division by THIS organiser.
      for (const read of [queue.listNeedsOrganiserExternalPlay, queue.listFlaggedExternalPlay, queue.listRunSheetOnlinePlay]) {
        expect(read, s.label).toHaveBeenLastCalledWith(PAGE.auth, "div-1");
      }
      expect(flags.isServerFeatureEnabled, `${s.label}: never asked, online play is off`).not.toHaveBeenCalled();
      expect(queue.listOpenRounds, `${s.label}: no round to open off-line`).not.toHaveBeenCalled();
      expect("openRounds" in (panels[0]!.props as object), `${s.label}: the stage cards have no such prop`).toBe(false);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("offered: no Open round on any stage card, no queue, one entry card - and the queue's reads are made once, for the card", async () => {
    division.onlinePlay = "lichess";
    fx.rows = [FIXTURE];
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([ROW]);
    const FLAGGED = { boards: [{ fixtureId: "f2" }], ownBoards: 1 };
    queue.listFlaggedExternalPlay.mockResolvedValue(FLAGGED);
    queue.listOpenRounds.mockResolvedValue([{ stageId: "s1", roundNo: 2 }]);
    flagIs(FLAG_STATES[0]!);
    const tree = await renderPage("fixtures");
    const panels = findAll(tree, StagesPanel);
    expect(panels).toHaveLength(1);
    expect("openRounds" in (panels[0]!.props as object), "no rounds map is handed down, not even an empty one").toBe(false);
    expect(findAll(tree, ExternalPlayNeedsResultQueue), "the queue lives in the panel").toHaveLength(0);
    const entry = findAll(tree, ArbiterEntryCard);
    expect(entry, "one entry card").toHaveLength(1);
    // Two boards need a decision (f1 held, f2 flagged): the card says so; the count is the column title's.
    expect((entry[0]!.props as { line: unknown }).line).toEqual({ kind: "attention", count: 2 });
    for (const read of [queue.listNeedsOrganiserExternalPlay, queue.listFlaggedExternalPlay, queue.listOpenRounds]) {
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenLastCalledWith(PAGE.auth, "div-1");
    }
  });

  it("flag off on a division playing online: no entry card, chip links are spans, the queue stays", async () => {
    division.onlinePlay = "lichess";
    fx.rows = [FIXTURE];
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([ROW]);
    let checked = 0;
    for (const s of [FLAG_STATES[1]!, FLAG_STATES[2]!]) {
      flagIs(s);
      queue.listOpenRounds.mockClear();
      const tree = await renderPage("fixtures");
      expect(findAll(tree, ArbiterEntryCard), s.label).toHaveLength(0);
      expect((findAll(tree, StagesPanel)[0]!.props as { arbiterHref: unknown }).arbiterHref, s.label).toBeNull();
      const queues = findAll(tree, ExternalPlayNeedsResultQueue);
      expect(queues, s.label).toHaveLength(1);
      expect((queues[0]!.props as { held: unknown }).held, s.label).toEqual([ROW]);
      expect(flags.isServerFeatureEnabled, s.label).toHaveBeenCalledWith("online-chess", "user-1", { orgId: "org-1", fallback: false });
      expect(queue.listOpenRounds, `${s.label}: nothing read for a card that is not drawn`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the empty case: a chess Fixtures tab with nothing held, nothing to open and the panel offered: the entry card with the default body, and no queue", async () => {
    division.onlinePlay = "lichess";
    fx.rows = [FIXTURE];
    flagIs(FLAG_STATES[0]!);
    const tree = await renderPage("fixtures");
    const entry = findAll(tree, ArbiterEntryCard);
    expect(entry).toHaveLength(1);
    expect((entry[0]!.props as { line: unknown }).line).toEqual({ kind: "default" });
    expect(findAll(tree, ExternalPlayNeedsResultQueue)).toHaveLength(0);
  });

  it("T16 — the empty case: a chess fixtures tab with nothing held or flagged (online play off) still mounts the queue (it renders nothing), and asks nothing", async () => {
    flagIs(FLAG_STATES[0]!);
    const queues = findAll(await renderPage("fixtures"), ExternalPlayNeedsResultQueue);
    expect(queues).toHaveLength(1);
    expect((queues[0]!.props as { held: unknown }).held).toEqual([]);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-10-25 (follow-up to the Arbiter Panel's D1): the queue reads its times in the VENUE's zone, so the page must hand it
  // the division's resolved venue zone - the same `scheduleSettings.tz` its StagesPanel gets - and not the club's zone (the page's
  // `org.timezone` is "UTC" here) and not a constant. A prop the page never sets would leave the queue on the viewer's clock.
  it("the queue is handed the division's venue zone: the schedule's zone, not the club's, and the same one the stage cards get", async () => {
    let checked = 0;
    for (const tz of ["Asia/Tokyo", "Pacific/Auckland"]) {
      schedule.tz = tz;
      flagIs(FLAG_STATES[0]!);
      const tree = await renderPage("fixtures");
      const queues = findAll(tree, ExternalPlayNeedsResultQueue);
      expect(queues, `${tz}: the queue mounted once`).toHaveLength(1);
      expect((queues[0]!.props as { venueTz: unknown }).venueTz, `${tz}: the queue's venue zone`).toBe(tz);
      expect(PAGE.org.timezone, "premise: the club's zone is not the venue's").not.toBe(tz);
      const panels = findAll(tree, StagesPanel);
      expect((panels[0]!.props as { tz: unknown }).tz, `${tz}: the stage cards read the same zone`).toBe(tz);
      checked++;
    }
    expect(checked, "anti-vacuity: two venues").toBe(2);
  });

  it("T16 — not chess, or a viewer: no queue, no entry card, and none of the three reads", async () => {
    const cells: [string, () => void][] = [
      ["another sport", () => (division.sport_key = "generic")],
      ["a viewer", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false })],
    ];
    let checked = 0;
    for (const [label, arm] of cells) {
      division.sport_key = "boardgame";
      division.onlinePlay = "lichess";
      fx.rows = [FIXTURE];
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      for (const read of Object.values(queue)) read.mockClear();
      arm();
      const tree = await renderPage("fixtures");
      expect(findAll(tree, ExternalPlayNeedsResultQueue), label).toHaveLength(0);
      expect(findAll(tree, ArbiterEntryCard), label).toHaveLength(0);
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

// The online-switch warning (owner ruling 2026-10-25: switching to online with players who cannot be paired WARNS, never
// blocks). The island's own suite (division-settings-online-link-gaps.test.tsx) proves what it prints from a summary; the
// use-case's (lichess-link-gaps.test.ts) proves the two lists against a real database. This one proves the JOIN between them
// - the page reads the lists for THIS division as THIS organiser, summarises BOTH, and hands them to DivisionSettings, and
// only where the Online play select renders - which neither end can see on its own (a fixture on both ends proves the fixture).
describe("division page: the link-gap summary reaches DivisionSettings", () => {
  type List = { count: number; names: string[] };
  const settingsProps = async () => {
    const found = findAll(await renderPage("settings"), DivisionSettings);
    expect(found, "DivisionSettings mounted once").toHaveLength(1);
    return found[0]!.props as { lichessGaps?: { unlinked: List; reconnect: List; empty: List } };
  };
  const person = (n: number, prefix = "Player") => ({ kind: "person", id: `p${n}`, name: `${prefix} ${n}` });
  const NONE: List = { count: 0, names: [] };

  it("empty case first: offered, nobody short -> zero summaries (so the island prints nothing), read for this division", async () => {
    flagIs(FLAG_STATES[0]!);
    unlinked.read.mockResolvedValue(NO_GAPS);

    expect((await settingsProps()).lichessGaps).toEqual({ unlinked: NONE, reconnect: NONE, empty: NONE });
    expect(unlinked.read).toHaveBeenCalledTimes(1);
    expect(unlinked.read).toHaveBeenLastCalledWith(PAGE.auth, "div-1");
  });

  it("offered, 7 unlinked: the true count and the first five names, in the reader's order", async () => {
    flagIs(FLAG_STATES[0]!);
    unlinked.read.mockResolvedValue({ ...NO_GAPS, unlinked: [1, 2, 3, 4, 5, 6, 7].map((n) => person(n)) });

    expect((await settingsProps()).lichessGaps).toEqual({
      unlinked: { count: 7, names: ["Player 1", "Player 2", "Player 3", "Player 4", "Player 5"] },
      reconnect: NONE,
      empty: NONE,
    });
  });

  it("the reconnect list rides its own field: 3 to reconnect and 1 unlinked arrive as two summaries, neither in the other", async () => {
    flagIs(FLAG_STATES[0]!);
    unlinked.read.mockResolvedValue({
      ...NO_GAPS,
      unlinked: [person(1, "Unlinked")],
      reconnect: [1, 2, 3].map((n) => person(n + 10, "Reconnect")),
    });

    expect((await settingsProps()).lichessGaps).toEqual({
      unlinked: { count: 1, names: ["Unlinked 1"] },
      reconnect: { count: 3, names: ["Reconnect 11", "Reconnect 12", "Reconnect 13"] },
      empty: NONE,
    });
  });

  it("the empty-entrant list rides its own field too: 2 empty entrants arrive in `empty`, in neither of the others", async () => {
    flagIs(FLAG_STATES[0]!);
    unlinked.read.mockResolvedValue({
      ...NO_GAPS,
      unlinked: [person(1, "Unlinked")],
      empty: [{ kind: "entrant", id: "e1", name: "Table 1" }, { kind: "entrant", id: "e2", name: "Table 2" }],
    });

    expect((await settingsProps()).lichessGaps).toEqual({
      unlinked: { count: 1, names: ["Unlinked 1"] },
      reconnect: NONE,
      empty: { count: 2, names: ["Table 1", "Table 2"] },
    });
  });

  it("read whether or not the division is online yet - the switch moment is exactly when it is not", async () => {
    let checked = 0;
    for (const online of ["off", "lichess"] as const) {
      division.onlinePlay = online;
      unlinked.read.mockReset().mockResolvedValue({ ...NO_GAPS, unlinked: [person(1)] });
      flagIs(FLAG_STATES[0]!);
      expect((await settingsProps()).lichessGaps, `online play ${online}`).toEqual({
        unlinked: { count: 1, names: ["Player 1"] },
        reconnect: NONE,
        empty: NONE,
      });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("not offered (flag off, PostHog down), not chess, or not the Settings tab: no summary, and the lists are never read", async () => {
    let checked = 0;
    for (const s of [FLAG_STATES[1]!, FLAG_STATES[2]!]) {
      flagIs(s);
      unlinked.read.mockClear();
      expect((await settingsProps()).lichessGaps, s.label).toBeUndefined();
      expect(unlinked.read, s.label).not.toHaveBeenCalled();
      checked++;
    }
    division.sport_key = "generic";
    flagIs(FLAG_STATES[0]!);
    unlinked.read.mockClear();
    expect((await settingsProps()).lichessGaps, "another sport").toBeUndefined();
    expect(unlinked.read, "another sport").not.toHaveBeenCalled();
    checked++;
    division.sport_key = "boardgame";
    flagIs(FLAG_STATES[0]!);
    unlinked.read.mockClear();
    await renderPage("entrants");
    expect(unlinked.read, "a tab that mounts no Settings").not.toHaveBeenCalled();
    checked++;
    expect(checked).toBe(4);
  });

  // Fix round 2: the warning is a courtesy beside the form. A reader that throws (a database hiccup, a sealed table) must
  // not take the whole Settings tab down with a 500: it logs, and the tab renders without the warning.
  it("a reader that throws does not take the Settings tab down: it logs (English, once) and renders without the warning", async () => {
    flagIs(FLAG_STATES[0]!);
    const boom = new Error("link table unavailable");
    unlinked.read.mockRejectedValue(boom);
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);

    const props = await settingsProps(); // the page rendered: DivisionSettings is there

    expect(props.lichessGaps, "no summary, so the island prints no warning").toBeUndefined();
    expect(unlinked.read, "premise: the reader was reached and threw").toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [context, message] = errorLog.mock.calls[0] as unknown as [{ err: unknown; divisionId: string }, string];
    expect(context.err).toBe(boom);
    expect(context.divisionId).toBe("div-1");
    expect(message).toMatch(/online-switch warning/);
    expect(message, "a log line, never copy: English").toMatch(/^[\x20-\x7e]+$/);
  });

  it("its positive pair: a reader that answers logs nothing and the warning is handed over", async () => {
    flagIs(FLAG_STATES[0]!);
    unlinked.read.mockResolvedValue({ ...NO_GAPS, unlinked: [person(1)] });
    const errorLog = vi.spyOn(log, "error").mockImplementation(() => undefined);

    expect((await settingsProps()).lichessGaps?.unlinked.count).toBe(1);

    expect(errorLog).not.toHaveBeenCalled();
  });

  it("a viewer (not an editor) reads nothing: the Settings island is not mounted for them", async () => {
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    flagIs(FLAG_STATES[0]!);

    expect(findAll(await renderPage("settings"), DivisionSettings)).toHaveLength(0);
    expect(unlinked.read).not.toHaveBeenCalled();
  });
});
