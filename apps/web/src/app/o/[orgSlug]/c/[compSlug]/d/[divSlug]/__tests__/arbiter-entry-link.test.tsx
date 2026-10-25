// T15 + phase 2 (spec 2026-10-24-arbiter-round-column-design.md §7, §8) - the division page's way into the arbiter panel: ONE
// card on the fixtures tab, for the organiser, only where the panel would answer - a chess division that plays online, has
// fixtures, and whose club is offered online chess. The card carries one status line (controller ruling 1, option C), chosen
// from the same reads and the same functions the panel's column uses. Every other cell renders no card (and the panel itself
// 404s there; the arbiter page's own suite). Same scaffold as online-chess-flag-wiring.test.tsx.
//
// Two predicates (pre-flight C18): `canEdit` decides the card and the run sheet's chip links (the panel's own 404 predicate), so
// a billing-frozen organiser keeps both; `editable` decides the controls and the queue, so that organiser gets neither.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({
  sport_key: "boardgame",
  status: "active",
  config: { variant: "classical", onlinePlay: "lichess" } as Record<string, unknown>,
}));
const comp = vi.hoisted(() => ({ frozen: false }));
const fx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
// The helper itself, counted: `onlineChessOffered` keeps its PostHog answer for 60s, so a second `await onlineChessOffered(...)` in the
// page would still make ONE PostHog call. Only a spy on the helper can see "asked once".
const asked = vi.hoisted(() => ({ offered: vi.fn() }));
// The viewer's locale and `ui` dictionary, as the page reads them: a non-default locale and a sentinel object the test owns.
const viewer = vi.hoisted(() => ({ locale: "en", ui: {} as object }));
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
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => viewer.locale) }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async (_locale: string, namespace?: string) => (namespace === "ui" ? viewer.ui : {})),
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
    config: division.config,
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
  return {
    ...actual,
    ...queue,
    // The REAL helper (flag cache, ONLINE_CHESS_ALWAYS, PostHog), seen through a spy.
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
import { ExternalPlayNeedsResultQueue } from "@/components/v2/external-play-needs-result-queue";
import { StagesPanel } from "@/components/v2/stages-panel";
import type { OpenRoundView } from "@/lib/open-round";
import { routes } from "@/lib/routes";
import { getDictionary } from "@/lib/i18n";
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
const ARBITER = routes.divisionArbiter("org", "comp", "div");
const renderPage = (tab: string) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });
const cards = async (tab = "fixtures") => findAll(await renderPage(tab), ArbiterEntryCard);
const lineOf = async () => {
  const found = await cards();
  expect(found, "premise: the entry card is mounted").toHaveLength(1);
  return (found[0]!.props as { line: unknown }).line;
};

/** Only what `entryStatus` reads of a view: the stage, the round, whether it has been opened (a deadline) and what its press is. */
const view = (roundNo: number, v: { deadlineAt: string | null; press: "open" | "none" }): OpenRoundView =>
  ({ stageId: "s1", roundNo, state: v.deadlineAt === null ? "paired" : "open", deadlineAt: v.deadlineAt, press: v.press }) as unknown as OpenRoundView;
const AHEAD = () => new Date(Date.now() + 60 * 60_000).toISOString();
const READY = (n: number) => view(n, { deadlineAt: null, press: "open" });
const CHECKIN = (n: number) => view(n, { deadlineAt: AHEAD(), press: "none" });
const HELD = (id: string, seated = false) => ({ fixtureId: id, seated });

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

