// T14 — the room's client reducer: every transition (TEST-STRATEGY rule 1 —
// a second call, an empty input, after a void), then a fast-check sequence
// property over moves, offers, resign, reconnect reads and out-of-order
// deliveries (rule 10). Boards come from chess.js (the rules), never from
// room-state.ts. Single-sport: the room exists only for chess.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Chess } from "chess.js";
import {
  canMove,
  initialRoomState,
  moveNotice,
  ownMeetingRetired,
  parseRoomBroadcast,
  plyOfFen,
  roomReducer,
  type RoomBroadcastWire,
  type RoomEvent,
  type RoomState,
} from "../room-state";
import type { RoomActBody } from "../room-api";
import { RoomAct, RoomActOut } from "@/server/api-v1/schemas";
import { ROUTES } from "@/server/api-v1/openapi";
import { ROOM_BEING_REPAIRED, type RoomGame, type RoomSnapshot } from "../room-snapshot";

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
    opponentPresence: null,
    ownParticipantId: null,
    frozen: null,
    canAct: true,
    otherAccount: null,
    onlineChessOff: false,
    boardClosed: false,
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
      answer: { snapshot: snap({ serverNow: iso(T0 + 10) }), seat: { seated: false, reason: "camera_required", participant: null }, create: null },
      receivedAt: T0,
    });
    expect([s.pending, s.seat?.seated, s.error]).toEqual([null, false, null]);
  });

  it("a Lichess grant refusal reads as relink, for both grant reasons", () => {
    let checked = 0;
    for (const reason of ["lichess_link_required", "lichess_reconsent_required"] as const) {
      const s = roomReducer(roomReducer(initialRoomState(snap(), T0), { type: "seat_sent" }), {
        type: "seat_answered",
        answer: { snapshot: snap({ serverNow: iso(T0 + 1) }), seat: { seated: false, reason, participant: null }, create: null },
        receivedAt: T0,
      });
      expect(s.error, reason).toBe("relink");
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("P10: Lichess's answer at page load is kept for the page — no snapshot, seat answer, act or failed fetch clears or sets it", () => {
    expect(initialRoomState(snap(), T0).grantRefused, "the empty case: not asked ⇒ not refused").toBe(false);
    const events: RoomEvent[] = [
      { type: "snapshot", snap: snap({ serverNow: iso(T0 + 1) }), receivedAt: T0 },
      { type: "seat_sent" },
      { type: "seat_answered", answer: { snapshot: snap({ serverNow: iso(T0 + 2) }), seat: { seated: true, participant: null }, create: null }, receivedAt: T0 },
      { type: "act_sent", at: T0, action: { kind: "resign" } },
      { type: "act_answered", answer: { ok: true, applied: true } },
      { type: "fetch_failed", status: 500 },
    ];
    let checked = 0;
    for (const start of [true, false]) {
      let s = initialRoomState(snap(), T0, start);
      for (const e of events) {
        s = roomReducer(s, e);
        expect(s.grantRefused, `${start} after ${e.type}`).toBe(start);
        checked += 1;
      }
    }
    expect(checked).toBe(events.length * 2);
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
    const s = roomReducer(live(), { type: "act_sent", at: T0, action: { kind: "move", uci: "g1f3" } });
    expect(roomReducer(s, { type: "act_sent", at: T0, action: { kind: "resign" } })).toBe(s);
    expect(s.pending).toEqual({ kind: "act", action: { kind: "move", uci: "g1f3" } });
  });

  it("an answer with nothing pending is ignored (a late answer after a reconnect)", () => {
    const s = live();
    expect(roomReducer(s, { type: "act_answered", answer: { ok: true, applied: true } })).toBe(s);
    expect(roomReducer(s, { type: "act_failed", status: 500 })).toBe(s);
  });

  it("accepted ⇒ pending clears, board untouched (the broadcast/read moves it)", () => {
    const s = roomReducer(roomReducer(live(), { type: "act_sent", at: T0, action: { kind: "move", uci: "g1f3" } }), {
      type: "act_answered",
      answer: { ok: true, applied: true },
    });
    expect([s.pending, s.error, s.syncKey, ply(s)]).toEqual([null, null, 0, 2]);
  });

  it("refused by Lichess ⇒ the board is put back (syncKey bumps); a grant refusal reads as relink", () => {
    const sent = roomReducer(live(), { type: "act_sent", at: T0, action: { kind: "move", uci: "g1f3" } });
    const refused = roomReducer(sent, { type: "act_answered", answer: { ok: false, reconcile: true, reason: "rejected" } });
    expect([refused.error, refused.syncKey, refused.pending]).toEqual(["refused", 1, null]);
    const grant = roomReducer(sent, { type: "act_answered", answer: { ok: false, reconcile: false, reason: "lichess_reconsent_required" } });
    expect([grant.error, grant.syncKey]).toEqual(["relink", 1]);
  });

  it("transport failure ⇒ the board is put back; 0 is network; a RULE's refusal (400/422) is invalid; play's 404 and any other status (a 409, a 5xx) is a failure, never invalid — and NONE of them stops the room", () => {
    // Review I2: play's 404 is T10 refusing a board it will not accept (a
    // hold, a finished game, a frozen seat, another account) — not the room
    // vanishing, and never a rule (T14 re-review 5, I-1). The room re-reads
    // and carries on; only GET room's own 404 is "gone".
    const sent = roomReducer(live(), { type: "act_sent", at: T0, action: { kind: "resign" } });
    let checked = 0;
    for (const [status, error] of [[0, "network"], [400, "invalid"], [404, "refused"], [409, "refused"], [500, "refused"]] as const) {
      const after = roomReducer(sent, { type: "act_failed", status });
      expect([after.error, after.syncKey, after.pending, after.polling, after.notFound], String(status)).toEqual([error, 1, null, true, false]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: statuses").toBe(5);
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

// Fix round 4b: a read inside an unpair → re-pair gap is the server's 409 ROOM_BEING_REPAIRED (who is told is pinned
// in external-play-room.test.ts). The room reads on through it; the reads that refuse the caller still stop it.
describe("fix round 4b: a board being re-paired never stops the room; a refusal still does", () => {
  const gapRead: RoomEvent = { type: "fetch_failed", status: 409, code: ROOM_BEING_REPAIRED };

  it("the empty case: a fresh room is not being re-paired", () => {
    expect(initialRoomState(snap(), T0).repairing).toBe(false);
  });

  it("a read in the gap ⇒ being re-paired, polling ON, not gone, no error; a second the same; the re-paired board's read ends it; a later 404 (the re-pair moved them off) stops", () => {
    const s1 = roomReducer(initialRoomState(snap(), T0), gapRead);
    expect([s1.repairing, s1.polling, s1.notFound, s1.error]).toEqual([true, true, false, null]);
    const s2 = roomReducer(s1, gapRead);
    expect([s2.repairing, s2.polling, s2.notFound], "a second read in the gap").toEqual([true, true, false]);
    const back = roomReducer(s2, { type: "snapshot", snap: snap({ serverNow: iso(T0 + 30_000) }), receivedAt: T0 + 30_000 });
    expect([back.repairing, back.polling], "re-paired: the room again").toEqual([false, true]);
    const moved = roomReducer(roomReducer(back, gapRead), { type: "fetch_failed", status: 404, code: "NOT_FOUND" });
    expect([moved.notFound, moved.polling], "moved off the board: the room's 404 stops it").toEqual([true, false]);
  });

  it("the reads that refuse the CALLER stop the room — 404 (not theirs, a link refused, a board gone: one answer), 401, 403 — while a transient read, and any OTHER 409, reads on and is not 'being re-paired'", () => {
    const s = initialRoomState(snap(), T0);
    const table: [number, string | null, "stop" | "read on"][] = [
      [404, "NOT_FOUND", "stop"],
      [401, "UNAUTHORIZED", "stop"],
      [403, "FORBIDDEN", "stop"],
      [0, null, "read on"],
      [500, null, "read on"],
      [503, "UPSTREAM", "read on"],
      [429, "RATE_LIMITED", "read on"],
      [409, "VIDEO_MEETING_PAIRING_CHANGED", "read on"],
      [409, null, "read on"],
      [400, ROOM_BEING_REPAIRED, "read on"], // the code is the 409's alone
    ];
    const seen = { stop: 0, "read on": 0 };
    for (const [status, code, rule] of table) {
      const n = roomReducer(s, { type: "fetch_failed", status, code });
      expect([n.polling, n.notFound, n.repairing], `${status} ${code}`).toEqual([rule === "read on", rule === "stop", false]);
      seen[rule] += 1;
    }
    expect(seen, "anti-vacuity: both rules exercised").toEqual({ stop: 3, "read on": 7 });
  });

  it("the seat call answers alike: in the gap ⇒ being re-paired, the call over, polling on; the next seat answer ends it; a 401 seat answer stops", () => {
    const sent = roomReducer(initialRoomState(snap(), T0), { type: "seat_sent" });
    const gap = roomReducer(sent, { type: "seat_failed", status: 409, code: ROOM_BEING_REPAIRED });
    expect([gap.repairing, gap.pending, gap.polling, gap.notFound]).toEqual([true, null, true, false]);
    const answered = roomReducer(roomReducer(gap, { type: "seat_sent" }), {
      type: "seat_answered",
      answer: { snapshot: snap({ serverNow: iso(T0 + 5_000) }), seat: { seated: true, participant: null }, create: null },
      receivedAt: T0 + 5_000,
    });
    expect([answered.repairing, answered.pending]).toEqual([false, null]);
    const signedOut = roomReducer(sent, { type: "seat_failed", status: 401, code: "UNAUTHORIZED" });
    expect([signedOut.polling, signedOut.notFound, signedOut.pending]).toEqual([false, true, null]);
  });
});

// Seams A/B/C (owner-approved canvas, "Room states"): the three in-room
// notices are the error kinds the room already records — C1 network, C2 a
// move that didn't go through, C3 a move a RULE refused — and each one's
// LIFETIME is a transition: what raises it, what keeps it, what ends it.
describe("move notices (C1–C3): raised, kept and ended by the room's own events", () => {
  const live = () => initialRoomState(snap({ game: game(2) }), T0); // White to move; you are White
  const move = { kind: "move", uci: "g1f3" } as const;
  const sent = (s: RoomState, action: RoomActBody = move) => roomReducer(s, { type: "act_sent", at: T0, action });
  const refusedBy = (s: RoomState) => roomReducer(s, { type: "act_answered", answer: { ok: false, reconcile: true, reason: "rejected" } });
  const read = (s: RoomState, at: number, g: RoomGame | null = game(2)) =>
    roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(at), game: g }), receivedAt: at });

  it("the empty case: a fresh room, and a room whose every act went through, show no notice", () => {
    expect(moveNotice(live())).toBeNull();
    expect(moveNotice(initialRoomState(snap(), T0)), "no game at all").toBeNull();
    const ok = roomReducer(sent(live()), { type: "act_answered", answer: { ok: true, applied: true } });
    expect(moveNotice(ok)).toBeNull();
  });

  it("C1: a read that never got an answer is offline; the next read that does ends it — and a second failure raises it again", () => {
    const off = roomReducer(live(), { type: "fetch_failed", status: 0 });
    expect(moveNotice(off)).toBe("offline");
    // A read the server ANSWERED with an error is not the player offline.
    expect(moveNotice(roomReducer(live(), { type: "fetch_failed", status: 500 }))).toBeNull();
    const back = read(off, T0 + 3000);
    expect([moveNotice(back), back.error]).toEqual([null, null]);
    // Even a stale answer is an answer: the connection is back.
    const staleBack = roomReducer(read(live(), T0 + 9000), { type: "fetch_failed", status: 0 });
    const stale = read(staleBack, T0 + 1000);
    expect([moveNotice(stale), ply(stale)]).toEqual([null, 2]);
    expect(moveNotice(roomReducer(back, { type: "fetch_failed", status: 0 })), "a second drop").toBe("offline");
    // A broadcast is not a read: the poll that failed has not come back, and
    // ending C1 on it would flicker the notice off until the next failed poll.
    expect(moveNotice(roomReducer(off, { type: "broadcast", b: bc(3), receivedAt: T0 + 100 })), "a broadcast").toBe("offline");
  });

  it("C1: a move that never reached us is offline too (the board is put back), and stays so while reads keep failing", () => {
    const lost = roomReducer(sent(live()), { type: "act_failed", status: 0 });
    expect([moveNotice(lost), lost.syncKey]).toEqual(["offline", 1]);
    const still = roomReducer(lost, { type: "fetch_failed", status: 0 });
    expect(moveNotice(still)).toBe("offline");
    expect(moveNotice(read(still, T0 + 3000))).toBeNull();
  });

  it("a read never ends a re-link (it is a screen, not a notice)", () => {
    const grant = roomReducer(sent(live()), { type: "act_answered", answer: { ok: false, reconcile: false, reason: "lichess_reconsent_required" } });
    const after = read(grant, T0 + 3000);
    expect([after.error, moveNotice(after)]).toEqual(["relink", null]);
  });

  it("C2: a move Lichess refused — the piece is put back — and the re-read of the SAME board keeps the notice", () => {
    const refused = refusedBy(sent(live()));
    expect([moveNotice(refused), refused.syncKey]).toEqual(["refused", 1]);
    // useRoom re-reads after every act: that read must not wipe the notice.
    const reread = read(refused, T0 + 500);
    expect(moveNotice(reread)).toBe("refused");
  });

  it("C3: a move a RULE refused (400 the move string, 422 semantically invalid) is invalid, and the re-read keeps it", () => {
    let checked = 0;
    for (const status of [400, 422]) {
      const bad = roomReducer(sent(live()), { type: "act_failed", status });
      expect([moveNotice(bad), bad.syncKey], String(status)).toEqual(["invalid", 1]);
      expect(moveNotice(read(bad, T0 + 500)), `${status} re-read`).toBe("invalid");
      checked += 1;
    }
    expect(checked, "anti-vacuity: statuses").toBe(2);
  });

  it("play's 404 is NEVER C3 (T14 re-review 5, I-1): every cause is the board, the seat or the account, never a rule — it is C2, and the re-read decides", () => {
    // play.ts throws its one NOT_FOUND for: no fixture, no playable game (a
    // hold, finished, withdrawn), not a seated person, a frozen seat, and a
    // linked account that is not the game's. None refuses the MOVE.
    const bad = roomReducer(sent(live()), { type: "act_failed", status: 404 });
    expect([bad.error, moveNotice(bad), bad.syncKey]).toEqual(["refused", "refused", 1]);
    expect(moveNotice(bad), "never \"isn't allowed\"").not.toBe("invalid");
    // The same board re-read (nothing changed): C2 stands — "try again".
    expect(moveNotice(read(bad, T0 + 500)), "a same-state re-read keeps C2").toBe("refused");
  });

  it("C2/C3 end when the player tries again, and when the board moves on (a read or a broadcast past the refused position)", () => {
    let checked = 0;
    for (const raise of [refusedBy, (s: RoomState) => roomReducer(s, { type: "act_failed", status: 400 })]) {
      const shown = raise(sent(live()));
      expect(moveNotice(shown)).not.toBeNull();
      expect(moveNotice(sent(shown)), "trying again").toBeNull();
      expect(moveNotice(read(shown, T0 + 3000, game(3))), "a read one ply on").toBeNull();
      expect(moveNotice(roomReducer(shown, { type: "broadcast", b: bc(3), receivedAt: T0 + 3000 })), "a broadcast one ply on").toBeNull();
      // The pair: a broadcast of the SAME ply (a clock or offer change) keeps it.
      expect(moveNotice(roomReducer(shown, { type: "broadcast", b: bc(2, { drawOfferBy: "black" }), receivedAt: T0 + 3000 })), "same ply").not.toBeNull();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a refused resign, draw or abort never fails silently: the generic C2 ('That didn't go through'), whatever refused it (notice routing ruling)", () => {
    let checked = 0;
    for (const action of [{ kind: "resign" }, { kind: "draw", accept: true }, { kind: "abort" }] as const) {
      const refused = refusedBy(sent(live(), action));
      expect([refused.error, moveNotice(refused)], `${action.kind} refused`).toEqual(["refused", "failed"]);
      const bad = roomReducer(sent(live(), action), { type: "act_failed", status: 400 });
      expect([bad.error, moveNotice(bad)], `${action.kind} 400`).toEqual(["invalid", "failed"]);
      const gone = roomReducer(sent(live(), action), { type: "act_failed", status: 404 });
      expect([gone.error, moveNotice(gone)], `${action.kind} 404`).toEqual(["refused", "failed"]);
      // Offline is offline whatever was sent.
      expect(moveNotice(roomReducer(sent(live(), action), { type: "act_failed", status: 0 })), `${action.kind} lost`).toBe("offline");
      checked += 1;
    }
    expect(checked, "anti-vacuity: non-move acts").toBe(3);
  });
});

// T14 re-review 5 (I-1 and its Minor): a move notice speaks of a board the
// player may act on. A read that says nobody may (canAct false: a hold, a
// frozen seat, another account) ends it, and so does any change of the hold
// or seat state — so a stale C2/C3 never comes back once a hold lifts at the
// SAME ply (the reviewer's probe read ["live","invalid"] after the lift).
describe("move notices end with the hold or seat state they were raised on", () => {
  const live = () => initialRoomState(snap({ game: game(2) }), T0); // White to move; you are White
  const move = { kind: "move", uci: "g1f3" } as const;
  const sent = (s: RoomState, action: RoomActBody = move) => roomReducer(s, { type: "act_sent", at: T0, action });
  const read = (s: RoomState, at: number, over: Partial<RoomSnapshot> = {}) =>
    roomReducer(s, { type: "snapshot", snap: snap({ serverNow: iso(at), game: game(2), ...over }), receivedAt: at });
  const decline = { kind: "draw", accept: false } as const;
  // [name, raise, the notice, the act it answers]. `raise` sends first; with
  // an act already in flight that send is a no-op and it answers that one.
  const raisers: [string, (s: RoomState) => RoomState, "refused" | "invalid" | "failed", RoomActBody][] = [
    ["C2: play's 404 (the race into a hold)", (s) => roomReducer(sent(s), { type: "act_failed", status: 404 }), "refused", move],
    ["C2: Lichess refused it", (s) => roomReducer(sent(s), { type: "act_answered", answer: { ok: false, reconcile: true, reason: "rejected" } }), "refused", move],
    ["C3: a rule refused it (400)", (s) => roomReducer(sent(s), { type: "act_failed", status: 400 }), "invalid", move],
    ["generic C2: a decline play refused (404)", (s) => roomReducer(sent(s, decline), { type: "act_failed", status: 404 }), "failed", decline],
  ];
  // Every way the server says the viewer may not act (room.ts's canAct).
  const holds: [string, Partial<RoomSnapshot>][] = [
    ["a hold the game plays through (provider_error)", { canAct: false }],
    ["held for the organiser", { canAct: false, held: true }],
    ["my seat frozen", { canAct: false, frozen: "you" }],
    ["both seats frozen", { canAct: false, frozen: "both" }],
  ];

  it("the notice → the read that says nobody may act → the hold lifts at the SAME ply ⇒ no notice after the read, ever", () => {
    let checked = 0;
    for (const [name, raise, kind] of raisers) {
      for (const [hold, over] of holds) {
        const shown = raise(live());
        expect(moveNotice(shown), `${name}: raised`).toBe(kind);
        const held = read(shown, T0 + 500, over);
        expect([moveNotice(held), held.error], `${name} × ${hold}: the read ends it`).toEqual([null, null]);
        const lifted = read(held, T0 + 3500);
        expect(ply(lifted), "premise: the SAME ply — no move ended it").toBe(ply(shown));
        expect(lifted.snap.canAct, "premise: the hold lifted").toBe(true);
        expect(moveNotice(lifted), `${name} × ${hold}: never back after the lift`).toBeNull();
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: notices × holds").toBe(raisers.length * holds.length);
  });

  it("the pair: a re-read of the SAME state keeps every notice — nothing changed, so \"try again\" still stands", () => {
    let checked = 0;
    for (const [name, raise, kind] of raisers) {
      expect(moveNotice(read(raise(live()), T0 + 500)), name).toBe(kind);
      checked += 1;
    }
    expect(checked).toBe(raisers.length);
  });

  it("a change of the seat state ends it even while the board stays actable: the opponent's seat frozen, then released", () => {
    let checked = 0;
    for (const [name, raise] of raisers) {
      const froze = read(raise(live()), T0 + 500, { frozen: "opponent" });
      expect([froze.snap.canAct, moveNotice(froze)], `${name}: the opponent frozen`).toEqual([true, null]);
      const onFrozen = raise(initialRoomState(snap({ game: game(2), frozen: "opponent" }), T0));
      const released = read(onFrozen, T0 + 500, { frozen: null });
      expect([released.snap.canAct, moveNotice(released)], `${name}: the opponent released`).toEqual([true, null]);
      checked += 1;
    }
    expect(checked).toBe(raisers.length);
  });

  it("the poll that reads the hold lands BEFORE the act's answer: the notice it raises ends at the next read still saying nobody may act", () => {
    // The ordering the change rule alone misses: the seat state is already
    // "held" when the notice is raised, so the next read changes nothing —
    // it is canAct false that ends it.
    let checked = 0;
    for (const [name, raise, kind, action] of raisers) {
      const racing = read(sent(live(), action), T0 + 300, { canAct: false });
      expect(racing.pending, "premise: the act is still in flight").toEqual({ kind: "act", action });
      const answer = raise(racing);
      expect(moveNotice(answer), `${name}: raised`).toBe(kind);
      const stillHeld = read(answer, T0 + 3300, { canAct: false });
      expect([stillHeld.snap.canAct, moveNotice(stillHeld)], `${name}: the next held read`).toEqual([false, null]);
      checked += 1;
    }
    expect(checked).toBe(raisers.length);
  });

  it("a notice raised while this client still read the board as held ends when a read says the hold has lifted", () => {
    const heldBoard = initialRoomState(snap({ game: game(2), canAct: false }), T0);
    let checked = 0;
    for (const [name, raise, kind] of raisers) {
      const shown = raise(heldBoard);
      expect(moveNotice(shown), `${name}: raised`).toBe(kind);
      const lifted = read(shown, T0 + 500);
      expect([lifted.snap.canAct, moveNotice(lifted)], `${name}: the lift`).toEqual([true, null]);
      checked += 1;
    }
    expect(checked).toBe(raisers.length);
  });
});

// Notice routing (controller ruling 2026-10-12): C3 "isn't allowed" is ONLY
// a move a RULE refused; a server failure or a lost request never blames the
// player (C1/C2); a refused offer, answer, resign or abort shows the generic
// C2. The rows are every action the room's declared union can send × every
// failure its declared answer union, its route's declared errors and the
// network can bring; the expected notice is the RULING's, stated here.
describe("notice routing: every failure × every action (the ruling, over the declared unions)", () => {
  const live = () => initialRoomState(snap({ game: game(2) }), T0);
  type Field = { def: { type: string; values?: unknown[] } };
  /** Every action RoomAct accepts: one per option, each boolean both ways. */
  const actions: RoomActBody[] = RoomAct.options.flatMap((o) => {
    let rows: Record<string, unknown>[] = [{}];
    for (const [key, f] of Object.entries(o.shape as Record<string, Field>)) {
      const vals =
        f.def.type === "literal" ? [f.def.values![0]] : f.def.type === "boolean" ? [true, false] : f.def.type === "string" ? ["g1f3"] : null;
      if (vals === null) throw new Error(`a RoomAct field of a new type (${key}: ${f.def.type}) — decide its rows`);
      rows = rows.flatMap((r) => vals.map((v) => ({ ...r, [key]: v })));
    }
    return rows.map((r) => RoomAct.parse(r));
  });
  /** Every refusing answer RoomActOut declares. */
  const answers = RoomActOut.options.flatMap((o) => {
    const shape = o.shape as Record<string, { def: { type: string; values?: unknown[] }; options?: string[] }>;
    if (shape.ok!.def.values![0] !== false) return [];
    const reconcile = shape.reconcile!.def.values![0] as boolean;
    return shape.reason!.options!.map((reason) => ({ ok: false as const, reconcile, reason }));
  });
  const actRoute = ROUTES.find((r) => r.path === "/fixtures/{id}/external-play/room/act" && r.method === "post");
  // The ruling's split of HTTP answers. Every status the route DECLARES must
  // sit in one of the two (guarded below), so a new one forces a decision.
  const RULE_REFUSALS = new Set([400, 422]); // the move string, semantically invalid
  // The request didn't go through — and play's 404, whose every cause is the
  // board, the seat or the account, never a rule (T14 re-review 5, I-1).
  const FAILURES = new Set([401, 404, 409, 429, 500, 502, 503]);
  const statuses = [...new Set([...(actRoute?.errors ?? []), ...RULE_REFUSALS, ...FAILURES])];

  type Expected = "offline" | "refused" | "invalid" | "failed" | null;
  const isMove = (a: RoomActBody) => a.kind === "move";

  it("the route's declared errors are each classified by the ruling", () => {
    expect(actRoute, "premise: the act route is declared").toBeDefined();
    expect(actRoute!.errors!.length).toBeGreaterThan(0);
    for (const st of actRoute!.errors!) expect(RULE_REFUSALS.has(st) || FAILURES.has(st), `declared ${st}`).toBe(true);
  });

  it("every row shows the ruling's notice — never C3 for a failure, never C3 or silence for a non-move", () => {
    const tally: Record<string, number> = { offline: 0, refused: 0, invalid: 0, failed: 0, none: 0 };
    let rows = 0;
    const check = (a: RoomActBody, label: string, after: RoomState, want: Expected) => {
      expect(moveNotice(after), `${JSON.stringify(a)} × ${label}`).toBe(want);
      tally[want ?? "none"]! += 1;
      rows += 1;
    };
    for (const a of actions) {
      const sent = roomReducer(live(), { type: "act_sent", at: T0, action: a });
      check(a, "network", roomReducer(sent, { type: "act_failed", status: 0 }), "offline");
      for (const st of statuses) {
        const want: Expected = !isMove(a) ? "failed" : RULE_REFUSALS.has(st) ? "invalid" : "refused";
        check(a, `HTTP ${st}`, roomReducer(sent, { type: "act_failed", status: st }), want);
      }
      for (const ans of answers) {
        // A grant refusal is the re-link SCREEN, not a notice.
        const want: Expected = !ans.reconcile ? null : isMove(a) ? "refused" : "failed";
        check(a, `${ans.reconcile ? "reconcile" : "grant"} ${ans.reason}`, roomReducer(sent, { type: "act_answered", answer: ans as never }), want);
      }
    }
    // Anti-vacuity: the unions were read, and every outcome was reached.
    expect(actions.some(isMove) && actions.some((a) => !isMove(a)), "moves and non-moves").toBe(true);
    expect(actions.length, "move, resign, draw ×2, abort").toBeGreaterThanOrEqual(5);
    expect(answers.some((x) => x.reconcile) && answers.some((x) => !x.reconcile), "both answer kinds").toBe(true);
    expect(rows).toBe(actions.length * (1 + statuses.length + answers.length));
    for (const [k, n] of Object.entries(tally)) expect(n, `rows expecting ${k}`).toBeGreaterThan(0);
  });
});

describe("ownMeetingRetired (final re-review 3, R3-1): the server no longer holds the participant this room's camera joined with", () => {
  const P = { participantId: "p-own", authToken: "tok" };
  const seated = (snapOver: Partial<RoomSnapshot>, seat: RoomState["seat"] = { seated: true, participant: P }, extra: Partial<RoomState> = {}): RoomState => ({
    ...initialRoomState(snap({ cameraPolicy: "required", ...snapOver }), T0),
    seat,
    ...extra,
  });
  // Expected from the ruling (re-claim only when the meeting the camera joined was retired under the player), never
  // from the predicate: each row says why.
  const rows: { why: string; s: RoomState; due: boolean }[] = [
    { why: "the empty case: no seat answer yet (nothing joined)", s: initialRoomState(snap({ cameraPolicy: "required" }), T0), due: false },
    { why: "seated, the same participant on file", s: seated({ ownParticipantId: "p-own" }), due: false },
    { why: "retired: none on file", s: seated({ ownParticipantId: null }), due: true },
    { why: "retired, and the new meeting already minted another", s: seated({ ownParticipantId: "p-new" }), due: true },
    { why: "a camera refusal still holds a token: retired under it", s: seated({ ownParticipantId: null }, { seated: false, reason: "camera_required", participant: P }), due: true },
    { why: "no token held (cameras off, or a refusal without one): nothing joined, nothing to move", s: seated({ ownParticipantId: null }, { seated: true, participant: null }), due: false },
    { why: "no token held, someone on file", s: seated({ ownParticipantId: "p-x" }, { seated: false, reason: "video_unavailable", participant: null }), due: false },
    { why: "a seat call in flight: its answer is the newer word", s: seated({ ownParticipantId: null }, undefined, { pending: { kind: "seat" } }), due: false },
    { why: "a result is written", s: seated({ ownParticipantId: null, result: { outcome: "win", method: "resign", score: "1-0" } as never }), due: false },
    { why: "the game is over", s: seated({ ownParticipantId: null, game: game(4, true) }), due: false },
    { why: "online chess is not offered (the re-entry's own condition)", s: seated({ ownParticipantId: null, onlineChessOff: true }), due: false },
    { why: "T17B fix 2 (D10): the organiser closed the board — no game will come, nothing to rejoin", s: seated({ ownParticipantId: null, boardClosed: true }), due: false },
  ];
  it("every row of the rule, counted", () => {
    let checked = 0;
    for (const r of rows) {
      expect(ownMeetingRetired(r.s), r.why).toBe(r.due);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(rows.length);
    expect(rows.filter((r) => r.due).length, "both answers are exercised").toBeGreaterThan(0);
    expect(rows.filter((r) => !r.due).length).toBeGreaterThan(0);
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
      ["pending", roomReducer(base, { type: "act_sent", at: T0, action: { kind: "resign" } }), false],
      // The server's word on who may act (play.ts's predicate, review I2):
      // a frozen seat and every other hold come through as canAct false.
      ["frozen you", initialRoomState(snap({ game: game(2), frozen: "you", canAct: false }), T0), false],
      ["frozen both", initialRoomState(snap({ game: game(2), frozen: "both", canAct: false }), T0), false],
      ["frozen opponent", initialRoomState(snap({ game: game(2), frozen: "opponent", canAct: true }), T0), true],
      ["held (provider_error mid-game)", initialRoomState(snap({ game: game(2), canAct: false }), T0), false],
    ];
    for (const [name, s, want] of cases) expect(canMove(s), name).toBe(want);
    expect(cases.length, "anti-vacuity: cases").toBe(10);
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
    | { k: "act"; move: boolean }
    | { k: "answer"; ok: boolean }
    | { k: "fail"; status: number }
    | { k: "actFail"; status: number }
    | { k: "off" }
    | { k: "hold" };
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.constant({ k: "advance" as const }) },
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 4 }).map((age) => ({ k: "snapshot" as const, age })) },
    { weight: 3, arbitrary: fc.record({ age: fc.integer({ min: 0, max: 4 }), offer: fc.boolean() }).map((r) => ({ k: "broadcast" as const, ...r })) },
    { weight: 1, arbitrary: fc.constant({ k: "end" as const }) },
    { weight: 2, arbitrary: fc.boolean().map((move) => ({ k: "act" as const, move })) },
    { weight: 2, arbitrary: fc.boolean().map((ok) => ({ k: "answer" as const, ok })) },
    { weight: 1, arbitrary: fc.constantFrom(0, 404, 500).map((status) => ({ k: "fail" as const, status })) },
    { weight: 2, arbitrary: fc.constantFrom(0, 400, 404, 500).map((status) => ({ k: "actFail" as const, status })) },
    { weight: 1, arbitrary: fc.constant({ k: "off" as const }) },
    // A hold placed or lifted at the server's current ply (T14 re-review 5).
    { weight: 1, arbitrary: fc.constant({ k: "hold" as const }) },
  );

  it("ply never falls, over never un-ends, polling never restarts, syncKey never falls, at most one request in flight — and the latest read wins", () => {
    const seen = {
      steps: 0, staleDropped: 0, plyRose: 0, overSeen: 0, pollingStopped: 0, doubleSendBlocked: 0, act404Survived: 0, endedPolling: 0, endedStopped: 0,
      // Seams C: each notice raised, and each ending exercised.
      offline: 0, refused: 0, invalid: 0, offlineEndedByRead: 0, endedByPlyRise: 0, nonMoveGeneric: 0,
      // I-1: reads that said nobody may act, and the notices they ended.
      heldReads: 0, endedByHold: 0,
    };
    fc.assert(
      fc.property(fc.array(step, { minLength: 12, maxLength: 40 }), (steps) => {
        // The server's history: index = server tick; each entry a snapshot.
        let serverPly = 0;
        let serverOver = false;
        let off = false;
        let hold = false;
        let sawGet404 = false;
        const history: RoomSnapshot[] = [snap({ serverNow: iso(T0), game: game(0) })];
        let s = initialRoomState(history[0]!, T0);
        const tick = () => {
          history.push(
            snap({
              serverNow: iso(T0 + history.length * 1000),
              game: { ...game(serverPly, serverOver) },
              onlineChessOff: off,
              canAct: !hold,
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
            case "hold":
              hold = !hold;
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
              const next = roomReducer(s, { type: "act_sent", at: T0, action: st.move ? { kind: "move", uci: "g1f3" } : { kind: "draw", accept: true } });
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
              if (st.status === 404) sawGet404 = true;
              break;
            case "actFail":
              s = roomReducer(s, { type: "act_failed", status: st.status });
              if (st.status === 404 && before.pending?.kind === "act") {
                expect(s.polling, "play's 404 never stops the room").toBe(before.polling);
                seen.act404Survived += 1;
              }
              break;
          }
          // Invariants, every step.
          expect(ply(s), "ply never falls").toBeGreaterThanOrEqual(ply(before));
          if (before.snap.game?.over) expect(s.snap.game?.over, "over never un-ends").toBe(true);
          if (!before.polling) expect(s.polling, "polling never restarts").toBe(false);
          expect(s.syncKey).toBeGreaterThanOrEqual(before.syncKey);
          expect(Date.parse(s.snap.serverNow)).toBeGreaterThanOrEqual(Date.parse(before.snap.serverNow));
          if (ply(s) > ply(before)) seen.plyRose += 1;
          // The notices (C1–C3): a refused/invalid error always knows its act;
          // a notice always stands on an error; an answered read is never
          // "offline"; a board past the refused position never shows C2/C3.
          const notice = moveNotice(s);
          if (s.error === "refused" || s.error === "invalid") expect(s.failedAct, "a refusal knows its act").not.toBeNull();
          if (notice !== null) expect(s.error, "a notice stands on an error").not.toBeNull();
          if (notice === "offline") seen.offline += 1;
          if (notice === "refused") seen.refused += 1;
          if (notice === "invalid") seen.invalid += 1;
          if (notice === "invalid") expect(s.failedAct, "C3 is a move's only").toBe("move");
          if ((s.error === "refused" || s.error === "invalid") && s.failedAct !== "move") {
            expect(notice, "a refused non-move is never silent: the generic C2").toBe("failed");
            seen.nonMoveGeneric += 1;
          }
          if (st.k === "snapshot") {
            expect(notice, "an answered read is never offline").not.toBe("offline");
            if (before.error === "network") seen.offlineEndedByRead += 1;
            // I-1: a read that says nobody may act leaves no C2/C3 standing.
            if (!s.snap.canAct) {
              expect(notice === "refused" || notice === "invalid" || notice === "failed", "nobody may act: no C2/C3").toBe(false);
              seen.heldReads += 1;
              if (moveNotice(before) === "refused" || moveNotice(before) === "invalid" || moveNotice(before) === "failed") seen.endedByHold += 1;
            }
          }
          if (ply(s) > ply(before)) {
            expect(notice === "refused" || notice === "invalid" || notice === "failed", "the board moved on: no C2/C3").toBe(false);
            if (moveNotice(before) === "refused" || moveNotice(before) === "invalid" || moveNotice(before) === "failed") seen.endedByPlyRise += 1;
          }
          if (s.snap.game?.over) seen.overSeen += 1;
          if (before.polling && !s.polling) seen.pollingStopped += 1;
          seen.steps += 1;
        }
        // Convergence: the server's last word, delivered, is what the room shows.
        const last = history[history.length - 1]!;
        s = roomReducer(s, { type: "snapshot", snap: last, receivedAt: T0 });
        expect(ply(s), "converges on the server's ply").toBe(serverPly);
        expect(s.snap.game?.over ?? false, "converges on over").toBe(serverOver);
        expect(s.polling, "polling stopped iff online chess went off or a read 404'd").toBe(!(off || sawGet404));
        if (s.polling) seen.endedPolling += 1;
        else seen.endedStopped += 1;
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
    expect(seen.act404Survived, "play 404s delivered while an act was pending").toBeGreaterThan(20);
    expect(seen.endedPolling, "runs ending still polling").toBeGreaterThan(20);
    expect(seen.endedStopped, "runs ending stopped").toBeGreaterThan(20);
    expect(seen.offline, "steps showing C1").toBeGreaterThan(200);
    expect(seen.refused, "steps showing C2").toBeGreaterThan(100);
    // Measured 70 at this seed once play's 404 left C3 too (T14 re-review 5,
    // I-1): only a MOVE's rule refusal (here the 400s) raises it now.
    expect(seen.invalid, "steps showing C3").toBeGreaterThan(50);
    expect(seen.offlineEndedByRead, "C1 ended by an answered read").toBeGreaterThan(30);
    expect(seen.endedByPlyRise, "C2/C3 ended by the board moving on").toBeGreaterThan(10);
    expect(seen.nonMoveGeneric, "a refused offer shows the generic C2").toBeGreaterThan(100);
    expect(seen.heldReads, "reads that said nobody may act").toBeGreaterThan(100);
    // Measured at this seed: 184 such reads, 16 of them ending a notice.
    expect(seen.endedByHold, "C2/C3 ended by such a read").toBeGreaterThan(10);
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
