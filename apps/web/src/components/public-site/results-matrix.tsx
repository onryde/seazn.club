// Server side of the round-robin results matrix (G2) — the classic crosstable
// for league/group stages. Rows = home side, columns = away side; a cell
// holds the scoreline of home-vs-away (linked), a live dot while in play, or
// a dot placeholder for an unplayed pairing. Zero per-sport code: scorelines
// come from ScoreSummary.headline, order comes from the standings.
//
// W5 B4 (stress S4): `resultsGridData` resolves every cell's words here (the dictionary, the forfeit ledger, the fixture's
// href) into the compact `ResultsGridData` - the axis and one line per played pairing, never n x n - and the table is drawn
// by `ResultsGrid` (results-grid.tsx). The division pages hand that data to `ResultsGridDisclosure`, which draws the table
// only once it is opened; `ResultsMatrix` draws it straight away.
import type { PublicFixture } from "@/server/public-site/data";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { forfeitLedgerOfReason, forfeitTag, forfeitWords } from "@/lib/forfeit-tag";
import { ResultsGrid, type ResultsGridData, type ResultsGridLine } from "./results-grid";

interface Props {
  /** Row/column order — pass the standings rank order. */
  entrantIds: string[];
  entrantNames: Record<string, string>;
  /** W3 T15 review I4: entrant id → status (the page's `entrantStatuses`) — a withdrawal cascade's walkover over a
   *  DISQUALIFIED entrant reads as a plain walkover, never "withdrew". Absent, the words follow the outcome alone. */
  entrantStatuses?: Readonly<Record<string, string>>;
  entrantLogos?: Record<string, string | null>;
  /** Fixtures of ONE pool/stage scope; pairings outside entrantIds are ignored. */
  fixtures: PublicFixture[];
  fixtureHref: (fixtureId: string) => string;
  caption?: string;
  /** The PUBLIC dictionary, in the page's language — the corner cell and the
   *  live dot's accessible name are its words, never English literals. */
  dict: Dict;
}

const DONE = new Set(["decided", "finalized", "forfeited", "abandoned"]);

/** The grid's cells as data, or null for fewer than two entrants (no grid). One entry per pairing that holds a line (a
 *  double round robin stacks two), so its size follows the fixtures, never the square of the field. */
export function resultsGridData({
  entrantIds,
  entrantNames,
  entrantStatuses,
  entrantLogos,
  fixtures,
  fixtureHref,
  dict,
}: Omit<Props, "caption">): ResultsGridData | null {
  if (entrantIds.length < 2) return null;
  const axis = new Set(entrantIds);
  const nameOf = (id: string) => entrantNames[id] ?? "?";
  // W2b Task 13 (review I-2): a forfeited cell carries its tag and sentence, in the page's dictionary. A round robin
  // feeds no next match, so a double walkover's sentence has no next-round clause here.
  const lineOf = (f: PublicFixture): ResultsGridLine => {
    if (f.status === "in_play") return { id: f.id, kind: "live", href: fixtureHref(f.id) };
    if (!DONE.has(f.status)) return { id: f.id, kind: "pending" };
    const tag = forfeitTag(f.outcome, forfeitLedgerOfReason(f.abandon_reason), f, entrantStatuses);
    if (tag !== null) {
      const words = forfeitWords(tag, (key, vars) => t(dict, key, vars), nameOf);
      // A double walkover credits nobody, so its 0 — 0 is not shown — the tag alone says what happened.
      const headline = words.kind !== "double_walkover" && f.summary?.headline ? f.summary.headline : null;
      return { id: f.id, kind: "forfeit", href: fixtureHref(f.id), headline, tag: words.tag, sentence: words.sentence };
    }
    return f.summary?.headline ? { id: f.id, kind: "result", href: fixtureHref(f.id), headline: f.summary.headline } : { id: f.id, kind: "pending" };
  };
  // home → away → lines (double round-robins stack two lines in a cell). Pairings outside the axis are ignored.
  const cells: Record<string, ResultsGridLine[]> = {};
  for (const f of fixtures) {
    if (!f.home_entrant_id || !f.away_entrant_id) continue;
    if (!axis.has(f.home_entrant_id) || !axis.has(f.away_entrant_id)) continue;
    (cells[`${f.home_entrant_id}:${f.away_entrant_id}`] ??= []).push(lineOf(f));
  }
  return {
    entrantIds,
    names: Object.fromEntries(entrantIds.map((id) => [id, nameOf(id)])),
    logos: entrantLogos ? Object.fromEntries(entrantIds.map((id) => [id, entrantLogos[id] ?? null])) : null,
    cells,
    corner: t(dict, "division.resultsGrid.corner"),
    live: t(dict, "matchesHub.live"),
  };
}

export function ResultsMatrix({ caption, ...rest }: Props) {
  const data = resultsGridData(rest);
  return data === null ? null : <ResultsGrid data={data} caption={caption} />;
}
