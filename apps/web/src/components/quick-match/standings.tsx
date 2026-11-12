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
// "Full table" (owner 2026-11-12): under the short table, a native `<details>` that expands IN PLACE (no script, no modal)
// into the public table's own columns for this sport, in its order (the tie-break order the table is ranked by), with the
// public table's own header words and cell text (`app/q/[token]/full-table.ts` builds them with standings-view.ts). Open,
// the short table steps aside (the section's `group-has` variant), so one table shows at a time. The full table is wider
// than a phone: it scrolls sideways inside its own focusable region (tabIndex 0, a role and a name, as the public table's
// region does), never the page.
/** The public table's columns and cells for this league, already in the viewer's words: the page builds it. */
export interface FullTableData {
  /** In the public table's order: the key, the printed abbreviation and the column's name in words. */
  columns: { key: string; abbr: string; word: string }[];
  /** entrant id → one cell per column, in `columns` order. */
  cells: Readonly<Record<string, readonly string[]>>;
}

export interface StandingsView {
  title: string;
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
  return (
    <section data-testid="qm-standings" aria-labelledby="qm-standings-title" className="group/standings min-w-0">
      <h2
        id="qm-standings-title"
        data-testid="qm-standings-title"
        className="app-display mb-2 text-xs font-semibold tracking-[0.18em] text-[#b7aede]"
      >
        {view.title}
      </h2>
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
                className={`border-b border-[rgba(59,42,110,0.6)] last:border-b-0 ${r.leader ? "bg-[rgba(163,230,53,0.08)]" : ""}`}
              >
                <td className="app-display px-2 py-2 text-center text-base font-bold text-[color:var(--mk-lime)]">
                  {view.levelLabel !== null ? (
                    <>
                      <span aria-hidden="true">{r.place}</span>
                      <span className="sr-only">{view.levelLabel}</span>
                    </>
                  ) : (
                    r.place
                  )}
                </td>
                <th scope="row" className="truncate px-2 py-2 text-left font-normal text-cream">
                  {r.name}
                </th>
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

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--mk-lime)]";
const HEAD = "app-display px-2 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-[#b7aede]";

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
                className={`border-b border-[rgba(59,42,110,0.6)] last:border-b-0 ${r.leader ? "bg-[rgba(163,230,53,0.08)]" : ""}`}
              >
                <td className="app-display px-2 py-2 text-center text-base font-bold text-[color:var(--mk-lime)]">
                  {view.levelLabel !== null ? (
                    <>
                      <span aria-hidden="true">{r.place}</span>
                      <span className="sr-only">{view.levelLabel}</span>
                    </>
                  ) : (
                    r.place
                  )}
                </td>
                <th scope="row" className="px-2 py-2 text-left font-normal text-cream">
                  <span className="block max-w-[10rem] truncate">{r.name}</span>
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
