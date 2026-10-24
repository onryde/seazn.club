// The Arbiter Panel round column's model (spec 2026-10-24-arbiter-round-column-design.md §5.2, §5.3, §5.5, §5.6, §8):
// phase, check-in clock, tallies, the attention count, the review target, the entry line and the next-round views, all
// pure. Every expected value below comes from the spec or from the declarations the model leans on:
//   - the check-in window is `inExtendWindow`'s half-open `[opensAt, deadlineAt)` (lib/checkin-extend.ts), the one
//     authority, which this suite uses as an ORACLE for its boundary sweep and never re-derives;
//   - "over" is `boardIsOver` (lib/arbiter-view.ts);
//   - the entry line's order is spec §8: attention, then check-in, then ready.
// Each describe states its empty case first, and each ladder carries the case where the order decides the answer.
import { describe, expect, it } from "vitest";
import type { ArbiterBoard, ArbiterBoardState, ArbiterRound, ArbiterSeatCheckin } from "../arbiter-view";
import { boardIsOver } from "../arbiter-view";
import type { CheckinExtendState } from "../checkin-extend";
import { EXTEND_REFUSALS, emptyExtendTally, inExtendWindow, liveExtendRefusal } from "../checkin-extend";
import type { ExtendRefusal } from "../checkin-extend";
import type { OpenRoundView } from "../open-round";
import type { FlaggedBoard } from "@/server/usecases/external-play/arbiter";
import type { NeedsOrganiserExternalPlayRow } from "@/server/usecases/external-play/queue";
import type { CheckinClock } from "../round-column";
import {
  attentionCount,
  checkinClock,
  checkinTally,
  entryLine,
  entryStatus,
  nextRoundViews,
  openWindowBoards,
  playingTally,
  reviewTarget,
  roundColumnPhase,
  viewOfRound,
} from "../round-column";

// ---- fixtures -------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A check-in window by offsets (ms) from NOW: it opens at `NOW + from` and its deadline is `NOW + to`. */
function checkin(from: number, to: number, over: Partial<CheckinExtendState> = {}): CheckinExtendState {
  return { canExtend: true, refusal: null, extensionsLeft: 3, opensAt: iso(NOW + from), deadlineAt: iso(NOW + to), ...over };
}

/** The window every "open now" board sits in: opened ten minutes ago, closes in `closesIn` minutes. */
const openNow = (closesIn = 8) => checkin(-10 * MIN, closesIn * MIN);
/** A later check-in group: opens `opensIn` minutes from now. */
const later = (opensIn = 15) => checkin(opensIn * MIN, (opensIn + 10) * MIN);
/** A group whose deadline has passed while the board is still checking_in. */
const pastDeadline = () => checkin(-20 * MIN, -1 * MIN, { canExtend: false, refusal: "closed" });

const seat = (here: boolean, invites: ArbiterSeatCheckin["invites"] = []): ArbiterSeatCheckin => ({ here, invites });

let nextId = 0;
function board(over: Partial<ArbiterBoard> = {}): ArbiterBoard {
  nextId += 1;
  return {
    fixtureId: `fx-${nextId}`,
    fixtureNo: nextId,
    boardNo: nextId,
    white: { name: "White Player", personId: null },
    black: { name: "Black Player", personId: null },
    state: { kind: "checking_in" },
    clock: null,
    cameraPolicy: "off",
    videoOverridden: false,
    cameraReport: null,
    sides: {
      home: { state: "none", endedAt: null, evidenceAt: null },
      away: { state: "none", endedAt: null, evidenceAt: null },
    },
    canResync: false,
    playable: true,
    canSettle: false,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    checkin: null,
    seats: null,
    flags: [],
    ...over,
  };
}

const withState = (state: ArbiterBoardState, over: Partial<ArbiterBoard> = {}) => board({ state, ...over });
/** A checking_in board in `window`, with its two seats. */
const checkingIn = (window: CheckinExtendState | null, seats: ArbiterBoard["seats"] = null) =>
  board({ state: { kind: "checking_in" }, checkin: window, seats });

function round(boards: ArbiterBoard[], over: Partial<ArbiterRound> = {}): ArbiterRound {
  return {
    stageId: "stage-1",
    stageName: "Swiss",
    roundNo: 2,
    timeControl: "10+5",
    boards,
    ownBoards: 0,
    current: true,
    extendableBoards: 0,
    ...over,
  };
}

function view(over: Partial<OpenRoundView> = {}): OpenRoundView {
  return {
    stageId: "stage-1",
    stageName: "Swiss",
    roundNo: 1,
    state: "paired",
    openedAt: null,
    deadlineAt: null,
    windowMinutes: 10,
    staggered: false,
    batches: [],
    staggerSpanMinutes: 0,
    scheduledAt: null,
    press: "open",
    pairings: [],
    extendableBoards: 0,
    extendWindows: [],
    extendRefusals: emptyExtendTally(),
    earlierInPlay: [],
    ...over,
  };
}

