// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the organiser's Fixtures tab of a big division ships the rounds a person reads
// now and every other league/group round as a TALLY (`lib/run-sheet-paging.ts`); the bar loads its rows from `../rounds/route.ts`. Driven
// through the REAL page (the roster-drift harness: the async server component called directly, its tree walked) with the perf report's
// cap scene generated here - groups 512 in 26 pools, 4,788 lines - and the serialised StagesPanel props measured: the size bar's
// stand-in. Expected rows are counted off the scene.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  divisionFormatLocked: vi.fn(async () => false),
  getStageRosterDrift: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async () => ({})),
  t: (_dict: unknown, key: string) => key,
}));
// A board-game division's Fixtures tab reads its online-play queues (the board-game test below); nothing here is about them.
vi.mock("@/server/usecases/external-play", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/external-play")>()),
  listFlaggedExternalPlay: async () => ({ boards: [], ownBoards: 0 }),
  listNeedsOrganiserExternalPlay: async () => [],
  listOpenRounds: async () => [],
  listRunSheetOnlinePlay: async () => ({}),
  onlineChessOffered: async () => false,
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
    frozen: false,
    visibility: "private",
    slug: "comp-one",
  })),
}));
const fixturesSpies = vi.hoisted(() => ({ listDivisionFixtures: vi.fn(async () => [] as unknown[]), listFixtureHeadlines: vi.fn(async () => ({})) }));
vi.mock("@/server/usecases/fixtures", () => fixturesSpies);
const authSpies = vi.hoisted(() => ({ requireResourceAuth: vi.fn(async () => ({ orgId: "org-1", via: "session", userId: "user-1", role: "owner" })) }));
vi.mock("@/server/api-v1/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/api-v1/auth")>()), ...authSpies }));
// The real module under the one stub: the page reads `DEPARTED_STATUSES` from it (the knockout desk's waiting list).
vi.mock("@/server/usecases/entrants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/entrants")>()),
  listEntrants: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: [] }, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
// Task 14 P1: the fixtures tab resolves the checkout's currency (`preferredCurrency` reads cookies/headers), which has
// no request scope in a direct page call. Not what this suite pins.
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
// Spec 2026-09-30 §2 (T6): the fixtures tab's one stream read is `openStreamStates` (the run sheet's chip) — this page
// test is not about streaming, so it is an empty double.
vi.mock("@/server/usecases/stream-sessions", () => ({
  openStreamStates: async () => ({}),
}));

import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";
import { GET as roundsGET } from "../rounds/route";
import type { FoldedRunSheetRound } from "@/lib/run-sheet-paging";
import { getDivision } from "@/server/usecases/divisions";

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

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const GROUP = { id: "grp", name: "Groups", kind: "group", seq: 1, status: "active", config: {}, progression: null };
const NOW = Date.now();
const DAY = 86_400_000;
let n = 0;
/** One FixtureRow as `listDivisionFixtures` returns it. Rounds 1-9 played a week and more ago; the rest a week and more ahead. */
const row = (pool: number, round: number, seq: number) => {
  n += 1;
  const done = round <= 9;
  return {
    id: `f${n}`, division_id: "div-1", stage_id: "grp", pool_id: `pool${pool}`, fixture_no: n, round_no: round, seq_in_round: seq,
    status: done ? "decided" : "scheduled", scheduled_at: new Date(done ? NOW - (16 - round) * DAY : NOW + (round - 2) * DAY).toISOString(),
    home_entrant_id: `h${pool}-${seq}`, away_entrant_id: `a${pool}-${seq}`, outcome: done ? { kind: "win", winner: `h${pool}-${seq}` } : null,
    home_slot_label: null, away_slot_label: null, court_id: null, court_name: null, venue_name: null, officials: [], lane: null,
    is_final: false, third_place: false, conditional: false, ext_key: null, summary: null,
  };
};
function groups512() {
  n = 0;
  const sizes = [...Array(18).fill(20), ...Array(8).fill(19)] as number[];
  const out: ReturnType<typeof row>[] = [];
  sizes.forEach((size, p) => {
    const rounds = size % 2 === 0 ? size - 1 : size;
    for (let r = 1; r <= rounds; r++) for (let s = 1; s <= Math.floor(size / 2); s++) out.push(row(p, r, s));
  });
  return out;
}
const renderTab = (tab = "fixtures") =>
  DivisionPage({ params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }), searchParams: Promise.resolve({ tab }) });
const panelProps = async (tab = "fixtures") => find(await renderTab(tab), StagesPanel)?.props as { fixtures: { id: string; round_no: number }[]; foldedRounds: FoldedRunSheetRound[] } | undefined;

