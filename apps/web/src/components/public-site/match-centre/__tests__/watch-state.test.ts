// T16 — the watch island's state: what the spectator's board shows as polls
// and pushes arrive, in whatever order the network delivers them.
//
// Two sources, one board. A PUSH is the server's own order (each accepted
// move, then reconcile's corrections) and always lands. A POLL can be stale —
// the route keeps a short public edge window, and a request sent before a
// move can answer after its push — so a poll never takes the board BACK: an
// older ply, a game no longer over at the same ply, or no board at all is
// refused. Status (finished, held), the fixture's facts (decided, its result)
// and the move list come only from polls: a push knows the board, not the
// bridge nor the fixture.
//
// Fix round 1, I1: the FIXTURE decides first — a decided fixture is finished
// for the spectators whatever its bridge reads (never "held"), and is never
// polled again.
//
// The sequence property below drives a server timeline through every order
// a push/poll interleaving can take (pushes lost, polls stale), and checks
// the board never regresses and always ends on the server's last word.
import { Chess } from "chess.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PublicBoardPush, PublicExternalPlay, PublicWatch, PublicWatchDoc } from "@/server/external-play/public-view";
import { START_FEN, holdOf, initialWatch, movesBehind, nextWatch, pollsAgain, startBoard, watchView, type WatchModel } from "../watch-state";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AT = "2026-10-13T10:00:00.000Z";
const board = (ply: number, o: Partial<PublicWatch> = {}): PublicWatch => ({
  fen: `${START}#${ply}`,
  lastMove: ply === 0 ? null : "e2e4",
  turn: ply % 2 === 0 ? "white" : "black",
  ply,
  whiteMs: 600_000 - ply,
  blackMs: 600_000 - ply,
  asOf: AT,
  clockRunning: ply >= 2,
  over: false,
  whiteSide: "home",
  moves: Array.from({ length: ply }, (_, i) => (i % 2 === 0 ? "e4" : "e5")),
  ...o,
});
const OPENED_AT = "2026-10-13T09:58:00.000Z";
const doc = (play: PublicExternalPlay | null, roundOpened = true): PublicWatchDoc => ({
  roundOpened,
  roundOpenedAt: roundOpened ? OPENED_AT : null,
  externalPlay: play,
});
const ep = (status: PublicExternalPlay["status"], watch: PublicWatch | null, o: Partial<PublicExternalPlay> = {}): PublicExternalPlay => ({
  status,
  watch,
  decided: false,
  hold: null,
  result: null,
  ...o,
});
const live = (w: PublicWatch): PublicExternalPlay => ep("live", w);
const push = (ply: number, o: Partial<PublicBoardPush> = {}): PublicBoardPush => ({
  fen: `${START}#${ply}`,
  lastMove: ply === 0 ? null : "e2e4",
  turn: ply % 2 === 0 ? "white" : "black",
  ply,
  whiteMs: 1_000,
  blackMs: 2_000,
  over: false,
  ...o,
});
const poll = (m: WatchModel, d: PublicWatchDoc) => nextWatch(m, { kind: "poll", doc: d });
const pushed = (m: WatchModel, p: PublicBoardPush, at = AT) => nextWatch(m, { kind: "push", push: p, at });

