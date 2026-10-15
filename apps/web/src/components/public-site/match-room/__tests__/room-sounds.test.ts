// T17B fix 2, D19 (owner, 2026-10-14): the room's move sounds — which sound a ply makes, and when the room stays
// silent. Every expected sound here is typed from the rules of chess (what the ply IS: a capture, a castle, a check),
// never read back from the code; chess.js only plays the ply to give the position after it. Single sport,
// deliberately: online play exists only for boardgame chess (supportsOnlinePlay).
import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import {
  LOW_TIME_MS,
  LOW_TIME_REARM_MS,
  SOUND_PRIORITY,
  SOUNDS,
  afterMove,
  lowTimeStep,
  observe,
  pickSound,
  soundStep,
  type LowTimeMemory,
  type Observation,
  type Sound,
  type SoundMemory,
} from "../room-sounds";
import { initialRoomState, plyOfFen, roomReducer, type RoomState } from "../room-state";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

type Colour = "white" | "black";
const START = new Chess().fen();

/** The position after `uci` (standard castling form), played by the rules. */
function play(fen: string, uci: string): string {
  const c = new Chess(fen);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
  return c.fen();
}
const moverOf = (fen: string): Colour => (fen.split(" ")[1] === "w" ? "white" : "black");

function obs(over: Partial<Observation> & { fen: string | null }): Observation {
  return {
    gameId: "g1",
    ply: over.fen === null ? -1 : plyOfFen(over.fen),
    ended: false,
    offerBy: null,
    me: "white",
    move: null,
    sync: 0,
    ...over,
  };
}
/** Watch `a`, then see `b`: the sound `b` makes. */
function heard(a: Observation, b: Observation, drop: SoundMemory["drop"] = null): Sound | null {
  return soundStep({ last: a, drop }, b).sound;
}

