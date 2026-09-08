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
// carries NO width at all, so it takes whatever's left over. A first
// attempt gave the name cell its own `w-full max-w-0` — WRONG: `max-w-0` on
// the inner `block truncate` span gives it a used width of zero, clipping
// every name to nothing, and `max-w-0` on the `<td>` is inert under fixed
// layout regardless (a fixed-layout column's width comes from the explicit
// widths in the row, never from `max-width`). The name cell needs no width
// utility of its own; only `block truncate` on the inner span, nothing else.
//
// Review round 2 (NEW IMPORTANT A) — Tailwind is border-box, so a numeric
// column's CONTENT width is its `w-*` MINUS its horizontal padding: `w-7`
// (28px) with the original `pl-2` (8px) left only 20px for the digits
// themselves — a century "104" or a ball count "127" painted over its
// neighbour, with no scroll to relieve it (this is a table, not a rail).
// Numeric header/cells now use `px-0.5` (2px) instead, so the ruled widths
// actually fit what they're sized for: `w-7` (28px, ~24px content) fits
// three digits; `w-8` (32px, ~28px) fits "19.4"; `w-11` (44px, ~40px) fits
// "142.9". The view model is expected to format `strikeRate`/`economy` to
// ONE decimal and `crr`/`rrr` to TWO (Task 6's job — asserted nothing about
// it here, only that the COLUMN can hold what a formatted value looks
// like). With the container's own padding accounted for, the name
// column's remainder is ≈100px at a 320px viewport — narrow, but enough
// for `block truncate` to do its job rather than clipping to nothing.
//
// Also: `scope="col"` on every header (screen readers announce which column
// a data cell belongs to without one), and an `sr-only` span carrying real
// TEXT in the name column's header — a `title` attribute alone is not
// reliably announced, unlike visible or `sr-only` text content.
//
// Whole-branch review, Accessibility group — TWO fixes, both about who can
// read this table:
//
//  * THE NUMERIC HEADERS LOCALISED ONLY VIA `title`, which is a HOVER
//    affordance a phone does not have; and where a `<th>` has text content
//    that text WINS the accessible name, so "R" was announced and the
//    localised word in `title` never was. Each numeric header now ships the
//    localised word as `sr-only` text with the notation `aria-hidden` — a
//    fold out of the accessibility tree, never a removal, so a sighted reader
//    still reads "R", "B", "4s". This is exactly what `scorecard-tab.tsx`'s
//    own `Th` already did, three inches away on the same tab.
//
//  * THE NAME CELL WAS A `<td>`. In a stat table the name IS the row's
//    header: without `<th scope="row">` a screen reader reading "62" out of
//    the R column cannot say whose 62 it is. `text-left` is needed because a
//    `<th>` is centred by default; `font-medium` was already there and keeps
//    it off the UA's bold.
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
  /** Owner design round (D) — this column FOLDS below `md`: its header and
   *  cells are `max-md:hidden` and its figure reappears in `phoneSubLine`
   *  under the name. A fold, never a drop: the same facts are on the phone,
   *  arranged differently. Columns without it show at every width. */
  foldAtPhone?: boolean;
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
  /** Owner design round (D) — the muted line under the NAME, phone only,
   *  carrying whatever `foldAtPhone` columns removed from the row. Lives in
   *  the CALLER because its wording is the sport's own notation ("1×4 1×6"),
   *  and this primitive holds no cricket vocabulary. Supply it whenever any
   *  column folds, or the phone silently loses those figures. */
  phoneSubLine?: (row: Row) => ReactNode;
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
  phoneSubLine,
}: StatTableProps<Row>) {
  const nameTitle = t(dict, nameTitleKey);
  return (
    // Owner design round (D) — CAPPED MEASURE from `md`. `table-fixed` gives
    // the name column whatever the numeric columns do not claim, so in a
    // half-width card at 1280 the name sat at the left edge and its figures at
    // the right, ~300px apart, which is the exact canyon this round exists to
    // close. A printout has a fixed character width; the fix is to stop the
    // ROW stretching, not to re-tune the columns inside it.
    <table className="w-full table-fixed border-separate border-spacing-0 tabular-nums md:max-w-[28rem]">
      <caption className="sr-only">{t(dict, captionKey)}</caption>
      <thead>
        <tr>
          {/* Owner design round (D) — this header is now VISIBLE. It was
              `sr-only`, which left the two stacked tables on a phone reading
              as one block interrupted by an unexplained second header row
              (…SR, then O M R W ECON, with nothing saying "Bowling"). Sighted
              readers were getting less than screen-reader users were. One
              element carries the text for both now, so the two cannot drift —
              which is why the `sr-only` twin is gone rather than kept. */}
          <th
            scope="col"
            title={nameTitle}
            className="pb-1 text-left font-mono text-[10px] font-medium uppercase tracking-wide text-ink-muted"
          >
            {nameTitle}
          </th>
          {columns.map((col) => (
            <th
              key={col.abbr}
              scope="col"
              title={t(dict, col.titleKey)}
              className={`${col.width} pb-1 px-0.5 text-right font-mono text-[10px] font-medium uppercase tracking-wide text-ink-muted${
                col.foldAtPhone ? " max-md:hidden" : ""
              }`}
            >
              {/* See the note above: the localised word ships as REAL text, and
                  the notation is hidden from the accessibility tree so a
                  screen reader reads "Strike rate" once rather than "SR Strike
                  rate". `scorecard-tab.tsx`'s `Th` is the same two spans. */}
              <span className="sr-only">{t(dict, col.titleKey)}</span>
              <span aria-hidden>{col.abbr}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)} {...(rowAttrs ? rowAttrs(row) : {})}>
            <th
              scope="row"
              data-testid="mc-stat-name-cell"
              className="min-w-0 py-1.5 pr-2 text-left align-top text-sm font-medium text-zinc-800"
            >
              <span className="block truncate">{nameCell(row)}</span>
              {/* Phone only, and only when the caller folded something. The
                  `md:hidden` is what stops it printing twice on desktop,
                  where the same figures already have their own columns. */}
              {phoneSubLine ? (
                <span
                  data-testid="mc-stat-phone-subline"
                  className="mt-0.5 block truncate font-mono text-[11px] font-normal text-ink-muted md:hidden"
                >
                  {phoneSubLine(row)}
                </span>
              ) : null}
            </th>
            {columns.map((col) => (
              <td
                key={col.abbr}
                className={`px-0.5 py-1.5 text-right align-top font-mono text-[13px] tabular-nums text-zinc-700${
                  col.foldAtPhone ? " max-md:hidden" : ""
                }`}
              >
                {col.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
