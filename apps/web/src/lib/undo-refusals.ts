// W4 app-A Task 5 (K1): an Undo, Redo or Restore can be refused by an undo barrier of either family — a Swiss one
// (`SWISS_LATE_ENTRY_NOT_UNDOABLE`, `SWISS_ROUNDS_CHANGE_NOT_UNDOABLE`, `SWISS_UNDO_ROUND_STARTED`) or, since T5, a
// knockout one (`SEED_CONFIRM_NOT_UNDOABLE`). The server throws each through its own family's table (history.ts); a
// screen that says the refusal reads its sentence key here, by family, so a knockout code never falls through to the
// server's English sentence. Client-safe: the two tables it reads have no runtime import of their own.
import type { MessageKey } from "@/lib/messages";
import { isKnockoutRefusalCode, knockoutRefusalKey, type KnockoutRefusalCode } from "@/lib/knockout-refusals";
import { isSwissRefusalCode, swissRefusalKey, type SwissRefusalCode } from "@/lib/swiss-refusals";

/** A refusal code an undo step can answer with, of either family. */
export type UndoRefusalCode = SwissRefusalCode | KnockoutRefusalCode;

/** Whether a wire code is one of either family's — own keys only (a prototype name is no code). */
export function isUndoRefusalCode(code: unknown): code is UndoRefusalCode {
  return isSwissRefusalCode(code) || isKnockoutRefusalCode(code);
}

/** The `ui.json` key a screen renders for `code`, dispatched by family. */
export function undoRefusalKey(code: UndoRefusalCode): MessageKey {
  return isKnockoutRefusalCode(code) ? knockoutRefusalKey(code) : swissRefusalKey(code);
}
