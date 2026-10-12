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

  it("precedence: not found > online chess off > your seat frozen > relink > over > live", () => {
    const all = st(
      { onlineChessOff: true, frozen: "you", game: { ...GAME, over: true } },
      { notFound: true, error: "relink" },
    );
    expect(roomScreen(all).kind).toBe("unavailable");
    expect(roomScreen({ ...all, notFound: false }).kind).toBe("offForClub");
    expect(roomScreen({ ...all, notFound: false, snap: { ...all.snap, onlineChessOff: false } }).kind).toBe("revoked");
    expect(roomScreen({ ...all, notFound: false, snap: { ...all.snap, onlineChessOff: false, frozen: null } }).kind).toBe("relink");
    expect(roomScreen({ ...all, notFound: false, error: null, snap: { ...all.snap, onlineChessOff: false, frozen: null } }).kind).toBe("over");
  });

  it("a freeze: yours or both ⇒ A (revoked); the opponent's ⇒ your board plays on", () => {
    expect(roomScreen(st({ game: GAME, frozen: "you" })).kind).toBe("revoked");
    expect(roomScreen(st({ game: GAME, frozen: "both" })).kind).toBe("revoked");
    expect(roomScreen(st({ game: GAME, frozen: "opponent" })).kind).toBe("live");
  });

  it("through the reducer (a sequence): check-in → seat refused for camera → seated → game arrives → over", () => {
    let s = st();
    expect(roomScreen(s).kind).toBe("checkin");
    s = roomReducer(s, { type: "seat_sent" });
    s = roomReducer(s, {
      type: "seat_answered",
      answer: { snapshot: snap({ serverNow: new Date(T0 + 1).toISOString() }), seat: refused("camera_required") },
      receivedAt: T0,
    });
    expect(roomScreen(s).kind).toBe("cameraRequired");
    s = roomReducer(s, { type: "seat_sent" });
    s = roomReducer(s, {
      type: "seat_answered",
      answer: {
        snapshot: snap({ serverNow: new Date(T0 + 2).toISOString(), creation: { state: "creating" } }),
        seat: { seated: true, participant: null },
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
