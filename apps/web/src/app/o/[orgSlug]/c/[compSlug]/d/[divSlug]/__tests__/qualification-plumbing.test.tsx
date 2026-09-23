// Standings qualification status on the ORGANISER CONSOLE (R1a, spec
// 2026-09-22 §4.2, plan Task 9) — the console page's own half: it reads each
// table stage's V414 meta through `listStageQualificationMeta` and hands every
// table the view `divisionQualification` builds, exactly as the public
// division page does. The usecase itself (and its parity with
// `public_stages_v`) is pinned against Postgres in
// server/usecases/__tests__/stage-qualification-db.test.ts; this file pins the
// wiring, which is the inert-seam risk (AGENTS.md #1): a page that never
// passes `qualification` renders a perfectly good table with nothing on it.
//
// Same harness as the five sibling tests (no jsdom; the async server component
// is called directly and its element tree walked), with two differences: the
// division resolves the REAL generic module, because the builder needs its
// config schema and points bounds; and the dictionaries are the real ones, so
// the words the table gets are asserted, not keys.
//
// The scenes are the public page's plumbing test's (swiss4, and the hub's
// two-pool stage), so the console is held to the same statuses and lines the
// public page draws for the same division.
//
// Mutants killed (task-9 report): the usecase not called, or called with
// other ids than the table stages the tenant read returned (→ the cut test's
// call assertion and the view); the page passing `qualification={null}` (→
// the cut and pool tests); the table's pool dropped (→ the pool test: a
// per-group cut on no pool is no view); the ORG's or English words used
// instead of the viewer's locale (→ the French case); the entrant names not
// handed to the builder (→ the cut test's what-if lines, which name the rival).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const scene = vi.hoisted(() => ({
  stages: [] as unknown[],
  fixtures: [] as unknown[],
  entrants: [] as unknown[],
  pools: {} as Record<string, unknown[]>,
  snaps: {} as Record<string, unknown>,
  locale: "en",
}));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(async () => scene.stages),
  getStandings: vi.fn(async (_auth: unknown, stageId: string, poolId?: string) => scene.snaps[`${stageId}:${poolId ?? ""}`] ?? { rows: [] }),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(),
}));
const qual = vi.hoisted(() => ({ listStageQualificationMeta: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);
vi.mock("@/server/usecases/stage-qualification", () => qual);

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => scene.locale) }));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Open",
    status: "active",
    sport_key: "generic",
    variant_key: "score",
    module_version: "1.0.0",
    // The live cfg the forecast's per-match bounds come from.
    config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 } },
    tiebreakers: null,
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
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: false, visibility: "private", slug: "comp-one" })),
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
  resolveModule: vi.fn(() => builtinModules.find((m) => m.key === "generic")),
}));
vi.mock("@/server/usecases/discipline", () => ({
  getDisciplineRules: vi.fn(async () => null),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
}));
// The page's own tenant reads: only the pools query answers.
const tx = (strings: unknown, ...values: unknown[]) =>
  Promise.resolve(
    Array.isArray(strings) && strings.join("?").includes("from pools") ? (scene.pools[values[0] as string] ?? []) : [],
  );
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));

import DivisionPage from "../page";
import { StandingsTable } from "@/components/public-site/standings-table";
import type { QualificationView } from "@/server/public-site/qualification-view";
import type { StageQualMetaRow } from "@/server/usecases/stage-qualification";

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

const NAMES: Record<string, string> = {
  A: "Ada Swiss", B: "Bo Swiss", C: "Cy Swiss", D: "Di Swiss",
  e1: "Red Rovers", e2: "Blue Jays", e3: "Green Giants", e4: "Gold Geese", e5: "Silver Swans", e6: "Bronze Bears",
};
const entrant = (id: string, seed: number) => ({ id, display_name: NAMES[id], status: "confirmed", seed });

let fixtureNo = 0;
const fx = (id: string, stageId: string, poolId: string | null, round: number, home: string | null, away: string | null, winner?: string) => ({
  id,
  stage_id: stageId,
  pool_id: poolId,
  round_no: round,
  seq_in_round: 1,
  fixture_no: ++fixtureNo,
  home_entrant_id: home,
  away_entrant_id: away,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  status: winner ? "decided" : "scheduled",
  outcome: winner ? { kind: "win", winner, loser: winner === home ? away : home } : null,
});

