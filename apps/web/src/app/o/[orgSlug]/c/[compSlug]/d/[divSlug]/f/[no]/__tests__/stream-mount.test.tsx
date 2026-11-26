// The organiser fixture page's Stream wiring (spec 2026-09-30 §2, T5). Same harness as the division page's
// stream-checkout-return.test.tsx: the async server component is called directly and its element tree walked (no jsdom
// here), so what is pinned is the page's REAL wiring — which gate it hands the loader, whether it reads sessions, which
// mount it passes the console, and what `?stream=open` and the checkout return turn into.
//
// The loader is a SPY that returns an entitled context whatever `offered` says: the page's OWN gates must keep a scorer
// and a frozen page off the panel, not the loader's early return (which stream-panel-context.test.ts pins separately).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const scene = vi.hoisted(() => ({
  canEdit: true,
  canScore: true,
  frozen: false,
  status: "scheduled",
  open: [] as string[],
  feedsNext: true,
  stageKind: null as string | null,
  // R116-4: the seats and the stored outcome getFixture returns.
  homeId: "e-home" as string | null,
  awayId: "e-away" as string | null,
  outcome: null as unknown,
  // Task 33d: the signed-in organiser's role, and the user ids the member-seat freeze answers for the org.
  // Back to fixtures: `null` is an accepted official who is NOT a member of the org.
  role: "admin" as string | null,
  locale: "en",
  frozenIds: [] as string[],
}));
const spies = vi.hoisted(() => ({
  loader: vi.fn(),
  openStreams: vi.fn(),
  // W2c Task 19: the match rules block's facts. A spy, so what pins the page is WHO it reads them for, not the loader.
  matchRules: vi.fn(),
  // Match Day C2: everyone who is not offered the block reads the match's format line alone.
  formatLines: vi.fn(async (_auth: unknown, ids: readonly string[]) => new Map(ids.map((i) => [i, `line of ${i}`]))),
  // Task 31b: the fixture's Seazn replays, read for an organiser the Stream panel is not mounted for.
  replays: vi.fn(),
  // Task 33d: the member-seat freeze (entitlement-freeze.ts `frozenMemberIds`) — WHO it is read for, and what the page does with it.
  frozen: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({
  requireFixturePage: vi.fn(async () => ({
    auth: { orgId: "org-1", userId: "u-1", role: scene.role },
    fixtureId: "fx-7",
    canScore: scene.canScore,
    canEdit: scene.canEdit,
  })),
}));
vi.mock("@/server/usecases/fixtures", () => ({
  getFixture: vi.fn(async () => ({
    id: "fx-7",
    division_id: "div-1",
    status: scene.status,
    scheduled_at: "2026-09-30T10:00:00Z",
    home_entrant_id: scene.homeId,
    away_entrant_id: scene.awayId,
    outcome: scene.outcome,
    venue_name: null,
    court_name: null,
    round_no: 1,
    home_slot_label: null,
    away_slot_label: null,
    officials: null,
  })),
  getFixtureState: vi.fn(async () => ({ status: scene.status, last_seq: 0, summary: null, state: null, outcome: null })),
  listEvents: vi.fn(async () => []),
  eventRecorderNames: vi.fn(async () => ({})),
  getLineup: vi.fn(async () => ({ slots: [] })),
  loadFixturePadCfg: vi.fn(async () => ({ cfg: {}, stageKind: scene.stageKind })),
  fixtureFeedsNextMatch: vi.fn(async (_auth: unknown, id: string) => (id === "fx-7" ? scene.feedsNext : !scene.feedsNext)),
  loadFixtureMatchRules: spies.matchRules,
  fixtureFormatLines: spies.formatLines,
}));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    slug: "div-one",
    name: "Division One",
    // Single sport on purpose (Minor 4): the mount is sport-agnostic — `sportKey` only passes through to the loader and
    // the overlay themes, and no gate here reads it; generic, cricket and badminton drive the real mount in e2e.
    sport_key: "football",
    module_version: "1.0.0",
    config: {},
    competition_id: "comp-1",
  })),
}));
vi.mock("@/server/usecases/schedule", () => ({ getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "Europe/London" })) }));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", name: "Comp", slug: "comp", frozen: scene.frozen, visibility: "private" })),
}));
// The page reads the server's ONE departed vocabulary for the settle flag (loop-F tidy) — the real Set, never a restated
// list (departed-vocabulary-is-single-sourced.test.ts).
vi.mock("@/server/usecases/entrants", async (importOriginal) => ({
  DEPARTED_STATUSES: (await importOriginal<typeof import("@/server/usecases/entrants")>()).DEPARTED_STATUSES,
  getEntrant: vi.fn(async (_auth: unknown, id: string) => ({
    id,
    display_name: ({ "e-home": "Alpha Athletic", "e-away": "Bravo Rangers", "e-gone": "Charlie Gone" } as Record<string, string>)[id] ?? id,
    kind: "team",
    members: [],
  })),
}));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({ officialLabel: { scorer: "Scorer" } })),
}));
vi.mock("@/server/usecases/lineup-catalog", () => ({
  lineupCatalogFor: vi.fn(() => ({ groups: [], roles: [], lineup: { size: 11, benchMax: 5 } })),
}));
vi.mock("@/server/usecases/me", () => ({ listFixtureAvailability: vi.fn(async () => []) }));
vi.mock("@/server/usecases/discipline", () => ({ suspensionsForFixture: vi.fn(async () => []) }));
vi.mock("@/server/usecases/fidelity", () => ({ resolveScorePadBootstrap: vi.fn(async () => null) }));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "pro"),
}));
vi.mock("@/lib/db", () => ({ sql: () => Promise.resolve([]) }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => scene.locale) }));
vi.mock("@/components/v2/checkin-qr", () => ({ CheckinQr: () => null }));
vi.mock("@/components/v2/fixture-officials-strip", () => ({ FixtureOfficialsStrip: () => null }));
vi.mock("@/components/v2/fixture-console", () => ({ FixtureConsole: () => null }));
vi.mock("@/server/stream-panel-context", () => ({ loadStreamPanelContext: spies.loader }));
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: spies.openStreams }));
vi.mock("@/server/video/organiser-replays", () => ({ fixtureSeaznReplays: spies.replays }));
vi.mock("@/components/v2/fixture-replays-section", () => ({ FixtureReplaysSection: () => null }));
vi.mock("@/server/usecases/entitlement-freeze", () => ({ frozenMemberIds: spies.frozen }));

