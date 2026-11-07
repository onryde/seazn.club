// W4 app-A (plan Task 3; later tasks grow it one code at a time). Every knockout refusal the W4 app work raises, in ONE
// table: the wire code, its HTTP status, the server's English sentence and the `knockout.refusal.<CODE>` key a screen
// renders in the reader's language. The server builds its error from this row (`server/usecases/knockout-refusal.ts`
// `knockoutRefusal`), so the code, the status and the English cannot drift apart between the throw site and the screen —
// the pattern of `lib/swiss-refusals.ts`, with the row's English named `en` (W4 pre-flight drift R2).
//
// Status: 422 when the request can never succeed as sent (re-sending it changes nothing), 409 when it is a state of the
// stage the organiser resolves another way (the copy says which), 400 for a refusal raised at the BODY door.
//
// Client-safe AND strip-types-safe: no runtime import at all, and only `import type` for `MessageKey`.
// `lib/__tests__/knockout-refusals.test.ts` pins the table against the plan's code list and the four dictionaries; the
// English here must equal `en/ui.json` for the same key.
import type { MessageKey } from "@/lib/messages";

export type KnockoutRefusalCode =
  // T3 (K2; X-SD-5): a bye line is not played, so it takes no court, no time and no pin.
  | "BYE_LINE_NOT_PLACEABLE"
  // T5 (K1): an Undo, Redo or Restore that would step across a seed confirm (history.ts `UNDO_BARRIER_TYPES`).
  | "SEED_CONFIRM_NOT_UNDOABLE";

export interface KnockoutRefusalRow {
  status: 400 | 409 | 422;
  /** The server's English sentence — the same text as `en/ui.json`'s `key`. */
  en: string;
  key: MessageKey;
}

export const KNOCKOUT_REFUSALS: Record<KnockoutRefusalCode, KnockoutRefusalRow> = {
  BYE_LINE_NOT_PLACEABLE: {
    status: 422,
    en: "A bye is not played, so it never takes a court or a time.",
    key: "knockout.refusal.BYE_LINE_NOT_PLACEABLE",
  },
  SEED_CONFIRM_NOT_UNDOABLE: {
    status: 409,
    en: "A confirmed draw can't be undone. Recompute the proposal instead.",
    key: "knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE",
  },
};

/** Whether a wire code is one of this table's — a client's branch to say a knockout refusal in the reader's language.
 *  Own keys only: a prototype name is no code. */
export function isKnockoutRefusalCode(code: unknown): code is KnockoutRefusalCode {
  return typeof code === "string" && Object.hasOwn(KNOCKOUT_REFUSALS, code);
}

/** The `ui.json` key a screen renders for `code` (`useMsg()(knockoutRefusalKey(code))`). */
export function knockoutRefusalKey(code: KnockoutRefusalCode): MessageKey {
  return KNOCKOUT_REFUSALS[code].key;
}
