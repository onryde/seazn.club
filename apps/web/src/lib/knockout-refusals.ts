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
  | "SEED_CONFIRM_NOT_UNDOABLE"
  // T6 (AN-2): Complete on a bracket the engine would complete while a line is still owed a result (`fixture_ids`).
  | "STAGE_HAS_UNDECIDED_FIXTURES"
  // T7 (RB4-D9, X-SD-10): a stage config naming `countrySeparation` — refused by name at the BODY door (400).
  | "COUNTRY_SEPARATION_NOT_OFFERED"
  // T8 (FX-G2, spec §6.5): Generate on a started root knockout whose roster changed since the draw — after Start the
  // bracket is never reshaped; a late player comes in through the late-entry door.
  | "KO_GENERATE_AFTER_START";

export interface KnockoutRefusalRow {
  status: 400 | 409 | 422;
  /** The server's English sentence — the same text as `en/ui.json`'s `key`. */
  en: string;
  key: MessageKey;
}

/** RB4-D9 (X-SD-10): the stage-config schema's never-key carries this sentence (`api-v1/schemas.ts` `StageConfig`), and
 *  `api-v1/http.ts` names the refusal by it. One literal, so the schema, the envelope and the table row say one thing. */
export const COUNTRY_SEPARATION_NOT_OFFERED_MESSAGE =
  "Country separation isn't offered: Seazn holds no country for players or teams.";

export const KNOCKOUT_REFUSALS: Record<KnockoutRefusalCode, KnockoutRefusalRow> = {
  BYE_LINE_NOT_PLACEABLE: {
    status: 422,
    en: "A bye is not played, so it never takes a court or a time.",
    key: "knockout.refusal.BYE_LINE_NOT_PLACEABLE",
  },
  SEED_CONFIRM_NOT_UNDOABLE: {
    status: 409,
    en: "This draw is confirmed and can't be undone.",
    key: "knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE",
  },
  STAGE_HAS_UNDECIDED_FIXTURES: {
    status: 409,
    en: "This bracket still has matches without a result. Finish or settle them first.",
    key: "knockout.refusal.STAGE_HAS_UNDECIDED_FIXTURES",
  },
  COUNTRY_SEPARATION_NOT_OFFERED: {
    status: 400,
    en: COUNTRY_SEPARATION_NOT_OFFERED_MESSAGE,
    key: "knockout.refusal.COUNTRY_SEPARATION_NOT_OFFERED",
  },
  KO_GENERATE_AFTER_START: {
    status: 409,
    en: "Play has started, so Generate won't change the bracket. Use Add late player.",
    key: "knockout.refusal.KO_GENERATE_AFTER_START",
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
