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
// Review round 1 — THE GEOMETRY, three fixes that no test in this repo can
// witness (`apps/web` vitest is `environment: "node"`: no DOM, no cascade, no
// layout). Fixed by construction; the arithmetic below is asserted, the PAINT
// is owed by the mounting task's 320/360/390 pass.
//
//  * THE NAME COLUMN HAD NO FLOOR. Under fixed layout an auto column takes the
//    remainder, and the table only grows past `w-full` once the EXPLICIT
//    widths alone exceed the container — so the name column reaches 0 before
//    `overflow-x-auto` ever engages. A football division with the disclosure
//    open at 320 was rank 32 + 7×32 + 44 = 300px against a ~286px card: every
//    name clipped to nothing, with 14px of scroll to show for it. The table
//    now carries an explicit `min-width` = rank + `NAME_MIN_PX` + the columns
//    actually DISPLAYED, so the remainder can never fall below the floor and
//    the region scrolls instead of crushing. It is computed per state rather
//    than once because below `md` the folded columns are `display:none` and
//    contribute nothing — a single unconditional value would either force a
//    rail on a collapsed phone or under-protect the expanded one.
//  * THE RANK COLUMN COULD NOT HOLD ITS OWN CONTENTS. `w-8` (32px) minus
//    `pl-3` (12px) left exactly the 20px of the `h-5 w-5` chip — zero slack —
//    and the tie-break `*` beside it is an adjacent JSX expression with no
//    whitespace node between them, so it had no break opportunity and
//    overflowed into the name cell. That is the same trap
//    `stat-table.tsx:26-35` documents. The cell is now a flex row with real
//    gap, and the column is sized for chip + marker together.
//  * THE CHIP COULD NOT PAINT THREE DIGITS. `buildTableView` deliberately
//    sorts rank ≥ 100 correctly (`UNRANKED = MAX_SAFE_INTEGER`); a fixed
//    `w-5` chip then clipped it. `min-w-5 px-1` keeps the circle for one and
//    two digits and grows to a pill for three.
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

/** Width for a numeric column, from the widest thing it has to hold — its own
 *  notation or any of its cells. A single class for every column either wastes
 *  the name column's remainder or wraps a derived value: "P" over one digit
 *  needs 32px, a signed NRR ("+1.000") needs 56.
 *
 *  The class and its pixel value travel TOGETHER because the table's own
 *  `min-width` is the sum of them: two declarations of the same number are two
 *  things to drift, and the drift would be silent (a `min-width` that no
 *  longer matches the columns crushes the name column again). Literal class
 *  names so Tailwind's scanner sees all four. */
const COLUMN_SIZES = [
  { upTo: 2, cls: "w-8", px: 32 },
  { upTo: 4, cls: "w-11", px: 44 },
  { upTo: 6, cls: "w-14", px: 56 },
  { upTo: Number.POSITIVE_INFINITY, cls: "w-16", px: 64 },
] as const;

function columnSize(chars: number): (typeof COLUMN_SIZES)[number] {
  return COLUMN_SIZES.find((s) => chars <= s.upTo) ?? COLUMN_SIZES[COLUMN_SIZES.length - 1]!;
}

/** The rank column: `w-12` (48px) less `pl-2` (8px) = 40px of content box, for
 *  a three-digit chip (~29px) plus the tie-break marker (~6px) side by side. */
const RANK_PX = 48;

/** The narrowest the name column may ever be. 96px holds the 20px crest, its
 *  gap and ~7 characters before the ellipsis — enough for `truncate` to do its
 *  job at 320 rather than clipping to nothing. Anything wider pushes the
 *  COLLAPSED phone table (48 + 96 + 32 + 32 + 32 + 44 = 284px) past a ~286px
 *  card and puts a rail under the compact set, which is the one thing the fold
 *  exists to prevent. */
const NAME_MIN_PX = 96;

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
  const sizes = view.columns.map((c, i) =>
    columnSize(Math.max(c.abbr.length, ...view.rows.map((r) => (r.cells[i] ?? "").length))),
  );
  // A compact column is always shown. A long-tail one folds below `md` until
  // the disclosure is opened; from `md` up nothing folds, ever.
  const shown = (c: TableColumnT) => c.compact || expanded;
  const foldCls = (c: TableColumnT) => (shown(c) ? "" : " max-md:hidden");
  // The floor described at the top of the file: rank + name + whatever is
  // actually painted right now. A folded column is `display:none` and claims
  // nothing, so it is excluded — which is what keeps the collapsed phone off a
  // rail while still guaranteeing the name column its 96px when expanded.
  const minTableWidth =
    RANK_PX +
    NAME_MIN_PX +
    view.columns.reduce((total, c, i) => total + (shown(c) ? sizes[i]!.px : 0), 0);

  const rankChip = (rank: number | null) => (
    <span
      className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 font-display text-[12px] font-bold ${
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

      {/* Round 1 fix 6: the SLICED rows decide, not `view.rows` — a
          `preview={0}` computed by a caller used to paint a header row over
          nothing instead of stating the empty case. */}
      {rows.length === 0 ? (
        <p
          data-testid={`${testid}-empty`}
          className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted"
        >
          {t(dict, "table.empty")}
        </p>
      ) : (
        <>
          {/* Round 1 fix 4: the region carries BOTH — the `id` because
              `aria-controls` needs one, and a `data-testid` because the
              downstream tasks were briefed on `${testid}-scroll` as an emitted
              testid. `role`, `tabIndex` and `aria-label` stay unconditional:
              `tabindex` cannot follow a media query (AGENTS.md #23). */}
          <div
            data-testid={`${testid}-scroll`}
            id={`${testid}-scroll`}
            role="region"
            tabIndex={0}
            aria-label={view.caption}
            className="overflow-x-auto rounded-xl border border-zinc-200/80 bg-surface shadow-sm"
          >
            <table
              className="w-full table-fixed text-sm tabular-nums"
              style={{ minWidth: `${minTableWidth}px` }}
            >
              <caption className="sr-only">{view.caption}</caption>
              <thead>
                <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-ink-muted">
                  <th scope="col" data-col="rank" className="w-12 py-2 pl-2 text-left font-semibold">
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
                      className={`${sizes[i]!.cls} px-0.5 py-2 text-right font-semibold${foldCls(c)}`}
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
                    {/* A flex row, not two adjacent JSX expressions: JSX
                        strips the newline between them, so the marker had no
                        break opportunity and overflowed into the name cell on
                        every tied row. The gap is real box, and the column is
                        sized for both together. */}
                    <td className="py-2 pl-2 align-middle tabular-nums">
                      <span className="flex items-center gap-px">
                        {rankChip(r.rank)}
                        {r.tieBreakText ? (
                          <span
                            title={r.tieBreakText}
                            className="shrink-0 text-[10px] leading-none text-accent"
                          >
                            <span aria-hidden>*</span>
                            <span className="sr-only">{r.tieBreakText}</span>
                          </span>
                        ) : null}
                      </span>
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
