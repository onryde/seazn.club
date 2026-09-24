// Server component: MetricSpec-driven standings table (doc 09 §2 — zero
// per-sport table code). Two cells explain themselves through the shared
// client `StandingsPopover`: the rank of a tied row (the snapshot's tieBreak
// trace) and a point/board ratio with a ledger behind it (`ratioNote`). The
// popover is the only client island; everything else still renders here. It
// replaced a native `<details>` that never closed on an outside tap.
//
// Every word is the caller's dictionary's (Task 16 review, I1): the header
// letters and their titles, "Team", and the tie note come from the SAME
// helpers the competition hub's table resolves them with
// (`server/public-site/standings-view.ts`), so the division page, the embed and
// the organiser console print what the hub prints over the same column.
//
// Standings qualification status (spec 2026-09-22 §5, Option B) rides on the
// optional `qualification` prop: a marker beside each rank, a cut line after
// place N, a legend under the box, and the status in the rank's popover —
// which is the SAME popover as the tie note, one per rank cell. Every word is
// the builder's (`buildQualificationView`). Without it the table renders
// exactly as it did before (pinned by a captured golden).
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
import { columnHeader, ratioNote, tieBreakRule } from "@/server/public-site/standings-view";
import type { QualificationView } from "@/server/public-site/qualification-view";
import type { QualRowT } from "@/server/public-site/competition-hub-schema";
import { EntityLogo } from "@/components/ui/entity-logo";
import { StandingsPopover } from "./standings-popover";
import { QualCutRow, QualLegend, QualMarker, QualPopoverBody } from "./qualification-bits";

/**
 * Every way OUT of a competing field, and the chip each one prints.
 *
 * The two are deliberately NOT collapsed into one "Withdrawn" chip. They are
 * different facts — one entrant left, the other was removed — and the product
 * already draws that distinction elsewhere: `entrantStatusStyle` in
 * `components/v2/entrants-panel.tsx` paints a withdrawal grey and a
 * disqualification red in the roster editor. Labelling a disqualified entrant
 * "Withdrawn" on the public board would be worse than the gap it replaced,
 * because it would be wrong rather than merely silent.
 *
 * This is the ONE place that decides which statuses count as departed. The
 * call sites hand over raw statuses and nothing else, so adding a fifth status
 * to the product is an edit here plus a dictionary key — not three page edits
 * that can each be half-done. `standings-withdrawn-and-tiebreak-layer` checks
 * this table against `EntrantStatus` minus `FIELD_ENTRANT_STATUSES`, so a new
 * departure reds there rather than shipping an unmarked row.
 *
 * The test id is per status (`standings-withdrawn`, `standings-disqualified`):
 * one testid for both would make an e2e count blind to exactly the confusion
 * this table exists to prevent.
 */
export const DEPARTED_STATUS_CHIPS = {
  withdrawn: { label: "table.withdrawn", className: "bg-zinc-100 text-zinc-600" },
  disqualified: { label: "table.disqualified", className: "bg-red-100 text-red-600" },
} as const satisfies Record<string, { label: TKey; className: string }>;

type DepartedStatus = keyof typeof DEPARTED_STATUS_CHIPS;

interface Props {
  rows: StandingsRow[];
  metricSpecs: MetricSpecLike[];
  cascade: readonly string[];
  entrantNames: Record<string, string>;
  /** entrant_id → badge URL (v3/03 §5 placement matrix). Omit = no badge
   *  column at all; null values fall back to initials via EntityLogo. */
  entrantLogos?: Record<string, string | null>;
  /** entrant_id → that entrant's own `status`, for EVERY entrant the caller
   *  holds — not a pre-filtered list of the departed. A departed entrant's
   *  played results STAND (the withdrawal or disqualification settles their
   *  remaining matches through the normal ledger and leaves what they actually
   *  played), so the row is carried rather than voided — and this is what lets
   *  it SAY so. `StandingsRow` itself has no status field, so this arrives
   *  beside the rows rather than on them. Omit and nothing is marked.
   *
   *  A status map rather than an id list, on purpose. The first version of this
   *  marking took `withdrawnEntrantIds`, and all three call sites derived it
   *  with `entrants.filter((e) => e.status === "withdrawn")` — so "which
   *  statuses mean this entrant has left" was answered three times, in three
   *  files, and every one of them missed `disqualified`: a disqualified
   *  entrant sat in the public standings ranked among the competing with
   *  nothing whatever to tell her apart (C1, 2026-09-21). Handing over the raw
   *  status moves that judgement here, to `DEPARTED_STATUS_CHIPS`, where it is
   *  made once and can be checked against the product's whole vocabulary. */
  entrantStatuses?: Record<string, string>;
  caption?: string;
  /** The PUBLIC dictionary, in the language the page is read in: the org's on
   *  the public division page and the embed, the viewer's in the console. */
  dict: Dict;
  /** Standings qualification (spec 2026-09-22), from `buildQualificationView`
   *  for THIS table (its stage and pool). Absent or null: the table renders
   *  exactly as before — no marker, no cut line, no legend (golden-pinned). */
  qualification?: QualificationView | null;
}

