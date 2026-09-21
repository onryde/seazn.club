// Server component: MetricSpec-driven standings table (doc 09 §2 — zero
// per-sport table code). Tie explanations render as a <details> popover from
// the snapshot's tieBreak trace: no client JS.
//
// Every word is the caller's dictionary's (Task 16 review, I1): the header
// letters and their titles, "Team", and the tie note come from the SAME
// helpers the competition hub's table resolves them with
// (`server/public-site/standings-view.ts`), so the division page, the embed and
// the organiser console print what the hub prints over the same column.
import {
  DERIVED_METRICS,
  derivedMetricText,
  type StandingsRow,
} from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import {
  standingsColumns,
  formatMetric,
  type MetricSpecLike,
} from "@/lib/public-site";
import type { Dict } from "@/lib/i18n-constants";
import { t, type TKey } from "@/lib/i18n-runtime";
import { columnHeader, tieBreakRule } from "@/server/public-site/standings-view";
import { EntityLogo } from "@/components/ui/entity-logo";

interface Props {
  rows: StandingsRow[];
  metricSpecs: MetricSpecLike[];
  cascade: readonly string[];
  entrantNames: Record<string, string>;
  /** entrant_id → badge URL (v3/03 §5 placement matrix). Omit = no badge
   *  column at all; null values fall back to initials via EntityLogo. */
  entrantLogos?: Record<string, string | null>;
  /** Entrant ids that are no longer in the field. A withdrawn entrant's played
   *  results STAND — the withdrawal settles their remaining matches through
   *  the normal ledger and leaves what they actually played — so the row is
   *  carried rather than voided. Until 2026-09-21 it was carried with nothing
   *  to tell it apart: a withdrawn player sat at rank 4 with 2 points, styled
   *  exactly like the people still competing (found by driving the product).
   *  `StandingsRow` itself has no status field, so this arrives beside the
   *  rows rather than on them. Omit and nothing is marked. */
  withdrawnEntrantIds?: readonly string[];
  caption?: string;
  /** The PUBLIC dictionary, in the language the page is read in: the org's on
   *  the public division page and the embed, the viewer's in the console. */
  dict: Dict;
}

