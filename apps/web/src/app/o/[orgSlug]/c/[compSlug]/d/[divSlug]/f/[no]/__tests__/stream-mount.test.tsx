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
  loadFixturePadCfg: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    slug: "div-one",
    name: "Division One",
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
vi.mock("@/server/usecases/entrants", () => ({
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
  Object.assign(scene, { canEdit: true, canScore: true, frozen: false, status: "scheduled", open: [] });
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
