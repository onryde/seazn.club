// The slideshow standings slide carries the "Pts ratio" column the normal
// standings table shows — and ONLY under the condition the normal table shows
// it: the stage's order (W2d Task 9: its table rules from the one loader, its
// pin, else the division's override, else the module's default) names
// `point_ratio` (`standingsColumns` / `DERIVED_METRICS`).
//
// The slide used to hardcode #, entrant, P, W, D, L, Pts, so a division whose
// cascade ranks on `point_ratio` (volleyball and carrom by default; badminton and
// table tennis too until W2d's signed defaults, spec §5.10) showed a table on the
// wall that left out the number the tie was decided on, while the same
// division's public page printed it.
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
import { ratioText, validateCascade, type StandingsRow } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { buildPublicDivisionSlides, buildDivisionSlides, type Slide, type StandingsSlideRow } from "../slideshow-data";
import { buildTableView, type TableViewInput } from "../public-site/standings-view";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages } from "@/server/usecases/stages";
import { defaultOrderOf } from "@seazn/engine/testkit";
import { chessRoundRobin, iihfLeague, levelLeague, type StoredTable } from "@/server/engine-db/__tests__/helpers/stored-table-rows";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { declaredCfgs } from "@seazn/engine/testkit";

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

/** `order` is the stage's table-rules order as the public loader hands it over (`PublicStage.table_rules`, W2d Task 9);
 *  absent: a hand-built input (or a stage the loader refused) that carries none. */
function publicInput(
  division: {
    sport_key?: string;
    module_version?: string;
  },
  order?: readonly string[],
) {
  return {
    division: { id: "d1", name: "Open", ...division },
    stages: [{ id: "sl", kind: "league", name: "League", ...(order === undefined ? {} : { table_rules: { tiebreakers: order } }) }],
    pools: [],
    fixtures: [],
    standings: [{ stage_id: "sl", pool_id: null, rows: snapshotRows }],
    entrants,
  };
}