// [name, fen before, uci as the board sends it, what the ply IS — from the rules]
type Row = [string, string, string, "quiet" | "capture" | "castle" | "check"];
const ROWS: Row[] = [
  ["a quiet pawn move", START, "e2e4", "quiet"],
  ["a quiet knight move", START, "g1f3", "quiet"],
  ["a capture", "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2", "e4d5", "capture"],
  ["Black captures", "rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 2", "e5d4", "capture"],
  ["en passant (the square taken onto is empty)", "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", "e5f6", "capture"],
  ["White castles short", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1", "castle"],
  ["Black castles long", "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1", "e8c8", "castle"],
  ["a rook check", "4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", "a1a8", "check"],
  ["a check BY a capture: check beats capture", "r3k3/8/8/8/8/8/8/R3K3 w Q - 0 1", "a1a8", "check"],
  ["castling WITH check: check beats castle", "5k2/8/8/8/8/8/8/4K2R w K - 0 1", "e1g1", "check"],
  ["a discovered check", "4k3/8/8/8/8/8/4B3/4R1K1 w - - 0 1", "e2d3", "check"],
  ["mate is a check", "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", "a1a8", "check"],
  ["a quiet promotion", "8/4P3/8/8/8/8/k7/4K3 w - - 0 1", "e7e8q", "quiet"],
  ["a promotion that captures", "3r4/4P3/8/8/8/8/k7/4K3 w - - 0 1", "e7d8q", "capture"],
  ["a promotion with check", "k7/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7e8q", "check"],
];

const soundOf = (kind: Row[3], mover: Colour, me: Colour): Sound =>
  kind === "quiet" ? (mover === me ? "move" : "opponentMove") : kind;

describe("which sound a ply makes (D19) — one per ply, by the rules", () => {
  it("every ply type, from both chairs, as it arrives live (counted)", () => {
    let checked = 0;
    for (const [name, before, uci, kind] of ROWS) {
      for (const me of ["white", "black"] as const) {
        const after = play(before, uci);
        expect(plyOfFen(after), `premise: ${name} is one ply`).toBe(plyOfFen(before) + 1);
        expect(heard(obs({ fen: before, me }), obs({ fen: after, me })), `${name}, seen by ${me}`).toBe(soundOf(kind, moverOf(before), me));
        checked += 1;
      }
    }
    expect(checked).toBe(ROWS.length * 2);
    // Each kind is reached by the table — a kind no row reaches is untested.
    const reached = new Set(ROWS.flatMap(([, before, , kind]) => (["white", "black"] as const).map((me) => soundOf(kind, moverOf(before), me))));
    expect([...reached].sort()).toEqual(["capture", "castle", "check", "move", "opponentMove"]);
  });

  it("the player's OWN move sounds at the drop — before any answer — and its confirmation is silent (counted)", () => {
    let checked = 0;
    for (const [name, before, uci, kind] of ROWS) {
      const me = moverOf(before);
      const idle = obs({ fen: before, me });
      const dropped = soundStep({ last: idle, drop: null }, { ...idle, move: uci });
      expect(dropped.sound, `${name}: at the drop`).toBe(soundOf(kind, me, me));
      const after = play(before, uci);
      const confirmed = soundStep(dropped.mem, obs({ fen: after, me, move: uci }));
      expect(confirmed.sound, `${name}: the server's ply is the same move, already heard`).toBeNull();
      const answered = soundStep(confirmed.mem, obs({ fen: after, me }));
      expect(answered.sound, `${name}: the act's answer`).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("the player's dropped move AND the reply arrive in one read: the reply is the one new ply, and it sounds (counted)", () => {
    // [the drop, the reply, what the reply IS — from the rules, heard by the player (White)]
    const cases: [string, string, Sound][] = [
      ["g1f3", "b8c6", "opponentMove"],
      ["d2d4", "e5d4", "capture"],
      ["f1c4", "d8h4", "opponentMove"],
    ];
    const before = play(play(START, "e2e4"), "e7e5");
    let checked = 0;
    for (const [mine, reply, want] of cases) {
      const idle = obs({ fen: before });
      const dropped = soundStep({ last: idle, drop: null }, { ...idle, move: mine });
      expect(dropped.sound, `${mine}: at the drop`).toBe("move");
      const both = play(play(before, mine), reply);
      const read = soundStep(dropped.mem, obs({ fen: both }));
      expect(read.sound, `${mine} then ${reply}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
    // Without a standing drop the same two-ply read is a jump, and silent.
    expect(heard(obs({ fen: before }), obs({ fen: play(play(before, "g1f3"), "b8c6") }))).toBeNull();
  });

  it("castling sent the way lila writes it (king onto its rook, e1h1) still sounds as a castle at the drop", () => {
    const before = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    expect(afterMove(before, "e1h1"), "the same position as e1g1").toBe(play(before, "e1g1"));
    expect(afterMove("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1", "e8a8")).toBe(play("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1", "e8c8"));
    const idle = obs({ fen: before });
    expect(soundStep({ last: idle, drop: null }, { ...idle, move: "e1h1" }).sound).toBe("castle");
  });

  it("a drop the rules refuse, or a position that cannot be read, makes no sound and never throws", () => {
    const idle = obs({ fen: START });
    expect(afterMove(START, "e2e5")).toBeNull();
    expect(afterMove("not a fen", "e2e4")).toBeNull();
    expect(soundStep({ last: idle, drop: null }, { ...idle, move: "e2e5" }).sound).toBeNull();
    // A ply between two positions that cannot be read: silence rather than a guessed sound.
    expect(heard(obs({ fen: "not a fen", ply: 3 }), obs({ fen: "still not", ply: 4 }))).toBeNull();
  });
});

describe("silence: load, replay, reconnect, a re-read (D19 — only NEW plies arriving live)", () => {
  it("the first observation is ALWAYS silent: a load mid-game, at the end, with an offer, at the start (counted)", () => {
    const loads: Observation[] = [
      obs({ fen: play(START, "e2e4") }),
      obs({ fen: "6k1/5ppp/8/8/8/8/8/R5K1 b - - 0 30", ended: true }),
      obs({ fen: START, ply: 0 }),
      obs({ fen: play(START, "e2e4"), offerBy: "black" }),
      obs({ fen: null, gameId: null }),
      obs({ fen: null, gameId: null, ended: true }),
    ];
    let checked = 0;
    for (const o of loads) {
      expect(soundStep(null, o).sound, JSON.stringify(o)).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(loads.length);
  });

  it("a jump of more than one ply (a reconnect, a dropped broadcast) replays nothing; a re-read and a step back say nothing (counted)", () => {
    const line = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"];
    const fens = [START];
    for (const m of line) fens.push(play(fens.at(-1)!, m));
    const cases: [string, Observation, Observation][] = [
      ["+2", obs({ fen: fens[0]! }), obs({ fen: fens[2]! })],
      ["+3", obs({ fen: fens[1]! }), obs({ fen: fens[4]! })],
      ["+6", obs({ fen: fens[0]! }), obs({ fen: fens[6]! })],
      ["the same ply re-read", obs({ fen: fens[3]! }), obs({ fen: fens[3]! })],
      ["a step back (a stale read)", obs({ fen: fens[4]! }), obs({ fen: fens[3]! })],
    ];
    let checked = 0;
    for (const [name, a, b] of cases) {
      expect(heard(a, b), name).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("a second call with the same observation says nothing (idempotent)", () => {
    const a = obs({ fen: START });
    const b = obs({ fen: play(START, "e2e4"), me: "black" });
    const first = soundStep({ last: a, drop: null }, b);
    expect(first.sound).toBe("opponentMove");
    expect(soundStep(first.mem, b).sound).toBeNull();
  });

  it("a NEW game appearing while the room is open sounds the start — never its moves, even 30 plies in", () => {
    const mid = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5";
    expect(heard(obs({ fen: null, gameId: null }), obs({ fen: START })), "no game, then one").toBe("start");
    expect(heard(obs({ fen: START, gameId: "g1" }), obs({ fen: mid, gameId: "g2" })), "a re-paired board's new game").toBe("start");
    expect(heard(obs({ fen: START, gameId: "g1", ended: true }), obs({ fen: START, gameId: "g2" })), "the next game after a decided one").toBe("start");
    expect(heard(obs({ fen: START, gameId: "g1" }), obs({ fen: mid, gameId: "g2", ended: true })), "a new game already over").toBe("end");
  });
});

describe("the result, a draw offer, and the order between sounds (D19)", () => {
  it("the end sounds once, when the board ENDS live — the game over, or a result with no game (counted)", () => {
    const cases: [string, Observation, Observation, Sound | null][] = [
      ["the game is over", obs({ fen: START }), obs({ fen: START, ended: true }), "end"],
      ["a result, no game (a no-show)", obs({ fen: null, gameId: null }), obs({ fen: null, gameId: null, ended: true }), "end"],
      ["still over", obs({ fen: START, ended: true }), obs({ fen: START, ended: true }), null],
    ];
    let checked = 0;
    for (const [name, a, b, want] of cases) {
      expect(heard(a, b), name).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("the mating ply that also ends the game is ONE sound — the end", () => {
    const before = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";
    expect(heard(obs({ fen: before }), obs({ fen: play(before, "a1a8"), ended: true }))).toBe("end");
  });

  it("a draw offer: the OPPONENT's sounds once; the player's own offer does not; an offer with a move is the offer", () => {
    const fen = play(START, "e2e4");
    expect(heard(obs({ fen }), obs({ fen, offerBy: "black" })), "offered to me").toBe("offer");
    expect(heard(obs({ fen, offerBy: "black" }), obs({ fen, offerBy: "black" })), "still offered").toBeNull();
    expect(heard(obs({ fen }), obs({ fen, offerBy: "white" })), "my own offer").toBeNull();
    expect(heard(obs({ fen }), obs({ fen: play(fen, "e7e5"), offerBy: "black" })), "a move with an offer").toBe("offer");
  });

  it("the priority list names every sound exactly once, and picks by it (counted)", () => {
    expect([...SOUND_PRIORITY].sort()).toEqual([...SOUNDS].sort());
    expect(new Set(SOUND_PRIORITY).size).toBe(SOUNDS.length);
    // The brief's two rules, as pairs: check beats capture, capture beats a move (either chair's).
    const pairs: [Sound, Sound][] = [
      ["check", "capture"],
      ["capture", "move"],
      ["capture", "opponentMove"],
      ["check", "castle"],
      ["end", "check"],
      ["offer", "opponentMove"],
    ];
    let checked = 0;
    for (const [winner, loser] of pairs) {
      expect(pickSound([loser, winner]), `${winner} over ${loser}`).toBe(winner);
      expect(pickSound([winner, loser])).toBe(winner);
      checked += 1;
    }
    expect(checked).toBe(pairs.length);
    expect(pickSound([]), "the empty case: no candidate, no sound").toBeNull();
  });
});

describe("through the REAL reducer: the room's own events in, sounds out", () => {
  const T0 = Date.parse("2026-10-14T18:00:00.000Z");
  function game(moves: string[], over: Partial<RoomGame> = {}): RoomGame {
    let fen = START;
    for (const m of moves) fen = play(fen, m);
    return {
      gameId: "g1",
      moves,
      fen,
      lastMove: moves.length ? [moves.at(-1)!.slice(0, 2), moves.at(-1)!.slice(2, 4)] : null,
      turn: moverOf(fen),
      whiteMs: 600_000,
      blackMs: 600_000,
      clockAsOf: new Date(T0).toISOString(),
      clockRunning: moves.length >= 2,
      drawOfferBy: null,
      over: false,
      ...over,
    };
  }
  function snap(g: RoomGame | null, at = T0): RoomSnapshot {
    return {
      fixtureId: "f1",
      serverNow: new Date(at).toISOString(),
      phase: "open",
      scheduledAt: null,
      roundOpenedAt: new Date(T0).toISOString(),
      opensAt: new Date(T0).toISOString(),
      deadline: new Date(T0 + 20 * 60_000).toISOString(),
      links: { fixture: "/fx", standings: "/st" },
      meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 600, incrementSeconds: 5 },
      orgSlug: "org",
      you: { colour: "white", name: "Bo Lind", checkedIn: true },
      opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
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
      result: null,
      watchUrl: null,
      realtime: null,
    };
  }
  const broadcast = (g: RoomGame) => ({
    fen: g.fen,
    lastMove: g.moves.at(-1) ?? null,
    turn: g.turn,
    whiteMs: g.whiteMs,
    blackMs: g.blackMs,
    status: g.over ? "mate" : "started",
    drawOfferBy: g.drawOfferBy,
  });

  it("a live sequence: load silent → opponent → own drop → its broadcast and answer silent → refused drop → re-read → end", () => {
    let state: RoomState = initialRoomState(snap(game(["e2e4", "e7e5"])), T0);
    let mem: SoundMemory | null = null;
    const heardNow: (Sound | null)[] = [];
    const see = (s: RoomState) => {
      state = s;
      const r = soundStep(mem, observe(state));
      mem = r.mem;
      heardNow.push(r.sound);
    };
    see(state); // load
    see(roomReducer(state, { type: "act_sent", at: T0, action: { kind: "move", uci: "g1f3" } })); // my drop
    see(roomReducer(state, { type: "broadcast", b: broadcast(game(["e2e4", "e7e5", "g1f3"])), receivedAt: T0 + 1_000 })); // its broadcast
    see(roomReducer(state, { type: "act_answered", answer: { ok: true } as never }));
    see(roomReducer(state, { type: "snapshot", snap: snap(game(["e2e4", "e7e5", "g1f3"]), T0 + 2_000), receivedAt: T0 + 2_000 })); // re-read
    see(roomReducer(state, { type: "broadcast", b: broadcast(game(["e2e4", "e7e5", "g1f3", "b8c6"])), receivedAt: T0 + 3_000 })); // opponent
    see(roomReducer(state, { type: "act_sent", at: T0, action: { kind: "move", uci: "f3e5" } })); // my capture, dropped
    see(roomReducer(state, { type: "act_failed", status: 409 })); // refused: the board is put back
    // The same capture then arrives from elsewhere (another tab): the refused drop no longer covers it.
    see(roomReducer(state, { type: "snapshot", snap: snap(game(["e2e4", "e7e5", "g1f3", "b8c6", "f3e5"]), T0 + 4_000), receivedAt: T0 + 4_000 }));
    see(roomReducer(state, { type: "snapshot", snap: snap(game(["e2e4", "e7e5", "g1f3", "b8c6", "f3e5"], { over: true }), T0 + 5_000), receivedAt: T0 + 5_000 }));
    expect(heardNow).toEqual([null, "move", null, null, null, "opponentMove", "capture", null, "capture", "end"]);
  });

  it("observe() reads the room's state: the game, the end, the offer, the pending move and the board's put-back key", () => {
    const s = initialRoomState(snap(game(["e2e4"], { drawOfferBy: "black" })), T0);
    const o = observe(roomReducer(s, { type: "act_sent", at: T0, action: { kind: "move", uci: "e7e5" } }));
    expect(o).toEqual({ gameId: "g1", ply: 1, fen: play(START, "e2e4"), ended: false, offerBy: "black", me: "white", move: "e7e5", sync: 0 });
    expect(observe(initialRoomState({ ...snap(null), result: { outcome: "won" } as never }, T0))).toMatchObject({ gameId: null, ply: -1, fen: null, ended: true });
    expect(observe(roomReducer(s, { type: "act_sent", at: T0, action: { kind: "resign" } })).move, "only a move is a drop").toBeNull();
  });
});

describe("low time (D19): ONE rule — once, when the player's clock crosses 10 s", () => {
  const run = (msList: number[], gameId = "g1", start: LowTimeMemory | null = null) => {
    let mem = start;
    const fires: number[] = [];
    for (const ms of msList) {
      const r = lowTimeStep(mem, gameId, ms);
      mem = r.mem;
      if (r.fire) fires.push(ms);
    }
    return { fires, mem };
  };

  it("the threshold and the re-arm are the brief's 10 s and half as much again", () => {
    expect(LOW_TIME_MS).toBe(10_000);
    expect(LOW_TIME_REARM_MS).toBe(15_000);
  });

  it("crossing fires once; the boundary is AT 10 s; staying under is silent (counted)", () => {
    const cases: [string, number[], number[]][] = [
      ["30 s down through 10 s", [30_000, 20_000, 10_001, 10_000, 9_000, 5_000, 0], [10_000]],
      ["just above, never crossing", [30_000, 10_001], []],
      ["a load already under 10 s (no crossing seen)", [9_000, 8_000, 1_000], []],
      ["an increment back to 12 s does not re-arm", [20_000, 9_000, 12_000, 9_000], [9_000]],
      ["back above 15 s re-arms", [20_000, 9_000, 15_001, 9_500], [9_000, 9_500]],
      ["exactly 15 s is not above it", [20_000, 9_000, 15_000, 9_500], [9_000]],
    ];
    let checked = 0;
    for (const [name, ms, want] of cases) {
      expect(run(ms).fires, name).toEqual(want);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("a new game starts its own count: under 10 s on arrival is silent", () => {
    const first = run([20_000, 9_000]);
    expect(first.fires).toEqual([9_000]);
    expect(run([8_000], "g2", first.mem).fires).toEqual([]);
    expect(run([20_000, 9_000], "g2", first.mem).fires).toEqual([9_000]);
  });
});
