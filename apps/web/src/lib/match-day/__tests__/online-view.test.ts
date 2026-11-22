// Match Day online, Task 6: what the page's pure reading (lib/match-day/view.ts) says about the online block - when the page is "live",
// what the counts line adds, which division chips narrow the rounds, what is focused by default, and what `?court=`, `?board=` and
// `?round=` open. The rules of the rows themselves (order, words, focus resolution) are online.test.ts's; the markup is the component suites'.
//
// Where an expected value comes from: the live states and the default order are the plan's own sentences typed row by row ("any online
// round in check-in or with a starting or live board"; "a court when any court is listed", then a match on no court, then the first
// round); the counts line's words are the dictionary's. Anti-vacuity: every sweep counts what it checked.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { ArbiterBoardState } from "@/lib/arbiter-view";
import type { MatchDayCourt, MatchDayFixture } from "../types";
import {
  filterOnlineRounds,
  headerCountParts,
  isLive,
  openedFromParams,
  resolveDayFocus,
  resolveFocus,
} from "../view";
import {
  arbiterRound,
  board,
  checkinRound,
  done,
  earlier,
  held,
  live,
  onlineView,
  overRound,
  pairedRound,
  playingRound,
  round,
  withState,
} from "../../../components/v2/match-day/__tests__/_online-fixtures";

const dict = en as Dict;

const court = (id: string, name: string, over: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: id,
  court_name: name,
  venue_id: "v-1",
  venue_name: "Hall",
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  stream_link: null,
  ...over,
});
const match = (id: string): MatchDayFixture => ({ id, sport_key: "generic" }) as MatchDayFixture;

describe("isLive - an online night polls at the live cadence", () => {
  it("EMPTY CASE FIRST: no court, no match on no court, no online round - not live", () => {
    expect(isLive(onlineView([]))).toBe(false);
  });

  it("an online round in check-in is live with no court on the page at all", () => {
    expect(isLive(onlineView([checkinRound("s:3")]))).toBe(true);
  });

  it("a round paired and not opened, a division not started and a round that is over are quiet", () => {
    expect(isLive(onlineView([pairedRound("s:3")]))).toBe(false);
    expect(isLive(onlineView([round("s:3", "not_started", null)]))).toBe(false);
    expect(isLive(onlineView([overRound("s:3")]))).toBe(false);
  });

  it("every board state, alone in a round: only a board checking in, starting or live makes the page live (6 states)", () => {
    const table: [ArbiterBoardState["kind"], ArbiterBoardState, boolean][] = [
      ["checking_in", { kind: "checking_in" }, true],
      ["starting", { kind: "starting" }, true],
      ["live", { kind: "live", moveNo: 4 }, true],
      ["on_hold", { kind: "on_hold" }, false],
      ["result", { kind: "result", score: "1-0", noResult: false }, false],
      ["cancelled", { kind: "cancelled" }, false],
    ];
    let checked = 0;
    for (const [kind, state, expected] of table) {
      const b = kind === "checking_in" ? board() : withState(state);
      expect(isLive(onlineView([round("s:3", kind === "checking_in" ? "checkin" : "playing", arbiterRound([b]))])), kind).toBe(expected);
      checked++;
    }
    expect(checked, "anti-vacuity: all six board states").toBe(6);
  });

  it("a held board in an earlier round (the 'Needs a decision' group) is not a game under way", () => {
    expect(isLive(onlineView([round("s:3", "playing", arbiterRound([done()]), { needs_decision: [earlier(2, { state: { kind: "live", moveNo: 3 } })] })]))).toBe(false);
  });

  it("the old reasons still hold, and an online round adds to them rather than replacing them", () => {
    const c = court("c-1", "Court 1", { state: "playing" });
    expect(isLive(onlineView([], { courts: [c] }))).toBe(true);
    expect(isLive(onlineView([], { courts: [court("c-2", "Court 2")] }))).toBe(false);
    expect(isLive(onlineView([], { playing_no_court: [match("m-1")] }))).toBe(true);
    expect(isLive(onlineView([pairedRound("s:3")], { courts: [c] }))).toBe(true);
  });
});

