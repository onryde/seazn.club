// T15 — the arbiter panel's reading of a flag's evidence note. The notes are
// written by two producers this file does NOT test: reconcile's out-of-band
// evidence (usecases/external-play/reconcile.ts) and the sweep's job 5 camera
// report (usecases/external-play/sweep.ts). The note texts below are copied
// from what those producers' own suites assert (external-play-reconcile.test.ts
// I5, external-play-sweep.test.ts job 5); the real producer → this parser
// round trip is asserted inside those two suites.
import { describe, expect, it } from "vitest";
import {
  boardMoveNo,
  fullMoveOf,
  parseCameraLostNote,
  parseOutOfBandNote,
  timelineSegments,
} from "../arbiter-view";

describe("parseOutOfBandNote", () => {
  it("reads one ply and a range of plies (1-based, as reconcile writes them)", () => {
    const cases: [string, { from: number; to: number }][] = [
      ["ply 2 (e7e5) played at Lichess, not through Seazn; camera required", { from: 2, to: 2 }],
      ["plies 2-5 (e7e5 g1f3 b8c6 f1c4) played at Lichess, not through Seazn; camera not required (policy off)", { from: 2, to: 5 }],
      ["plies 51-53 (a1a2 a7a6 a2a3) played at Lichess, not through Seazn; camera not required (policy optional)", { from: 51, to: 53 }],
    ];
    let checked = 0;
    for (const [note, want] of cases) {
      expect(parseOutOfBandNote(note), note).toEqual(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(3);
  });

  it("anything it cannot read is null — never a guessed number", () => {
    const bad = [
      null,
      "",
      "plies 5-2 (x) played at Lichess, not through Seazn; camera required", // a backwards range
      "ply 0 (e2e4) played at Lichess, not through Seazn; camera required", // plies are 1-based
      "plies 2-5 played at Lichess", // no move list
      "something else entirely",
    ];
    let checked = 0;
    for (const note of bad) {
      expect(parseOutOfBandNote(note), String(note)).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(bad.length);
  });
});

describe("fullMoveOf / boardMoveNo — the canvas counts full moves", () => {
  it("ply → the move it belongs to: White's 26th is ply 51, Black's 26th ply 52", () => {
    // FIDE numbering: move N is White's ply 2N-1 and Black's ply 2N.
    const table: [number, number][] = [
      [1, 1],
      [2, 1],
      [3, 2],
      [51, 26],
      [52, 26],
      [53, 27],
    ];
    for (const [ply, move] of table) expect(fullMoveOf(ply), `ply ${ply}`).toBe(move);
  });

  it("a ledger of N plies is being played at move floor(N/2)+1 (the canvas's 'Live · move 31' after 60)", () => {
    const table: [number, number][] = [
      [0, 1],
      [1, 1],
      [2, 2],
      [60, 31],
      [61, 31],
    ];
    for (const [plies, move] of table) expect(boardMoveNo(plies), `${plies} plies`).toBe(move);
  });
});

describe("parseCameraLostNote", () => {
  const A = "2026-10-12T19:31:05.000Z";
  const B = "2026-10-12T19:34:14.000Z";
  const C = "2026-10-12T19:36:00.000Z";
  const D = "2026-10-12T19:37:30.000Z";

  it("one interval its own events agree on, one connection, one session", () => {
    const note = `camera off 189 s of 1260 s in the match: ${A} to ${B} (its own off/on events agree); from 1 camera connection over 1 session; camera required`;
    expect(parseCameraLostNote(note)).toEqual({
      offSeconds: 189,
      windowSeconds: 1260,
      intervals: [{ from: A, to: B, confirmedByEvents: true }],
      connections: 1,
      sessions: 1,
    });
  });

  it("two intervals, one unconfirmed; plural connections and sessions", () => {
    const note = `camera off 279 s of 1260 s in the match: ${A} to ${B} (its own off/on events agree); ${C} to ${D}; from 2 camera connections over 3 sessions; camera required`;
    expect(parseCameraLostNote(note)).toEqual({
      offSeconds: 279,
      windowSeconds: 1260,
      intervals: [
        { from: A, to: B, confirmedByEvents: true },
        { from: C, to: D, confirmedByEvents: false },
      ],
      connections: 2,
      sessions: 3,
    });
  });

  it("anything it cannot read is null", () => {
    const bad = [
      null,
      "",
      `camera off 189 s of 1260 s in the match: ; from 1 camera connection over 1 session; camera required`, // no interval
      `camera off 189 s of 1260 s in the match: not-a-time to ${B}; from 1 camera connection over 1 session; camera required`,
      `camera off 189 s of 1260 s in the match: ${B} to ${A}; from 1 camera connection over 1 session; camera required`, // backwards
      `camera off 1300 s of 1260 s in the match: ${A} to ${B}; from 1 camera connection over 1 session; camera required`, // more off than the window
      "30 s stamped as our side's camera connection problems, 2 stamps in the match: x to y; camera required",
    ];
    let checked = 0;
    for (const note of bad) {
      expect(parseCameraLostNote(note), String(note)).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(bad.length);
  });
});

describe("timelineSegments — where the off time sits in the match", () => {
  it("places each interval as a percentage of the window, clamped inside it", () => {
    const from = "2026-10-12T19:18:00.000Z";
    // 21 minutes: 19:18 → 19:39 (the canvas).
    const segs = timelineSegments({
      windowFrom: from,
      windowSeconds: 1260,
      intervals: [
        // 19:31:05 → 19:34:14: 785 s in, 189 s long.
        { from: "2026-10-12T19:31:05.000Z", to: "2026-10-12T19:34:14.000Z", confirmedByEvents: true },
        // Starts before the window: clamped to 0.
        { from: "2026-10-12T19:17:00.000Z", to: "2026-10-12T19:18:30.000Z", confirmedByEvents: false },
      ],
    });
    expect(segs.length).toBe(2);
    expect(segs[0]!.leftPct).toBeCloseTo((785 / 1260) * 100, 5);
    expect(segs[0]!.widthPct).toBeCloseTo((189 / 1260) * 100, 5);
    expect(segs[1]!.leftPct).toBe(0);
    expect(segs[1]!.widthPct).toBeCloseTo((30 / 1260) * 100, 5);
  });

  it("no window (a zero-length match or an unreadable start) draws nothing", () => {
    const iv = [{ from: "2026-10-12T19:31:05.000Z", to: "2026-10-12T19:34:14.000Z", confirmedByEvents: true }];
    expect(timelineSegments({ windowFrom: null, windowSeconds: 1260, intervals: iv })).toEqual([]);
    expect(timelineSegments({ windowFrom: "2026-10-12T19:18:00.000Z", windowSeconds: 0, intervals: iv })).toEqual([]);
  });
});
