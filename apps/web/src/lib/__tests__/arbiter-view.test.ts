// T15 — the arbiter panel's reading of a flag's evidence note. The notes are
// written by two producers this file does NOT test: reconcile's out-of-band
// evidence (usecases/external-play/reconcile.ts) and the sweep's job 5 camera
// report (usecases/external-play/sweep/camera-evidence.ts). The note texts below are copied
// from what those producers' own suites assert (external-play-reconcile.test.ts
// I5, external-play-sweep.test.ts job 5); the real producer → this parser
// round trip is asserted inside those two suites.
import { describe, expect, it } from "vitest";
import {
  type ArbiterFlag,
  boardMoveNo,
  flagsForReader,
  fullMoveOf,
  parseCameraLostNote,
  parseMultipleDevicesNote,
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

// T17B fix 2, D9: the sweep's job-5 note for a player connected from more than one place at once. The texts are the
// ones external-play-sweep.test.ts (D9) asserts the producer writes; that suite also reads them back through the loader.
describe("parseMultipleDevicesNote", () => {
  const A = "2026-10-12T19:31:05.000Z";
  const B = "2026-10-12T19:36:45.000Z";
  const C = "2026-10-12T19:40:00.000Z";
  const D = "2026-10-12T19:41:00.000Z";

  it("one overlap, and two overlaps with three at once — the count, the total and every interval, in order", () => {
    const cases: [string, unknown][] = [
      [
        `2 camera connections at once for 340 s in the match: ${A} to ${B}; camera required`,
        { devices: 2, seconds: 340, intervals: [{ from: A, to: B }] },
      ],
      [
        `3 camera connections at once for 400 s in the match: ${A} to ${B}; ${C} to ${D}; camera required`,
        { devices: 3, seconds: 400, intervals: [{ from: A, to: B }, { from: C, to: D }] },
      ],
    ];
    let checked = 0;
    for (const [note, want] of cases) {
      expect(parseMultipleDevicesNote(note), note).toEqual(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("anything it cannot read is null — never a guessed count", () => {
    const bad = [
      null,
      "",
      `1 camera connections at once for 340 s in the match: ${A} to ${B}; camera required`, // one is not "at once"
      `2 camera connections at once for 340 s in the match: ; camera required`, // no interval
      `2 camera connections at once for 340 s in the match: ${B} to ${A}; camera required`, // backwards
      `2 camera connections at once for 340 s in the match: soon to ${B}; camera required`,
      `camera off 189 s of 1260 s in the match: ${A} to ${B}; from 1 camera connection over 1 session; camera required`,
    ];
    let checked = 0;
    for (const note of bad) {
      expect(parseMultipleDevicesNote(note), String(note)).toBeNull();
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

// MD-R13: a flag names a player and carries what the sweep found about them. The editors who review a board get the card whole; a reader
// without an editor's role (a view-only member, an API key) gets which kind of flag it is and when it was opened, nothing else.
describe("flagsForReader - the evidence is the organiser's", () => {
  const WHOLE: ArbiterFlag[] = [
    { id: "f1", kind: "out_of_band_play", at: "2026-10-12T19:38:00.000Z", plies: { from: 2, to: 5 } },
    {
      id: "f2",
      kind: "camera_lost",
      at: "2026-10-12T19:40:00.000Z",
      personName: "Ada Lovelace",
      report: { offSeconds: 189, windowSeconds: 1260, intervals: [{ from: "2026-10-12T19:31:05.000Z", to: "2026-10-12T19:34:14.000Z", confirmedByEvents: true }], connections: 3, sessions: 2 },
      windowFrom: "2026-10-12T19:18:00.000Z",
    },
    { id: "f3", kind: "camera_connection_problems", at: "2026-10-12T19:42:00.000Z", personName: "Alan Turing", seconds: 90, stamps: 2 },
    {
      id: "f4",
      kind: "multiple_devices",
      at: "2026-10-12T19:43:00.000Z",
      personName: "Grace Hopper",
      report: { devices: 2, seconds: 75, intervals: [{ from: "2026-10-12T19:30:00.000Z", to: "2026-10-12T19:31:15.000Z" }] },
    },
  ];
  /** The four kinds the flags table's CHECK names (V451, widened by V455 and T17B): each is a card with its own detail. */
  const KINDS = ["out_of_band_play", "camera_lost", "camera_connection_problems", "multiple_devices"] as const;

  it("an editor gets every card whole, untouched", () => {
    expect(flagsForReader(WHOLE, true)).toEqual(WHOLE);
    expect(WHOLE.map((f) => f.kind), "the cards under test cover every kind").toEqual([...KINDS]);
  });

  it("a reader without an editor's role gets kind, opening time and id for each - every other field is null, and no name or number of the evidence travels", () => {
    const out = flagsForReader(WHOLE, false);
    expect(out).toHaveLength(WHOLE.length);
    let checked = 0;
    for (const [i, flag] of out.entries()) {
      const whole = WHOLE[i]!;
      expect([flag.id, flag.kind, flag.at], whole.kind).toEqual([whole.id, whole.kind, whole.at]);
      // The same shape the card has, so a reader of the card meets a null where the editor meets evidence - never a missing key.
      expect(Object.keys(flag).sort(), `${whole.kind}: the same keys`).toEqual(Object.keys(whole).sort());
      const detail = Object.entries(flag).filter(([k]) => !["id", "kind", "at"].includes(k));
      expect(detail.length, `${whole.kind}: has detail fields to blank`).toBeGreaterThan(0);
      for (const [k, v] of detail) expect(v, `${whole.kind}.${k}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(KINDS.length);
    const wire = JSON.stringify(out);
    for (const secret of ["Ada Lovelace", "Alan Turing", "Grace Hopper", "189", "1260", "19:31:05", "19:30:00", "19:18:00"]) {
      expect(wire, `no ${secret} for a reader`).not.toContain(secret);
    }
  });

  it("the sequence and the empty case: a second strip of the same cards gives the same answer, the input keeps its evidence, and no flag is no flag for either reader", () => {
    const first = flagsForReader(WHOLE, false);
    expect(flagsForReader(WHOLE, false)).toEqual(first);
    expect(flagsForReader(WHOLE, true), "the cards were not blanked in place").toEqual(WHOLE);
    expect(flagsForReader([], false)).toEqual([]);
    expect(flagsForReader([], true)).toEqual([]);
  });
});