async function standingsSlide(division: Parameters<typeof publicInput>[0], order?: readonly string[]): Promise<StandingsSlide> {
  const slides = await buildPublicDivisionSlides(publicInput(division, order));
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
    // W2d T17: no stage rules (a plain whole-point layout) and no date — these suites pin the rest of the view
    rules: null,
    dateOf: () => null,
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
  it("a division that names no module and a stage with no order gets no ratio column (the slide as it always was)", async () => {
    const slide = await standingsSlide({});
    expect(slideShowsRatio(slide)).toBe(false);
    // W2d follow-up m8: the result counts ride as `results` (paired with the slide's P · W · D · L columns); no row
    // carries a `pointRatio` key at all.
    for (const r of slide.rows) expect(Object.keys(r).sort()).toEqual(["name", "points", "rank", "results"]);
    expect(slide.columns.map((c) => c.key)).toEqual(["played", "won", "drawn", "lost"]);
  });

  it("an unknown (retired) module build degrades to no column — it never throws, like the division page", async () => {
    // The loader refuses (and omits) a stage whose module this build cannot resolve, so it arrives with no order.
    const slide = await standingsSlide({ sport_key: "no-such-sport", module_version: "9.9.9" });
    expect(slideShowsRatio(slide)).toBe(false);
  });

  // ---- the sweep: the real normal table decides ------------------------------
  it("for EVERY shipped module the slide shows the column exactly when the normal table does", async () => {
    const withRatio: string[] = [];
    const without: string[] = [];
    for (const m of builtinModules) {
      const slide = await standingsSlide({ sport_key: m.key, module_version: m.version }, defaultOrderOf(m));
      const table = normalTable(m, defaultOrderOf(m));
      expect({ sport: m.key, slide: slideShowsRatio(slide) }).toEqual({ sport: m.key, slide: tableHasRatio(table) });
      (tableHasRatio(table) ? withRatio : without).push(m.key);
    }
    // Both directions are exercised: a sweep that only ever saw one answer
    // would pass a builder that always said it.
    expect(withRatio.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
  });

  it("the STAGE's order decides, not the module default, in both directions", async () => {
    const ranksOnRatio = builtinModules.find((m) => defaultOrderOf(m).includes("point_ratio"));
    const doesNot = builtinModules.find((m) => !defaultOrderOf(m).includes("point_ratio"));
    if (!ranksOnRatio || !doesNot) throw new Error("the shipped modules no longer split on point_ratio");

    // Positive: a sport that never ranks on it, told to, gets the column.
    const added = ["points", "wins", "point_ratio"];
    const addedSlide = await standingsSlide({ sport_key: doesNot.key, module_version: doesNot.version }, added);
    expect(slideShowsRatio(addedSlide)).toBe(true);
    expect(tableHasRatio(normalTable(doesNot, added))).toBe(true);

    // Negative pair: a sport that ranks on it by default, told not to, loses it.
    const dropped = ["points", "wins"];
    const droppedSlide = await standingsSlide({ sport_key: ranksOnRatio.key, module_version: ranksOnRatio.version }, dropped);
    expect(slideShowsRatio(droppedSlide)).toBe(false);
    expect(tableHasRatio(normalTable(ranksOnRatio, dropped))).toBe(false);
  });

  // ---- the value -------------------------------------------------------------
  it("each row's ratio is the engine's text for its OWN points pair, the normal table's cell, to two decimals", async () => {
    const m = builtinModules.find((x) => defaultOrderOf(x).includes("point_ratio"));
    if (!m) throw new Error("no shipped module ranks on point_ratio");
    const slide = await standingsSlide({ sport_key: m.key, module_version: m.version }, defaultOrderOf(m));

    // Hand-computed, differing from every neighbouring pair's ratio.
    expect(slide.rows.map((r) => r.pointRatio)).toEqual(LEDGER.map((l) => l.want));

    // And the normal table prints the very same text in its point_ratio cell.
    const table = normalTable(m, defaultOrderOf(m));
    const col = table.columns.findIndex((c) => c.key === "point_ratio");
    expect(col).toBeGreaterThan(-1);
    const cellOf = (id: string) => table.rows.find((r) => r.entrantId === id)!.cells[col];
    expect(slide.rows.map((r) => r.pointRatio)).toEqual(LEDGER.map((l) => cellOf(l.id)));
  });

  it("the structural cells are untouched by the new column (rank, name, P/W/D/L/Pts)", async () => {
    const m = builtinModules.find((x) => defaultOrderOf(x).includes("point_ratio"))!;
    const withCol = await standingsSlide({ sport_key: m.key, module_version: m.version }, defaultOrderOf(m));
    const without = await standingsSlide({});
    const structural = (rows: StandingsSlideRow[]) => rows.map((r) => [r.rank, r.name, ...r.results, r.points]);
    expect(structural(withCol.rows)).toEqual(structural(without.rows));
    expect(structural(withCol.rows)).toHaveLength(LEDGER.length);
  });

  it("a snapshot row with NO metrics object at all prints the table's dash under the ratio and does not throw", async () => {
    const m = builtinModules.find((x) => defaultOrderOf(x).includes("point_ratio"))!;
    // A row as a hand-built input or a pre-ledger snapshot carries it: no `metrics` key.
    const bare = { entrantId: "e1", played: 0, won: 0, drawn: 0, lost: 0, points: 0, rank: 1 };
    const withLedger = { ...bare, entrantId: "e2", rank: 2, metrics: { points_won: 63, points_lost: 42 } };
    const input = publicInput({ sport_key: m.key, module_version: m.version }, defaultOrderOf(m));
    const slides = await buildPublicDivisionSlides({
      ...input,
      standings: [{ stage_id: "sl", pool_id: null, rows: [bare, withLedger] }],
    });
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings")!;
    // The dash is the engine's own for "no ledger yet"; the neighbour with a
    // ledger prints its number, so the bare row's dash is the row's, not the slide's.
    expect(slide.rows.map((r) => r.pointRatio)).toEqual([ratioText(0, 0, 2), ratioText(63, 42, 2)]);
    expect(slide.rows[0]!.pointRatio).toBe("—");
    expect(slide.rows[1]!.pointRatio).not.toBe("—");
  });
});

