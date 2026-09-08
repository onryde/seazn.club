"use client";
// Spectator surface W2, Task 2 — the phone-composed standings table.
//
// `"use client"` for ONE reason: the long tail's disclosure is component
// state. Every row and every column is rendered on the SERVER first, so a
// spectator with no JS still gets the whole table from `md` up and the
// compact P W L Pts set on a phone — the button is the only thing that needs
// the client, and its absence degrades to "you see the four columns that
// matter", never to a blank tab.
//
// This is the SPECTATOR table. `standings-table.tsx` next door is the
// organiser console's and the embed's, and stays exactly as it is: it renders
// a `StandingsRow[]` straight from the engine, this one renders an
// already-formatted `TableViewT` and holds no sport vocabulary, no number
// formatting and no locale of its own. `server/public-site/standings-view.ts`
// owns all three.
//
// Composition rules carried from W1's `stat-table.tsx`, all three learned the
// expensive way there:
//
//  * `table-fixed` with an EXPLICIT width on every numeric column. Under the
//    default AUTO layout a `<td>` sizes to its content and `truncate` just
//    overflows, so the name column can never be made to clip. The name column
//    carries NO width utility at all and takes whatever the numeric columns
//    do not claim.
//  * Tailwind is border-box, so a column's CONTENT width is its `w-*` minus
//    its horizontal padding — `px-0.5` (2px a side), not `px-2`.
//  * A `<th>`'s TEXT content wins its accessible name, so a localised `title`
//    attribute alone is announced to nobody and is a hover affordance a phone
//    does not have. Each header ships the localised word as `sr-only` text
//    with the notation `aria-hidden` — a fold out of the accessibility tree,
//    never a removal.
//
// AGENTS.md #23 — the scroll region owes a `tabindex`, a role and an
// accessible name, and `tabindex` cannot be varied by a media query, so all
// three are unconditional. The container is `overflow-x-auto` at every width
// rather than `overflow-hidden` when collapsed: an overflow whose content is
// REACHABLE is a feature, one inside an `overflow-hidden` box is a defect,
// and a wide long tail on a narrow desktop card is exactly that case.
import Link from "next/link";
import { useState } from "react";
import { EntityLogo } from "@/components/ui/entity-logo";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { TableColumnT, TableViewT } from "@/server/public-site/competition-hub-schema";

export interface StandingsTableViewProps {
  view: TableViewT;
  dict: PublicDict;
  /** Prefix for every testid this table emits — `${testid}-row-<entrantId>`,
   *  `${testid}-more`, `${testid}-full`, `${testid}-empty`, `${testid}-scroll`.
   *  A division can publish an overall table AND one per pool on the same
   *  screen, so an entrant appears in two tables at once: a bare
   *  `mh-table-row-<id>` literal would emit duplicate ids. Nothing here is
   *  allowed to name itself outside this prefix. */
  testid: string;
  /** Render only the first N rows (the overview tab's teaser). Omitted =
   *  every row. */
  preview?: number;
  showFullLink?: boolean;
}

// Podium chips are fixed vocabulary (gold/silver/bronze) — deliberately NOT
// org-themeable, so a red-branded org still reads gold as first place. Same
// three classes `standings-table.tsx` uses; the console and the spectator
// surface must not disagree about what first place looks like.
const MEDAL: Record<number, string> = {
  1: "bg-amber-300 text-amber-950",
  2: "bg-slate-300 text-slate-900",
  3: "bg-orange-300 text-orange-950",
};

/** Width class for a numeric column, from the widest thing it has to hold —
 *  its own notation or any of its cells. A single class for every column
 *  either wastes the name column's remainder or wraps a derived value: "P"
 *  over one digit needs 32px, a signed NRR ("+1.000") needs 56. Literal class
 *  names so Tailwind's scanner sees all four. */
function columnWidth(chars: number): string {
  if (chars <= 2) return "w-8";
  if (chars <= 4) return "w-11";
  if (chars <= 6) return "w-14";
  return "w-16";
}

