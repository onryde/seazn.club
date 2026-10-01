// The division page's stream wiring. Same harness as roster-drift-stage-wiring.test.tsx beside it (the async server
// component called directly, its element tree walked — no jsdom here), so what is pinned is the page's REAL wiring.
//
// Spec 2026-09-30 §2: the context-level cases (G1 reconcile-before-balance, Task 14b split, I2/N1 relay availability, P1
// currency, M4 concurrency, RT overlay keys) MOVED to server/__tests__/stream-panel-context.test.ts in T5, and in T6 the
// division stopped calling the loader at all (the panel lives on the fixture page). What stays here is the division's
// one stream read — `openStreamStates`, for the run sheet's chip — with its organiser gate, and the pin that the page
// builds no panel context and mounts no probe stack. The loader is still wrapped in a spy so "never called" is a
// witnessed fact rather than an absent import.
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
  states: vi.fn<(auth: unknown, fixtureIds: readonly string[]) => Promise<Record<string, "live" | "waiting">>>(async () => ({})),
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
  openStreamStates: (auth: unknown, fixtureIds: readonly string[]) => relay.states(auth, fixtureIds),
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

// Spec 2026-09-30 §2 (T6): the division page stops building StreamPanelContext and stops mounting the frozen-page stop
// probes. Its only stream read is `openStreamStates`, for the run sheet's chip — the division's path to Stop — and it is
// read for the PAGE-level organiser (`canEdit`), frozen or not, entitled or not: Stop must stay one tap away wherever a
// session is up (the fixture page's Stop-only mount is where the chip leads).
describe("the division hands the run sheet each fixture's stream state, and builds no stream panel (spec 2026-09-30 §2)", () => {
  const fx = (id: string, no: number) => ({
    id, stage_id: "st-1", pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
    home_entrant_id: null, away_entrant_id: null, home_slot_label: null, away_slot_label: null,
    scheduled_at: null, status: "scheduled", outcome: null,
  });
  const panelProps = (tree: ReactNode): Record<string, unknown> => {
    const panel = find(tree, StagesPanel);
    expect(panel, "no StagesPanel on the fixtures tab").not.toBeNull();
    return panel!.props as Record<string, unknown>;
  };
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.states.mockReset().mockResolvedValue({});
    loader.calls.length = 0;
    scene.frozen = false;
    scene.fixtures = [fx("fx-2", 2), fx("fx-1", 1), fx("fx-3", 3)];
    scene.entrants = [];
  });

  it("fixtures tab, an organiser: ONE read for THIS division's fixtures, and StagesPanel gets exactly what it answered — no panel context, no checkout return", async () => {
    relay.states.mockResolvedValue({ "fx-2": "live", "fx-3": "waiting" });
    const tree = await render({ tab: "fixtures", stream: "open", fixture: "fx-2", checkout: "success", session_id: "cs_old" });
    expect(relay.states).toHaveBeenCalledTimes(1);
    expect(relay.states.mock.calls[0]![0]).toBe(PAGE.auth);
    expect(relay.states.mock.calls[0]![1]).toEqual(["fx-2", "fx-1", "fx-3"]);
    const props = panelProps(tree);
    expect(props.streamStates).toEqual({ "fx-2": "live", "fx-3": "waiting" });
    expect(props.stream, "the division builds no StreamPanelContext").toBeUndefined();
    expect(props.checkoutReturn, "the checkout return lands on the fixture page now").toBeUndefined();
    expect(loader.calls, "the context loader is the fixture page's, never the division's").toHaveLength(0);
    expect(findAll(tree, PhoneStopProbe), "no probe stack on the division").toEqual([]);
  });

  it("F1: a billing-FROZEN page and an overlay switched off (I-2) still read the states — the chip is the only path to Stop from here", async () => {
    relay.states.mockResolvedValue({ "fx-1": "live" });
    let checked = 0;
    for (const [name, setup] of [
      ["frozen", () => { scene.frozen = true; }],
      ["overlay off", () => { vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.overlay"); }],
    ] as const) {
      relay.states.mockClear();
      scene.frozen = false;
      setup();
      try {
        const tree = await render({ tab: "fixtures" });
        expect(relay.states, name).toHaveBeenCalledTimes(1);
        expect(panelProps(tree).streamStates, name).toEqual({ "fx-1": "live" });
        expect(findAll(tree, PhoneStopProbe), `${name}: no probe stack any more`).toEqual([]);
      } finally {
        vi.mocked(hasFeature).mockImplementation(async () => true);
      }
      checked++;
    }
    expect(checked).toBe(2);
    expect(loader.calls).toHaveLength(0);
  });

  it("organisers only: a viewer who cannot edit, and any other tab, read NO state", async () => {
    relay.states.mockResolvedValue({ "fx-1": "live" });
    let checked = 0;
    for (const [name, setup, sp] of [
      ["cannot edit", () => { pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false }); }, { tab: "fixtures" }],
      ["standings tab", () => {}, { tab: "standings" }],
    ] as const) {
      relay.states.mockClear();
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      setup();
      const tree = await render(sp as Record<string, string>);
      expect(relay.states, name).not.toHaveBeenCalled();
      const panel = find(tree, StagesPanel);
      if (panel) expect((panel.props as { streamStates?: unknown }).streamStates ?? {}, name).toEqual({});
      checked++;
    }
    expect(checked).toBe(2);
  });
});
