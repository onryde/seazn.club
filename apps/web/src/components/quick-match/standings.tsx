// Quick match home (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §7.10; plan 2 Task 5, mockup
// home.html "Standings"): a league's table as the scoring path stored it, never recomputed here. The columns are the
// mockup's P, W and Pts in `resultColumns`' order (lib/public-site.ts), with D between W and Pts once a row holds a draw,
// the public table's own rule; the leader rows are lime-tinted (home.tsx decides which rows lead).
//
// A SERVER component over a view home.tsx built: no dictionary or database here. The side column truncates inside a
// fixed table layout, so a 40-character name never widens a 320px screen.
export interface StandingsView {
  title: string;
  /** The place column's name, for a screen reader (the mockup's header cell is blank). */
  rankLabel: string;
  sideLabel: string;
  /** The numeric columns after the side, in print order: their keys and their words ("P", "W", "D", "Pts"). */
  columns: { key: string; label: string }[];
  rows: {
    entrantId: string;
    /** The place as the stored table gives it; blank on a level table, which has no place yet. */
    place: string;
    name: string;
    /** One per column, in `columns` order. */
    cells: string[];
    leader: boolean;
  }[];
}

export function QuickMatchStandings({ view }: { view: StandingsView }) {
  return (
    <section data-testid="qm-standings" aria-labelledby="qm-standings-title" className="min-w-0">
      <h2
        id="qm-standings-title"
        data-testid="qm-standings-title"
        className="app-display mb-2 text-xs font-semibold tracking-[0.18em] text-[#b7aede]"
      >
        {view.title}
      </h2>
      <div className="min-w-0 overflow-hidden rounded-xl border border-[#3b2a6e]">
        <table className="w-full table-fixed border-collapse bg-[rgba(36,22,80,0.75)] text-sm">
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
                  className="app-display w-10 px-1 py-1.5 text-center text-[11px] font-semibold tracking-[0.08em] text-[#b7aede]"
                >
                  {c.label}
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
                <td className="app-display px-2 py-2 text-center text-base font-bold text-[color:var(--mk-lime)]">{r.place}</td>
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
    </section>
  );
}