beforeEach(() => {
  viewer.locale = "en";
  viewer.ui = {};
  asked.offered.mockReset();
  vi.mocked(getDictionary).mockClear();
  division.sport_key = "boardgame";
  division.status = "active";
  division.config = { variant: "classical", onlinePlay: "lichess" };
  comp.frozen = false;
  fx.rows = [FIXTURE];
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  queue.listFlaggedExternalPlay.mockReset().mockResolvedValue({ boards: [], ownBoards: 0 });
  queue.listRunSheetOnlinePlay.mockReset().mockResolvedValue({});
  queue.listOpenRounds.mockReset().mockResolvedValue([]);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
  vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("division page: the arbiter panel entry card", () => {
  it("fixtures tab, organiser, online chess division with fixtures, club offered: ONE card, aimed at the panel, with the VIEWER's locale and `ui` dictionary (identity, not a lookalike)", async () => {
    // A non-default locale and a dictionary object the test owns: a card hard-wired to "en" or to `{}` could not pass this.
    const sentinel = { "arbiter.entry.link": "sentinel link copy" };
    viewer.locale = "fr";
    viewer.ui = sentinel;
    const found = await cards();
    expect(found).toHaveLength(1);
    const props = found[0]!.props as { href: string; locale: string; dict: unknown };
    expect(props.href).toBe(ARBITER);
    expect(props.locale, "the viewer's locale reaches the card").toBe("fr");
    expect(props.dict, "the very `ui` dictionary the page loaded for that locale").toBe(sentinel);
    expect(getDictionary, "loaded for the viewer's locale").toHaveBeenCalledWith("fr", "ui");
    // The positive pair: the default viewer still gets the default locale (so the test above is not just reading a constant).
    viewer.locale = "en";
    viewer.ui = {};
    const plain = await cards();
    expect((plain[0]!.props as { locale: string }).locale).toBe("en");
  });

  it("every other cell renders no card - and the flag is not asked where an earlier, cheaper part already said no", async () => {
    const cells: [string, () => void, string, boolean][] = [
      ["a viewer", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false }), "fixtures", false],
      ["over the board", () => (division.config = { variant: "classical" }), "fixtures", false],
      ["online play off", () => (division.config = { variant: "classical", onlinePlay: "off" }), "fixtures", false],
      ["another sport", () => (division.sport_key = "generic"), "fixtures", false],
      ["no fixtures yet (and the division already started)", () => (fx.rows = []), "fixtures", false],
      ["the entrants tab", () => undefined, "entrants", false],
      ["the standings tab", () => undefined, "standings", false],
    ];
    let checked = 0;
    for (const [label, arm, tab, wasAsked] of cells) {
      division.sport_key = "boardgame";
      division.status = "active";
      division.config = { variant: "classical", onlinePlay: "lichess" };
      fx.rows = [FIXTURE];
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      flagIs(FLAG_STATES[0]!);
      asked.offered.mockClear();
      arm();
      expect(await cards(tab), label).toHaveLength(0);
      expect(asked.offered.mock.calls.length > 0, `${label}: flag asked?`).toBe(wasAsked);
      checked++;
    }
    expect(checked, "anti-vacuity: every cell ran").toBe(cells.length);
  });

  it("the flag: the helper is asked ONCE per fixtures-tab render, for this viewer (so PostHog is asked once too); a club not offered (or PostHog down) gets no card", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      asked.offered.mockClear();
      expect(await cards(), s.label).toHaveLength(s.offered ? 1 : 0);
      // The helper, not just PostHog: the 60s answer cache makes a duplicate `await onlineChessOffered(...)` invisible one layer down.
      expect(asked.offered, `${s.label}: the helper, once per render`).toHaveBeenCalledTimes(1);
      expect(asked.offered, `${s.label}: for this viewer`).toHaveBeenCalledWith(PAGE.auth);
      expect(flags.isServerFeatureEnabled, s.label).toHaveBeenCalledTimes(1);
      expect(flags.isServerFeatureEnabled, s.label).toHaveBeenCalledWith("online-chess", "user-1", { orgId: "org-1", fallback: false });
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("flag off on a division playing online: no card, the stage cards get no panel link (chip links are spans), and nothing of the column's reads is made", async () => {
    flagIs(FLAG_STATES[1]!);
    const tree = await renderPage("fixtures");
    expect(findAll(tree, ArbiterEntryCard)).toHaveLength(0);
    const panels = findAll(tree, StagesPanel);
    expect(panels).toHaveLength(1);
    expect((panels[0]!.props as { arbiterHref: unknown }).arbiterHref, "no panel link for the cards or the run sheet's chips").toBeNull();
    expect(queue.listOpenRounds, "the panel would not answer: no rounds read for its card").not.toHaveBeenCalled();
  });

  it("billing-frozen organiser (canEdit, not editable): the card and the chip links stay; no queue and no run-sheet chip reads", async () => {
    comp.frozen = true;
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([HELD("h1")]);
    const tree = await renderPage("fixtures");
    const found = findAll(tree, ArbiterEntryCard);
    expect(found, "canEdit decides the card").toHaveLength(1);
    expect((found[0]!.props as { href: string }).href).toBe(ARBITER);
    expect((findAll(tree, StagesPanel)[0]!.props as { arbiterHref: unknown }).arbiterHref, "canEdit decides the chip links").toBe(ARBITER);
    expect(findAll(tree, ExternalPlayNeedsResultQueue), "editable decides the queue").toHaveLength(0);
    expect(queue.listRunSheetOnlinePlay, "the chips' camera/flag reads are the controls' (editable)").not.toHaveBeenCalled();
    // ... and the same card still says what is waiting: the panel it opens shows the held board to this organiser.
    expect((found[0]!.props as { line: unknown }).line).toEqual({ kind: "attention", count: 1 });
  });
});

describe("division page: the entry card's one line follows the ladder", () => {
  it("the empty case first: nothing held, nothing to open ⇒ the card's default body", async () => {
    expect(await lineOf()).toEqual({ kind: "default" });
  });

  it("a round waiting to open ⇒ ready, naming ITS round", async () => {
    queue.listOpenRounds.mockResolvedValue([READY(3)]);
    expect(await lineOf()).toEqual({ kind: "ready", roundNo: 3 });
  });

  it("a round in check-in ⇒ check-in, naming ITS round", async () => {
    queue.listOpenRounds.mockResolvedValue([CHECKIN(2)]);
    expect(await lineOf()).toEqual({ kind: "checkin", roundNo: 2 });
  });

  it("check-in beats ready (a league pairs every round at Generate, so both exist at once), whichever the reader lists first", async () => {
    queue.listOpenRounds.mockResolvedValue([READY(3), CHECKIN(2)]);
    expect(await lineOf()).toEqual({ kind: "checkin", roundNo: 2 });
    queue.listOpenRounds.mockResolvedValue([CHECKIN(2), READY(3)]);
    expect(await lineOf()).toEqual({ kind: "checkin", roundNo: 2 });
  });

  it("a window that has CLOSED is not check-in: the page hands the real clock to the ladder, so a stale deadline reads as the round waiting (ready) or as nothing (default)", async () => {
    const PAST = (n: number) => view(n, { deadlineAt: "2020-01-01T00:00:00.000Z", press: "none" });
    queue.listOpenRounds.mockResolvedValue([PAST(1)]);
    expect(await lineOf(), "a closed window alone says nothing").toEqual({ kind: "default" });
    queue.listOpenRounds.mockResolvedValue([PAST(1), READY(3)]);
    expect(await lineOf(), "a closed window beside a round waiting to open: the waiting round").toEqual({ kind: "ready", roundNo: 3 });
    // The positive pair: the same two views with a window that is still running read as check-in.
    queue.listOpenRounds.mockResolvedValue([CHECKIN(1), READY(3)]);
    expect(await lineOf()).toEqual({ kind: "checkin", roundNo: 1 });
  });

  it("a board that needs a decision beats ready AND check-in (a red attention outranks the phase)", async () => {
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([HELD("h1")]);
    queue.listOpenRounds.mockResolvedValue([READY(3)]);
    expect(await lineOf()).toEqual({ kind: "attention", count: 1 });
    queue.listOpenRounds.mockResolvedValue([CHECKIN(2)]);
    expect(await lineOf()).toEqual({ kind: "attention", count: 1 });
    queue.listOpenRounds.mockResolvedValue([CHECKIN(2), READY(3)]);
    expect(await lineOf()).toEqual({ kind: "attention", count: 1 });
  });

  it("the attention number is the column title's rule: DISTINCT boards, a seated held board never counted, a flagged-only board counted", async () => {
    // h1 is held AND flagged (one board), h2 is held but the organiser sits on it (shown, never counted), f3 is flagged only.
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([HELD("h1"), HELD("h2", true)]);
    queue.listFlaggedExternalPlay.mockResolvedValue({ boards: [{ fixtureId: "h1" }, { fixtureId: "f3" }], ownBoards: 4 });
    expect(await lineOf()).toEqual({ kind: "attention", count: 2 });
  });

  it("only boards the organiser sits on, or flags the viewer plays on: nothing needs a decision ⇒ the phase speaks", async () => {
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([HELD("h2", true)]);
    queue.listFlaggedExternalPlay.mockResolvedValue({ boards: [], ownBoards: 2 });
    queue.listOpenRounds.mockResolvedValue([READY(3)]);
    expect(await lineOf()).toEqual({ kind: "ready", roundNo: 3 });
  });

  it("the card's reads are asked for THIS division by THIS organiser, each once", async () => {
    await cards();
    for (const read of [queue.listNeedsOrganiserExternalPlay, queue.listFlaggedExternalPlay, queue.listOpenRounds]) {
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenLastCalledWith(PAGE.auth, "div-1");
    }
  });
});

// T16 (T19 carry) - the same link reaches the stage cards and the run sheet's chips: a refused Unpair / Rebuild over a board an
// online game stands behind sends the organiser there (OnlineGameExistsNotice), and each camera / flag chip leads there.
describe("division page: the stage cards know where the arbiter panel is", () => {
  const panelHref = async () => {
    const panels = findAll(await renderPage("fixtures"), StagesPanel);
    expect(panels, "premise: the stages panel is mounted").toHaveLength(1);
    return (panels[0]!.props as { arbiterHref?: unknown }).arbiterHref;
  };

  it("the empty case first: no panel to link to (over the board, no fixtures) ⇒ null", async () => {
    division.config = { variant: "classical" };
    expect(await panelHref()).toBeNull();
    division.config = { variant: "classical", onlinePlay: "lichess" };
    fx.rows = [];
    expect(await panelHref()).toBeNull();
  });

  it("an online chess division with fixtures, club offered ⇒ the arbiter panel's own route, the card's href", async () => {
    expect(await panelHref()).toBe(ARBITER);
    expect(((await cards())[0]!.props as { href: string }).href).toBe(ARBITER);
  });
});
