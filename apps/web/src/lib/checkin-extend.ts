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

/** A board's check-in as the screens read it: whether a press would be accepted at the SNAPSHOT's clock, why not, how many presses
 *  it has left and the window it is on (ISO). The server's one reading (`extendRefusal`); a screen that keeps showing it after the
 *  snapshot was taken re-asks the CLOCK through `liveExtendRefusal`, never the rule. */
export type CheckinExtendState = {
  canExtend: boolean;
  /** Why not, when not. null exactly when `canExtend`. */
  refusal: ExtendRefusal | null;
  extensionsLeft: number;
  /** When the board's check-in opens (window.ts `windowFor`: a later batch opens AT its start, batch 0 ten minutes before it). */
  opensAt: string;
  /** The board's effective deadline: `T_batch + DEADLINE_AFTER_MS` plus every press so far. */
  deadlineAt: string;
};

/** The two instants a board's press is allowed between - `opensAt <= now < deadlineAt` - and the presses it has left. A board that
 *  nothing but the clock stands in the way of a press: still to be played, no game on file, not closed. One with no presses left
 *  (`extensionsLeft` 0) is in the list too, so that a screen's reading of it follows the clock as the server's does (no extensions
 *  left while its window runs, closed from its deadline on) - but it is never counted as a board a press would reach. */
export type ExtendWindow = { opensAt: string; deadlineAt: string; extensionsLeft: number };

/** Is `nowMs` inside the window - the opening included, the deadline excluded (window.ts `roomPhase`: "open" from `opensAt`,
 *  "closed" from the deadline on). */
export function inExtendWindow(w: ExtendWindow, nowMs: number): boolean {
  return Date.parse(w.opensAt) <= nowMs && nowMs < Date.parse(w.deadlineAt);
}

/** What a screen shows on a board's check-in on a TICKING clock. The snapshot says why a press was refused when it was read; the
 *  clock keeps moving (the screen's poll is up to 20 s apart), and the owner's rule is that +5 is offered only INSIDE the window -
 *  hidden before the opening and from the deadline on, to the millisecond. The board's own state (a game on file, a board that is
 *  over) is the snapshot's word, which a clock cannot change; the window is the clock's. A snapshot that said `closed` stays closed
 *  (a deadline only moves later while the window is open). Equal to the server's `extendRefusal` at `nowMs` for every
 *  `nowMs` at or after the snapshot's own (checkin-extend-live.test.ts runs the two against each other). */
export function liveExtendRefusal(c: Pick<CheckinExtendState, "refusal" | "extensionsLeft" | "opensAt" | "deadlineAt">, nowMs: number): ExtendRefusal | null {
  if (c.refusal === "not_playable" || c.refusal === "game_started" || c.refusal === "closed") return c.refusal;
  if (nowMs >= Date.parse(c.deadlineAt)) return "closed";
  if (nowMs < Date.parse(c.opensAt)) return "not_open";
  return c.extensionsLeft === 0 ? "cap_reached" : null;
}

/** How many of a round's windows a round-wide press reaches at `nowMs`: the ones the instant is inside, that have a press left. */
export function liveExtendableCount(windows: readonly ExtendWindow[], nowMs: number): number {
  return windows.filter((w) => w.extensionsLeft > 0 && inExtendWindow(w, nowMs)).length;
}

/** The windows of the boards whose answer the CLOCK can still change: not the ones a game, a result or a closed window already settled
 *  (`liveExtendRefusal` returns the snapshot's word for those, whatever the time). */
export function watchedWindows(checkins: readonly (CheckinExtendState | null)[]): ExtendWindow[] {
  return checkins.flatMap((c) => (c === null || c.refusal === "not_playable" || c.refusal === "game_started" || c.refusal === "closed" ? [] : [c]));
}

/** The instants (epoch ms) at which a window changes what a screen may offer: its opening and its deadline. A screen schedules its
 *  next re-read on the nearest one ahead (`nextExtendEdge`), so the +5 button arrives and leaves AT the edge, not at the next tick. */