describe("C: the organiser's Fixtures tab of a big division ships its open rounds and a tally of the rest", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([GROUP]);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
  });

  it("groups 512 (4,788 lines): only round 10's rows reach StagesPanel, every other round is a tally, and the props are a fraction", async () => {
    const all = groups512();
    expect(all.length, "premise: the measured cap shape").toBe(4788);
    fixturesSpies.listDivisionFixtures.mockResolvedValue(all);
    const props = (await panelProps())!;
    const round10 = all.filter((f) => f.round_no === 10);
    expect(props.fixtures.map((f) => f.id).sort()).toEqual(round10.map((f) => f.id).sort());
    expect(props.foldedRounds.map((r) => r.round)).toEqual([...new Set(all.map((f) => f.round_no))].filter((r) => r !== 10).sort((a, b) => a - b));
    // Every line is accounted for: shipped, or in exactly one tally.
    expect(props.fixtures.length + props.foldedRounds.reduce((s, r) => s + r.rows, 0)).toBe(all.length);
    const full = JSON.stringify(all).length;
    const sent = JSON.stringify({ fixtures: props.fixtures, foldedRounds: props.foldedRounds }).length;
    expect(sent / full, `${sent} of ${full} bytes`).toBeLessThan(0.1);
  });

  it("a board-game division ships every row, however big: its run sheet reads each row's online-play state", async () => {
    const all = groups512();
    fixturesSpies.listDivisionFixtures.mockResolvedValue(all);
    const base = await getDivision(PAGE.auth as never, "div-1");
    vi.mocked(getDivision).mockResolvedValueOnce({ ...base, sport_key: "boardgame" } as never);
    const props = (await panelProps())!;
    expect(props.fixtures.length).toBe(4788);
    expect(props.foldedRounds).toEqual([]);
  });

  it("a small division ships every row and no tally", async () => {
    const all = groups512().filter((f) => f.pool_id === "pool0");
    expect(all.length).toBe(190);
    fixturesSpies.listDivisionFixtures.mockResolvedValue(all);
    const props = (await panelProps())!;
    expect(props.fixtures.length).toBe(190);
    expect(props.foldedRounds).toEqual([]);
  });
});

describe("C: the round loader beside the organiser's page", () => {
  const ask = (q: string) => roundsGET(new Request(`http://x/o/org/c/comp/d/div/rounds?${q}`));

  it("returns exactly the asked round's rows of the asked stage, every round of the scene swept, after a READ check on the division", async () => {
    const all = groups512();
    fixturesSpies.listDivisionFixtures.mockResolvedValue(all);
    authSpies.requireResourceAuth.mockClear();
    let rows = 0;
    for (let round = 1; round <= 19; round++) {
      const res = await ask(`division=div-1&stage=grp&round=${round}`);
      expect(res.status, `round ${round}`).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const got = ((await res.json()) as { data: { id: string }[] }).data.map((f) => f.id);
      expect(got, `round ${round}`).toEqual(all.filter((f) => f.round_no === round).map((f) => f.id));
      rows += got.length;
    }
    expect(rows, "anti-vacuity: every line came back once").toBe(all.length);
    expect(authSpies.requireResourceAuth.mock.calls.every((c) => { const a = c as unknown[]; return a[1] === "division" && a[2] === "div-1" && a[3] === "read"; })).toBe(true);
    expect(authSpies.requireResourceAuth).toHaveBeenCalledTimes(19);
  });

  it("refuses a malformed question before any read, and a round the stage does not have", async () => {
    fixturesSpies.listDivisionFixtures.mockResolvedValue(groups512());
    authSpies.requireResourceAuth.mockClear();
    let refused = 0;
    for (const q of ["", "division=div-1&stage=grp", "division=div-1&stage=grp&round=", "division=div-1&stage=grp&round=0", "division=div-1&stage=grp&round=1.5", "stage=grp&round=1", "division=div-1&round=1"]) {
      expect((await ask(q)).status, q).toBe(400);
      refused += 1;
    }
    expect(refused).toBe(7);
    expect(authSpies.requireResourceAuth, "no read before the question is sound").not.toHaveBeenCalled();
    expect((await ask("division=div-1&stage=grp&round=99")).status).toBe(404);
    expect((await ask("division=div-1&stage=other&round=1")).status).toBe(404);
  });

  it("a caller who may not read the division gets the auth refusal, never rows", async () => {
    const { HttpError } = await import("@/lib/errors");
    authSpies.requireResourceAuth.mockRejectedValueOnce(new HttpError(403, "Insufficient permissions"));
    fixturesSpies.listDivisionFixtures.mockClear();
    const res = await ask("division=div-1&stage=grp&round=1");
    expect(res.status).toBe(403);
    expect(fixturesSpies.listDivisionFixtures).not.toHaveBeenCalled();
  });
});