import { renderToStaticMarkup } from "react-dom/server";
import FixturePage from "../page";
import { BackLink } from "@/components/back-link";
import { CheckinQr } from "@/components/v2/checkin-qr";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { FixtureConsole } from "@/components/v2/fixture-console";
import { FixtureReplaysSection } from "@/components/v2/fixture-replays-section";

/** What `loadFixtureMatchRules` answers: the serialisable facts, plus a function-valued `fields` an RSC payload cannot carry. */
const MATCH_RULES = {
  sportKey: "football",
  stageKind: "knockout",
  variant: "11-a-side",
  stageLine: "2 halves of 45 min",
  override: null,
  stageResolved: { halfMinutes: 45 },
  effective: { halfMinutes: 45 },
  effectiveLine: "2 halves of 45 min",
  fields: [{ key: "halfMinutes", build: () => ({}) }],
  state: "unstarted",
  cancelled: false,
};

const CONTEXT = { entitled: true, relayEntitled: true, relayDisabled: false, orgId: "org-1", streamBalance: 2 };
/** What `fixtureSeaznReplays` answers: two parts, one playable (Download and Delete), one failed (Delete). */
const REPLAYS = [
  { id: "r-1", partNo: 1, state: "playable", lengthSeconds: 3600, onMatchPage: false },
  { id: "r-2", partNo: 2, state: "failed", lengthSeconds: null, onMatchPage: false },
];

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

async function consoleProps(query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const tree = await FixturePage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div-one", no: "7" }),
    searchParams: Promise.resolve(query),
  });
  const el = find(tree as ReactNode, FixtureConsole);
  if (!el) throw new Error("the page rendered no FixtureConsole");
  return el.props as Record<string, unknown>;
}

beforeEach(() => {
  Object.assign(scene, {
    canEdit: true, canScore: true, frozen: false, status: "scheduled", open: [], feedsNext: true, stageKind: null,
    homeId: "e-home", awayId: "e-away", outcome: null, role: "admin", locale: "en", frozenIds: [],
  });
  spies.loader.mockReset();
  spies.loader.mockImplementation(async () => CONTEXT);
  spies.formatLines.mockClear();
  spies.openStreams.mockReset();
  spies.openStreams.mockImplementation(async () => Object.fromEntries(scene.open.map((id) => [id, "live"])));
  spies.matchRules.mockReset();
  spies.matchRules.mockImplementation(async () => MATCH_RULES);
  spies.replays.mockReset();
  spies.replays.mockImplementation(async () => REPLAYS);
  spies.frozen.mockReset();
  spies.frozen.mockImplementation(async () => new Set(scene.frozenIds));
});

