// The slideshow standings slide carries the "Pts ratio" column the normal
// standings table shows — and ONLY under the condition the normal table shows
// it: the division's cascade (its own override, else the pinned module's
// default) names `point_ratio` (`standingsColumns` / `DERIVED_METRICS`).
//
// The slide used to hardcode #, entrant, P, W, D, L, Pts, so a badminton, table
// tennis, volleyball or carrom division — whose cascades all rank on
// `point_ratio` — showed a table on the wall that left out the number the tie
// was decided on, while the same division's public page printed it.
//
// Conventions (RULES.md, test-case design):
//  - the "which sports get the column" question is answered by the REAL normal
//    table (`buildTableView(...).columns`), swept over every shipped module
//    (`builtinModules`) — never a table of sport names typed here;
//  - the cell VALUE is compared with that same table's cell for the same row,
//    and pinned to hand-computed strings whose ledger pairs all differ, so a
//    builder that divided the sets pair or the boards pair, or swapped won and
//    lost, prints a different number;
//  - the empty case (no cascade, no module) is stated first, and every negative
//    ("no column") has its positive pair in the same file.
//
// DB-free: `buildPublicDivisionSlides` is pure. The organiser twin
// (`buildDivisionSlides`) is driven against a real database in the second half,
// which self-skips without one, like every DB-backed suite here.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { StandingsRow } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import { buildPublicDivisionSlides, buildDivisionSlides, type Slide, type StandingsSlideRow } from "../slideshow-data";
import { buildTableView, type TableViewInput } from "../public-site/standings-view";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages } from "@/server/usecases/stages";

type StandingsSlide = Extract<Slide, { kind: "standings" }>;

const HAS_DB = !!process.env.DATABASE_URL;

/** Every ledger pair DIFFERS (points 63/42, sets 3/1, boards 9/2), so a ratio
 *  that read the wrong pair, or swapped won and lost, cannot match by luck. The
 *  last two rows are the ratio column's own edge cases. */
const LEDGER: { id: string; name: string; metrics: Record<string, number>; want: string }[] = [
  { id: "e1", name: "Mexico", metrics: { points_won: 63, points_lost: 42, sets_won: 3, sets_lost: 1, boards_won: 9, boards_lost: 2 }, want: "1.50" },
  // 21 / 16 = 1.3125: two decimals, rounded, not truncated to "1.3".
  { id: "e2", name: "Canada", metrics: { points_won: 21, points_lost: 16, sets_won: 1, sets_lost: 3, boards_won: 2, boards_lost: 9 }, want: "1.31" },
  // Never lost a point: the engine prints the infinity sign, not "Infinity".
  { id: "e3", name: "Japan", metrics: { points_won: 30, points_lost: 0, sets_won: 2, sets_lost: 0 }, want: "∞" },
  // No ledger yet: the engine's dash.
  { id: "e4", name: "Ghana", metrics: {}, want: "—" },
];

const snapshotRows = LEDGER.map((l, i) => ({
  entrantId: l.id,
  played: 3,
  won: 3 - i,
  drawn: 0,
  lost: i,
  points: 9 - 3 * i,
  rank: i + 1,
  metrics: l.metrics,
}));

const entrants = LEDGER.map((l) => ({ id: l.id, display_name: l.name }));

function publicInput(division: {
  sport_key?: string;
  module_version?: string;
  tiebreakers?: string[] | null;
}) {
  return {
    division: { id: "d1", name: "Open", ...division },
    stages: [{ id: "sl", kind: "league", name: "League" }],
    pools: [],
    fixtures: [],
    standings: [{ stage_id: "sl", pool_id: null, rows: snapshotRows }],
    entrants,
  };
}

async function standingsSlide(division: Parameters<typeof publicInput>[0]): Promise<StandingsSlide> {
  const slides = await buildPublicDivisionSlides(publicInput(division));
  const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
  if (!slide) throw new Error("no standings slide built");
  return slide;
}

