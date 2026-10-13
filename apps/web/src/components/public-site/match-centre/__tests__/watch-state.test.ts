// T16 — the watch island's state: what the spectator's board shows as polls
// and pushes arrive, in whatever order the network delivers them.
//
// Two sources, one board. A PUSH is the server's own order (each accepted
// move, then reconcile's corrections) and always lands. A POLL can be stale —
// the route keeps a short public edge window, and a request sent before a
// move can answer after its push — so a poll never takes the board BACK: an
// older ply, a game no longer over at the same ply, or no board at all is
// refused. Status (finished, held) comes only from polls: a push knows the
// board, not the bridge.
//
// The sequence property below drives a server timeline through every order
// a push/poll interleaving can take (pushes lost, polls stale), and checks
// the board never regresses and always ends on the server's last word.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PublicBoardPush, PublicExternalPlay, PublicWatch, PublicWatchDoc } from "@/server/external-play/public-view";
import { initialWatch, nextWatch, pollsAgain, watchView, type WatchModel } from "../watch-state";

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
  ...o,
});
const doc = (play: PublicExternalPlay | null, roundOpened = true): PublicWatchDoc => ({ roundOpened, externalPlay: play });
const live = (w: PublicWatch): PublicExternalPlay => ({ status: "live", watch: w });
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

  it("every bridge status, with and without a board", () => {
    const cells: [PublicExternalPlay, string][] = [
      [{ status: "pending", watch: null }, "not_started"],
      [{ status: "ready", watch: board(0) }, "not_started"],
      [{ status: "live", watch: null }, "not_started"],
      [{ status: "live", watch: board(3) }, "board"],
      [{ status: "finished", watch: board(9, { over: true }) }, "board"],
      [{ status: "needs_organiser", watch: null }, "held"],
      [{ status: "needs_organiser", watch: board(4) }, "held"],
    ];
    let checked = 0;
    for (const [play, view] of cells) {
      expect(watchView(initialWatch(doc(play))), JSON.stringify(play.status)).toBe(view);
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
    const over = initialWatch(doc({ status: "finished", watch: board(5, { over: true }) }));
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

  it("a push always lands (the server's order), takes its clocks as of its arrival, and keeps White's side", () => {
    const m = initialWatch(doc(live(board(6, { whiteSide: "away" }))));
    const p = pushed(m, push(7), "2026-10-13T10:00:05.000Z");
    expect(p.play).toEqual({
      status: "live",
      watch: {
        fen: `${START}#7`, lastMove: "e2e4", turn: "black", ply: 7, whiteMs: 1_000, blackMs: 2_000,
        asOf: "2026-10-13T10:00:05.000Z", clockRunning: true, over: false, whiteSide: "away",
      },
    });
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
    const held = initialWatch(doc({ status: "needs_organiser", watch: board(4) }));
    expect(pushed(held, push(5)).play?.status).toBe("needs_organiser");
    const done = initialWatch(doc({ status: "finished", watch: board(9, { over: true }) }));
    expect(pushed(done, push(9, { over: true })).play?.status).toBe("finished");
  });

  it("polling stops once a poll says the game is finished — not on a push's 'over'", () => {
    expect(pollsAgain(initialWatch(doc(null)))).toBe(true);
    expect(pollsAgain(pushed(initialWatch(doc(null)), push(9, { over: true })))).toBe(true);
    expect(pollsAgain(initialWatch(doc({ status: "finished", watch: board(9, { over: true }) })))).toBe(false);
    expect(pollsAgain(initialWatch(doc({ status: "needs_organiser", watch: board(9, { over: true }) })))).toBe(true);
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
  return doc({ status: over ? "finished" : "live", watch: board(ply, { over, clockRunning: ply >= 2 && !over }) });
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
