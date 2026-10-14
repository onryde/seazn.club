// T14 — which screen the room shows. Expected screens come from the owner's
// canvas (States board, 2026-10-11: cards 1–8, check-in, live, game over)
// and preflight's refusal list, never from room-screen.ts. The empty case
// first: an open window with nothing happened yet is the check-in.
import { describe, expect, it } from "vitest";
import { roomScreen, seatRefusalScreen } from "../room-screen";
import { initialRoomState, roomReducer, type RoomState } from "../room-state";
import type { RoomGame, RoomSnapshot, SeatRefusal } from "../room-snapshot";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const GAME: RoomGame = {
  gameId: "g1",
  moves: [],
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  lastMove: null,
  turn: "white",
  whiteMs: 600_000,
  blackMs: 600_000,
  clockAsOf: null,
  clockRunning: false,
  drawOfferBy: null,
  over: false,
};
function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: null,
    opensAt: null,
    deadline: null,
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Ada Okonkwo", checkedIn: false },
    opponent: { colour: "black", name: "Bo Lind", checkedIn: false },
    cameraPolicy: "off",
    opponentPresence: null,
    frozen: null,
    canAct: true,
    otherAccount: null,
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
const st = (over: Partial<RoomSnapshot> = {}, patch: Partial<RoomState> = {}): RoomState => ({
  ...initialRoomState(snap(over), T0),
  ...patch,
});
const refused = (reason: SeatRefusal) => ({ seated: false as const, reason, participant: null });