export function StandingsTable({
  rows,
  metricSpecs,
  cascade,
  entrantNames,
  entrantLogos,
  withdrawnEntrantIds,
  caption,
  dict,
}: Props) {
  const msg = (key: TKey, vars?: Record<string, string | number>) => t(dict, key, vars);
  const withdrawn = new Set(withdrawnEntrantIds ?? []);
  const columns = standingsColumns(metricSpecs, cascade, rows, DERIVED_METRICS);
  const ranked = [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  // Podium chips are fixed vocabulary (gold/silver/bronze) — deliberately NOT
  // org-themeable, so a red-branded org still reads gold as first place.
  const medal: Record<number, string> = {
    1: "bg-amber-300 text-amber-950",
    2: "bg-slate-300 text-slate-900",
    3: "bg-orange-300 text-orange-950",
  };
  // Fixed-size cell for every rank so podium chips and plain numbers line up.
  const rankChip = (rank: number | undefined) => (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full font-display text-[12px] font-bold ${
        rank && medal[rank] ? medal[rank] : "text-ink-muted"
      }`}
    >
      {rank}
    </span>
  );

  return (
    // `relative`: the containing block for the `.sr-only` column words in the
    // header. Left static, their containing block was `<body>`, outside this
    // box's `overflow-x` clip, and a table wider than a phone scrolled the
    // whole PAGE sideways with no visible culprit (T17 HB9c, 80px at 320).
    // A named, focusable region: a keyboard user scrolls to the hidden columns
    // only through `tabIndex` (final review B m3), as on the hub's table.
    <div
      role="region"
      tabIndex={0}
      aria-label={caption ? msg("table.regionCaptioned", { caption }) : msg("table.region")}
      className="relative overflow-x-auto rounded-xl border border-zinc-200/80 bg-surface shadow-sm"
    >
      <table className="w-full text-sm">
        {caption ? (
          <caption className="px-4 pb-1 pt-3 text-left font-display text-lg font-semibold text-ink">
            {caption}
          </caption>
        ) : null}
        <thead>
          <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wider text-ink-muted">
            <th scope="col" className="sticky left-0 z-10 w-12 bg-surface py-2.5 pl-4 pr-2 font-semibold">#</th>
            <th scope="col" className="py-2.5 pr-3 font-semibold">{msg("table.team")}</th>
            {columns.map((col) => {
              // The letters are what fits; the word is what a hover and a
              // screen reader get — a `<th>`'s text wins its accessible name,
              // so the word rides as sr-only text and the letters are hidden.
              const { abbr, title } = columnHeader(col, msg);
              return (
                <th key={col.key} scope="col" title={title} className="px-2.5 py-2.5 text-right font-semibold last:pr-4">
                  <span className="sr-only">{title}</span>
                  <span aria-hidden="true">{abbr}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr
              key={row.entrantId}
              className={`border-b border-zinc-100 last:border-0 ${
                row.rank === 1 ? "bg-amber-50/60" : ""
              }`}
            >
              {/* Rank column frozen inside the scroll container (v3/02 §3.3)
                  — solid bg so scrolled columns pass underneath, not through.

                  `has-[details[open]]:z-30` is what stops the tie-break
                  popover being painted over by the rows BELOW it. Every one of
                  these cells is `z-10`, so an open tooltip (also `z-10`, and
                  trapped in its own cell's stacking context) tied with the
                  sticky cell of the next row and lost on DOM order: the next
                  rank chip punched through the popover's left edge, and the
                  row after that covered its bottom-left corner. Raising the
                  CELL — not the tooltip — is the fix, because the comparison
                  happens between the cells' stacking contexts, not between the
                  tooltip and its cousins. Measured with `elementFromPoint` on
                  every row, before and after. */}
              <td
                className={`sticky left-0 z-10 py-2.5 pl-4 pr-2 tabular-nums has-[details[open]]:z-30 ${
                  row.rank === 1 ? "bg-amber-50" : "bg-surface"
                }`}
              >
                {row.tieBreak ? (
                  <details className="relative inline-block">
                    <summary className="inline-flex cursor-help list-none items-start whitespace-nowrap">
                      {rankChip(row.rank)}
                      <span className="text-[10px] text-accent">*</span>
                    </summary>
                    {/* The LAST row opens its explanation UPWARD. The table
                        sits in a `relative overflow-x-auto` box, and an
                        `overflow-x: auto` computes `overflow-y: auto` too, so
                        a popover hanging below the final row is CLIPPED by
                        that box, not merely overlapped — measured on the live
                        page at 1280: tooltip bottom 704 against a container
                        bottom of 679, three of its four lines cut off. Raising
                        the cell (above) cannot help, because clipping happens
                        before stacking. Flipping it up keeps it inside the
                        same box, where the raise then wins. */}
                    <p
                      role="tooltip"
                      className="absolute left-0 z-10 mt-1 w-56 rounded-lg border border-zinc-200 bg-surface p-2 text-xs text-zinc-700 shadow-lg [tr:last-child_&]:bottom-full [tr:last-child_&]:top-auto [tr:last-child_&]:mb-1 [tr:last-child_&]:mt-0"
                    >
                      {msg("table.tieBreak", {
                        with: row.tieBreak.with.map((id) => entrantNames[id] ?? "—").join(", "),
                        rule: tieBreakRule(row.tieBreak.key, msg),
                      })}
                    </p>
                  </details>
                ) : (
                  rankChip(row.rank)
                )}
              </td>
              <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink">
                {entrantLogos && (
                  <EntityLogo
                    src={entrantLogos[row.entrantId]}
                    name={entrantNames[row.entrantId] ?? ""}
                    size={20}
                    className="mr-2"
                  />
                )}
                {entrantNames[row.entrantId] ?? row.entrantId}
                {withdrawn.has(row.entrantId) && (
                  <span
                    data-testid="standings-withdrawn"
                    className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 align-middle text-[10px] font-medium text-zinc-600"
                  >
                    {msg("table.withdrawn")}
                  </span>
                )}
              </th>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-2.5 py-2.5 text-right tabular-nums last:pr-4 ${
                    col.key === "points"
                      ? "font-display text-base font-bold text-accent-strong"
                      : "text-zinc-600"
                  }`}
                >
                  {col.kind === "derived"
                    ? (derivedMetricText(row, col.key as TiebreakerKey) ?? "—")
                    : col.kind === "structural"
                      ? formatMetric(row[col.key as "played" | "won" | "drawn" | "lost" | "points"])
                      : formatMetric(row.metrics[col.key], col.decimals)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
