// W3 app-B T9 (ST-G21) - the standings slide of a Swiss stage carries its tie-break columns: the first two Swiss-only keys of
// the STAGE's order (`slideTiebreakColumns`), with cells the public table's own (`cellText`, Swiss format) and headers the
// public table's own (`columnHeader`'s abbr, in the org's locale).
//
// Conventions (TEST-STRATEGY.md):
//  - the empty case first (a league slide is the slide it always was), and every negative has its positive pair;
//  - the expected columns are the engine's: `unpinnedRulesDoc` serves the stage rules the production loader serves, and the
//    keys the engine refuses outside a Swiss (`validateCascade`) say which are Swiss-only - no key list is typed;
//  - the cells are compared with the REAL public table (`buildTableView`, stageKind "swiss") over the same rows and rules,
//    and ALSO pinned to the engine's own formatter (`pointsText`) so a pair of builders agreeing on a wrong spelling is seen;
//  - every sweep reports how many items it checked.
//
// DB-free: `buildPublicDivisionSlides` is pure. The organiser twin (`buildDivisionSlides`) is driven against a real database
// in the last describe, which self-skips without one, like every DB-backed suite here.
import { describe, expect, it } from "vitest";
import { pointsText, validateCascade, type StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { SLIDE_TIEBREAK_MAX } from "@/lib/slide-tiebreak-columns";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { buildTableView, columnHeader } from "@/server/public-site/standings-view";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages } from "@/server/usecases/stages";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { buildDivisionSlides, buildPublicDivisionSlides, type Slide } from "../slideshow-data";

type StandingsSlide = Extract<Slide, { kind: "standings" }>;
const HAS_DB = !!process.env.DATABASE_URL;

const sport = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`premise: ${key} is a built-in sport`);
  return m;
};

/** The registry sweep: every built-in sport and every cfg it declares (`forEachSport` is the engine's own iteration; it counts the sports). */
const CASES: { m: AnySportModule; name: string; cfg: unknown }[] = [];
const SPORTS = forEachSport(({ module: m }) => {
  for (const { name, cfg } of declaredCfgs(m)) CASES.push({ m, name, cfg });
});
const FIRST_CASES = CASES.filter((c, i) => CASES.findIndex((x) => x.m.key === c.m.key) === i);

const IDS = ["e1", "e2", "e3", "e4"] as const;
const NAMES: Record<string, string> = { e1: "Ash", e2: "Birch", e3: "Cedar", e4: "Dogwood" };

/** Four Swiss rows whose ladders all DIFFER from row to row and from each other (so a cell read from the wrong key, or from
 *  the wrong row, cannot match by luck), with a half point in Buchholz (a whole-point table spells it "7.5", a half-point table
 *  "7½"), a negative Opp diff (the sign must survive), and every ledger the sport's metrics and ratios read. */
function swissRows(m: AnySportModule, points = (i: number) => 9 - 3 * i): StandingsRow[] {
  const ledger = Object.fromEntries(m.metrics.map((x, k) => [x.key, 10 - k]));
  return IDS.map((entrantId, i) => ({
    entrantId,
    played: 3,
    won: 3 - i,
    drawn: 0,
    lost: i,
    points: points(i),
    rank: i + 1,
    metrics: {
      ...ledger,
      points_won: 63 - 7 * i,
      points_lost: 42 + 3 * i,
      sets_won: 6 - i,
      sets_lost: 1 + i,
      buchholz: 7.5 - 1.5 * i,
      buchholz_cut1: 6 - i,
      opp_diff: 3 - 2 * i,
      sberger: 4.25 - i,
    },
  }));
}

const swissDoc = (m: AnySportModule, cfg: unknown) => unpinnedRulesDoc({ module: m, kind: "swiss", divisionConfig: cfg });
const leagueDoc = (m: AnySportModule, cfg: unknown) => unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: cfg });
type Doc = ReturnType<typeof swissDoc>;

