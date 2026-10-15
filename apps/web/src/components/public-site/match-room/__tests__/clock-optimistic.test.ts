// T17B fix 2, D24 (owner request, stg v797): the player's own increment shows AT ONCE on their move. Today the page
// waits for Lichess, so a 1.4 s clock sits there and then jumps to 4.4. The drop adds the division's increment on the
// spot (the pure rule: clock-math `optimisticAfterDrop` / `clockFaces`; the state: the reducer's `optimistic`), and the
// server's number replaces it the moment the move is on the ledger — never added to it.
//
// The server's own rule is the oracle (play.ts, scalachess Clock.step): the clock is not running until both sides have
// moved (the first two plies cost and earn nothing), and the mover earns the increment only if time remained.
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import {
  clockFaces,
  OPTIMISTIC_CLOCK_MAX_MS,
  optimisticAfterDrop,
  optimisticOwnMs,
  type OptimisticClock,
} from "../clock-math";
import { initialRoomState, roomReducer, type RoomEvent, type RoomState } from "../room-state";
import type { RoomActBody } from "../room-api";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";

const SCRIPT = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5"];
const FENS: string[] = (() => {
  const c = new Chess();
  const out = [c.fen()];
  for (const u of SCRIPT) {
    c.move({ from: u.slice(0, 2), to: u.slice(2, 4) });
    out.push(c.fen());
  }
  return out;
})();
const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** The board after `ply` plies; White's clock `whiteMs`, Black's `blackMs`, true as of `asOf`. */
function game(ply: number, o: Partial<RoomGame> & { asOf?: number } = {}): RoomGame {
  const { asOf = T0, ...rest } = o;
  return {
    gameId: "g1",
    moves: SCRIPT.slice(0, ply),
    fen: FENS[ply]!,
    lastMove: ply === 0 ? null : [SCRIPT[ply - 1]!.slice(0, 2), SCRIPT[ply - 1]!.slice(2, 4)],
    turn: ply % 2 === 0 ? "white" : "black",
    whiteMs: 600_000,
    blackMs: 600_000,
    clockAsOf: ply === 0 ? null : iso(asOf),
    clockRunning: ply >= 2,
    drawOfferBy: null,
    over: false,
    ...rest,
  };
}
function snap(g: RoomGame | null, o: { at?: number; incrementSeconds?: number; you?: "white" | "black"; result?: RoomSnapshot["result"] } = {}): RoomSnapshot {
  const you = o.you ?? "white";
  return {
    fixtureId: "f1",
    serverNow: iso(o.at ?? T0),
    phase: "open",
    scheduledAt: iso(T0),
    roundOpenedAt: iso(T0),
    opensAt: iso(T0),
    deadline: iso(T0 + 20 * 60_000),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 180, incrementSeconds: o.incrementSeconds ?? 3 },
    orgSlug: "org",
    you: { colour: you, name: "Bo Lind", checkedIn: true },
    opponent: { colour: you === "white" ? "black" : "white", name: "Ada Okonkwo", checkedIn: true },
    cameraPolicy: "off",
    opponentPresence: null,
    ownParticipantId: null,
    frozen: null,
    canAct: true,
    otherAccount: null,
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: g,
    held: false,
    result: o.result ?? null,
    watchUrl: null,
    realtime: null,
  };
}
const MOVE: RoomActBody = { kind: "move", uci: "f1c4" };
/** The room at ply 4, White (the player) to move with `whiteMs` on the clock as of T0. */
const roomWith = (whiteMs: number, inc = 3, you: "white" | "black" = "white", ply = 4) => {
  const g = game(ply, { whiteMs, blackMs: 120_000 });
  return initialRoomState(snap(g, { incrementSeconds: inc, you }), T0);
};
const drop = (s: RoomState, at: number, action: RoomActBody = MOVE) => roomReducer(s, { type: "act_sent", action, at });
const faces = (s: RoomState, nowMs: number | null) =>
  clockFaces({ game: s.snap.game!, you: s.snap.you.colour, optimistic: s.optimistic, resultWritten: s.snap.result !== null, nowMs });

