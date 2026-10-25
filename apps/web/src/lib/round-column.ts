// The Arbiter Panel round column's model (spec 2026-10-24-arbiter-round-column-design.md §5.2, §5.3, §5.5, §5.6, §8): which
// phase the column is in, the check-in clock, the tallies, the queue's attention count, where a "Review board" goes, the
// Fixtures-tab entry line and the next-round views. Pure on purpose - no DB, no React, nothing server-only (the two server
// types below are type-only and erased) - so the column, the waiting list and the entry card all read ONE answer, and a
// client component can import it.
//
// The check-in window is the one authority of lib/checkin-extend.ts: `inExtendWindow` says whether an instant is inside it (opening
// included, deadline excluded) and `liveExtendRefusal` says "not_open" for one still ahead of its opening. Nothing here parses an
// edge of it itself.
import type { ArbiterBoard, ArbiterBoardState, ArbiterRound } from "./arbiter-view.ts";
import { boardIsOver } from "./arbiter-view.ts";
import type { CheckinExtendState } from "./checkin-extend.ts";
import type { DictionaryKey } from "./i18n-keys.ts";
import { inExtendWindow, liveExtendRefusal } from "./checkin-extend.ts";
import type { OpenRoundView } from "./open-round.ts";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";

// ---- phase (§5.2) ---------------------------------------------------------------------------------------------

export type RoundColumnPhase = "none" | "before" | "checkin" | "playing";

/** A ladder whose order is part of its meaning, empty case stated by the first rungs:
 *   1. the page said "not here" or "you play on it" (`requested`): no column, the panel's notice stands alone;
 *   2. no round of the division has been opened: before;
 *   3. some board on screen is `checking_in`: check-in;
 *   4. otherwise playing - every board over, and a round whose every board is your own (`boards` empty), included.
 *  A pinned older round (`current` false) takes its phase from the round on screen, like any other. */
export function roundColumnPhase(round: ArbiterRound | null, requested: "unavailable" | "own" | null): RoundColumnPhase {
  if (requested !== null) return "none";
  if (round === null) return "before";
  if (round.boards.some((b) => b.state.kind === "checking_in")) return "checkin";
  return "playing";
}

// ---- check-in: the open-window set, the clock and the tally (§5.3) ---------------------------------------------

/** A board known to have a check-in window: what `openWindowBoards` returns, so a caller reads `checkin` without a null branch. */
export type OpenWindowBoard = ArbiterBoard & { checkin: CheckinExtendState };

/** No clock yet (`nowMs` null - the server render and the first client paint): the SNAPSHOT's word stands, as every other reader of a
 *  window reads it (`boardExtendOffer`, `liveExtendableBoards`). `refusal` says where the board's window was when the page was read,
 *  and the window has exactly two words of its own: `not_open` (still ahead) and `closed` (past). Every other verdict - none,
 *  `cap_reached` (judged only INSIDE the window, window.ts `extendRefusal`), `game_started` (the board's state, not the window's:
 *  a create marker can be on file while the board is still `checking_in`) and `not_playable` (a board that is over, which
 *  `openWindowBoards` has already left out by state) - says nothing against the window, so the window is open. */
function windowOpen(c: CheckinExtendState, nowMs: number | null): boolean {
  return nowMs === null ? c.refusal !== "not_open" && c.refusal !== "closed" : inExtendWindow(c, nowMs);
}

/** The `checking_in` boards whose window is open now (`inExtendWindow` over `board.checkin`): the tally's set AND the waiting
 *  list's (pre-flight A6), so a later group's board is "Not here yet" in neither before its window opens. Board order is kept.
 *  A board with presses left or not is in its window either way: the cap is the +5's business, not the window's. */
export function openWindowBoards(boards: readonly ArbiterBoard[], nowMs: number | null): OpenWindowBoard[] {
  return boards.filter((b): b is OpenWindowBoard => b.state.kind === "checking_in" && b.checkin !== null && windowOpen(b.checkin, nowMs));
}

/** The three states of the one check-in clock:
 *   - `closes`: some window is open - the NEXT board to close, the earliest deadline among the open windows;
 *   - `opens`: no window is open but a later group is still to open - the earliest opening ahead;
 *   - `closed`: neither (no `checking_in` board, or every window has run out). */
export type CheckinClock = { kind: "closes"; at: string } | { kind: "opens"; at: string } | { kind: "closed" };

/** The earliest of some ISO instants. Callers pass a non-empty list of parseable ones. */
function earliest(isos: readonly string[]): string {
  return isos.reduce((best, t) => (Date.parse(t) < Date.parse(best) ? t : best));
}

