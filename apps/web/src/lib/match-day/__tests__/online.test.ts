// Match Day online rounds - the pure rules (plan 2026-11-05-match-day-all-in-one.md Task 1; spec 2026-11-05-match-day-all-in-one-design.md
// §5.1 rows, §5.2 order, §5.5 boards from earlier rounds, §6.4 who sees what; owner rulings O1, O2 and O4 of 2026-11-17).
//
// Chess-only reason, once: online play is `onlinePlay = 'lichess'` on `boardgame` (server/external-play/online-play.ts), so no other
// sport ever reaches these rules and there is no sport registry to sweep. What IS swept: every ArbiterBoardState kind, every NEEDS_REASONS
// value, every reader shape and every presence cell.
//
// Where an expected value comes from (never from the function under test):
//   - the check-in window is `inExtendWindow`'s half-open [opensAt, deadlineAt) (lib/checkin-extend.ts), used as the ORACLE for the
//     boundary cases; the earliest `deadlineAt` of a clock is TYPED in the seed;
//   - "over" is `boardIsOver` (lib/arbiter-view.ts); the tallies' counts are typed from the seeded boards;
//   - the 24-case press table is typed from the plan's Global Constraints (O4: START writes gated by the freeze, FINISH decisions
//     exempt as scoring, cameras ungated), row by row, never computed from booleans.
// Anti-vacuity: each sweep reports what it checked and zero is a failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArbiterBoard, ArbiterBoardState, ArbiterCameraPolicy, ArbiterRound, ArbiterSideMeeting } from "@/lib/arbiter-view";
import { boardIsOver } from "@/lib/arbiter-view";
import type { CheckinExtendState } from "@/lib/checkin-extend";
import { emptyExtendTally, inExtendWindow } from "@/lib/checkin-extend";
import type { OpenRoundPairing, OpenRoundView } from "@/lib/open-round";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import type { MatchDayBoardRow, MatchDayOnlineRound, OnlineRoundPhase } from "../types";
import {
  boardRowWord,
  mayPress,
  onlineRoundPhase,
  orderOnlineRounds,
  presenceMark,
  resolveOnlineFocus,
  roundRowWord,
  type BoardRowWord,
  type OnlineFocus,
  type OnlineOpened,
  type PresenceMark,
  type Reader,
  type RoundRowWord,
} from "../online";

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-11-19T18:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A check-in window by offsets (ms) from NOW. */
function window(from: number, to: number, over: Partial<CheckinExtendState> = {}): CheckinExtendState {
  return { canExtend: true, refusal: null, extensionsLeft: 3, opensAt: iso(NOW + from), deadlineAt: iso(NOW + to), ...over };
}
/** Opened ten minutes ago, closes in `closesIn` minutes. */
const openNow = (closesIn = 8) => window(-10 * MIN, closesIn * MIN);
/** A later check-in group: opens `opensIn` minutes from now. */
const laterGroup = (opensIn = 15) => window(opensIn * MIN, (opensIn + 10) * MIN);

const sideMeeting = (over: Partial<ArbiterSideMeeting> = {}): ArbiterSideMeeting => ({
  state: "none",
  endedAt: null,
  evidenceAt: null,
  presence: { present: false, since: null, leftAt: null },
  camera: { state: "unknown", at: null },
  joinable: false,
  ...over,
});

let nextId = 0;
function arbiterBoard(over: Partial<ArbiterBoard> = {}): ArbiterBoard {
  nextId += 1;
  return {
    fixtureId: `fx-${nextId}`,
    fixtureNo: nextId,
    boardNo: nextId,
    white: { name: "White Player", personId: null },
    black: { name: "Black Player", personId: null },
    state: { kind: "checking_in" },
    clock: null,
    cameraPolicy: "optional",
    videoOverridden: false,
    cameraReport: null,
    sides: { home: sideMeeting(), away: sideMeeting() },
    canResync: false,
    playable: true,
    canSettle: false,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    checkin: null,
    seats: null,
    flags: [],
    flagCount: 0,
    ...over,
  };
}
const withState = (state: ArbiterBoardState, over: Partial<ArbiterBoard> = {}) => arbiterBoard({ state, ...over });
const rowBoard = (over: Partial<MatchDayBoardRow> = {}): MatchDayBoardRow => ({ ...arbiterBoard(), stage_id: "stage-1", round_no: 1, ...over });
const seat = (here: boolean): NonNullable<ArbiterBoard["seats"]>["white"] => ({ here, invites: [] });
/** A checking_in board in `win`, its seats as asked (white, black here). */
const checkingIn = (win: CheckinExtendState | null, here: [boolean, boolean] = [false, false]) =>
  arbiterBoard({ state: { kind: "checking_in" }, checkin: win, seats: { white: seat(here[0]), black: seat(here[1]) } });
const live = () => withState({ kind: "live", moveNo: 7 });
const done = (score = "1-0") => withState({ kind: "result", score, noResult: false });

function arbiterRound(boards: ArbiterBoard[], over: Partial<ArbiterRound> = {}): ArbiterRound {
  return { stageId: "stage-1", stageName: "Swiss", roundNo: 2, timeControl: "10+5", boards, ownBoards: 0, current: true, extendableBoards: 0, ...over };
}