describe("D24 — the increment at the drop", () => {
  it("1.4 s + 3 shows 4.4 AT ONCE, and stays 4.4 while the move is in flight (the clock does not keep running down)", () => {
    const s = drop(roomWith(1_400, 3), T0);
    expect(s.optimistic).toEqual({ gameId: "g1", ply: 5, ms: 4_400, at: T0 });
    expect(faces(s, T0).white, "at the drop").toBe(4_400);
    expect(faces(s, T0 + 600).white, "600 ms later, still waiting for Lichess").toBe(4_400);
    // The opponent's clock is not started by our guess: it starts when Lichess says the move is made.
    expect(faces(s, T0 + 600).black).toBe(120_000);
  });

  it("the clock ran down to the drop first: the increment is added to what was LEFT at that instant, not to the clock as last told", () => {
    const s = drop(roomWith(1_400, 3), T0 + 700); // 0.7 s of thinking before the drop
    expect(s.optimistic?.ms, "1.4 − 0.7 + 3").toBe(3_700);
    expect(faces(s, T0 + 900).white).toBe(3_700);
  });

  it("the drop is stamped on the SERVER's clock (the viewer's skew applies), not the viewer's own", () => {
    // The viewer's wall clock reads 2 s behind the server's: a drop at viewer time T0 is server time T0 + 2 s.
    const base = roomWith(10_000, 3);
    const skewed = { ...base, skewMs: 2_000 };
    const s = drop(skewed, T0);
    expect(s.optimistic?.at).toBe(T0 + 2_000);
    expect(s.optimistic?.ms, "10 s − 2 s + 3 s").toBe(11_000);
  });

  it("with +0 NOTHING changes: no optimistic record, the clock keeps running exactly as before", () => {
    const s = drop(roomWith(10_000, 0), T0 + 200);
    expect(s.optimistic).toBeNull();
    expect(faces(s, T0 + 1_000).white, "ticking down as ever").toBe(9_000);
  });

  // The list is the product's own: every control a board can be created with (SHIP1_TIME_CONTROLS — the setup gate's
  // catalogue), not a typed set of increments. A zero increment is a control too: the server adds nothing, so no guess.
  it("for every ship-1 time control the add is exactly that control's increment, and a control with none leaves no guess (counted)", () => {
    let withInc = 0;
    let without = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const s = drop(roomWith(20_000, tc.incrementSeconds), T0);
      if (tc.incrementSeconds > 0) {
        expect(s.optimistic?.ms, tc.key).toBe(20_000 + tc.incrementSeconds * 1_000);
        expect(faces(s, T0 + 100).white, tc.key).toBe(20_000 + tc.incrementSeconds * 1_000);
        withInc += 1;
      } else {
        expect(s.optimistic, `${tc.key}: no increment, nothing to add`).toBeNull();
        expect(faces(s, T0 + 100).white, `${tc.key}: ticking down as ever`).toBe(20_000 - 100);
        without += 1;
      }
    }
    expect(withInc + without, "anti-vacuity: every control").toBe(SHIP1_TIME_CONTROLS.length);
    expect([withInc > 0, without > 0], "both kinds of control are in the list").toEqual([true, true]);
  });

  it("both colours: Black's drop adds to BLACK's clock (by viewer, never by colour)", () => {
    const g = game(3, { whiteMs: 90_000, blackMs: 2_000 }); // ply 3: Black to move, the clocks running
    const s = drop(initialRoomState(snap(g, { you: "black", incrementSeconds: 5 }), T0), T0);
    expect(s.optimistic).toEqual({ gameId: "g1", ply: 4, ms: 7_000, at: T0 });
    const f = faces(s, T0 + 50);
    expect([f.black, f.white], "Black's face carries the add; White's is untouched").toEqual([7_000, 90_000]);
  });
});

