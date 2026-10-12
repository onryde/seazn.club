// T14 — the room's client reducer: every transition (TEST-STRATEGY rule 1 —
// a second call, an empty input, after a void), then a fast-check sequence
// property over moves, offers, resign, reconnect reads and out-of-order
// deliveries (rule 10). Boards come from chess.js (the rules), never from
// room-state.ts. Single-sport: the room exists only for chess.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Chess } from "chess.js";
import { canMove, initialRoomState, parseRoomBroadcast, plyOfFen, roomReducer, type RoomBroadcastWire, type RoomState } from "../room-state";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

// A fixed opening, played by chess.js: FENS[i] is the board after i plies.
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
const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function game(ply: number, over = false, gameId = "g1"): RoomGame {
  return {
    gameId,
    moves: SCRIPT.slice(0, ply),
    fen: FENS[ply]!,
    lastMove: ply === 0 ? null : [SCRIPT[ply - 1]!.slice(0, 2), SCRIPT[ply - 1]!.slice(2, 4)],
    turn: ply % 2 === 0 ? "white" : "black",
    whiteMs: 600_000,
    blackMs: 600_000,
    clockAsOf: ply === 0 ? null : iso(T0),
    clockRunning: ply >= 2 && !over,
    drawOfferBy: null,
    over,
  };
}

function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: iso(T0),
    phase: "open",
    scheduledAt: iso(T0),
    roundOpenedAt: iso(T0),
    opensAt: iso(T0),
    deadline: iso(T0 + 20 * 60_000),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Ada Okonkwo", checkedIn: true },
    opponent: { colour: "black", name: "Bo Lind", checkedIn: true },
    cameraPolicy: "off",
    opponentCameraLive: null,
    frozen: null,
    onlineChessOff: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    realtime: null,
    ...over,
  };
}

function bc(ply: number, over: Partial<RoomBroadcastWire> = {}): RoomBroadcastWire {
  return {
    fen: FENS[ply]!,
    lastMove: ply === 0 ? null : SCRIPT[ply - 1]!,
    turn: ply % 2 === 0 ? "white" : "black",
    whiteMs: 590_000,
    blackMs: 595_000,
    status: "started",
    drawOfferBy: null,
    ...over,
  };
}

const ply = (s: RoomState) => (s.snap.game ? new Chess(s.snap.game.fen).moveNumber() * 2 - (new Chess(s.snap.game.fen).turn() === "w" ? 2 : 1) : -1);

describe("plyOfFen agrees with chess.js's own count", () => {
  it("every board of the script", () => {
    let checked = 0;
    const c = new Chess();
    for (let i = 0; i <= SCRIPT.length; i += 1) {
      expect(plyOfFen(FENS[i]!), `ply ${i}`).toBe(i);
      if (i < SCRIPT.length) c.move({ from: SCRIPT[i]!.slice(0, 2), to: SCRIPT[i]!.slice(2, 4) });
      checked += 1;
    }
    expect(c.history().length).toBe(SCRIPT.length);
    expect(checked, "anti-vacuity: boards checked").toBe(SCRIPT.length + 1);
  });

  it("garbage is ply 0, never NaN", () => {
    expect(plyOfFen("not a fen")).toBe(0);
    expect(plyOfFen("")).toBe(0);
  });
});

describe("initialRoomState", () => {
  it("polls unless the club is not offered online chess; skew is server minus client", () => {
    const s = initialRoomState(snap(), T0 - 1500);
    expect([s.polling, s.skewMs, s.pending, s.error, s.syncKey, s.notFound]).toEqual([true, 1500, null, null, 0, false]);
    expect(initialRoomState(snap({ onlineChessOff: true }), T0).polling).toBe(false);
  });
});