/** A round that is open: stamped, its last deadline `closesIn` minutes from NOW (negative: passed). */
const openView = (roundNo: number, closesIn: number | null, press: OpenRoundView["press"] = "reinvite", stageId = "stage-1") =>
  view({
    stageId,
    roundNo,
    state: "open",
    openedAt: iso(NOW - 10 * MIN),
    deadlineAt: closesIn === null ? null : iso(NOW + closesIn * MIN),
    press,
  });
/** A round that is paired and waiting for its Open. */
const pairedView = (roundNo: number, stageId = "stage-1") => view({ stageId, roundNo, state: "paired", press: "open" });

function held(over: Partial<NeedsOrganiserExternalPlayRow> = {}): NeedsOrganiserExternalPlayRow {
  nextId += 1;
  return {
    fixtureId: `held-${nextId}`,
    fixtureNo: nextId,
    homeName: "Home",
    awayName: "Away",
    scheduledAt: null,
    reason: "no_show_white",
    lastError: null,
    whiteSide: "home",
    revokedSeat: null,
    roundNo: 2,
    boardNo: nextId,
    stageName: "Swiss",
    canResync: false,
    seated: false,
    noResultOffer: { kind: "void" },
    ...over,
  };
}

function flagged(over: Partial<ArbiterBoard> = {}, roundNo: number | null = 2): FlaggedBoard {
  return { ...board({ state: { kind: "result", score: "1-0", noResult: false }, ...over }), roundNo, stageName: "Swiss" };
}

/** Every state kind the board can be in, with the answer each tally owes it (spec §5.3 / §5.5: "playing" is `starting` +
 *  `live`; a held board is the queue's, not "playing"; "finished" is a board that is over, `boardIsOver`). Keyed by kind
 *  through `Record`, so a new kind in `ArbiterBoardState` is a type error here until it gets a row (and a verdict). */
const STATE_TABLE: Record<ArbiterBoardState["kind"], { states: ArbiterBoardState[]; playing: boolean; finished: boolean }> = {
  checking_in: { states: [{ kind: "checking_in" }], playing: false, finished: false },
  starting: { states: [{ kind: "starting" }], playing: true, finished: false },
  live: { states: [{ kind: "live", moveNo: 12 }], playing: true, finished: false },
  on_hold: { states: [{ kind: "on_hold" }], playing: false, finished: false },
  result: {
    states: [
      { kind: "result", score: "1-0", noResult: false },
      { kind: "result", score: null, noResult: true },
    ],
    playing: false,
    finished: true,
  },
  cancelled: { states: [{ kind: "cancelled" }], playing: false, finished: true },
};
/** One entry per state shape in the table (a kind with two shapes, like a played result and a void, appears twice). */
const EVERY_STATE = Object.values(STATE_TABLE).flatMap((row) => row.states.map((state) => ({ state, playing: row.playing, finished: row.finished })));

// ---- roundColumnPhase -----------------------------------------------------------------------------------------

