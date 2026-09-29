// Task 14 fix round 1 — G1: the match-credit checkout returns to THIS page
// (`?tab=fixtures&fixture=…&stream=open&checkout=success&session_id=…`, see
// app/api/billing/relay-checkout/route.ts), and the return render can beat
// Stripe's webhook. The page reconciles the session BEFORE it reads the balance
// it hands the Phone tab, or the club that has just paid is shown the buy card
// again. Same harness as roster-drift-stage-wiring.test.tsx beside it (the async
// server component called directly, its element tree walked — no jsdom here),
// so what is pinned is the page's REAL wiring: which usecase it calls, with
// what, in which order, and what the Phone tab is handed as a result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import DivisionPage from "../page";
import { hasFeature } from "@/lib/entitlements";
import { StagesPanel } from "@/components/v2/stages-panel";
import { PhoneStopProbe } from "@/components/v2/fixture-stream-panel";
import { disabledRelayDrivers, relayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { verifyOverlayKey } from "@/server/overlay/overlay-key";

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

// Task 14b (R3b/R4): the page reads the balance through `relayCredits` — which grants this month's free credits first —
// and hands the Phone tab the chip's total, the split behind it and the plan's monthly allowance, from that ONE read.
describe("Task 14b: the Phone tab is handed the split and the monthly allowance from the page's one credits read", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.balance.mockReset();
    relay.split.mockReset();
    scene.frozen = false;
    scene.fixtures = [];
    scene.entrants = [];
  });

  it("passes the total as the chip, the split behind it and the allowance — each a value no default could produce", async () => {
    relay.balance.mockResolvedValue(7);
    relay.split.mockReturnValue({ monthly: 2, pack: 5, monthlyAllowance: 20 });
    const stream = (find(await render({ tab: "fixtures" }), StagesPanel)!.props as {
      stream?: { streamBalance?: unknown; streamSplit?: unknown; monthlyAllowance?: unknown };
    }).stream;
    expect(relay.balance).toHaveBeenCalledTimes(1);
    expect(relay.balance.mock.calls[0]![1]).toBe(PAGE.auth.orgId);
    expect(stream?.streamBalance).toBe(7);
    expect(stream?.streamSplit).toEqual({ monthly: 2, pack: 5, total: 7 });
    expect(stream?.monthlyAllowance).toBe(20);
  });

  it("I2: a deployment with NO relay (R5's disabled drivers) tells the tab so, and reads no credits — that read GRANTS; the relay back on reads them again", async () => {
    relay.balance.mockResolvedValue(3);
    relay.split.mockReturnValue({ monthly: 1, pack: 2, monthlyAllowance: 1 });
    type Stream = { relayEntitled?: unknown; relayDisabled?: unknown; streamBalance?: unknown; streamSplit?: unknown };
    const streamOf = async () => (find(await render({ tab: "fixtures" }), StagesPanel)!.props as { stream?: Stream }).stream;
    setRelayDriversForTest(disabledRelayDrivers());
    try {
      const off = await streamOf();
      expect(off).toMatchObject({ relayEntitled: true, relayDisabled: true, streamBalance: 0, streamSplit: null });
      expect(relay.balance, "no grant-and-read on a relay-less deployment").not.toHaveBeenCalled();
    } finally {
      setRelayDriversForTest(null);
    }
    // The positive pair: the default (fake) drivers — the tab is live and the credits are read.
    expect(await streamOf()).toMatchObject({ relayEntitled: true, relayDisabled: false, streamBalance: 3 });
    expect(relay.balance).toHaveBeenCalledTimes(1);
  });

  it("N1: a LIVE deployment missing its Cloudflare secret still renders the fixtures tab — the render never constructs the drivers", async () => {
    // The fixtures tab asks "is the relay off?" on every render. Answered by constructing the drivers, a live deploy
    // without CLOUDFLARE_* threw here for every org (V426 entitles the relay on every plan).
    relay.balance.mockResolvedValue(4);
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("ENV_NAME", "prod");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", "");
    setRelayDriversForTest(null);
    try {
      expect(() => relayDrivers(), "premise: constructing the drivers here throws").toThrow(/CLOUDFLARE_ACCOUNT_ID/);
      const stream = (find(await render({ tab: "fixtures" }), StagesPanel)!.props as {
        stream?: { relayEntitled?: unknown; relayDisabled?: unknown; streamBalance?: unknown };
      }).stream;
      expect(stream).toMatchObject({ relayEntitled: true, relayDisabled: false, streamBalance: 4 });
    } finally {
      vi.unstubAllEnvs();
      setRelayDriversForTest(null);
    }
  });

  it("without the relay: no credits read, and the tab gets no split and no allowance — the empty case", async () => {
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.relay");
    try {
      const stream = (find(await render({ tab: "fixtures" }), StagesPanel)!.props as {
        stream?: { streamBalance?: unknown; streamSplit?: unknown; monthlyAllowance?: unknown };
      }).stream;
      expect(relay.balance).not.toHaveBeenCalled();
      expect(stream).toMatchObject({ streamBalance: 0, streamSplit: null, monthlyAllowance: 0 });
    } finally {
      vi.mocked(hasFeature).mockImplementation(async () => true);
    }
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

  // M4 (fix round 4): the balance and the currency were awaited one after the other inside the object literal — one extra
  // round trip on every relay-entitled fixtures-tab render. Neither depends on the other, so neither may wait for it.
  it("M4: the balance and the currency are read CONCURRENTLY — the second is asked before the first has answered", async () => {
    let checked = 0;
    for (const slow of ["balance", "currency"] as const) {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      relay.balance.mockReset().mockImplementation(async () => { if (slow === "balance") await gate; return 4; });
      money.preferredCurrency.mockReset().mockImplementation(async () => { if (slow === "currency") await gate; return "usd"; });
      const page = render({ tab: "fixtures" });
      await vi.waitFor(() => expect(slow === "balance" ? relay.balance : money.preferredCurrency).toHaveBeenCalledTimes(1));
      // The slow one is still pending: the other must already have been asked.
      expect(slow === "balance" ? money.preferredCurrency : relay.balance, `${slow} held the other back`).toHaveBeenCalledTimes(1);
      release();
      const stream = (find(await page, StagesPanel)!.props as { stream?: { streamBalance?: unknown; currency?: unknown } }).stream;
      expect(stream?.streamBalance, slow).toBe(4);
      expect(stream?.currency, slow).toBe("usd");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("M4: without the relay neither is read — the tab gets 0 and gbp, and the page keeps its query budget", async () => {
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.relay");
    try {
      money.preferredCurrency.mockReset().mockResolvedValue("usd");
      const stream = (find(await render({ tab: "fixtures" }), StagesPanel)!.props as { stream?: { relayEntitled?: unknown; streamBalance?: unknown; currency?: unknown } }).stream;
      expect(stream?.relayEntitled, "premise: overlay yes, relay no").toBe(false);
      expect(stream?.streamBalance).toBe(0);
      expect(stream?.currency).toBe("gbp");
      expect(relay.balance).not.toHaveBeenCalled();
      expect(money.preferredCurrency).not.toHaveBeenCalled();
    } finally {
      vi.mocked(hasFeature).mockImplementation(async () => true);
    }
  });
});

// RT (lane-close fix, ruled 2026-09-29): the page mints each row's signed overlay key for the OBS URL its panel copies —
// the grant a community org's overlay presents at the realtime-token route. Folded through the REAL key module on both
// ends: what the page hands the panel must be what the route's `verifyOverlayKey` accepts, for THAT fixture only.
describe("RT: the page hands the panel one signed overlay key per fixture — and only with the panel", () => {
  const fx = (id: string) => ({
    id, stage_id: "st-1", pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
    home_entrant_id: null, away_entrant_id: null, home_slot_label: null, away_slot_label: null,
    scheduled_at: null, status: "scheduled", outcome: null,
  });
  const IDS = ["0b6c3a55-0000-4000-8000-000000000001", "0b6c3a55-0000-4000-8000-000000000002", "0b6c3a55-0000-4000-8000-000000000003"];
  const keysOf = async (sp: Record<string, string>) =>
    (find(await render(sp), StagesPanel)!.props as { stream?: { overlayKeys?: Record<string, string> } }).stream?.overlayKeys;
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.balance.mockReset().mockResolvedValue(1);
    relay.open.mockReset().mockResolvedValue([]);
    scene.frozen = false;
    scene.fixtures = IDS.map(fx);
    scene.entrants = [];
    vi.stubEnv("AUTH_SECRET", "rt-page-unit-secret-0123456789abcdef");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("every listed fixture gets a key the route verifies for IT and for no other listed fixture", async () => {
    const keys = await keysOf({ tab: "fixtures" });
    expect(Object.keys(keys ?? {}).sort(), "one key per fixture, none missing").toEqual([...IDS].sort());
    let own = 0;
    let crossed = 0;
    for (const a of IDS) {
      for (const b of IDS) {
        expect(verifyOverlayKey(b, keys![a]), `${a}'s key on ${b}`).toBe(a === b);
        if (a === b) own++; else crossed++;
      }
    }
    expect(own).toBe(IDS.length);
    expect(crossed).toBe(IDS.length * (IDS.length - 1));
  });

  it("no panel (overlay switched off) → no keys on the flight; no signing secret → no keys, and the page still renders", async () => {
    vi.mocked(hasFeature).mockImplementation(async (_org, key) => key !== "streaming.overlay");
    try {
      expect(await keysOf({ tab: "fixtures" }), "switched off").toEqual({});
    } finally {
      vi.mocked(hasFeature).mockImplementation(async () => true);
    }
    vi.stubEnv("AUTH_SECRET", "");
    expect(await keysOf({ tab: "fixtures" }), "no AUTH_SECRET").toEqual({});
    // The positive pair, the secret back: the keys are back.
    vi.stubEnv("AUTH_SECRET", "rt-page-unit-secret-0123456789abcdef");
    expect(Object.keys((await keysOf({ tab: "fixtures" })) ?? {})).toHaveLength(IDS.length);
  });
});
