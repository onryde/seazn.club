// W5 app PR B Task 4 (X-UP-3; R24 pick 16 B): the unequal-pool basis under a group stage's tables on the Standings tab - one
// line, then the results it left out behind a disclosure. The text is `bestNthBasisNote`'s (lib/bestnth-basis-note.ts).
import type { BasisNoteText } from "@/lib/bestnth-basis-note";

export function BestNthBasisNote({ note }: { note: BasisNoteText | null }) {
  if (note === null) return null;
  return (
    <div data-testid="standings-bestnth-basis" className="mt-2 min-w-0 px-1 text-xs leading-relaxed text-ink-muted">
      <p data-testid="standings-bestnth-basis-line" className="min-w-0 break-words">
        {note.line}
      </p>
      <details className="min-w-0">
        {/* The 44px tap floor, as the Results grid's summary: padding, not flex, so the disclosure triangle stays. */}
        <summary className="min-h-11 cursor-pointer py-3.5 font-medium hover:text-ink">{note.leftOutTitle}</summary>
        <ul data-testid="standings-bestnth-left-out" className="min-w-0 space-y-1 pb-2">
          {note.leftOut.map((line) => (
            <li key={line} className="min-w-0 break-words">
              {line}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