const pairing = (fixtureId: string, owedSeats: 0 | 1 | 2): OpenRoundPairing => ({
  fixtureId,
  boardNo: 1,
  whiteName: "A",
  blackName: "B",
  invitedAt: null,
  owedSeats,
  canResend: false,
});
function openView(over: Partial<OpenRoundView> = {}): OpenRoundView {
  return {
    stageId: "stage-1",
    stageName: "Swiss",
    roundNo: 2,
    state: "open",
    openedAt: iso(NOW - 10 * MIN),
    deadlineAt: null,
    windowMinutes: 10,
    staggered: false,
    batches: [],
    staggerSpanMinutes: 0,
    scheduledAt: null,
    press: "none",
    pairings: [],
    extendableBoards: 0,
    extendWindows: [],
    extendRefusals: emptyExtendTally(),
    earlierInPlay: [],
    ...over,
  };
}

function onlineRound(key: string, phase: OnlineRoundPhase, round: ArbiterRound | null, over: Partial<MatchDayOnlineRound> = {}): MatchDayOnlineRound {
  const [stage_id, no] = key.split(":");
  return {
    key,
    division_id: "div-1",
    division_name: "Open",
    division_slug: "open",
    stage_id: stage_id!,
    stage_name: "Swiss",
    round_no: Number(no),
    multi_stage: false,
    phase,
    offered: true,
    tz: "Europe/London",
    view: null,
    round,
    needs_decision: [],
    own_boards: 0,
    ...over,
  };
}
const checkinRound = (key: string) => onlineRound(key, "checkin", arbiterRound([checkingIn(openNow(8), [true, false])]));
const playingRound = (key: string) => onlineRound(key, "playing", arbiterRound([live(), done()]));
const overRound = (key: string) => onlineRound(key, "playing", arbiterRound([done("1-0"), done("0-1")]));
const beforeRound = (key: string) => onlineRound(key, "before", null, { view: openView({ state: "paired", press: "open", openedAt: null }) });
const notStartedRound = (key: string) => onlineRound(key, "not_started", null);
const keys = (rs: readonly MatchDayOnlineRound[]) => rs.map((r) => r.key);

// ---- onlineRoundPhase -------------------------------------------------------------------------------------------------------------

