// Standings qualification status — the shared marker, cut line, legend and
// popover body (spec 2026-09-22 §5, Option B). Used by BOTH standings tables so
// the division page, the embed, the console and the hub draw the same thing.
// Every string arrives resolved (`buildQualificationView`); nothing here knows
// a locale. The marker is aria-hidden: the status is spoken by the rank
// trigger's own label ("Rank 3, Win 2 and in, show details").
//
// Server-safe (no hooks, no "use client") and type-only against the hub
// schema, so either table — a server component or a client one — can use it.
import type { QualRowT, QualTableT } from "@/server/public-site/competition-hub-schema";

type Kind = QualRowT["status"];

export function QualMarker({ status }: { status: Kind }) {
  if (status === "through") {
    return (
      <span
        aria-hidden="true"
        data-qual-marker="through"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-bold leading-none text-emerald-700"
      >
        ✓
      </span>
    );
  }
  if (status === "out") {
    return (
      <span
        aria-hidden="true"
        data-qual-marker="out"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-bold leading-none text-zinc-500"
      >
        –
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-qual-marker={status}
      className="inline-block h-4 w-4 shrink-0 rounded-full border-2 border-zinc-400 bg-surface"
    />
  );
}

const CUT_CELL = "border-t-2 border-dashed border-accent p-0";

/** A full-width row after place N. The label is sticky so it stays on screen
 *  when the table scrolls sideways inside its region, and it may wrap to two
 *  lines at 320 (spec §5).
 *
 *  `folds`: for a table whose columns fold by breakpoint (the hub's
 *  `table-fixed` table), `colSpan` covers only the columns shown at the
 *  narrowest width, and each folded column gets an empty cell here carrying
 *  that column's own fold class, so the row spans exactly the visible columns
 *  at every width. One `colSpan` over every column is NOT equivalent there: a
 *  row spanning more columns than the header shows makes grid columns the
 *  header never sized, and fixed layout shares the remainder with them —
 *  measured in Chromium at 320, the name column went 88px → 29px. Omitted
 *  (the division page's auto-layout table, which folds nothing): one cell. */
export function QualCutRow({
  colSpan,
  label,
  folds = [],
}: {
  colSpan: number;
  label: string;
  folds?: readonly string[];
}) {
  return (
    <tr data-testid="qual-cut">
      <td colSpan={colSpan} className={CUT_CELL}>
        <span className="sticky left-0 block max-w-[calc(100vw-3rem)] whitespace-normal px-4 py-1.5 text-[11px] font-semibold leading-snug text-accent-strong md:max-w-none">
          {label}
        </span>
      </td>
      {folds.map((fold, i) => (
        <td key={i} className={`${CUT_CELL} ${fold}`} />
      ))}
    </tr>
  );
}

export function QualLegend({ legend }: { legend: QualTableT["legend"] }) {
  return (
    <p
      data-testid="qual-legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[11px] text-ink-muted"
    >
      <span className="inline-flex items-center gap-1">
        <QualMarker status="through" />
        {legend.through}
      </span>
      <span className="inline-flex items-center gap-1">
        <QualMarker status="needs_help" />
        {legend.open}
      </span>
      <span className="inline-flex items-center gap-1">
        <QualMarker status="out" />
        {legend.out}
      </span>
      <span>{legend.hint}</span>
    </p>
  );
}

/** Popover content, in the spec's order: headline, if-you-lose, tie note,
 *  what-if. Spans set `block`, not `<p>`/`<div>`: it renders inside the
 *  popover's panel, which is a `<span>` (phrasing content only). */
export function QualPopoverBody({ qual, tieNote }: { qual: QualRowT | null; tieNote: string | null }) {
  return (
    <span className="block space-y-1.5 text-xs text-zinc-700">
      {qual ? (
        <span data-testid="qual-headline" className="block font-semibold text-ink">
          {qual.headline}
        </span>
      ) : null}
      {qual?.ifYouLose ? (
        <span data-testid="qual-if-lose" className="block">
          {qual.ifYouLose}
        </span>
      ) : null}
      {tieNote ? (
        <span data-testid="qual-tie-note" className="block">
          {tieNote}
        </span>
      ) : null}
      {qual?.whatIf ? (
        <span data-testid="qual-what-if" className="block">
          <span className="block">{qual.whatIf}</span>
          {qual.whatIfAssumption ? (
            <span className="mt-0.5 block text-[11px] italic text-ink-muted">{qual.whatIfAssumption}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