describe("the organiser fixture page mounts Stream (spec 2026-09-30 §2)", () => {
  it("an organiser on an entitled, unfrozen page gets the full panel for THIS fixture, in the venue zone, with both names", async () => {
    const props = await consoleProps();
    expect(props.stream).toEqual({
      mode: "panel",
      context: CONTEXT,
      tz: "Europe/London",
      fixture: {
        id: "fx-7",
        status: "scheduled",
        outcome: null,
        scheduled_at: "2026-09-30T10:00:00Z",
        home_entrant_id: "e-home",
        away_entrant_id: "e-away",
      },
      entrantNames: { "e-home": "Alpha Athletic", "e-away": "Bravo Rangers" },
    });
    expect(props.streamReturn, "an ordinary visit opens nothing").toBe(false);
    expect(spies.loader).toHaveBeenCalledTimes(1);
    expect(spies.loader.mock.calls[0][0]).toMatchObject({ competitionId: "comp-1", sportKey: "football", fixtureIds: ["fx-7"], locale: "en", offered: true });
  });

  it("organisers only: a scorer without canEdit gets NO mount, offers the loader nothing, and reads no sessions — even with one on air", async () => {
    Object.assign(scene, { canEdit: false, canScore: true, open: ["fx-7"] });
    const props = await consoleProps({ stream: "open" });
    expect(props.stream, "a scorer sees no Stream control").toBeUndefined();
    expect(spies.loader.mock.calls[0][0]).toMatchObject({ offered: false });
    expect(spies.openStreams, "a scorer's refresh pays no session read").not.toHaveBeenCalled();
  });

  it("F1: a billing-frozen page with a session ON AIR gets the Stop-only mount; with none on air, nothing", async () => {
    const cases: [string, string[], unknown][] = [
      ["frozen, on air", ["fx-7"], { mode: "stop-only" }],
      ["frozen, nothing on air", [], undefined],
    ];
    let checked = 0;
    for (const [name, open, want] of cases) {
      Object.assign(scene, { frozen: true, open });
      spies.loader.mockClear();
      spies.openStreams.mockClear();
      const props = await consoleProps();
      expect(props.stream, name).toEqual(want);
      expect(spies.loader.mock.calls[0][0], `${name}: a frozen page is not offered the panel`).toMatchObject({ offered: false });
      expect(spies.openStreams, `${name}: the organiser's session read`).toHaveBeenCalledWith(expect.anything(), ["fx-7"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a finalized fixture still mounts the panel — the fixture's state never gates Stream, the PAGE's canEdit does", async () => {
    Object.assign(scene, { status: "finalized" });
    expect((await consoleProps()).stream).toMatchObject({ mode: "panel" });
  });

  it("the checkout return: `?stream=open` opens the panel, and `checkout`/`session_id` reach the loader (first value of a repeat)", async () => {
    const props = await consoleProps({ stream: "open", checkout: "success", session_id: "cs_test_9" });
    expect(props.streamReturn).toBe(true);
    expect(spies.loader.mock.calls[0][0]).toMatchObject({ checkout: { status: "success", sessionId: "cs_test_9" } });
    spies.loader.mockClear();
    const repeated = await consoleProps({ stream: ["open", "x"] as unknown as string, session_id: ["cs_a", "cs_b"] as unknown as string });
    expect(repeated.streamReturn).toBe(true);
    expect(spies.loader.mock.calls[0][0]).toMatchObject({ checkout: { status: undefined, sessionId: "cs_a" } });
    // The empty case: any other value of `stream` is not a return.
    expect((await consoleProps({ stream: "closed" })).streamReturn).toBe(false);
  });
});

// Loop-F tidy 2 — not Stream, the same page harness: the held block's no-choice sentence reads whether THIS line feeds a
// next match (needs-decision.tsx `feedsNextMatch`), and the page is what hands the console that read.
describe("the organiser fixture page hands the console whether the line feeds a next match (loop-F tidy 2)", () => {
  it("passes THIS fixture's fixtureFeedsNextMatch read through, both ways", async () => {
    let checked = 0;
    for (const feeds of [true, false]) {
      scene.feedsNext = feeds;
      const fixture = (await consoleProps()).fixture as { id: string; feeds_next_match?: boolean };
      expect([fixture.id, fixture.feeds_next_match], `feeds ${String(feeds)}`).toEqual(["fx-7", feeds]);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// W2b Task 11 (D19, X-DW-3): the forfeit dialog's "Neither" is hidden exactly where the server refuses a double walkover,
// and the page is what hands the console that reading — the stage kind (`loadFixturePadCfg`) with the feed edges
// (`fixtureFeedsNextMatch`). Expected values are D19's rows, typed: a feeding bracket kind on a line that feeds nothing
// refuses; a ladder, a table stage, a stage-less fixture and a line that feeds a next match never do.
describe("the organiser fixture page hands the console D19's double-walkover reading (W2b Task 11)", () => {
  it("no_next_match is true only for a feeding bracket kind on a line that feeds no next match", async () => {
    const ROWS: [stageKind: string | null, feeds: boolean, want: boolean][] = [
      [null, false, false],
      [null, true, false],
      ["league", false, false],
      ["ladder", false, false],
      ["knockout", true, false],
      ["knockout", false, true],
      ["double_elim", false, true],
      ["stepladder", false, true],
      ["page_playoff", false, true],
    ];
    let checked = 0;
    for (const [stageKind, feeds, want] of ROWS) {
      Object.assign(scene, { stageKind, feedsNext: feeds });
      const fixture = (await consoleProps()).fixture as { no_next_match?: boolean };
      expect(fixture.no_next_match, `${String(stageKind)}, feeds ${String(feeds)}`).toBe(want);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});

// R116-4 (owner ruling 116): the console's header names the side a walkover was won over whose seat is EMPTY — the page
// reads her through `unseatedForfeitLoser` and hands down only her name, never a seated side (the pad and the dialogs
// read `home`/`away` as who is IN the fixture). The pairs: a bye (no loser) and a seated loser hand down nothing.
describe("the organiser fixture page names ruling 116's withdrawn winner for the console header (R116-4)", () => {
  it("her name rides on her empty seat, either side; a bye and a seated loser name nobody", async () => {
    const withdrew = (winner: string) => ({ kind: "award", winner, loser: "e-gone", reason: "withdrew" });
    const ROWS: [name: string, homeId: string | null, awayId: string | null, outcome: unknown, want: [unknown, unknown]][] = [
      ["her seat home", null, "e-away", withdrew("e-away"), ["Charlie Gone", null]],
      ["her seat away", "e-home", null, withdrew("e-home"), [null, "Charlie Gone"]],
      ["a bye", "e-home", null, { kind: "award", winner: "e-home", loser: null, reason: "bye" }, [null, null]],
      ["a seated loser", "e-home", "e-away", { kind: "award", winner: "e-home", loser: "e-away", reason: "withdrew" }, [null, null]],
    ];
    let checked = 0;
    for (const [name, homeId, awayId, outcome, want] of ROWS) {
      Object.assign(scene, { status: "forfeited", homeId, awayId, outcome });
      const props = await consoleProps();
      const fixture = props.fixture as { home_unseated_name?: unknown; away_unseated_name?: unknown };
      expect([fixture.home_unseated_name, fixture.away_unseated_name], name).toEqual(want);
      expect([props.home === null, props.away === null], `${name}: the seated sides are untouched`).toEqual([homeId === null, awayId === null]);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});

describe("the organiser fixture page mounts the match rules block (W2c Task 19, S2)", () => {
  it("an organiser on an unfrozen page: the loader is read for THIS fixture and the console gets its facts - JSON only, the function-valued fields dropped", async () => {
    const props = await consoleProps();
    expect(spies.matchRules).toHaveBeenCalledTimes(1);
    expect(spies.matchRules.mock.calls[0][1], "read for this fixture").toBe("fx-7");
    // Every fact the loader answers but the function-valued `fields`.
    const facts = Object.fromEntries(Object.entries(MATCH_RULES).filter(([k]) => k !== "fields"));
    expect(props.matchRules).toEqual({ fixtureId: "fx-7", ...facts });
    expect(JSON.parse(JSON.stringify(props.matchRules)), "what crosses the RSC boundary survives JSON").toEqual(props.matchRules);
    // Match Day C2: the block carries the format; the read-only line is not read twice.
    expect(spies.formatLines).not.toHaveBeenCalled();
    expect(props.matchFormatLine).toBeUndefined();
  });

  it("organisers only: a scorer without canEdit is not offered the block, and its facts are not read", async () => {
    Object.assign(scene, { canEdit: false, canScore: true });
    const props = await consoleProps();
    expect(props.matchRules, "the writer is organiser auth: a block shown to a scorer would only earn a 403").toBeUndefined();
    expect(spies.matchRules, "nothing is read for a scorer").not.toHaveBeenCalled();
    // Match Day C2: the scorer reads the match's format, read-only - its line alone, for THIS fixture.
    expect(spies.formatLines).toHaveBeenCalledTimes(1);
    expect(spies.formatLines.mock.calls[0]![1]).toEqual(["fx-7"]);
    expect(props.matchFormatLine).toBe("line of fx-7");
  });

  it("a billing-frozen competition is offered no block, and nothing is read", async () => {
    Object.assign(scene, { frozen: true });
    const props = await consoleProps();
    expect(props.matchRules).toBeUndefined();
    expect(spies.matchRules).not.toHaveBeenCalled();
    expect(props.matchFormatLine, "the read-only format is still said").toBe("line of fx-7");
  });

  it("a sport with nothing to change for one match (the loader answers no fields) gets no block", async () => {
    spies.matchRules.mockImplementation(async () => ({ ...MATCH_RULES, sportKey: "generic", fields: [] }));
    const props = await consoleProps();
    expect(spies.matchRules).toHaveBeenCalledTimes(1);
    expect(props.matchRules).toBeUndefined();
  });
});

// Match Day PB2 (owner 2026-11-02, "apply rec", option A): a billing-frozen competition still SCORES — the events door asks no
// freeze (scoring.ts; scoring-frozen-competition.test.ts drives it) — so the page hands the console its pad, the organiser's
// settle/forfeit/abandon (all score events) and the device hand-over exactly as it would unfrozen. What the freeze still stops
// stays off: the match rules block (its writer is freeze-guarded) and a NEW stream (no panel; a stream on air keeps Stop, F1).
// One row per page role, unfrozen first (the empty case), on a live match.
describe("PB2 — a billing-frozen page keeps the pad, the organiser's actions and the hand-over", () => {
  type Role = [name: string, canEdit: boolean, canScore: boolean, want: { canEdit: boolean; canOrganise: boolean; deviceHandover: boolean }];
  const ROLES: Role[] = [
    ["organiser", true, true, { canEdit: true, canOrganise: true, deviceHandover: true }],
    ["official scorer", false, true, { canEdit: true, canOrganise: false, deviceHandover: false }],
    ["viewer", false, false, { canEdit: false, canOrganise: false, deviceHandover: false }],
  ];
  const pick = (p: Record<string, unknown>) => ({ canEdit: p.canEdit, canOrganise: p.canOrganise, deviceHandover: p.deviceHandover });

  it("EMPTY CASE FIRST (unfrozen): each role's pad, organiser actions and hand-over", async () => {
    let checked = 0;
    for (const [name, canEdit, canScore, want] of ROLES) {
      Object.assign(scene, { canEdit, canScore, frozen: false, status: "in_play" });
      expect(pick(await consoleProps()), name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(ROLES.length);
  });

  it("frozen: the same three for every role — and still no match rules block and no new-stream panel", async () => {
    let checked = 0;
    for (const [name, canEdit, canScore, want] of ROLES) {
      Object.assign(scene, { canEdit, canScore, frozen: true, status: "in_play", open: [] });
      spies.matchRules.mockClear();
      const props = await consoleProps();
      expect(pick(props), `${name}: frozen scores like unfrozen`).toEqual(want);
      expect(props.matchRules, `${name}: the rules block's writer is freeze-guarded`).toBeUndefined();
      expect(spies.matchRules, name).not.toHaveBeenCalled();
      expect(props.stream, `${name}: no new stream on a frozen page`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(ROLES.length);
  });

  it("frozen: a finalized match still offers no hand-over (the write lock, not the freeze, closes it)", async () => {
    Object.assign(scene, { canEdit: true, canScore: true, frozen: true, status: "finalized" });
    expect((await consoleProps()).deviceHandover).toBe(false);
    Object.assign(scene, { frozen: false });
    expect((await consoleProps()).deviceHandover).toBe(false);
  });
});

// Seazn-hosted video Task 31b (T26 review m8): Delete and Download live in the replays list, which lives in the Stream panel, which
// mounts only for an entitled, unfrozen page. Every other organiser gets the list ON ITS OWN, below the console — read by the page
// for THIS fixture and this org — and never the panel (start and stop stay where they were). The truth is the brief's sentence; the
// real loader's early return is not what keeps it (the loader here is a spy that answers entitled unless told otherwise).
describe("Task 31b: an organiser whose page mounts no Stream panel still reaches the fixture's replays", () => {
  async function page(query: Record<string, string> = {}) {
    const tree = await FixturePage({
      params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div-one", no: "7" }),
      searchParams: Promise.resolve(query),
    });
    return { console: find(tree as ReactNode, FixtureConsole), replays: find(tree as ReactNode, FixtureReplaysSection) };
  }

  it("the whole table over canEdit x entitled x frozen x a session on air: the list stands alone exactly when the panel is not mounted, for an organiser; the replays are read only then", async () => {
    let checked = 0;
    let alone = 0;
    for (const canEdit of [false, true]) for (const entitled of [false, true]) for (const frozen of [false, true]) for (const onAir of [false, true]) {
      Object.assign(scene, { canEdit, frozen, open: onAir ? ["fx-7"] : [] });
      spies.loader.mockImplementation(async () => ({ ...CONTEXT, entitled }));
      spies.replays.mockClear();
      const p = await page();
      const label = JSON.stringify({ canEdit, entitled, frozen, onAir });
      const panel = (p.console!.props as { stream?: { mode: string } }).stream?.mode === "panel";
      const want = canEdit && !(entitled && !frozen);
      expect(panel, `${label}: PREMISE: the panel mounts for an entitled, unfrozen organiser`).toBe(canEdit && entitled && !frozen);
      expect(p.replays !== null, label).toBe(want);
      expect(spies.replays.mock.calls.length, `${label}: read only when shown`).toBe(want ? 1 : 0);
      if (want) {
        expect(spies.replays.mock.calls[0], label).toEqual(["org-1", "fx-7"]);
        expect(p.replays!.props).toEqual({ fixtureId: "fx-7", replays: REPLAYS, memberFrozen: false });
        alone++;
      }
      checked++;
    }
    expect(checked).toBe(16);
    expect(alone, "anti-vacuity").toBe(6);
  });

  it("EMPTY CASE: a frozen organiser's fixture with no replay gets no list (no empty card)", async () => {
    Object.assign(scene, { frozen: true });
    spies.replays.mockImplementation(async () => []);
    const p = await page();
    expect(spies.replays, "PREMISE: read").toHaveBeenCalledTimes(1);
    expect(p.replays).toBeNull();
  });

  it("a read that fails costs only the list: the page still renders its console", async () => {
    Object.assign(scene, { frozen: true });
    spies.replays.mockImplementation(async () => { throw new Error("database is down"); });
    const p = await page();
    expect(spies.replays, "PREMISE: read").toHaveBeenCalledTimes(1);
    expect(p.replays).toBeNull();
    expect(p.console, "the page rendered").not.toBeNull();
  });
});

// Task 33d (T31b review m3): Delete and Download both go through `requireOrgAuth`'s write scope, which answers 402 to an ADMIN whose seat
// the plan's member limit has paused (entitlement-freeze.ts `frozenMemberIds`; the owner is never in it — doc 10 §2.4). The page reads
// that freeze ONCE, beside the standalone list's own read, and hands "this member's seat is paused" to the list, which then offers
// neither action (seazn-replays-card.test.tsx draws it). The routes stay the guard (their own tests pin the 402). A paused seat is NOT
// an unentitled org or a billing-frozen competition: those keep both actions (Task 31b). The PANEL's list needs no such read: it rides
// the session view (`GET …/stream-sessions/current`), whose door is write-scoped too, so a paused seat never gets that list at all.
describe("Task 33d: a member whose seat is paused sees the replays without the actions they cannot use", () => {
  async function page() {
    const tree = await FixturePage({
      params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div-one", no: "7" }),
      searchParams: Promise.resolve({}),
    });
    const consoleEl = find(tree as ReactNode, FixtureConsole);
    const section = find(tree as ReactNode, FixtureReplaysSection);
    const stream = (consoleEl?.props as { stream?: { mode: string; context?: Record<string, unknown> } } | undefined)?.stream;
    return { consoleEl, section, stream, paused: (section?.props as { memberFrozen?: unknown } | undefined)?.memberFrozen };
  }
  // [name, role, the user ids the freeze answers, paused?, seat reads] — the signed-in user is "u-1". The page's rule is the routes'
  // (auth.ts `requireOrgAuth`): only an ADMIN's write is refused for a paused seat, so only an admin is read. The owner row names the
  // owner IN the freeze set on purpose — today's selector never does (it skips owners), but the route would still serve the owner if it
  // ever did, so the page must not hide the owner's actions on the set alone. That row is the one a page without the role gate fails.
  const SEATS: [name: string, role: string, frozenIds: string[], paused: boolean, reads: number][] = [
    ["an admin of an org within its limit", "admin", [], false, 1],
    ["an admin whose seat is paused", "admin", ["u-1"], true, 1],
    ["an admin of an over-quota org who keeps a seat (another admin is paused)", "admin", ["u-2"], false, 1],
    ["the owner, even with the freeze set naming them (the routes never refuse an owner's write)", "owner", ["u-1", "u-2"], false, 0],
  ];

  it("the standalone list (no Stream panel: the org lost the plan): paused exactly for the admin whose seat is paused; an admin is read once, for this org; the owner never", async () => {
    let checked = 0;
    let paused = 0;
    let ownerNamed = 0;
    for (const [name, role, frozenIds, want, reads] of SEATS) {
      Object.assign(scene, { role, frozenIds, frozen: false, open: [] });
      spies.loader.mockImplementation(async () => ({ ...CONTEXT, entitled: false }));
      spies.frozen.mockClear();
      const p = await page();
      expect(p.stream, `${name}: PREMISE: no panel`).toBeUndefined();
      expect(p.section, `${name}: PREMISE: the list stands alone`).not.toBeNull();
      expect(p.paused, name).toBe(want);
      expect(spies.frozen.mock.calls, `${name}: seat reads, for this org`).toEqual(Array.from({ length: reads }, () => ["org-1"]));
      checked++;
      if (want) paused++;
      if (role !== "admin" && frozenIds.includes("u-1")) ownerNamed++;
    }
    expect([checked, paused, ownerNamed], "anti-vacuity: every seat, one paused, one non-admin the set names").toEqual([SEATS.length, 1, 1]);
  });

  it("a billing-frozen competition is NOT a paused seat: an admin with a seat keeps both actions on the standalone list (Task 31b) — and a paused admin there is still paused", async () => {
    Object.assign(scene, { frozen: true, frozenIds: [] });
    const kept = await page();
    expect(kept.section, "PREMISE: the list stands alone").not.toBeNull();
    expect(kept.paused).toBe(false);
    Object.assign(scene, { frozen: true, frozenIds: ["u-1"] });
    expect((await page()).paused).toBe(true);
  });

  it("the panel is mounted (entitled, unfrozen page): no standalone list, and the seat is not read at all — whatever the freeze says", async () => {
    let checked = 0;
    for (const [name, role, frozenIds] of SEATS) {
      Object.assign(scene, { role, frozenIds, frozen: false, open: [] });
      spies.frozen.mockClear();
      const p = await page();
      expect(p.stream?.mode, `${name}: PREMISE: the panel`).toBe("panel");
      expect(p.stream?.context, `${name}: the panel's context is the loader's, untouched`).toEqual(CONTEXT);
      expect(p.section, `${name}: never both`).toBeNull();
      expect(spies.frozen, `${name}: nothing to hide here, so nothing read`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(SEATS.length);
  });

  it("organisers only: a scorer or a viewer (no canEdit) is never read for a seat — no list, no panel, no question asked", async () => {
    let checked = 0;
    for (const canScore of [true, false]) {
      Object.assign(scene, { canEdit: false, canScore, role: "viewer", frozen: true, frozenIds: ["u-1"] });
      spies.frozen.mockClear();
      spies.replays.mockClear();
      const p = await page();
      expect([p.stream, p.section], `scorer ${String(canScore)}`).toEqual([undefined, null]);
      expect(spies.frozen, `scorer ${String(canScore)}`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a seat read that fails costs nothing: the page renders and the list keeps its actions (the routes stay the guard)", async () => {
    spies.frozen.mockImplementation(async () => { throw new Error("database is down"); });
    Object.assign(scene, { frozen: true });
    const p = await page();
    expect(spies.frozen, "PREMISE: read").toHaveBeenCalledTimes(1);
    expect(p.consoleEl, "the page rendered").not.toBeNull();
    expect(p.section, "the list too").not.toBeNull();
    expect(p.paused).toBe(false);
  });
});

/** Every element in the page's tree that `match` accepts, in document order. */
function findAll(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child as ReactNode, match));
  if (!isValidElement(node)) return [];
  const below = findAll((node.props as { children?: ReactNode }).children, match);
  return match(node) ? [node, ...below] : below;
}

const props = (el: ReactElement) => el.props as Record<string, unknown>;

// The one sport here (football) is enough: the destination is built from the three slugs alone, no sport reaches it.
describe("the match page's back button to the division's fixtures", () => {
  /** Everyone `requireFixturePage` lets in. `member` is what decides whether the division page opens at all. */
  const VIEWERS = [
    { who: "owner", role: "owner", canEdit: true, canScore: true, member: true },
    { who: "admin", role: "admin", canEdit: true, canScore: true, member: true },
    { who: "member viewer", role: "viewer", canEdit: false, canScore: false, member: true },
    { who: "member official scorer", role: "viewer", canEdit: false, canScore: true, member: true },
    { who: "non-member official scorer", role: null, canEdit: false, canScore: true, member: false },
  ] as const;
  const STATUSES = ["scheduled", "in_play", "decided", "finalized", "forfeited", "abandoned", "cancelled"];
  // The route the division page really serves (app/o/[orgSlug]/c/[compSlug]/d/[divSlug], `?tab=fixtures`), spelled out.
  const FIXTURES = "/o/org/c/comp/d/div-one?tab=fixtures";

  async function render() {
    const tree = (await FixturePage({
      params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div-one", no: "7" }),
      searchParams: Promise.resolve({}),
    })) as ReactNode;
    const backs = findAll(tree, (el) => el.type === BackLink);
    const rows = findAll(tree, (el) => props(el)["data-role"] === "match-top-row");
    return {
      backs,
      rows,
      inRow: rows[0] ? findAll(rows[0], (el) => el.type === BackLink || el.type === CheckinQr).map((el) => el.type) : [],
      checkin: findAll(tree, (el) => el.type === CheckinQr).length,
      meLinks: findAll(tree, (el) => el.type !== BackLink && props(el).href === "/me"),
    };
  }

  it("every viewer, every fixture status, frozen or not: exactly one, first in the top row, to a page that viewer can open", async () => {
    let checked = 0;
    let withCheckin = 0;
    let withoutCheckin = 0;
    for (const v of VIEWERS) {
      for (const status of STATUSES) {
        for (const frozen of [false, true]) {
          Object.assign(scene, { role: v.role, canEdit: v.canEdit, canScore: v.canScore, status, frozen });
          const at = `${v.who} · ${status} · frozen ${String(frozen)}`;
          const p = await render();
          expect(p.backs, at).toHaveLength(1);
          expect(p.rows, at).toHaveLength(1);
          expect(props(p.backs[0]!).href, at).toBe(v.member ? FIXTURES : "/me");
          expect(props(p.backs[0]!).emphasis, at).toBe("round");
          expect(props(p.backs[0]!).label, at).toBe(v.member ? uiEn["fixture.back.fixtures"] : uiEn["fixture.back.myMatches"]);
          // Same row as the check-in QR, back button first (left). The QR keeps its own gate.
          const offersCheckin = v.canEdit && status === "scheduled" && !frozen;
          expect(p.inRow, at).toEqual(offersCheckin ? [BackLink, CheckinQr] : [BackLink]);
          expect(p.checkin, at).toBe(offersCheckin ? 1 : 0);
          if (offersCheckin) withCheckin++;
          else withoutCheckin++;
          checked++;
        }
      }
    }
    expect(checked).toBe(VIEWERS.length * STATUSES.length * 2);
    expect(withCheckin, "anti-vacuity: some scenes do offer the QR").toBeGreaterThan(0);
    expect(withoutCheckin, "anti-vacuity: and some do not").toBeGreaterThan(0);
  });

  // Whole class tokens, never a substring or a `\b` regex: `md:hidden` sits inside `max-md:hidden`, so a looser match
  // passes on its own inversion.
  const tokens = (className: unknown): string[] => String(className ?? "").split(/\s+/).filter(Boolean);
  const hiding = (list: string[]) => list.filter((c) => c === "hidden" || c.endsWith(":hidden"));
  const spacing = (list: string[]) => list.filter((c) => /(^|:)-?m[trblxy]?-/.test(c)).sort();

  it("desktop only for anyone with the breadcrumb (owner 2026-11-26): below md a member sees the page as it was before the button", async () => {
    // What origin/main drew below md: the QR's own row `mb-3`, a member official's courtside line `mb-4`, else NOTHING.
    const PHONE_AS_BEFORE = { checkin: ["max-md:mb-3"], courtside: ["max-md:mb-4"], nothing: ["max-md:hidden"] } as const;
    const seen = { checkin: 0, courtside: 0, nothing: 0, stranger: 0 };
    let checked = 0;
    for (const v of VIEWERS) {
      for (const status of STATUSES) {
        for (const frozen of [false, true]) {
          Object.assign(scene, { role: v.role, canEdit: v.canEdit, canScore: v.canScore, status, frozen });
          const at = `${v.who} · ${status} · frozen ${String(frozen)}`;
          const p = await render();
          const arrow = tokens(/class="([^"]*)"/.exec(renderToStaticMarkup(p.backs[0]!))![1]);
          const row = tokens(props(p.rows[0]!).className);
          if (!v.member) {
            // No breadcrumb: the button is their only way back, so nothing hides it at any width.
            expect(hiding(arrow), at).toEqual([]);
            expect(hiding(row), at).toEqual([]);
            expect(spacing(row), at).toEqual(["-mt-6", "mb-2", "md:-mt-3", "md:mb-3"].sort());
            seen.stranger++;
          } else {
            expect(hiding(arrow), `${at}: the arrow is hidden below md only`).toEqual(["max-md:hidden"]);
            const officialLine = v.canScore && !v.canEdit;
            const phone = v.canEdit && status === "scheduled" && !frozen ? "checkin" : officialLine ? "courtside" : "nothing";
            const margins = phone === "nothing" ? [] : PHONE_AS_BEFORE[phone];
            expect(hiding(row), `${at}: ${phone}`).toEqual(phone === "nothing" ? [...PHONE_AS_BEFORE.nothing] : []);
            // Every margin names its side of md: an unprefixed one would move the phone page too.
            expect(spacing(row), `${at}: ${phone}`).toEqual([...margins, "md:-mt-3", "md:mb-3"].sort());
            seen[phone]++;
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(VIEWERS.length * STATUSES.length * 2);
    for (const [kind, n] of Object.entries(seen)) expect(n, `anti-vacuity: the ${kind} case is reached`).toBeGreaterThan(0);
  });

  it("an official scorer's courtside line: a member keeps its My matches shortcut; a non-member's is the back button, not a second link", async () => {
    Object.assign(scene, { role: "viewer", canEdit: false, canScore: true });
    const member = await render();
    expect(member.meLinks, "member official: the shortcut stays").toHaveLength(1);
    expect(props(member.meLinks[0]!).children).toBe(uiEn["fixture.myMatches"]);
    Object.assign(scene, { role: null });
    const stranger = await render();
    expect(stranger.meLinks, "non-member official: no second way to /me").toHaveLength(0);
    expect(props(stranger.backs[0]!).href).toBe("/me");
  });

  it("is a real link with a localised name and a 44px target, in all four locales", async () => {
    let checked = 0;
    for (const [locale, ui] of [["en", uiEn], ["es", uiEs], ["fr", uiFr], ["nl", uiNl]] as const) {
      for (const [role, key, href] of [
        ["admin", "fixture.back.fixtures", FIXTURES],
        [null, "fixture.back.myMatches", "/me"],
      ] as const) {
        Object.assign(scene, { locale, role, canEdit: role !== null, canScore: true });
        const [back] = (await render()).backs;
        const html = renderToStaticMarkup(back!);
        const name = ui[key];
        expect(name, `${locale} has the key`).toBeTruthy();
        expect(html, locale).toMatch(/^<a [^>]*>.*<\/a>$/);
        expect(html, locale).toContain(`href="${href}"`);
        expect(html, locale).toContain(`aria-label="${name.replaceAll("'", "&#x27;")}"`);
        // h-11 w-11 = 44px square.
        expect(html, locale).toMatch(/class="[^"]*\bh-11 w-11\b[^"]*"/);
        checked++;
      }
    }
    expect(checked).toBe(8);
    const translated = new Set([uiEn, uiEs, uiFr, uiNl].map((ui) => ui["fixture.back.fixtures"]));
    expect(translated.size, "four different strings, not English four times").toBe(4);
  });
});