// ---- W2d T17 fix 1 (I3): the slide prints what the public table prints --------
// RB2B-17: chess points are shown 1 / ½ / 0 "on every surface"; anti-goal 3: on a table with no counted fixture "no row
// is shown or marked as first". Rows and rules from the engine's producers (`stored-table-rows`); the expected text is
// FIDE's arithmetic, never the builder's.
describe("W2d T17 fix 1: the standings slide prints the public table's points and places (RB2B-17, X-TB-6)", () => {
  const IDS = ["c1", "c2", "c3", "c4"] as const;
  const NAMES = { c1: "Anand", c2: "Bela", c3: "Clara", c4: "Dmitri" } as Record<string, string>;
  async function slideOf(table: StoredTable, rules: unknown = table.doc): Promise<StandingsSlide> {
    const slides = await buildPublicDivisionSlides({
      division: { id: "d1", name: "Open" },
      stages: [{ id: "sl", kind: "league", name: "League", table_rules: rules as never }],
      pools: [],
      fixtures: [],
      standings: [{ stage_id: "sl", pool_id: null, rows: table.rows }],
      entrants: table.rows.map((r) => ({ id: r.entrantId, display_name: NAMES[r.entrantId] ?? r.entrantId })),
    });
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    if (!slide) throw new Error("no standings slide built");
    return slide;
  }

  it("chess: the stored half-points print 1½ / 1 / ½ / 0 (FIDE: A beat B, drew C, lost to D), places as ranked", async () => {
    const chess = chessRoundRobin(IDS);
    expect(chess.rows.find((r) => r.entrantId === "c1")!.points, "premise: the snapshot stores half-points").toBe(3);
    const slide = await slideOf(chess);
    expect(slide.rows.map((r) => [r.rank, r.name, r.points])).toEqual([["1", "Anand", "1½"], ["2", "Dmitri", "1"], ["3", "Clara", "½"], ["4", "Bela", "0"]]);
    expect(slide.level).toBe(false);
    // The pair: the same rows with no rules (a hand-built input) print the stored number — the unit is the rules'.
    expect((await slideOf(chess, { tiebreakers: chess.doc.tiebreakers })).rows.map((r) => r.points)).toEqual(["3", "2", "1", "0"]);
  });

  it("a level table: every rank '–' and the slide says level (no first row); one counted result brings places back", async () => {
    const level = levelLeague(["e1", "e2", "e3"]);
    expect(level.rows.every((r) => r.level === true), "premise: the engine marks the empty table level").toBe(true);
    const slide = await slideOf(level);
    expect(slide.rows.map((r) => r.rank)).toEqual(["–", "–", "–"]);
    expect(slide.level).toBe(true);
    const played = await slideOf(chessRoundRobin(IDS));
    expect(played.rows.map((r) => r.rank)).toEqual(["1", "2", "3", "4"]);
    expect(played.level).toBe(false);
  });
});

