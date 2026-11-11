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
  | "KO_START_NEEDS_UPDATE_DRAW_FROZEN"
  // T9 (X-LE-2): a late player asked into a knockout an earlier stage fills (`{stage}`: that stage's name) — a fed
  // bracket never takes one; its field is the source's.
  | "KO_LATE_ENTRY_FED_STAGE"
  // T10 (X-LE-6): round 1 holds no bye and no withdrawn seat a late player could take. With nothing in the stage started an
  // organiser's add no longer meets this (B6a fix round 1, RB4-L6: it keeps the player and answers 201 `rebuild_offered`);
  // the 409 is the add once a match has started (`details.can_rebuild: false`: Rebuild would clear played work).
  | "KO_LATE_ENTRY_NO_SLOT"
  // T10 (X-LE-13): an Undo, Redo or Restore that would step across a knockout late entry (history.ts `UNDO_BARRIER_TYPES`).
  | "KO_LATE_ENTRY_NOT_UNDOABLE"
  | "KO_LATE_ENTRY_NOT_WAITING"
  // T15 (X-PL-1, owner pick 5A): Start or a root Generate of a Knockout + Plate on a field below 4. Its plate needs two
  // round-one losers; the builder shows the card disabled with the same reason.
  | "KO_PLATE_TOO_FEW"
  // T15 (X-QM-5, `details.min`): Start or a root Generate of a qualifying draw on a field that cannot fill the cut. Unrefused,
  // the whole qualifying stage is played and Complete then fails (STAGE_COMPLETED_SEEDING_FAILED).
  | "QUALIFYING_MAIN_TOO_FEW"
  // T26c fix round 1 (I1): Start, a root Generate or Rebuild of a format with a fed page playoff (group_playoffs,
  // swiss_playoff) on a field below the page playoff's four: its fourth seat could never fill, and its lines took a court.
  | "PAGE_PLAYOFF_TOO_FEW"
  // T15 (X-QM-2): a rank cut from a knockout source that is no whole round: the ranks inside a round are not played off, so a
  // cut through one is decided by seed. Refused at create and patch only: a stored one keeps running.
  | "KO_CUT_NOT_WHOLE_ROUND"
  // T16 (SP-UI; RB4-S6 / X-SP-6, ruling 269): a stepladder or a page playoff with no progression has no table to seed
  // from, so the stage writers refuse it (`lib/stage-standalone.ts` names the kind -> code). One code per kind (pre-flight
  // D13): each locale names the format in its own words, never a raw kind token.
  | "STEPLADDER_NEEDS_TABLE_SOURCE"
  | "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE"
  // T8 (X-PL-2): a plate proposal asked of a field under two first-match losers; the plate completes by name instead.
  | "PLATE_FIELD_TOO_SMALL"
  // B5a T11 (X-CH-3; T12): reversing a vacant title (a Reinstate) or undoing joint winners on a stage whose completion already
  // filled another stage's draw - its ranks are not this stage's to change any more.
  | "VACANT_TITLE_ALREADY_SEEDED"
  // B5a T12 (X-CH-4, X-CH-6): "Declare joint winners" on a fixture that is no deciding final.
  | "JOINT_WINNERS_NOT_A_FINAL"
  // B5a T12: ... on a final that already holds a result (a winner, or a decided/walkover outcome).
  | "JOINT_WINNERS_FINAL_DECIDED"
  // B5a T12: Undo on a final that holds no joint-winners declaration.
  | "JOINT_WINNERS_NOT_DECLARED"
  // B5a fix round 1 (I-3): a score event, a pad Undo or a settle on a final ruled joint (Undo the declaration first).
  | "FINAL_JOINT_WINNERS_DECLARED"
  // B5a fix round 1 (m-3): declare on a final whose seated finalists have both withdrawn (the title is vacant, X-CH-3).
  | "JOINT_WINNERS_FINALISTS_OUT"
  // B5a fix round 1 (m-4): Undo while a finalist has withdrawn since the declaration (it would seat a departed finalist).
  | "JOINT_WINNERS_UNDO_FINALIST_OUT"
  // B4 T9 (X-TP-1, D3): a third-place match on a stage that draws under four entrants (the engine's `third_place_needs_two_semis`),
  // at Generate, Start or the setting's PATCH. `details.entrants` is the count; the way out is Shared.
  | "KO_THIRD_PLACE_TOO_FEW"
  // B4 T9 (X-TP-6): the third-place setting is edited until the stage starts, then read-only.
  | "THIRD_PLACE_LOCKED"
  // B4 T9: the third-place setting sent to a stage that is no knockout (PATCH /stages/{id} `{ thirdPlace }`).
  | "STAGE_NOT_KNOCKOUT";