describe("onlineRoundPhase - the server's word, re-read from the round's BOARDS: a deadline passing flips nothing, a board leaving check-in does", () => {
  it("EMPTY CASE FIRST: a division not started and a round not opened keep their phase, whatever the clock", () => {
    for (const now of [null, NOW]) {
      expect(onlineRoundPhase(notStartedRound("s:1"), now)).toBe("not_started");
      expect(onlineRoundPhase(beforeRound("s:1"), now)).toBe("before");
    }
  });

  it("a round with a board checking in is check-in on every clock - before its window, inside it, at its deadline and long after (the sweep, not the clock, turns the board)", () => {
    const r = onlineRound("s:2", "checkin", arbiterRound([checkingIn(openNow(8)), live()]));
    const deadline = NOW + 8 * MIN; // openNow(8)'s deadline, typed
    // the oracle for the boundary is the window's own half-open rule, not a copy of it: the clock DOES move the window...
    expect(inExtendWindow(openNow(8), deadline - 1)).toBe(true);
    expect(inExtendWindow(openNow(8), deadline)).toBe(false);
    // ...and the phase does not follow it
    let checked = 0;
    for (const now of [null, NOW - 30 * MIN, deadline - 1, deadline, deadline + 5 * MIN, deadline + 6 * 60 * MIN]) {
      expect(onlineRoundPhase(r, now), `now ${now}`).toBe("checkin");
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  it("SEQUENCE: the same round leaves check-in when its last checking-in board does (a game starts, a hold, a result), and not before", () => {
    const stays = checkingIn(openNow(8));
    const leaves = checkingIn(openNow(8));
    const mk = (boards: ArbiterBoard[]) => onlineRound("s:2", "checkin", arbiterRound(boards));
    expect(onlineRoundPhase(mk([stays, leaves]), NOW)).toBe("checkin");
    // one board starts: the other is still checking in
    expect(onlineRoundPhase(mk([stays, { ...leaves, state: { kind: "starting" } }]), NOW)).toBe("checkin");
    // the last one leaves, by each way out
    for (const state of [{ kind: "starting" }, { kind: "live", moveNo: 3 }, { kind: "on_hold" }, { kind: "result", score: "1-0", noResult: false }] as const satisfies readonly ArbiterBoardState[]) {
      expect(onlineRoundPhase(mk([{ ...stays, state }, { ...leaves, state }]), NOW), state.kind).toBe("playing");
    }
  });

  it("no clock yet (the server render, the first client paint), a round with a board checking in: check-in whether its window is open or the snapshot says it closed", () => {
    // typed: an open window (refusal null) and a snapshot-closed one (the sweep has not turned the board yet) are BOTH check-in
    const closed = window(-20 * MIN, -1 * MIN, { canExtend: false, refusal: "closed" });
    expect(onlineRoundPhase(onlineRound("s:2", "checkin", arbiterRound([checkingIn(openNow(8))])), null)).toBe("checkin");
    expect(onlineRoundPhase(onlineRound("s:2", "checkin", arbiterRound([checkingIn(closed)])), null)).toBe("checkin");
    // and a round with none checking in is playing with no clock too
    expect(onlineRoundPhase(onlineRound("s:2", "playing", arbiterRound([live(), done()])), null)).toBe("playing");
  });

  it("a later check-in group still to open keeps the round in check-in (check-in is not over while a batch is ahead)", () => {
    const r = onlineRound("s:2", "checkin", arbiterRound([checkingIn(window(-20 * MIN, -1 * MIN, { canExtend: false, refusal: "closed" })), checkingIn(laterGroup(15))]));
    expect(onlineRoundPhase(r, NOW)).toBe("checkin");
  });

  it("the server's word never overrides the boards: no board checking in is playing even if the poll said check-in (a stale snapshot)", () => {
    expect(onlineRoundPhase(onlineRound("s:2", "checkin", arbiterRound([live(), done()])), NOW)).toBe("playing");
    expect(onlineRoundPhase(onlineRound("s:2", "playing", arbiterRound([checkingIn(openNow(8))])), NOW)).toBe("checkin");
  });

  it("a round every board of which is the viewer's own (no boards on screen) is playing, never before", () => {
    expect(onlineRoundPhase(onlineRound("s:2", "playing", arbiterRound([], { ownBoards: 3 })), NOW)).toBe("playing");
  });

  it("GUARD: a round the server calls check-in or playing but carries no boards for reads before (nothing can be checking in)", () => {
    expect(onlineRoundPhase(onlineRound("s:2", "checkin", null), NOW)).toBe("before");
    expect(onlineRoundPhase(onlineRound("s:2", "playing", null), NOW)).toBe("before");
  });
});

// ---- orderOnlineRounds ------------------------------------------------------------------------------------------------------------

describe("orderOnlineRounds - check-in or in play first, then paired and not opened, then over; stable inside a group", () => {
  it("EMPTY CASE FIRST: no rounds is no rounds, with or without a clock", () => {
    expect(orderOnlineRounds([], NOW)).toEqual([]);
    expect(orderOnlineRounds([], null)).toEqual([]);
  });

  it("a check-in round before a paired one before an over one, whatever order the server listed them in", () => {
    const rounds = [overRound("a:3"), beforeRound("b:1"), checkinRound("c:2")];
    expect(keys(orderOnlineRounds(rounds, NOW))).toEqual(["c:2", "b:1", "a:3"]);
    expect(keys(orderOnlineRounds([...rounds].reverse(), NOW))).toEqual(["c:2", "b:1", "a:3"]);
  });

  it("no clock yet (the server render): the same non-empty list orders the same way, over rounds typed by their boards", () => {
    const rounds = [overRound("o:1"), notStartedRound("n:0"), playingRound("p:2"), beforeRound("b:1"), checkinRound("c:2")];
    expect(keys(orderOnlineRounds(rounds, null))).toEqual(["p:2", "c:2", "n:0", "b:1", "o:1"]);
    expect(keys(orderOnlineRounds(rounds, null))).toEqual(keys(orderOnlineRounds(rounds, NOW)));
  });

  it("a round with a board live sits with check-in, ahead of a paired round and an over one", () => {
    expect(keys(orderOnlineRounds([overRound("o:1"), beforeRound("b:1"), playingRound("p:2")], NOW))).toEqual(["p:2", "b:1", "o:1"]);
  });

  it("a division not started sits with the rounds not opened - behind a round in check-in, level with a paired one (input order), ahead of an over one", () => {
    // listed FIRST by the server, so only its group can move it behind the check-in round and the over one's behind it
    expect(keys(orderOnlineRounds([notStartedRound("n:0"), overRound("o:1"), checkinRound("c:2"), beforeRound("b:1")], NOW))).toEqual(["c:2", "n:0", "b:1", "o:1"]);
    expect(keys(orderOnlineRounds([beforeRound("b:1"), notStartedRound("n:0")], NOW))).toEqual(["b:1", "n:0"]);
  });

  it("two rounds of one division in one group keep the stage order the server gave, in either input order (stable, not sorted by key)", () => {
    const a = checkinRound("s2:1");
    const b = checkinRound("s1:1");
    expect(keys(orderOnlineRounds([a, b], NOW))).toEqual(["s2:1", "s1:1"]);
    expect(keys(orderOnlineRounds([b, a], NOW))).toEqual(["s1:1", "s2:1"]);
  });

  it("a round with only HELD boards is still in progress: ahead of a paired round, never filed with the over ones", () => {
    const heldOnly = onlineRound("h:1", "playing", arbiterRound([withState({ kind: "on_hold" })]));
    expect(keys(orderOnlineRounds([overRound("o:1"), beforeRound("b:1"), heldOnly], NOW))).toEqual(["h:1", "b:1", "o:1"]);
  });

  it("EMPTY BOARD LIST: a round whose boards are all the viewer's own is not 'all over' - the empty set must not read as finished", () => {
    const own = onlineRound("w:1", "playing", arbiterRound([], { ownBoards: 2 }));
    expect(keys(orderOnlineRounds([overRound("o:1"), beforeRound("b:1"), own], NOW))).toEqual(["w:1", "b:1", "o:1"]);
  });

  it("a board that paints as over but is owed its invite again (a re-armed No result) keeps the round in progress", () => {
    const rearmed = done();
    const r = onlineRound("r:2", "playing", arbiterRound([rearmed, done("0-1")]), { view: openView({ pairings: [pairing(rearmed.fixtureId, 2)] }) });
    expect(keys(orderOnlineRounds([overRound("o:1"), beforeRound("b:1"), r], NOW))).toEqual(["r:2", "b:1", "o:1"]);
  });

  it("SEQUENCE: the same round moves from the first group to the last as its boards finish, and the order follows", () => {
    const stillPlaying = playingRound("x:1");
    const before = beforeRound("y:1");
    expect(keys(orderOnlineRounds([before, stillPlaying], NOW))).toEqual(["x:1", "y:1"]);
    const finished = onlineRound("x:1", "playing", arbiterRound([done(), done("0-1")]));
    expect(keys(orderOnlineRounds([before, finished], NOW))).toEqual(["y:1", "x:1"]);
  });

  it("does not mutate its input", () => {
    const rounds = [overRound("a:3"), checkinRound("c:2")];
    const snapshot = [...rounds];
    orderOnlineRounds(rounds, NOW);
    expect(rounds).toEqual(snapshot);
    expect(keys(rounds)).toEqual(["a:3", "c:2"]);
  });
});

// ---- roundRowWord -----------------------------------------------------------------------------------------------------------------

describe("roundRowWord - the round row's one line, from the column's own clock and tallies", () => {
  it("a division not started says so; a round paired and not opened says paired", () => {
    expect(roundRowWord(notStartedRound("s:0"), NOW)).toEqual({ kind: "not_started" } satisfies RoundRowWord);
    expect(roundRowWord(beforeRound("s:1"), NOW)).toEqual({ kind: "paired" } satisfies RoundRowWord);
  });

  it("check-in: closes at the EARLIEST deadline among the open windows, with the seats here out of the seats being waited on", () => {
    // seed typed by hand: three boards; two in an open window (closing in 8 and 5 minutes), one in a later group (not counted);
    // seats here among the open boards: board 1 white, board 2 white and black = 3, of 2 boards x 2 seats = 4.
    const boards = [checkingIn(openNow(8), [true, false]), checkingIn(openNow(5), [true, true]), checkingIn(laterGroup(15), [true, true])];
    const r = onlineRound("s:2", "checkin", arbiterRound(boards));
    expect(roundRowWord(r, NOW)).toEqual({ kind: "closes", at: iso(NOW + 5 * MIN), here: 3, seats: 4 } satisfies RoundRowWord);
  });

  it("check-in on a ticking clock: when the earliest window runs out the NEXT deadline is named and the tally follows the boards still open", () => {
    const boards = [checkingIn(openNow(8), [true, false]), checkingIn(openNow(5), [true, true])];
    const r = onlineRound("s:2", "checkin", arbiterRound(boards));
    expect(roundRowWord(r, NOW + 5 * MIN)).toEqual({ kind: "closes", at: iso(NOW + 8 * MIN), here: 1, seats: 2 } satisfies RoundRowWord);
  });

  it("no clock yet (the server render): an open window names its deadline with the seats here; a window the snapshot calls closed says the playing tally", () => {
    // typed: open window closing in 8 minutes, white here of 1 board = 1 of 2 seats
    const open = onlineRound("s:2", "checkin", arbiterRound([checkingIn(openNow(8), [true, false])]));
    expect(roundRowWord(open, null)).toEqual({ kind: "closes", at: iso(NOW + 8 * MIN), here: 1, seats: 2 } satisfies RoundRowWord);
    // the snapshot's refusal says "closed" while the board still checks in: still a check-in round (its boards decide), no deadline to name
    const closed = window(-20 * MIN, -1 * MIN, { canExtend: false, refusal: "closed" });
    const ended = onlineRound("s:2", "checkin", arbiterRound([checkingIn(closed), live()]));
    expect(onlineRoundPhase(ended, null)).toBe("checkin");
    expect(roundRowWord(ended, null)).toEqual({ kind: "playing", playing: 1, total: 2 } satisfies RoundRowWord);
  });

  it("a check-in round whose last window has run out (the board not yet turned by the sweep) stays check-in and says the playing tally, never a deadline in the past", () => {
    const r = onlineRound("s:2", "checkin", arbiterRound([checkingIn(openNow(8)), live()]));
    expect(roundRowWord(r, NOW + 8 * MIN - 1)).toEqual({ kind: "closes", at: iso(NOW + 8 * MIN), here: 0, seats: 2 } satisfies RoundRowWord);
    expect(onlineRoundPhase(r, NOW + 8 * MIN)).toBe("checkin");
    expect(roundRowWord(r, NOW + 8 * MIN)).toEqual({ kind: "playing", playing: 1, total: 2 } satisfies RoundRowWord);
  });

  it("playing: boards playing of the boards on screen (a held board is not playing, a finished one is on screen)", () => {
    const r = onlineRound("s:2", "playing", arbiterRound([live(), withState({ kind: "starting" }), done(), withState({ kind: "on_hold" })]));
    expect(roundRowWord(r, NOW)).toEqual({ kind: "playing", playing: 2, total: 4 } satisfies RoundRowWord);
  });

  it("over: every board decided and none owed its invite", () => {
    expect(roundRowWord(overRound("s:2"), NOW)).toEqual({ kind: "over" } satisfies RoundRowWord);
    // a No result is decided too (the abandon of a league board)
    const abandoned = onlineRound("s:2", "playing", arbiterRound([done(), withState({ kind: "result", score: null, noResult: true })]));
    expect(roundRowWord(abandoned, NOW)).toEqual({ kind: "over" } satisfies RoundRowWord);
  });

  it("NOT over while a held board waits for the organiser, or a re-armed board is owed its invite", () => {
    const held = onlineRound("s:2", "playing", arbiterRound([done(), withState({ kind: "on_hold" })]));
    expect(roundRowWord(held, NOW)).toEqual({ kind: "playing", playing: 0, total: 2 } satisfies RoundRowWord);
    const rearmed = done();
    const owed = onlineRound("s:2", "playing", arbiterRound([rearmed, done("0-1")]), { view: openView({ pairings: [pairing(rearmed.fixtureId, 2)] }) });
    expect(roundRowWord(owed, NOW)).toEqual({ kind: "playing", playing: 0, total: 2 } satisfies RoundRowWord);
  });

  it("EMPTY BOARD LIST: a round whose every board is the viewer's own is 0 of 0 playing, never 'over' (the empty set is not finished)", () => {
    const own = onlineRound("s:2", "playing", arbiterRound([], { ownBoards: 2 }));
    expect(roundRowWord(own, NOW)).toEqual({ kind: "playing", playing: 0, total: 0 } satisfies RoundRowWord);
  });

  it("CORNER: a round still in check-in whose only open window has no deadline to name (a later group ahead) says its playing tally", () => {
    const r = onlineRound("s:2", "checkin", arbiterRound([live(), checkingIn(laterGroup(15))]));
    expect(onlineRoundPhase(r, NOW)).toBe("checkin");
    expect(roundRowWord(r, NOW)).toEqual({ kind: "playing", playing: 1, total: 2 } satisfies RoundRowWord);
  });

  it("SEQUENCE: one round walks paired -> check-in -> playing -> over, and each step's word is the one for its state", () => {
    const words: RoundRowWord["kind"][] = [];
    words.push(roundRowWord(beforeRound("s:2"), NOW).kind);
    const b1 = checkingIn(openNow(8), [true, true]);
    const b2 = checkingIn(openNow(8), [true, true]);
    words.push(roundRowWord(onlineRound("s:2", "checkin", arbiterRound([b1, b2])), NOW).kind);
    words.push(roundRowWord(onlineRound("s:2", "playing", arbiterRound([live(), live()])), NOW).kind);
    words.push(roundRowWord(onlineRound("s:2", "playing", arbiterRound([done(), done("0-1")])), NOW).kind);
    expect(words).toEqual(["paired", "closes", "playing", "over"]);
  });
});

// ---- boardRowWord -----------------------------------------------------------------------------------------------------------------

/** Every ArbiterBoardState kind, with the word (house copy given in the comment) each one owes. A `Record` over the kinds, so a new kind
 *  in `ArbiterBoardState` is a compile error here until it gets cases. `flagCount` is set apart from `flags` on purpose: the LIST read
 *  carries the count and an empty card list. */
const WORDS: Record<ArbiterBoardState["kind"], { state: ArbiterBoardState; flagCount: number; word: BoardRowWord }[]> = {
  checking_in: [{ state: { kind: "checking_in" }, flagCount: 0, word: { kind: "checking_in" } }], // "Checking in"
  starting: [{ state: { kind: "starting" }, flagCount: 0, word: { kind: "starting" } }],
  live: [
    { state: { kind: "live", moveNo: 1 }, flagCount: 0, word: { kind: "live", moveNo: 1 } }, // "Live · move 1"
    { state: { kind: "live", moveNo: 12 }, flagCount: 0, word: { kind: "live", moveNo: 12 } },
  ],
  on_hold: [
    { state: { kind: "on_hold" }, flagCount: 0, word: { kind: "on_hold", flags: 0 } }, // "On hold"
    { state: { kind: "on_hold" }, flagCount: 1, word: { kind: "on_hold", flags: 1 } }, // "On hold · 1 flag"
    { state: { kind: "on_hold" }, flagCount: 3, word: { kind: "on_hold", flags: 3 } },
  ],
  result: [
    { state: { kind: "result", score: "1-0", noResult: false }, flagCount: 0, word: { kind: "result", score: "1-0" } },
    { state: { kind: "result", score: "½-½", noResult: false }, flagCount: 0, word: { kind: "result", score: "½-½" } },
    // settled without a score: still a result, with no score to print
    { state: { kind: "result", score: null, noResult: false }, flagCount: 0, word: { kind: "result", score: null } },
    // I-3: an abandon decides nobody - "No result", never a score
    { state: { kind: "result", score: null, noResult: true }, flagCount: 0, word: { kind: "no_result" } },
    // even with a score on file, noResult wins (the board was voided)
    { state: { kind: "result", score: "1-0", noResult: true }, flagCount: 0, word: { kind: "no_result" } },
  ],
  cancelled: [
    { state: { kind: "cancelled" }, flagCount: 1, word: { kind: "cancelled", flags: 1 } }, // listed only while a flag is open (O1)
    { state: { kind: "cancelled" }, flagCount: 2, word: { kind: "cancelled", flags: 2 } },
  ],
};

describe("boardRowWord - one word for every state a listed board can be in", () => {
  it("sweeps every ArbiterBoardState kind, the result split by noResult, and reports how many it checked", () => {
    let checked = 0;
    for (const [kind, cases] of Object.entries(WORDS)) {
      expect(cases.length, `${kind} has no case`).toBeGreaterThan(0);
      for (const c of cases) {
        // the LIST read: no cards, only the count
        const b = rowBoard({ state: c.state, flags: [], flagCount: c.flagCount });
        expect(boardRowWord(b), `${kind} ${JSON.stringify(c.state)} flagCount ${c.flagCount}`).toEqual(c.word);
        checked += 1;
      }
    }
    // 1 + 1 + 2 + 3 + 5 + 2, typed: a case dropped from the table drops this
    expect(checked).toBe(14);
    expect(Object.keys(WORDS).sort()).toEqual(["cancelled", "checking_in", "live", "on_hold", "result", "starting"]);
  });

  it("the flag count is the board's COUNT, not its card list (the list read leaves the cards out)", () => {
    expect(boardRowWord(rowBoard({ state: { kind: "on_hold" }, flags: [], flagCount: 2 }))).toEqual({ kind: "on_hold", flags: 2 });
    expect(boardRowWord(rowBoard({ state: { kind: "cancelled" }, flags: [], flagCount: 1 }))).toEqual({ kind: "cancelled", flags: 1 });
  });

  it("a board that is over (boardIsOver) never reads as a live word, and a live word is never over", () => {
    let checked = 0;
    for (const cases of Object.values(WORDS)) {
      for (const c of cases) {
        const word = boardRowWord(rowBoard({ state: c.state, flagCount: c.flagCount }));
        const overWord = word.kind === "result" || word.kind === "no_result" || word.kind === "cancelled";
        expect(overWord, JSON.stringify(c.state)).toBe(boardIsOver(c.state));
        checked += 1;
      }
    }
    expect(checked).toBe(14);
  });

  it("EVERY hold reason reads 'On hold', the link holds (lichess_unlinked, lichess_reconnect) included: a board's state carries no reason", () => {
    // The loader reads a held board as `on_hold` from the bridge status alone (arbiter.ts boardWithSides); the row's `hold_reason` (for
    // Needs you's routing, MD-R2) and `tiebreakOwed` are the reason-derived facts. The row's WORD cannot depend on a reason, and a link
    // hold (V536) is "On hold" like any other.
    expect(NEEDS_REASONS).toContain("lichess_unlinked");
    expect(NEEDS_REASONS).toContain("lichess_reconnect");
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      const held = rowBoard({ state: { kind: "on_hold" }, hold_reason: reason, tiebreakOwed: reason === "tiebreak_owed", flagCount: 0 });
      expect(held.hold_reason, reason).toBe(reason);
      expect(boardRowWord(held), reason).toEqual({ kind: "on_hold", flags: 0 });
      checked += 1;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("boardRowWord does not enumerate hold reasons: its body names none of NEEDS_REASONS, or names ALL of them (so a new reason cannot be half-covered)", () => {
    // Scoped to the one function that makes a board's WORD: online.ts may name a reason elsewhere (a routing rule on `hold_reason`
    // is not a word), but a word that begins to depend on a reason must cover every reason, link holds included.
    const file = readFileSync(join(__dirname, "../online.ts"), "utf8");
    const from = file.indexOf("export function boardRowWord");
    expect(from, "boardRowWord not found in online.ts").toBeGreaterThanOrEqual(0);
    const body = file
      .slice(from, file.indexOf("\n}\n", from))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(body, "the scan must have read the switch").toContain('case "on_hold"');
    // `not_started` is both a hold reason and a PHASE word ("the division has not started"); a Record over the phases keeps this list honest
    const PHASE_WORDS = Object.keys({ not_started: 1, before: 1, checkin: 1, playing: 1 } satisfies Record<OnlineRoundPhase, 1>);
    const reasons = NEEDS_REASONS.filter((r: NeedsReason) => !PHASE_WORDS.includes(r));
    expect(reasons.length).toBe(NEEDS_REASONS.length - 1);
    expect(reasons).toContain("lichess_unlinked");
    expect(reasons).toContain("lichess_reconnect");
    const named = reasons.filter((r) => body.includes(r));
    expect(named.length === 0 || named.length === reasons.length, `boardRowWord names only ${named.join(", ")}`).toBe(true);
  });
});

// ---- presenceMark -----------------------------------------------------------------------------------------------------------------

/** One side's meeting by what the loader reads: presence (a current peer) and the player's own browser's last word on the camera. */
const here = (camera: ArbiterSideMeeting["camera"]["state"], over: Partial<ArbiterSideMeeting> = {}): ArbiterSideMeeting =>
  sideMeeting({ state: "open", presence: { present: true, since: iso(NOW - MIN), leftAt: null }, camera: { state: camera, at: iso(NOW - MIN) }, joinable: true, ...over });

describe("presenceMark - the mark by a player's name: here, camera off, away, or none when the policy is off", () => {
  it("camera policy OFF: no mark for any side state, present or not (the policy decides, before the facts)", () => {
    let checked = 0;
    for (const meeting of [here("live"), here("off"), here("unknown"), sideMeeting(), sideMeeting({ state: "open" }), sideMeeting({ state: "ended" })]) {
      const b = rowBoard({ cameraPolicy: "off", sides: { home: meeting, away: meeting } });
      expect(presenceMark(b, "home")).toBeNull();
      expect(presenceMark(b, "away")).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  it("optional and required: present with the camera live or unknown is here; present with the camera reported off is off", () => {
    const cases: [ArbiterSideMeeting["camera"]["state"], PresenceMark][] = [
      ["live", "here"],
      ["unknown", "here"],
      ["off", "off"],
    ];
    let checked = 0;
    for (const policy of ["optional", "required"] as const satisfies readonly ArbiterCameraPolicy[]) {
      for (const [camera, mark] of cases) {
        const b = rowBoard({ cameraPolicy: policy, sides: { home: here(camera), away: sideMeeting() } });
        expect(presenceMark(b, "home"), `${policy} ${camera}`).toBe(mark);
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  it("away: a pre-minted room (a meeting row, joinable false, nobody in it) and a side with no meeting at all", () => {
    for (const policy of ["optional", "required"] as const) {
      const preMinted = sideMeeting({ state: "open", joinable: false });
      const none = sideMeeting();
      const b = rowBoard({ cameraPolicy: policy, sides: { home: preMinted, away: none } });
      expect(presenceMark(b, "home"), `${policy} pre-minted`).toBe("away");
      expect(presenceMark(b, "away"), `${policy} none`).toBe("away");
    }
  });

  it("the mark is PRESENCE, not joinability: a checked-in player not yet in the room (joinable true, no peer) is away; a peer in a room the join would refuse is still here", () => {
    const checkedInNotInRoom = sideMeeting({ state: "open", joinable: true });
    const peerButNotJoinable = here("live", { joinable: false });
    const b = rowBoard({ cameraPolicy: "required", sides: { home: checkedInNotInRoom, away: peerButNotJoinable } });
    expect(presenceMark(b, "home")).toBe("away");
    expect(presenceMark(b, "away")).toBe("here");
  });

  it("a peer who has LEFT (presence not current, a left_at on file) is away", () => {
    const left = sideMeeting({ state: "open", presence: { present: false, since: iso(NOW - 5 * MIN), leftAt: iso(NOW - MIN) }, camera: { state: "live", at: iso(NOW - 2 * MIN) } });
    expect(presenceMark(rowBoard({ cameraPolicy: "required", sides: { home: left, away: sideMeeting() } }), "home")).toBe("away");
  });

  it("each side is read on its own: one here, one away, one off", () => {
    const b = rowBoard({ cameraPolicy: "required", sides: { home: here("live"), away: here("off") } });
    expect(presenceMark(b, "home")).toBe("here");
    expect(presenceMark(b, "away")).toBe("off");
    const c = rowBoard({ cameraPolicy: "optional", sides: { home: sideMeeting(), away: here("unknown") } });
    expect(presenceMark(c, "home")).toBe("away");
    expect(presenceMark(c, "away")).toBe("here");
  });
});

// ---- resolveOnlineFocus -----------------------------------------------------------------------------------------------------------

describe("resolveOnlineFocus - a round or a board by what was opened, never another one in its place", () => {
  const b1 = arbiterBoard({ boardNo: 1 });
  const b2 = arbiterBoard({ boardNo: 2 });
  const held = rowBoard({ state: { kind: "on_hold" }, stage_id: "stage-1", round_no: 1, flagCount: 1 });
  const cancelled = rowBoard({ state: { kind: "cancelled" }, stage_id: "stage-1", round_no: 1, flagCount: 1 });
  const r2 = onlineRound("stage-1:2", "playing", arbiterRound([b1, b2], { roundNo: 2 }), { needs_decision: [held, cancelled], own_boards: 1 });
  const other = onlineRound("stage-2:1", "before", null, { stage_id: "stage-2", round_no: 1, multi_stage: true });
  const rounds = [r2, other];

  const round = (key: string, name = "Round"): OnlineOpened => ({ kind: "round", key, name });
  const board = (id: string, name = "Board"): OnlineOpened => ({ kind: "board", id, name });
  const kinds = (f: OnlineFocus) => f.kind;

  it("EMPTY CASE FIRST: nothing opened is none - with no rounds, and with rounds (the shell's default focus is not this function's)", () => {
    expect(resolveOnlineFocus([], null)).toEqual({ kind: "none" });
    expect(resolveOnlineFocus(rounds, null)).toEqual({ kind: "none" });
  });

  it("with nothing listed, whatever was opened is lost and named", () => {
    expect(resolveOnlineFocus([], round("stage-1:2", "Open · Round 2"))).toEqual({ kind: "lost", name: "Open · Round 2" });
    expect(resolveOnlineFocus([], board("fx-1", "Board 4 · A v B"))).toEqual({ kind: "lost", name: "Board 4 · A v B" });
  });

  it("a round is found by its key, each of two rows of one division by its own", () => {
    expect(resolveOnlineFocus(rounds, round("stage-1:2"))).toEqual({ kind: "round", round: r2 });
    const f = resolveOnlineFocus(rounds, round("stage-2:1"));
    expect(f).toEqual({ kind: "round", round: other });
    expect((f as Extract<OnlineFocus, { kind: "round" }>).round).toBe(other);
  });

  it("a board of the listed round is found, carrying the round's own stage and number", () => {
    const f = resolveOnlineFocus(rounds, board(b2.fixtureId));
    expect(f.kind).toBe("board");
    const found = f as Extract<OnlineFocus, { kind: "board" }>;
    expect(found.round).toBe(r2);
    expect(found.board.fixtureId).toBe(b2.fixtureId);
    expect(found.board.boardNo).toBe(2);
    expect(found.board.stage_id).toBe("stage-1");
    expect(found.board.round_no).toBe(2);
  });

  it("a held or flagged board of an earlier round is found in needs_decision, with its own round; a cancelled one with an open flag too (O1)", () => {
    for (const nd of [held, cancelled]) {
      const f = resolveOnlineFocus(rounds, board(nd.fixtureId));
      expect(f.kind).toBe("board");
      const found = f as Extract<OnlineFocus, { kind: "board" }>;
      expect(found.board).toBe(nd);
      expect(found.board.round_no).toBe(1);
      expect(found.round).toBe(r2);
    }
  });

  it("a board in both a round and another row's needs_decision is found once, in its round", () => {
    const dup = onlineRound("stage-2:1", "before", null, { stage_id: "stage-2", needs_decision: [rowBoard({ ...b1, stage_id: "stage-1", round_no: 2 })] });
    const f = resolveOnlineFocus([dup, r2], board(b1.fixtureId));
    expect((f as Extract<OnlineFocus, { kind: "board" }>).round).toBe(r2);
  });

  it("a board of a round the viewer plays on (in neither list) is lost, never the round's first board", () => {
    const f = resolveOnlineFocus(rounds, board("fx-the-viewers-own", "Board 3 · You v Them"));
    expect(f).toEqual({ kind: "lost", name: "Board 3 · You v Them" });
    expect(kinds(f)).not.toBe("board");
  });

  it("a stale round key is lost, never another round (including the round after it)", () => {
    expect(resolveOnlineFocus(rounds, round("stage-1:3", "Open · Round 3"))).toEqual({ kind: "lost", name: "Open · Round 3" });
    expect(resolveOnlineFocus(rounds, round("stage-9:1", "Gone"))).toEqual({ kind: "lost", name: "Gone" });
  });

  it("a board that WAS open and then left the list (its flags settled, it dropped out of needs_decision) is lost", () => {
    const before = resolveOnlineFocus(rounds, board(cancelled.fixtureId, "Board 5"));
    expect(before.kind).toBe("board");
    const next = onlineRound("stage-1:2", "playing", arbiterRound([b1, b2], { roundNo: 2 }), { needs_decision: [held] });
    expect(resolveOnlineFocus([next, other], board(cancelled.fixtureId, "Board 5"))).toEqual({ kind: "lost", name: "Board 5" });
  });

  it("a round key never matches a board id, nor a board id a round key (the two kinds are asked apart)", () => {
    expect(resolveOnlineFocus(rounds, board("stage-1:2")).kind).toBe("lost");
    expect(resolveOnlineFocus(rounds, round(b1.fixtureId)).kind).toBe("lost");
  });
});

// ---- mayPress ---------------------------------------------------------------------------------------------------------------------

describe("mayPress - the ONE online press rule for Match Day and the division page's Held | Flagged queue (O2 + O4)", () => {
  // Typed from the plan's Global Constraints, one row per reader shape (editor, offered, frozen):
  //   start   (open a round, resend invites, +5 on a board, +5 to the round): an editor in an offered club on a competition that is not frozen
  //   finish  (resync, let the game go on, settle, let play without video): every editor, flag or freeze or neither - it writes a RESULT
  //   cameras (watching writes nothing, so the freeze never touches it): an editor in an offered club
  const TABLE: { reader: Reader; start: boolean; finish: boolean; cameras: boolean }[] = [
    { reader: { editor: false, offered: false, frozen: false }, start: false, finish: false, cameras: false },
    { reader: { editor: false, offered: false, frozen: true }, start: false, finish: false, cameras: false },
    { reader: { editor: false, offered: true, frozen: false }, start: false, finish: false, cameras: false },
    { reader: { editor: false, offered: true, frozen: true }, start: false, finish: false, cameras: false },
    { reader: { editor: true, offered: false, frozen: false }, start: false, finish: true, cameras: false },
    { reader: { editor: true, offered: false, frozen: true }, start: false, finish: true, cameras: false },
    { reader: { editor: true, offered: true, frozen: false }, start: true, finish: true, cameras: true },
    { reader: { editor: true, offered: true, frozen: true }, start: false, finish: true, cameras: true },
  ];

  it("the table holds every reader shape exactly once (8 = editor x offered x frozen), so the 24 cases below are all of them", () => {
    const seen = new Set(TABLE.map((r) => `${r.reader.editor}/${r.reader.offered}/${r.reader.frozen}`));
    expect(TABLE).toHaveLength(8);
    expect(seen.size).toBe(8);
    for (const editor of [false, true]) for (const offered of [false, true]) for (const frozen of [false, true]) expect(seen.has(`${editor}/${offered}/${frozen}`)).toBe(true);
  });

  it("24 cases: 8 reader shapes x start, finish and cameras", () => {
    let checked = 0;
    for (const row of TABLE) {
      const label = `editor=${row.reader.editor} offered=${row.reader.offered} frozen=${row.reader.frozen}`;
      expect(mayPress(row.reader, "start"), `start ${label}`).toBe(row.start);
      expect(mayPress(row.reader, "finish"), `finish ${label}`).toBe(row.finish);
      expect(mayPress(row.reader, "cameras"), `cameras ${label}`).toBe(row.cameras);
      checked += 3;
    }
    expect(checked).toBe(24);
  });

  it("O4, the pair: a billing-frozen competition refuses START for every reader; the same editor unfrozen in an offered club may start", () => {
    const frozenShapes = TABLE.filter((r) => r.reader.frozen);
    expect(frozenShapes).toHaveLength(4);
    for (const r of frozenShapes) expect(mayPress(r.reader, "start"), JSON.stringify(r.reader)).toBe(false);
    expect(mayPress({ editor: true, offered: true, frozen: false }, "start")).toBe(true);
  });

  it("finish and cameras read the same frozen or not (a result is scoring, and watching writes nothing)", () => {
    let checked = 0;
    for (const editor of [false, true]) {
      for (const offered of [false, true]) {
        for (const what of ["finish", "cameras"] as const) {
          expect(mayPress({ editor, offered, frozen: true }, what), `${what} editor=${editor} offered=${offered}`).toBe(mayPress({ editor, offered, frozen: false }, what));
          checked += 1;
        }
      }
    }
    expect(checked).toBe(8);
  });

  it("a viewer who may only look gets no press of any kind, in any club, frozen or not", () => {
    let checked = 0;
    for (const offered of [false, true]) {
      for (const frozen of [false, true]) {
        for (const what of ["start", "finish", "cameras"] as const) {
          expect(mayPress({ editor: false, offered, frozen }, what)).toBe(false);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(12);
  });
});
