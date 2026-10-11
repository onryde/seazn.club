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
}));
const spies = vi.hoisted(() => ({
  loader: vi.fn(),
  openStreams: vi.fn(),
}));

vi.mock("@/server/page-auth", () => ({
  requireFixturePage: vi.fn(async () => ({
    auth: { orgId: "org-1", userId: "u-1" },
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
    home_entrant_id: "e-home",
    away_entrant_id: "e-away",
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
    display_name: id === "e-home" ? "Alpha Athletic" : "Bravo Rangers",
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
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/components/v2/checkin-qr", () => ({ CheckinQr: () => null }));
vi.mock("@/components/v2/fixture-officials-strip", () => ({ FixtureOfficialsStrip: () => null }));
vi.mock("@/components/v2/fixture-console", () => ({ FixtureConsole: () => null }));
vi.mock("@/server/stream-panel-context", () => ({ loadStreamPanelContext: spies.loader }));
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: spies.openStreams }));

import FixturePage from "../page";
import { FixtureConsole } from "@/components/v2/fixture-console";

const CONTEXT = { entitled: true, relayEntitled: true, relayDisabled: false, orgId: "org-1", streamBalance: 2 };

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
  Object.assign(scene, { canEdit: true, canScore: true, frozen: false, status: "scheduled", open: [], feedsNext: true, stageKind: null });
  spies.loader.mockReset();
  spies.loader.mockImplementation(async () => CONTEXT);
  spies.openStreams.mockReset();
  spies.openStreams.mockImplementation(async () => Object.fromEntries(scene.open.map((id) => [id, "live"])));
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
