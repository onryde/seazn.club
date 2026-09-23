// refusal-copy.ts — the pad's own words for a write the server refused.
//
// R6 FIX PASS 3, GAP 1. Until this file existed, both pad lanes resolved a
// refusal through `scoringErrorText(code, message, msg, fallback)`, whose
// documented contract is "engine copy if the code is an engine one, ELSE THE
// RAW SERVER MESSAGE". That was harmless while the pad could only ever see a
// 422 — every `EngineErrorCode` has localized copy, so the raw-message branch
// was unreachable in practice. It stopped being harmless the moment
// `transport.ts` began surfacing the whole permanent 4xx class: a band-1
// penalty then resolved to the server's own
//
//     "Plan upgrade required: scoring.match_timeline"
//
// which is English regardless of the scorer's locale AND names an internal
// feature slug on a screen at the side of a rink.
//
// So this resolver never falls through to server prose. Three steps, in order:
//
//   1. an engine code -> the engine copy that already ships in four locales;
//   2. a wire code this pad has words for -> those words;
//   3. anything else -> the generic fallback, which says the one thing that
//      always matters and can never be wrong.
//
// WHAT THE COPY HAS TO DO. The defect this fixes was not a missing sentence —
// it was a scorer believing two penalties were on the sheet and that their
// side was short. So every string below leads with "Not recorded", then says
// what to do about it. No apology, no system vocabulary, no status number.
//
// The codes are `http.ts`'s own `statusCode()` map — the single place a
// non-engine HTTP status becomes a stable machine code — restated here rather
// than imported because `@/server/**` is banned from this bundle by the pad's
// purity gate (`__tests__/server-boundary.test.ts`). `__tests__/refusal-copy
// .test.ts` pins the two lists against each other so a new server code cannot
// arrive without copy.
import type { MessageKey } from "@/lib/messages";
import { engineErrorLabel, type MsgFn } from "@/lib/scoring-vocab";
import type { RejectionInfo } from "./use-pad-pipeline";
import { NEXT_MATCH_STARTED_CODE, nextMatchLabel } from "@/lib/next-match-started";

/**
 * Wire code -> the pad's words. Every entry is a PERMANENT refusal the pad can
 * now be handed (transport.ts's own class); the retryable ones (429/408) and
 * the 5xx never reach a rejection surface at all, so they are deliberately
 * absent rather than mapped to something reassuring.
 *
 * A bare `CONFLICT` is still deliberately ABSENT: a renegotiable 409 goes to
 * the append/replay protocol and never reaches this resolver. The four
 * `UNDO_*` codes DO reach it (W1, 2026-09-21) — they are 409s the server will
 * refuse no matter what seq we send (`transport.ts`'s
 * `TERMINAL_CONFLICT_CODES`), so they are surfaced rather than retried.
 *
 * `QUEUE_STALLED` is the one code here the SERVER never sends: `pipeline.ts`
 * mints it when an event has spent its conflict-pass ceiling, so that a write
 * the pad cannot land is said out loud instead of sitting at the queue head.
 */
export const REFUSAL_KEY: Readonly<Record<string, MessageKey>> = {
  VALIDATION: "scorepad.refusal.invalid",
  UNAUTHENTICATED: "scorepad.refusal.signedOut",
  PAYMENT_REQUIRED: "scorepad.refusal.planLocked",
  FORBIDDEN: "scorepad.refusal.notAllowed",
  NOT_FOUND: "scorepad.refusal.missing",
  UNDO_NOOP: "scorepad.refusal.undoNothing",
  UNDO_TARGET_MISSING: "scorepad.refusal.undoMissing",
  UNDO_ALREADY_VOIDED: "scorepad.refusal.undoAlready",
  UNDO_NOT_UNDOABLE: "scorepad.refusal.undoNotUndoable",
  // The plain sentence, for a refusal that arrived without its ref;
  // `refusalText` names the match whenever the ref is there.
  NEXT_MATCH_STARTED: "scorepad.refusal.nextMatchStarted",
  QUEUE_STALLED: "scorepad.refusal.queueStalled",
  // Scorer sheets §4.5 — a device link's write once the result has moved the
  // competition on (`usecases/carried-forward.ts`). Terminal for the chrome
  // too (`transport.ts`'s CHROME_TERMINAL_CODES), which leaves the pad; this
  // is the pad's own banner for the moment before it does.
  RESULT_CARRIED_FORWARD: "scorepad.refusal.carriedForward",
};

/** The one sentence that is true of every refusal, known code or not. */
export const REFUSAL_FALLBACK: MessageKey = "scorepad.rejection.fallback";

/**
 * Localized copy for a refused submission — never null, never the server's
 * own string. `null` in means "nothing was refused", which is the only case
 * that renders nothing at all.
 */
export function refusalText(rejection: RejectionInfo | null, m: MsgFn): string | null {
  if (!rejection) return null;
  const engine = engineErrorLabel(rejection.code, m);
  if (engine !== null) return engine;
  // Owner ruling 2026-09-23: the refusal NAMES the match to void first — by
  // the label the schedule board shows it by (fix round 2 ruling): "F·1" for a
  // knockout final, "R2·1" where the board prints no code
  // (`lib/next-match-started.ts`'s `nextMatchLabel`).
  if (rejection.code === NEXT_MATCH_STARTED_CODE && rejection.nextMatch) {
    return m("scorepad.refusal.nextMatchStartedRef", { ref: nextMatchLabel(rejection.nextMatch, m) });
  }
  const own = REFUSAL_KEY[rejection.code];
  return m(own ?? REFUSAL_FALLBACK);
}