describe("the counts line (§5.3): '... · 6 boards playing'", () => {
  const three = round("s:3", "playing", arbiterRound([live(), live(2), board(), held(1), done()]));
  const courts = [court("c-1", "Court 1", { state: "playing" }), court("c-2", "Court 2")];

  it("EMPTY CASE FIRST: no online round leaves every line exactly as it was", () => {
    expect(headerCountParts(dict, "en", "court", [], [])).toEqual(["0 courts"]);
    expect(headerCountParts(dict, "en", "court", [], [], [])).toEqual(["0 courts"]);
    expect(headerCountParts(dict, "en", "court", courts, [])).toEqual(["2 courts", "1 playing", "1 free"]);
    expect(headerCountParts(dict, "en", "court", courts, [], [])).toEqual(["2 courts", "1 playing", "1 free"]);
  });

  it("boards checking in, starting or live join the courts' counts (held and decided do not): '3 boards playing'", () => {
    expect(headerCountParts(dict, "en", "court", courts, [], [three])).toEqual(["2 courts", "1 playing", "1 free", "3 boards playing"]);
    const six = round("s:4", "playing", arbiterRound([live(), live(), live(), live(), live(), live()]));
    expect(headerCountParts(dict, "en", "court", courts, [], [six])).toEqual(["2 courts", "1 playing", "1 free", "6 boards playing"]);
    expect(headerCountParts(dict, "en", "court", courts, [], [round("s:5", "playing", arbiterRound([live()]))])[3]).toBe("1 board playing");
  });

  it("with no court the line is the boards' part alone, after the no-court count when there is one", () => {
    expect(headerCountParts(dict, "en", "court", [], [], [three])).toEqual(["3 boards playing"]);
    expect(headerCountParts(dict, "en", "court", [], [{ sport_key: "badminton" }], [three])).toEqual(["1 match with no court", "3 boards playing"]);
  });

  it("a round nobody has opened lists '0 boards playing' on a day with no court - not '0 courts'; with courts it adds nothing", () => {
    expect(headerCountParts(dict, "en", "court", [], [], [pairedRound("s:2")])).toEqual(["0 boards playing"]);
    expect(headerCountParts(dict, "en", "court", courts, [], [pairedRound("s:2")])).toEqual(["2 courts", "1 playing", "1 free"]);
  });
});

describe("the division chips narrow the rounds", () => {
  const rounds = [
    checkinRound("s:3", { division_id: "d-chess" }),
    pairedRound("t:1", { division_id: "d-blitz" }),
    playingRound("u:2", { division_id: "d-chess" }),
  ];

  it("no chip chosen (null) lists every round; a chosen division lists only its rounds; a division with none lists none", () => {
    expect(filterOnlineRounds(rounds, null).map((r) => r.key)).toEqual(["s:3", "t:1", "u:2"]);
    expect(filterOnlineRounds(rounds, new Set(["d-chess"])).map((r) => r.key)).toEqual(["s:3", "u:2"]);
    expect(filterOnlineRounds(rounds, new Set(["d-blitz", "d-chess"])).map((r) => r.key)).toEqual(["s:3", "t:1", "u:2"]);
    // A chip for an OTB division: the online block disappears (its division has no round on the page).
    expect(filterOnlineRounds(rounds, new Set(["d-badminton"]))).toEqual([]);
    expect(filterOnlineRounds([], new Set(["d-chess"]))).toEqual([]);
  });
});

describe("what is focused by default and what is opened (§5.2, §7)", () => {
  const r1 = checkinRound("s:3");
  const c1 = court("c-1", "Court 1");

  it("EMPTY CASE FIRST: nothing on the page - nothing focused", () => {
    expect(resolveDayFocus([], [], [], null)).toEqual({ kind: "none" });
  });

  it("the default is the FIRST ROW of the whole list: a court, else a match on no court, else the first online round", () => {
    expect(resolveDayFocus([c1], [match("m-1")], [r1], null)).toMatchObject({ kind: "court", court: { court_id: "c-1" } });
    expect(resolveDayFocus([], [match("m-1")], [r1], null)).toMatchObject({ kind: "match", fixture: { id: "m-1" } });
    expect(resolveDayFocus([], [], [r1, pairedRound("t:1")], null)).toMatchObject({ kind: "round", round: { key: "s:3" } });
  });

  it("an opened round or board is read by the ONLINE rules, never `resolveFocus` (which answers lost for a kind it does not list)", () => {
    const b = { ...r1.round!.boards[0]!, stage_id: "s", round_no: 3 };
    // The premise: `resolveFocus` alone cannot see either kind.
    expect(resolveFocus([c1], [], { kind: "round", id: "s:3", name: "x" }).kind).toBe("lost");
    expect(resolveFocus([c1], [], { kind: "board", id: b.fixtureId, name: "x" }).kind).toBe("lost");
    // Through the day's focus both are found, with the court on the page not in the way.
    expect(resolveDayFocus([c1], [], [r1], { kind: "round", id: "s:3", name: "x" })).toMatchObject({ kind: "round", round: { key: "s:3" } });
    expect(resolveDayFocus([c1], [], [r1], { kind: "board", id: b.fixtureId, name: "x" })).toMatchObject({ kind: "board", board: { fixtureId: b.fixtureId } });
  });

  it("a round or board that left the list is lost, named - never another row; a court and a match keep resolveFocus's rules", () => {
    expect(resolveDayFocus([c1], [], [r1], { kind: "round", id: "gone:1", name: "Open · Round 1" })).toEqual({ kind: "lost", name: "Open · Round 1" });
    expect(resolveDayFocus([c1], [], [r1], { kind: "board", id: "nope", name: "Board 9 · A v B" })).toEqual({ kind: "lost", name: "Board 9 · A v B" });
    expect(resolveDayFocus([c1], [], [], { kind: "board", id: "nope", name: "Board 9" }).kind).toBe("lost");
    expect(resolveDayFocus([c1], [], [r1], { kind: "court", id: "c-1", name: "Court 1" })).toMatchObject({ kind: "court" });
    expect(resolveDayFocus([c1], [], [r1], { kind: "court", id: "c-9", name: "Court 9" }).kind).toBe("lost");
    expect(resolveDayFocus([], [match("m-1")], [r1], { kind: "match", id: "m-1", name: "x" })).toMatchObject({ kind: "match" });
  });
});

