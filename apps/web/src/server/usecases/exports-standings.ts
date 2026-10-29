import "server-only";
// The organiser's standings document, one table: the PURE half of `buildDivisionDocModel`'s "standings" case, lifted out
// so the export and its parity sweep call the same function (standings export parity, 2026-10-29).
//
// The rule is one sentence: the PDF/XLSX prints what the public table prints. So nothing here decides a column or a cell:
//   - the columns are `tableColumns` (the selection both public tables call): result columns, the sport's displayed
//     metrics a row carries, Pts, then the derived columns the stage's cascade earns (NRR, a ratio, Buchholz, SB …);
//   - every cell is `cellText` (THE cell expression of both public tables: `resultColumnText`, `formatMetric` over the
//     column's declared decimals, `derivedMetricText`), so a team with no counted result prints the public "—", not 0;
//   - every header is `columnHeader` over the public dictionary, in the org's language.
// What this file owns is only the spreadsheet's typing of a cell (`exportCell`) and the pairing of cells with headers.
import { buildStandings, type BuildOpts, type DocSection, type ExportStandingsRow } from "@seazn/engine/exports";
import { isLevelTable, rankText, type StandingsRow, type TableLayout } from "@seazn/engine/competition";
import type { StandingsColumn, MetricSpecLike } from "@/lib/public-site";
import type { TKey } from "@/lib/i18n-runtime";
import { cellText, columnHeader, resultColumnsOf, tableColumns } from "@/server/public-site/standings-view";

/** The Pts column as `standingsColumns` declares it (always present, after the metrics and before the derived columns).
 *  Held to the public selection by the parity sweep: the exported header list equals the public one. */
const POINTS: StandingsColumn = { key: "points", label: "Pts", kind: "structural" };

/**
 * A printed cell as the document holds it: a NUMBER when printing the number gives back exactly the text the public table
 * prints ("13", "-12", "2.5"), so a spreadsheet's count columns stay numeric; otherwise the text itself ("—" for a value
 * nobody recorded, "3.0" under a declared decimal, "1½" for chess half-points, "+0.412"). Never a number that would print
 * differently than the public cell does.
 */
export function exportCell(text: string): string | number {
  const n = Number(text);
  return Number.isFinite(n) && String(n) === text ? n : text;
}

export interface StandingsExportInput {
  /** The document title (`<competition> — <division>`) and its chrome: description, branding, i18n, page breaks. */
  title: string;
  common: BuildOpts;
  liveUrl?: string;
  /** THIS table's stored rows (one pool, or the whole stage). */
  rows: readonly StandingsRow[];
  /** The sport module's metric declarations, the stage's order and its layout: the public table's three inputs. */
  metricSpecs: readonly MetricSpecLike[];
  cascade: readonly string[];
  layout: TableLayout;
  nameOf: (entrantId: string) => string;
  /** The entrant's crest URL, already resolved; absent or null: none. */
  badgeOf?: (entrantId: string) => string | null | undefined;
  /** The public dictionary's lookup, in the org's language (`t(publicDict, key)`). */
  msg: (key: TKey) => string;
}

/** The table's document sections (one, for the standings kind), headed as the caller likes. */
export function standingsTableSections(input: StandingsExportInput): DocSection[] {
  const { layout, msg } = input;
  const shown = tableColumns(input.metricSpecs, input.cascade, input.rows, layout);
  const results = resultColumnsOf(shown);
  const metrics = shown.filter((c) => c.kind === "metric");
  const derived = shown.filter((c) => c.kind === "derived");
  const header = (c: { key: string; label: string }) => columnHeader(c, msg).abbr;
  // W2d concern 2 (anti-goal 3, X-TB-6): a LEVEL table — nothing counted — has no places, and `#` would print seed 1 first.
  const level = isLevelTable(input.rows);
  const rows: ExportStandingsRow[] = [...input.rows]
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .map((r) => {
      const badge = input.badgeOf?.(r.entrantId);
      return {
        // the public `#` (`rankText`): the level dash, else the row's place; a row the ranking pass left no place keeps
        // the builder's position
        ...(level || r.rank !== undefined ? { rank: exportCell(rankText(r, level)) } : {}),
        name: input.nameOf(r.entrantId),
        played: r.played,
        won: r.won,
        drawn: r.drawn,
        lost: r.lost,
        results: results.map((c) => exportCell(cellText(r, c, layout))),
        // whole points are a number cell; a half-point table (chess: "1", "½", "1½") is text throughout, one type to a column
        points: layout.unit === "whole" ? exportCell(cellText(r, POINTS, layout)) : cellText(r, POINTS, layout),
        metrics: r.metrics,
        metricCells: metrics.map((c) => exportCell(cellText(r, c, layout))),
        derived: derived.map((c) => cellText(r, c, layout)),
        ...(badge ? { badgeUrl: badge } : {}),
      };
    });
  return buildStandings(input.title, rows, {
    ...input.common,
    i18n: {
      ...input.common.i18n,
      standingsHeaders: { team: msg("table.team"), points: header(POINTS), metrics: metrics.map(header) },
    },
    metricColumns: metrics.map((m) => m.key),
    resultColumns: results.map(header),
    derivedColumns: derived.map(header),
    ...(input.liveUrl !== undefined ? { liveUrl: input.liveUrl } : {}),
  }).sections;
}