/** A generic 3-1-0 row whose for/against/diff agree. */
const row = (entrantId: string, rank: number, won: number, played: number, goals: [number, number] = [won, played - won]) => ({
  entrantId,
  rank,
  played,
  won,
  drawn: 0,
  lost: played - won,
  points: 3 * won,
  metrics: { for: goals[0], against: goals[1], diff: goals[0] - goals[1] },
});

/** V414's six columns, as the usecase returns them. */
const meta = (m: Partial<StageQualMetaRow>): StageQualMetaRow => ({
  qualify_count: null,
  qualify_per_group: false,
  next_stage_name: null,
  swiss_rounds: null,
  points_rule: null,
  has_rank_overrides: false,
  ...m,
});

const FINALS = (take: unknown) => ({
  id: "fin",
  name: "Finals",
  kind: "knockout",
  seq: 2,
  status: "pending",
  config: {},
  progression: { sources: [{ stage: "previous", take: [take] }], placement: "rank_order", timing: "on_complete" },
});

/** swiss4: a Swiss of four, three rounds, two played (A 2W, B 1W, C 1W, D 0),
 *  into a knockout "Finals". Whether it has a cut is the META's call. */
function swissScene() {
  scene.stages = [
    { id: "sw", name: "Swiss", kind: "swiss", seq: 1, status: "active", config: { rounds: 3 }, progression: null },
    FINALS({ kind: "rankRange", from: 1, to: 2 }),
  ];
  scene.fixtures = [
    fx("f1", "sw", null, 1, "A", "D", "A"),
    fx("f2", "sw", null, 1, "B", "C", "B"),
    fx("f3", "sw", null, 2, "A", "B", "A"),
    fx("f4", "sw", null, 2, "C", "D", "C"),
    // Round 3's boards are unseated shells until it is paired.
    fx("f5", "sw", null, 3, null, null),
    fx("f6", "sw", null, 3, null, null),
  ];
  scene.entrants = ["A", "B", "C", "D"].map((id, i) => entrant(id, i + 1));
  scene.pools = {};
  scene.snaps = {
    "sw:": {
      stage_id: "sw",
      pool_id: null,
      rows: [row("A", 1, 2, 2, [4, 0]), row("B", 2, 1, 2, [2, 2]), row("C", 3, 1, 2, [1, 2]), row("D", 4, 0, 2, [0, 3])],
    },
  };
}

/** Two pools of three under one group stage with a per-group cut of one.
 *  Pool A: e1 beat e2; e1–e3, e2–e3 to play (two rounds left). Pool B: e4
 *  beat e5 and e6; e5–e6 to play (one left). */
function twoPoolScene() {
  scene.stages = [
    { id: "gr", name: "Groups", kind: "group", seq: 1, status: "active", config: { pools: { count: 2 } }, progression: null },
    FINALS({ kind: "topNPerGroup", n: 1 }),
  ];
  scene.fixtures = [
    fx("a1", "gr", "pA", 1, "e1", "e2", "e1"),
    fx("a2", "gr", "pA", 2, "e1", "e3"),
    fx("a3", "gr", "pA", 3, "e2", "e3"),
    fx("b1", "gr", "pB", 1, "e4", "e5", "e4"),
    fx("b2", "gr", "pB", 2, "e4", "e6", "e4"),
    fx("b3", "gr", "pB", 3, "e5", "e6"),
  ];
  scene.entrants = ["e1", "e2", "e3", "e4", "e5", "e6"].map((id, i) => entrant(id, i + 1));
  scene.pools = {
    gr: [
      { id: "pA", key: "A", name: "Pool A" },
      { id: "pB", key: "B", name: "Pool B" },
    ],
  };
  scene.snaps = {
    "gr:pA": { stage_id: "gr", pool_id: "pA", rows: [row("e1", 1, 1, 1), row("e2", 2, 0, 1), row("e3", 3, 0, 0)] },
    "gr:pB": { stage_id: "gr", pool_id: "pB", rows: [row("e4", 1, 2, 2), row("e5", 2, 0, 1), row("e6", 3, 0, 1)] },
  };
}

