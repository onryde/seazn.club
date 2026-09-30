// The division page's stream wiring. Same harness as roster-drift-stage-wiring.test.tsx beside it (the async server
// component called directly, its element tree walked — no jsdom here), so what is pinned is the page's REAL wiring.
//
// Spec 2026-09-30 §2 (T5): the context-level cases (G1 reconcile-before-balance, Task 14b split, I2/N1 relay
// availability, P1 currency, M4 concurrency, RT overlay keys) MOVED to server/__tests__/stream-panel-context.test.ts,
// with the reads themselves: the page now calls THE loader, and this file keeps the case proving it does — with what
// gate, competition and fixture order — beside the division-only cases (F1's frozen probes, D2's hand-over).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
// F1: the scene a billing-frozen page renders — the competition's freeze, the division's fixtures and entrants.
const scene = vi.hoisted(() => ({ frozen: false, fixtures: [] as unknown[], entrants: [] as unknown[] }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);

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
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({
    id: "comp-1",
    frozen: scene.frozen,
    visibility: "private",
    slug: "comp-one",
  })),
}));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => scene.fixtures),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/entrants")>()),
  listEntrants: vi.fn(async () => scene.entrants),
}));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
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

const relay = vi.hoisted(() => ({
  reconcile: vi.fn<(orgId: string, sessionId: string) => Promise<boolean>>(async () => true),
  balance: vi.fn<(auth: unknown, orgId: string) => Promise<number>>(async () => 0),
  // Task 14b: the page reads `relayCredits` (the balance split by bucket + the plan's monthly allowance). Its double is
  // COMPOSED over `balance` above, so every G1/M4 test keeps witnessing the same read; `split` shapes the rest.
  split: vi.fn<(total: number) => { monthly: number; pack: number; monthlyAllowance: number }>((total) => ({ monthly: 0, pack: total, monthlyAllowance: 1 })),
  open: vi.fn<(auth: unknown, fixtureIds: readonly string[]) => Promise<string[]>>(async () => []),
}));
vi.mock("@/server/usecases/stream-credits-checkout", () => ({
  reconcileStreamCreditsCheckout: (orgId: string, sessionId: string) => relay.reconcile(orgId, sessionId),
}));
// P1: the currency the relay-checkout route charges — the page resolves the SAME function for the same org.
const money = vi.hoisted(() => ({ preferredCurrency: vi.fn<(orgId: string | null, req?: Request) => Promise<string>>(async () => "gbp") }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: (orgId: string | null, req?: Request) => money.preferredCurrency(orgId, req) }));
vi.mock("@/server/usecases/stream-sessions", () => ({
  relayCredits: async (auth: unknown, orgId: string) => {
    const total = await relay.balance(auth, orgId);
    return { ...relay.split(total), total };
  },
  openStreamFixtureIds: (auth: unknown, fixtureIds: readonly string[]) => relay.open(auth, fixtureIds),
}));

// The loader is the REAL one, wrapped in a spy: the F1 cases below still run the page through its real reads, and the
// loader case reads what the page CALLED it with.
const loader = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/server/stream-panel-context", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/stream-panel-context")>();
  return {
    loadStreamPanelContext: (a: Parameters<typeof real.loadStreamPanelContext>[0]) => {
      loader.calls.push(a);
      return real.loadStreamPanelContext(a);
    },
  };
});

import DivisionPage from "../page";
import { hasFeature } from "@/lib/entitlements";
import { StagesPanel } from "@/components/v2/stages-panel";
import { PhoneStopProbe } from "@/components/v2/fixture-stream-panel";

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

const render = (sp: Record<string, string | string[]>) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve(sp),
  });

