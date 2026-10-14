import "server-only";
// I-3 (controller rulings, fix rounds 2 and 3) — what the organiser's "No result" means on an online board, in ONE
// place: the settle (resolve.ts) writes it, and the two readers that offer it (the arbiter panel's loader, the
// needs-result queue) carry the same `noResultOffer`, so neither can offer a No result the server refuses.
//
//   - VOID: No result is an abandon — `core.abandon {reason}` (W2b's abandon reason slot): no points to either player
//     and no absence. The engine folds it to no outcome, so the table scores nothing for it; the fixture reads
//     `abandoned`, and W2b's shared surfaces print "Abandoned ({reason})". The reason is the hold's, in plain words, in
//     the club's own language (stored text: the ledger has no reader to localise it for later).
//     Offered ONLY where a void cannot hold progression up (fix round 3): a league, or a group stage's round-robin —
//     a table completes over a void (`engineFixtureStatus` reads abandoned as the engine's settled `void`). A Swiss
//     round is not paired while a board of the round before is undecided (stages.ts `DECIDED`), and abandoned is not
//     decided there, so a void would stall the stage: refused, "a Swiss round needs every game decided". So is
//     americano's (its mexicano mode waits on every game decided), which reads the same sentence.
//   - Both players absent (no_show_both, double_walkover_blocked): W2b's double walkover, `core.forfeit {by: "both",
//     reason: "walkover"}` — each charged a game played and lost at 0 points; it folds to `forfeited`, which a Swiss
//     round counts as decided. Offered wherever W2b takes one (fix round 3), a knockout line that feeds a next match
//     included, and hidden exactly where W2b refuses it — W2b's OWN predicate, D19 `doubleWalkoverRefused` (a final, a
//     last rung, a third-place match: a bracket line that feeds no next match), so the two can never disagree.
//   - In any knockout (every kind where a level result is forbidden: `forbidsLevelResult`), No result is refused: a
//     knockout game needs a winner.
import { forbidsLevelResult } from "@seazn/engine/core";
import type { NoResultOffer } from "@/lib/arbiter-view";
import { feedsNextMatch, type FeedEdges } from "@/lib/bracket-next-match";
import { doubleWalkoverRefused } from "@/lib/double-walkover-next-match";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import type { NeedsReason } from "@/server/external-play/types";

/** The holds where BOTH players stayed away: their No result is W2b's double walkover, not a void. */
const BOTH_ABSENT = ["no_show_both", "double_walkover_blocked"] as const satisfies readonly NeedsReason[];
type BothAbsent = (typeof BOTH_ABSENT)[number];
const isBothAbsent = (r: NeedsReason): r is BothAbsent => (BOTH_ABSENT as readonly string[]).includes(r);

/** The abandon's reason for each other hold, and for a board settled with no hold ("none": the organiser's own
 *  decision on a game still being played). Total over the vocabulary, so a new hold reason cannot be written without
 *  its words. */
const ABANDON_REASON_KEY = {
  no_show_white: "externalPlay.resolve.abandonReason.no_show_white",
  no_show_black: "externalPlay.resolve.abandonReason.no_show_black",
  not_started: "externalPlay.resolve.abandonReason.not_started",
  aborted: "externalPlay.resolve.abandonReason.aborted",
  mismatch: "externalPlay.resolve.abandonReason.mismatch",
  provider_error: "externalPlay.resolve.abandonReason.provider_error",
  token_revoked: "externalPlay.resolve.abandonReason.token_revoked",
  create_outcome_unknown: "externalPlay.resolve.abandonReason.create_outcome_unknown",
  tiebreak_owed: "externalPlay.resolve.abandonReason.tiebreak_owed",
  fair_play: "externalPlay.resolve.abandonReason.fair_play",
  account_changed: "externalPlay.resolve.abandonReason.account_changed",
  clock_flag_unsettled: "externalPlay.resolve.abandonReason.clock_flag_unsettled",
  none: "externalPlay.resolve.abandonReason.none",
} as const satisfies Record<Exclude<NeedsReason, BothAbsent> | "none", MessageKey>;

/** The stage kinds a void cannot hold up: a table that completes over it, and pairs nothing round by round. */
const VOID_SAFE_KINDS: ReadonlySet<string> = new Set(["league", "group"]);

/** What the settle offers in place of a winner on a board of a `stageKind` stage held for `reason` (null: not held),
 *  its two feed edges saying whether its line feeds a next match — the server's one reading: the settle's refusal, and
 *  both readers' `noResultOffer`. */
export function noResultOffer(board: { stageKind: string | null; reason: NeedsReason | null; edges: FeedEdges }): NoResultOffer {
  const knockout = forbidsLevelResult(board.stageKind);
  if (board.reason !== null && isBothAbsent(board.reason)) {
    return doubleWalkoverRefused(board.stageKind, feedsNextMatch(board.edges)) ? { kind: "refused", why: "knockout" } : { kind: "double_walkover" };
  }
  if (board.stageKind !== null && VOID_SAFE_KINDS.has(board.stageKind)) return { kind: "void" };
  return { kind: "refused", why: knockout ? "knockout" : "swiss" };
}

/** M-7 (fix round 4): the settle asked for the void and the board now offers the double walkover, or the reverse —
 *  who turned up changed under the organiser's screen. Its own code, never BOARD_CHANGED (another writer's decision
 *  landing first): the organiser reloads to see the choice the board takes now. */
export const NO_RESULT_CHANGED = {
  code: "NO_RESULT_CHANGED",
  message: "Who turned up on this board changed while you were deciding — reload to see your choices now",
} as const;

/** The settle's 409 for each refusal: its code (the readers' notice) and its message. */
export const NO_RESULT_REFUSAL = {
  knockout: { code: "KNOCKOUT_NEEDS_WINNER", message: "A knockout game needs a winner — adjudicate it or award it" },
  swiss: { code: "SWISS_NEEDS_RESULT", message: "A Swiss round needs every game decided — adjudicate it or award it" },
} as const satisfies Record<Extract<NoResultOffer, { kind: "refused" }>["why"], { code: string; message: string }>;

export type NoResultEvent =
  | { type: "core.forfeit"; payload: { by: "both"; reason: "walkover" } }
  | { type: "core.abandon"; payload: { reason: string } };

/** The ledger event the organiser's No result writes for a board held for `reason` (null: not held), its abandon
 *  reason worded in `locale`. */
export function noResultEvent(reason: NeedsReason | null, locale: Locale): NoResultEvent {
  if (reason !== null && isBothAbsent(reason)) return { type: "core.forfeit", payload: { by: "both", reason: "walkover" } };
  return { type: "core.abandon", payload: { reason: msgFor(locale, ABANDON_REASON_KEY[reason ?? "none"]) } };
}
