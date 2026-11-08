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
  | "KO_GENERATE_AFTER_START"
  // B2 fix round 1 (I1): a knockout's Generate (or Start) would have to redraw the bracket — delete every line — and the
  // lines carry organiser setup the delete cascades into. Generate has no confirm; Rebuild's lists what it clears.
  | "KO_REDRAW_WOULD_CLEAR_SETUP"
  // B2 fix round 2 (item 2): Start reconciles a root knockout in place only; a change that needs the bracket drawn again is
  // Update draw's (its notice says what moved), so Start refuses it by name and names the button.
  | "KO_START_NEEDS_UPDATE_DRAW"
  // T9 (X-LE-2): a late player asked into a knockout an earlier stage fills (`{stage}`: that stage's name) — a fed
  // bracket never takes one; its field is the source's.
  | "KO_LATE_ENTRY_FED_STAGE"
  // T10 (X-LE-6): round 1 holds no bye and no withdrawn seat a late player could take (`details.can_rebuild`: nothing in the
  // stage has started, so Rebuild fixtures would draw the field again with them in it).
  | "KO_LATE_ENTRY_NO_SLOT"
  // T10 (X-LE-13): an Undo, Redo or Restore that would step across a knockout late entry (history.ts `UNDO_BARRIER_TYPES`).
  | "KO_LATE_ENTRY_NOT_UNDOABLE";

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
  KO_REDRAW_WOULD_CLEAR_SETUP: {
    status: 409,
    en: "The bracket would have to be drawn again, which clears match setup already on its lines (officials, team sheets, scoring devices, streams, player availability or court calls). Use Rebuild fixtures — it lists what it clears first.",
    key: "knockout.refusal.KO_REDRAW_WOULD_CLEAR_SETUP",
  },
  KO_START_NEEDS_UPDATE_DRAW: {
    status: 409,
    en: "The draw needs updating — press Update draw first.",
    key: "knockout.refusal.KO_START_NEEDS_UPDATE_DRAW",
  },
  KO_LATE_ENTRY_FED_STAGE: {
    status: 422,
    en: "This knockout is filled from {stage}. Add the player there.",
    key: "knockout.refusal.KO_LATE_ENTRY_FED_STAGE",
  },
  KO_LATE_ENTRY_NO_SLOT: {
    status: 409,
    en: "Round 1 complete; no slot left.",
    key: "knockout.refusal.KO_LATE_ENTRY_NO_SLOT",
  },
  KO_LATE_ENTRY_NOT_UNDOABLE: {
    status: 409,
    en: "Adding a late player can't be undone. Withdraw the player instead.",
    key: "knockout.refusal.KO_LATE_ENTRY_NOT_UNDOABLE",
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
