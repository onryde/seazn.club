// Match Day - the online chess rounds' pure rules (plan 2026-11-05-match-day-all-in-one.md Task 1; spec
// 2026-11-05-match-day-all-in-one-design.md §5.1 rows, §5.2 order, §5.5 boards from earlier rounds, §6.4 who sees what).
// Client-safe and DOM-free (no value import from server/**), so the node-environment suite reaches every decision the list and the two
// panels make: which phase a round is in, where it sits in the list, what its row and its boards' rows say, which row a `?round=` or a
// `?board=` opens, and who may press what.
//
// The round-column rules (lib/round-column.ts) are the one authority for the check-in clock, the tallies and what "playing" means; this
// file asks them over `round.boards` (an `ArbiterBoard[]`, so no adaptation) and never re-derives a window edge or a count.
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import { boardsOwedAnInvite, checkinClock, checkinTally, playingTally } from "@/lib/round-column";
import type { MatchDayBoardRow, MatchDayOnlineRound, OnlineRoundPhase } from "./types";

// ---- phase and order (§5.2) -------------------------------------------------------------------------------------------------------

/** The server's `phase`, re-read from `round.boards` for the page's ticking clock (the poll is up to 20 s apart, and a window's deadline
 *  moves nothing in the data). A division not started stays `not_started`; a round with no boards on screen is `before` whatever else it
 *  was called (nothing can be checking in; a producer that says otherwise is contradicting itself, and the row reads as not opened); a
 *  round with boards is `checkin` while the column's check-in clock (`checkinClock`) has a window open or still to open, else `playing`.
 *  So a board still `checking_in` after its window has run out (the sweep has not turned it yet) is in a round that is `playing`: the
 *  clock has nothing to count down, and the tally says who is playing. With no clock yet (`nowMs` null: the server render, the first
 *  client paint) the snapshot's word stands, as every other reader of a window reads it. */
export function onlineRoundPhase(r: Pick<MatchDayOnlineRound, "view" | "round" | "phase">, nowMs: number | null): OnlineRoundPhase {
  if (r.phase === "not_started") return "not_started";
  if (r.round === null) return "before";
  return checkinClock(r.round.boards, nowMs).kind === "closed" ? "playing" : "checkin";
}

/** Every board decided and none owed its invite again. Never true of a round with no board on screen: the viewer plays on all of them,
 *  and the empty set must not read as "finished" (the empty set answers yes to every "all of them" question). A held board is not
 *  decided (it waits for the organiser) and a board that paints as over but is owed an invite (a re-armed No result) is `waiting`, which
 *  `playingTally` takes out of `finished`. */
function roundIsOver(round: ArbiterRound, owed: ReturnType<typeof boardsOwedAnInvite>): boolean {
  const tally = playingTally(round.boards, owed);
  return tally.total > 0 && tally.finished === tally.total;
}

/** The list's three groups of online rounds (§5.2): 0 in check-in or in progress (a board playing, held or owed its invite), 1 paired and
 *  not opened (a division not started sits here too: it too waits for an open), 2 over. */
function groupOf(r: MatchDayOnlineRound, nowMs: number | null): 0 | 1 | 2 {
  const phase = onlineRoundPhase(r, nowMs);
  if (phase === "not_started" || phase === "before") return 1;
  if (phase === "checkin" || r.round === null) return 0;
  return roundIsOver(r.round, boardsOwedAnInvite(r.view)) ? 2 : 0;
}

/** Check-in or in progress first, then rounds not opened, then rounds over; the order the server gave (divisions in competition order,
 *  a division's stages in order) kept inside a group. A new array; the input is not touched. */