/** The slide's verdict on the column: every row carries it, or none does. A
 *  half-set slide is a defect of its own, so it throws rather than answering. */
function slideShowsRatio(slide: StandingsSlide): boolean {
  const has = slide.rows.map((r: StandingsSlideRow) => r.pointRatio !== undefined);
  if (has.some(Boolean) && !has.every(Boolean)) throw new Error(`half-set pointRatio: ${has.join(",")}`);
  return has.every(Boolean);
}

// ---- the normal table, as the reference --------------------------------------

const msg: TableViewInput["msg"] = (key) => `${key}`;
const engineRow = (r: (typeof snapshotRows)[number]): StandingsRow => ({ ...r });

/** The normal standings table for the same rows, cascade and module metrics. */
function normalTable(module_: { metrics: TableViewInput["metricSpecs"] }, cascade: readonly string[]) {
  return buildTableView({
    id: "t",
    division: { id: "d1", slug: "open", name: "Open" },
    caption: "League",
    fullHref: "/",
    rows: snapshotRows.map(engineRow),
    metricSpecs: module_.metrics,
    cascade,
    entrantNames: Object.fromEntries(LEDGER.map((l) => [l.id, l.name])),
    entrantLogos: {},
    entrantColours: {},
    championId: null,
    updatedAt: "2026-09-26T00:00:00Z",
    msg,
  });
}
const tableHasRatio = (view: ReturnType<typeof normalTable>) => view.columns.some((c) => c.key === "point_ratio");

