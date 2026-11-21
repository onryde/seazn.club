"use client";
// The round-robin results grid's table and its disclosure (W5 B4, stress S4). The grid is n x n cells, so a 500-entrant Swiss
// put 249,500 cells - 87 MB of HTML, 17 s to first byte - into every load of its division page, open or not. The page now
// sends only what the cells are made of (`ResultsGridData`: the axis and one line per played pairing, built on the server
// by `resultsGridData`, results-matrix.tsx), and the table is drawn in the browser the first time its disclosure opens.
// Closed, the disclosure is the same <summary> it always was; open, the table is the same markup `ResultsMatrix` drew.
//
// Client-safe imports only: everything that needs the dictionary or the forfeit ledger was resolved into strings server-side.
import Link from "next/link";
import { useCallback, useState } from "react";
import { EntityLogo } from "@/components/ui/entity-logo";
import { ForfeitTagChip } from "./forfeit-tag-chip";

/** One line in a cell, decided on the server: a live dot, a credited forfeit (its tag and sentence, with its headline unless
 *  nobody was credited), a result's headline, or a pairing not yet played. */
export type ResultsGridLine =
  | { id: string; kind: "live"; href: string }
  | { id: string; kind: "forfeit"; href: string; headline: string | null; tag: string; sentence: string }
  | { id: string; kind: "result"; href: string; headline: string }
  | { id: string; kind: "pending" };

export interface ResultsGridData {
  /** Row and column order: the standings rank order. */
  entrantIds: string[];
  /** The axis' names, and only theirs. */
  names: Record<string, string>;
  /** The axis' badges, or null where the surface shows initials. */
  logos: Record<string, string | null> | null;
  /** `home:away` -> its lines, for the pairings that hold one; a pairing absent here is an empty cell. */
  cells: Record<string, ResultsGridLine[]>;
  /** The corner cell and the live dot's accessible name, in the page's language. */
  corner: string;
  live: string;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function ResultsGrid({ data, caption }: { data: ResultsGridData; caption?: string }) {
  const { entrantIds, names, logos, cells } = data;
  const nameOf = (id: string) => names[id] ?? "?";
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200/80 bg-surface shadow-sm" data-results-matrix>
      <table className="w-full text-sm">
        {caption ? <caption className="px-4 py-2.5 text-left font-display text-sm font-semibold text-ink">{caption}</caption> : null}
        <thead>
          <tr className="border-b border-zinc-200/80 text-xs text-ink-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {data.corner}
            </th>
            {entrantIds.map((id) => (
              <th key={id} scope="col" title={nameOf(id)} className="px-2 py-2 text-center font-medium">
                {logos ? (
                  <span className="inline-flex items-center justify-center">
                    <EntityLogo src={logos[id] ?? null} name={nameOf(id)} size={20} />
                  </span>
                ) : (
                  initials(nameOf(id))
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entrantIds.map((rowId) => (
            <tr key={rowId} className="border-b border-zinc-100 last:border-0">
              <th scope="row" className="max-w-44 truncate px-3 py-2 text-left font-medium text-ink">
                <span className="flex items-center gap-2">
                  {logos ? <EntityLogo src={logos[rowId] ?? null} name={nameOf(rowId)} size={20} /> : null}
                  <span className="truncate">{nameOf(rowId)}</span>
                </span>
              </th>
              {entrantIds.map((colId) => {
                if (rowId === colId) {
                  return (
                    <td key={colId} aria-hidden className="bg-zinc-100/70 px-2 py-2 text-center">
                      <span className="text-zinc-300">—</span>
                    </td>
                  );
                }
                const cell = cells[`${rowId}:${colId}`] ?? [];
                return (
                  <td key={colId} className="px-2 py-2 text-center tabular-nums">
                    {cell.length === 0 ? (
                      <span className="text-zinc-300">·</span>
                    ) : (
                      <span className="flex flex-col items-center gap-0.5">
                        {cell.map((line) =>
                          line.kind === "live" ? (
                            <Link key={line.id} href={line.href} aria-label={data.live}>
                              <span className="animate-live-pulse inline-block h-2 w-2 rounded-full bg-emerald-500" />
                            </Link>
                          ) : line.kind === "forfeit" ? (
                            // A credited result: its headline and its tag; a double walkover credits nobody, so its
                            // 0 — 0 is not shown — the tag alone says what happened.
                            <Link
                              key={line.id}
                              href={line.href}
                              className="inline-flex items-center gap-1 font-display text-[13px] font-semibold text-accent-strong hover:underline"
                            >
                              {line.headline}
                              <ForfeitTagChip tag={line.tag} sentence={line.sentence} testId="results-matrix-forfeit-tag" />
                            </Link>
                          ) : line.kind === "result" ? (
                            <Link
                              key={line.id}
                              href={line.href}
                              className="font-display text-[13px] font-semibold text-accent-strong hover:underline"
                            >
                              {line.headline}
                            </Link>
                          ) : (
                            <span key={line.id} className="text-zinc-300">
                              ·
                            </span>
                          ),
                        )}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The grid behind its disclosure: nothing of the table is in the page until the organiser or spectator opens it, and once
 *  drawn it stays drawn (closing hides it, as any <details> does). The summary is the page's own, unchanged: its label and
 *  classes come from the page (the public page's carries the 44px tap floor).
 *
 *  B4 review I-3: a <details> opens natively, before React is in the page, and React attaches its `toggle` listener only at
 *  hydration (`toggle` is not an event React replays) - so a tap in the window between first paint and hydration, which on these
 *  multi-megabyte pages is long on a phone, opened a disclosure React never heard of, empty until closed and opened again. The
 *  ref callback reads the element's own `open` at the moment React takes it over (hydration's commit, before the first paint
 *  React makes), so an open that happened before is drawn then; `onToggle` covers every open after. A ref callback, not a mount
 *  effect: it runs in the same commit with the element in hand, and it is not the effect-sets-state pattern the lint warns on.
 *  Stable (`useCallback`), so it runs once, at mount, and never again on a re-render. */
export function ResultsGridDisclosure({
  data,
  label,
  summaryClassName,
  noScript,
}: {
  data: ResultsGridData;
  label: string;
  summaryClassName: string;
  /** B4 review m-11: what the disclosure says with scripts off (it still opens natively, and the table is drawn by script): that
   *  the grid needs JavaScript, and which tab lists the same results. The page's own sentence, in its language. */
  noScript: string;
}) {
  const [drawn, setDrawn] = useState(false);
  const openedBeforeHydration = useCallback((el: HTMLDetailsElement | null) => {
    if (el?.open) setDrawn(true);
  }, []);
  return (
    <details ref={openedBeforeHydration} data-results-grid onToggle={(e) => (e.currentTarget.open ? setDrawn(true) : undefined)}>
      <summary className={summaryClassName}>{label}</summary>
      <noscript>
        <p className="mt-2 text-xs">{noScript}</p>
      </noscript>
      {drawn ? (
        <div className="mt-2">
          <ResultsGrid data={data} />
        </div>
      ) : null}
    </details>
  );
}