describe("watchView — what the panel says", () => {
  it("the empty case first: no bridge row, round not opened ⇒ not opened; opened ⇒ not started", () => {
    expect(watchView(initialWatch(doc(null, false)))).toBe("not_opened");
    expect(watchView(initialWatch(doc(null, true)))).toBe("not_started");
  });

  it("every bridge status, with and without a board, held or not, under an open or a DECIDED fixture", () => {
    const cells: [string, PublicExternalPlay, string, string | null][] = [
      ["pending, no game", ep("pending", null), "not_started", null],
      ["ready, no move yet", ep("ready", board(0)), "not_started", null],
      ["live, no board", ep("live", null), "not_started", null],
      ["live", ep("live", board(3)), "live", null],
      ["finished", ep("finished", board(9, { over: true })), "finished", null],
      ["held to confirm, no game", ep("needs_organiser", null, { hold: "confirm" }), "held", "confirm"],
      ["held: a knockout draw", ep("needs_organiser", board(4, { over: true }), { hold: "tiebreak" }), "held", "tiebreak"],
      // A revoked token is one seat's problem: the public reading is "no hold", and the board is still played.
      ["held, the game goes on (token revoked)", ep("needs_organiser", board(4), { hold: null }), "live", null],
      // I1: the fixture decides first.
      ["decided, bridge still held", ep("needs_organiser", board(4), { decided: true, hold: null }), "finished", null],
      ["decided, bridge still live", ep("live", board(4), { decided: true }), "finished", null],
      ["decided, no game", ep("pending", null, { decided: true }), "finished", null],
      // The guard, not a doc the server sends (it never sends decided WITH a hold): decided outranks any hold.
      ["decided, a hold still on file", ep("needs_organiser", board(4), { decided: true, hold: "confirm" }), "finished", null],
      // A knockout draw awaiting its winner (needs_decision): the fixture's hold outlives the bridge's close.
      ["bridge closed, the fixture awaiting its winner", ep("finished", board(9, { over: true }), { hold: "tiebreak" }), "held", "tiebreak"],
    ];
    let checked = 0;
    for (const [label, play, view, hold] of cells) {
      const m = initialWatch(doc(play));
      expect(watchView(m), label).toBe(view);
      expect(holdOf(m), `${label}: the hold named`).toBe(hold);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
  });
});

describe("nextWatch — transitions", () => {
  it("a poll lands a newer board, and a first board, whatever came before", () => {
    const m0 = initialWatch(doc(null, false));
    const m1 = poll(m0, doc(live(board(1))));
    expect(m1.play?.watch?.ply).toBe(1);
    expect(m1.roundOpened).toBe(true);
    expect(poll(m1, doc(live(board(2)))).play?.watch?.ply).toBe(2);
  });

  it("a stale poll never takes the board back: an older ply, no board at all, or 'not over' at the ply that ended", () => {
    const m = initialWatch(doc(live(board(5))));
    expect(poll(m, doc(live(board(4)))).play?.watch?.ply, "older ply").toBe(5);
    expect(poll(m, doc(null)).play?.watch?.ply, "no board").toBe(5);
    const over = initialWatch(doc(ep("finished", board(5, { over: true }))));
    expect(poll(over, doc(live(board(5)))).play?.watch?.over, "un-over").toBe(true);
    // The positive pair: the same ply, not regressing, lands (a fresher clock).
    expect(poll(m, doc(live(board(5, { whiteMs: 1 })))).play?.watch?.whiteMs).toBe(1);
  });

  it("a stale poll still tells White's side to a pushed board that lacks it", () => {
    const m = pushed(initialWatch(doc(null)), push(3));
    expect(m.play?.watch?.whiteSide).toBeNull();
    const after = poll(m, doc(live(board(2, { whiteSide: "away" }))));
    expect(after.play?.watch).toMatchObject({ ply: 3, whiteSide: "away" });
  });

  it("the round, once open, stays open — a stale poll from before the open cannot close it", () => {
    const m = poll(initialWatch(doc(null, false)), doc(null, true));
    expect(poll(m, doc(null, false)).roundOpened).toBe(true);
  });

  it("a push always lands (the server's order), takes its clocks as of its arrival, and keeps White's side and the list", () => {
    const m = initialWatch(doc(live(board(6, { whiteSide: "away" }))));
    const p = pushed(m, push(7), "2026-10-13T10:00:05.000Z");
    expect(p.play).toEqual({
      status: "live",
      watch: {
        fen: `${START}#7`, lastMove: "e2e4", turn: "black", ply: 7, whiteMs: 1_000, blackMs: 2_000,
        asOf: "2026-10-13T10:00:05.000Z", clockRunning: true, over: false, whiteSide: "away",
        moves: ["e4", "e5", "e4", "e5", "e4", "e5"],
      },
      decided: false,
      hold: null,
      result: null,
    });
    // The list is behind the pushed board: the panel asks for a poll; the poll brings it level.
    expect(movesBehind(p)).toBe(true);
    expect(movesBehind(poll(p, doc(live(board(7, { whiteSide: "away" })))))).toBe(false);
    expect(movesBehind(m), "a polled board is level with its list").toBe(false);
    // Reconcile's correction is a push too: an older ply lands.
    expect(pushed(p, push(6)).play?.watch?.ply).toBe(6);
    expect(p.roundOpened, "a game on the board means the round is open").toBe(true);
  });

  it("clocks run from ply 2 on a push, never on a game that is over", () => {
    const m = initialWatch(doc(null));
    const cells: [PublicBoardPush, boolean][] = [
      [push(1), false],
      [push(2), true],
      [push(9, { over: true }), false],
    ];
    let checked = 0;
    for (const [p, running] of cells) {
      expect(pushed(m, p).play?.watch?.clockRunning, `ply ${p.ply} over ${p.over}`).toBe(running);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("status comes from polls: a push never closes or holds the board, nor reopens one a poll closed", () => {
    expect(pushed(initialWatch(doc(null)), push(9, { over: true })).play?.status, "over by push: still live until a poll").toBe("live");
    const held = initialWatch(doc(ep("needs_organiser", board(4), { hold: "tiebreak" })));
    expect(pushed(held, push(5)).play).toMatchObject({ status: "needs_organiser", hold: "tiebreak" });
    const done = initialWatch(doc(ep("finished", board(9, { over: true }))));
    expect(pushed(done, push(9, { over: true })).play?.status).toBe("finished");
    // A push onto a decided fixture's board never restarts its clocks.
    const decided = initialWatch(doc(ep("live", board(4), { decided: true })));
    expect(pushed(decided, push(5)).play?.watch).toMatchObject({ over: true, clockRunning: false });
    expect(pushed(decided, push(5)).play?.decided).toBe(true);
  });

  it("I1: a decided fixture's board is over with its clocks stopped — first paint, a fresh poll, a push — whatever the board on hand says", () => {
    const runningBoard = board(6, { over: false, clockRunning: true });
    const d = doc(ep("needs_organiser", runningBoard, { decided: true }));
    let checked = 0;
    for (const [label, m] of [
      ["first paint", initialWatch(d)],
      ["a fresh poll", poll(initialWatch(doc(live(board(4)))), d)],
      ["a push after it", pushed(initialWatch(d), push(7))],
    ] as const) {
      expect(m.play?.watch, label).toMatchObject({ over: true, clockRunning: false });
      checked += 1;
    }
    expect(checked).toBe(3);
    // The positive pair: the same board under an open fixture keeps its running clock.
    expect(initialWatch(doc(live(runningBoard))).play?.watch).toMatchObject({ over: false, clockRunning: true });
  });

  it("I1: a STALE poll still brings the fixture's decision and result — the board kept, its clocks stopped", () => {
    const m = initialWatch(doc(live(board(6))));
    const result = { kind: "win" as const, winner: "home" as const, method: "resign", score: "1–0", recordedAt: AT };
    const after = poll(m, doc(ep("needs_organiser", board(5), { decided: true, result })));
    expect(after.play?.watch?.ply, "the board is not taken back").toBe(6);
    expect(after.play).toMatchObject({ decided: true, result, hold: null });
    expect(after.play?.watch).toMatchObject({ over: true, clockRunning: false });
    expect([watchView(after), pollsAgain(after)]).toEqual(["finished", false]);
  });

  it("polling stops once a poll says the game is over for us — the bridge finished, or the fixture DECIDED (I1) — never on a push's 'over'", () => {
    const cells: [string, WatchModel, boolean][] = [
      ["nothing yet", initialWatch(doc(null)), true],
      ["a push says over", pushed(initialWatch(doc(null)), push(9, { over: true })), true],
      ["bridge finished", initialWatch(doc(ep("finished", board(9, { over: true })))), false],
      ["held under an OPEN fixture (its result is still to come)", initialWatch(doc(ep("needs_organiser", board(9, { over: true }), { hold: "tiebreak" }))), true],
      ["held under a DECIDED fixture", initialWatch(doc(ep("needs_organiser", board(9), { decided: true }))), false],
      ["decided, no game", initialWatch(doc(ep("pending", null, { decided: true }))), false],
      ["bridge closed, the fixture awaiting its winner", initialWatch(doc(ep("finished", board(9, { over: true }), { hold: "tiebreak" }))), true],
    ];
    let checked = 0;
    for (const [label, m, polls] of cells) {
      expect(pollsAgain(m), label).toBe(polls);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
  });
});

// ── the sequence property ────────────────────────────────────────────────
// The server's timeline: boards at ply 0..n, the last one possibly over (and
// then the bridge finished). Each step advances the server by one move and
// delivers some mix of: that move's push (or loses it), and polls answering a
// board up to LAG plies old.
type Step = { pushLost: boolean; polls: number[] };
const LAG = 3;
const serverDoc = (ply: number, n: number, endsOver: boolean): PublicWatchDoc => {
  const over = endsOver && ply === n;
  return doc(ep(over ? "finished" : "live", board(ply, { over, clockRunning: ply >= 2 && !over }), { decided: over }));
};

function run(steps: Step[], endsOver: boolean) {
  const n = steps.length;
  let m = initialWatch(doc(null, true));
  let pushedMax = -1;
  let shown = -1;
  const c = { staleRefused: 0, pushLanded: 0, overKept: 0 };
  steps.forEach((step, i) => {
    const ply = i + 1;
    const over = endsOver && ply === n;
    if (!step.pushLost) {
      m = pushed(m, push(ply, { over }));
      pushedMax = ply;
      c.pushLanded += 1;
    }
    for (const lag of step.polls) {
      const at = Math.max(0, ply - lag);
      const before = m.play?.watch?.ply ?? -1;
      m = poll(m, serverDoc(at, n, endsOver));
      if (at < before) c.staleRefused += 1;
      if (m.play?.watch?.over) c.overKept += 1;
    }
    const now = m.play?.watch?.ply ?? -1;
    // P1: never below the newest push. P2: never back from what was shown.
    expect(now, `step ${i}: below the last push`).toBeGreaterThanOrEqual(pushedMax);
    expect(now, `step ${i}: went back`).toBeGreaterThanOrEqual(shown);
    shown = now;
  });
  // P3: a fresh poll at the end lands the server's last word.
  m = poll(m, serverDoc(n, n, endsOver));
  expect(m.play?.watch?.ply).toBe(n);
  expect(m.play?.watch?.over).toBe(endsOver);
  expect(m.play?.status).toBe(endsOver ? "finished" : "live");
  expect(pollsAgain(m)).toBe(!endsOver);
  return c;
}

const stepArb = fc.record({
  pushLost: fc.boolean(),
  polls: fc.array(fc.oneof({ arbitrary: fc.constantFrom(0, LAG), weight: 2 }, { arbitrary: fc.integer({ min: 0, max: LAG }), weight: 1 }), { maxLength: 3 }),
});

describe("nextWatch — any interleaving of pushes and stale polls", () => {
  // Each prefix ends with the path it exists for, and runs a fixed number of times.
  const PREFIXES: [string, Step[]][] = [
    ["a stale poll after its push", [{ pushLost: false, polls: [] }, { pushLost: false, polls: [LAG] }]],
    ["every push lost", [{ pushLost: true, polls: [0] }, { pushLost: true, polls: [0, 1] }]],
    ["a push between two polls", [{ pushLost: true, polls: [0] }, { pushLost: false, polls: [2, 0] }]],
  ];
  for (const endsOver of [false, true]) {
    for (const [name, prefix] of PREFIXES) {
      it(`${name}, game ${endsOver ? "ends over" : "still on"}: never regresses, always ends on the server's last word`, () => {
        const totals = { runs: 0, staleRefused: 0, pushLanded: 0, overKept: 0 };
        fc.assert(
          fc.property(fc.array(stepArb, { minLength: 0, maxLength: 12 }), (tail) => {
            const c = run([...prefix, ...tail], endsOver);
            totals.runs += 1;
            totals.staleRefused += c.staleRefused;
            totals.pushLanded += c.pushLanded;
            totals.overKept += c.overKept;
          }),
          { numRuns: 60 },
        );
        expect(totals.runs, "anti-vacuity: runs").toBeGreaterThanOrEqual(60);
        expect(totals.staleRefused, "a stale poll was offered and refused").toBeGreaterThan(0);
        if (name !== "every push lost") expect(totals.pushLanded, "pushes landed").toBeGreaterThan(0);
        if (endsOver) expect(totals.overKept, "the game's end was shown").toBeGreaterThan(0);
      });
    }
  }
});

// Owner ruling 2026-10-13 (option B): from the round's open the spectators see the real board — the start position,
// both clocks at the initial time, each player on their side — instead of a "not started" card.
describe("startBoard — the board before the first move", () => {
  it("the start position is the rules' own (chess.js), not a string typed twice", () => {
    expect(START_FEN).toBe(new Chess().fen());
  });

  it("the empty case first: no game on file, no colours read, no time control — the start position, clocks unknown", () => {
    expect(startBoard(null, null, null)).toEqual({
      fen: new Chess().fen(), lastMove: null, turn: "white", ply: 0, whiteMs: null, blackMs: null, asOf: null,
      clockRunning: false, over: false, whiteSide: null, moves: [],
    });
  });

  it("before a game exists: the pairing's colours and BOTH clocks at the division's initial time, stopped", () => {
    // 15 minutes, as the time control states it — the rulebook's number, not one the panel computed.
    const b = startBoard(null, "away", 15 * 60 * 1000);
    expect(b).toMatchObject({ whiteSide: "away", whiteMs: 900_000, blackMs: 900_000, clockRunning: false, over: false, turn: "white", ply: 0 });
  });

  it("a game on file at ply 0 lends its own colours and any clock it has read — the game's word over the pairing's", () => {
    const g = board(0, { whiteSide: "home", whiteMs: 599_000, blackMs: 598_000 });
    expect(startBoard(g, "away", 900_000)).toMatchObject({ whiteSide: "home", whiteMs: 599_000, blackMs: 598_000, ply: 0 });
    // A game created but not yet clocked (create-game resets the ledger's clocks to null) keeps the initial time.
    const unclocked = board(0, { whiteSide: "home", whiteMs: null, blackMs: null });
    expect(startBoard(unclocked, "away", 900_000)).toMatchObject({ whiteSide: "home", whiteMs: 900_000, blackMs: 900_000 });
  });
});