describe("?court=, ?board= and ?round= are read alike: a value naming a listed row opens it, any other value is ignored", () => {
  const b1 = board();
  const old = earlier(2, { fixtureId: "old-1", boardNo: 7, white: { name: "Hoff", personId: null }, black: { name: "Fern", personId: null } });
  const r1 = round("s:3", "playing", arbiterRound([{ ...b1, white: { name: "Chen", personId: null }, black: { name: "Silva", personId: null }, boardNo: 3 }]), { needs_decision: [old] });
  const view = { courts: [court("c-1", "Court 1")], online_rounds: [r1] };
  const none = { court: null, board: null, round: null };

  it("EMPTY CASE FIRST: no param opens nothing", () => {
    expect(openedFromParams(dict, view, none)).toBeNull();
    expect(openedFromParams(dict, { courts: [], online_rounds: [] }, none)).toBeNull();
  });

  it("a board of the listed round opens by its fixture id, named 'Board N · White v Black'", () => {
    expect(openedFromParams(dict, view, { ...none, board: b1.fixtureId })).toEqual({ kind: "board", id: b1.fixtureId, name: "Board 3 · Chen v Silva" });
  });

  it("a held board of an earlier round (the 'Needs a decision' group) opens too", () => {
    expect(openedFromParams(dict, view, { ...none, board: "old-1" })).toEqual({ kind: "board", id: "old-1", name: "Board 7 · Hoff v Fern" });
  });

  it("a round opens by its key, named by its title", () => {
    expect(openedFromParams(dict, view, { ...none, round: "s:3" })).toEqual({ kind: "round", id: "s:3", name: "Online Rapid · Round 3" });
  });

  it("any other value opens nothing: an unknown board, a board the viewer plays on (never listed), an unknown round, a key in the wrong param", () => {
    const values: { board?: string; round?: string }[] = [
      { board: "ghost" },
      { board: "own-board-of-the-viewer" },
      { board: "" },
      { board: "s:3" }, // a round's key is not a board id
      { round: "ghost:9" },
      { round: "s:4" }, // a round number the stage has no row for
      { round: b1.fixtureId }, // a board id is not a round key
      { round: "" },
    ];
    let checked = 0;
    for (const v of values) {
      expect(openedFromParams(dict, view, { ...none, ...v }), JSON.stringify(v)).toBeNull();
      checked++;
    }
    expect(checked, "anti-vacuity: eight unlisted values").toBe(8);
  });

  it("a court wins when several are given, then a board, then a round; an unlisted court falls through to the next", () => {
    expect(openedFromParams(dict, view, { court: "c-1", board: b1.fixtureId, round: "s:3" })).toMatchObject({ kind: "court", id: "c-1" });
    expect(openedFromParams(dict, view, { court: "c-9", board: b1.fixtureId, round: "s:3" })).toMatchObject({ kind: "board" });
    expect(openedFromParams(dict, view, { court: null, board: "ghost", round: "s:3" })).toMatchObject({ kind: "round" });
    expect(openedFromParams(dict, view, { court: "c-9", board: "ghost", round: "ghost:1" })).toBeNull();
  });
});