describe("snapshot", () => {
  it("a fresher snapshot replaces the held one, and refreshes the skew", () => {
    const s0 = initialRoomState(snap({ game: game(1) }), T0);
    const s1 = roomReducer(s0, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 5000), game: game(2) }), receivedAt: T0 + 4000 });
    expect(ply(s1)).toBe(2);
    expect(s1.skewMs).toBe(1000);
  });

  it("a STALE answer (older server clock) is dropped whole — a GET that left before the move", () => {
    const s0 = initialRoomState(snap({ serverNow: iso(T0 + 5000), game: game(2) }), T0);
    const s1 = roomReducer(s0, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 1000), game: game(1), phase: "closed" }), receivedAt: T0 });
    expect(s1).toBe(s0);
  });

  it("a fresher snapshot BEHIND the held ply keeps the held board (a broadcast got there first)", () => {
    let s = initialRoomState(snap({ game: game(1) }), T0);
    s = roomReducer(s, { type: "broadcast", b: bc(2), receivedAt: T0 + 100 });
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 200), game: game(1), phase: "open" }), receivedAt: T0 + 200 });
    expect(ply(s)).toBe(2);
    expect(s.snap.game?.moves).toEqual(SCRIPT.slice(0, 2));
  });

  it("a game on file never disappears; a DIFFERENT game replaces it outright", () => {
    let s = initialRoomState(snap({ game: game(3) }), T0);
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 10), game: null }), receivedAt: T0 });
    expect(ply(s)).toBe(3);
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 20), game: game(0, false, "g2") }), receivedAt: T0 });
    expect([s.snap.game?.gameId, ply(s)]).toEqual(["g2", 0]);
  });

  it("a game seen over stays over, even if a later read lags", () => {
    let s = initialRoomState(snap({ game: game(4, true) }), T0);
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 10), game: game(4) }), receivedAt: T0 });
    expect([s.snap.game?.over, s.snap.game?.clockRunning]).toEqual([true, false]);
  });

  it("online chess going off stops polling, and a later read never restarts it", () => {
    let s = initialRoomState(snap(), T0);
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 10), onlineChessOff: true }), receivedAt: T0 });
    expect(s.polling).toBe(false);
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 20), onlineChessOff: false }), receivedAt: T0 });
    expect(s.polling).toBe(false);
  });
});

describe("broadcast", () => {
  it("the empty case: no game held ⇒ ignored (the next read brings the game)", () => {
    const s0 = initialRoomState(snap(), T0);
    expect(roomReducer(s0, { type: "broadcast", b: bc(1), receivedAt: T0 })).toBe(s0);
  });

  it("one ply on: the move joins the ledger; clocks and the offer come from the broadcast; the instant is the server's", () => {
    const s0 = initialRoomState(snap({ game: game(1) }), T0 - 2000); // server 2s ahead
    const s1 = roomReducer(s0, { type: "broadcast", b: bc(2, { drawOfferBy: "black" }), receivedAt: T0 + 10_000 });
    expect(s1.snap.game).toMatchObject({
      moves: SCRIPT.slice(0, 2),
      fen: FENS[2],
      lastMove: ["e7", "e5"],
      turn: "white",
      whiteMs: 590_000,
      blackMs: 595_000,
      clockAsOf: iso(T0 + 12_000),
      clockRunning: true,
      drawOfferBy: "black",
      over: false,
    });
  });

  it("the clocks start at ply 2, not before (lila)", () => {
    const s = roomReducer(initialRoomState(snap({ game: game(0) }), T0), { type: "broadcast", b: bc(1), receivedAt: T0 });
    expect(s.snap.game?.clockRunning).toBe(false);
  });

  it("a duplicate broadcast is idempotent (a second call): the ledger does not grow twice", () => {
    let s = initialRoomState(snap({ game: game(1) }), T0);
    s = roomReducer(s, { type: "broadcast", b: bc(2), receivedAt: T0 });
    s = roomReducer(s, { type: "broadcast", b: bc(2), receivedAt: T0 + 5 });
    expect(s.snap.game?.moves).toEqual(SCRIPT.slice(0, 2));
  });

  it("an older broadcast is dropped", () => {
    const s0 = initialRoomState(snap({ game: game(3) }), T0);
    expect(roomReducer(s0, { type: "broadcast", b: bc(2), receivedAt: T0 })).toBe(s0);
  });

  it("every terminal Lichess status ends the game; created/started do not", () => {
    // lichess-org/api GameStatusName: 14 names, two of them live.
    const all = ["created", "started", "aborted", "mate", "resign", "stalemate", "timeout", "draw", "outoftime", "cheat", "noStart", "unknownFinish", "insufficientMaterialClaim", "variantEnd"];
    let checked = 0;
    for (const status of all) {
      const s = roomReducer(initialRoomState(snap({ game: game(2) }), T0), { type: "broadcast", b: bc(2, { status }), receivedAt: T0 });
      const live = status === "created" || status === "started";
      expect(s.snap.game?.over, status).toBe(!live);
      expect(s.snap.game?.clockRunning, status).toBe(live);
      checked += 1;
    }
    expect(checked, "anti-vacuity: statuses").toBe(14);
  });
});

