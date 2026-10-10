// The vocabulary of the organiser's Open round (D12, T19), client-safe on
// purpose: the server usecase (`server/usecases/external-play/open-round.ts`)
// answers in these words and the organiser control (T16) renders them, so the
// two read ONE list rather than each spelling the reasons out. Every member
// carries its copy key here; `open-round-copy.test.ts` sweeps every member
// against all four locales.
import type { DictionaryKey } from "@/lib/i18n-keys";

/** Why a round was NOT opened. Each is refused before anything is written —
 *  no stamp, no invite. */
export const OPEN_ROUND_REFUSALS = ["no_fixtures", "not_paired", "division_not_started", "clock_not_playable"] as const;
export type OpenRoundRefusal = (typeof OPEN_ROUND_REFUSALS)[number];

/** Why one board of an opened round was not invited. Reported per fixture. */
export const OPEN_ROUND_SKIP_REASONS = ["window_closed", "send_failed"] as const;
export type OpenRoundSkipReason = (typeof OPEN_ROUND_SKIP_REASONS)[number];

export type OpenRoundSkip = { fixtureId: string; reason: OpenRoundSkipReason };

export type OpenRoundResult =
  /** This call stamped the round, or invited (or tried to invite) someone not
   *  yet invited. `invited` counts SEATS whose invite was accepted by the
   *  provider — two per board — never boards. */
  | { opened: true; invited: number; skipped: OpenRoundSkip[] }
  /** Already open and nothing left that can be invited. `skipped` names the
   *  boards that could not be (a closed window). */
  | { opened: false; reason: "already_open"; skipped: OpenRoundSkip[] }
  | { opened: false; reason: OpenRoundRefusal };

/** `invited` is a count: render through the plural helper (`.one`/`.other`). */
export const OPEN_ROUND_INVITED_KEY = "externalPlay.openRound.invited";

export const OPEN_ROUND_ALREADY_OPEN_KEY: DictionaryKey = "externalPlay.openRound.alreadyOpen";

export const OPEN_ROUND_REFUSAL_KEYS: Readonly<Record<OpenRoundRefusal, DictionaryKey>> = {
  no_fixtures: "externalPlay.openRound.noFixtures",
  not_paired: "externalPlay.openRound.notPaired",
  division_not_started: "externalPlay.openRound.divisionNotStarted",
  clock_not_playable: "externalPlay.openRound.clockNotPlayable",
};

export const OPEN_ROUND_SKIP_KEYS: Readonly<Record<OpenRoundSkipReason, DictionaryKey>> = {
  window_closed: "externalPlay.openRound.skipped.windowClosed",
  send_failed: "externalPlay.openRound.skipped.sendFailed",
};

/** A re-pair (Swiss unpair, or the pre-Start delete-entrant that unpairs) is
 *  refused while a game stands — or may stand — behind any board it would
 *  clear (controller ruling, 2026-10-10). The organiser voids the game first. */
export const ONLINE_GAME_EXISTS_CODE = "ONLINE_GAME_EXISTS";
export const ONLINE_GAME_EXISTS_KEY: DictionaryKey = "externalPlay.onlineGameExists";

/** The resend's refusals beyond the board's own (review M6, fix round 1): the
 *  round's window closed (T+20), or the board is held for the organiser. A
 *  board a game stands behind answers `ONLINE_GAME_EXISTS_CODE`. */
export const RESEND_WINDOW_CLOSED_CODE = "WINDOW_CLOSED";
export const RESEND_BOARD_HELD_CODE = "BOARD_HELD";
export const RESEND_REFUSAL_KEYS: Readonly<Record<"WINDOW_CLOSED" | "BOARD_HELD", DictionaryKey>> = {
  WINDOW_CLOSED: "externalPlay.resend.windowClosed",
  BOARD_HELD: "externalPlay.resend.boardHeld",
};