export interface KnockoutRefusalRow {
  status: 400 | 409 | 422;
  /** The server's English sentence — the same text as `en/ui.json`'s `key`. */
  en: string;
  key: MessageKey;
}

/** RB4-D9 (X-SD-10): the stage-config schema's never-key carries this sentence (`api-v1/schemas/stages.ts` `StageConfig`), and
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
    en: "Play has started, so Generate won't change the bracket. Use Add to bracket.",
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
  // W4 B6a fix round 1 (review I2): Start on a FROZEN board that needs a redraw. Update draw is refused while frozen, so the plain
  // copy would name a remedy that fails; this one says unfreeze first (as knockout.lateEntry.unfreezeFirst does).
  KO_START_NEEDS_UPDATE_DRAW_FROZEN: {
    status: 409,
    en: "The draw needs updating, and the schedule is frozen: unfreeze it on the Schedule page, press Update draw, then Start.",
    key: "knockout.refusal.KO_START_NEEDS_UPDATE_DRAW_FROZEN",
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
  // T11 (X-LE-10): the one-tap place route on an entrant that does not wait on this stage — never marked, already placed,
  // placed by a Rebuild, or withdrawn since.
  KO_LATE_ENTRY_NOT_WAITING: {
    status: 409,
    en: "This player isn't waiting to join this bracket.",
    key: "knockout.refusal.KO_LATE_ENTRY_NOT_WAITING",
  },
  KO_PLATE_TOO_FEW: {
    status: 422,
    en: "Knockout + Plate needs at least 4 entrants.",
    key: "knockout.refusal.KO_PLATE_TOO_FEW",
  },
  PLATE_FIELD_TOO_SMALL: {
    status: 422,
    en: "The plate needs at least two first-match losers.",
    key: "knockout.refusal.PLATE_FIELD_TOO_SMALL",
  },
  QUALIFYING_MAIN_TOO_FEW: {
    status: 422,
    en: "Qualifying + Main draw needs at least {min} entrants.",
    key: "knockout.refusal.QUALIFYING_MAIN_TOO_FEW",
  },
  PAGE_PLAYOFF_TOO_FEW: {
    status: 422,
    en: "A page playoff needs at least 4 entrants.",
    key: "knockout.refusal.PAGE_PLAYOFF_TOO_FEW",
  },
  KO_CUT_NOT_WHOLE_ROUND: {
    status: 422,
    en: "From a knockout, qualify a whole round: 1, 2, 4, 8 …",
    key: "knockout.refusal.KO_CUT_NOT_WHOLE_ROUND",
  },
  STEPLADDER_NEEDS_TABLE_SOURCE: {
    status: 422,
    en: "A stepladder needs a table to seed from. Add a league or groups first.",
    key: "knockout.refusal.STEPLADDER_NEEDS_TABLE_SOURCE",
  },
  PAGE_PLAYOFF_NEEDS_TABLE_SOURCE: {
    status: 422,
    en: "A page playoff needs a table to seed from. Add a league, groups or a Swiss stage first.",
    key: "knockout.refusal.PAGE_PLAYOFF_NEEDS_TABLE_SOURCE",
  },
  VACANT_TITLE_ALREADY_SEEDED: {
    status: 409,
    en: "This result already seeded the next stage. Correct it there first.",
    key: "knockout.refusal.VACANT_TITLE_ALREADY_SEEDED",
  },
  JOINT_WINNERS_NOT_A_FINAL: {
    status: 422,
    en: "Joint winners can only be declared on a final.",
    key: "knockout.refusal.JOINT_WINNERS_NOT_A_FINAL",
  },
  JOINT_WINNERS_FINAL_DECIDED: {
    status: 409,
    en: "This final already has a result.",
    key: "knockout.refusal.JOINT_WINNERS_FINAL_DECIDED",
  },
  JOINT_WINNERS_NOT_DECLARED: {
    status: 409,
    en: "This final has no joint winners to undo.",
    key: "knockout.refusal.JOINT_WINNERS_NOT_DECLARED",
  },
  KO_THIRD_PLACE_TOO_FEW: {
    status: 422,
    en: "A third-place match needs at least 4 entrants. Use Shared third place instead.",
    key: "knockout.refusal.KO_THIRD_PLACE_TOO_FEW",
  },
  THIRD_PLACE_LOCKED: {
    status: 409,
    en: "Third place can't change once play has started.",
    key: "knockout.refusal.THIRD_PLACE_LOCKED",
  },
  STAGE_NOT_KNOCKOUT: {
    status: 422,
    en: "Third place only applies to a knockout stage.",
    key: "knockout.refusal.STAGE_NOT_KNOCKOUT",
  },
  FINAL_JOINT_WINNERS_DECLARED: {
    status: 409,
    en: "Joint winners were declared on this final. Undo them first.",
    key: "knockout.refusal.FINAL_JOINT_WINNERS_DECLARED",
  },
  JOINT_WINNERS_FINALISTS_OUT: {
    status: 409,
    en: "Both finalists have withdrawn, so this title is vacant. Reinstate one to rule on it.",
    key: "knockout.refusal.JOINT_WINNERS_FINALISTS_OUT",
  },
  JOINT_WINNERS_UNDO_FINALIST_OUT: {
    status: 409,
    en: "A finalist has withdrawn since. Reinstate them before undoing joint winners, or leave the joint title.",
    key: "knockout.refusal.JOINT_WINNERS_UNDO_FINALIST_OUT",
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

/**
 * The sentence a screen shows for a knockout refusal, in the reader's language — its placeholders (`{stage}`, `{min}`)
 * filled from the envelope's string and number fields (`err.extra`, the `details` `knockoutRefusal(code, details)` sent
 * beside the code); any other field fills nothing. The ONE place the desk's panels turn a knockout refusal into words (the
 * stage card's actions, the Entrants tab's add, the waiting strip's tap, Undo, the builder's gate).
 *
 * Two call shapes, one body (merge-lanes-1: T12/T15 and B6a each wrote one): a caller that has narrowed the code
 * (`isKnockoutRefusalCode`) gets a string; one that hands over any wire code gets null for a code that is not this
 * table's, and falls through to its own mapping (W4 T19, B3 review #3, #6).
 */
export function knockoutRefusalText(
  code: KnockoutRefusalCode,
  extra: Readonly<Record<string, unknown>>,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string;
export function knockoutRefusalText(
  code: unknown,
  extra: Readonly<Record<string, unknown>>,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string | null;
export function knockoutRefusalText(
  code: unknown,
  extra: Readonly<Record<string, unknown>>,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string | null {
  if (!isKnockoutRefusalCode(code)) return null;
  const vars = Object.fromEntries(
    Object.entries(extra).filter((e): e is [string, string | number] => typeof e[1] === "string" || typeof e[1] === "number"),
  );
  return msg(knockoutRefusalKey(code), vars);
}
