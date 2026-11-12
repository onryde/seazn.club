// The quick match home's "Full table" (owner 2026-11-12): the public table's own columns and cells for a league, in the
// viewer's words. Built here, in the page's folder, because `components/quick-match/**` may not reach a server module by
// value (eslint.config.mjs) and these helpers are the public table's: the SAME three calls `buildTableView` and
// `standings-table.tsx` make (`tableColumns` for which columns and in what order — the stage's tie-break order —,
// `columnHeader` for the letters and their words, `cellText` for each cell), over the same inputs (the stage's table
// rules from the one loader, the sport's metrics from the division's pinned module), so the quick match's full table
// cannot print a column or a number the public table would not.
import type { StandingsRow } from "@seazn/engine/competition";
import type { TKey } from "@/lib/i18n-runtime";
import type { FullTableData } from "@/components/quick-match/standings";
import { tableOrderOf } from "@/server/engine-db/table-rules";
import { cellText, columnHeader, tableColumns, tableLayoutFor } from "@/server/public-site/standings-view";
import type { QuickMatchHome } from "@/server/usecases/quick-match-home";

/** Null for a quick match with no stored table (a knockout). */
export function quickMatchFullTable(
  home: Pick<QuickMatchHome, "standings" | "tableRules" | "metricSpecs">,
  pub: (key: TKey) => string,
): FullTableData | null {
  if (home.standings === null) return null;
  const rows = home.standings.rows as StandingsRow[];
  const layout = tableLayoutFor(home.tableRules);
  const columns = tableColumns(home.metricSpecs, tableOrderOf(home.tableRules), rows, layout);
  return {
    columns: columns.map((c) => {
      const { abbr, title } = columnHeader(c, pub);
      return { key: c.key, abbr, word: title };
    }),
    cells: Object.fromEntries(rows.map((r) => [r.entrantId, columns.map((c) => cellText(r, c, layout))])),
  };
}