export function checkinClock(boards: readonly ArbiterBoard[], nowMs: number | null): CheckinClock {
  const closing = openWindowBoards(boards, nowMs).map((b) => b.checkin.deadlineAt);
  if (closing.length > 0) return { kind: "closes", at: earliest(closing) };
  // Nothing is open. A group is "still to come" when the window's owner says it is not open YET (`not_open`); a group whose
  // deadline has passed reads `closed` there, and is not. With no clock yet the owner's word is the snapshot's.
  const coming = boards.flatMap((b) =>
    b.state.kind === "checking_in" && b.checkin !== null && (nowMs === null ? b.checkin.refusal : liveExtendRefusal(b.checkin, nowMs)) === "not_open"
      ? [b.checkin.opensAt]
      : [],
  );
  if (coming.length > 0) return { kind: "opens", at: earliest(coming) };
  return { kind: "closed" };
}

/** A board with a game under way: `starting` or `live`. A held board is the queue's, not "playing" (§5.3, §5.5). */
function isPlaying(state: ArbiterBoardState): boolean {
  return state.kind === "starting" || state.kind === "live";
}

/** A board held for the organiser (`fixture_external_play.status = needs_organiser`): the board the queue draws a held card for. The
 *  tally says so in a line of its own (Task 16 D7), so the boards it counts add up: playing, finished, held. */
function isHeld(state: ArbiterBoardState): boolean {
  return state.kind === "on_hold";
}

/** The hero's tally. `seats` is two for each open-window board; `here` the seats among them that have checked in (a board
 *  whose `seats` is null counts as not here); `playing`, `finished` and `held` are over EVERY board on screen. */
export type CheckinTally = { here: number; seats: number; playing: number; finished: number; held: number };

export function checkinTally(boards: readonly ArbiterBoard[], nowMs: number | null): CheckinTally {
  const open = openWindowBoards(boards, nowMs);
  const here = open.reduce((n, b) => n + (b.seats?.white.here ? 1 : 0) + (b.seats?.black.here ? 1 : 0), 0);
  const { playing, finished, held } = playingTally(boards);
  return { here, seats: open.length * 2, playing, finished, held };
}

// ---- playing (§5.5) -------------------------------------------------------------------------------------------

/** "{playing} of {total} boards playing", the finished clause and the held clause, over the boards on screen. A board is in at most one
 *  of the three, and a board still checking in is in none (`playing + finished + held + checking in = total`). */
export type PlayingTally = { playing: number; total: number; finished: number; held: number };

export function playingTally(boards: readonly ArbiterBoard[]): PlayingTally {
  return {
    playing: boards.filter((b) => isPlaying(b.state)).length,
    total: boards.length,
    finished: boards.filter((b) => boardIsOver(b.state)).length,
    held: boards.filter((b) => isHeld(b.state)).length,
  };
}

// ---- the queue (§5.6) -----------------------------------------------------------------------------------------

/** C6: the held rows that COUNT, the ones the organiser does not sit on. A seated held card is shown but never counted, and
 *  never colours the queue title. The one rule behind `attentionCount` and the title's red. */
export function countedHeld(held: readonly NeedsOrganiserExternalPlayRow[]): NeedsOrganiserExternalPlayRow[] {
  return held.filter((row) => !row.seated);
}

/** C6: the number of DISTINCT fixture ids over the counted held rows (`countedHeld`) and the flagged boards. A held board with
 *  an open flag is in both lists and counts once; a cancelled flagged board counts. Two callers, one call shape
 *  (`attentionCount(held, flagged)`): the column's title (`round-queue-cards.tsx`) and the Fixtures tab's entry card (the division
 *  page hands `entryStatus` this number), so the tab and the panel cannot count differently. */
export function attentionCount(held: readonly NeedsOrganiserExternalPlayRow[], flagged: readonly FlaggedBoard[]): number {
  const ids = new Set<string>();
  for (const row of countedHeld(held)) ids.add(row.fixtureId);
  for (const b of flagged) ids.add(b.fixtureId);
  return ids.size;
}

/** Where a card's "Review board" goes: `select` the board in place (it is in the round on screen), `link` to the arbiter page
 *  pinned to its round (any other board), or `none` (a board the organiser sits on, or a cancelled one, which can never be
 *  selected). `none` outranks the other two. */
export type ReviewTarget = { kind: "select" } | { kind: "link" } | { kind: "none" };

