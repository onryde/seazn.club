// W4 app-A Task 5 (K1): an Undo, Redo or Restore can be refused by an undo barrier of either family — a Swiss one
// (`SWISS_LATE_ENTRY_NOT_UNDOABLE`, `SWISS_ROUNDS_CHANGE_NOT_UNDOABLE`, `SWISS_UNDO_ROUND_STARTED`) or, since T5, a
// knockout one (`SEED_CONFIRM_NOT_UNDOABLE`), and since W5 T5 a round-robin one (`RR_LATE_ENTRY_NOT_UNDOABLE`). The server
// throws each through its own family's table (history.ts); a screen that says the refusal reads its sentence key here, by
// family, so a knockout or round-robin code never falls through to the server's English sentence. Client-safe: the three
// tables it reads have no runtime import of their own.
import type { MessageKey } from "@/lib/messages";
import { isKnockoutRefusalCode, knockoutRefusalKey, knockoutRefusalText, type KnockoutRefusalCode } from "@/lib/knockout-refusals";
import { isRoundRobinRefusalCode, roundRobinRefusalKey, type RoundRobinRefusalCode } from "@/lib/roundrobin-refusals";
import { isSwissRefusalCode, swissRefusalKey, type SwissRefusalCode } from "@/lib/swiss-refusals";

/** A refusal code an undo step can answer with, of any family. */
export type UndoRefusalCode = SwissRefusalCode | KnockoutRefusalCode | RoundRobinRefusalCode;

/** Whether a wire code is one of any family's — own keys only (a prototype name is no code). */
export function isUndoRefusalCode(code: unknown): code is UndoRefusalCode {
  return isSwissRefusalCode(code) || isKnockoutRefusalCode(code) || isRoundRobinRefusalCode(code);
}

/** The `ui.json` key a screen renders for `code`, dispatched by family. */
export function undoRefusalKey(code: UndoRefusalCode): MessageKey {
  if (isKnockoutRefusalCode(code)) return knockoutRefusalKey(code);
  if (isRoundRobinRefusalCode(code)) return roundRobinRefusalKey(code);
  return swissRefusalKey(code);
}

/** The sentence a screen shows for `code`, in the reader's language, its fields filled. A knockout sentence can name something
 *  (`{min}`, `{stage}`), which the server sends beside the code (`knockoutRefusal(code, details)` → the envelope's `extra`); the
 *  key alone prints the hole. Every screen that says an undo step's refusal reads it here, so none can forget the fields. A
 *  Swiss sentence names nothing. */
export function undoRefusalText(
  code: UndoRefusalCode,
  extra: Readonly<Record<string, unknown>> | undefined,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (isKnockoutRefusalCode(code)) return knockoutRefusalText(code, extra ?? {}, msg);
  if (isRoundRobinRefusalCode(code)) {
    // A round-robin sentence names its fields by the same names the server sends in `extra` (`roundRobinRefusal(code, details)`).
    const vars: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(extra ?? {})) if (typeof v === "string" || typeof v === "number") vars[k] = v;
    return msg(roundRobinRefusalKey(code), vars);
  }
  return msg(swissRefusalKey(code));
}