describe("roundColumnPhase", () => {
  it("no round: before (the empty case, nothing requested)", () => {
    expect(roundColumnPhase(null, null)).toBe("before");
  });

  it("requested set: none, whatever the round is (none yet, or opened and playing)", () => {
    const playing = round([withState({ kind: "live", moveNo: 3 })]);
    let checked = 0;
    for (const requested of ["unavailable", "own"] as const) {
      for (const r of [null, playing]) {
        expect(roundColumnPhase(r, requested), `${requested} / ${r === null ? "no round" : "a round"}`).toBe("none");
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(4);
  });

  it("a board checking_in: checkin, even beside boards already playing", () => {
    const r = round([withState({ kind: "live", moveNo: 3 }), checkingIn(openNow())]);
    expect(roundColumnPhase(r, null)).toBe("checkin");
  });

  it("none checking_in: playing (live, held and finished boards only)", () => {
    const r = round([
      withState({ kind: "live", moveNo: 3 }),
      withState({ kind: "on_hold" }),
      withState({ kind: "result", score: "1-0", noResult: false }),
    ]);
    expect(roundColumnPhase(r, null)).toBe("playing");
  });

  it("every board your own (boards [], ownBoards 2): playing, with no boards to count", () => {
    expect(roundColumnPhase(round([], { ownBoards: 2 }), null)).toBe("playing");
  });

  it("a pinned older round (current false) takes its phase from the round on screen", () => {
    expect(roundColumnPhase(round([checkingIn(openNow())], { current: false }), null)).toBe("checkin");
    expect(roundColumnPhase(round([withState({ kind: "live", moveNo: 1 })], { current: false }), null)).toBe("playing");
  });

  it('ORDER: requested "own" with a round in check-in is none, not checkin', () => {
    const inCheckin = round([checkingIn(openNow())]);
    expect(roundColumnPhase(inCheckin, "own")).toBe("none");
    expect(roundColumnPhase(inCheckin, "unavailable")).toBe("none");
  });
});

// ---- openWindowBoards -----------------------------------------------------------------------------------------

describe("openWindowBoards", () => {
  it("empty: no boards, no open window", () => {
    expect(openWindowBoards([], NOW)).toEqual([]);
  });

  it("a not-yet-open board of a later group is in neither the tally nor the waiting set (A6)", () => {
    const open = checkingIn(openNow(), { white: seat(false), black: seat(true) });
    const ahead = checkingIn(later(), { white: seat(true), black: seat(true) });
    const boards = [open, ahead];
    expect(openWindowBoards(boards, NOW)).toEqual([open]);
    // The tally reads the same set: two seats for the one open board, and the later group's two present seats are not here.
    expect(checkinTally(boards, NOW)).toMatchObject({ seats: 2, here: 1 });
  });

  it("a board past its deadline but still checking_in is in neither", () => {
    const open = checkingIn(openNow(), { white: seat(true), black: seat(false) });
    const closed = checkingIn(pastDeadline(), { white: seat(true), black: seat(true) });
    const boards = [closed, open];
    expect(openWindowBoards(boards, NOW)).toEqual([open]);
    expect(checkinTally(boards, NOW)).toMatchObject({ seats: 2, here: 1 });
  });

  it("a checking_in board with checkin null is not in the set (the guard, reached)", () => {
    expect(openWindowBoards([checkingIn(null)], NOW)).toEqual([]);
  });

  it("only a checking_in board: a board with a game on file is never waited on, whatever its window says", () => {
    const boards = [
      withState({ kind: "starting" }, { checkin: openNow() }),
      withState({ kind: "live", moveNo: 2 }, { checkin: openNow() }),
      withState({ kind: "on_hold" }, { checkin: openNow() }),
      withState({ kind: "result", score: "1-0", noResult: false }, { checkin: openNow() }),
    ];
    expect(openWindowBoards(boards, NOW)).toEqual([]);
  });

  it("a board with no presses left is still in its open window (the cap is the +5's business, not the window's)", () => {
    const capped = checkingIn(openNow(), null);
    capped.checkin = { ...openNow(), extensionsLeft: 0, canExtend: false, refusal: "cap_reached" };
    expect(openWindowBoards([capped], NOW)).toEqual([capped]);
  });

  it("keeps board order", () => {
    const a = checkingIn(openNow(3));
    const b = checkingIn(openNow(9));
    const c = checkingIn(openNow(1));
    expect(openWindowBoards([b, a, c], NOW)).toEqual([b, a, c]);
  });

  it("agrees with inExtendWindow at every probe around both edges (the declared half-open window is the oracle)", () => {
    const opensAt = NOW + 5 * MIN;
    const deadlineAt = NOW + 15 * MIN;
    const probes = [opensAt - MIN, opensAt - 1, opensAt, opensAt + 1, deadlineAt - 1, deadlineAt, deadlineAt + 1];
    const w = { opensAt: iso(opensAt), deadlineAt: iso(deadlineAt), extensionsLeft: 3 };
    const b = checkingIn({ canExtend: true, refusal: null, ...w });
    let inside = 0;
    let outside = 0;
    for (const t of probes) {
      const want = inExtendWindow(w, t);
      expect(openWindowBoards([b], t).length === 1, `at ${iso(t)}`).toBe(want);
      if (want) inside += 1;
      else outside += 1;
    }
    expect(probes.length, "anti-vacuity: probes checked").toBe(7);
    // Both outcomes were witnessed: the sweep cannot pass on an always-in or an always-out set.
    expect(inside, "probes inside the window").toBeGreaterThan(0);
    expect(outside, "probes outside the window").toBeGreaterThan(0);
  });
});

// ---- checkinClock ---------------------------------------------------------------------------------------------

describe("checkinClock", () => {
  it("no checking_in board: closed (no boards at all, then boards that are all past check-in)", () => {
    expect(checkinClock([], NOW)).toEqual({ kind: "closed" });
    const noneCheckingIn = [
      withState({ kind: "live", moveNo: 2 }, { checkin: openNow() }),
      withState({ kind: "result", score: "1-0", noResult: false }, { checkin: later() }),
    ];
    expect(checkinClock(noneCheckingIn, NOW)).toEqual({ kind: "closed" });
  });

  it("one open window: closes at its deadline", () => {
    const w = openNow(8);
    expect(checkinClock([checkingIn(w)], NOW)).toEqual({ kind: "closes", at: w.deadlineAt });
  });

  it("two open windows: the EARLIER deadline, whichever board is listed first", () => {
    const soon = openNow(3);
    const lateOne = openNow(9);
    expect(checkinClock([checkingIn(lateOne), checkingIn(soon)], NOW)).toEqual({ kind: "closes", at: soon.deadlineAt });
    expect(checkinClock([checkingIn(soon), checkingIn(lateOne)], NOW)).toEqual({ kind: "closes", at: soon.deadlineAt });
  });

  it("nothing open, a later group ahead: opens at the earliest opensAt", () => {
    const near = later(5);
    const far = later(20);
    expect(checkinClock([checkingIn(far), checkingIn(near)], NOW)).toEqual({ kind: "opens", at: near.opensAt });
  });

  it("ORDER: an open window outranks a later group (closes, not opens)", () => {
    const open = openNow(8);
    expect(checkinClock([checkingIn(later(5)), checkingIn(open)], NOW)).toEqual({ kind: "closes", at: open.deadlineAt });
  });

  it("a group that has closed does not hide a later one still to open", () => {
    const ahead = later(5);
    expect(checkinClock([checkingIn(pastDeadline()), checkingIn(ahead)], NOW)).toEqual({ kind: "opens", at: ahead.opensAt });
  });

  it("only closed groups left: closed, not opens", () => {
    expect(checkinClock([checkingIn(pastDeadline())], NOW)).toEqual({ kind: "closed" });
  });

  it("at exactly deadlineAt the window is closed (the deadline is excluded)", () => {
    const w = checkin(-10 * MIN, 0);
    // The oracle: the declared window excludes its deadline.
    expect(inExtendWindow(w, NOW)).toBe(false);
    expect(checkinClock([checkingIn(w)], NOW)).toEqual({ kind: "closed" });
    // One millisecond earlier it is still open.
    expect(inExtendWindow(w, NOW - 1)).toBe(true);
    expect(checkinClock([checkingIn(w)], NOW - 1)).toEqual({ kind: "closes", at: w.deadlineAt });
  });

  it("at exactly opensAt it is open (the opening is included)", () => {
    const w = checkin(0, 10 * MIN);
    expect(inExtendWindow(w, NOW)).toBe(true);
    expect(checkinClock([checkingIn(w)], NOW)).toEqual({ kind: "closes", at: w.deadlineAt });
    // One millisecond earlier it has not opened: the clock says when it will.
    expect(inExtendWindow(w, NOW - 1)).toBe(false);
    expect(checkinClock([checkingIn(w)], NOW - 1)).toEqual({ kind: "opens", at: w.opensAt });
  });

  it("agrees with the window's owner at every probe around both edges (inExtendWindow and liveExtendRefusal are the oracle)", () => {
    const opensAt = NOW + 5 * MIN;
    const deadlineAt = NOW + 15 * MIN;
    const probes = [opensAt - MIN, opensAt - 1, opensAt, opensAt + 1, deadlineAt - 1, deadlineAt, deadlineAt + 1];
    const w = checkin(5 * MIN, 15 * MIN);
    const seen = new Set<string>();
    for (const t of probes) {
      // closes iff inside the declared half-open window; opens iff outside it and the window's owner says "not_open"; else closed.
      const want: CheckinClock = inExtendWindow(w, t)
        ? { kind: "closes", at: w.deadlineAt }
        : liveExtendRefusal(w, t) === "not_open"
          ? { kind: "opens", at: w.opensAt }
          : { kind: "closed" };
      expect(checkinClock([checkingIn(w)], t), `at ${iso(t)}`).toEqual(want);
      seen.add(want.kind);
    }
    expect(probes.length, "anti-vacuity: probes checked").toBe(7);
    // All three outcomes were witnessed: the sweep cannot pass on a clock that only ever says one thing.
    expect([...seen].sort()).toEqual(["closed", "closes", "opens"]);
    // ...and the oracle itself agrees with the declaration it leans on (the window is [opensAt, deadlineAt)), probe by probe.
    expect(probes.map((t) => checkinClock([checkingIn(w)], t).kind)).toEqual(["opens", "opens", "closes", "closes", "closes", "closed", "closed"]);
  });

  it("a checking_in board with checkin null is ignored (the guard, reached)", () => {
    expect(checkinClock([checkingIn(null)], NOW)).toEqual({ kind: "closed" });
    const w = openNow(6);
    expect(checkinClock([checkingIn(null), checkingIn(w)], NOW)).toEqual({ kind: "closes", at: w.deadlineAt });
  });

  it("a board that is not checking_in is ignored even when its window is open", () => {
    const w = openNow(2);
    const live = withState({ kind: "live", moveNo: 4 }, { checkin: w });
    const other = openNow(9);
    expect(checkinClock([live, checkingIn(other)], NOW)).toEqual({ kind: "closes", at: other.deadlineAt });
  });
});

// ---- checkinTally ---------------------------------------------------------------------------------------------

describe("checkinTally", () => {
  it("empty: all zero", () => {
    expect(checkinTally([], NOW)).toEqual({ here: 0, seats: 0, playing: 0, finished: 0 });
  });

  it("seats are two per open-window board", () => {
    const boards = [checkingIn(openNow()), checkingIn(openNow()), checkingIn(openNow()), checkingIn(later())];
    expect(checkinTally(boards, NOW).seats).toBe(6);
  });

  it("here counts seats.white.here and seats.black.here", () => {
    const boards = [
      checkingIn(openNow(), { white: seat(true), black: seat(false) }),
      checkingIn(openNow(), { white: seat(false), black: seat(true) }),
      checkingIn(openNow(), { white: seat(true), black: seat(true) }),
      checkingIn(openNow(), { white: seat(false), black: seat(false) }),
    ];
    expect(checkinTally(boards, NOW)).toMatchObject({ here: 4, seats: 8 });
  });

  it("seats null on an open-window board counts as not here (the guard, reached), and still counts its two seats", () => {
    expect(checkinTally([checkingIn(openNow(), null)], NOW)).toMatchObject({ here: 0, seats: 2 });
  });

  it("a seat with no invite words is still a seat, and presence is independent of the invite", () => {
    const b = checkingIn(openNow(), { white: seat(true, []), black: seat(false, []) });
    expect(checkinTally([b], NOW)).toMatchObject({ here: 1, seats: 2 });
  });

  it("playing = starting + live; a held board is not playing", () => {
    // The differential: one on_hold board beside one live board is 1 playing, never 2.
    const live = withState({ kind: "live", moveNo: 9 });
    const onHold = withState({ kind: "on_hold" });
    expect(checkinTally([onHold, live], NOW).playing).toBe(1);
    // starting counts as playing too.
    expect(checkinTally([withState({ kind: "starting" }), live, onHold], NOW).playing).toBe(2);
  });

  it("finished = result boards (a played result and a void both count)", () => {
    const boards = [
      withState({ kind: "result", score: "1-0", noResult: false }),
      withState({ kind: "result", score: null, noResult: true }),
      withState({ kind: "live", moveNo: 1 }),
    ];
    expect(checkinTally(boards, NOW).finished).toBe(2);
  });

  it("playing and finished count every board on screen, not only the open-window ones", () => {
    const boards = [
      checkingIn(openNow(), { white: seat(true), black: seat(true) }),
      withState({ kind: "live", moveNo: 5 }),
      withState({ kind: "result", score: "0-1", noResult: false }),
      checkingIn(later()),
    ];
    expect(checkinTally(boards, NOW)).toEqual({ here: 2, seats: 2, playing: 1, finished: 1 });
  });
});

// ---- playingTally ---------------------------------------------------------------------------------------------

describe("playingTally", () => {
  it("empty boards: { playing: 0, total: 0, finished: 0 }", () => {
    expect(playingTally([])).toEqual({ playing: 0, total: 0, finished: 0 });
  });

  it("total is the boards on screen, whatever state each is in", () => {
    const boards = EVERY_STATE.map((row) => withState(row.state));
    expect(boards.length, "anti-vacuity").toBeGreaterThan(0);
    expect(playingTally(boards).total).toBe(EVERY_STATE.length);
  });

  it("every state kind lands where the spec puts it (playing is starting + live; held is neither; over is finished)", () => {
    let checked = 0;
    for (const row of EVERY_STATE) {
      const t = playingTally([withState(row.state)]);
      expect(t, JSON.stringify(row.state)).toEqual({ playing: row.playing ? 1 : 0, total: 1, finished: row.finished ? 1 : 0 });
      // The table's "finished" is the declared `boardIsOver`, not a second opinion.
      expect(row.finished, `${row.state.kind} vs boardIsOver`).toBe(boardIsOver(row.state));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(EVERY_STATE.length);
    // Completeness is the type's job (`Record` over every kind); at runtime the table must still reach at least one of each outcome.
    expect(EVERY_STATE.some((r) => r.playing)).toBe(true);
    expect(EVERY_STATE.some((r) => r.finished)).toBe(true);
    expect(EVERY_STATE.some((r) => !r.playing && !r.finished)).toBe(true);
  });

  it("a held board beside a live one is playing 1 of 2, never 2", () => {
    expect(playingTally([withState({ kind: "on_hold" }), withState({ kind: "live", moveNo: 3 })])).toEqual({ playing: 1, total: 2, finished: 0 });
  });
});

// ---- attentionCount (C6) --------------------------------------------------------------------------------------

describe("attentionCount", () => {
  it("empty: 0", () => {
    expect(attentionCount([], [])).toBe(0);
  });

  it("held rows and flagged boards each count, by distinct fixture", () => {
    expect(attentionCount([held(), held()], [flagged(), flagged(), flagged()])).toBe(5);
  });

  it("a held board with an open flag counts once", () => {
    const row = held();
    const both = flagged({ fixtureId: row.fixtureId });
    expect(attentionCount([row], [both])).toBe(1);
  });

  it("two held rows of one fixture count once", () => {
    const row = held();
    expect(attentionCount([row, { ...row }], [])).toBe(1);
  });

  it("a seated held row is not counted", () => {
    expect(attentionCount([held({ seated: true })], [])).toBe(0);
    // ...and it does not hide the rows beside it.
    expect(attentionCount([held({ seated: true }), held()], [])).toBe(1);
  });

  it("a seated held row that is also flagged counts once, through the flag", () => {
    const row = held({ seated: true });
    expect(attentionCount([row], [flagged({ fixtureId: row.fixtureId })])).toBe(1);
  });

  it("a cancelled flagged board counts", () => {
    expect(attentionCount([], [flagged({ state: { kind: "cancelled" } })])).toBe(1);
  });
});

// ---- reviewTarget ---------------------------------------------------------------------------------------------

describe("reviewTarget", () => {
  const plain = { seated: false, cancelled: false };

  it("round null: link (the empty case: there is no round to select in)", () => {
    expect(reviewTarget("fx-x", null, plain)).toEqual({ kind: "link" });
  });

  it("a round with no boards (every board your own): link", () => {
    expect(reviewTarget("fx-x", round([], { ownBoards: 2 }), plain)).toEqual({ kind: "link" });
  });

  it("fixture in round.boards: select", () => {
    const b = board();
    expect(reviewTarget(b.fixtureId, round([board(), b]), plain)).toEqual({ kind: "select" });
  });

  it("not in the round: link", () => {
    expect(reviewTarget("elsewhere", round([board(), board()]), plain)).toEqual({ kind: "link" });
  });

  it("seated: none, even for a fixture that is in the round (seated outranks select)", () => {
    const b = board();
    expect(reviewTarget(b.fixtureId, round([b]), { seated: true, cancelled: false })).toEqual({ kind: "none" });
    expect(reviewTarget("elsewhere", round([b]), { seated: true, cancelled: false })).toEqual({ kind: "none" });
  });

  it("cancelled: none (cancelled outranks link), also with no round", () => {
    expect(reviewTarget("elsewhere", round([board()]), { seated: false, cancelled: true })).toEqual({ kind: "none" });
    expect(reviewTarget("elsewhere", null, { seated: false, cancelled: true })).toEqual({ kind: "none" });
  });
});

// ---- entryStatus and entryLine (C7) ---------------------------------------------------------------------------

describe("entryStatus and entryLine", () => {
  it("nothing: default (no views, no attention), and the line is the card's existing body", () => {
    const s = entryStatus([], 0, NOW);
    expect(s).toEqual({ attention: 0, phase: "default", roundNo: null });
    expect(entryLine(s)).toEqual({ kind: "default" });
  });

  it("views with nothing to open and no check-in running: default", () => {
    const views = [openView(1, -5, "none"), openView(2, null, "none")];
    expect(entryStatus(views, 0, NOW)).toEqual({ attention: 0, phase: "default", roundNo: null });
  });

  it("attention 2 and a round ready: the line is attention, and the status still says ready", () => {
    const s = entryStatus([pairedView(3)], 2, NOW);
    // The two facts stay separate (desk _RULES): attention is not folded into the phase.
    expect(s).toEqual({ attention: 2, phase: "ready", roundNo: 3 });
    expect(entryLine(s)).toEqual({ kind: "attention", count: 2 });
  });

  it("attention outranks a check-in in progress too", () => {
    const s = entryStatus([openView(2, 8)], 1, NOW);
    expect(s).toEqual({ attention: 1, phase: "checkin", roundNo: 2 });
    expect(entryLine(s)).toEqual({ kind: "attention", count: 1 });
  });

  it("a round open with deadlineAt ahead: checkin", () => {
    const s = entryStatus([openView(2, 8)], 0, NOW);
    expect(s).toEqual({ attention: 0, phase: "checkin", roundNo: 2 });
    expect(entryLine(s)).toEqual({ kind: "checkin", roundNo: 2 });
  });

  it('a round paired with press "open": ready', () => {
    const s = entryStatus([pairedView(4)], 0, NOW);
    expect(s).toEqual({ attention: 0, phase: "ready", roundNo: 4 });
    expect(entryLine(s)).toEqual({ kind: "ready", roundNo: 4 });
  });

  it("ORDER: checkin and ready both (a league pairs every round at Generate): checkin", () => {
    const views = [pairedView(3), openView(2, 8)];
    const s = entryStatus(views, 0, NOW);
    expect(s).toEqual({ attention: 0, phase: "checkin", roundNo: 2 });
    expect(entryLine(s)).toEqual({ kind: "checkin", roundNo: 2 });
    // Listed the other way round, the answer is the same: it is the ladder, not the list order, that decides.
    expect(entryStatus([...views].reverse(), 0, NOW)).toEqual({ attention: 0, phase: "checkin", roundNo: 2 });
  });

  it("deadlineAt passed: not checkin", () => {
    expect(entryStatus([openView(2, -1)], 0, NOW).phase).toBe("default");
  });

  it("at exactly deadlineAt the check-in is over; one millisecond before it is on", () => {
    const v = openView(2, 5);
    const deadline = Date.parse(v.deadlineAt ?? "");
    expect(entryStatus([v], 0, deadline).phase).toBe("default");
    expect(entryStatus([v], 0, deadline - 1).phase).toBe("checkin");
  });

  it("an open round with no deadline on it is not a check-in (the guard, reached)", () => {
    expect(entryStatus([openView(2, null)], 0, NOW).phase).toBe("default");
  });

  it("with several rounds, the first in the reader's order that qualifies names the round", () => {
    // Round 1's check-in is over, round 2's and 3's are on: round 2 (the first that qualifies) is named.
    const checkins = [openView(1, -5, "none"), openView(2, 8), openView(3, 12)];
    expect(entryStatus(checkins, 0, NOW)).toEqual({ attention: 0, phase: "checkin", roundNo: 2 });
    // Listed [3, 2], the FIRST LISTED names the round: 3, not the lowest number.
    expect(entryStatus([openView(3, 12), openView(2, 8)], 0, NOW)).toEqual({ attention: 0, phase: "checkin", roundNo: 3 });
    const readies = [openView(1, -5, "none"), pairedView(3), pairedView(2)];
    expect(entryStatus(readies, 0, NOW)).toEqual({ attention: 0, phase: "ready", roundNo: 3 });
  });

  it("entryLine: attention 0 with a phase and a round reads the phase; with no round to name it falls back to default", () => {
    expect(entryLine({ attention: 0, phase: "checkin", roundNo: 5 })).toEqual({ kind: "checkin", roundNo: 5 });
    expect(entryLine({ attention: 0, phase: "ready", roundNo: 5 })).toEqual({ kind: "ready", roundNo: 5 });
    // A phase with no round number cannot be said ("Round null"): the guard lands on the default body.
    expect(entryLine({ attention: 0, phase: "checkin", roundNo: null })).toEqual({ kind: "default" });
    expect(entryLine({ attention: 0, phase: "ready", roundNo: null })).toEqual({ kind: "default" });
    // Attention needs no round.
    expect(entryLine({ attention: 3, phase: "default", roundNo: null })).toEqual({ kind: "attention", count: 3 });
  });
});

// ---- viewOfRound ----------------------------------------------------------------------------------------------

describe("viewOfRound", () => {
  it("empty: no views, no view of the round", () => {
    expect(viewOfRound([], { stageId: "stage-1", roundNo: 2 })).toBeNull();
  });

  it("finds the view of the same stage and round number", () => {
    const want = openView(2, 8, "reinvite", "stage-1");
    const views = [openView(2, 8, "reinvite", "stage-2"), openView(1, 8, "reinvite", "stage-1"), want];
    expect(viewOfRound(views, { stageId: "stage-1", roundNo: 2 })).toBe(want);
  });

  it("the same round number in another stage is not this round's view, and an absent round is null", () => {
    const views = [openView(2, 8, "reinvite", "stage-2")];
    expect(viewOfRound(views, { stageId: "stage-1", roundNo: 2 })).toBeNull();
    expect(viewOfRound(views, { stageId: "stage-2", roundNo: 9 })).toBeNull();
  });
});

// ---- nextRoundViews -------------------------------------------------------------------------------------------

describe("nextRoundViews", () => {
  it("empty: no views, no next round", () => {
    expect(nextRoundViews([], round([]))).toEqual([]);
    expect(nextRoundViews([], null)).toEqual([]);
  });

  it("pinned round (current false): [] even though a round is waiting to open", () => {
    const views = [pairedView(3)];
    expect(nextRoundViews(views, round([], { current: true }))).toHaveLength(1);
    expect(nextRoundViews(views, round([], { current: false }))).toEqual([]);
  });

  it("excludes the round on screen (by stage AND round number)", () => {
    const onScreen = pairedView(2, "stage-1");
    const sameNoOtherStage = pairedView(2, "stage-2");
    const sameStageOtherNo = pairedView(3, "stage-1");
    const r = round([], { stageId: "stage-1", roundNo: 2 });
    expect(nextRoundViews([onScreen, sameNoOtherStage, sameStageOtherNo], r)).toEqual([sameNoOtherStage, sameStageOtherNo]);
  });

  it('keeps only press "open"', () => {
    const open = pairedView(4);
    const others = [openView(1, 5, "reinvite"), openView(2, 5, "reopen"), openView(3, 5, "none")];
    expect(nextRoundViews([...others, open], round([]))).toEqual([open]);
  });

  it("keeps the reader's order (not sorted by round number)", () => {
    const a = pairedView(5, "stage-2");
    const b = pairedView(3, "stage-1");
    const c = pairedView(4, "stage-3");
    expect(nextRoundViews([a, b, c], round([], { stageId: "stage-9", roundNo: 1 }))).toEqual([a, b, c]);
  });

  it("no round on screen: every view waiting to open (nothing to exclude, nothing pinned)", () => {
    const a = pairedView(1);
    const b = pairedView(1, "stage-2");
    expect(nextRoundViews([a, openView(2, 5, "none"), b], null)).toEqual([a, b]);
  });
});

// ---- before the viewer's clock is known (nowMs null) ------------------------------------------------------------
//
// The arbiter page renders on the server and in the first client paint with no clock (`useExtendClock` answers null until it mounts).
// The convention of every other reader of a window (`boardExtendOffer`, `liveExtendableBoards`, `OpenRoundControl`) is that the
// SNAPSHOT's own word stands until the clock is known: `checkin.refusal` says where the board's window was when the page was read.
// The set, the clock and the tally must give the same answer from it, or the first paint disagrees with itself.

describe("no clock yet (nowMs null): the snapshot's refusal stands as the window's verdict", () => {
  /** What each declared refusal says about the board's window at the snapshot. The window has exactly two words of its own:
   *  `not_open` (still ahead) and `closed` (past). Every other verdict says nothing against it:
   *   - `cap_reached` is only ever judged INSIDE the window (window.ts `extendRefusal` judges closed and not_open before the cap);
   *   - `game_started` is the board's state, and a create marker can be on file while the board is still `checking_in`;
   *   - `not_playable` is a board that is over, which is never `checking_in` at all (arbiter.ts `boardOf` gives a playable board
   *     with no game that state). That row is UNREACHABLE through `openWindowBoards`; it was `false` while the rule listed it
   *     as shut, and is `true` since the rule was simplified to "shut iff not_open or closed" (Task 6 review m8). It is kept
   *     so that a sixth refusal word cannot be added without choosing, and so that the simplification is stated, not implied.
   *  Typed as a Record over the declared list, so a new refusal cannot be added without choosing. */
  const SNAPSHOT_SAYS_OPEN: Record<ExtendRefusal, boolean> = {
    not_open: false,
    closed: false,
    not_playable: true,
    game_started: true,
    cap_reached: true,
  };

  it("empty: no boards give an empty set, a closed clock and an all-zero tally", () => {
    expect(openWindowBoards([], null)).toEqual([]);
    expect(checkinClock([], null)).toEqual({ kind: "closed" });
    expect(checkinTally([], null)).toEqual({ here: 0, seats: 0, playing: 0, finished: 0 });
  });

  it("every declared refusal, and no refusal, is read once (the table covers the declared list)", () => {
    expect(Object.keys(SNAPSHOT_SAYS_OPEN).sort(), "the table is the declared list").toEqual([...EXTEND_REFUSALS].sort());
    let open = 0;
    let shut = 0;
    for (const refusal of [null, ...EXTEND_REFUSALS]) {
      const b = checkingIn(checkin(-10 * MIN, 8 * MIN, { refusal, canExtend: refusal === null }), { white: seat(true), black: seat(false) });
      const want = refusal === null ? true : SNAPSHOT_SAYS_OPEN[refusal];
      expect(openWindowBoards([b], null).length === 1, `refusal ${String(refusal)}`).toBe(want);
      expect(checkinTally([b], null), `tally, refusal ${String(refusal)}`).toMatchObject(want ? { here: 1, seats: 2 } : { here: 0, seats: 0 });
      if (want) open += 1;
      else shut += 1;
    }
    expect(open + shut, "anti-vacuity: refusals read (none + the declared five)").toBe(6);
    expect(open, "both outcomes witnessed").toBeGreaterThan(0);
    expect(shut, "both outcomes witnessed").toBeGreaterThan(0);
  });

  it("the clock: the earliest deadline among boards the snapshot says are open; else the earliest opening among those it says are ahead; else closed", () => {
    const soon = checkin(-10 * MIN, 3 * MIN);
    const farther = checkin(-10 * MIN, 9 * MIN);
    // A snapshot-open window outranks a later group, whichever is listed first.
    const ahead = checkin(5 * MIN, 15 * MIN, { refusal: "not_open", canExtend: false });
    expect(checkinClock([checkingIn(farther), checkingIn(ahead), checkingIn(soon)], null)).toEqual({ kind: "closes", at: soon.deadlineAt });
    // Nothing open: the earliest opening.
    const nearer = checkin(2 * MIN, 12 * MIN, { refusal: "not_open", canExtend: false });
    expect(checkinClock([checkingIn(ahead), checkingIn(nearer)], null)).toEqual({ kind: "opens", at: nearer.opensAt });
    // A group the snapshot saw closed is neither.
    expect(checkinClock([checkingIn(pastDeadline())], null)).toEqual({ kind: "closed" });
    expect(checkinClock([checkingIn(pastDeadline()), checkingIn(ahead)], null)).toEqual({ kind: "opens", at: ahead.opensAt });
  });

  it("agrees with the ticking clock whenever the snapshot is current: the same boards, the same clock, the same tally", () => {
    // The snapshot was read at NOW, so the refusal each fixture carries is the one the server gives at NOW; the null reading must
    // equal the NOW reading, or the first paint would flip when the clock arrives.
    const open = checkingIn(openNow(8), { white: seat(true), black: seat(false) });
    const ahead = checkingIn(checkin(15 * MIN, 25 * MIN, { refusal: "not_open", canExtend: false }), { white: seat(true), black: seat(true) });
    const closed = checkingIn(pastDeadline(), { white: seat(false), black: seat(false) });
    // Inside its window with no presses left: the server judges the cap only INSIDE the window (window.ts `extendRefusal`), so at the
    // snapshot instant its refusal is `cap_reached` and the window is open - the reading a ticking clock gives it too.
    const capped = checkingIn(checkin(-10 * MIN, 8 * MIN, { refusal: "cap_reached", canExtend: false, extensionsLeft: 0 }), { white: seat(true), black: seat(false) });
    const boards = [open, ahead, closed, capped];
    expect(openWindowBoards(boards, null)).toEqual(openWindowBoards(boards, NOW));
    expect(checkinClock(boards, null)).toEqual(checkinClock(boards, NOW));
    expect(checkinTally(boards, null)).toEqual(checkinTally(boards, NOW));
    expect(openWindowBoards(boards, NOW), "anti-vacuity: the compared set is not empty").toHaveLength(2);
    expect(openWindowBoards(boards, NOW), "the capped board is in the compared set, not skipped").toContain(capped);
    expect(openWindowBoards(boards, null)).toContain(capped);
    expect(checkinTally(boards, null), "both open boards' four seats are counted, the capped one included").toMatchObject({ here: 2, seats: 4 });
  });
});
