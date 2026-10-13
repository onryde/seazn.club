import "server-only";
// I-3 (controller ruling, fix round 2) — what the organiser's "No result" means on an online board, in ONE place: the
// settle (resolve.ts) writes it, and the two readers that offer it (the arbiter panel's loader, the needs-result queue)
// hide it by the same predicate, so neither can offer a No result the server refuses.
//
//   - VOID: No result is an abandon — `core.abandon {reason}` (W2b's abandon reason slot): no points to either player
//     and no absence. The engine folds it to no outcome, so the table scores nothing for it; the fixture reads
//     `abandoned`, and W2b's shared surfaces print "Abandoned ({reason})". The reason is the hold's, in plain words, in
//     the club's own language (stored text: the ledger has no reader to localise it for later).
//   - Both players absent (no_show_both, double_walkover_blocked): W2b's double walkover, `core.forfeit {by: "both",
//     reason: "walkover"}` — each charged a game played and lost at 0 points.
//   - In any knockout (every kind where a level result is forbidden: `forbidsLevelResult`), No result is refused: a
//     knockout game needs a winner.
import { forbidsLevelResult } from "@seazn/engine/core";
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
  none: "externalPlay.resolve.abandonReason.none",
} as const satisfies Record<Exclude<NeedsReason, BothAbsent> | "none", MessageKey>;

/** No result is refused on this board's stage: a knockout game needs a winner. The server's one reading — the settle's
 *  refusal and both readers' `knockout` flag. */
export function noResultRefused(stageKind: string | null): boolean {
  return forbidsLevelResult(stageKind);
}

export type NoResultEvent =
  | { type: "core.forfeit"; payload: { by: "both"; reason: "walkover" } }
  | { type: "core.abandon"; payload: { reason: string } };

/** The ledger event the organiser's No result writes for a board held for `reason` (null: not held), its abandon
 *  reason worded in `locale`. */
export function noResultEvent(reason: NeedsReason | null, locale: Locale): NoResultEvent {
  if (reason !== null && isBothAbsent(reason)) return { type: "core.forfeit", payload: { by: "both", reason: "walkover" } };
  return { type: "core.abandon", payload: { reason: msgFor(locale, ABANDON_REASON_KEY[reason ?? "none"]) } };
}