/** The keys the engine refuses outside a Swiss, in `order`'s order: its own declaration of "Swiss-only". */
const engineSwissOnly = (m: AnySportModule, cfg: unknown, order: readonly string[]): string[] =>
  validateCascade(order as TiebreakerKey[], { module: m, cfg, stageKind: "league", crossGroup: false })
    .filter((r) => r.reason === "stage_format")
    .map((r) => String(r.key));

async function slideOf(
  m: AnySportModule,
  doc: Doc | { tiebreakers: readonly string[] },
  rows: readonly StandingsRow[],
  opts: { kind?: string; locale?: string; division?: { sport_key?: string; module_version?: string } } = {},
): Promise<StandingsSlide> {
  const slides = await buildPublicDivisionSlides({
    division: { id: "d1", name: "Open", sport_key: m.key, module_version: m.version, ...opts.division },
    stages: [{ id: "sw", kind: opts.kind ?? "swiss", name: "Swiss", table_rules: doc as never }],
    pools: [],
    fixtures: [],
    standings: [{ stage_id: "sw", pool_id: null, rows: rows as never }],
    entrants: IDS.map((id) => ({ id, display_name: NAMES[id]! })),
    ...(opts.locale === undefined ? {} : { orgLocale: opts.locale }),
  });
  const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
  if (slide === undefined) throw new Error("no standings slide built");
  return slide;
}

/** The REAL public table for the same stage, rows and rules, in `locale`. */
async function publicTable(m: AnySportModule, doc: Doc, rows: readonly StandingsRow[], locale = "en", metricSpecs: AnySportModule["metrics"] = m.metrics) {
  const dict = await getDictionary(toLocale(locale), "public");
  return buildTableView({
    id: "t",
    division: { id: "d1", slug: "open", name: "Open" },
    caption: "Swiss",
    fullHref: "/x",
    rows,
    metricSpecs,
    cascade: doc.tiebreakers,
    entrantNames: NAMES,
    entrantLogos: {},
    entrantColours: {},
    championIds: [],
    updatedAt: "2026-11-03T10:00:00Z",
    msg: (key, vars) => t(dict, key, vars),
    rules: doc,
    dateOf: () => null,
    stageKind: "swiss",
  });
}

/** The slide's tie-break cells for entrant `id` next to the public table's cells under the same columns. */
function compare(slide: StandingsSlide, view: Awaited<ReturnType<typeof publicTable>>) {
  const columns = slide.tiebreakColumns ?? [];
  const idx = columns.map((c) => view.columns.findIndex((x) => x.key === c.key));
  return {
    keys: columns.map((c) => c.key),
    headers: columns.map((c) => c.header),
    tableHeaders: idx.map((i) => view.columns[i]?.abbr),
    slideCells: slide.rows.map((r) => r.tiebreaks),
    tableCells: slide.rows.map((r) => idx.map((i) => view.rows.find((v) => v.name === r.name)?.cells[i])),
    found: idx.every((i) => i >= 0),
  };
}