export function reviewTarget(fixtureId: string, round: ArbiterRound | null, card: { seated: boolean; cancelled: boolean }): ReviewTarget {
  if (card.seated || card.cancelled) return { kind: "none" };
  if (round !== null && round.boards.some((b) => b.fixtureId === fixtureId)) return { kind: "select" };
  return { kind: "link" };
}

// ---- the Fixtures-tab entry card (§8, C7) ---------------------------------------------------------------------

/** Attention and phase are separate facts (desk _RULES: "must never be collapsed into one enum"). `phase` is "checkin" when
 *  some round's check-in deadline is ahead, otherwise "ready" when some view's press is "open", otherwise "default";
 *  `roundNo` is the round that set the phase (null for "default"). */
export type EntryStatus = { attention: number; phase: "default" | "checkin" | "ready"; roundNo: number | null };

/** Check-in outranks ready: a league pairs every round at Generate, so a ready round exists beside a round in check-in.
 *  When several views qualify, the first in the reader's order (`listOpenRounds`: stage, then round) names the round.
 *  `deadlineAt` is THE check-in rule here: the producer leaves it null until the round is opened (`open-round-view.ts:279`,
 *  `openedAt === null` gives null; `OpenRoundView.deadlineAt` "Null before the open"), so a non-null deadline already means
 *  "opened" and `state` is not asked a second time. */
export function entryStatus(views: readonly OpenRoundView[], attention: number, nowMs: number): EntryStatus {
  const checkin = views.find((v) => v.deadlineAt !== null && Date.parse(v.deadlineAt) > nowMs);
  if (checkin) return { attention, phase: "checkin", roundNo: checkin.roundNo };
  const ready = views.find((v) => v.press === "open");
  if (ready) return { attention, phase: "ready", roundNo: ready.roundNo };
  return { attention, phase: "default", roundNo: null };
}

export type EntryLine =
  | { kind: "default" }
  | { kind: "attention"; count: number }
  | { kind: "checkin"; roundNo: number }
  | { kind: "ready"; roundNo: number };

/** The one line the entry card says, empty case first: nothing to say reads the card's existing body; a board that needs a
 *  decision outranks the phase (a red attention outranks the phase, as on the desk); then check-in; then ready. A phase with
 *  no round number to name cannot be said ("Round null"), so it falls to the default body. */
export function entryLine(s: EntryStatus): EntryLine {
  if (s.attention > 0) return { kind: "attention", count: s.attention };
  if (s.phase === "checkin" && s.roundNo !== null) return { kind: "checkin", roundNo: s.roundNo };
  if (s.phase === "ready" && s.roundNo !== null) return { kind: "ready", roundNo: s.roundNo };
  return { kind: "default" };
}

// ---- the round's views (§5.4, §5.5) ---------------------------------------------------------------------------

/** The open-round view of the round on screen, or null when `listOpenRounds` has none for it (no row then offers Resend). */
export function viewOfRound(views: readonly OpenRoundView[], round: Pick<ArbiterRound, "stageId" | "roundNo">): OpenRoundView | null {
  return views.find((v) => v.stageId === round.stageId && v.roundNo === round.roundNo) ?? null;
}

/** The views waiting for their Open (`press === "open"`), the round on screen excluded, in the reader's order. A pinned older
 *  round (`current` false) never offers the next round's press - the panel's N1 line offers the newer round - so it gets none.
 *  With no round on screen there is nothing to exclude and nothing pinned: every view waiting to open. */
export function nextRoundViews(views: readonly OpenRoundView[], round: ArbiterRound | null): OpenRoundView[] {
  if (round !== null && !round.current) return [];
  return views.filter((v) => v.press === "open" && !(round !== null && v.stageId === round.stageId && v.roundNo === round.roundNo));
}

// ---- the column's copy (§9, C19) --------------------------------------------------------------------------------

/** The stem of a plural pair: `foo` for `foo.one` / `foo.other`, the form `plural()` is called with. */
type PluralStem = DictionaryKey extends infer K ? (K extends `${infer S}.one` ? S : never) : never;

/** A dictionary key, or the stem of a plural pair. tsc refuses a key that is not in the dictionary, and a stem with no `.one`. */
export type ColumnKey = DictionaryKey | PluralStem;

/** Every key the column's own files (every component in components/v2/arbiter/) pass as a LITERAL to `msg(`, `plural(`, `t(` or
 *  `f.t(` (plural keys by their stem). round-column-copy.test.ts reads those files as text, from the directory listing, and refuses a
 *  literal that is not here; it sweeps every key here through all four locales and for dashes and arrows. What it does NOT see is a
 *  key the column asks for through a variable (`msg(map[reason])`): each such call is pinned by its text in the test and tied to the
 *  table that supplies it (the `HELPER` keys below), so a new one fails until it is pinned. A key listed here that the column no
 *  longer asks for only widens the sweep. */