export function StandingsTableView({
  view,
  dict,
  testid,
  preview,
  showFullLink = true,
}: StandingsTableViewProps) {
  const [expanded, setExpanded] = useState(false);

  const rows = preview === undefined ? view.rows : view.rows.slice(0, preview);
  const hasLongTail = view.columns.some((c) => !c.compact);
  const widths = view.columns.map((c, i) =>
    columnWidth(Math.max(c.abbr.length, ...view.rows.map((r) => (r.cells[i] ?? "").length))),
  );
  // A compact column is always shown. A long-tail one folds below `md` until
  // the disclosure is opened; from `md` up nothing folds, ever.
  const foldCls = (c: TableColumnT) => (c.compact || expanded ? "" : " max-md:hidden");

  const rankChip = (rank: number | null) => (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full font-display text-[12px] font-bold ${
        rank !== null && MEDAL[rank] ? MEDAL[rank] : "text-ink-muted"
      }`}
    >
      {rank ?? ""}
    </span>
  );

  return (
    <section data-testid={testid} className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate font-display text-lg font-semibold text-ink">
          {view.caption}
        </h3>
        {showFullLink ? (
          <Link
            data-testid={`${testid}-full`}
            href={view.fullHref}
            className="shrink-0 text-xs font-medium uppercase tracking-wide text-accent-strong hover:underline"
          >
            {t(dict, "table.fullDivision")}
          </Link>
        ) : null}
      </div>

      {view.rows.length === 0 ? (
        <p
          data-testid={`${testid}-empty`}
          className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted"
        >
          {t(dict, "table.empty")}
        </p>
      ) : (
        <>
          <div
            id={`${testid}-scroll`}
            role="region"
            tabIndex={0}
            aria-label={view.caption}
            className="overflow-x-auto rounded-xl border border-zinc-200/80 bg-surface shadow-sm"
          >
            <table className="w-full table-fixed text-sm tabular-nums">
              <caption className="sr-only">{view.caption}</caption>
              <thead>
                <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-ink-muted">
                  <th scope="col" className="w-8 py-2 pl-3 text-left font-semibold">
                    <span className="sr-only">{t(dict, "table.col.rank")}</span>
                    <span aria-hidden>#</span>
                  </th>
                  <th scope="col" className="py-2 pr-2 text-left font-semibold">
                    {t(dict, "table.team")}
                  </th>
                  {view.columns.map((c, i) => (
                    <th
                      key={c.key}
                      scope="col"
                      data-col={c.key}
                      title={c.title}
                      className={`${widths[i]} px-0.5 py-2 text-right font-semibold${foldCls(c)}`}
                    >
                      <span className="sr-only">{c.title}</span>
                      <span aria-hidden>{c.abbr}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.entrantId}
                    data-testid={`${testid}-row-${r.entrantId}`}
                    data-champion={r.champion ? "true" : "false"}
                    className={`border-b border-zinc-100 last:border-0 ${
                      r.rank === 1 ? "bg-amber-50/60" : ""
                    }`}
                  >
                    <td className="py-2 pl-3 tabular-nums">
                      {rankChip(r.rank)}
                      {r.tieBreakText ? (
                        <span title={r.tieBreakText} className="text-[10px] text-accent">
                          <span aria-hidden>*</span>
                          <span className="sr-only">{r.tieBreakText}</span>
                        </span>
                      ) : null}
                    </td>
                    {/* The name IS the row's header: without `scope="row"` a
                        screen reader reading "6" out of the Pts column cannot
                        say whose 6 it is. */}
                    <th scope="row" className="py-2 pr-2 text-left font-medium text-ink">
                      <span className="flex min-w-0 items-center gap-2">
                        <EntityLogo src={r.badgeUrl} name={r.name} size={20} />
                        {/* `truncate` needs `min-w-0` on the whole ancestor
                            chain, not just this span. */}
                        <span className="block min-w-0 truncate" title={r.name}>
                          {r.name}
                        </span>
                      </span>
                    </th>
                    {view.columns.map((c, i) => (
                      <td
                        key={c.key}
                        data-col={c.key}
                        className={`px-0.5 py-2 text-right ${
                          c.key === "points"
                            ? "font-display text-base font-bold text-accent-strong"
                            : "text-zinc-600"
                        }${foldCls(c)}`}
                      >
                        {r.cells[i]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasLongTail ? (
            <button
              type="button"
              data-testid={`${testid}-more`}
              aria-expanded={expanded}
              aria-controls={`${testid}-scroll`}
              onClick={() => setExpanded((x) => !x)}
              className="min-h-11 w-full rounded-lg border border-zinc-200/80 bg-surface px-3 text-sm font-medium text-accent-strong md:hidden"
            >
              {t(dict, expanded ? "table.fewer" : "table.more")}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
