// Quick match home (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.10; plan 2 Task 5, mockup
// home.html "Standings"): a league's table as the scoring path stored it, never recomputed here. The columns are the
// mockup's P, W and Pts in `resultColumns`' order (lib/public-site.ts), with D between W and Pts once a row holds a draw,
// the public table's own rule; the leader rows are lime-tinted (home.tsx decides which rows lead). Each header shows the
// public table's abbreviation (`table.abbr.*`) and names its column in words (`table.col.*`) for a screen reader, as the
// public table's `columnHeader` does; a level table's dash carries the public table's "level" words beside it.
//
// A SERVER component over a view home.tsx built: no dictionary or database here. The side column truncates inside a
// fixed table layout, so a 40-character name never widens a 320px screen.
//
// Not played (quick match plan 4 Task 4, mockup qmd13a01 §3-§4): the title reads "Final table" once the league is finished,
// and with a match Not played the header carries a note that the table counts played matches only (both words home.tsx's).
//
// "Full table" (owner 2026-11-12): under the short table, a native `<details>` that expands IN PLACE (no script, no modal)
// into the public table's own columns for this sport, in its order (the tie-break order the table is ranked by), with the
// public table's own header words and cell text (`app/q/[token]/full-table.ts` builds them with standings-view.ts). Open,
// the short table steps aside (the section's `group-has` variant), so one table shows at a time. The full table is wider
// than a phone: it scrolls sideways inside its own focusable region (tabIndex 0, a role and a name, as the public table's
// region does), never the page.
//
// A League + Knockout's league (quick match plan 5 Task 7, D6, D9; mockup qmd13a01 §7-12): the header says how many go
// through ("Top 2 go through", "Top 2 went through"); the rows that go through are lime-tinted (`through`), a dashed line
// sits at the cut (`cutAbove`); while a tie at the cut is open its rows show "=" and "level — to decide" (orange,
// `toDecide`), and once settled a row carries "decided by lot" or "picked" (`tag`). The "Full table" carries the same marks
// row for row (T7 review m2). The caption and the note stack together on the right from md (m6). A plain League draws none
// of these.
import type { ReactNode } from "react";

/** The public table's columns and cells for this league, already in the viewer's words: the page builds it. */
export interface FullTableData {
  /** In the public table's order: the key, the printed abbreviation and the column's name in words. */
  columns: { key: string; abbr: string; word: string }[];
  /** entrant id → one cell per column, in `columns` order. */
  cells: Readonly<Record<string, readonly string[]>>;
}

export interface StandingsView {
  /** "Standings", or "Final table" once the league is finished. */
  title: string;
  /** "Counts played matches only" while a match is Not played (plan 4); null otherwise. */
  note: string | null;
  /** A League + Knockout's "Top {count} go through" / "went through" (plan 5 T7); null for a plain League. */
  caption?: string | null;
  /** The place column's name, for a screen reader (the mockup's header cell is blank). */
  rankLabel: string;
  sideLabel: string;
  /** A level table's words for its dash (`table.level`), read by a screen reader in each place cell; null otherwise. */
  levelLabel: string | null;
  /** The numeric columns after the side, in print order: their keys, the printed abbreviation ("P", "W", "D", "Pts") and
   *  the column's name in words ("Played", "Won", "Drawn", "Points"). */
  columns: { key: string; abbr: string; word: string }[];
  rows: {
    entrantId: string;
    /** The place as the engine prints it (`rankText`): the level dash before any match counts; co-leaders share 1. */
    place: string;
    name: string;
    /** One per column, in `columns` order. */
    cells: string[];
    leader: boolean;
    /** A League + Knockout's row (plan 5 T7), absent on a plain League's: it goes (or went) through to the knockout. */
    through?: boolean;
    /** Its tie at the cut is open: the place reads "=" (hidden from a screen reader, which hears the tag) in orange. */
    toDecide?: boolean;
    /** The place is "=" (an open tie, or a tie the guests settled by Pick): printed, but not read out. */
    placeHidden?: boolean;
    /** "level — to decide", "decided by lot" or "picked", beside the name. */
    tag?: { text: string; kind: "toDecide" | "lot" | "picked" } | null;
    /** The cut: a dashed line above this row (the first row past the ones that go through, or the open tie's edge). */
    cutAbove?: boolean;
  }[];
  /** The "Full table" fold; null when the public table has no column the short table lacks (nothing more to show). */
  full: {
    /** The toggle's words ("Full table"). */
    label: string;
    /** The scrolling region's name for a screen reader. */
    regionLabel: string;
    columns: FullTableData["columns"];
    /** One per `rows` entry, in the same order: that row's cells, in `columns` order. */
    cells: (readonly string[])[];
  } | null;
}