export const ROUND_COLUMN_KEYS: readonly ColumnKey[] = [
  "arbiter.boardNo",
  "arbiter.colour.black",
  "arbiter.colour.white",
  "arbiter.column.alreadyPlaying",
  "arbiter.column.batchBoards",
  "arbiter.column.checkin.closed",
  "arbiter.column.checkin.closesIn",
  "arbiter.column.checkin.opensIn",
  "arbiter.column.checkin.tally",
  "arbiter.column.finished",
  "arbiter.column.here",
  "arbiter.column.label",
  "arbiter.column.notHereYet",
  "arbiter.column.nothingPaired",
  "arbiter.column.onHold",
  "arbiter.column.playing",
  "arbiter.column.queue",
  "arbiter.column.reopenConfirmCta",
  "arbiter.column.reopenConfirmTitle",
  "arbiter.column.reopenCta",
  "arbiter.column.review",
  "arbiter.column.reviewThis",
  "arbiter.column.toFixtures",
  "arbiter.column.waiting",
  "arbiter.flagCount",
  "arbiter.invite.help",
  "arbiter.notice.settleOwnBoard",
  "arbiter.roundLine",
  "arbiter.vs",
  "confirm.cancel",
  "externalPlay.openRound.startFirst",
  "externalPlay.queue.markReviewed",
  "externalPlay.queue.ownFlagged",
  "runsheet.round.batchCloses",
  "runsheet.round.batchOpens",
  "runsheet.round.batchesLabel",
  "runsheet.round.confirmCta",
  "runsheet.round.confirmEarlierInPlay",
  "runsheet.round.confirmTitle",
  "runsheet.round.confirmTitleReinvite",
  "runsheet.round.heading",
  "runsheet.round.inviteCta",
  "runsheet.round.openCta",
  "runsheet.round.pairedLede",
  "runsheet.round.pairingsLabel",
  "runsheet.round.resend",
  "schedule.vs",
];

/** Keys the column renders through code it does not own, which a literal scan of its own files cannot see. Each group names its
 *  helper; round-column-copy.test.ts requires every value of the key maps the helpers read to be listed here, and scans the helper's
 *  own file (or function) for literals and for variable keys, so a literal added to a helper, or a value added to a map, fails until it
 *  is listed. A path the test does not scan (a new helper file, a key built by string concatenation) is not covered:
 *   - `openNoticeText`, `resendNoticeText` and `OpenRoundConfirmBody` (desk/open-round-control.tsx), and the maps they read;
 *   - `RoundExtend` and the extend copy it asks for (checkin-extend-ui.ts; the reasons are `EXTEND_WHY_KEYS`);
 *   - the invite word of a seat (`INVITE_WORD_KEYS`) and the chip of a held card (`HELD_TITLE_KEYS`);
 *   - what the queue's cards say through `where()`, `boardStateWord()` and `noticeSentence()` (only a Mark as reviewed answer reaches
 *     the column, so only its two kinds are listed). The test scans `boardStateWord` for its words; `where()` and `noticeSentence()`
 *     are listed by hand and not scanned. */
