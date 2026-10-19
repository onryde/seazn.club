// The vocabulary of the organiser's Open round (D12, T19), client-safe on
// purpose: the server usecase (`server/usecases/external-play/open-round.ts`)
// answers in these words and the organiser control (T16) renders them, so the
// two read ONE list rather than each spelling the reasons out. Every member
// carries its copy key here; `open-round-copy.test.ts` sweeps every member
// against all four locales.
// Relative with `.ts`, not "@/…": api-v1/schemas.ts imports this file, so it is
// also compiled under tsconfig.scripts.json (nodenext), which refuses an
// extensionless specifier — the convention of every file in that chain.
import type { DictionaryKey } from "./i18n-keys.ts";
import type { ExtendWindow } from "./checkin-extend.ts";

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

/** T16 — what an Open press on this round would do, predicted by the reader
 *  (`listOpenRounds`) from the same facts `openRound` decides on:
 *  - `open`: never opened — stamp it, invite everyone, start the window now;
 *  - `reopen`: opened, but nobody it reached is still bound (every send
 *    failed, or a re-pair cleared the rows) — the window starts again now;
 *  - `reinvite`: opened and under way — invite only who is still owed, inside
 *    the round's own window (its deadline does not move);
 *  - `none`: nobody left to invite, or the window has closed on them. */
export type OpenRoundPress = "open" | "reopen" | "reinvite" | "none";

/** One pairing of the round, by colour. */
export type OpenRoundPairing = {
  fixtureId: string;
  boardNo: number;
  whiteName: string;
  blackName: string;
  /** The latest seat stamp this round's open wrote on the board (ISO), or
   *  null when no seat of it has been invited. */
  invitedAt: string | null;
  /** Seats an Open press would invite now (0–2): a seat not yet stamped, on a
   *  board that still takes invites. */
  owedSeats: 0 | 1 | 2;
  /** The invite can be sent again (`/resend`): invited, no game behind it,
   *  inside the round's window. */
  canResend: boolean;
};

/** One check-in batch of a round (spec §3.2.1): boards `fromBoard`..`toBoard` (their board numbers), which open
 *  `offsetMs` after the Open press and, once the round is open, at `opensAt`..`closesAt`. A round that does not stagger is
 *  one batch of every board. */
export type OpenRoundBatch = {
  fromBoard: number;
  toBoard: number;
  offsetMs: number;
  opensAt: string | null;
  closesAt: string | null;
};

export type OpenRoundView = {
  stageId: string;
  stageName: string;
  roundNo: number;
  /** `paired`: no open stamp yet (`isRoundPaired`); `open`: stamped. */
  state: "paired" | "open";
  openedAt: string | null;
  /** When a player who has not taken their seat is reported: the LAST batch's open plus the window (the round is closed
   *  when its last batch has closed); on a re-invite press, the earliest deadline among the boards it would still invite.
   *  Null before the open. */
  deadlineAt: string | null;
  /** Minutes from a batch's open to its deadline (window.ts DEADLINE_AFTER_MS). */
  windowMinutes: number;
  /** Whether this round's check-in runs in timed batches: the flag the open STORED, or - before the open - what the stage's
   *  camera policy would store now (spec §3.2.1). */
  staggered: boolean;
  /** The batches, in order (at least one). More than one only for a staggered round of more than one batch of boards. */
  batches: OpenRoundBatch[];
  /** Minutes from the Open press to the LAST batch's start: `(batches - 1) × gap`, rounded UP (never less than the truth).
   *  0 for a round of one batch. */
  staggerSpanMinutes: number;
  /** The earliest scheduled time on the round's boards — only what players
   *  were shown — or null when none carries one. */
  scheduledAt: string | null;
  press: OpenRoundPress;
  pairings: OpenRoundPairing[];
  /** Spec §3.2.2: how many of this round's boards a round-wide "+N min" would extend right now (check-in open, no game on
   *  file, under the cap, not a board the viewer plays on). 0 before the open. The control offers the button above zero. */
  extendableBoards: number;
  /** Spec §3.2.2 (owner, 2026-10-19: +5 only inside the check-in window): for each board a round-wide press could reach if only the
   *  clock allowed it, the instants it is allowed between. The control counts them on its ticking clock, so the button appears at a
   *  board's opening and goes at its deadline without waiting for the next refresh. `extendableBoards` is this list at the snapshot. */
  extendWindows: ExtendWindow[];
  /** T16 fix round 1, R1 — this stage's EARLIER rounds that still have games in play (a paired board still to be
   *  played), lowest round first; empty when none. Opening is still allowed (the organiser drives; D8 never blocks):
   *  the confirmation names them so the press is made knowingly. */
  earlierInPlay: { roundNo: number; games: number }[];
};

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

/** A re-pair (Swiss unpair, Rebuild, or the delete-entrant that unpairs) is
 *  refused while a game stands — or may stand — behind any board it would
 *  clear (controller ruling, 2026-10-10). There is no "void" that unblocks it:
 *  the organiser's way out is settling the board in the arbiter panel (T16),
 *  which decides it, and a round with a decided board stays paired. */
export const ONLINE_GAME_EXISTS_CODE = "ONLINE_GAME_EXISTS";
export const ONLINE_GAME_EXISTS_KEY: DictionaryKey = "externalPlay.onlineGameExists";

/** Whether an organiser action's refusal is that one (T16): the panels show
 *  `OnlineGameExistsNotice` for it instead of the server's English. */
export function isOnlineGameExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === ONLINE_GAME_EXISTS_CODE;
}

/** The resend's refusals beyond the board's own (review M6, fix round 1): the
 *  round's window closed (DEADLINE_AFTER_MS), or the board is held for the organiser. A
 *  board a game stands behind answers `ONLINE_GAME_EXISTS_CODE`. */
export const RESEND_WINDOW_CLOSED_CODE = "WINDOW_CLOSED";
export const RESEND_BOARD_HELD_CODE = "BOARD_HELD";
export const RESEND_REFUSAL_KEYS: Readonly<Record<"WINDOW_CLOSED" | "BOARD_HELD", DictionaryKey>> = {
  WINDOW_CLOSED: "externalPlay.resend.windowClosed",
  BOARD_HELD: "externalPlay.resend.boardHeld",
};