describe("seat round trip", () => {
  it("one seat request in flight; a second send is a no-op; the answer clears it and keeps the seat", () => {
    let s = initialRoomState(snap(), T0);
    s = roomReducer(s, { type: "seat_sent" });
    const again = roomReducer(s, { type: "seat_sent" });
    expect(again).toBe(s);
    s = roomReducer(s, {
      type: "seat_answered",
      answer: { snapshot: snap({ serverNow: iso(T0 + 10) }), seat: { seated: false, reason: "camera_required", participant: null } },
      receivedAt: T0,
    });
    expect([s.pending, s.seat?.seated, s.error]).toEqual([null, false, null]);
  });

  it("a Lichess grant refusal reads as relink, for both grant reasons", () => {
    let checked = 0;
    for (const reason of ["lichess_link_required", "lichess_reconsent_required"] as const) {
      const s = roomReducer(roomReducer(initialRoomState(snap(), T0), { type: "seat_sent" }), {
        type: "seat_answered",
        answer: { snapshot: snap({ serverNow: iso(T0 + 1) }), seat: { seated: false, reason, participant: null } },
        receivedAt: T0,
      });
      expect(s.error, reason).toBe("relink");
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a 404 seat answer is not-found and stops polling; a dropped connection is a network error", () => {
    const sent = roomReducer(initialRoomState(snap(), T0), { type: "seat_sent" });
    const gone = roomReducer(sent, { type: "seat_failed", status: 404 });
    expect([gone.notFound, gone.polling, gone.pending]).toEqual([true, false, null]);
    const net = roomReducer(sent, { type: "seat_failed", status: 0 });
    expect([net.error, net.polling]).toEqual(["network", true]);
  });
});

describe("act round trip", () => {
  const live = () => initialRoomState(snap({ game: game(2) }), T0);

  it("one act in flight: a second act while pending is a no-op (a double tap sends once)", () => {
    const s = roomReducer(live(), { type: "act_sent", action: { kind: "move", uci: "g1f3" } });
    expect(roomReducer(s, { type: "act_sent", action: { kind: "resign" } })).toBe(s);
    expect(s.pending).toEqual({ kind: "act", action: { kind: "move", uci: "g1f3" } });
  });

  it("an answer with nothing pending is ignored (a late answer after a reconnect)", () => {
    const s = live();
    expect(roomReducer(s, { type: "act_answered", answer: { ok: true, applied: true } })).toBe(s);
    expect(roomReducer(s, { type: "act_failed", status: 500 })).toBe(s);
  });

  it("accepted ⇒ pending clears, board untouched (the broadcast/read moves it)", () => {
    const s = roomReducer(roomReducer(live(), { type: "act_sent", action: { kind: "move", uci: "g1f3" } }), {
      type: "act_answered",
      answer: { ok: true, applied: true },
    });
    expect([s.pending, s.error, s.syncKey, ply(s)]).toEqual([null, null, 0, 2]);
  });

  it("refused by Lichess ⇒ the board is put back (syncKey bumps); a grant refusal reads as relink", () => {
    const sent = roomReducer(live(), { type: "act_sent", action: { kind: "move", uci: "g1f3" } });
    const refused = roomReducer(sent, { type: "act_answered", answer: { ok: false, reconcile: true, reason: "rejected" } });
    expect([refused.error, refused.syncKey, refused.pending]).toEqual(["refused", 1, null]);
    const grant = roomReducer(sent, { type: "act_answered", answer: { ok: false, reconcile: false, reason: "lichess_reconsent_required" } });
    expect([grant.error, grant.syncKey]).toEqual(["relink", 1]);
  });

  it("transport failure ⇒ the board is put back; 0 is network, 404 is not-found and stops polling", () => {
    const sent = roomReducer(live(), { type: "act_sent", action: { kind: "resign" } });
    const net = roomReducer(sent, { type: "act_failed", status: 0 });
    expect([net.error, net.syncKey, net.polling]).toEqual(["network", 1, true]);
    const gone = roomReducer(sent, { type: "act_failed", status: 404 });
    expect([gone.notFound, gone.polling, gone.syncKey]).toEqual([true, false, 1]);
  });
});

describe("fetch_failed", () => {
  it("404 is not-found and stops polling; 500 changes nothing but keeps polling; 0 is network", () => {
    const s = initialRoomState(snap(), T0);
    expect(roomReducer(s, { type: "fetch_failed", status: 404 })).toMatchObject({ notFound: true, polling: false });
    expect(roomReducer(s, { type: "fetch_failed", status: 500 })).toMatchObject({ notFound: false, polling: true, error: null });
    expect(roomReducer(s, { type: "fetch_failed", status: 0 })).toMatchObject({ polling: true, error: "network" });
  });
});

describe("canMove", () => {
  it("only on your turn, in a live game, with nothing pending and your seat not frozen", () => {
    const base = initialRoomState(snap({ game: game(2) }), T0); // white to move, you are white
    const cases: [string, RoomState, boolean][] = [
      ["your turn", base, true],
      ["no game", initialRoomState(snap(), T0), false],
      ["their turn", initialRoomState(snap({ game: game(3) }), T0), false],
      ["over", initialRoomState(snap({ game: game(2, true) }), T0), false],
      ["result written", initialRoomState(snap({ game: game(2), result: { outcome: "won", method: null, score: "1–0" } }), T0), false],
      ["pending", roomReducer(base, { type: "act_sent", action: { kind: "resign" } }), false],
      ["frozen you", initialRoomState(snap({ game: game(2), frozen: "you" }), T0), false],
      ["frozen both", initialRoomState(snap({ game: game(2), frozen: "both" }), T0), false],
      ["frozen opponent", initialRoomState(snap({ game: game(2), frozen: "opponent" }), T0), true],
    ];
    for (const [name, s, want] of cases) expect(canMove(s), name).toBe(want);
    expect(cases.length, "anti-vacuity: cases").toBe(9);
  });
});

describe("sequence property (rule 10): moves, offers, resign, reconnect reads, out-of-order delivery", () => {
  // Events are drawn against a server that plays the script forward: at each
  // step the server may advance a ply, and the client receives a snapshot or
  // broadcast of ANY past server state (late, duplicated, out of order), plus
  // act/seat traffic. Invariants hold after every step.
  type Step =
    | { k: "advance" }
    | { k: "snapshot"; age: number }
    | { k: "broadcast"; age: number; offer: boolean }
    | { k: "end" }
    | { k: "act" }
    | { k: "answer"; ok: boolean }
    | { k: "fail"; status: number }
    | { k: "off" };
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.constant({ k: "advance" as const }) },
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 4 }).map((age) => ({ k: "snapshot" as const, age })) },
    { weight: 3, arbitrary: fc.record({ age: fc.integer({ min: 0, max: 4 }), offer: fc.boolean() }).map((r) => ({ k: "broadcast" as const, ...r })) },
    { weight: 1, arbitrary: fc.constant({ k: "end" as const }) },
    { weight: 2, arbitrary: fc.constant({ k: "act" as const }) },
    { weight: 2, arbitrary: fc.boolean().map((ok) => ({ k: "answer" as const, ok })) },
    { weight: 1, arbitrary: fc.constantFrom(0, 404, 500).map((status) => ({ k: "fail" as const, status })) },
    { weight: 1, arbitrary: fc.constant({ k: "off" as const }) },
  );

  it("ply never falls, over never un-ends, polling never restarts, syncKey never falls, at most one request in flight — and the latest read wins", () => {
    const seen = { steps: 0, staleDropped: 0, plyRose: 0, overSeen: 0, pollingStopped: 0, doubleSendBlocked: 0 };
    fc.assert(
      fc.property(fc.array(step, { minLength: 12, maxLength: 40 }), (steps) => {
        // The server's history: index = server tick; each entry a snapshot.
        let serverPly = 0;
        let serverOver = false;
        let off = false;
        const history: RoomSnapshot[] = [snap({ serverNow: iso(T0), game: game(0) })];
        let s = initialRoomState(history[0]!, T0);
        const tick = () => {
          history.push(
            snap({
              serverNow: iso(T0 + history.length * 1000),
              game: { ...game(serverPly, serverOver) },
              onlineChessOff: off,
            }),
          );
        };
        for (const st of steps) {
          const before = s;
          switch (st.k) {
            case "advance":
              if (!serverOver && serverPly < SCRIPT.length) serverPly += 1;
              tick();
              break;
            case "end":
              serverOver = true;
              tick();
              break;
            case "off":
              off = true;
              tick();
              break;
            case "snapshot": {
              const idx = Math.max(0, history.length - 1 - st.age);
              if (idx < history.length - 1) seen.staleDropped += 1;
              s = roomReducer(s, { type: "snapshot", snap: history[idx]!, receivedAt: T0 });
              break;
            }
            case "broadcast": {
              const idx = Math.max(0, history.length - 1 - st.age);
              const g = history[idx]!.game!;
              s = roomReducer(s, {
                type: "broadcast",
                b: { ...bc(plyOfFen(g.fen)), status: g.over ? "resign" : "started", drawOfferBy: st.offer ? "black" : null },
                receivedAt: T0,
              });
              break;
            }
            case "act": {
              const next = roomReducer(s, { type: "act_sent", action: { kind: "draw", accept: true } });
              if (before.pending !== null) {
                expect(next, "a second send while one is in flight is a no-op").toBe(before);
                seen.doubleSendBlocked += 1;
              }
              s = next;
              break;
            }
            case "answer":
              s = roomReducer(s, { type: "act_answered", answer: st.ok ? { ok: true, applied: true } : { ok: false, reconcile: true, reason: "rejected" } });
              break;
            case "fail":
              s = roomReducer(s, { type: "fetch_failed", status: st.status });
              break;
          }
          // Invariants, every step.
          expect(ply(s), "ply never falls").toBeGreaterThanOrEqual(ply(before));
          if (before.snap.game?.over) expect(s.snap.game?.over, "over never un-ends").toBe(true);
          if (!before.polling) expect(s.polling, "polling never restarts").toBe(false);
          expect(s.syncKey).toBeGreaterThanOrEqual(before.syncKey);
          expect(Date.parse(s.snap.serverNow)).toBeGreaterThanOrEqual(Date.parse(before.snap.serverNow));
          if (ply(s) > ply(before)) seen.plyRose += 1;
          if (s.snap.game?.over) seen.overSeen += 1;
          if (before.polling && !s.polling) seen.pollingStopped += 1;
          seen.steps += 1;
        }
        // Convergence: the server's last word, delivered, is what the room shows.
        const last = history[history.length - 1]!;
        s = roomReducer(s, { type: "snapshot", snap: last, receivedAt: T0 });
        expect(ply(s), "converges on the server's ply").toBe(serverPly);
        expect(s.snap.game?.over ?? false, "converges on over").toBe(serverOver);
        expect(s.polling, "polling stopped iff online chess went off or a read 404'd").toBe(s.polling && !off);
      }),
      { numRuns: 300, seed: 20261012 },
    );
    // Anti-vacuity, per path: each invariant was actually exercised.
    expect(seen.steps, "steps checked").toBeGreaterThanOrEqual(300 * 12);
    expect(seen.staleDropped, "stale reads delivered").toBeGreaterThan(100);
    expect(seen.plyRose, "plies advanced on the client").toBeGreaterThan(300);
    expect(seen.overSeen, "steps with the game over").toBeGreaterThan(100);
    expect(seen.pollingStopped, "polling stops").toBeGreaterThan(50);
    expect(seen.doubleSendBlocked, "double sends blocked").toBeGreaterThan(50);
  });
});

describe("parseRoomBroadcast (a realtime payload is untrusted)", () => {
  it("a well-formed broadcast — the server's RoomBroadcast shape — passes through unchanged", () => {
    const good = bc(2, { drawOfferBy: "white" });
    expect(parseRoomBroadcast(good)).toEqual(good);
    expect(parseRoomBroadcast({ ...bc(0), lastMove: null })).toEqual({ ...bc(0), lastMove: null });
    expect(parseRoomBroadcast({ ...bc(1), lastMove: "e7e8q" })?.lastMove).toBe("e7e8q");
  });

  it("every malformed field is refused (the empty case first)", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "room_state",
      {},
      { ...bc(1), fen: "8/8/8/8/8/8/8/8" },
      { ...bc(1), lastMove: "e2e9" },
      { ...bc(1), lastMove: 42 },
      { ...bc(1), turn: "red" },
      { ...bc(1), whiteMs: -1 },
      { ...bc(1), blackMs: Number.NaN },
      { ...bc(1), status: 3 },
      { ...bc(1), drawOfferBy: "both" },
    ];
    let checked = 0;
    for (const raw of bad) {
      expect(parseRoomBroadcast(raw), JSON.stringify(raw) ?? String(raw)).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: malformed payloads").toBe(12);
  });
});
