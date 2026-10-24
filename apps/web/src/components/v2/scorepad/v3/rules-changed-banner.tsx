"use client";
// W2c Task 15 (X-SR-7, owner P-1 "A") — the scorer is told the organiser corrected the match's format, and what it is
// now. Shown by both pads: the v3 host (`pad-host.tsx`, from `usePadPipeline`'s `rulesChanged`) and the device chrome
// (`device-score-pad.tsx`, after its own write was refused for the rules).
//
// A STATUS, not an alert: the refused tap already has its own `role="alert"` line ("Not recorded — …"); this one says
// what the pad now scores to, and stays until the scorer has read it. Amber like the pad's own "needs attention" queue
// pill (`text-amber-700`'s family): something changed under the scorer, nothing failed. The format line is the one
// thing to read — on its own line, in the weight of a fact — and wraps rather than clips at 320 (`min-w-0`,
// `break-words`); the dismiss keeps its own column so it never wraps under the text. It sits in the host's unordered
// band, after the scorebug and before the board (phone composition: `max-md:order-*` is reserved for the four
// ordered rows), so a phone reads it before its next tap.
import { useMsg } from "@/components/i18n/dict-provider";

export function RulesChangedBanner({
  formatLine,
  onDismiss,
}: {
  /** The corrected format in the reader's language (`GET /fixtures/{id}/rules`), or null when there is none to say. */
  formatLine: string | null;
  onDismiss: () => void;
}) {
  const msg = useMsg();
  return (
    <div
      data-testid="pad-rules-changed"
      role="status"
      className="flex min-w-0 items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <div className="min-w-0 flex-1">
        <p>{msg("pad.rulesChanged")}</p>
        {formatLine !== null && (
          <p data-role="pad-rules-changed-format" className="mt-0.5 break-words font-semibold">
            {formatLine}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="min-h-9 shrink-0 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-900 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700"
      >
        {msg("pad.rulesChangedDismiss")}
      </button>
    </div>
  );
}