export function orderOnlineRounds(rounds: readonly MatchDayOnlineRound[], nowMs: number | null): MatchDayOnlineRound[] {
  return rounds
    .map((r, i) => ({ r, i, g: groupOf(r, nowMs) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.r);
}

// ---- the words (§5.1) -------------------------------------------------------------------------------------------------------------

/** What a round row says on the right, as data (the copy is the component's, in four locales):
 *  - `closes`: check-in, the NEXT window to close (`checkinClock`) and the seats here of the seats being waited on (`checkinTally`);
 *  - `playing`: boards playing of the boards on screen (`playingTally`); also what a round in check-in says while no window has a
 *    deadline to name (a later group still to open), and a round whose every board is the viewer's own (`total` 0);
 *  - `paired`: paired, not opened; `not_started`: the division has not started; `over`: every board decided. */
export type RoundRowWord =
  | { kind: "closes"; at: string; here: number; seats: number }
  | { kind: "playing"; playing: number; total: number }
  | { kind: "paired" }
  | { kind: "not_started" }
  | { kind: "over" };

export function roundRowWord(r: MatchDayOnlineRound, nowMs: number | null): RoundRowWord {
  const phase = onlineRoundPhase(r, nowMs);
  if (phase === "not_started") return { kind: "not_started" };
  if (phase === "before" || r.round === null) return { kind: "paired" };
  const boards = r.round.boards;
  if (phase === "checkin") {
    const clock = checkinClock(boards, nowMs);
    if (clock.kind === "closes") {
      const tally = checkinTally(boards, nowMs);
      return { kind: "closes", at: clock.at, here: tally.here, seats: tally.seats };
    }
  }
  if (roundIsOver(r.round, boardsOwedAnInvite(r.view))) return { kind: "over" };
  const tally = playingTally(boards, boardsOwedAnInvite(r.view));
  return { kind: "playing", playing: tally.playing, total: tally.total };
}

/** What a board row says on the right, as data. `on_hold` carries the board's open-flag COUNT (`flagCount`, never the card list: the list
 *  read leaves the cards out) and so does `cancelled`, which reaches the list only through `needs_decision`, while it has an open flag
 *  (owner O1, 2026-11-17). A hold is a hold whatever its reason: `ArbiterBoardState` carries none (the loader reads `on_hold` from the
 *  bridge status alone), so a link hold (`lichess_unlinked`, `lichess_reconnect`) reads as any other. */
export type BoardRowWord =
  | { kind: "checking_in" }
  | { kind: "starting" }
  | { kind: "live"; moveNo: number }
  | { kind: "on_hold"; flags: number }
  | { kind: "result"; score: string | null }
  | { kind: "no_result" }
  | { kind: "cancelled"; flags: number };

export function boardRowWord(b: MatchDayBoardRow): BoardRowWord {
  const state = b.state;
  switch (state.kind) {
    case "checking_in":
      return { kind: "checking_in" };
    case "starting":
      return { kind: "starting" };
    case "live":
      return { kind: "live", moveNo: state.moveNo };
    case "on_hold":
      return { kind: "on_hold", flags: b.flagCount };
    case "result":
      return state.noResult ? { kind: "no_result" } : { kind: "result", score: state.score };
    case "cancelled":
      return { kind: "cancelled", flags: b.flagCount };
  }
}

/** The mark by a player's name (§5.1): `here` a current peer in the player's room; `off` present with the camera reported off; `away`
 *  nobody there (a pre-minted room is a meeting row and nothing more); null when the board's camera policy is off. Read from the side's
 *  PRESENCE and reported camera only - never `joinable`, which is whether a join would be admitted, not whether the player is there.
 *  `side` is the seat (`home`/`away`, the key of `board.sides`), not the colour: a row names White first, so the caller maps the colour
 *  through `board.whiteSide`. */
export type PresenceMark = "here" | "off" | "away" | null;

export function presenceMark(b: MatchDayBoardRow, side: "home" | "away"): PresenceMark {
  if (b.cameraPolicy === "off") return null;
  const meeting = b.sides[side];
  if (!meeting.presence.present) return "away";
  return meeting.camera.state === "off" ? "off" : "here";
}

// ---- focus (§5.5, §7) -------------------------------------------------------------------------------------------------------------

/** What the organiser opened, with its name to say so if it leaves the list: a round by its key, a board by its fixture id. */
export type OnlineOpened = { kind: "round"; key: string; name: string } | { kind: "board"; id: string; name: string };

/** What is focused: the round or board that was opened while it is still on the list; a board with the round row it sits under;
 *  something that was opened and is gone `lost`, named; nothing opened `none` (the default focus is the shell's). */
export type OnlineFocus =
  | { kind: "round"; round: MatchDayOnlineRound }
  | { kind: "board"; round: MatchDayOnlineRound; board: MatchDayBoardRow }
  | { kind: "lost"; name: string }
  | { kind: "none" };

/** A board is found in some row's `round.boards` first (a board of the listed round appears once, in its round, §5.5), then in a row's
 *  `needs_decision` (a held or flagged board of an earlier round). A board in neither - one the viewer plays on, or one that left the
 *  list - is `lost`, never another board: an unknown id never falls back to the round's first. `lost` only for an `opened` that names
 *  something (the shell never makes one from an unknown `?board=` or `?round=`). */
export function resolveOnlineFocus(rounds: readonly MatchDayOnlineRound[], opened: OnlineOpened | null): OnlineFocus {
  if (opened === null) return { kind: "none" };
  if (opened.kind === "round") {
    const round = rounds.find((r) => r.key === opened.key);
    return round === undefined ? { kind: "lost", name: opened.name } : { kind: "round", round };
  }
  for (const round of rounds) {
    const found: ArbiterBoard | undefined = round.round?.boards.find((b) => b.fixtureId === opened.id);
    if (found !== undefined) return { kind: "board", round, board: { ...found, stage_id: round.stage_id, round_no: round.round_no } };
  }
  for (const round of rounds) {
    const board = round.needs_decision.find((b) => b.fixtureId === opened.id);
    if (board !== undefined) return { kind: "board", round, board };
  }
  return { kind: "lost", name: opened.name };
}

// ---- who may press (§6.4; owner O2 + O4, 2026-11-17) ------------------------------------------------------------------------------

/** The reader's three facts: `editor` (their role is in `EDITOR_ROLES`, `isEditorRole`), `offered` (the club is offered online chess,
 *  `onlineChessOffered`) and `frozen` (the competition is billing-frozen, `MatchDayCtx.frozen`). */
export type Reader = { editor: boolean; offered: boolean; frozen: boolean };

/** THE online press rule, one for Match Day and the division page's Held | Flagged queue (owner O2 + O4, 2026-11-17). Pure,
 *  client-safe (lib/), so both surfaces import it.
 *   - `start`: the presses that START play - open a round, resend invites, +5 on a board, +5 to the round - an editor in an offered club
 *     on a competition that is not frozen (Match Day's PB2 rule: a frozen competition keeps every write it guards except scoring);
 *   - `finish`: the decisions that FINISH play - resync, let the game go on, settle, let play without video - every editor, flag or
 *     freeze or neither: they write or unblock a RESULT, the scoring the freeze exempts;
 *   - `cameras`: watching writes nothing, so the freeze never touches it - an editor in an offered club. */
export function mayPress(reader: Reader, what: "start" | "finish" | "cameras"): boolean {
  switch (what) {
    case "start":
      return reader.editor && reader.offered && !reader.frozen;
    case "finish":
      return reader.editor;
    case "cameras":
      return reader.editor && reader.offered;
  }
}
