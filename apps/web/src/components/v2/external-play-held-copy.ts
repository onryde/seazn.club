// T16 — what the organiser's queue says about a HELD online board (canvas
// HoldQueueDesktop/Phone): a short title for the chip, and a sentence naming
// what happened. One entry per member of the needs_reason vocabulary
// (`NEEDS_REASONS`, which V439/V441's CHECK pins): a `Record<NeedsReason, …>`
// so a new reason cannot ship without its copy (tsc), and the copy sweep in
// external-play-reason-map.test.ts reads every member in every locale.
//
// There is deliberately no "generic" fallback: the reader refuses a reason
// outside the vocabulary (`readNeedsReason`, 500), so a fallback could only
// ever paint over a drift.
import type { DictionaryKey } from "@/lib/i18n-keys";
import type { NeedsReason } from "@/server/external-play/types";

/** The chip on the card ("Lichess link revoked", "Winner to be decided"). */
export const HELD_TITLE_KEYS: Readonly<Record<NeedsReason, DictionaryKey>> = {
  no_show_white: "externalPlay.held.noShowWhite",
  no_show_black: "externalPlay.held.noShowBlack",
  no_show_both: "externalPlay.held.noShowBoth",
  not_started: "externalPlay.held.notStarted",
  aborted: "externalPlay.held.aborted",
  mismatch: "externalPlay.held.mismatch",
  provider_error: "externalPlay.held.providerError",
  token_revoked: "externalPlay.held.tokenRevoked",
  double_walkover_blocked: "externalPlay.held.doubleWalkoverBlocked",
  create_outcome_unknown: "externalPlay.held.createOutcomeUnknown",
  tiebreak_owed: "externalPlay.held.tiebreakOwed",
  fair_play: "externalPlay.held.fairPlay",
  account_changed: "externalPlay.held.accountChanged",
};

export type HeldCopyInput = {
  reason: NeedsReason;
  /** V442: the seat a token_revoked hold froze. */
  revokedSeat: "white" | "black" | "both" | null;
  whiteName: string;
  blackName: string;
};

/** The sentence's key and the name it carries, if any. A no-show names the
 *  colour that stayed away; a revoked token names the seat V442 recorded —
 *  never a no-show (design §3.6) — and an unknown seat names nobody. */
export function heldBody(row: HeldCopyInput): { key: DictionaryKey; vars?: { name: string } } {
  switch (row.reason) {
    case "no_show_white":
      return { key: "externalPlay.reason.noShowWhite", vars: { name: row.whiteName } };
    case "no_show_black":
      return { key: "externalPlay.reason.noShowBlack", vars: { name: row.blackName } };
    case "no_show_both":
      return { key: "externalPlay.reason.noShowBoth" };
    case "not_started":
      return { key: "externalPlay.reason.notStarted" };
    case "aborted":
      return { key: "externalPlay.reason.abort" };
    case "mismatch":
      return { key: "externalPlay.reason.accountMismatch" };
    case "provider_error":
      return { key: "externalPlay.reason.providerError" };
    case "token_revoked":
      switch (row.revokedSeat) {
        case "white":
          return { key: "externalPlay.reason.tokenRevokedWhite", vars: { name: row.whiteName } };
        case "black":
          return { key: "externalPlay.reason.tokenRevokedBlack", vars: { name: row.blackName } };
        case "both":
          return { key: "externalPlay.reason.tokenRevokedBoth" };
        case null:
          return { key: "externalPlay.reason.tokenRevoked" };
      }
    // falls through only if V442's seat vocabulary grows — tsc refuses that
    case "double_walkover_blocked":
      return { key: "externalPlay.reason.doubleWalkoverBlocked" };
    case "create_outcome_unknown":
      return { key: "externalPlay.reason.createOutcomeUnknown" };
    case "tiebreak_owed":
      return { key: "externalPlay.reason.tiebreakOwed" };
    case "fair_play":
      return { key: "externalPlay.reason.fairPlay" };
    case "account_changed":
      return { key: "externalPlay.reason.accountChanged" };
  }
}

/** A held board's card on the division page: the run sheet's held chip
 *  links to it (`#external-play-queue-row-<id>`). */
export const queueRowAnchor = (fixtureId: string) => `external-play-queue-row-${fixtureId}`;

/** The names by colour, from the sides the server reads: the queue names the
 *  players as the canvas does (by colour); the settle sends a side. */
export function namesByColour(row: { whiteSide: "home" | "away"; homeName: string; awayName: string }): { whiteName: string; blackName: string } {
  return row.whiteSide === "home"
    ? { whiteName: row.homeName, blackName: row.awayName }
    : { whiteName: row.awayName, blackName: row.homeName };
}
