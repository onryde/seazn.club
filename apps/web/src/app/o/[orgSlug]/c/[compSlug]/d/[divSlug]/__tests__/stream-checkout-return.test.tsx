// Task 14 fix round 1 — G1: the match-credit checkout returns to THIS page
// (`?tab=fixtures&fixture=…&stream=open&checkout=success&session_id=…`, see
// app/api/billing/relay-checkout/route.ts), and the return render can beat
// Stripe's webhook. The page reconciles the session BEFORE it reads the balance
// it hands the Phone tab, or the club that has just paid is shown the buy card
// again. Same harness as roster-drift-stage-wiring.test.tsx beside it (the async
// server component called directly, its element tree walked — no jsdom here),
// so what is pinned is the page's REAL wiring: which usecase it calls, with
// what, in which order, and what the Phone tab is handed as a result.
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
  open: vi.fn<(auth: unknown, fixtureIds: readonly string[]) => Promise<string[]>>(async () => []),
}));
vi.mock("@/server/usecases/stream-credits-checkout", () => ({
  reconcileStreamCreditsCheckout: (orgId: string, sessionId: string) => relay.reconcile(orgId, sessionId),
}));
// P1: the currency the relay-checkout route charges — the page resolves the SAME function for the same org.
const money = vi.hoisted(() => ({ preferredCurrency: vi.fn<(orgId: string | null, req?: Request) => Promise<string>>(async () => "gbp") }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: (orgId: string | null, req?: Request) => money.preferredCurrency(orgId, req) }));
vi.mock("@/server/usecases/stream-sessions", () => ({
  relayBalance: (auth: unknown, orgId: string) => relay.balance(auth, orgId),
  openStreamFixtureIds: (auth: unknown, fixtureIds: readonly string[]) => relay.open(auth, fixtureIds),
}));

import DivisionPage from "../page";
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

const render = (sp: Record<string, string>) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve(sp),
  });

const streamBalanceOf = async (sp: Record<string, string>): Promise<unknown> => {
  const panel = find(await render(sp), StagesPanel);
  expect(panel, "no StagesPanel on the fixtures tab").not.toBeNull();
  return (panel!.props as { stream?: { streamBalance?: unknown } }).stream?.streamBalance;
};

describe("the checkout return reconciles the session BEFORE the Phone tab's balance is read (G1)", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.reconcile.mockClear();
    relay.balance.mockReset();
    relay.open.mockReset().mockResolvedValue([]);
    scene.frozen = false;
    scene.fixtures = [];
    scene.entrants = [];
  });

  it("?checkout=success&session_id=… reconciles THAT session for THIS page's org, then reads the balance — and hands the tab the post-reconcile number", async () => {
    // The balance double answers 0 until the reconcile has run and the purchase's credits after — so the number the tab
    // receives can only be the fresh one if the ORDER is right (an order-blind test would pass on either).
    let reconciled = false;
    relay.reconcile.mockImplementation(async () => { reconciled = true; return true; });
    relay.balance.mockImplementation(async () => (reconciled ? 5 : 0));
    const balance = await streamBalanceOf({
      tab: "fixtures", fixture: "fx-1", stream: "open", checkout: "success", session_id: "cs_test_return_1",
    });
    expect(relay.reconcile).toHaveBeenCalledTimes(1);
    expect(relay.reconcile).toHaveBeenCalledWith(PAGE.auth.orgId, "cs_test_return_1");
    expect(relay.reconcile.mock.invocationCallOrder[0]!).toBeLessThan(relay.balance.mock.invocationCallOrder[0]!);
    expect(balance, "the tab was handed the pre-reconcile balance").toBe(5);
  });

  it("an ordinary visit — no checkout, a cancelled checkout, a success without its session id — makes NO Stripe reconcile", async () => {
    relay.balance.mockResolvedValue(2);
    let checked = 0;
    for (const sp of [
      { tab: "fixtures" } as Record<string, string>,
      { tab: "fixtures", checkout: "cancel", session_id: "cs_test_x" },
      { tab: "fixtures", checkout: "success" },
    ]) {
      // The positive half of the pair: the page still hands the tab the balance it read (G4's seam, witnessed here).
      expect(await streamBalanceOf(sp), JSON.stringify(sp)).toBe(2);
      checked++;
    }
    expect(checked).toBe(3);
    expect(relay.reconcile).not.toHaveBeenCalled();
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
});

// P1 (Task 14 fix round 2): the tiles quoted GBP while `/api/billing/relay-checkout` charged `preferredCurrency(orgId,
// req)` — capture pass 2 saw a £25 tile open a $33.25 checkout. The page now resolves the same function for the same org
// and hands the Phone tab the result, so the tiles quote in the currency the checkout will charge.
describe("P1: the Phone tab is handed the currency the checkout will charge", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.balance.mockReset().mockResolvedValue(3);
    money.preferredCurrency.mockReset();
    scene.frozen = false;
    scene.fixtures = [];
    scene.entrants = [];
  });

  it("resolves preferredCurrency for THIS org and passes it through — every non-GBP currency, not just one", async () => {
    let checked = 0;
    for (const currency of ["usd", "eur", "inr"]) {
      money.preferredCurrency.mockClear().mockResolvedValue(currency);
      const panel = find(await render({ tab: "fixtures" }), StagesPanel);
      expect((panel!.props as { stream?: { currency?: unknown } }).stream?.currency, currency).toBe(currency);
      expect(money.preferredCurrency).toHaveBeenCalledTimes(1);
      expect(money.preferredCurrency.mock.calls[0]![0]).toBe(PAGE.auth.orgId);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
