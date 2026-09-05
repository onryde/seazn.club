// Spectator surface W1, Task 11 — the shared stat-table primitive behind the
// live block's batters and bowler tables. A `<table>` with a screen-reader
// `<caption>`, right-aligned `tabular-nums` numeric cells, and a
// `min-w-0 truncate` name cell. Column HEADERS stay the sport's own
// abbreviation notation (R, B, 4s, 6s, SR, O, M, W, Econ …) in every
// locale — only each header's `title` attribute (and the table's own
// caption) is localised, per the design's "notation, not copy" rule for the
// scoreboard's numbers (the same rule `MatchCentreHeader.rateLine`'s own
// schema comment states for "CRR 8.44 · RRR 9.71").
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";

export interface StatColumn<Row> {
  /** The literal header text — R/B/4s/6s/SR, O/M/R/W/Econ — never localised. */
  abbr: string;
  /** Dictionary key for this column's `title` attribute (the full word). */
  titleKey: TKey;
  cell: (row: Row) => ReactNode;
}

export interface StatTableProps<Row> {
  dict: PublicDict;
  captionKey: TKey;
  /** Dictionary key for the leftmost (name) column header's `title`. */
  nameTitleKey: TKey;
  columns: StatColumn<Row>[];
  rows: Row[];
  nameCell: (row: Row) => ReactNode;
  rowKey: (row: Row, index: number) => string;
  /** Extra attributes per row — e.g. `data-striker`. */
  rowAttrs?: (row: Row) => Record<string, string>;
}

export function StatTable<Row>({
  dict,
  captionKey,
  nameTitleKey,
  columns,
  rows,
  nameCell,
  rowKey,
  rowAttrs,
}: StatTableProps<Row>) {
  return (
    <table className="w-full border-separate border-spacing-0 tabular-nums">
      <caption className="sr-only">{t(dict, captionKey)}</caption>
      <thead>
        <tr>
          <th
            title={t(dict, nameTitleKey)}
            className="min-w-0 pb-1 text-left text-xs font-medium uppercase tracking-wide text-zinc-400"
          />
          {columns.map((col) => (
            <th
              key={col.abbr}
              title={t(dict, col.titleKey)}
              className="w-12 pb-1 pl-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-400"
            >
              {col.abbr}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)} {...(rowAttrs ? rowAttrs(row) : {})}>
            <td className="min-w-0 max-w-40 truncate pr-2 text-sm font-medium text-zinc-800">
              {nameCell(row)}
            </td>
            {columns.map((col) => (
              <td key={col.abbr} className="pl-2 text-right text-sm tabular-nums text-zinc-700">
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
