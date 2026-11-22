// Match Day online rows: the seeds the Task 6 suites share (online-list, the shell's static and driven suites). Not a test file. The
// shapes are the wire's own (`MatchDayOnlineRound`, `MatchDayBoardRow`, `ArbiterBoard`); every value a test asserts is typed at the call
// site, never read back from here.
import type { ArbiterBoard, ArbiterBoardState, ArbiterRound, ArbiterSideMeeting } from "@/lib/arbiter-view";
import type { CheckinExtendState } from "@/lib/checkin-extend";
import type { MatchDayBoardRow, MatchDayOnlineRound, MatchDayView, OnlineRoundPhase } from "@/lib/match-day/types";

export const NOW_ISO = "2026-11-19T18:00:00.000Z";
export const NOW = Date.parse(NOW_ISO);
const MIN = 60_000;
export const iso = (ms: number) => new Date(ms).toISOString();

/** A check-in window by offsets (ms) from NOW: opened ten minutes ago, closing in `closesIn` minutes. */
export function openWindow(closesIn = 8): CheckinExtendState {
  return { canExtend: true, refusal: null, extensionsLeft: 3, opensAt: iso(NOW - 10 * MIN), deadlineAt: iso(NOW + closesIn * MIN) };
}

export const meeting = (over: Partial<ArbiterSideMeeting> = {}): ArbiterSideMeeting => ({
  state: "none",
  endedAt: null,
  evidenceAt: null,
  presence: { present: false, since: null, leftAt: null },
  camera: { state: "unknown", at: null },
  joinable: false,
  ...over,
});
/** A side whose player is in the room, camera on (`here`) or reported off (`off`). */
export const present = (camera: "live" | "off" = "live"): ArbiterSideMeeting =>
  meeting({ state: "open", presence: { present: true, since: iso(NOW - 3 * MIN), leftAt: null }, camera: { state: camera, at: iso(NOW - MIN) } });

let seq = 0;
/** A board of a round: unique fixture id and board number, `checking_in` and nobody here unless asked. */
export function board(over: Partial<ArbiterBoard> = {}): ArbiterBoard {
  seq += 1;
  return {
    fixtureId: `fx-${seq}`,
    fixtureNo: seq,
    boardNo: seq,
    white: { name: `White ${seq}`, personId: null },
    black: { name: `Black ${seq}`, personId: null },
    state: { kind: "checking_in" },
    clock: null,
    cameraPolicy: "optional",
    videoOverridden: false,
    cameraReport: null,
    sides: { home: meeting(), away: meeting() },
    canResync: false,
    playable: true,
    canSettle: false,
    whiteSide: "home",
    tiebreakOwed: false,
    noResultOffer: { kind: "void" },
    checkin: openWindow(),
    seats: { white: { here: false, invites: [] }, black: { here: false, invites: [] } },
    flags: [],
    flagCount: 0,
    ...over,
  };
}
export const withState = (state: ArbiterBoardState, over: Partial<ArbiterBoard> = {}): ArbiterBoard => board({ state, seats: null, checkin: null, ...over });
export const live = (moveNo = 23, over: Partial<ArbiterBoard> = {}) => withState({ kind: "live", moveNo }, over);
export const held = (flagCount = 0, over: Partial<ArbiterBoard> = {}) => withState({ kind: "on_hold" }, { flagCount, ...over });
export const done = (score: string | null = "1-0", over: Partial<ArbiterBoard> = {}) => withState({ kind: "result", score, noResult: false }, over);

/** A board as the list carries it when it is NOT in its round's list: with the round it belongs to. */
export const earlier = (roundNo: number, over: Partial<MatchDayBoardRow> = {}): MatchDayBoardRow => ({ ...held(1), stage_id: "stage-1", round_no: roundNo, ...over });

export function arbiterRound(boards: ArbiterBoard[], over: Partial<ArbiterRound> = {}): ArbiterRound {
  return { stageId: "stage-1", stageName: "Swiss", roundNo: 3, timeControl: "10+5", boards, ownBoards: 0, current: true, extendableBoards: 0, ...over };
}

/** One round row of the online block. `key` is `${stage_id}:${round_no}`. */
export function round(key: string, phase: OnlineRoundPhase, r: ArbiterRound | null, over: Partial<MatchDayOnlineRound> = {}): MatchDayOnlineRound {
  const [stage_id, no] = key.split(":");
  return {
    key,
    division_id: "div-chess",
    division_name: "Online Rapid",
    division_slug: "online-rapid",
    stage_id: stage_id!,
    stage_name: "Swiss",
    round_no: Number(no),
    multi_stage: false,
    phase,
    offered: true,
    tz: "Europe/London",
    view: null,
    round: r,
    needs_decision: [],
    own_boards: 0,
    ...over,
  };
}
export const checkinRound = (key: string, over: Partial<MatchDayOnlineRound> = {}) =>
  round(key, "checkin", arbiterRound([board({ seats: { white: { here: true, invites: [] }, black: { here: false, invites: [] } } }), board()]), over);
export const playingRound = (key: string, over: Partial<MatchDayOnlineRound> = {}) => round(key, "playing", arbiterRound([live(), live(9)]), over);
export const overRound = (key: string, over: Partial<MatchDayOnlineRound> = {}) => round(key, "playing", arbiterRound([done("1-0"), done("0-1")]), over);
export const pairedRound = (key: string, over: Partial<MatchDayOnlineRound> = {}) => round(key, "before", null, over);

/** A MatchDayView of an online night. */
export const onlineView = (online_rounds: MatchDayOnlineRound[], over: Partial<MatchDayView> = {}): MatchDayView => ({
  competition_id: "comp-1",
  date: "2026-11-19",
  tz: "Europe/London",
  now: NOW_ISO,
  courts: [],
  playing_no_court: [],
  needs_you: [],
  results_owed: 0,
  fixtures_today: 0,
  venues_today: [],
  online_rounds,
  online_failed: false,
  boards_unread: [],
  frozen: false,
  ...over,
});