describe("the page hands its stream context to the run sheet through THE loader (spec 2026-09-30 §2)", () => {
  const fx = (id: string, no: number) => ({
    id, stage_id: "st-1", pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
    home_entrant_id: null, away_entrant_id: null, home_slot_label: null, away_slot_label: null,
    scheduled_at: null, status: "scheduled", outcome: null,
  });
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.reconcile.mockClear();
    relay.balance.mockReset().mockResolvedValue(6);
    relay.open.mockReset().mockResolvedValue([]);
    loader.calls.length = 0;
    scene.frozen = false;
    scene.fixtures = [fx("fx-2", 2), fx("fx-1", 1), fx("fx-3", 3)];
    scene.entrants = [];
  });

  it("calls the loader ONCE with offered = the fixtures tab AND editable, its competition, the fixture ids in page order and the checkout params — and hands StagesPanel what it answered", async () => {
    const tree = await render({ tab: "fixtures", checkout: "success", session_id: "cs_div_1" });
    expect(loader.calls).toHaveLength(1);
    expect(loader.calls[0]).toMatchObject({
      auth: PAGE.auth,
      competitionId: "comp-1",
      sportKey: "generic",
      fixtureIds: ["fx-2", "fx-1", "fx-3"],
      offered: true,
      checkout: { status: "success", sessionId: "cs_div_1" },
    });
    // What the loader answered IS what the run sheet gets — the balance is the (mocked) relay read, through the loader.
    expect((find(tree, StagesPanel)!.props as { stream?: { streamBalance?: unknown } }).stream?.streamBalance).toBe(6);
  });

  it("offered is false — and nothing is read — off the fixtures tab, for a viewer who cannot edit, and on a frozen page", async () => {
    let checked = 0;
    for (const [name, setup, sp] of [
      ["standings tab", () => {}, { tab: "standings" }],
      ["cannot edit", () => { pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false }); }, { tab: "fixtures" }],
      ["frozen", () => { scene.frozen = true; }, { tab: "fixtures" }],
    ] as const) {
      loader.calls.length = 0;
      relay.balance.mockClear();
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      scene.frozen = false;
      setup();
      await render(sp as Record<string, string>);
      expect(loader.calls, name).toHaveLength(1);
      expect((loader.calls[0] as { offered: boolean }).offered, name).toBe(false);
      expect(relay.balance, `${name}: no credits read`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// F1 (Task 14 fix round 2): a billing freeze makes the page read-only (`editable = canEdit && !billingFrozen`), and the
// stream panel is gated on `editable` — so a competition that froze MID-STREAM had no Stop anywhere, while the stop route
// itself still serves the frozen org's organiser. The page now mounts the stop-only probe for each fixture with a session
// still up, and only on the fixtures tab of a frozen competition, for a viewer who could otherwise edit.
describe("F1: a billing-frozen competition still offers Stop for every stream on air", () => {
  const NAMES: Record<string, string> = { e1: "Red Rovers", e2: "Blue Jays", e3: "Green Giants", e4: "Gold Geese" };
  const fx = (id: string, home: string | null, away: string | null, no: number) => ({
    id, stage_id: "st-1", pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
    home_entrant_id: home, away_entrant_id: away, home_slot_label: null, away_slot_label: null,
    scheduled_at: null, status: "scheduled", outcome: null,
  });
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.open.mockReset().mockResolvedValue([]);
    scene.frozen = true;
    scene.fixtures = [fx("fx-1", "e1", "e2", 1), fx("fx-2", "e3", "e4", 2), fx("fx-3", null, "e1", 3)];
    scene.entrants = Object.entries(NAMES).map(([id, display_name], i) => ({ id, display_name, status: "confirmed", seed: i + 1 }));
  });

  it("frozen, fixtures tab, an organiser: asks for THIS division's fixtures and mounts one labelled probe per open stream", async () => {
    relay.open.mockResolvedValue(["fx-3", "fx-2"]);
    const tree = await render({ tab: "fixtures" });
    expect(relay.open).toHaveBeenCalledTimes(1);
    expect(relay.open.mock.calls[0]![0]).toBe(PAGE.auth);
    expect(relay.open.mock.calls[0]![1]).toEqual(["fx-1", "fx-2", "fx-3"]);
    const probes = findAll(tree, PhoneStopProbe);
    // In the division's fixture order, whatever order the read answered in.
    expect(probes.map((p) => (p.props as { fixtureId: string }).fixtureId)).toEqual(["fx-2", "fx-3"]);
    // Named by the fixture's own entrants and the dictionary's "vs" — the `t` double answers with the key — and an
    // unfilled side by the slot resolver's TBD.
    expect(probes.map((p) => (p.props as { label?: string }).label)).toEqual([
      "Green Giants schedule.vs Gold Geese",
      "schedule.tbd schedule.vs Red Rovers",
    ]);
    // The panel stays gated: the probe is the ONLY stream control a frozen page offers.
    expect((find(tree, StagesPanel)!.props as { stream?: unknown }).stream).toBeUndefined();
  });

  it("nothing on air: no probe", async () => {
    const tree = await render({ tab: "fixtures" });
    expect(relay.open).toHaveBeenCalledTimes(1);
    expect(findAll(tree, PhoneStopProbe)).toEqual([]);
  });

  it("NOT frozen, a viewer who cannot edit, or another tab: no query and no probe — the live panel (or nothing) owns Stop there", async () => {
    relay.open.mockResolvedValue(["fx-1"]);
    let checked = 0;
    for (const [name, setup, sp] of [
      ["not frozen", () => { scene.frozen = false; }, { tab: "fixtures" }],
      ["cannot edit", () => { pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false }); }, { tab: "fixtures" }],
      ["standings tab", () => {}, { tab: "standings" }],
    ] as const) {
      relay.open.mockClear();
      scene.frozen = true;
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      setup();
      const tree = await render(sp as Record<string, string>);
      expect(relay.open, name).not.toHaveBeenCalled();
      expect(findAll(tree, PhoneStopProbe), name).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  // I-2 (lane-close review): since V426 every plan grants `streaming.overlay`, so the only way it goes false is a staff
  // override — and the panel (with its Phone tab and Stop) is gated on it, the row's toggle too (run-sheet-row.tsx
  // `showStream`). A club whose overlay was switched off MID-STREAM had no Stop anywhere while the relay kept sending.
  // The page mounts the same labelled stop-only probes it mounts for a billing freeze.
  it("I-2: NOT frozen, but an override switched streaming.overlay OFF — the same labelled probe per open stream, and still no panel", async () => {
    scene.frozen = false;
    relay.open.mockResolvedValue(["fx-1"]);
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.overlay");
    try {
      const tree = await render({ tab: "fixtures" });
      expect(relay.open).toHaveBeenCalledTimes(1);
      expect(relay.open.mock.calls[0]![1]).toEqual(["fx-1", "fx-2", "fx-3"]);
      const probes = findAll(tree, PhoneStopProbe);
      expect(probes.map((p) => (p.props as { fixtureId: string }).fixtureId)).toEqual(["fx-1"]);
      expect(probes.map((p) => (p.props as { label?: string }).label)).toEqual(["Red Rovers schedule.vs Blue Jays"]);
      // Premise: the switched-off org has no panel to find a Stop in — the probe is the only way out.
      expect((find(tree, StagesPanel)!.props as { stream?: { entitled?: unknown } }).stream?.entitled).toBe(false);

      // The pair: a viewer who cannot edit gets neither the query nor a probe, overlay or not.
      relay.open.mockClear();
      pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
      const viewer = await render({ tab: "fixtures" });
      expect(relay.open, "cannot edit").not.toHaveBeenCalled();
      expect(findAll(viewer, PhoneStopProbe)).toEqual([]);
    } finally {
      vi.mocked(hasFeature).mockImplementation(async () => true);
    }
  });
});

// D2 (stream-credits walkthrough, owner: fix now, 2026-09-29): the return's fixture is rendered only if the run sheet
// MOUNTS on a filter that keeps its row — decided inside StagesPanel (`initialRunSheetFilter`) from the URL's `stream`
// and `fixture` params. The panel cannot read them itself (its tests mock `next/navigation` with `useRouter` alone), so
// the page must hand them over; this pins that hand-over, the seam the panel's own unit test cannot see.
describe("D2: the page hands StagesPanel the URL's checkout-return params", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.reconcile.mockClear();
    relay.balance.mockReset().mockResolvedValue(0);
    relay.open.mockReset().mockResolvedValue([]);
    scene.frozen = false;
    scene.fixtures = [];
    scene.entrants = [];
  });

  const checkoutReturnOf = async (sp: Record<string, string | string[]>): Promise<unknown> => {
    const panel = find(await render(sp), StagesPanel);
    expect(panel, "no StagesPanel on the fixtures tab").not.toBeNull();
    return (panel!.props as { checkoutReturn?: unknown }).checkoutReturn;
  };

  it("a checkout return: the panel is handed exactly the URL's stream and fixture", async () => {
    expect(
      await checkoutReturnOf({ tab: "fixtures", fixture: "fx-1", stream: "open", checkout: "success", session_id: "cs_test_d2" }),
    ).toEqual({ stream: "open", fixture: "fx-1" });
  });

  it("a REPEATED key (Next hands a string[]): the panel gets the FIRST value, as useSearchParams().get does", async () => {
    // fixture-stream-panel's auto-open reads `useSearchParams().get("fixture")` — URLSearchParams.get answers the FIRST
    // value — so the filter must be derived from the same one, or the two readers disagree about which row is named.
    const url = new URLSearchParams("tab=fixtures&stream=open&fixture=fx-1&fixture=fx-2&stream=closed");
    expect([url.get("stream"), url.get("fixture")], "the premise: get() answers the first of each").toEqual(["open", "fx-1"]);
    expect(
      await checkoutReturnOf({ tab: "fixtures", stream: url.getAll("stream"), fixture: url.getAll("fixture") }),
    ).toEqual({ stream: url.get("stream"), fixture: url.get("fixture") });
  });

  it("an ordinary visit: the panel is handed no stream and no fixture (the positive pair's other half)", async () => {
    expect(await checkoutReturnOf({ tab: "fixtures" })).toEqual({ stream: undefined, fixture: undefined });
  });
});