describe("slideshow standings slide — the Pts ratio column (public /present)", () => {
  // ---- the empty case first --------------------------------------------------
  it("a division that names no module and no cascade gets no ratio column (the slide as it always was)", async () => {
    const slide = await standingsSlide({});
    expect(slideShowsRatio(slide)).toBe(false);
    for (const r of slide.rows) expect(Object.keys(r).sort()).toEqual(["drawn", "lost", "name", "played", "points", "rank", "won"]);
  });

  it("an unknown (retired) module build degrades to no column — it never throws, like the division page", async () => {
    const slide = await standingsSlide({ sport_key: "no-such-sport", module_version: "9.9.9", tiebreakers: null });
    expect(slideShowsRatio(slide)).toBe(false);
  });

  // ---- the sweep: the real normal table decides ------------------------------
  it("for EVERY shipped module the slide shows the column exactly when the normal table does", async () => {
    const withRatio: string[] = [];
    const without: string[] = [];
    for (const m of builtinModules) {
      const slide = await standingsSlide({ sport_key: m.key, module_version: m.version, tiebreakers: null });
      const table = normalTable(m, m.defaultTiebreakers);
      expect({ sport: m.key, slide: slideShowsRatio(slide) }).toEqual({ sport: m.key, slide: tableHasRatio(table) });
      (tableHasRatio(table) ? withRatio : without).push(m.key);
    }
    // Both directions are exercised: a sweep that only ever saw one answer
    // would pass a builder that always said it.
    expect(withRatio.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
  });

  it("a division's OWN cascade override wins over the module default, in both directions", async () => {
    const ranksOnRatio = builtinModules.find((m) => m.defaultTiebreakers.includes("point_ratio"));
    const doesNot = builtinModules.find((m) => !m.defaultTiebreakers.includes("point_ratio"));
    if (!ranksOnRatio || !doesNot) throw new Error("the shipped modules no longer split on point_ratio");

    // Positive: a sport that never ranks on it, told to, gets the column.
    const added = ["points", "wins", "point_ratio"];
    const addedSlide = await standingsSlide({ sport_key: doesNot.key, module_version: doesNot.version, tiebreakers: added });
    expect(slideShowsRatio(addedSlide)).toBe(true);
    expect(tableHasRatio(normalTable(doesNot, added))).toBe(true);

    // Negative pair: a sport that ranks on it by default, told not to, loses it.
    const dropped = ["points", "wins"];
    const droppedSlide = await standingsSlide({ sport_key: ranksOnRatio.key, module_version: ranksOnRatio.version, tiebreakers: dropped });
    expect(slideShowsRatio(droppedSlide)).toBe(false);
    expect(tableHasRatio(normalTable(ranksOnRatio, dropped))).toBe(false);
  });

  // ---- the value -------------------------------------------------------------
  it("each row's ratio is the engine's text for its OWN points pair, the normal table's cell, to two decimals", async () => {
    const m = builtinModules.find((x) => x.defaultTiebreakers.includes("point_ratio"));
    if (!m) throw new Error("no shipped module ranks on point_ratio");
    const slide = await standingsSlide({ sport_key: m.key, module_version: m.version, tiebreakers: null });

    // Hand-computed, differing from every neighbouring pair's ratio.
    expect(slide.rows.map((r) => r.pointRatio)).toEqual(LEDGER.map((l) => l.want));

    // And the normal table prints the very same text in its point_ratio cell.
    const table = normalTable(m, m.defaultTiebreakers);
    const col = table.columns.findIndex((c) => c.key === "point_ratio");
    expect(col).toBeGreaterThan(-1);
    const cellOf = (id: string) => table.rows.find((r) => r.entrantId === id)!.cells[col];
    expect(slide.rows.map((r) => r.pointRatio)).toEqual(LEDGER.map((l) => cellOf(l.id)));
  });

  it("the structural cells are untouched by the new column (rank, name, P/W/D/L/Pts)", async () => {
    const m = builtinModules.find((x) => x.defaultTiebreakers.includes("point_ratio"))!;
    const withCol = await standingsSlide({ sport_key: m.key, module_version: m.version, tiebreakers: null });
    const without = await standingsSlide({});
    const structural = (rows: StandingsSlideRow[]) =>
      rows.map((r) => [r.rank, r.name, r.played, r.won, r.drawn, r.lost, r.points]);
    expect(structural(withCol.rows)).toEqual(structural(without.rows));
    expect(structural(withCol.rows)).toHaveLength(LEDGER.length);
  });
});

// ---- the organiser twin, through its real producer ---------------------------

describe.skipIf(!HAS_DB)("slideshow standings slide — the Pts ratio column (organiser board, DB)", () => {
  async function seededDivision(sportKey: string, variantKey: string, config: unknown) {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Ratio Cup", visibility: "public", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: sportKey,
      variant_key: variantKey,
      config: config as never,
    });
    await createEntrants(
      auth,
      division.id,
      LEDGER.map((l, i) => ({ kind: "individual" as const, display_name: l.name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
    // Seed the snapshot the board reads, so the ledger is the test's own and
    // needs no scored match: `getStandings` returns a stored snapshot as is
    // (`org_id` is filled by trigger, like the hub suite's own seed).
    const stored = await sql<{ id: string; display_name: string }[]>`
      select id, display_name from entrants where division_id = ${division.id}`;
    const idOf = new Map(stored.map((e) => [e.display_name, e.id]));
    const rows = snapshotRows.map((r, i) => ({ ...r, entrantId: idOf.get(LEDGER[i]!.name)! }));
    await sql`
      insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
      values (${stage!.id}, null, ${sql.json(rows as never)}, 0)`;
    return { auth, division, stage: stage! };
  }

  it("a badminton division's board carries the ratio, computed from its snapshot's points ledger", async () => {
    const { auth, division } = await seededDivision("badminton", "bwf", {});
    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    expect(slide!.rows.map((r) => r.pointRatio)).toEqual(LEDGER.map((l) => l.want));
  });

  it("a division whose cascade has no point_ratio (generic) renders the slide as it always was", async () => {
    const { auth, division } = await seededDivision("generic", "score", GENERIC_CONFIG);
    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    expect(slideShowsRatio(slide!)).toBe(false);
  });
});
