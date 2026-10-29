// Standings export parity (2026-10-29): the organiser's standings document prints what the public standings table prints.
//
// Five gaps stood between the PDF and the table a visitor reads, each green behind a suite that never compared them:
//   1. the cascade's DERIVED columns (cricket NRR, the set / point / game / board ratios, a set or point difference,
//      hockey's field goals, chess Buchholz and Sonneborn–Berger) were dropped (`kind === "metric"` only);
//   2. a team with no counted result printed 0 where the public table prints "—";
//   3. a metric cell never went through `formatMetric`, so a declared number of decimals could diverge;
//   4. nothing read the export's columns against the public table's — this file;
//   5. (layout, doc-render-standings-grid.test.ts).
//
// Pure: no database. The seam is `standingsTableSections` (usecases/exports-standings.ts), the function
// `buildDivisionDocModel`'s "standings" case calls; the oracle is the PUBLIC path — the hub's view (`buildTableView`: the
// public `standingsColumns` / `formatMetric` / `derivedMetricText` / `columnHeader`) and the division page's own render
// (`StandingsTable`, to markup) — never the export's code. Rows are the engine's own producer's (`completeTableStage` over
// deltas the sport's own ledger keys name), and every stage's rules the loader's own pure mapping (`unpinnedRulesDoc`).
// The expected derived values in the hand-worked cases are the rulebook's arithmetic (NRR: ICC / ECB 16.9.4(a)), typed
// here, not read back from the engine.
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsDelta } from "@seazn/engine/core";
import {
  DERIVED_METRICS,
  RATIO_LEDGERS,
  completeTableStage,
  foldResults,
  rankStandings,
  type FixtureResult,
  type StandingsRow,
  type TableFixture,
} from "@seazn/engine/competition";
import { buildStandings } from "@seazn/engine/exports";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport, tableRulesOf } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { formatPublicInstant } from "@/lib/public-date-locale";
import { formatMetric, type MetricSpecLike } from "@/lib/public-site";
import { StandingsTable } from "@/components/public-site/standings-table";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";
import { tableOrderOf } from "@/server/engine-db/table-rules";
import { buildTableView, columnHeader, tableColumns, tableLayoutFor, type TableViewInput } from "@/server/public-site/standings-view";
import { docModelToXlsx } from "../../doc-render";
import { exportCell, standingsTableSections } from "../exports-standings";
import { readPublicTable, type PublicTableRead } from "./_public-table-markup";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Locale = (typeof LOCALES)[number];
const DICTS = { en, es, fr, nl } as unknown as Record<Locale, Dict>;
/** Spec §5.7, verbatim: a level row's rank prints an en dash (U+2013). Typed from the spec, not imported. */
const SPEC_LEVEL_RANK = "–";
/** The public table's word for a value nobody recorded. Typed from the public table's own cells, not imported. */
const DASH = "—";
const PRINTED_AT = "2026-10-29T09:00:00.000Z";
const TABLE_KINDS: readonly TableStageKind[] = ["league", "group", "swiss", "americano"];
const NAMES: Record<string, string> = { A: "Ash", B: "Birch", C: "Cedar", D: "Dogwood" };
const msgOf = (locale: Locale) => (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t(DICTS[locale], key, vars);

// ── The fixture state ─────────────────────────────────────────────────────────────────────────────────────────────────
// Four entrants. Ash beats Birch and Cedar; Dogwood has played nobody (`zeroRow`: no metric key at all). Ash's ledger holds
// every key at a positive count except the "lost" halves, which are a RECORDED 0 (a ratio of ∞, a displayed 0 that must
// stay 0); Cedar's holds every key positive; Birch's holds only the sport's first metric (a partial ledger: every derived
// value the rest would feed is "—"). With `draw`, Birch and Cedar also draw (a D column).

/** Every ledger key a table reads: the sport's own metrics, the ratio pairs, NRR's operands, and field goals' ledger. */
const LEDGER_EXTRAS = ["runs_for", "runs_against", "balls_faced_eff", "balls_bowled_eff", "gf", "goals_pc", "goals_stroke"];
/** The display fold `payout` writes on a match's real winner and loser: a decision beyond regulation, which a table that
 *  counts them apart (IIHF's OTW / OTL) takes out of W and L. One each, so W and L differ from the row's own won / lost. */
const DECISION_KEYS = ["won_ot", "won_so", "lost_ot", "lost_so"];
const ledgerKeysOf = (m: AnySportModule): string[] => [
  ...new Set([...m.metrics.map((x) => x.key), ...Object.values(RATIO_LEDGERS).flat(), ...LEDGER_EXTRAS]),
];
const LOST_HALVES: ReadonlySet<string> = new Set(Object.values(RATIO_LEDGERS).map(([, lost]) => lost));

function delta(entrantId: string, kind: "win" | "draw" | "loss", metrics: Record<string, number>): StandingsDelta {
  return {
    entrantId,
    played: 1,
    won: kind === "win" ? 1 : 0,
    drawn: kind === "draw" ? 1 : 0,
    lost: kind === "loss" ? 1 : 0,
    points: kind === "win" ? 2 : kind === "draw" ? 1 : 0,
    metrics,
  };
}

function fixtures(m: AnySportModule, draw: boolean): TableFixture[] {
  const keys = ledgerKeysOf(m);
  // distinct counts per key, so a cell in the wrong column cannot match by luck
  const full = (lostHalvesZero: boolean) => ({
    ...Object.fromEntries(keys.map((k, i) => [k, lostHalvesZero && LOST_HALVES.has(k) ? 0 : 7 + 3 * i])),
    ...Object.fromEntries(DECISION_KEYS.map((k) => [k, 1])),
  });
  const partial = () => ({ [m.metrics[0]!.key]: 5 });
  const win = (id: string, home: string, away: string, loser: Record<string, number>): TableFixture => ({
    id,
    status: "decided",
    result: [delta(home, "win", full(true)), delta(away, "loss", loser)] as FixtureResult,
  });
  return [
    win("f1", "A", "B", partial()),
    win("f2", "A", "C", Object.fromEntries(keys.map((k, i) => [k, 2 + i]))),
    ...(draw
      ? [{ id: "f3", status: "decided", result: [delta("B", "draw", partial()), delta("C", "draw", Object.fromEntries(keys.map((k, i) => [k, 3 + i])))] as FixtureResult } satisfies TableFixture]
      : []),
  ];
}

type RulesDoc = ReturnType<typeof unpinnedRulesDoc>;

/** The ranked stored rows of one state under `doc`'s rules. `level`: nobody has played. */
function rowsOf(doc: RulesDoc, m: AnySportModule, state: "draw" | "nodraw" | "level" | "empty", kind: TableStageKind): StandingsRow[] {
  if (state === "empty") return [];
  const entrants = ["A", "B", "C", "D"];
  const rules = tableRulesOf(doc.tiebreakers, doc.points);
  if (state === "level") return rankStandings(foldResults(entrants, []), { cascade: rules.tiebreakers, results: [], countedFixtures: 0 }).rows;
  const stage = { id: "s", kind: kind === "americano" ? "league" : kind, entrants, rules, ...(kind === "swiss" ? { swiss: true } : {}) };
  const done = completeTableStage(stage as Parameters<typeof completeTableStage>[0], fixtures(m, state === "draw"));
  const rows = done.tables.overall;
  if (rows === undefined) throw new Error(`premise: ${m.key} ${kind}: the engine ranked a table`);
  // a stored snapshot's order is the database's, not the table's: hand both documents the rows reversed, so each one's own
  // sort by place is what puts them in order
  return [...rows].reverse();
}

// ── The public oracle ─────────────────────────────────────────────────────────────────────────────────────────────────
const enDate = (iso: string) => formatPublicInstant("en", "UTC", iso, { dateStyle: "medium" });
const viewInput = (doc: RulesDoc, m: AnySportModule, rows: StandingsRow[], locale: Locale): TableViewInput => ({
  id: "t",
  division: { id: "d1", slug: "div", name: "Div" },
  caption: "League",
  fullHref: "/x",
  rows,
  metricSpecs: m.metrics,
  cascade: tableOrderOf(doc),
  entrantNames: NAMES,
  entrantLogos: {},
  entrantColours: {},
  championId: null,
  updatedAt: "2026-10-29T10:00:00Z",
  msg: msgOf(locale),
  rules: doc,
  dateOf: enDate,
});

/** The division page's table, rendered, read as a visitor reads it (`_public-table-markup.ts`). */
function rendered(doc: RulesDoc, m: AnySportModule, rows: StandingsRow[], locale: Locale): PublicTableRead {
  return readPublicTable(
    renderToStaticMarkup(
      createElement(StandingsTable, { rows, metricSpecs: m.metrics as never, cascade: tableOrderOf(doc), entrantNames: NAMES, dict: DICTS[locale], rules: doc, locale: "en", tz: "UTC" }),
    ),
  );
}

const exported = (doc: RulesDoc, m: AnySportModule, rows: StandingsRow[], locale: Locale, extra: { metricSpecs?: readonly MetricSpecLike[] } = {}) => {
  const sections = standingsTableSections({
    title: "Open — Standings",
    common: { printedAt: PRINTED_AT },
    rows,
    metricSpecs: extra.metricSpecs ?? m.metrics,
    cascade: tableOrderOf(doc),
    layout: tableLayoutFor(doc),
    nameOf: (id) => NAMES[id] ?? id,
    msg: (k) => t(DICTS[locale], k),
  });
  expect(sections, "premise: one table").toHaveLength(1);
  return sections[0]!.table!;
};

// ── Which derived keys each sport declares ────────────────────────────────────────────────────────────────────────────
const DERIVED_KEYS: ReadonlySet<string> = new Set(DERIVED_METRICS.map((d) => d.key));
const derivedOf = (keys: readonly TiebreakerKey[]) => keys.filter((k) => DERIVED_KEYS.has(k));

/** Every order a sport declares for a table stage of `kind`: its default under each declared cfg, each preset's order, and
 *  one order holding every derived key the sport declares in any of them (so a sport whose derived keys sit in different
 *  orders is still swept with all its derived columns in one table). */
function ordersOf(m: AnySportModule, kind: TableStageKind): { id: string; cfg: unknown; divisionTiebreakers: readonly TiebreakerKey[] | null }[] {
  const out: { id: string; cfg: unknown; divisionTiebreakers: readonly TiebreakerKey[] | null }[] = [];
  const cfgs = declaredCfgs(m);
  for (const { name, cfg } of cfgs) out.push({ id: `default/${name}`, cfg, divisionTiebreakers: null });
  const presets = m.tablePresets?.(kind).tiebreakers ?? [];
  for (const p of presets) out.push({ id: `preset/${p.id}`, cfg: cfgs[0]!.cfg, divisionTiebreakers: p.keys });
  const declared = new Set<TiebreakerKey>();
  for (const k of TABLE_KINDS) {
    for (const { cfg } of cfgs) derivedOf(m.defaultTiebreakers(k, cfg as never)).forEach((x) => declared.add(x));
    for (const p of m.tablePresets?.(k).tiebreakers ?? []) derivedOf(p.keys).forEach((x) => declared.add(x));
  }
  const base = m.defaultTiebreakers(kind, cfgs[0]!.cfg as never);
  out.push({ id: "every-derived-key", cfg: cfgs[0]!.cfg, divisionTiebreakers: [...base, ...[...declared].filter((x) => !base.includes(x))] });
  return out;
}

const STATES = ["draw", "nodraw", "level", "empty"] as const;

describe("standings export parity — the exported table is the public table (registry sweep, counted)", () => {
  it("every sport × table stage kind × order × state × locale: the export's header list and each row's cell text equal the public table's", () => {
    const seen = { sports: 0, scenes: 0, headers: 0, rows: 0, cells: 0, derivedColumns: 0, derivedCells: 0, dashCells: 0, wholeNumberCells: 0, renderedHeaders: 0, renderedCells: 0, apartTables: 0, halfTables: 0, halfPointCells: 0, halfPointTextCells: 0, d: 0, noD: 0 };
    const derivedKeysSeen = new Set<string>();
    seen.sports = forEachSport((c) => {
      const m = c.module;
      for (const kind of TABLE_KINDS) {
        for (const order of ordersOf(m, kind)) {
          const doc = unpinnedRulesDoc({ module: m, kind, divisionConfig: order.cfg, divisionTiebreakers: order.divisionTiebreakers });
          for (const state of STATES) {
            const rows = rowsOf(doc, m, state, kind);
            for (const locale of LOCALES) {
              const view = buildTableView(viewInput(doc, m, rows, locale));
              const table = exported(doc, m, rows, locale);
              const where = `${m.key} ${kind} ${order.id} ${state} ${locale}`;
              // the header list: # · Team · the public columns, after the public dictionary
              expect(table.columns, `${where}: header list`).toEqual(["#", msgOf(locale)("table.team"), ...view.columns.map((x) => x.abbr)]);
              // and every row: the public # (the level dash on a level table), the name, the public cells — in the public order
              const want = view.rows.map((r) => [r.rank === null ? SPEC_LEVEL_RANK : String(r.rank), r.name, ...r.cells]);
              expect(table.rows.map((r) => r.map(String)), `${where}: rows`).toEqual(want);
              const layout = tableLayoutFor(doc);
              if (layout.apart.length > 0) seen.apartTables++;
              if (layout.unit === "half") {
                seen.halfTables++;
                const ptsAt = table.columns.indexOf(msgOf(locale)("table.abbr.points"));
                seen.halfPointCells += table.rows.filter((r) => /½/.test(String(r[ptsAt]))).length;
              }
              seen.headers += table.columns.length;
              seen.rows += want.length;
              seen.cells += want.flat().length;
              view.columns.forEach((col, i) => {
                if (col.key === "drawn") seen.d++;
                if (DERIVED_KEYS.has(col.key)) {
                  seen.derivedColumns++;
                  derivedKeysSeen.add(col.key);
                  for (const r of table.rows) {
                    // a derived cell is the public text, as text (it is not a count)
                    expect(typeof r[2 + i], `${where}: ${col.key} cells are text`).toBe("string");
                    seen.derivedCells++;
                  }
                }
              });
              if (!view.columns.some((col) => col.key === "drawn")) seen.noD++;
              for (const r of table.rows) {
                r.forEach((cell, ci) => {
                  if (cell === DASH) seen.dashCells++;
                  if (ci === 1) return; // the name
                  // a derived cell is text (checked above); every other cell that prints a whole count is a NUMBER cell, so a
                  // spreadsheet's columns stay numeric, and a text cell is never a whole count
                  if (ci >= 2 && DERIVED_KEYS.has(view.columns[ci - 2]!.key)) return;
                  // a half-point table's Pts column ("1", "½", "1½") is text throughout: one type to a column
                  if (ci >= 2 && view.columns[ci - 2]!.key === "points" && layout.unit === "half") {
                    expect(typeof cell, `${where}: half-point Pts are text`).toBe("string");
                    seen.halfPointTextCells++;
                    return;
                  }
                  if (typeof cell === "string") expect(cell, `${where}: a whole count is a number cell`).not.toMatch(/^-?\d+$/);
                  else seen.wholeNumberCells++;
                });
              }
              // the division page's own render (en only: its markup is locale-neutral in structure; the hub view above is swept in all four)
              if (locale === "en") {
                const page = rendered(doc, m, rows, locale);
                expect(page.header, `${where}: the division page's header`).toEqual(table.columns.slice(2));
                expect(page.rows, `${where}: the division page's rows`).toEqual(table.rows.map((r) => r.slice(1).map(String)));
                seen.renderedHeaders += page.header.length;
                seen.renderedCells += page.rows.flat().length;
              }
              // a second call prints the same document (pure)
              expect(exported(doc, m, rows, locale), `${where}: second call`).toEqual(table);
              seen.scenes++;
            }
          }
        }
      }
    });
    // Anti-vacuity: zero checked is a failure. Each count is a floor the registry must clear (measured 2026-10-29: 3648
    // scenes, 102144 cells, 4416 derived columns, 14848 dash cells), set a quarter under so a sport's departure is a red,
    // not a silent shrink.
    expect(seen.sports, "every built-in sport was swept").toBe(builtinModules.length);
    expect(seen.scenes, "scenes compared").toBeGreaterThan(2700);
    expect(seen.cells, "cells compared").toBeGreaterThan(76000);
    expect(seen.renderedCells, "cells read back off the division page's markup").toBeGreaterThan(19000);
    expect(seen.derivedColumns, "derived columns compared").toBeGreaterThan(3300);
    expect(seen.derivedCells, "derived cells compared").toBeGreaterThan(9900);
    expect(seen.dashCells, "'—' cells compared (a team with nothing counted)").toBeGreaterThan(11000);
    expect(seen.wholeNumberCells, "number cells compared").toBeGreaterThan(49000);
    expect(seen.apartTables, "tables that split OTW / OTL apart (IIHF)").toBeGreaterThan(0);
    expect(seen.halfTables, "tables that print half-points (FIDE)").toBeGreaterThan(0);
    expect(seen.halfPointCells, "Pts cells that print a half ('½', '1½'): text, not a number").toBeGreaterThan(0);
    expect(seen.halfPointTextCells, "half-point Pts cells, whole or not, all text").toBeGreaterThan(0);
    expect(seen.d, "tables with a D column").toBeGreaterThan(600);
    expect(seen.noD, "tables without one").toBeGreaterThan(2000);
    // Every derived column the engine declares was swept at least once: a key no sport's order earns would be unswept.
    expect([...derivedKeysSeen].sort(), "every derived key").toEqual([...DERIVED_KEYS].sort());
    console.log("exports-standings-parity checked:", JSON.stringify({ ...seen, derivedKeys: derivedKeysSeen.size }));
  });
});

// Hand-worked cells. The values are the rulebooks' arithmetic, typed here: the ratio is won ÷ lost and ∞ when unbeaten
// (the public cell), NRR is runs per over scored less runs per over conceded (ECB The Hundred 16.9.4(a); ICC 16.9).
describe("standings export parity — hand-worked cells", () => {
  const rowOf = (entrantId: string, rank: number, over: Partial<StandingsRow> & { metrics: Record<string, number> }): StandingsRow => ({
    entrantId, played: 2, won: 1, drawn: 0, lost: 1, points: 2, rank, ...over,
  });
  const sport = (key: string): AnySportModule => {
    const m = builtinModules.find((x) => x.key === key);
    if (m === undefined) throw new Error(`premise: ${key} is a built-in sport`);
    return m;
  };
  const cricket = () => {
    const m = sport("cricket");
    return { m, doc: unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: m.variants.t20 }) };
  };

  it("cricket: NRR follows Pts, '+1.000' for 120 off 20 overs against 100 off 20 (6 × 120/120 − 6 × 100/120), and a team with nothing counted prints '—'", () => {
    const { m, doc } = cricket();
    const rows = [
      rowOf("A", 1, { metrics: { runs_for: 120, balls_faced_eff: 120, runs_against: 100, balls_bowled_eff: 120, ties: 0 }, points: 2 }),
      rowOf("D", 2, { played: 0, won: 0, lost: 0, points: 0, metrics: {} }),
    ];
    expect(tableOrderOf(doc), "premise: cricket ranks on NRR").toContain("nrr");
    const table = exported(doc, m, rows, "en");
    expect(table.columns.slice(-2), "NRR is the last column, after Pts").toEqual([en["table.abbr.points"], "NRR"]);
    const pts = table.columns.indexOf(en["table.abbr.points"]);
    expect(table.rows[0]![pts + 1], "Ash: +1.000").toBe("+1.000");
    expect(table.rows[1]![pts + 1], "Dogwood: nothing counted").toBe(DASH);
  });

  it("football: a goal count nobody recorded is '—', a RECORDED 0 stays the number 0 — the pair is asserted to be reached, not skipped", () => {
    const m = sport("football");
    const doc = unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: m.variants["11-a-side"] });
    const rows = [
      rowOf("A", 1, { played: 1, won: 1, lost: 0, points: 3, metrics: { gf: 2, ga: 0, gd: 2 } }),
      rowOf("B", 2, { played: 1, won: 0, lost: 1, points: 0, metrics: { gf: 0, ga: 2, gd: -2 } }),
      rowOf("D", 3, { played: 0, won: 0, lost: 0, points: 0, metrics: {} }),
    ];
    const table = exported(doc, m, rows, "en");
    // the GF column, found by the PUBLIC selection and the public header (not by a hand-typed label that could miss)
    const shown = tableColumns(m.metrics, tableOrderOf(doc), rows, tableLayoutFor(doc));
    const gf = shown.find((c) => c.key === "gf");
    expect(gf, "premise: the public table shows a GF column").toBeDefined();
    const gfAt = table.columns.indexOf(columnHeader(gf!, msgOf("en")).abbr);
    expect(gfAt, "premise: the export prints that column").toBeGreaterThan(1);
    expect(table.rows.map((r) => r[gfAt]), "Ash: 2 (a number), Birch: a recorded 0 (the number 0), Dogwood: nothing recorded").toEqual([2, 0, DASH]);
    expect(table.rows.map((r) => r[1 + 1]), "premise: P is a counted fact, 0 for Dogwood").toEqual([1, 1, 0]);
  });

  it("`#` is the stored place, not the row's position in the document (the public table's rankText): a table whose places are 1, 2, 2, 4 prints them", () => {
    const m = sport("football");
    const doc = unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: m.variants["11-a-side"] });
    const gf = (n: number) => ({ gf: n, ga: 1, gd: n - 1 });
    const rows = [
      rowOf("A", 1, { points: 6, metrics: gf(4) }), rowOf("B", 2, { points: 3, metrics: gf(2) }),
      rowOf("C", 2, { points: 3, metrics: gf(2) }), rowOf("D", 4, { points: 0, metrics: gf(0) }),
    ];
    const table = exported(doc, m, rows, "en");
    expect(table.columns[0], "premise: # is the first column").toBe("#");
    expect(table.rows.map((r) => r[0]), "the stored places, in the document's order — never 1, 2, 3, 4").toEqual([1, 2, 2, 4]);
    expect(table.rows.map((r) => r[1]), "premise: the order is the places' order").toEqual(["Ash", "Birch", "Cedar", "Dogwood"]);
  });

  it("a metric under a declared number of decimals prints as the public formatMetric does: '3.0' (text), '12.5' (a number cell), '—' when unrecorded", () => {
    const m = sport("generic");
    const doc = unpinnedRulesDoc({ module: m, kind: "league", divisionConfig: m.variants.score });
    const specs: MetricSpecLike[] = [{ key: "for", label: "For", decimals: 1 }, { key: "against", label: "Against" }];
    const rows = [
      rowOf("A", 1, { metrics: { for: 3, against: 3 } }),
      rowOf("B", 2, { metrics: { for: 12.5, against: 0 } }),
      rowOf("D", 3, { played: 0, won: 0, lost: 0, points: 0, metrics: {} }),
    ];
    const table = exported(doc, m, rows, "en", { metricSpecs: specs });
    const at = (label: string) => table.columns.indexOf(label);
    const forAt = at(en["table.abbr.for" as keyof typeof en] ?? "For");
    expect(forAt, "premise: the For column is there").toBeGreaterThan(1);
    expect(table.rows.map((r) => r[forAt])).toEqual(["3.0", 12.5, DASH]);
    // each is the public formatMetric's text for the same value and decimals
    expect(table.rows.map((r) => String(r[forAt]))).toEqual([formatMetric(3, 1), formatMetric(12.5, 1), formatMetric(undefined, 1)]);
    const againstAt = forAt + 1;
    expect(table.rows.map((r) => r[againstAt]), "no decimals declared: a whole count, a recorded 0, and the dash").toEqual([3, 0, DASH]);
  });

  it("the engine builder's own fallback for a metric nobody recorded is the public formatMetric's dash (engine-only consumers print what the web does)", () => {
    const table = buildStandings("S", [{ name: "Ash", played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} }], { printedAt: PRINTED_AT, metricColumns: ["gf"] }).sections[0]!.table!;
    expect(String(table.rows[0]![6])).toBe(formatMetric(undefined));
    expect(formatMetric(undefined), "premise: the public cell for a value nobody recorded").toBe(DASH);
  });

  it("XLSX, read back from the real sheet: a whole count is a numeric cell; '—', a derived value and half-point Pts are string cells", async () => {
    const sheetOf = async (sections: ReturnType<typeof standingsTableSections>) => {
      const model = { ...buildStandings("Open — Standings", [], { printedAt: PRINTED_AT }), sections };
      const book = new ExcelJS.Workbook();
      await book.xlsx.load((await docModelToXlsx(model)) as never); // exceljs types `load` against an older Buffer
      const sheet = book.worksheets[0]!;
      let headerAt = -1;
      sheet.eachRow((row, n) => { if (row.getCell(1).value === "#") headerAt = n; });
      expect(headerAt, "premise: the table's header row is on the sheet").toBeGreaterThan(0);
      return { sheet, headerAt };
    };
    // exceljs's ValueType is a plain name -> number object (Number 2, String 3 ...), not a reverse-mapped enum
    const typeName = (v: unknown) => Object.entries(ExcelJS.ValueType).find(([, n]) => n === v)?.[0];
    let checked = 0;

    // football: one unplayed team
    const fm = sport("football");
    const fdoc = unpinnedRulesDoc({ module: fm, kind: "league", divisionConfig: fm.variants["11-a-side"] });
    const frows = [
      rowOf("A", 1, { played: 1, won: 1, lost: 0, points: 3, metrics: { gf: 2, ga: 0, gd: 2 } }),
      rowOf("D", 2, { played: 0, won: 0, lost: 0, points: 0, metrics: {} }),
    ];
    const football = await sheetOf(standingsTableSections({
      title: "Open — Standings", common: { printedAt: PRINTED_AT }, rows: frows, metricSpecs: fm.metrics, cascade: tableOrderOf(fdoc),
      layout: tableLayoutFor(fdoc), nameOf: (id) => NAMES[id] ?? id, msg: (k) => t(en as unknown as Dict, k),
    }));
    const header = football.sheet.getRow(football.headerAt).values as unknown[];
    const col = (label: string) => { const i = header.indexOf(label); expect(i, `${label} is a column of the sheet`).toBeGreaterThan(0); return i; };
    const cell = (rowAt: number, label: string) => football.sheet.getRow(football.headerAt + rowAt).getCell(col(label));
    for (const label of ["P", "W", "L", "GF", "GA", "GD", "Pts"]) {
      expect(typeName(cell(1, label).type), `Ash ${label}: a count is a numeric cell`).toBe("Number");
      checked++;
    }
    for (const label of ["P", "W", "L", "Pts"]) {
      expect(typeName(cell(2, label).type), `Dogwood ${label}: a counted 0 is a numeric cell`).toBe("Number");
      expect(cell(2, label).value).toBe(0);
      checked++;
    }
    for (const label of ["GF", "GA", "GD"]) {
      expect(typeName(cell(2, label).type), `Dogwood ${label}: nothing recorded is a string cell`).toBe("String");
      expect(cell(2, label).value).toBe(DASH);
      checked++;
    }

    // cricket: NRR is derived text, '+1.000' and '—'
    const cm = sport("cricket");
    const cdoc = unpinnedRulesDoc({ module: cm, kind: "league", divisionConfig: cm.variants.t20 });
    const crows = [
      rowOf("A", 1, { metrics: { runs_for: 120, balls_faced_eff: 120, runs_against: 100, balls_bowled_eff: 120, ties: 0 } }),
      rowOf("D", 2, { played: 0, won: 0, lost: 0, points: 0, metrics: {} }),
    ];
    const cricket = await sheetOf(standingsTableSections({
      title: "Open — Standings", common: { printedAt: PRINTED_AT }, rows: crows, metricSpecs: cm.metrics, cascade: tableOrderOf(cdoc),
      layout: tableLayoutFor(cdoc), nameOf: (id) => NAMES[id] ?? id, msg: (k) => t(en as unknown as Dict, k),
    }));
    const cheader = cricket.sheet.getRow(cricket.headerAt).values as unknown[];
    const nrrAt = cheader.indexOf("NRR");
    expect(nrrAt, "NRR is a column of the sheet").toBeGreaterThan(0);
    const nrr = [1, 2].map((n) => cricket.sheet.getRow(cricket.headerAt + n).getCell(nrrAt));
    expect(nrr.map((c) => typeName(c.type)), "derived values are string cells").toEqual(["String", "String"]);
    expect(nrr.map((c) => c.value)).toEqual(["+1.000", DASH]);
    checked += 2;

    // chess: half-point Pts is text ("1½"), the count columns stay numeric
    const bm = sport("boardgame");
    const bdoc = unpinnedRulesDoc({ module: bm, kind: "swiss", divisionConfig: bm.variants.classical });
    const bl = tableLayoutFor(bdoc);
    expect(bl.unit, "premise: a chess table counts half-points").toBe("half");
    const brows = [
      rowOf("A", 1, { played: 2, won: 1, drawn: 1, lost: 0, points: 3, metrics: {} }), // "1½"
      rowOf("B", 2, { played: 2, won: 1, drawn: 0, lost: 1, points: 2, metrics: {} }), // "1": a whole number as TEXT, one type to the column
    ];
    const chess = await sheetOf(standingsTableSections({
      title: "Open — Standings", common: { printedAt: PRINTED_AT }, rows: brows, metricSpecs: bm.metrics, cascade: tableOrderOf(bdoc),
      layout: bl, nameOf: (id) => NAMES[id] ?? id, msg: (k) => t(en as unknown as Dict, k),
    }));
    const bheader = chess.sheet.getRow(chess.headerAt).values as unknown[];
    const ptsAt = bheader.indexOf("Pts");
    const pts = [1, 2].map((n) => chess.sheet.getRow(chess.headerAt + n).getCell(ptsAt));
    expect(pts.map((c) => typeName(c.type)), "half-point Pts is a string cell, even where the text is a whole number").toEqual(["String", "String"]);
    expect(pts.map((c) => c.value)).toEqual(["1½", "1"]);
    expect(typeName(chess.sheet.getRow(chess.headerAt + 1).getCell(bheader.indexOf("P")).type), "P is numeric").toBe("Number");
    checked += 3;

    expect(checked, "anti-vacuity: sheet cells whose type was checked").toBe(7 + 4 + 3 + 2 + 3);
  });

  it("exportCell: a number only when printing it gives back the public text", () => {
    const cases: [string, string | number][] = [
      ["13", 13], ["-12", -12], ["0", 0], ["2.5", 2.5],
      ["3.0", "3.0"], ["+0.412", "+0.412"], ["1½", "1½"], ["—", "—"], ["∞", "∞"], ["", ""], ["-0", "-0"], ["1e3", "1e3"], ["007", "007"],
    ];
    for (const [text, want] of cases) expect(exportCell(text), JSON.stringify(text)).toBe(want);
  });
});
