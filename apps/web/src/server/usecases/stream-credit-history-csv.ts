// server/usecases/stream-credit-history-csv.ts — the Streaming credit history as a CSV file (Settings → Credits →
// Streaming → Export). Pure: rows in, text out, so the formula-injection guard and the column set are testable with no
// request in sight. Headers are stable and machine-readable, NOT localised — the file is data, like the AI export
// (settings/billing/credits.csv) and the participants export.
import type { StreamHistoryRow } from "@/server/usecases/stream-credit-history";

/** `activity` is the history kind key (`packPurchase`, `streamUsed`, …) — stable, never the localised label. */
export const STREAM_HISTORY_CSV_HEADER = ["date", "activity", "change", "balance_after", "fixture_no", "match", "competition"] as const;

/** A side not yet decided (a bracket slot, a TBD entrant) — the same word the screen shows, so a row never reads `Hawks v `. */
const UNDECIDED = "TBD";

/** `Hawks v Owls`; one undecided side is `Hawks v TBD`; both undecided is empty — the row's `fixture_no` names the match. */
function matchName(f: { homeName: string | null; awayName: string | null }): string {
  if (!f.homeName && !f.awayName) return "";
  return `${f.homeName || UNDECIDED} v ${f.awayName || UNDECIDED}`;
}

/** One CSV cell.
 *  TEXT starting with = + - @ (or a leading tab/CR) is executed as a formula by Excel and Sheets, and the entrant and
 *  competition names in this file are user-controlled — so it is neutralised with a leading apostrophe, as the AI export
 *  does. Quoted when it holds a comma, quote or newline.
 *  A NUMBER is written as is: it is a typed integer of ours (a signed change, a balance), never text from a person, and
 *  a spend's "-1" run through the text guard would arrive as the string `'-1` that a spreadsheet cannot sum. */
export function csvCell(v: string | number): string {
  if (typeof v === "number") return String(v);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function streamHistoryCsv(rows: readonly StreamHistoryRow[]): string {
  const lines: (string | number)[][] = [
    [...STREAM_HISTORY_CSV_HEADER],
    ...rows.map((r) => [
      r.dateIso,
      r.kind,
      r.delta,
      r.balanceAfter,
      r.fixture ? r.fixture.fixtureNo : "",
      r.fixture ? matchName(r.fixture) : "",
      r.fixture?.competitionName ?? "",
    ]),
  ];
  return lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n");
}
