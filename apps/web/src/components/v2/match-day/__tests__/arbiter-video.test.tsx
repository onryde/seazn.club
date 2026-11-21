// The video rules a watched board runs on (match-day/online/arbiter-video.tsx): which side a colour is, when a camera is worth joining,
// what each refusal of the join route means, which side is watchable, when a refused join is asked again and when "camera off since" starts.
// MOVED here from the Arbiter Panel's suite (`components/v2/__tests__/arbiter-panel.test.tsx`, deleted with the page) before that suite
// went: the pure rules outlive the panel, since Match Day's two tiles (board-cameras.tsx) and the join engine (arbiter-joins.ts) read
// them. What the tiles and the panel DRAW from these answers is board-cameras.test.tsx and board-focus.test.tsx; the join engine's
// sequence (keys, retries, leaves) is arbiter-joins.test.ts.
//
// Expected values are typed from the rules, never read back from the function. Every table reports how many cells it checked.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import { outageOffered } from "../board-decision";
import { ArbiterGuardError } from "../online/arbiter-camera";
import {
  arbiterJoinStateFromError,
  nextOffSince,
  rejoinAfterPoll,
  seatSide,
  shouldJoinVideo,
  showsOutageCard,
  sideSeat,
  sideWatchable,
  type ArbiterVideoView,
} from "../online/arbiter-video";
import { board, done, live, meeting, withState } from "./_online-fixtures";

describe("the side and the colour (the meeting is the SIDE's)", () => {
  it("seatSide and sideSeat are inverses, for both whiteSide values", () => {
    const rows = [
      { whiteSide: "home" as const, white: "home" as const, black: "away" as const },
      { whiteSide: "away" as const, white: "away" as const, black: "home" as const },
    ];
    let checked = 0;
    for (const r of rows) {
      expect(seatSide(r, "white")).toBe(r.white);
      expect(seatSide(r, "black")).toBe(r.black);
      expect(sideSeat(r, r.white)).toBe("white");
      expect(sideSeat(r, r.black)).toBe("black");
      checked += 4;
    }
    expect(checked, "anti-vacuity: 2 whiteSide values x 4 reads").toBe(8);
  });
});

describe("sideWatchable: open AND joinable, nothing else", () => {
  it("every state x joinable (6): true only for open + joinable", () => {
    let checked = 0;
    let watchable = 0;
    for (const state of ["none", "open", "ended"] as const) {
      for (const joinable of [false, true]) {
        const b = { sides: { home: meeting({ state, joinable }), away: meeting() } };
        const got = sideWatchable(b, "home");
        expect(got, `${state} / joinable ${joinable}`).toBe(state === "open" && joinable);
        checked += 1;
        if (got) watchable += 1;
      }
    }
    expect(checked, "anti-vacuity: 3 states x 2").toBe(6);
    expect(watchable, "exactly one cell is watchable").toBe(1);
  });

  it("the away side reads the away meeting, not the home one", () => {
    const b = { sides: { home: meeting({ state: "open", joinable: true }), away: meeting({ state: "open", joinable: false }) } };
    expect(sideWatchable(b, "home")).toBe(true);
    expect(sideWatchable(b, "away")).toBe(false);
  });
});

describe("shouldJoinVideo: a camera to watch", () => {
  it("joins only where the policy asks for one, nobody let the board go without, and the game is not over", () => {
    const base = live(23, { cameraPolicy: "required" });
    const rows: [Partial<ArbiterBoard>, boolean][] = [
      [{}, true],
      [{ cameraPolicy: "optional" }, true],
      [{ cameraPolicy: "off" }, false],
      [{ videoOverridden: true }, false],
      [{ state: { kind: "result", score: "1-0", noResult: false } }, false],
      [{ state: { kind: "checking_in" } }, true],
      [{ state: { kind: "on_hold" } }, true],
    ];
    let checked = 0;
    for (const [over, join] of rows) {
      expect(shouldJoinVideo({ ...base, ...over }), JSON.stringify(over)).toBe(join);
      checked++;
    }
    expect(checked, "anti-vacuity: seven rows").toBe(7);
  });
});

describe("arbiterJoinStateFromError: each refusal of the join route is its own tile state", () => {
  it("each code becomes its own state; anything else is an error", () => {
    const rows: [unknown, ArbiterVideoView["kind"]][] = [
      [new ApiV1Error("x", 503, "VIDEO_UNAVAILABLE"), "unavailable"],
      [new ApiV1Error("x", 409, "VIDEO_NOT_IN_USE"), "none"],
      [new ApiV1Error("x", 409, "VIDEO_OVERRIDDEN"), "overridden"],
      [new ApiV1Error("x", 409, "VIDEO_MEETING_ENDED"), "ended"],
      // D16: the arbiter never makes a room - a player who has not checked in has none to join.
      [new ApiV1Error("x", 409, "VIDEO_MEETING_NOT_STARTED"), "notStarted"],
      [new ApiV1Error("x", 403, "ARBITER_PLAYS_THIS_BOARD"), "own"],
      // The join's rate limit (ARBITER_JOIN_LIMIT): the generic error tile, with its retry.
      [new ApiV1Error("x", 429, "RATE_LIMITED"), "error"],
      // The board ended between the loader's read and the join.
      [new ApiV1Error("x", 409, "FIXTURE_NOT_PLAYABLE"), "over"],
      [new ArbiterGuardError(new Error("audio")), "fault"],
      [new ApiV1Error("x", 404, "NOT_FOUND"), "error"],
      // Only opened rounds are listed: unreachable but by a race, so no copy of its own.
      [new ApiV1Error("x", 409, "ROUND_NOT_OPEN"), "error"],
      [new Error("network"), "error"],
      // The check-in line has first call on the vendor's budget (503 VIDEO_BUSY): the join waits its turn, it did not fail.
      [new ApiV1Error("x", 503, "VIDEO_BUSY"), "busy"],
    ];
    let checked = 0;
    for (const [err, kind] of rows) {
      expect(arbiterJoinStateFromError(err).kind).toBe(kind);
      checked++;
    }
    expect(checked, "anti-vacuity: thirteen rows").toBe(13);
  });
});

