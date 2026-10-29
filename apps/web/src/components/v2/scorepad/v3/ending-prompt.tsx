"use client";
// W2e Task 30 (D3, D13; rule X-SE-1) — the pad's blocking prompt for a match whose ending sanction has no ending recorded.
//
// Until the ending is recorded (or the sanction voided) the write path takes nothing but a forfeit, an abandon or a void
// (`ENDING_SANCTION_PENDING`). A pad that kept showing its scoring board would offer taps the server must refuse, so while an
// ending is pending the host swaps the board for this card (`pad-host.tsx`, `data-role="v3-ending"`). It opens on its own for
// a ledger that was already in this state when the pad mounted: the match a scorer reloads after a failed second append, and
// one that was in progress when the rule shipped.
//
// It asks ONE thing, and offers only the answers this person can give:
//   - "Record the ending" — sends `core.forfeit{by, reason:"disqualified"}` against the sanctioned side. Offered only to someone
//     the server will let record it (`scorerMayForfeit` over the ledger's last live event, or an organiser): a scorer for whom
//     the same forfeit is a 403 is told who can resolve it instead, in the dictionary's words, never in the server's.
//   - "Void the sanction" — the pad's one void rule (`activityRowState`): a device link may void only its own rows.
//
// House look, from the pad's own sheets: the guided-sheet card (white, `rounded-2xl`, slate hairline) with the dock's top rule
// in the sanction's rose instead of the dock's lime, and the sheet's one violet commit button. The sentence is the loudest
// thing on it; both buttons are 44px and stack full-width on a phone, side by side from `sm`.
import type { TFn } from "./context-strip";

export interface EndingPromptProps {
  /** The sanctioned side, as the screen names it (entrant name, else the Home/Away word). */
  sideName: string;
  /** The server lets this person record the ending. */
  canRecord: boolean;
  /** The pad lets this person void the sanction row. */
  canVoid: boolean;
  /** A write from this prompt is in flight: both buttons wait. */
  busy: boolean;
  onRecord: () => void;
  onVoid: () => void;
  t: TFn;
}

/** The dictionary key for what the prompt says under its sentence, from what this person may do. */
export function endingBodyKey(canRecord: boolean, canVoid: boolean): string {
  if (canRecord) return canVoid ? "pad.ending.body.both" : "pad.ending.body.recordOnly";
  return canVoid ? "pad.ending.body.voidOnly" : "pad.ending.body.neither";
}

const recordButtonClass =
  "min-w-0 max-w-full break-words rounded-full border-2 border-transparent bg-violet-600 px-6 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-400 max-sm:w-full";

const voidButtonClass =
  "min-w-0 max-w-full break-words rounded-full border border-slate-300 bg-white px-6 py-1.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 max-sm:w-full";

export function EndingPrompt({ sideName, canRecord, canVoid, busy, onRecord, onVoid, t }: EndingPromptProps) {
  return (
    <section
      data-testid="pad-ending-pending"
      role="group"
      aria-labelledby="pad-ending-title"
      aria-describedby="pad-ending-body"
      aria-busy={busy}
      className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 border-t-2 border-t-rose-500 bg-white shadow-sm"
    >
      <div className="flex min-w-0 flex-col gap-1 px-4 pb-1 pt-3">
        <h2 id="pad-ending-title" className="break-words text-base font-semibold leading-snug text-slate-900">
          {t("pad.ending.title", { side: sideName })}
        </h2>
        <p id="pad-ending-body" className="break-words text-sm leading-snug text-slate-600">
          {t(endingBodyKey(canRecord, canVoid))}
        </p>
      </div>
      {(canRecord || canVoid) && (
        <div className="flex min-w-0 flex-col gap-2 px-4 pb-3 pt-2 sm:flex-row sm:flex-wrap">
          {canRecord && (
            <button
              type="button"
              data-testid="pad-ending-record"
              disabled={busy}
              onClick={onRecord}
              style={{ minHeight: 44 }}
              className={recordButtonClass}
            >
              {t("pad.ending.record")}
            </button>
          )}
          {canVoid && (
            <button
              type="button"
              data-testid="pad-ending-void"
              disabled={busy}
              onClick={onVoid}
              style={{ minHeight: 44 }}
              className={voidButtonClass}
            >
              {t("pad.ending.void")}
            </button>
          )}
        </div>
      )}
      {!canRecord && !canVoid && <div className="pb-3" />}
    </section>
  );
}
