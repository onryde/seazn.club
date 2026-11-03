// W3 app-B Task 4 (SW-H1 on the desk; X-SW-3, rulebook-W3 §3.3): what the desk says when Pair next is refused
// SWISS_NO_LEGAL_PAIRING — the reason-specific sentence and the recovery it offers. Pure and client-safe: the wire
// details in (`{ round, reason, field, finishAfter, canFinish }`, the five fields `swissGen` copies by name), the
// dictionary keys, their parameters and the offered actions out. The sentence is COMPOSED — the reason's lead ("Round 4
// can't be paired: …") plus a tail naming only the recoveries actually offered — so the copy never promises a button the
// desk does not show: no Finish without a finished round to end at (and the server's `canFinish`), no Change rounds once
// a match has started (the count is fixed from then on; `swissRoundControls[stage].started`).
import type { SwissRefusalReason } from "@seazn/engine/scheduling/swiss";
import type { MessageKey } from "./messages";
import type { SwissFinishPlan } from "./swiss-finish-plan";

/** The five fields of the refusal's body. */
export interface NoPairingDetails {
  /** The round that could not be paired. */
  round: number;
  reason: SwissRefusalReason;
  /** The round's field (entrants to seat). */
  field: number;
  /** k: the round "Finish after round k" ends the Swiss at (the round before `round`; 0 in round 1). */
  finishAfter: number;
  /** THE Finish predicate's answer, from the server. */
  canFinish: boolean;
}

export type NoPairingAction = "finish" | "rounds";

export interface NoPairingNotice {
  /** The reason's lead sentence. */
  key: MessageKey;
  /** The recovery sentence, or null when nothing is offered. */
  tail: MessageKey | null;
  params: { round: number; finishAfter: number };
  /** In display order. */
  actions: NoPairingAction[];
}

/** An exhaustive Record over the engine's own union: a sixth reason added to the engine reds `tsc` here. */
const LEAD_KEY: Record<SwissRefusalReason, MessageKey> = {
  rematch: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.rematch",
  colour: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.colour",
  no_bye_candidate: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.no_bye_candidate",
  search_limit: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.search_limit",
  field_too_small: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.field_too_small",
};

/** The two recovery buttons' labels (`{n}` on the first: the round it finishes after). */
export const NO_PAIRING_ACTION_KEY = {
  finish: "swiss.recovery.finishAfter",
  rounds: "swiss.recovery.changeRounds",
} as const satisfies Record<NoPairingAction, MessageKey>;

const TAIL_KEY = {
  both: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.tail.both",
  finish: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.tail.finish",
  rounds: "swiss.refusal.SWISS_NO_LEGAL_PAIRING.tail.rounds",
} as const satisfies Record<string, MessageKey>;

const isCount = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;

/**
 * The refusal's details off the wire (`ApiV1Error.extra`), or null when any of the five is missing or mistyped — a stale
 * server, a proxy that rewrote the body. The desk then says the generic sentence instead of a notice with a guessed round.
 */
export function noPairingDetailsOf(extra: unknown): NoPairingDetails | null {
  if (typeof extra !== "object" || extra === null) return null;
  const { round, reason, field, finishAfter, canFinish } = extra as Record<string, unknown>;
  if (!isCount(round, 1) || !isCount(field, 0) || !isCount(finishAfter, 0) || typeof canFinish !== "boolean") return null;
  if (typeof reason !== "string" || !Object.hasOwn(LEAD_KEY, reason)) return null;
  return { round, reason: reason as SwissRefusalReason, field, finishAfter, canFinish };
}

/**
 * The notice for a refusal. Finish is offered on BOTH the server's `canFinish` and a round to finish after (`finishAfter`
 * 1 or more: round 1 has nothing behind it); Change rounds unless the stage has started (`roundsEditable: false`).
 */
export function noPairingNotice(details: NoPairingDetails, opts: { roundsEditable?: boolean } = {}): NoPairingNotice {
  const finish = details.canFinish && details.finishAfter >= 1;
  const rounds = opts.roundsEditable !== false;
  const actions: NoPairingAction[] = [...(finish ? (["finish"] as const) : []), ...(rounds ? (["rounds"] as const) : [])];
  const tail = finish ? (rounds ? TAIL_KEY.both : TAIL_KEY.finish) : rounds ? TAIL_KEY.rounds : null;
  return {
    key: LEAD_KEY[details.reason],
    tail,
    params: { round: details.round, finishAfter: details.finishAfter },
    actions,
  };
}

/** The notice as one sentence: the reason's lead, then the recovery tail when there is one. */
export function noPairingText(
  notice: NoPairingNotice,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const lead = msg(notice.key, notice.params);
  return notice.tail === null ? lead : `${lead} ${msg(notice.tail, notice.params)}`;
}

/**
 * The plan the Finish action confirms and posts: finish after round `finishAfter` of the stage's `rounds`, or null when
 * Finish is not on offer (the server's `canFinish` false, nothing finished yet, or no readable round count at least as
 * large as `finishAfter` — the stage's rounds control, else its stored config). The notice then drops the action too.
 */
export function noPairingFinishPlan(details: NoPairingDetails, rounds: unknown): SwissFinishPlan | null {
  if (!details.canFinish || details.finishAfter < 1) return null;
  if (!isCount(rounds, details.finishAfter)) return null;
  return { after: details.finishAfter, rounds };
}