describe("roomScreen", () => {
  it("the empty case: an open window, no seat asked, no game ⇒ the check-in", () => {
    expect(roomScreen(st())).toEqual({ kind: "checkin" });
  });

  it("checked in and waiting for the opponent stays on the check-in (its done state)", () => {
    expect(roomScreen(st({ you: { colour: "white", name: "A", checkedIn: true } }, { seat: { seated: true, participant: null } }))).toEqual({
      kind: "checkin",
    });
  });

  it("the window: not opened and before ⇒ card 1; closed with no game ⇒ card 6; held with no game ⇒ card 6", () => {
    expect(roomScreen(st({ phase: "not_opened" })).kind).toBe("notOpened");
    expect(roomScreen(st({ phase: "before" })).kind).toBe("notOpened");
    expect(roomScreen(st({ phase: "closed" })).kind).toBe("closed");
    expect(roomScreen(st({ held: true })).kind).toBe("closed");
  });

  it("both in, no game yet ⇒ card 5; busy carries Lichess's retry time", () => {
    expect(roomScreen(st({ creation: { state: "creating" } }))).toEqual({ kind: "creating", retryAt: null });
    expect(roomScreen(st({ creation: { state: "busy", retryAt: "2026-10-12T10:01:00.000Z" } }))).toEqual({
      kind: "creating",
      retryAt: "2026-10-12T10:01:00.000Z",
    });
  });

  it("every seat refusal has its card (preflight's nine reasons; canvas cards 1, 2, 3, 4, 6, 7, 8)", () => {
    const want: Record<SeatRefusal, string> = {
      camera_required: "cameraRequired",
      camera_lost: "cameraLost",
      video_unavailable: "videoDown",
      lichess_link_required: "relink",
      lichess_reconsent_required: "relink",
      window_closed: "closed",
      round_not_open: "notOpened",
      not_a_player: "unavailable",
      fixture_not_playable: "unavailable",
    };
    let checked = 0;
    for (const [reason, kind] of Object.entries(want) as [SeatRefusal, string][]) {
      expect(seatRefusalScreen(reason), reason).toBe(kind);
      expect(roomScreen(st({}, { seat: refused(reason) })).kind, reason).toBe(kind);
      checked += 1;
    }
    expect(checked, "anti-vacuity: refusal reasons").toBe(9);
  });

  it("a game on file is the live room — whatever stale seat refusal or window the state still holds", () => {
    expect(roomScreen(st({ game: GAME, phase: "closed" }, { seat: refused("window_closed") })).kind).toBe("live");
    expect(roomScreen(st({ game: GAME }, { seat: refused("camera_lost") })).kind).toBe("live");
  });

  it("over: the game says over, or a result is written (with or without a board)", () => {
    expect(roomScreen(st({ game: { ...GAME, over: true } })).kind).toBe("over");
    expect(roomScreen(st({ result: { outcome: "won", method: null, score: "1–0" } })).kind).toBe("over");
  });

  it("precedence: not found > online chess off > over > your seat frozen > relink > held > live", () => {
    // Review I1 (controller ruling): a written result outranks the frozen
    // seat — the frozen player sees how the game ended, never A again.
    const all = st(
      { onlineChessOff: true, frozen: "you", canAct: false, game: GAME, result: { outcome: "lost", method: "time", score: "0–1" } },
      { notFound: true, error: "relink" },
    );
    const off = { ...all.snap, onlineChessOff: false };
    expect(roomScreen(all).kind).toBe("unavailable");
    expect(roomScreen({ ...all, notFound: false }).kind).toBe("offForClub");
    expect(roomScreen({ ...all, notFound: false, snap: off }).kind).toBe("over");
    expect(roomScreen({ ...all, notFound: false, snap: { ...off, result: null } }).kind).toBe("revoked");
    expect(roomScreen({ ...all, notFound: false, snap: { ...off, result: null, frozen: null } }).kind).toBe("relink");
    expect(roomScreen({ ...all, notFound: false, error: null, snap: { ...off, result: null, frozen: null } }).kind).toBe("held");
    expect(roomScreen({ ...all, notFound: false, error: null, snap: { ...off, result: null, frozen: null, canAct: true } }).kind).toBe("live");
  });

  it("P10: Lichess said at page load that the grant no longer plays ⇒ relink — game over and a frozen seat outrank it; it outranks a held board, the live board and the check-in", () => {
    const grantRefusedOn = (over: Partial<RoomSnapshot>) => roomScreen(st(over, { grantRefused: true })).kind;
    // The empty case first: no refusal leaves each of these on its own screen.
    expect([st({ game: GAME, canAct: true }), st({ game: GAME, canAct: false }), st({})].map((x) => roomScreen(x).kind)).toEqual(["live", "held", "checkin"]);
    expect([grantRefusedOn({ game: GAME, canAct: true }), grantRefusedOn({ game: GAME, canAct: false }), grantRefusedOn({})]).toEqual(["relink", "relink", "relink"]);
    expect(grantRefusedOn({ game: { ...GAME, over: true } })).toBe("over");
    expect(grantRefusedOn({ game: GAME, frozen: "you" })).toBe("revoked");
  });

  it("I1: a frozen seat whose game is over — written or seen over — is the game-over screen, for both freezes", () => {
    let checked = 0;
    for (const frozen of ["you", "both"] as const) {
      expect(roomScreen(st({ game: GAME, frozen, canAct: false, result: { outcome: "won", method: "resign", score: "1–0" } })).kind, frozen).toBe("over");
      expect(roomScreen(st({ game: { ...GAME, over: true }, frozen, canAct: false })).kind, frozen).toBe("over");
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a freeze: yours or both ⇒ A (revoked); the opponent's ⇒ your board plays on", () => {
    expect(roomScreen(st({ game: GAME, frozen: "you", canAct: false })).kind).toBe("revoked");
    expect(roomScreen(st({ game: GAME, frozen: "both", canAct: false })).kind).toBe("revoked");
    expect(roomScreen(st({ game: GAME, frozen: "opponent", canAct: true })).kind).toBe("live");
  });

  it("re-review 5 I-2: the game is on ANOTHER Lichess account ⇒ A (revoked) — after over, before relink and held; the pairs: the same board as recorded is live, held stays held", () => {
    const other = { game: GAME, canAct: false, otherAccount: "ada_recorded" } as const;
    expect(roomScreen(st(other)).kind).toBe("revoked");
    // The remedy is a re-link either way: the server's reason outranks a re-link the act asked for.
    expect(roomScreen(st(other, { error: "relink" })).kind).toBe("revoked");
    // A written result, or a game seen over, outranks it (as it does a freeze).
    expect(roomScreen(st({ ...other, result: { outcome: "lost", method: "time", score: "0–1" } })).kind).toBe("over");
    expect(roomScreen(st({ ...other, game: { ...GAME, over: true } })).kind).toBe("over");
    // The pairs.
    expect(roomScreen(st({ game: GAME, canAct: true, otherAccount: null })).kind).toBe("live");
    expect(roomScreen(st({ game: GAME, canAct: false, otherAccount: null })).kind).toBe("held");
  });

  it("I2: a game on file the server will not take a move on is HELD — never the live, movable room", () => {
    // A provider_error mid-game, T13's deadline hold of a created game, a
    // withdrawn board: play.ts refuses each, so the room must too.
    expect(roomScreen(st({ game: GAME, canAct: false })).kind).toBe("held");
    expect(roomScreen(st({ game: GAME, canAct: false, held: true })).kind).toBe("held");
    expect(roomScreen(st({ game: GAME, canAct: false, phase: "closed" })).kind).toBe("held");
    // The pair: the same board the server takes moves on is live.
    expect(roomScreen(st({ game: GAME, canAct: true })).kind).toBe("live");
    // No game: a hold is still card 6.
    expect(roomScreen(st({ game: null, canAct: false, held: true })).kind).toBe("closed");
  });

  it("through the reducer (a sequence): check-in → seat refused for camera → seated → game arrives → over", () => {
    let s = st();
    expect(roomScreen(s).kind).toBe("checkin");
    s = roomReducer(s, { type: "seat_sent" });
    s = roomReducer(s, {
      type: "seat_answered",
      answer: { snapshot: snap({ serverNow: new Date(T0 + 1).toISOString() }), seat: refused("camera_required"), create: null },
      receivedAt: T0,
    });
    expect(roomScreen(s).kind).toBe("cameraRequired");
    s = roomReducer(s, { type: "seat_sent" });
    s = roomReducer(s, {
      type: "seat_answered",
      answer: {
        snapshot: snap({ serverNow: new Date(T0 + 2).toISOString(), creation: { state: "creating" } }),
        seat: { seated: true, participant: null },
        create: null,
      },
      receivedAt: T0,
    });
    expect(roomScreen(s).kind).toBe("creating");
    s = roomReducer(s, { type: "snapshot", snap: snap({ serverNow: new Date(T0 + 3).toISOString(), game: GAME }), receivedAt: T0 });
    expect(roomScreen(s).kind).toBe("live");
    s = roomReducer(s, {
      type: "broadcast",
      b: { fen: GAME.fen, lastMove: null, turn: "white", whiteMs: 1, blackMs: 1, status: "aborted", drawOfferBy: null },
      receivedAt: T0,
    });
    expect(roomScreen(s).kind).toBe("over");
  });
});

describe("roomScreen — the camera settling (room-shell's context)", () => {
  it("a camera refusal stays on the check-in while the camera comes up; card 2/3 once it will not", () => {
    let checked = 0;
    for (const reason of ["camera_required", "camera_lost"] as const) {
      const s = st({}, { seat: refused(reason) });
      expect(roomScreen(s, { cameraSettling: true }).kind, reason).toBe("checkin");
      expect(roomScreen(s, { cameraSettling: false }).kind, reason).toBe(reason === "camera_required" ? "cameraRequired" : "cameraLost");
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("settling never hides any OTHER refusal", () => {
    let checked = 0;
    for (const reason of ["video_unavailable", "window_closed", "lichess_link_required", "not_a_player"] as const) {
      expect(roomScreen(st({}, { seat: refused(reason) }), { cameraSettling: true }).kind, reason).not.toBe("checkin");
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});
