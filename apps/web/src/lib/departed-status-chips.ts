// Every way OUT of a competing field, and the chip each one prints - moved here from `components/public-site/standings-table.tsx`
// (W5 T20, ST-G20) so the hub's CLIENT table (`standings-table-view.tsx`) can read the one vocabulary: `standings-table.tsx` pulls
// in server-only modules and cannot be imported from a client component. `standings-table.tsx` re-exports `DEPARTED_STATUS_CHIPS`,
// so every existing importer is unchanged; this stays the ONE place that decides which statuses count as departed.
import type { TKey } from "@/lib/i18n-runtime";

/** The departed vocabulary as a tuple, so a wire schema (`TableRow.status`) can be built from it instead of restating it. */
export const DEPARTED_STATUS_KEYS = ["withdrawn", "disqualified"] as const;

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
} as const satisfies Record<(typeof DEPARTED_STATUS_KEYS)[number], { label: TKey; className: string }>;

export type DepartedStatus = keyof typeof DEPARTED_STATUS_CHIPS;