/** Every element anywhere in a server component's returned tree. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

async function renderTables(tab = "standings") {
  const root = await DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });
  return elements(root)
    .filter((el) => el.type === StandingsTable)
    .map((table) => {
      const props = table.props as { qualification?: QualificationView | null; rows: { entrantId: string }[]; caption?: string };
      return {
        qualification: props.qualification,
        rowIds: props.rows.map((r) => r.entrantId),
        caption: props.caption,
        html: renderToStaticMarkup(table),
      };
    });
}

const statuses = (q: QualificationView) => Object.fromEntries(Object.entries(q.rows).map(([id, r]) => [id, r.status]));

describe("organiser console — the standings tables get the same qualification view as the public page", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    qual.listStageQualificationMeta.mockReset();
    scene.locale = "en";
  });

  it("a stage with a cut: the page reads the meta for its table stages and hands the table the builder's view", async () => {
    swissScene();
    qual.listStageQualificationMeta.mockResolvedValue(
      new Map([["sw", meta({ qualify_count: 2, next_stage_name: "Finals", swiss_rounds: 3 })]]),
    );
    const tables = await renderTables();
    expect(tables, "one StandingsTable for the one Swiss stage").toHaveLength(1);
    const { qualification, html } = tables[0]!;

    // Asked once, with the auth, for exactly the TABLE stages the tenant-scoped
    // stage read returned — never the knockout, never an id from elsewhere.
    expect(qual.listStageQualificationMeta).toHaveBeenCalledTimes(1);
    expect(qual.listStageQualificationMeta).toHaveBeenCalledWith(PAGE.auth, ["sw"]);

    expect(qualification, "the page passed no qualification to a table with a cut").toBeTruthy();
    expect(qualification!.table.cutIndex).toBe(2);
    expect(qualification!.table.label).toBe("Top 2 go through to Finals · 1 round left");
    // The engine's statuses for this scene — the same as the public page's.
    expect(statuses(qualification!)).toEqual({ A: "win_k", B: "needs_help", C: "needs_help", D: "needs_help" });
    // The popover's what-if names the RIVAL by the page's entrant names — an
    // entrant id here means the page handed the builder no names.
    expect(qualification!.rows.A!.whatIf).toBe(
      "If you finish level on points with Cy Swiss, you stay ahead on difference even after a heavy defeat.",
    );
    expect(qualification!.rows.C!.whatIf).toBe(
      "If you finish level on points with Bo Swiss, difference decides. Now: you -1, Bo Swiss 0.",
    );
    // …and the table draws it.
    expect(html).toContain('data-testid="qual-cut"');
    expect(html).toContain('data-testid="qual-legend"');
    expect(/<button[^>]*data-testid="standings-rank-A"[^>]*>/.exec(html)?.[0] ?? "").toContain(
      'aria-label="Rank 1, Win and in, show details"',
    );
  });

  it("negative pair: the same division with no cut passes no view, and the table draws none of it", async () => {
    swissScene();
    // V414 with no cut gives no destination either (all or nothing).
    qual.listStageQualificationMeta.mockResolvedValue(new Map([["sw", meta({ swiss_rounds: 3 })]]));
    const [table] = await renderTables();
    expect(table!.qualification ?? null).toBeNull();
    for (const probe of ['data-testid="qual-cut"', 'data-testid="qual-legend"', 'data-qual-marker="', 'aria-label="Rank ']) {
      expect(table!.html, probe).not.toContain(probe);
    }
    // The table is still there, names and all.
    expect(table!.html).toContain(">Ada Swiss<");
  });

  it("no meta for the stage at all (nothing came back for it) → no view", async () => {
    swissScene();
    qual.listStageQualificationMeta.mockResolvedValue(new Map());
    const [table] = await renderTables();
    expect(table!.qualification ?? null).toBeNull();
    expect(table!.html).not.toContain('data-testid="qual-cut"');
  });

  it("two pools with a per-group cut: each pool's table gets ITS OWN pool's view, line and statuses", async () => {
    twoPoolScene();
    qual.listStageQualificationMeta.mockResolvedValue(
      new Map([["gr", meta({ qualify_count: 1, qualify_per_group: true, next_stage_name: "Finals" })]]),
    );
    const tables = await renderTables();
    expect(tables.map((x) => x.caption)).toEqual(["Groups — Pool A", "Groups — Pool B"]);
    for (const { qualification, rowIds, caption } of tables) {
      expect(qualification, `${caption}: no view for a pool with a per-group cut`).toBeTruthy();
      // The view covers exactly the entrants this table draws.
      expect(Object.keys(qualification!.rows).sort(), caption).toEqual([...rowIds].sort());
    }
    const [a, b] = tables as [(typeof tables)[0], (typeof tables)[0]];
    expect(a.qualification!.table.label).toBe("First place goes through to Finals · 2 rounds left");
    expect(b.qualification!.table.label).toBe("First place goes through to Finals · 1 round left");
    expect(statuses(b.qualification!)).toEqual({ e4: "through", e5: "out", e6: "out" });
    expect(a.html).toContain("First place goes through to Finals · 2 rounds left");
    expect(b.html).toContain("First place goes through to Finals · 1 round left");
  });

  it("pools read Pool A above Pool B whatever their ids and the query's order (lib/pool-order.ts)", async () => {
    // The two-pool scene with ids that sort OPPOSITE to the names ("f…" is
    // Pool A's), handed back by the tenant read in B, A order: a console that
    // sorts by id, or keeps query order, draws Pool B first.
    twoPoolScene();
    const POOL_A = "ffffffff-0000-4000-8000-00000000000a";
    const POOL_B = "00000000-0000-4000-8000-00000000000b";
    const id = (p: unknown) => (p === "pA" ? POOL_A : p === "pB" ? POOL_B : p);
    scene.fixtures = scene.fixtures.map((f) => ({ ...(f as object), pool_id: id((f as { pool_id: unknown }).pool_id) }));
    scene.pools = {
      gr: [
        { id: POOL_B, key: "B", name: "Pool B" },
        { id: POOL_A, key: "A", name: "Pool A" },
      ],
    };
    scene.snaps = Object.fromEntries(
      Object.values(scene.snaps).map((v) => {
        const pool = id((v as { pool_id: string }).pool_id) as string;
        return [`gr:${pool}`, { ...(v as object), pool_id: pool }];
      }),
    );
    expect([POOL_A, POOL_B].sort(), "premise: the ids sort B first").toEqual([POOL_B, POOL_A]);
    qual.listStageQualificationMeta.mockResolvedValue(
      new Map([["gr", meta({ qualify_count: 1, qualify_per_group: true, next_stage_name: "Finals" })]]),
    );
    const tables = await renderTables();
    expect(tables.map((x) => x.caption)).toEqual(["Groups — Pool A", "Groups — Pool B"]);
    // Each caption over its OWN pool's rows — the tables moved, not the labels.
    expect(tables.map((x) => x.rowIds)).toEqual([["e1", "e2", "e3"], ["e4", "e5", "e6"]]);
  });

  it("the console speaks the VIEWER's locale: a French viewer gets the French cut line", async () => {
    swissScene();
    scene.locale = "fr";
    qual.listStageQualificationMeta.mockResolvedValue(
      new Map([["sw", meta({ qualify_count: 2, next_stage_name: "Finals", swiss_rounds: 3 })]]),
    );
    const [table] = await renderTables();
    expect(table!.qualification!.table.label).toBe("Les 2 premiers passent en Finals · 1 tour restant");
    expect(table!.qualification!.rows.A!.status).toBe("win_k");
  });

  it("off the standings tab the meta is never read", async () => {
    swissScene();
    qual.listStageQualificationMeta.mockResolvedValue(new Map());
    await renderTables("entrants");
    expect(qual.listStageQualificationMeta).not.toHaveBeenCalled();
  });
});