describe("nextOffSince: 'camera off since' starts when this browser first sees a present player's camera off", () => {
  it("starts, holds, and clears when it is back or the player is gone", () => {
    const off = { present: true, live: false, track: null };
    const on = { present: true, live: true, track: null };
    const gone = { present: false, live: false, track: null };
    expect(nextOffSince(null, off, 1_000)).toBe(1_000);
    expect(nextOffSince(1_000, off, 5_000), "a second reading keeps the first instant").toBe(1_000);
    expect(nextOffSince(1_000, on, 6_000)).toBeNull();
    expect(nextOffSince(1_000, gone, 6_000), "absent is its own state, not 'off since'").toBeNull();
  });
});

describe("rejoinAfterPoll: re-open only a join refused NOT_STARTED while the side is watchable", () => {
  const VIEWS: Record<ArbiterVideoView["kind"], ArbiterVideoView> = {
    idle: { kind: "idle" },
    connecting: { kind: "connecting" },
    switching: { kind: "switching" },
    watching: { kind: "watching", tile: {} as never },
    notStarted: { kind: "notStarted" },
    none: { kind: "none" },
    overridden: { kind: "overridden" },
    over: { kind: "over" },
    ended: { kind: "ended" },
    unavailable: { kind: "unavailable" },
    busy: { kind: "busy" },
    fault: { kind: "fault" },
    own: { kind: "own" },
    error: { kind: "error" },
  };

  it("true only for notStarted + watchable; false for every other view kind, for watchable false, and for no view", () => {
    let checked = 0;
    for (const [kind, view] of Object.entries(VIEWS)) {
      expect(rejoinAfterPoll(view, true), `${kind}, watchable`).toBe(kind === "notStarted");
      expect(rejoinAfterPoll(view, false), `${kind}, not watchable`).toBe(false);
      checked += 2;
    }
    expect(rejoinAfterPoll(null, true), "no view").toBe(false);
    expect(checked, "views iterated x 2").toBe(Object.keys(VIEWS).length * 2);
    expect(Object.keys(VIEWS).length, "every ArbiterVideoView kind (14)").toBe(14);
  });
});

describe("the outage card: only during a video outage on a required, playable board not already let go", () => {
  it("the whole table: policy x let go x playable x what the join answered (60 cells, exactly one shows the card)", () => {
    const POLICIES = ["off", "optional", "required"] as const;
    const VIDEO: ArbiterVideoView[] = [
      { kind: "unavailable" },
      { kind: "connecting" },
      { kind: "watching", tile: { present: true, live: true, offSinceMs: null, track: null } },
      { kind: "fault" },
      { kind: "error" },
    ];
    let cells = 0;
    let shown = 0;
    for (const cameraPolicy of POLICIES)
      for (const videoOverridden of [false, true])
        for (const playable of [false, true])
          for (const video of VIDEO) {
            const b = { ...live(9), cameraPolicy, videoOverridden, playable };
            const expected = cameraPolicy === "required" && playable && !videoOverridden && video.kind === "unavailable";
            expect(showsOutageCard(b, video), JSON.stringify({ cameraPolicy, videoOverridden, playable, v: video.kind })).toBe(expected);
            // The one predicate both callers read: the panel's `showsOutageCard` is it, with `unavailable` derived from the join state.
            expect(outageOffered(b, video.kind === "unavailable")).toBe(expected);
            cells++;
            if (expected) shown++;
          }
    expect(cells, "anti-vacuity: 3 x 2 x 2 x 5").toBe(60);
    expect(shown, "exactly one cell of the table").toBe(1);
  });

  it("a board that is over or on hold or still checking in is judged by its own flags, not its state word", () => {
    // `playable` is the loader's own fact; the state word never decides it here. A finished board the loader calls not playable has no card.
    const cases: [ArbiterBoard, boolean][] = [
      [{ ...done("1-0"), cameraPolicy: "required", playable: false }, false],
      [{ ...withState({ kind: "on_hold" }), cameraPolicy: "required", playable: true }, true],
      [{ ...withState({ kind: "checking_in" }), cameraPolicy: "required", playable: true }, true],
      [{ ...board(), cameraPolicy: "required", playable: false }, false],
    ];
    for (const [b, expected] of cases) expect(showsOutageCard(b, { kind: "unavailable" }), JSON.stringify(b.state)).toBe(expected);
    expect(cases.length, "anti-vacuity").toBe(4);
  });
});