export function QuickMatchStandings({ view }: { view: StandingsView }) {
  const note =
    view.note !== null ? (
      <p data-testid="qm-standings-note" className="min-w-0 text-xs text-[#8d7fc0] [overflow-wrap:anywhere]">
        {view.note}
      </p>
    ) : null;
  return (
    <section data-testid="qm-standings" aria-labelledby="qm-standings-title" className="group/standings min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2
          id="qm-standings-title"
          data-testid="qm-standings-title"
          className="app-display text-xs font-semibold tracking-[0.18em] text-[#b7aede]"
        >
          {view.title}
        </h2>
        {view.caption ? (
          // A League + Knockout's caption and note read as one aside (T7 review m6): on a phone the block is `contents`, so
          // both stay items of this wrapping row exactly as before; from md they stack together on the right, so the
          // caption never floats mid-row between the title and the note.
          <div className="contents md:ml-auto md:flex md:min-w-0 md:flex-col md:items-end md:gap-y-0.5 md:text-right">
            <p data-testid="qm-standings-caption" className="min-w-0 text-xs text-[#d9d2f2] [overflow-wrap:anywhere]">
              {view.caption}
            </p>
            {note}
          </div>
        ) : (
          note
        )}
      </div>
      <div
        data-testid="qm-standings-short"
        className="min-w-0 overflow-hidden rounded-xl border border-[#3b2a6e] group-has-[>details[open]]/standings:hidden"
      >
        <table aria-labelledby="qm-standings-title" className="w-full table-fixed border-collapse bg-[rgba(36,22,80,0.75)] text-sm">
          <thead>
            <tr data-testid="qm-standings-head" className="border-b border-[#3b2a6e]">
              <th scope="col" className="w-9 px-2 py-1.5">
                <span className="sr-only">{view.rankLabel}</span>
              </th>
              <th scope="col" className="app-display px-2 py-1.5 text-left text-[11px] font-semibold tracking-[0.08em] text-[#b7aede]">
                {view.sideLabel}
              </th>
              {view.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  title={c.word}
                  className="app-display w-10 px-1 py-1.5 text-center text-[11px] font-semibold tracking-[0.08em] text-[#b7aede]"
                >
                  <span className="sr-only">{c.word}</span>
                  <span aria-hidden="true">{c.abbr}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr
                key={r.entrantId}
                data-testid="qm-standings-row"
                data-leader={r.leader ? "true" : undefined}
                data-through={r.through ? "true" : undefined}
                data-to-decide={r.toDecide ? "true" : undefined}
                className={`border-b border-[rgba(59,42,110,0.6)] last:border-b-0 ${rowTint(r)}${r.cutAbove ? CUT : ""}`}
              >
                <td className="app-display px-2 py-2 text-center text-base font-bold text-[color:var(--mk-lime)]">
                  {r.placeHidden ? (
                    <span aria-hidden="true" className={r.toDecide ? "text-[color:var(--mk-orange)]" : undefined}>
                      {r.place}
                    </span>
                  ) : view.levelLabel !== null ? (
                    <>
                      <span aria-hidden="true">{r.place}</span>
                      <span className="sr-only">{view.levelLabel}</span>
                    </>
                  ) : (
                    r.place
                  )}
                </td>
                {r.tag ? (
                  <th scope="row" className="px-2 py-2 text-left font-normal text-cream">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 max-w-full truncate">{r.name}</span>
                      {rowTag(r.tag)}
                    </span>
                  </th>
                ) : (
                  <th scope="row" className="truncate px-2 py-2 text-left font-normal text-cream">
                    {r.name}
                  </th>
                )}
                {r.cells.map((value, i) => (
                  <td
                    key={view.columns[i]!.key}
                    data-testid="qm-cell"
                    className="app-display px-1 py-2 text-center text-base font-bold tabular-nums text-cream"
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.full ? <QuickMatchFullTable view={view} full={view.full} /> : null}
    </section>
  );
}

type Row = StandingsView["rows"][number];
/** The row's tint: lime for the leader (a plain League) or a side going through (a League + Knockout), orange for a row of
 *  an open tie at the cut, none otherwise (an empty string: a plain League's row class is what it always was). */
function rowTint(r: Row): string {
  if (r.toDecide) return "bg-[rgba(251,146,60,0.08)]";
  return r.leader || r.through ? "bg-[rgba(163,230,53,0.08)]" : "";
}
/** The cut line: a dashed rule above the row, where the sides going through end (mockup qmd13a01 §8-9). */
const CUT = " border-t-2 border-t-[#4a3a80] [border-top-style:dashed]";
const TAG = {
  toDecide: "bg-[rgba(251,146,60,0.16)] text-[color:var(--mk-orange)]",
  lot: "border border-[#4a3a80] text-[#b7aede]",
  picked: "bg-[rgba(163,230,53,0.14)] text-[color:var(--mk-lime)]",
} as const satisfies Record<NonNullable<Row["tag"]>["kind"], string>;
/** The tag beside a name. The Full table's sizes its columns to their content (it scrolls), so its tag never breaks inside
 *  a word (`whitespace-nowrap`): squeezed, the tag drops under the name whole instead. */
function rowTag(tag: NonNullable<Row["tag"]>, testId = "qm-standings-tag", extra = "") {
  return (
    <span
      data-testid={testId}
      data-kind={tag.kind}
      className={`inline-flex min-w-0 max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-tight [overflow-wrap:anywhere] ${TAG[tag.kind]}${extra}`}
    >
      {tag.text}
    </span>
  );
}

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--mk-lime)]";
const HEAD = "app-display px-2 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-[#b7aede]";

/** The Full table's side name: on a phone the column holds 10rem and the table scrolls sideways in its region; from md the
 *  cap lifts and the name takes the room the numbers leave (sign-off qlk14s1: capped at 10rem beside ~400px of empty row
 *  at 1280), still ending in an ellipsis when that is not enough. */
const FULL_NAME = "block max-w-[10rem] truncate md:max-w-none";
/** The side cell's content, from md: the cell asks for the table's whole width (`md:w-full` on the `th`), so the numeric
 *  columns keep their own widths and the side column takes the rest. The inner box adds nothing to the column's width
 *  (`w-0 min-w-full`: as wide as its cell and no wider), so a long name truncates instead of widening the table; the outer
 *  box holds the column at 10rem at least, so a sport with many columns scrolls rather than squeezing the name to
 *  nothing. Below md both boxes are plain blocks and the cell is what it was. */
function fullSide(content: ReactNode): ReactNode {
  return (
    <span className="block md:min-w-[10rem]">
      <span className="block md:w-0 md:min-w-full">{content}</span>
    </span>
  );
}

export function QuickMatchFullTable({ view, full }: { view: StandingsView; full: NonNullable<StandingsView["full"]> }) {
  return (
    <details data-testid="qm-full-table" className="group/full mt-1 min-w-0">
      <summary
        data-testid="qm-full-table-toggle"
        className={`app-display inline-flex min-h-11 max-w-full cursor-pointer list-none items-center gap-1.5 rounded-lg text-sm font-semibold tracking-[0.04em] text-[color:var(--mk-lime)] [&::-webkit-details-marker]:hidden ${FOCUS}`}
      >
        {full.label}
        <span aria-hidden="true" className="inline-block group-open/full:rotate-180">
          ▾
        </span>
      </summary>
      <div
        role="region"
        tabIndex={0}
        // `relative`: the header's screen-reader words are absolutely placed, so without a containing block here they sit at
        // their scrolled-out x against the page and widen it at 320 (measured: 572px), as the public table's region says.
        aria-label={full.regionLabel}
        data-testid="qm-full-table-region"
        className={`relative min-w-0 overflow-x-auto rounded-xl border border-[#3b2a6e] ${FOCUS}`}
      >
        <table aria-label={full.regionLabel} className="w-full border-collapse bg-[rgba(36,22,80,0.75)] text-sm">
          <thead>
            <tr data-testid="qm-full-table-head" className="border-b border-[#3b2a6e]">
              <th scope="col" className="w-9 px-2 py-1.5">
                <span className="sr-only">{view.rankLabel}</span>
              </th>
              <th scope="col" className={`${HEAD} text-left`}>
                {view.sideLabel}
              </th>
              {full.columns.map((c) => (
                <th key={c.key} scope="col" title={c.word} className={`${HEAD} whitespace-nowrap text-center`}>
                  <span className="sr-only">{c.word}</span>
                  <span aria-hidden="true">{c.abbr}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr
                key={r.entrantId}
                data-testid="qm-full-table-row"
                data-leader={r.leader ? "true" : undefined}
                // The short table's marks, row for row (T7 review m2): the same tint, cut line, "=" and tag.
                data-through={r.through ? "true" : undefined}
                data-to-decide={r.toDecide ? "true" : undefined}
                className={`border-b border-[rgba(59,42,110,0.6)] last:border-b-0 ${rowTint(r)}${r.cutAbove ? CUT : ""}`}
              >
                <td className="app-display px-2 py-2 text-center text-base font-bold text-[color:var(--mk-lime)]">
                  {r.placeHidden ? (
                    <span aria-hidden="true" className={r.toDecide ? "text-[color:var(--mk-orange)]" : undefined}>
                      {r.place}
                    </span>
                  ) : view.levelLabel !== null ? (
                    <>
                      <span aria-hidden="true">{r.place}</span>
                      <span className="sr-only">{view.levelLabel}</span>
                    </>
                  ) : (
                    r.place
                  )}
                </td>
                <th scope="row" className="px-2 py-2 text-left font-normal text-cream md:w-full">
                  {fullSide(
                    r.tag ? (
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className={FULL_NAME}>{r.name}</span>
                        {rowTag(r.tag, "qm-full-table-tag", " whitespace-nowrap")}
                      </span>
                    ) : (
                      <span className={FULL_NAME}>{r.name}</span>
                    ),
                  )}
                </th>
                {full.cells[i]!.map((value, k) => (
                  <td
                    key={full.columns[k]!.key}
                    data-testid="qm-full-cell"
                    className="app-display whitespace-nowrap px-2 py-2 text-center text-base font-bold tabular-nums text-cream"
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
