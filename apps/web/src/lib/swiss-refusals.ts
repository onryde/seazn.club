// W3 Swiss app-A (spec 2026-10-31-format-matrix-w3-swiss-design.md §11: "refusal codes, i18n keys and copy for every
// new message, all 4 locales"). Every Swiss refusal the W3 app work raises, in ONE table: the wire code, its HTTP
// status, the server's English sentence and the `swiss.refusal.<CODE>` key the desk renders in the reader's language.
// The server builds its error from this row (`server/usecases/swiss-refusal.ts` `swissRefusal`), so the code, the
// status and the English cannot drift apart between the throw site and the screen.
//
// Status: 422 when the request can never succeed as sent (re-sending it changes nothing), 409 when it is a state of the
// stage the organiser resolves another way (the copy says which) — the split `usecases/stages.ts` already makes:
// `assertFormatUnlocked`'s FORMAT_LOCKED is a 409, and a refusal of the stage's KIND is a 422 (`unpairSwissRound`'s
// "unpair only exists on swiss stages", SWISS_PAIRING_NOT_SWISS).
//
// Client-safe AND strip-types-safe: no runtime import at all, and only `import type` for `MessageKey`, so
// `api-v1/schemas.ts` (loaded by `scripts/openapi-gen.ts` under bare `node --experimental-strip-types`) may import it
// by relative path. `lib/__tests__/swiss-refusals.test.ts` pins the table against the plan's code list and the four
// dictionaries; the English here must equal `en/ui.json` for the same key.
import type { MessageKey } from "./messages";

export type SwissRefusalCode =
  | "SWISS_ADHOC_REFUSED"
  | "SWISS_BYE_NOT_PLACEABLE"
  | "SWISS_UNDO_ROUND_STARTED"
  | "SWISS_LATE_ENTRY_NOT_UNDOABLE"
  | "SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"
  | "SWISS_NO_ROUND_LEFT"
  | "SWISS_OVER"
  | "SWISS_ROUNDS_ABOVE_MAX"
  | "SWISS_ROUNDS_LOCKED"
  | "SWISS_ROUNDS_BELOW_SEATED"
  | "SWISS_FINISH_ROUND_UNDECIDED"
  | "SWISS_FINISH_NOTHING_PLAYED"
  | "STAGE_NOT_SWISS";

export interface SwissRefusalRow {
  status: 409 | 422;
  /** The server's English sentence (the `message` of the error body); `en/ui.json[key]` says the same. */
  message: string;
  key: MessageKey;
}

export const SWISS_REFUSALS: Record<SwissRefusalCode, SwissRefusalRow> = {
  // W3 T4 (RB3-15 A, ruling 252, X-SW-21): Add match on a Swiss stage.
  SWISS_ADHOC_REFUSED: {
    status: 422,
    message: "Swiss rounds are paired by the system. Add friendlies in another stage.",
    key: "swiss.refusal.SWISS_ADHOC_REFUSED",
  },
  // W3 T3 (SW-M7, X-SW-29): a bye shell moved onto a court or a time.
  SWISS_BYE_NOT_PLACEABLE: {
    status: 422,
    message: "A bye is not played, so it takes no court or time.",
    key: "swiss.refusal.SWISS_BYE_NOT_PLACEABLE",
  },
  // W3 T5 (RB3-22, X-SW-28): Undo of Pair next over a round with a started board.
  SWISS_UNDO_ROUND_STARTED: {
    status: 409,
    message: "A match in this round has started, so its pairing can't be undone.",
    key: "swiss.refusal.SWISS_UNDO_ROUND_STARTED",
  },
  // W3 T5 (design §10.8): Undo across an organiser's "Add late player" — it points to Withdraw.
  SWISS_LATE_ENTRY_NOT_UNDOABLE: {
    status: 409,
    message: "Adding a late player can't be undone. Withdraw the player instead.",
    key: "swiss.refusal.SWISS_LATE_ENTRY_NOT_UNDOABLE",
  },
  // W3 T5 (design §10.8): Undo across a change to the round count (edit, Add a round, Finish now).
  SWISS_ROUNDS_CHANGE_NOT_UNDOABLE: {
    status: 409,
    message: "A change to the number of rounds can't be undone.",
    key: "swiss.refusal.SWISS_ROUNDS_CHANGE_NOT_UNDOABLE",
  },
  // W3 T9 (ruling 250): a late player with the last round started — the desk offers "Add a round".
  SWISS_NO_ROUND_LEFT: {
    status: 409,
    message: "The last round has started, so there is no round left to join. Add a round first.",
    key: "swiss.refusal.SWISS_NO_ROUND_LEFT",
  },
  // W3 T9/T12 (ruling 250): the Swiss is finished or its knockout has started.
  SWISS_OVER: {
    status: 409,
    message: "This Swiss is over.",
    key: "swiss.refusal.SWISS_OVER",
  },
  // W3 T11/T12 (RB3-3): more rounds than the field's hard maximum.
  SWISS_ROUNDS_ABOVE_MAX: {
    status: 422,
    message: "That is more rounds than this field can pair.",
    key: "swiss.refusal.SWISS_ROUNDS_ABOVE_MAX",
  },
  // W3 T12 (RB3-5): the round count after the first match started — only Finish now or Add a round remain.
  SWISS_ROUNDS_LOCKED: {
    status: 409,
    message: "A match has started, so the number of rounds is fixed. Finish the Swiss now or add a round.",
    key: "swiss.refusal.SWISS_ROUNDS_LOCKED",
  },
  // W3 T12 (RB3-5): a round count below a round already paired.
  SWISS_ROUNDS_BELOW_SEATED: {
    status: 422,
    message: "Rounds that are already paired can't be removed.",
    key: "swiss.refusal.SWISS_ROUNDS_BELOW_SEATED",
  },
  // W3 T13 (RB3-20): Finish now while the next round has a started board.
  SWISS_FINISH_ROUND_UNDECIDED: {
    status: 409,
    message: "The round in progress has a started match. Decide it before finishing the Swiss.",
    key: "swiss.refusal.SWISS_FINISH_ROUND_UNDECIDED",
  },
  // W3 T13 (RB3-20): Finish now before any round is complete.
  SWISS_FINISH_NOTHING_PLAYED: {
    status: 409,
    message: "No round has been completed yet, so there is nothing to finish.",
    key: "swiss.refusal.SWISS_FINISH_NOTHING_PLAYED",
  },
  // W3 T12/T13: a Swiss-only action on another kind of stage.
  STAGE_NOT_SWISS: {
    status: 422,
    message: "This is not a Swiss stage.",
    key: "swiss.refusal.STAGE_NOT_SWISS",
  },
};

/** The `ui.json` key the desk renders for `code` (`useMsg()(swissRefusalKey(code))`). */
export function swissRefusalKey(code: SwissRefusalCode): MessageKey {
  return SWISS_REFUSALS[code].key;
}
