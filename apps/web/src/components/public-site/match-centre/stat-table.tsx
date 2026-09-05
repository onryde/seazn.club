// Spectator surface W1, Task 11 — the shared stat-table primitive behind the
// live block's batters and bowler tables. A `<table>` with a screen-reader
// `<caption>`, right-aligned `tabular-nums` numeric cells, and a truncating
// name cell. Column HEADERS stay the sport's own abbreviation notation (R,
// B, 4s, 6s, SR, O, M, W, Econ …) in every locale — only each header's
// `title` attribute (and the table's own caption) is localised, per the
// design's "notation, not copy" rule for the scoreboard's numbers (the same
// rule `MatchCentreHeader.rateLine`'s own schema comment states for
// "CRR 8.44 · RRR 9.71").
//
// Review fix round 2 (IMPORTANT 1, corrected) — the name cell used to carry
// `min-w-0 max-w-40 truncate` directly on a `<td>` under the table's default
// AUTO layout: `min-w-0`/`max-width` on a table cell are INERT there (a
// `<td>` sizes to its content regardless), and `white-space: nowrap` (which
// `truncate` sets) just overflows instead of clipping. Fixed with
// `table-fixed` on the `<table>` and an EXPLICIT width on every NUMERIC
// column's `<th>` (only honoured under fixed layout) — the name column
// carries NO width at all, so it takes whatever's left over (about 120px at
// a 320px viewport, which is where a long name actually starts truncating).
// A first attempt gave the name cell its own `w-full max-w-0` — WRONG:
// `max-w-0` on the inner `block truncate` span gives it a used width of
// zero, clipping every name to nothing, and `max-w-0` on the `<td>` is
// inert under fixed layout regardless (a fixed-layout column's width comes
// from the explicit widths in the row, never from `max-width`). The name
// cell needs no width utility of its own; only `block truncate` on the
// inner span, nothing else.
//
// Also: `scope="col"` on every header (screen readers announce which column
// a data cell belongs to without one), and an `sr-only` span carrying real
// TEXT in the name column's header — a `title` attribute alone is not
// reliably announced, unlike visible or `sr-only` text content.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";

export interface StatColumn<Row> {
  /** The literal header text — R/B/4s/6s/SR, O/M/R/W/Econ — never localised. */
  abbr: string;
  /** Dictionary key for this column's `title` attribute (the full word). */
  titleKey: TKey;
  /** Tailwind width class for this column's `<th>` — REQUIRED now that the
   *  table is `table-fixed` and the name column depends on every numeric
   *  column claiming a fixed width so it can take the remainder. */
  width: string;
  cell: (row: Row) => ReactNode;
}

export interface StatTableProps<Row> {
  dict: PublicDict;
  captionKey: TKey;
  /** Dictionary key for the leftmost (name) column header's `title`/label. */
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
  const nameTitle = t(dict, nameTitleKey);
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 tabular-nums">
      <caption className="sr-only">{t(dict, captionKey)}</caption>
      <thead>
        <tr>
          <th
            scope="col"
            title={nameTitle}
            className="pb-1 text-left text-xs font-medium uppercase tracking-wide text-ink-muted"
          >
            <span className="sr-only">{nameTitle}</span>
          </th>
          {columns.map((col) => (
            <th
              key={col.abbr}
              scope="col"
              title={t(dict, col.titleKey)}
              className={`${col.width} pb-1 pl-2 text-right text-xs font-medium uppercase tracking-wide text-ink-muted`}
            >
              {col.abbr}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)} {...(rowAttrs ? rowAttrs(row) : {})}>
            <td data-testid="mc-stat-name-cell" className="pr-2 text-sm font-medium text-zinc-800">
              <span className="block truncate">{nameCell(row)}</span>
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