export function StandingsTable({
  rows,
  metricSpecs,
  cascade,
  entrantNames,
  entrantLogos,
  entrantStatuses,
  caption,
  dict,
  qualification,
}: Props) {
  const msg = (key: TKey, vars?: Record<string, string | number>) => t(dict, key, vars);
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

  // A derived cell prints the engine's text; a ratio with a ledger behind it
  // also opens onto the two totals it divides. `ratioNote` is null for every
  // other derived column and for a row with no ledger ("—"), and null means a
  // plain cell — never a button that explains nothing. `end`: these columns
  // sit at the table's right, so the panel hangs left, inside the scroll box.
  const derivedCell = (row: StandingsRow, key: string) => {
    const text = derivedMetricText(row, key as TiebreakerKey) ?? "—";
    const note = ratioNote(row, key, msg);
    if (note === null) return text;
    return (
      <StandingsPopover
        testid={`standings-ratio-${key}-${row.entrantId}`}
        align="end"
        className="-my-2.5 py-2.5 text-right underline decoration-zinc-300 decoration-dotted underline-offset-4"
        trigger={text}
      >
        {note}
      </StandingsPopover>
    );
  };

  // The snapshot's tie trace, in the page's language — what a tied row's rank
  // explains, whether or not the table has a cut.
  const tieNote = (row: StandingsRow): string | null =>
    row.tieBreak
      ? msg("table.tieBreak", {
          with: row.tieBreak.with.map((id) => entrantNames[id] ?? "—").join(", "),
          rule: tieBreakRule(row.tieBreak.key, msg, row, rows),
        })
      : null;

  // A row with a qualification status: its rank opens ONE popover holding the
  // status headline, what a loss would do, the tie note when the row is tied,
  // and the what-if (spec §5, in that order). The builder names the button
  // ("Rank 2, Win and in, show details"), because the marker beside the chip
  // is aria-hidden and the chip alone says only "2". The hit area is the tie
  // trigger's below: 40px wide from the popover's `min-w-10`, 40px tall from
  // `-my-2.5 py-2.5` over the cell's padding. A tied row keeps its
  // `standings-tie-` test id, so a spec that finds a tie by it still does.
  const qualRank = (row: StandingsRow, qual: QualRowT) => (
    <StandingsPopover
      testid={`standings-${row.tieBreak ? "tie" : "rank"}-${row.entrantId}`}
      ariaLabel={qual.ariaLabel}
      className="-my-2.5 inline-flex items-center gap-1 whitespace-nowrap py-2.5"
      trigger={
        <>
          {rankChip(row.rank)}
          <QualMarker status={qual.status} />
        </>
      }
    >
      <QualPopoverBody qual={qual} tieNote={tieNote(row)} />
    </StandingsPopover>
  );

  const region = (
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
          {/* A FLAT list of rows — each entrant's, then the cut line after
              place N — rather than a Fragment per entrant. With no cut the list
              is exactly the rows it always was, so every row keeps its tree
              position and every popover its `useId`: the no-cut table is
              byte-for-byte what it was before qualification existed. */}
          {ranked.flatMap((row, index) => {
            const qual = qualification?.rows[row.entrantId] ?? null;
            // Never under the last row: there it says nothing, and it would
            // take `tr:last-child` — the upward-opening panel — from the last
            // entrant.
            const cut =
              qualification && index === qualification.table.cutIndex - 1 && index < ranked.length - 1 ? (
                <QualCutRow key="qual-cut" colSpan={2 + columns.length} label={qualification.table.label} />
              ) : null;
            const tr = (
              <tr
                key={row.entrantId}
                data-qual={qual?.status}
                className={`border-b border-zinc-100 last:border-0 ${
                  row.rank === 1 ? "bg-amber-50/60" : ""
                }`}
              >
                {/* Rank column frozen inside the scroll container (v3/02 §3.3)
                    — solid bg so scrolled columns pass underneath, not through.

                    `has-[[data-open]]:z-20` is what stops the tie-break
                    popover being painted over by the rows BELOW it. Every one of
                    these cells is `z-10`, and an open panel is trapped in its
                    own cell's stacking context, so however high the panel's own
                    z-index it tied with the sticky cell of the next row and lost
                    on DOM order: the next rank chip punched through the
                    popover's left edge, and the row after that covered its
                    bottom-left corner. Raising the CELL — not the panel — is the
                    fix, because the comparison happens between the cells'
                    stacking contexts, not between the panel and its cousins.
                    Measured with `elementFromPoint` on every row, before and
                    after. `data-open` is `StandingsPopover`'s open-state mark
                    (the `<details open>` it replaced was the old one).

                    The LAST row's panel opens UPWARD — the popover's own
                    `[tr:last-child_&]` classes, because the `overflow-x-auto`
                    box above clips a panel hanging below the final row, and
                    clipping happens before stacking (measured at 1280: panel
                    bottom 704 against a container bottom of 679). Any other
                    row whose panel would still cross that bottom edge is
                    flipped the same way, measured on open (`data-side`). */}
                <td
                  className={`sticky left-0 z-10 py-2.5 pl-4 pr-2 tabular-nums has-[[data-open]]:z-20 ${
                    row.rank === 1 ? "bg-amber-50" : "bg-surface"
                  }`}
                >
                  {qual ? (
                    qualRank(row, qual)
                  ) : row.tieBreak ? (
                    // `-my-2.5 py-2.5`: the button's hit area takes in the cell's
                    // vertical padding (a 40px band, not the 20px chip) without
                    // making the row any taller; a row a wrapped name has made
                    // taller still has its top and bottom beyond it. Its 40px of
                    // width is the popover's own `min-w-10`, inside its box. The
                    // STRETCH is vertical only —
                    // a horizontal overhang (`-mx-1 px-1`, tried first) widens
                    // the button past its own box, which the public board's
                    // clip scan (`overflowingIn`) rightly reads as clipped
                    // content at 320.
                    <StandingsPopover
                      testid={`standings-tie-${row.entrantId}`}
                      className="-my-2.5 inline-flex items-start whitespace-nowrap py-2.5"
                      trigger={
                        <>
                          {rankChip(row.rank)}
                          <span aria-hidden="true" className="text-[10px] text-accent">*</span>
                        </>
                      }
                    >
                      {tieNote(row)}
                    </StandingsPopover>
                  ) : (
                    rankChip(row.rank)
                  )}
                </td>
                {/* An Out row reads muted, as its marker does (spec §5). */}
                {/* Long names (P4 option C, owner-approved 2026-09-24): below
                    `md` the name is a flex row — crest, then the name clamped
                    to TWO lines with an ellipsis, the full name in `title` —
                    over a 7.5rem floor, so auto layout cannot squeeze it to
                    one word a line (a 43-character club took five). Every
                    class here is `max-md:`, so from `md` up the cell draws
                    exactly as before. `min-w-0` down the chain lets the
                    clamped span shrink inside the flex row. The name opts
                    into browser hyphenation (ruling (a), 2026-09-24, as the
                    hub's name does), by the rules of `<html lang>` — the
                    org's locale, set by the org layout. Safari (WebKit)
                    breaks "North- / gate"; Chromium never hyphenates a word
                    that starts with a capital, so there `break-words` stays
                    the fallback and a long word still breaks at a letter. */}
                <th
                  scope="row"
                  className={`py-2.5 pr-3 text-left font-medium max-md:min-w-[7.5rem] ${qual?.status === "out" ? "text-ink-muted" : "text-ink"}`}
                >
                  <span className="max-md:flex max-md:min-w-0 max-md:items-center">
                    {entrantLogos && (
                      <EntityLogo
                        src={entrantLogos[row.entrantId]}
                        name={entrantNames[row.entrantId] ?? ""}
                        size={20}
                        className="mr-2"
                      />
                    )}
                    <span
                      className="max-md:line-clamp-2 max-md:min-w-0 max-md:break-words max-md:hyphens-auto"
                      title={entrantNames[row.entrantId] ?? row.entrantId}
                    >
                      {entrantNames[row.entrantId] ?? row.entrantId}
                    </span>
                    {(() => {
                      const status = entrantStatuses?.[row.entrantId] ?? "";
                      const chip = DEPARTED_STATUS_CHIPS[status as DepartedStatus];
                      // An unknown or competing status is NOT a chip: this prop
                      // carries the whole field, so marking on mere presence would
                      // brand every entrant in the table.
                      if (!chip) return null;
                      return (
                        <span
                          data-testid={`standings-${status}`}
                          className={`ml-2 shrink-0 rounded-full px-2 py-0.5 align-middle text-[10px] font-medium ${chip.className}`}
                        >
                          {msg(chip.label)}
                        </span>
                      );
                    })()}
                  </span>
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
                      ? derivedCell(row, col.key)
                      : col.kind === "structural"
                        ? formatMetric(row[col.key as "played" | "won" | "drawn" | "lost" | "points"])
                        : formatMetric(row.metrics[col.key], col.decimals)}
                  </td>
                ))}
              </tr>
            );
            return cut ? [tr, cut] : [tr];
          })}
        </tbody>
      </table>
    </div>
  );

  if (!qualification) return region;
  // The legend sits under the box, outside its sideways scroll, so it wraps
  // to the page's width rather than the table's.
  return (
    <div>
      {region}
      <QualLegend legend={qualification.table.legend} />
    </div>
  );
}
