// W3 app-B Task 7 (X-SW-10; rulebook-W3-swiss.md §3.3 "Prevention"): what the desk says after a Pair whose answer carries the
// engine's one-round look-ahead verdict (`swiss_next_round`, with `swiss_paired_round`: the round just seated). Pure and
// client-safe, in the shape of `swiss-no-pairing.ts`: the wire in, the dictionary key and its parameters out.
//
// A CAUTION, not a refusal: the round is seated and the Pair landed. It names the round it is about ({next} = the round
// just seated + 1) and, when no legal pairing may be left for it, the way out (Finish after the round just seated). Both
// round numbers are derived from the SERVER's `swiss_paired_round` - the desk keeps no count of its own that could drift.
import type { MessageKey } from "./messages";

export type NextRoundVerdict = "unpairable" | "unknown";

export interface NextRoundNotice {
  verdict: NextRoundVerdict;
  /** The round the Pair just seated; the warning is about the one after it. */
  round: number;
}

const KEY: Record<NextRoundVerdict, MessageKey> = {
  unpairable: "swiss.warning.nextRoundUnpairable",
  unknown: "swiss.warning.nextRoundUnknown",
};

/**
 * The notice off a Generate's answer, or null: the answer carries no verdict (the ordinary Pair - a stage within its safe
 * maximum, the last round, or a pairable next round), or it carries one the desk cannot name a round for (a stale server, a
 * proxy that rewrote the body) - never a caution with a guessed round.
 */
export function nextRoundNoticeOf(out: { swiss_next_round?: unknown; swiss_paired_round?: unknown }): NextRoundNotice | null {
  const { swiss_next_round: verdict, swiss_paired_round: round } = out;
  if (verdict !== "unpairable" && verdict !== "unknown") return null;
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) return null;
  return { verdict, round };
}

/** The caution as one sentence in the reader's language. */
export function nextRoundText(
  notice: NextRoundNotice,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  return msg(KEY[notice.verdict], { round: notice.round, next: notice.round + 1 });
}
