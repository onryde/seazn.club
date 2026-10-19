// The check-in extension (spec 2026-10-09 §3.2.2; owner-approved 2026-10-19): the arbiter adds time to a board's check-in while
// it is still open - per board, and for a whole round. Client-safe on purpose (nothing server-only): the server rule
// (`server/external-play/window.ts` `extendRefusal`, `usecases/external-play/checkin-extend.ts`) and the two screens that
// offer it (the arbiter panel, the organiser's Open round control) read ONE vocabulary here.
// Relative with `.ts`, not "@/…": api-v1/schemas.ts imports this file, so it is also compiled under tsconfig.scripts.json
// (nodenext), which refuses an extensionless specifier - the convention of every file in that chain.
import type { DictionaryKey } from "./i18n-keys.ts";

/** Declared once, here (owner, 2026-10-19: +5 minutes a press, three presses at most). `server/external-play/window.ts`
 *  re-exports them and builds the board's deadline from them; no other file spells either number. */
export const CHECKIN_EXTEND_STEP_MS = 5 * 60_000;
export const CHECKIN_EXTEND_MAX = 3;
/** The step in whole minutes, for a label ("+5 min"). Derived, never retyped. */
export const CHECKIN_EXTEND_STEP_MINUTES = CHECKIN_EXTEND_STEP_MS / 60_000;

/** How many presses a board has left. A count past the cap (a row that somehow holds more) reads none left. */
export function extensionsLeft(used: number): number {
  return Math.max(0, CHECKIN_EXTEND_MAX - used);
}

/** Why ONE board's check-in may not be extended now. One word per reason, each its own 409 code at the door. */
export const EXTEND_REFUSALS = ["not_playable", "game_started", "closed", "not_open", "cap_reached"] as const;
export type ExtendRefusal = (typeof EXTEND_REFUSALS)[number];

/** The 409 code of each refusal (single board). `FIXTURE_NOT_PLAYABLE` is the arbiter's own word for a board that is over. */
export const EXTEND_REFUSAL_CODES: Readonly<Record<ExtendRefusal, string>> = {
  not_playable: "FIXTURE_NOT_PLAYABLE",
  game_started: "CHECKIN_GAME_STARTED",
  closed: "CHECKIN_CLOSED",
  not_open: "CHECKIN_NOT_OPEN",
  cap_reached: "CHECKIN_EXTEND_CAP",
};

/** The copy of each refusal, for the panel that shows it. */
export const EXTEND_REFUSAL_KEYS: Readonly<Record<ExtendRefusal, DictionaryKey>> = {
  not_playable: "externalPlay.checkinExtend.refused.notPlayable",
  game_started: "externalPlay.checkinExtend.refused.gameStarted",
  closed: "externalPlay.checkinExtend.refused.closed",
  not_open: "externalPlay.checkinExtend.refused.notOpen",
  cap_reached: "externalPlay.checkinExtend.refused.capReached",
};

/** A board's check-in as the screens read it: whether a press would be accepted NOW, how many presses it has left and the
 *  deadline it is on (ISO). The server's one reading (`extendRefusal`), never re-derived on the client. */
export type CheckinExtendState = {
  canExtend: boolean;
  /** Why not, when not. null exactly when `canExtend`. */
  refusal: ExtendRefusal | null;
  extensionsLeft: number;
  /** The board's effective deadline: `T_batch + DEADLINE_AFTER_MS` plus every press so far. */
  deadlineAt: string;
};

/** The answer to ONE board's press. */
export type CheckinExtendBoardResult = {
  fixtureId: string;
  /** Presses made on this board, this one included. */
  extensions: number;
  extensionsLeft: number;
  /** Minutes this press added. */
  addedMinutes: number;
  /** The board's new deadline (ISO). */
  deadlineAt: string;
};

/** The answer to a ROUND-wide press: one action, the same rule on every board, each board its own atomic step. Not-yet-open
 *  batches are untouched and counted apart (`notOpenYet`); a board the caller plays on is never touched (C1) and counted too
 *  (`ownBoards`). `failed` is a board whose step threw (logged; the rest went on). Every board of the round that is played online
 *  lands in exactly one of `extended`, `skipped.*`, `notOpenYet`, `ownBoards` or `failed`, apart from a settled board with no
 *  game on file (a withdrawn or voided one), which is not a board that has anything to extend. */
export type CheckinExtendRoundResult = {
  extended: number;
  skipped: { closed: number; gameStarted: number; capReached: number };
  notOpenYet: number;
  ownBoards: number;
  failed: number;
  /** Minutes each extended board was given. */
  addedMinutes: number;
};

/** The sentence parts, in the order the result line says them. A reason is said only when its count is above zero. */
export const EXTEND_ROUND_SKIP_KEYS = ["closed", "gameStarted", "capReached"] as const;
export type ExtendRoundSkipKey = (typeof EXTEND_ROUND_SKIP_KEYS)[number];

/** The plural BASE key of each line the result says about boards left alone (`<base>.one` / `<base>.other`, read with `plural`). */
export const EXTEND_ROUND_SKIP_COPY: Readonly<Record<ExtendRoundSkipKey | "notOpenYet" | "ownBoards" | "failed", string>> = {
  closed: "externalPlay.checkinExtend.skip.closed",
  gameStarted: "externalPlay.checkinExtend.skip.gameStarted",
  capReached: "externalPlay.checkinExtend.skip.capReached",
  notOpenYet: "externalPlay.checkinExtend.skip.notOpenYet",
  ownBoards: "externalPlay.checkinExtend.skip.ownBoards",
  failed: "externalPlay.checkinExtend.skip.failed",
};

/** How many boards a round-wide press would extend right now, at a glance: the count the round button is offered on. */
export type RoundExtendOffer = { extendableBoards: number };