// ---- W2d follow-up (final review m8): the slide's result columns are the public table's --------------------------------
// RBG §3.4 (lines 343-344): "OT and GWS decisions both land in OTW/OTL" — IIHF's W and L are regulation only. The slide
// used to print P · W · D · L for every table, so a hockey board folded its overtime wins into W. Rows come from the
// engine's producers (`stored-table-rows`), the expected counts from the rulebook. Export review I2 (2026-10-28): a stage
// that can never draw prints no D, as the public table never does — RBG §3.4 line 343 is "GP · W · OTW · OTL · L", no D.
describe("W2d follow-up m8: the standings slide prints IIHF's W · OTW · OTL · L, and every other table as before", () => {
  const IDS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
  const NAMES: Record<string, string> = { h1: "Ash", h2: "Birch", h3: "Cedar", h4: "Dogwood", h5: "Elm", h6: "Fir" };
  async function slideOf(table: StoredTable, rules: unknown = table.doc, division: Parameters<typeof publicInput>[0] = {}): Promise<StandingsSlide> {
    const slides = await buildPublicDivisionSlides({
      division: { id: "d1", name: "Open", ...division },
      stages: [{ id: "sl", kind: "league", name: "League", table_rules: rules as never }],
      pools: [],
      fixtures: [],
      standings: [{ stage_id: "sl", pool_id: null, rows: table.rows }],
      entrants: table.rows.map((r) => ({ id: r.entrantId, display_name: NAMES[r.entrantId] ?? r.entrantId })),
    });
    const slide = slides.find((x): x is StandingsSlide => x.kind === "standings");
    if (!slide) throw new Error("no standings slide built");
    return slide;
  }
  const byName = (slide: StandingsSlide) =>
    Object.fromEntries(slide.rows.map((r) => [r.name, Object.fromEntries(slide.columns.map((c, i) => [c.key, r.results[i]]))]));

  it("IIHF: OT and shoot-out wins and losses in OTW/OTL, W and L regulation only (RBG §3.4); a phone keeps P and Pts", async () => {
    const slide = await slideOf(iihfLeague(IDS));
    expect(slide.columns.map((c) => c.key), "RBG §3.4: GP · W · OTW · OTL · L, no D").toEqual(["played", "won", "otw", "otl", "lost"]);
    // RBG §3.4: Ash won in regulation, overtime and the shoot-out, and lost in overtime and the shoot-out — 3+2+2+1+1 = 9.
    const cells = byName(slide);
    expect(cells["Ash"]).toEqual({ played: "5", won: "1", otw: "2", otl: "2", lost: "0" });
    expect(cells["Dogwood"], "a shoot-out loss and a regulation loss").toEqual({ played: "2", won: "0", otw: "0", otl: "1", lost: "1" });
    expect(cells["Cedar"], "a regulation win and an overtime loss").toEqual({ played: "2", won: "1", otw: "0", otl: "1", lost: "0" });
    expect(slide.rows.find((r) => r.name === "Ash")!.points).toBe("9");
    // The public table's phone set for a split table (P, then Pts): every other count folds below the board's cut-off.
    expect(slide.columns.filter((c) => c.compact).map((c) => c.key)).toEqual(["played"]);
    // The pair: the same rows with no rules to read (a stage the loader refused) print W and L as folded, never a split.
    const plain = await slideOf(iihfLeague(IDS), { tiebreakers: iihfLeague(IDS).doc.tiebreakers });
    expect(plain.columns.map((c) => c.key)).toEqual(["played", "won", "drawn", "lost"]);
    expect(byName(plain)["Ash"], "the folded W counts all three wins").toEqual({ played: "5", won: "3", drawn: "0", lost: "2" });
  });

  it("every shipped sport and declared cfg: the slide's columns are P · W · D · L — D only where the stage can draw — nothing folds, and each cell is the stored count; except IIHF's split", async () => {
    let plain = 0;
    let split = 0;
    let withD = 0;
    let withoutD = 0;
    for (const m of builtinModules) {
      for (const { name, cfg } of declaredCfgs(m)) {
        const doc = unpinnedRulesDoc({ module: m, divisionConfig: m.key === "generic" ? GENERIC_CONFIG : cfg });
        const slide = await slideOf({ doc, rows: snapshotRows.map(engineRow) }, doc, { sport_key: m.key, module_version: m.version });
        const label = `${m.key} ${name}`;
        if (m.key === "icehockey" && name !== "recreational") {
          expect(slide.columns.map((c) => c.key), label).toEqual(["played", "won", "otw", "otl", "lost"]);
          split++;
          continue;
        }
        // The stage's own declaration of what it can reach (`reachableOutcomes`, carried by its rules doc): D where a draw is
        // one of them. The ledger holds no draw, so the column is the stage's, never the rows'.
        const canDraw = doc.reachable.includes("draw");
        const keys = canDraw ? ["played", "won", "drawn", "lost"] : ["played", "won", "lost"];
        expect(slide.columns, label).toEqual(keys.map((key) => ({ key, compact: true })));
        expect(slide.rows.map((r) => r.results), label).toEqual(snapshotRows.map((r) => (canDraw ? [r.played, r.won, r.drawn, r.lost] : [r.played, r.won, r.lost]).map(String)));
        if (m.key === "badminton") expect(canDraw, `${label}: a set match always has a winner`).toBe(false);
        if (m.key === "football") expect(canDraw, `${label}: a football league match can end level`).toBe(true);
        plain++;
        if (canDraw) withD++;
        else withoutD++;
      }
    }
    expect(split, "anti-vacuity: IIHF cfgs").toBeGreaterThan(0);
    expect(plain, "anti-vacuity: every other sport's cfgs").toBeGreaterThan(builtinModules.length - 1);
    expect(withD, "anti-vacuity: cfgs whose stage can draw").toBeGreaterThan(0);
    expect(withoutD, "anti-vacuity: cfgs whose stage cannot").toBeGreaterThan(0);
  });
});

