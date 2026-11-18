// W5 app PR A, Task 2 (RB5-G7, RB5-L*, RB5-P*, RB5-E*; rulings 285-290). Every round-robin refusal the W5 app work raises, in ONE
// client-safe table: the wire code, its HTTP status, the server's English sentence and the `roundrobin.refusal.<CODE>` key a
// screen renders in the reader's language. The server builds its error from this row (`server/usecases/roundrobin-refusal.ts`
// `roundRobinRefusal`), so the code, the status and the English cannot drift apart between the throw site and the screen: the
// pattern of `lib/knockout-refusals.ts` and `lib/swiss-refusals.ts`.
//
// Task 2 creates the table with the whole plan's codes (the plan lists them together); each later task wires its own throw
// site. A code with no throw site yet is a word waiting for its task, never an invented one: the test that pins this table
// names the task each one belongs to.
//
// Status: 422 when the request can never succeed as sent (re-sending it changes nothing), 409 when it is a state of the stage
// the organiser resolves another way (the copy says which).
//
// Client-safe AND strip-types-safe: no runtime import at all, and only `import type` for `MessageKey`.
import type { MessageKey } from "@/lib/messages";

export type RoundRobinRefusalCode =
  // Task 2 (RB5-G7, X-CU-6): Generate on a league or group once play has started never reshapes it.
  | "RR_GENERATE_AFTER_START"
  // Task 5 (late entry; RB5-L*): the stage is complete, the newcomer owes nothing, the add has no Undo, the entrant is not
  // waiting / already placed, the pool is not one of the stage's.
  | "RR_LATE_ENTRY_STAGE_COMPLETE"
  | "RR_LATE_ENTRY_NOTHING_TO_ADD"
  | "RR_LATE_ENTRY_NOT_UNDOABLE"
  | "RR_LATE_ENTRY_NOT_WAITING"
  | "RR_LATE_ENTRY_ALREADY_PLACED"
  | "RR_LATE_ENTRY_UNKNOWN_POOL"
  // Task 8b: a pair changing partners after Start.
  | "RR_SUBSTITUTE_PARTNER_REFUSED"
  // Task 9: an ad-hoc fixture into a round that does not exist yet and is not the next one.
  | "RR_ADHOC_ROUND_INVALID"
  // Task 13 (ruling 288): a rank pinned twice in a pool, or above the pool's size; and a pin on a stage that has no table.
  | "RR_RANK_OVERRIDE_POOL"
  | "RR_RANK_OVERRIDE_NOT_TABLE"
  // Task 12b (RB5-E6): a cut larger than the field (or than any pool can supply).
  | "RR_CUT_EXCEEDS_FIELD"
  // Task 2 fix round 1: a Generate that would have to draw the stage again (a pool changed parity or a group re-snaked)
  // while its lines carry officials, team sheets, devices, streams, availability or
  // court calls. Details: `attachments`, the counts `stageAttachmentCounts` reads - the same shape as KO_REDRAW_WOULD_CLEAR_SETUP.
  | "RR_REGENERATE_WOULD_CLEAR_SETUP"
  // B1 batch C1: the same redraw over a table that holds an Add match row. The row cannot be kept through a redraw and is never
  // dropped silently, so the Generate is refused. Details: `matches`, how many extra rows the stage holds.
  | "RR_REGENERATE_WOULD_DROP_ADD_MATCH";

export interface RoundRobinRefusalRow {
  status: 409 | 422;
  /** The server's English sentence — the same text as `en/ui.json`'s `key`. */
  en: string;
  key: MessageKey;
}