describe("ST-G21 the standings slide - the empty case first: a league slide is the slide it always was", () => {
  it("a league stage of every sport and declared cfg carries no tie-break columns and no row carries a tie-break key (counted)", async () => {
    let checked = 0;
    for (const { m, name, cfg } of CASES) {
      const slide = await slideOf(m, leagueDoc(m, cfg), swissRows(m), { kind: "league" });
      expect(slide.tiebreakColumns, `${m.key} ${name}`).toBeUndefined();
      for (const r of slide.rows) expect(Object.keys(r), `${m.key} ${name}`).not.toContain("tiebreaks");
      expect(slide.rows, `${m.key} ${name}: a slide of ${IDS.length} rows`).toHaveLength(IDS.length);
      checked++;
    }
    expect(SPORTS, "sports in the registry").toBe(11);
    expect(checked, "(sport, cfg) league slides checked").toBeGreaterThan(SPORTS);
  });

  it("a hand-built input with no rules draws no tie-break column, and does not throw (the pair: the same rows with their rules do) - for every sport (counted)", async () => {
    let checked = 0;
    for (const { m, cfg } of FIRST_CASES) {
      const doc = swissDoc(m, cfg);
      expect((await slideOf(m, doc, swissRows(m))).tiebreakColumns?.length, `${m.key}: premise - with its rules the slide gets its two`).toBe(SLIDE_TIEBREAK_MAX);
      for (const rules of [null, undefined, { tiebreakers: [] }]) {
        const slide = await slideOf(m, rules as never, swissRows(m));
        expect(slide.tiebreakColumns, `${m.key} ${JSON.stringify(rules)}`).toBeUndefined();
        expect(slide.rows).toHaveLength(IDS.length);
      }
      checked++;
    }
    expect(checked, "sports checked").toBe(SPORTS);
  });

  it("a module this build cannot resolve keeps the ladders exactly as the public table shows them without one (review m1), and does not throw", async () => {
    let checked = 0;
    for (const { m, name, cfg } of FIRST_CASES) {
      const doc = swissDoc(m, cfg);
      const rows = swissRows(m);
      const resolved = await slideOf(m, doc, rows);
      expect(resolved.tiebreakColumns?.length, `${m.key}: premise - the resolved module gets its two`).toBe(SLIDE_TIEBREAK_MAX);
      for (const division of [{ sport_key: "no-such-sport", module_version: "9.9.9" }, { sport_key: undefined, module_version: undefined }]) {
        const slide = await slideOf(m, doc, rows, { division });
        // the public table for the same stage with no module: structural + derived columns only (`metricSpecs` empty)
        const c = compare(slide, await publicTable(m, doc, rows, "en", []));
        expect(c.keys, `${m.key} ${name} ${JSON.stringify(division)}`).toEqual(resolved.tiebreakColumns!.map((x) => x.key));
        expect(c.found, `${m.key}: the table shows them too`).toBe(true);
        expect(c.headers).toEqual(c.tableHeaders);
        expect(c.slideCells).toEqual(c.tableCells);
        expect(slide.rows).toHaveLength(IDS.length);
        checked++;
      }
    }
    expect(checked, "(sport, no-module case) pairs checked").toBe(SPORTS * 2);
  });
});