export const ROUND_COLUMN_HELPER_KEYS: readonly ColumnKey[] = [
  // OpenRoundConfirmBody, inviteState, the open's answer and the resend's
  "arbiter.column.confirmSeat",
  "externalPlay.openRound.alreadyOpen",
  "externalPlay.openRound.clockNotPlayable",
  "externalPlay.openRound.divisionNotStarted",
  "externalPlay.openRound.invited",
  "externalPlay.openRound.noFixtures",
  "externalPlay.openRound.notPaired",
  "externalPlay.openRound.skipped.sendFailed",
  "externalPlay.openRound.skipped.windowClosed",
  "externalPlay.resend.boardHeld",
  "externalPlay.resend.gameExists",
  "externalPlay.resend.roundChanged",
  "externalPlay.resend.windowClosed",
  "runsheet.round.confirmBody",
  "runsheet.round.confirmBodyReinvite",
  "runsheet.round.confirmListLabel",
  "runsheet.round.confirmScheduled",
  "runsheet.round.confirmWindow",
  "runsheet.round.confirmWindowReinvite",
  "runsheet.round.confirmWindowStaggered",
  "runsheet.round.err.disabled",
  "runsheet.round.err.failed",
  "runsheet.round.err.notOnline",
  "runsheet.round.err.roundChanged",
  "runsheet.round.invited",
  "runsheet.round.noInviteOwed",
  "runsheet.round.notInvited",
  "runsheet.round.reopenNotice",
  "runsheet.round.resendFailed",
  "runsheet.round.resent",
  "runsheet.round.resentNone",
  "runsheet.round.sending",
  "runsheet.round.skipLine",
  "runsheet.round.stillToInvite",
  // RoundExtend (the round bar the panel hands the column) and the board's +5 on a waiting row
  "externalPlay.checkinExtend.board",
  "externalPlay.checkinExtend.busy",
  "externalPlay.checkinExtend.closesAt",
  "externalPlay.checkinExtend.helper",
  "externalPlay.checkinExtend.notice.board",
  "externalPlay.checkinExtend.notice.round",
  "externalPlay.checkinExtend.notice.roundNone",
  "externalPlay.checkinExtend.refused.capReached",
  "externalPlay.checkinExtend.refused.closed",
  "externalPlay.checkinExtend.refused.failed",
  "externalPlay.checkinExtend.refused.gameStarted",
  "externalPlay.checkinExtend.refused.notOpen",
  "externalPlay.checkinExtend.refused.notPlayable",
  "externalPlay.checkinExtend.refused.playsThis",
  "externalPlay.checkinExtend.refused.roundNotOpen",
  "externalPlay.checkinExtend.round",
  "externalPlay.checkinExtend.roundHint",
  "externalPlay.checkinExtend.skip.capReached",
  "externalPlay.checkinExtend.skip.closed",
  "externalPlay.checkinExtend.skip.failed",
  "externalPlay.checkinExtend.skip.gameStarted",
  "externalPlay.checkinExtend.skip.notOpenYet",
  "externalPlay.checkinExtend.skip.ownBoards",
  // the reasons a round or a board has no +5 (the "why" family)
  "externalPlay.checkinExtend.why.capReached",
  "externalPlay.checkinExtend.why.closed",
  "externalPlay.checkinExtend.why.gameStarted",
  "externalPlay.checkinExtend.why.notOpen",
  "externalPlay.checkinExtend.why.roundNoneOpen",
  // INVITE_WORD_KEYS
  "arbiter.invite.bounced",
  "arbiter.invite.delayed",
  "arbiter.invite.delivered",
  "arbiter.invite.notDelivered",
  "arbiter.invite.sent",
  // HELD_TITLE_KEYS
  "externalPlay.held.aborted",
  "externalPlay.held.accountChanged",
  "externalPlay.held.clockFlagUnsettled",
  "externalPlay.held.createOutcomeUnknown",
  "externalPlay.held.doubleWalkoverBlocked",
  "externalPlay.held.fairPlay",
  "externalPlay.held.mismatch",
  "externalPlay.held.noShowBlack",
  "externalPlay.held.noShowBoth",
  "externalPlay.held.noShowWhite",
  "externalPlay.held.notStarted",
  "externalPlay.held.providerError",
  "externalPlay.held.tiebreakOwed",
  "externalPlay.held.tokenRevoked",
  // heldBody(): the sentence of a held card, one per reason and per revoked seat
  "externalPlay.reason.abort",
  "externalPlay.reason.accountChanged",
  "externalPlay.reason.accountChangedBlack",
  "externalPlay.reason.accountChangedBoth",
  "externalPlay.reason.accountChangedWhite",
  "externalPlay.reason.accountMismatch",
  "externalPlay.reason.clockFlagUnsettled",
  "externalPlay.reason.createOutcomeUnknown",
  "externalPlay.reason.doubleWalkoverBlocked",
  "externalPlay.reason.fairPlay",
  "externalPlay.reason.noShowBlack",
  "externalPlay.reason.noShowBoth",
  "externalPlay.reason.noShowWhite",
  "externalPlay.reason.notStarted",
  "externalPlay.reason.providerError",
  "externalPlay.reason.tiebreakOwed",
  "externalPlay.reason.tokenRevoked",
  "externalPlay.reason.tokenRevokedBlack",
  "externalPlay.reason.tokenRevokedBoth",
  "externalPlay.reason.tokenRevokedWhite",
  // the queue's cards: where(), boardStateWord(), and the answer to Mark as reviewed
  "arbiter.notice.failed",
  "arbiter.notice.goOnOwnBoard",
  "arbiter.state.cancelled",
  "arbiter.state.checkingIn",
  "arbiter.state.live",
  "arbiter.state.noResult",
  "arbiter.state.onHold",
  "arbiter.state.over",
  "arbiter.state.starting",
  "externalPlay.queue.reviewed",
  "externalPlay.queue.reviewedNew",
  "externalPlay.queue.where",
];