export const ROUND_ROBIN_REFUSALS: Record<RoundRobinRefusalCode, RoundRobinRefusalRow> = {
  RR_GENERATE_AFTER_START: {
    status: 409,
    en: "Play has started, so Generate won't change the fixtures. Use Add late player.",
    key: "roundrobin.refusal.RR_GENERATE_AFTER_START",
  },
  RR_LATE_ENTRY_STAGE_COMPLETE: {
    status: 422,
    en: "This table has finished. Late players can't join it.",
    key: "roundrobin.refusal.RR_LATE_ENTRY_STAGE_COMPLETE",
  },
  RR_LATE_ENTRY_NOTHING_TO_ADD: {
    status: 422,
    en: "This player already has a fixture against everyone in the pool.",
    key: "roundrobin.refusal.RR_LATE_ENTRY_NOTHING_TO_ADD",
  },
  RR_LATE_ENTRY_NOT_UNDOABLE: {
    status: 409,
    en: "Adding a late player can't be undone. Withdraw the player instead.",
    key: "roundrobin.refusal.RR_LATE_ENTRY_NOT_UNDOABLE",
  },
  RR_LATE_ENTRY_NOT_WAITING: {
    status: 409,
    en: "This player isn't waiting for a place.",
    key: "roundrobin.refusal.RR_LATE_ENTRY_NOT_WAITING",
  },
  RR_LATE_ENTRY_ALREADY_PLACED: {
    status: 409,
    en: "This player already has their fixtures.",
    key: "roundrobin.refusal.RR_LATE_ENTRY_ALREADY_PLACED",
  },
  RR_LATE_ENTRY_UNKNOWN_POOL: {
    status: 422,
    en: "There's no pool with that name in this stage.",
    key: "roundrobin.refusal.RR_LATE_ENTRY_UNKNOWN_POOL",
  },
  RR_SUBSTITUTE_PARTNER_REFUSED: {
    status: 422,
    en: "A pair can't change partners once play has started. Withdraw the pair and add a new one.",
    key: "roundrobin.refusal.RR_SUBSTITUTE_PARTNER_REFUSED",
  },
  RR_ADHOC_ROUND_INVALID: {
    status: 422,
    en: "That round doesn't exist yet. Pick an existing round or the next one.",
    key: "roundrobin.refusal.RR_ADHOC_ROUND_INVALID",
  },
  RR_RANK_OVERRIDE_POOL: {
    status: 422,
    en: "Each rank can be pinned once per pool, and never above the pool's size.",
    key: "roundrobin.refusal.RR_RANK_OVERRIDE_POOL",
  },
  RR_RANK_OVERRIDE_NOT_TABLE: {
    status: 422,
    en: "Ranks can only be pinned on a league, group, Swiss or americano table.",
    key: "roundrobin.refusal.RR_RANK_OVERRIDE_NOT_TABLE",
  },
  // Task 12b states the sentence's final wording with its builder gate; the two numbers are `details.qualified` / `details.max`.
  RR_CUT_EXCEEDS_FIELD: {
    status: 422,
    en: "{qualified} can't qualify from this field: it can supply at most {max}.",
    key: "roundrobin.refusal.RR_CUT_EXCEEDS_FIELD",
  },
  RR_REGENERATE_WOULD_CLEAR_SETUP: {
    status: 409,
    en: "The table would have to be drawn again, which clears match setup already on its lines (officials, team sheets, scoring devices, streams, player availability or court calls). Use Rebuild fixtures — it lists what it clears first.",
    key: "roundrobin.refusal.RR_REGENERATE_WOULD_CLEAR_SETUP",
  },
  RR_REGENERATE_WOULD_DROP_ADD_MATCH: {
    status: 409,
    en: "The table would have to be drawn again, which removes the matches you added with Add match. Rebuild fixtures removes them too: note them down first, then use it.",
    key: "roundrobin.refusal.RR_REGENERATE_WOULD_DROP_ADD_MATCH",
  },
};

/** Whether a wire code is one of this table's — a client's branch to say a round-robin refusal in the reader's language.
 *  Own keys only: a prototype name is no code. */
export function isRoundRobinRefusalCode(code: unknown): code is RoundRobinRefusalCode {
  return typeof code === "string" && Object.hasOwn(ROUND_ROBIN_REFUSALS, code);
}

/** The `ui.json` key a screen renders for `code` (`useMsg()(roundRobinRefusalKey(code))`). */
export function roundRobinRefusalKey(code: RoundRobinRefusalCode): MessageKey {
  return ROUND_ROBIN_REFUSALS[code].key;
}