export function extendEdgesOf(windows: readonly ExtendWindow[]): number[] {
  return [...new Set(windows.flatMap((w) => [Date.parse(w.opensAt), Date.parse(w.deadlineAt)]))].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

/** The first edge STRICTLY after `nowMs` (an edge at `nowMs` has already happened: the opening is included, the deadline is out), or
 *  null when every edge is behind. */
export function nextExtendEdge(edges: readonly number[], nowMs: number): number | null {
  let best: number | null = null;
  for (const e of edges) if (e > nowMs && (best === null || e < best)) best = e;
  return best;
}

/** The short reason shown where the +5 button is not offered (owner, 2026-10-19): check-in not opened, closed, a game started, no
 *  extensions left. Each is one sentence that says what cannot be done and why ("Can't extend check-in: a game has started", phase 2
 *  Task 11), because the round column shows it with no button beside it. `not_playable` (a board that is over) says nothing: it has no check-in to speak of. Every
 *  refusal is a key of this table, so a sixth reason cannot be added without choosing its words (or choosing silence) here. */
export const EXTEND_WHY_KEYS: Readonly<Record<ExtendRefusal, DictionaryKey | null>> = {
  not_playable: null,
  game_started: "externalPlay.checkinExtend.why.gameStarted",
  closed: "externalPlay.checkinExtend.why.closed",
  not_open: "externalPlay.checkinExtend.why.notOpen",
  cap_reached: "externalPlay.checkinExtend.why.capReached",
};

/** The reason a round has no "+5 min to the round" to offer (owner, 2026-10-19): when every board that has a reason says the SAME one,
 *  that reason's own words (`EXTEND_WHY_KEYS`); when they differ, the one sentence that is true of all of them. */
export const EXTEND_ROUND_MIXED_WHY_KEY: DictionaryKey = "externalPlay.checkinExtend.why.roundNoneOpen";

/** What a round says in place of its button: the `data-why` code (a refusal, or `mixed`) and the dictionary key of its words. */
export type RoundWhy = { code: ExtendRefusal | "mixed"; key: DictionaryKey };

/** The reason a round-wide press has nothing to reach, from each board's refusal at the instant asked (`null`: that board would accept
 *  a press). Null when ANY board would accept one (the round has its button, and a button needs no reason), and when no board has a
 *  reason to speak of: a round that lists no boards, and one whose every board is over (`not_playable` is silent, as it is on the
 *  board). Boards that are over are left out of the count: "a game has started" is true of a round whose boards are all either started or over. */
export function roundWhy(refusals: Iterable<ExtendRefusal | null>): RoundWhy | null {
  const spoken = new Set<ExtendRefusal>();
  for (const r of refusals) {
    if (r === null) return null;
    if (EXTEND_WHY_KEYS[r] !== null) spoken.add(r);
  }
  if (spoken.size === 0) return null;
  if (spoken.size > 1) return { code: "mixed", key: EXTEND_ROUND_MIXED_WHY_KEY };
  const [only] = [...spoken] as [ExtendRefusal];
  return { code: only, key: EXTEND_WHY_KEYS[only]! };
}

/** A round's boards by the refusal the server gave each (`extendRefusal` at the snapshot), counted per cause. */
export type ExtendTally = Record<ExtendRefusal, number>;
export const emptyExtendTally = (): ExtendTally => ({ not_playable: 0, game_started: 0, closed: 0, not_open: 0, cap_reached: 0 });

/** Every board of an Open round view as one refusal at `nowMs`: the boards outside `windows` as the server's tally counted them (no tick
 *  of a clock changes why a game is on file, a board is over, or a window has closed), and each window board as the clock judges it
 *  (`liveExtendRefusal`, the arbiter panel's own function: ahead of its opening `not_open`, inside it `null` - it would accept a
 *  press - or `cap_reached` when it has none left, and past its deadline `closed`). `nowMs` null (the viewer's clock is not known yet):
 *  the windows read as the snapshot saw them, and a window with presses left that the snapshot saw OPEN would have made the server's
 *  own count non-zero, which is a round that has its button and is never asked for a reason. */
export function liveRoundRefusals(tally: Readonly<Record<ExtendRefusal, number>>, windows: readonly ExtendWindow[], nowMs: number | null): (ExtendRefusal | null)[] {
  const out: (ExtendRefusal | null)[] = [];
  for (const r of EXTEND_REFUSALS) for (let i = 0; i < tally[r]; i++) out.push(r);
  for (const w of windows) {
    out.push(nowMs === null ? (w.extensionsLeft === 0 ? "cap_reached" : "not_open") : liveExtendRefusal({ refusal: null, ...w }, nowMs));
  }
  return out;
}

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