describe("D24 — the guards: no add where the server adds nothing", () => {
  const cases: [string, () => RoomState, number][] = [
    ["the first ply (the clocks have not started)", () => initialRoomState(snap(game(0), { incrementSeconds: 3 }), T0), T0],
    ["the second ply (the clocks have not started)", () => initialRoomState(snap(game(1), { you: "black", incrementSeconds: 3 }), T0), T0],
    ["a drop AFTER the clock reached zero (no time remained: the server adds nothing)", () => roomWith(1_000, 3), T0 + 1_000],
    ["a drop long after zero", () => roomWith(1_000, 3), T0 + 5_000],
    ["not the player's turn", () => roomWith(10_000, 3, "black"), T0],
    ["the game is over", () => initialRoomState(snap(game(4, { over: true, clockRunning: false, whiteMs: 10_000 }), { incrementSeconds: 3 }), T0), T0],
    ["a result is written", () => initialRoomState(snap(game(4, { whiteMs: 10_000 }), { incrementSeconds: 3, result: { outcome: "won", method: "resign", score: "1–0" } }), T0), T0],
    ["no game on file", () => initialRoomState(snap(null), T0), T0],
  ];
  it("each is no optimistic record at all (counted)", () => {
    let checked = 0;
    for (const [why, make, at] of cases) {
      expect(drop(make(), at).optimistic, why).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: guards").toBe(cases.length);
  });

  // D24 re-review M3: `atMs` is the sender's clock plus the viewer's skew; a skew that was never a number (an unreadable
  // serverNow) makes it NaN, and NaN slides through every comparison below it into a guess of NaN milliseconds.
  it("an instant that is not a finite number leaves no guess at all (NaN, ±Infinity) — and the finite pair does (counted)", () => {
    let checked = 0;
    for (const atMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(optimisticAfterDrop({ game: game(4, { whiteMs: 10_000, blackMs: 120_000 }), you: "white", incrementSeconds: 3, resultWritten: false, atMs }), `${atMs}`).toBeNull();
      expect(drop(roomWith(10_000, 3), atMs).optimistic, `${atMs} through the reducer`).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: instants").toBe(3);
    expect(drop(roomWith(10_000, 3), T0).optimistic?.ms, "the pair: a finite instant earns its guess").toBe(13_000);
  });

  it("the pair: one millisecond before zero the add still happens (the boundary)", () => {
    const s = drop(roomWith(1_000, 3), T0 + 999);
    expect(s.optimistic?.ms, "1 ms left + 3 s").toBe(3_001);
  });

  it("only a MOVE is a drop: a resign, a draw offer, an answer and an abort add nothing", () => {
    const acts: RoomActBody[] = [{ kind: "resign" }, { kind: "draw", accept: true }, { kind: "draw", accept: false }, { kind: "abort" }];
    let checked = 0;
    for (const a of acts) {
      expect(drop(roomWith(10_000, 3), T0, a).optimistic, JSON.stringify(a)).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(acts.length);
    // The pair: the same room with a move is optimistic.
    expect(drop(roomWith(10_000, 3), T0).optimistic).not.toBeNull();
  });

  it("a second act while one is pending is ignored: the first drop's record stands untouched", () => {
    const first = drop(roomWith(10_000, 3), T0);
    expect(drop(first, T0 + 500, { kind: "move", uci: "d2d3" })).toBe(first);
  });
});

describe("D24 — the server's number replaces the guess, and is never added to", () => {
  const dropped = () => drop(roomWith(1_400, 3), T0);
  /** Lichess's side of the same move: Black to move at ply 5, White's clock 4,250 (1.4 − 0.15 lag + 3). */
  const confirmed = (at: number) => game(5, { whiteMs: 4_250, blackMs: 120_000, asOf: at });

  it("a snapshot of the next ply: White's face is the server's 4.25, not 4.25 + 3 (no double add)", () => {
    const s = roomReducer(dropped(), { type: "snapshot", snap: snap(confirmed(T0 + 200), { at: T0 + 200 }), receivedAt: T0 + 200 });
    expect(optimisticOwnMs({ optimistic: s.optimistic, game: s.snap.game!, resultWritten: false, nowMs: T0 + 250 })).toBeNull();
    const f = faces(s, T0 + 250);
    expect(f.white).toBe(4_250);
    expect(f.black, "the opponent's clock runs from Lichess's instant").toBe(120_000 - 50);
  });

  it("a realtime broadcast of the next ply replaces it the same way", () => {
    const b: RoomEvent = {
      type: "broadcast",
      b: { fen: FENS[5]!, lastMove: SCRIPT[4]!, turn: "black", whiteMs: 4_250, blackMs: 120_000, status: "started", drawOfferBy: null },
      receivedAt: T0 + 200,
    };
    const s = roomReducer(dropped(), b);
    expect(faces(s, T0 + 200).white).toBe(4_250);
  });

  it("the answer 'accepted' alone changes nothing: the board is still at the old ply, so the guess stands until the ledger moves", () => {
    const s = roomReducer(dropped(), { type: "act_answered", answer: { ok: true, applied: true } });
    expect(s.pending).toBeNull();
    expect(s.optimistic).not.toBeNull();
    expect(faces(s, T0 + 300).white).toBe(4_400);
  });

  it("a snapshot of the SAME ply (a re-read that raced the move) leaves the guess in place", () => {
    const s = roomReducer(dropped(), { type: "snapshot", snap: snap(game(4, { whiteMs: 1_400 }), { at: T0 + 100 }), receivedAt: T0 + 100 });
    expect(faces(s, T0 + 300).white).toBe(4_400);
  });

  it("a guess for ONE game never applies to another", () => {
    const o = dropped().optimistic as OptimisticClock;
    const other = game(4, { gameId: "g2", whiteMs: 1_400 });
    expect(optimisticOwnMs({ optimistic: o, game: other, resultWritten: false, nowMs: T0 })).toBeNull();
  });

  it("the game ending (the move mated, or it was over): the guess stands down", () => {
    const o = dropped().optimistic as OptimisticClock;
    expect(optimisticOwnMs({ optimistic: o, game: game(4, { whiteMs: 1_400, over: true }), resultWritten: false, nowMs: T0 })).toBeNull();
    expect(optimisticOwnMs({ optimistic: o, game: game(4, { whiteMs: 1_400 }), resultWritten: true, nowMs: T0 })).toBeNull();
  });

  it("the guess never outlives OPTIMISTIC_CLOCK_MAX_MS (a move Lichess never confirms cannot pin a number): the last ms applies, the next does not", () => {
    const o = dropped().optimistic as OptimisticClock;
    const g = game(4, { whiteMs: 1_400 });
    expect(optimisticOwnMs({ optimistic: o, game: g, resultWritten: false, nowMs: T0 + OPTIMISTIC_CLOCK_MAX_MS })).toBe(4_400);
    expect(optimisticOwnMs({ optimistic: o, game: g, resultWritten: false, nowMs: T0 + OPTIMISTIC_CLOCK_MAX_MS + 1 })).toBeNull();
    expect(OPTIMISTIC_CLOCK_MAX_MS, "a bound longer than any honest round trip, short enough not to stand for a minute").toBe(10_000);
  });

  it("a static render (the clock has not ticked: now is null) shows the guess, and never expires it", () => {
    const s = dropped();
    expect(faces(s, null).white).toBe(4_400);
  });
});

describe("D24 — a refusal restores", () => {
  const dropped = () => drop(roomWith(10_000, 3), T0 + 1_000);

  it("Lichess refused it: the guess is gone and the clock is the server's again, still counting from the old ply (the lost seconds are lost)", () => {
    const sent = dropped();
    expect(sent.optimistic?.ms).toBe(9_000 + 3_000);
    const refused = roomReducer(sent, { type: "act_answered", answer: { ok: false, reconcile: true, reason: "rejected" } });
    expect(refused.optimistic).toBeNull();
    expect(faces(refused, T0 + 2_500).white, "10 − 2.5").toBe(7_500);
  });

  it("a grant refusal (relink) and every transport failure restore too (counted)", () => {
    const events: RoomEvent[] = [
      { type: "act_answered", answer: { ok: false, reconcile: false, reason: "lichess_reconsent_required" } },
      { type: "act_failed", status: 0 },
      { type: "act_failed", status: 400 },
      { type: "act_failed", status: 404 },
      { type: "act_failed", status: 409 },
      { type: "act_failed", status: 500 },
    ];
    let checked = 0;
    for (const e of events) {
      const after = roomReducer(dropped(), e);
      expect(after.optimistic, JSON.stringify(e)).toBeNull();
      expect(faces(after, T0 + 2_000).white, JSON.stringify(e)).toBe(8_000);
      checked += 1;
    }
    expect(checked).toBe(events.length);
  });

  it("an answer for no pending act (a late one) leaves a stored guess alone", () => {
    const idle = initialRoomState(snap(game(4)), T0);
    expect(roomReducer(idle, { type: "act_failed", status: 500 })).toBe(idle);
  });
});

describe("D24 — two quick moves", () => {
  it("move, confirmation, the opponent's instant reply, move again: each drop is its own guess; the first one never leaks into the second", () => {
    // Drop 1 at ply 4 (White): 20 s left, +3.
    let s = drop(roomWith(20_000, 3), T0);
    expect(s.optimistic).toEqual({ gameId: "g1", ply: 5, ms: 23_000, at: T0 });
    s = roomReducer(s, { type: "act_answered", answer: { ok: true, applied: true } });
    // Lichess: ply 5 is on the ledger, then Black replied at once — ply 6; White to move with 22.8 s as of T0 + 400.
    s = roomReducer(s, { type: "snapshot", snap: snap(game(6, { whiteMs: 22_800, blackMs: 119_000, asOf: T0 + 400 }), { at: T0 + 450 }), receivedAt: T0 + 450 });
    expect(faces(s, T0 + 450).white, "the server's number, not the first guess").toBe(22_800 - 50);
    // Drop 2 a moment later.
    s = drop(s, T0 + 1_000);
    expect(s.optimistic, "a fresh guess for ply 7").toEqual({ gameId: "g1", ply: 7, ms: 22_800 - 600 + 3_000, at: T0 + 1_000 });
    expect(faces(s, T0 + 1_100).white).toBe(22_800 - 600 + 3_000);
    // …and it too is replaced, never added to.
    s = roomReducer(s, { type: "snapshot", snap: snap(game(7, { whiteMs: 25_000, blackMs: 119_000, asOf: T0 + 1_200 }), { at: T0 + 1_250 }), receivedAt: T0 + 1_250 });
    expect(faces(s, T0 + 1_250).white).toBe(25_000);
  });

  it("move 1 confirmed and move 2 refused: the refusal restores only move 2's guess; the board's own number is untouched", () => {
    let s = drop(roomWith(20_000, 3), T0);
    s = roomReducer(s, { type: "snapshot", snap: snap(game(6, { whiteMs: 22_800, blackMs: 119_000, asOf: T0 + 400 }), { at: T0 + 450 }), receivedAt: T0 + 450 });
    s = drop(s, T0 + 1_000);
    s = roomReducer(s, { type: "act_failed", status: 500 });
    expect(s.optimistic).toBeNull();
    expect(faces(s, T0 + 2_400).white, "22.8 − 2.0").toBe(20_800);
  });
});

describe("D24 — the pending clock-at-zero report cannot fire on a guess", () => {
  it("the side to move's face is the guess (> 0) while the move is in flight, so a clock that reached zero only AFTER the drop is not a flag", () => {
    // 0.5 s left, dropped at once: the real clock would reach 0 at T0 + 500, the guess holds 3.5 s.
    const s = drop(roomWith(500, 3), T0);
    const f = faces(s, T0 + 800);
    expect(f.white).toBe(3_500);
    expect(f.white).toBeGreaterThan(0);
  });
});
