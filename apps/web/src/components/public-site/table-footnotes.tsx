// W5 app PR B, Task 7 (C6; X-ADJ-1, X-ADJ-4; R24 picks 11 A and 15 A): every note under a league, group or Swiss table, in one
// slot - PR A's departure notes (`WithdrawalFootnotes`, unchanged and still its own component) and the points adjustments ("Marsh
// Lane: −3 points, fielded an ineligible player, 16 Nov 2026."). Always visible, the only form that survives print, export and a
// screen reader. The text is resolved by the caller (`adjustmentNoteText`, lib/points-adjustment-note.ts) - the division page with
// its dictionary, the hub's builder in the org's language - so every surface prints the same words. Nothing for a table with
// neither.
import type { AdjustmentNoteText } from "@/lib/points-adjustment-note";
import type { WithdrawalNoteText } from "@/lib/table-withdrawal-note";
import { WithdrawalFootnotes } from "./withdrawal-footnotes";

export function AdjustmentFootnotes({ items }: { items: readonly AdjustmentNoteText[] }) {
  if (items.length === 0) return null;
  return (
    <ul data-testid="standings-adjustment-notes" className="mt-2 min-w-0 space-y-1 px-1 text-xs leading-relaxed text-ink-muted">
      {items.map((n) => (
        <li key={n.key} data-testid={`standings-adjustment-note-${n.entrantId}`} className="min-w-0 break-words">
          <strong className="font-semibold text-ink">{n.lead}</strong> {n.body}
        </li>
      ))}
    </ul>
  );
}

/** One fragment, so a surface that mounts it in the slot it already gave the departure notes renumbers no `useId` above it. */
export function TableFootnotes({
  withdrawals,
  adjustments,
}: {
  withdrawals: readonly WithdrawalNoteText[];
  adjustments: readonly AdjustmentNoteText[];
}) {
  if (withdrawals.length === 0 && adjustments.length === 0) return null;
  return (
    <>
      <WithdrawalFootnotes items={withdrawals} />
      <AdjustmentFootnotes items={adjustments} />
    </>
  );
}