describe("ST-G21 a Swiss slide carries the tie-break columns, its cells the public table's own", () => {
  it("ST-G21 a badminton Swiss slide carries Buchholz Cut-1 and Buchholz cells equal to the public table's cells for the same rows", async () => {
    // single-sport: rulebook X-SW-9 names badminton's chain (Buchholz Cut-1, Buchholz); the registry sweep below derives every sport's from the engine
    const m = sport("badminton");
    const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
    const rows = swissRows(m);
    const slide = await slideOf(m, doc, rows);
    const view = await publicTable(m, doc, rows);
    const c = compare(slide, view);
    expect(c.found, "the public table has the slide's columns").toBe(true);
    expect(c.keys).toEqual(["buchholz_cut1", "buchholz"]);
    expect(c.headers, "the header is the public table's").toEqual(c.tableHeaders);
    expect(c.headers).toEqual(["Buchholz Cut-1", "Buchholz"]);
    // The cells are the table's, row by row ...
    expect(c.slideCells).toEqual(c.tableCells);
    // ... and are the Swiss spelling of the ladders (whole-point table: a plain number), taken from the engine's formatter.
    expect(slide.rows.map((r) => r.tiebreaks)).toEqual(rows.map((r) => [pointsText(r.metrics.buchholz_cut1!, "whole"), pointsText(r.metrics.buchholz!, "whole")]));
    expect(slide.rows.map((r) => r.tiebreaks![1]), "premise: a half point is spelled as the whole-point table spells Pts").toEqual(["7.5", "6", "4.5", "3"]);
    // The ratio column the cascade also holds stays beside them, untouched.
    expect(slide.rows.every((r) => typeof r.pointRatio === "string")).toBe(true);
  });

  it("a football Swiss slide carries Buchholz and Opp diff (a negative number keeps its sign), the table's cells in the table's spelling", async () => {
    // single-sport: rulebook X-SW-9 names the football family's chain (Buchholz, Opp diff); the registry sweep below derives every sport's from the engine
    const m = sport("football");
    const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
    const rows = swissRows(m);
    const slide = await slideOf(m, doc, rows);
    const c = compare(slide, await publicTable(m, doc, rows));
    expect(c.keys).toEqual(["buchholz", "opp_diff"]);
    expect(c.headers).toEqual(c.tableHeaders);
    expect(c.slideCells).toEqual(c.tableCells);
    expect(slide.rows.map((r) => r.tiebreaks![1]), "Opp diff is an integer in the whole spelling, sign kept").toEqual(["3", "1", "-1", "-3"]);
  });

  it("one stored ledger, two spellings: a half-point (chess) slide reads the 7.5 as 7½ and a whole-point (badminton) slide as 7.5 - the unit is the stage's own, taken by the slide from its layout", async () => {
    // single-sport: the pair needs both ends of the unit - chess is the only half-point sport, badminton one of the whole-point ones (every sport's unit spelling is swept in standings-view-swiss-display.test.ts)
    const chess = sport("boardgame");
    const doc = swissDoc(chess, chess.variants.classical);
    // chess stores Pts in HALVES (a win is 2): 3 -> "1½"
    const rows = swissRows(chess, (i) => 6 - 2 * i);
    const slide = await slideOf(chess, doc, rows);
    const c = compare(slide, await publicTable(chess, doc, rows));
    expect(c.keys).toEqual(["buchholz_cut1", "buchholz"]);
    expect(c.slideCells).toEqual(c.tableCells);
    expect(slide.rows.map((r) => r.tiebreaks![1])).toEqual(rows.map((r) => pointsText(r.metrics.buchholz! * 2, "half")));
    expect(slide.rows[0]!.tiebreaks![1], "premise: 7.5 whole points is fifteen halves").toBe("7½");
    // The pair, built through the same slide builder: a whole-point sport given the SAME stored ledger spells it as a decimal.
    // (An engine fact like `pointsText(7.5, "whole")` would not say the SLIDE does so; this does.)
    const bad = sport("badminton");
    const whole = await slideOf(bad, swissDoc(bad, declaredCfgs(bad)[0]!.cfg), swissRows(bad));
    expect(whole.rows[0]!.tiebreaks![1], "the same 7.5 on a whole-point slide").toBe("7.5");
    expect(whole.rows[0]!.tiebreaks![1]).not.toBe(slide.rows[0]!.tiebreaks![1]);
  });

  it("every sport and declared cfg: the slide's columns are the engine's first two Swiss-only keys of the stage order; headers and cells are the public table's (registry sweep, counted)", async () => {
    let stages = 0;
    let cells = 0;
    let headers = 0;
    const withRatio: string[] = [];
    for (const { m, name, cfg } of CASES) {
      const doc = swissDoc(m, cfg);
      const rows = swissRows(m);
      const slide = await slideOf(m, doc, rows);
      const want = engineSwissOnly(m, cfg, doc.tiebreakers).slice(0, SLIDE_TIEBREAK_MAX);
      const c = compare(slide, await publicTable(m, doc, rows));
      expect(c.keys, `${m.key} ${name}`).toEqual(want);
      expect(c.found, `${m.key} ${name}: the table shows those columns`).toBe(true);
      expect(c.headers, `${m.key} ${name}`).toEqual(c.tableHeaders);
      expect(c.slideCells, `${m.key} ${name}`).toEqual(c.tableCells);
      for (const r of slide.rows) expect(r.tiebreaks, `${m.key} ${name}: one cell per column`).toHaveLength(want.length);
      stages++;
      headers += c.headers.length;
      cells += c.slideCells.flat().length;
      if (slide.rows.every((r) => r.pointRatio !== undefined)) withRatio.push(m.key);
    }
    expect(SPORTS, "sports in the registry").toBe(11);
    expect(stages, "Swiss stages swept").toBe(CASES.length);
    expect(stages, "more stages than sports (every declared cfg)").toBeGreaterThan(SPORTS);
    expect(headers, "headers compared").toBe(stages * SLIDE_TIEBREAK_MAX);
    expect(cells, "cells compared").toBe(stages * SLIDE_TIEBREAK_MAX * IDS.length);
    expect(withRatio.length, "anti-vacuity: some Swiss slides hold the ratio column AND the two tie-breaks (the widest board)").toBeGreaterThan(0);
  });

  it("the headers are the org's locale: Opp diff over a Spanish board is the Spanish word, the Buchholz notation stays (derived from the public dictionary, differing from English)", async () => {
    // single-sport: Opp diff is the one tie-break word the dictionaries translate, and only the football-family Swiss chain holds it (rulebook X-SW-9)
    const m = sport("football");
    const doc = swissDoc(m, declaredCfgs(m)[0]!.cfg);
    const rows = swissRows(m);
    const enDict = await getDictionary("en", "public");
    for (const locale of ["es", "fr", "nl"] as const) {
      const dict = await getDictionary(locale, "public");
      const slide = await slideOf(m, doc, rows, { locale });
      const want = columnHeader({ key: "opp_diff", label: "Opp diff" }, (k) => t(dict, k)).abbr;
      expect(want, `${locale}: premise - the word is translated`).not.toBe(t(enDict, "table.abbr.oppDiff"));
      expect(slide.tiebreakColumns!.map((c) => c.header), locale).toEqual(["Buchholz", want]);
    }
  });
});