// ---- the organiser twin, through its real producer ---------------------------

describe.skipIf(!HAS_DB)("slideshow standings slide — the Pts ratio column (organiser board, DB)", () => {
  async function seededDivision(
    sportKey: string,
    variantKey: string,
    config: unknown,
    /** The division's own cascade override, set by direct SQL (it is what the
     *  organiser select must READ; the settings write path is not under test). */
    tiebreakers: string[] | null = null,
    /** W2d T17: the snapshot's rows by entrant name, as the engine stored them (default: `snapshotRows`). */
    rowsOf?: (idOf: ReadonlyMap<string, string>) => unknown[],
  ) {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Ratio Cup", visibility: "public", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: sportKey,
      variant_key: variantKey,
      config: config as never,
    });
    if (tiebreakers !== null) {
      await sql`update divisions set tiebreakers = ${sql.json(tiebreakers as never)} where id = ${division.id}`;
    }
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
    const rows = rowsOf?.(idOf) ?? snapshotRows.map((r, i) => ({ ...r, entrantId: idOf.get(LEDGER[i]!.name)! }));
    await sql`
      insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
      values (${stage!.id}, null, ${sql.json(rows as never)}, 0)`;
    return { auth, division, stage: stage! };
  }

  // The sport is the first shipped module whose DEFAULT order ranks on point_ratio, read off the engine (badminton by
  // name until W2d's §5.10 order, BWF 16.2, which ranks on the point DIFFERENCE instead), under its first variant.
  const ratioSport = () => {
    const m = builtinModules.find((x) => defaultOrderOf(x).includes("point_ratio"));
    if (!m) throw new Error("no shipped module ranks on point_ratio by default (the pair below proves nothing)");
    const variant = Object.keys(m.variants)[0];
    if (variant === undefined) throw new Error(`${m.key} declares no variant`);
    return { m, variant };
  };

  it("a division whose sport ranks on point_ratio by default carries the ratio, computed from its snapshot's points ledger", async () => {
    const { m, variant } = ratioSport();
    const { auth, division } = await seededDivision(m.key, variant, {});
    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    expect(slide!.rows.map((r) => r.pointRatio)).toEqual(LEDGER.map((l) => l.want));
  });

  it("W2d T17 fix 1: a chess division's board prints the stored half-points as 1½ (RB2B-17), through the loader's rules", async () => {
    const names = LEDGER.map((l) => l.name);
    const { auth, division } = await seededDivision("boardgame", "classical", {}, null, (idOf) => {
      const [a, b, c, d] = names.map((n) => idOf.get(n)!);
      return chessRoundRobin([a!, b!, c!, d!]).rows;
    });
    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    // Mexico beat Canada, drew Japan, lost to Ghana: FIDE 1 + ½ + 0 = 1½.
    expect(slide!.rows.map((r) => [r.name, r.points])).toEqual([["Mexico", "1½"], ["Ghana", "1"], ["Japan", "½"], ["Canada", "0"]]);
    expect(slide!.level).toBe(false);
  });

  it("a division whose cascade has no point_ratio (generic) renders the slide as it always was", async () => {
    const { auth, division } = await seededDivision("generic", "score", GENERIC_CONFIG);
    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    expect(slideShowsRatio(slide!)).toBe(false);
  });

  // The division's own cascade reaches a PENDING stage's order through the one
  // loader (`stageTableRulesDocs`, W2d Task 9: an unpinned stage reads its live
  // layers). Both directions, on the same snapshot rows, so a builder that
  // stopped reading the stage's rules (falling back to the module default, or to
  // no order) fails one of the pair.
  // The sport is the first shipped module whose DEFAULT order never ranks on point_ratio yet which records what the ratio
  // reads (points_won, points_lost), read off the engine: `validateCascade`, which W2d T10 asks of the order a new stage
  // inherits (`refuseNewStageTable`). generic records neither, so its own order naming point_ratio is refused at the stage
  // create. point_ratio goes in AHEAD of the terminal drawing of lots, under the sport's first variant.
  const addedRatioSport = () => {
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0];
      const order = defaultOrderOf(m);
      if (variant === undefined || order.includes("point_ratio") || order.at(-1) !== "lots") continue;
      const added = [...order.slice(0, -1), "point_ratio", "lots"] as TiebreakerKey[];
      const cfg = m.configSchema.parse(m.variants[variant]);
      if (validateCascade(added, { module: m, cfg, stageKind: "league", crossGroup: false }).length === 0) return { m, variant, added };
    }
    throw new Error("no shipped module records point_ratio's inputs without ranking on it (the case below proves nothing)");
  };

  it("a division whose OWN cascade adds point_ratio to a sport that never ranks on it gets the column, with its values", async () => {
    const { m, variant, added } = addedRatioSport();
    expect(defaultOrderOf(m), `${m.key}'s default cascade`).not.toContain("point_ratio");
    expect(added, "the own order adds point_ratio").toContain("point_ratio");
    // Why not generic (the case before W2d T10): it records no points ledger, so the engine refuses point_ratio there.
    const generic = builtinModules.find((x) => x.key === "generic")!;
    const genericAdded = [...defaultOrderOf(generic).slice(0, -1), "point_ratio", "lots"] as TiebreakerKey[];
    const genericCfg = generic.configSchema.parse(GENERIC_CONFIG);
    expect(validateCascade(genericAdded, { module: generic, cfg: genericCfg, stageKind: "league", crossGroup: false }).map((r) => r.key), "generic refuses it").toEqual(["point_ratio"]);
    const { auth, division } = await seededDivision(m.key, variant, {}, added);
    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    expect(slide!.rows.map((r) => r.pointRatio)).toEqual(LEDGER.map((l) => l.want));
  });

  it("a division whose OWN cascade drops point_ratio from a sport that ranks on it loses the column (same rows as the ratio-sport case above)", async () => {
    const { m, variant } = ratioSport();
    expect(defaultOrderOf(m), `${m.key}'s default cascade`).toContain("point_ratio");
    const dropped = defaultOrderOf(m).filter((k) => k !== "point_ratio");
    const { auth, division } = await seededDivision(m.key, variant, {}, dropped);
    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    expect(slide!.rows).toHaveLength(LEDGER.length);
    expect(slideShowsRatio(slide!)).toBe(false);
  });
});
