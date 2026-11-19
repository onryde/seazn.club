// W5 app PR A, Task 8 (RB5-W7; owner R24 pick 11 A): one line per departed entrant under a league or group table, naming the
// rule its departure applied. Always visible (the only form that survives print, export and a screen reader, R24). The text
// is resolved by the caller (`withdrawalNoteText`, lib/table-withdrawal-note.ts) — the division page with its dictionary, the
// hub's builder in the org's language — so both tables print the same words. Nothing at all for a table with no departure.
import type { WithdrawalNoteText } from "@/lib/table-withdrawal-note";

export function WithdrawalFootnotes({ items }: { items: readonly WithdrawalNoteText[] }) {
  if (items.length === 0) return null;
  return (
    <ul data-testid="standings-withdrawal-notes" className="mt-2 min-w-0 space-y-1 px-1 text-xs leading-relaxed text-ink-muted">
      {items.map((n) => (
        <li key={n.entrantId} data-testid={`standings-withdrawal-note-${n.entrantId}`} className="min-w-0 break-words">
          <strong className="font-semibold text-ink">{n.lead}</strong> {n.body}
        </li>
      ))}
    </ul>
  );
}