describe("ST-G21 a stage pinned to an older chain shows only what that chain holds (Review Focus 5)", () => {
  it("a stage pinned to a chain with no Swiss-only key shows none - on a Swiss stage, for every sport (counted), with the unpinned stage as the positive pair", async () => {
    let pinned = 0;
    let unpinned = 0;
    for (const { m, cfg } of FIRST_CASES) {
      const rows = swissRows(m);
      // A chain with no Swiss-only key: the engine's non-Swiss default for the sport (a stand-in for "older", which the next test pins
      // literally - this one holds for every sport, and the current engine cannot produce a true pre-W3 chain).
      const old = leagueDoc(m, cfg);
      expect(engineSwissOnly(m, cfg, old.tiebreakers), `${m.key}: premise - the pre-W3 chain names no Swiss-only key`).toEqual([]);
      const pin = { ...swissDoc(m, cfg), tiebreakers: old.tiebreakers };
      const slide = await slideOf(m, pin, rows);
      expect(slide.tiebreakColumns, `${m.key}: pinned`).toBeUndefined();
      pinned++;
      // the positive pair: the same rows under the stage's unpinned (Swiss default) rules carry two
      const live = await slideOf(m, swissDoc(m, cfg), rows);
      expect(live.tiebreakColumns?.length, `${m.key}: unpinned`).toBe(SLIDE_TIEBREAK_MAX);
      unpinned++;
    }
    expect(pinned, "sports checked pinned").toBe(SPORTS);
    expect(unpinned, "sports checked unpinned").toBe(SPORTS);
    expect(SPORTS).toBe(11);
  });

  // The chains a stage pinned BEFORE W3 carries, as engine 1.1.0 (what origin/main still runs) declared them: recorded fixtures, because
  // the engine this branch pins cannot produce them. Read from 1.1.0's own `module.defaultTiebreakers("swiss", cfg)` on 2026-11-03
  // (the first variant of each sport). badminton and football held no Swiss-only key; boardgame's Swiss default ALREADY held both ladders.
  const ENGINE_1_1_0_SWISS_DEFAULT = {
    badminton: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
    football: ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"],
    boardgame: ["points", "buchholz_cut1", "buchholz", "sberger", "direct", "wins", "lots"],
  } as const;

  it("ST-G21 a stage pinned to the pre-W3 chain shows exactly what that chain holds (Review Focus 5): badminton and football none, boardgame its two ladders - engine 1.1.0's recorded Swiss defaults", async () => {
    // single-sport: engine 1.1.0's pre-W3 chains were recorded for these three sports only (the fixtures above); the test before this one holds every sport to its non-Swiss default
    const want = { badminton: [], football: [], boardgame: ["buchholz_cut1", "buchholz"] } as const;
    let checked = 0;
    for (const key of ["badminton", "football", "boardgame"] as const) {
      const m = sport(key);
      const cfg = declaredCfgs(m)[0]!.cfg;
      const chain = ENGINE_1_1_0_SWISS_DEFAULT[key];
      const pinned = await slideOf(m, { ...swissDoc(m, cfg), tiebreakers: chain }, swissRows(m));
      expect((pinned.tiebreakColumns ?? []).map((c) => c.key), `${key} pinned to the 1.1.0 chain`).toEqual(want[key]);
      // the pair: the same rows under today's unpinned Swiss default carry two, so the empty answers above are the pin's
      const live = await slideOf(m, swissDoc(m, cfg), swissRows(m));
      expect(live.tiebreakColumns?.length, `${key} unpinned`).toBe(SLIDE_TIEBREAK_MAX);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a chain holding ONE Swiss-only key shows one column (the board has a template for each count), and the column is that key - for every sport (counted)", async () => {
    let checked = 0;
    for (const { m, cfg } of FIRST_CASES) {
      const doc = swissDoc(m, cfg);
      // the engine's own list says which keys are Swiss-only; keep the last of them and drop the rest
      const swissOnly = engineSwissOnly(m, cfg, doc.tiebreakers);
      const keep = swissOnly[swissOnly.length - 1]!;
      expect(swissOnly.length, `${m.key}: premise - the default Swiss chain holds more than one Swiss-only key`).toBeGreaterThan(1);
      const oneLadder = doc.tiebreakers.filter((k) => !swissOnly.includes(k) || k === keep);
      expect(engineSwissOnly(m, cfg, oneLadder), `${m.key}: premise - exactly one Swiss-only key left`).toEqual([keep]);
      const rows = swissRows(m);
      const pinned = { ...doc, tiebreakers: oneLadder };
      const slide = await slideOf(m, pinned, rows);
      const c = compare(slide, await publicTable(m, pinned, rows));
      expect(c.keys, m.key).toEqual([keep]);
      expect(c.found, `${m.key}: the table shows it too`).toBe(true);
      expect(c.slideCells, `${m.key}: one cell per row, the table's own`).toEqual(c.tableCells);
      expect(c.slideCells.every((cells) => cells?.length === 1), `${m.key}: one cell per row`).toBe(true);
      checked++;
    }
    expect(checked, "sports checked").toBe(SPORTS);
  });

  it("a row with no ledger at all prints the table's dash under each tie-break column, and does not throw - for every sport (counted)", async () => {
    let checked = 0;
    for (const { m, cfg } of FIRST_CASES) {
      const doc = swissDoc(m, cfg);
      const bare = swissRows(m).map((r, i) => (i === 0 ? { ...r, metrics: {} } : r));
      const slide = await slideOf(m, doc, bare);
      expect(slide.rows[0]!.tiebreaks, m.key).toEqual(["—", "—"]);
      expect(slide.rows[1]!.tiebreaks, `${m.key}: the neighbour with a ledger prints numbers, so the dash is the row's`).not.toContain("—");
      checked++;
    }
    expect(checked, "sports checked").toBe(SPORTS);
  });
});

// ---- the organiser twin, through its real producer ---------------------------------------------------------------------
describe.skipIf(!HAS_DB)("ST-G21 the organiser board's Swiss slide (buildDivisionSlides, DB)", () => {
  it("carries the same columns, headers and cells as the public builder over the same snapshot rows, from the stage's rules as the loader serves them", async () => {
    // single-sport: this drives the DB-backed organiser loader once, with one sport's stage; every sport's columns, headers and cells are swept DB-free above
    const m = sport("badminton");
    const variant = Object.keys(m.variants)[0]!;
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Swiss Cup", visibility: "public", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: m.key, variant_key: variant, config: {} as never });
    await createEntrants(auth, division.id, IDS.map((id, i) => ({ kind: "individual" as const, display_name: NAMES[id]!, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } });
    const stored = await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where division_id = ${division.id}`;
    const idOf = new Map(stored.map((e) => [e.display_name, e.id]));
    const rows = swissRows(m).map((r) => ({ ...r, entrantId: idOf.get(NAMES[r.entrantId]!)! }));
    await sql`insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq) values (${stage!.id}, null, ${sql.json(rows as never)}, 0)`;

    const slides = await buildDivisionSlides(auth, division.id, "Open");
    const slide = slides.find((s): s is StandingsSlide => s.kind === "standings");
    expect(slide, "a standings slide").toBeDefined();
    const cfg = m.configSchema.parse(m.variants[variant]);
    const doc = swissDoc(m, cfg);
    const want = engineSwissOnly(m, cfg, doc.tiebreakers).slice(0, SLIDE_TIEBREAK_MAX);
    expect(want.length, "premise").toBe(SLIDE_TIEBREAK_MAX);
    expect(slide!.tiebreakColumns!.map((c) => c.key)).toEqual(want);
    // the same rows through the public builder (the organiser's entrant ids differ, so compare by name)
    const publicSlide = await slideOf(m, doc, swissRows(m));
    expect(slide!.tiebreakColumns).toEqual(publicSlide.tiebreakColumns);
    expect(Object.fromEntries(slide!.rows.map((r) => [r.name, r.tiebreaks]))).toEqual(Object.fromEntries(publicSlide.rows.map((r) => [r.name, r.tiebreaks])));
    expect(slide!.rows.length).toBe(IDS.length);
  });

  it("review m6: the organiser board's tie-break headers are the board's label locale (English), never the org's - a Spanish org's header row is not half and half; the public board keeps the org's", async () => {
    // single-sport: Opp diff is the one tie-break word the dictionaries translate, and only the football-family Swiss chain holds it (rulebook X-SW-9)
    const m = sport("football");
    const variant = Object.keys(m.variants)[0]!;
    const { auth } = await seedOrg();
    await sql`update organizations set default_locale = 'es' where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Copa", visibility: "public", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: m.key, variant_key: variant, config: {} as never });
    await createEntrants(auth, division.id, IDS.map((id, i) => ({ kind: "team" as const, display_name: NAMES[id]!, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 } });
    const stored = await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where division_id = ${division.id}`;
    const idOf = new Map(stored.map((e) => [e.display_name, e.id]));
    const rows = swissRows(m).map((r) => ({ ...r, entrantId: idOf.get(NAMES[r.entrantId]!)! }));
    await sql`insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq) values (${stage!.id}, null, ${sql.json(rows as never)}, 0)`;

    const slide = (await buildDivisionSlides(auth, division.id, "Open")).find((s): s is StandingsSlide => s.kind === "standings");
    const en = await getDictionary("en", "public");
    const es = await getDictionary("es", "public");
    const enWord = columnHeader({ key: "opp_diff", label: "Opp diff" }, (k) => t(en, k)).abbr;
    const esWord = columnHeader({ key: "opp_diff", label: "Opp diff" }, (k) => t(es, k)).abbr;
    expect(esWord, "premise: the Spanish word differs from the English one").not.toBe(enWord);
    expect(slide!.tiebreakColumns!.map((c) => c.header), "the organiser board: the board's English").toEqual(["Buchholz", enWord]);
    // the pair: the public builder over the same stage speaks the org's locale
    const publicSlide = await slideOf(m, swissDoc(m, m.configSchema.parse(m.variants[variant])), swissRows(m), { locale: "es" });
    expect(publicSlide.tiebreakColumns!.map((c) => c.header)).toEqual(["Buchholz", esWord]);
  });
});
