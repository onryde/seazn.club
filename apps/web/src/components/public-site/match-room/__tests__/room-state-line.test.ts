// Capacity test 32, the reducer's half (spec §5.7.3, §6.1 (2), §8.1): a `queued` seat answer keeps the token the room holds,
// carries `left` only on the first claim of a replacement stay, and the card keeps saying it (sticky) until the answer stops
// being `queued`. A 429 on the seat route changes nothing in the room.
import { describe, expect, it } from "vitest";
import { initialRoomState, roomReducer, type RoomState } from "../room-state";
import type { SeatAnswer } from "../room-api";
import type { LineWire, RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
function snap(): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: iso(T0),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: iso(T0),
    opensAt: iso(T0),
    deadline: iso(T0 + 10 * 60_000),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 300, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
    cameraPolicy: "required",
    opponentCamera: null,
    ownParticipantId: null,
    frozen: null,
    canAct: false,
    otherAccount: null,
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    heldUntil: null,
    realtime: null,
  };
}
const TOKEN = { participantId: "pt-1", authToken: "jwt-1" };
const line = (over: Partial<LineWire> = {}): LineWire => ({
  position: 4,
  etaS: 40,
  pollMs: 3_000,
  closesAt: iso(T0 + 12 * 60_000),
  mayTimeOut: false,
  left: null,
  ...over,
});
const queued = (over: Partial<LineWire> = {}): SeatAnswer => ({ seated: false, reason: "queued", participant: null, line: line(over) });
function answer(s: RoomState, seat: SeatAnswer | null): RoomState {
  return roomReducer(s, { type: "seat_answered", answer: { snapshot: snap(), seat, create: null }, receivedAt: T0 });
}
const fresh = () => initialRoomState(snap(), T0);

describe("the room's reducer on a queued seat answer", () => {
  it("starts with no 'left' to show", () => {
    expect(fresh().lineLeft).toBeNull();
  });

  it("keeps the token the room already holds (the budget looked at nothing), and does not invent one", () => {
    let s = answer(fresh(), { seated: false, reason: "camera_required", participant: TOKEN });
    expect(s.seat?.participant, "premise: the room holds the token").toEqual(TOKEN);
    s = answer(s, queued());
    expect(s.seat, "the queued answer is the seat").toMatchObject({ seated: false, reason: "queued", participant: TOKEN });
    // The pair: a room that held none stays with none.
    const bare = answer(fresh(), queued());
    expect(bare.seat?.participant).toBeNull();
    // And ONLY these answers keep it: a seated answer without a token means there is none.
    const seated = answer(s, { seated: true, participant: null });
    expect(seated.seat?.participant, "every other tokenless answer means none").toBeNull();
  });

  it("'left' reaches the card on the claim that carries it, SURVIVES the polls that follow (the server says it once), and is gone when the answer stops being queued", () => {
    let s = answer(fresh(), queued({ left: "silent" }));
    expect(s.lineLeft).toBe("silent");
    s = answer(s, queued({ position: 3 }));
    expect(s.lineLeft, "the next poll carries no left - the card still says it").toBe("silent");
    s = answer(s, queued({ position: 2 }));
    expect(s.lineLeft).toBe("silent");
    // The player is admitted: the answer is the claim's own, and the notice goes with the line.
    s = answer(s, { seated: false, reason: "camera_starting", participant: null });
    expect(s.lineLeft, "a non-queued answer clears it").toBeNull();
    // Back in line later with nothing to say: nothing is shown (it does not come back).
    s = answer(s, queued());
    expect(s.lineLeft).toBeNull();
  });

  it("each value of the wire's `left` is kept as itself, and a newer one replaces an older one (camera after silent)", () => {
    const seen: LineWire["left"][] = [];
    for (const left of ["silent", "camera"] as const) {
      const s = answer(fresh(), queued({ left }));
      seen.push(s.lineLeft);
    }
    expect(seen).toEqual(["silent", "camera"]);
    let s = answer(fresh(), queued({ left: "silent" }));
    s = answer(s, queued({ left: "camera" }));
    expect(s.lineLeft).toBe("camera");
  });

  it("a null seat answer (a claim that asked nothing) clears it too", () => {
    let s = answer(fresh(), queued({ left: "camera" }));
    s = answer(s, null);
    expect(s.lineLeft).toBeNull();
    expect(s.seat).toBeNull();
  });
});

describe("a seat-door failure while the card shows the line", () => {
  it("a 429 changes nothing the card shows: the line, the notice, the token and polling all stay; only `pending` clears", () => {
    let s = answer(answer(fresh(), { seated: false, reason: "camera_required", participant: TOKEN }), queued({ left: "silent" }));
    s = roomReducer(s, { type: "seat_sent" });
    expect(s.pending, "premise: the claim is in flight").toEqual({ kind: "seat" });
    const failed = roomReducer(s, { type: "seat_failed", status: 429, code: "RATE_LIMITED" });
    expect(failed.pending).toBeNull();
    expect(failed.seat).toBe(s.seat);
    expect(failed.lineLeft).toBe("silent");
    expect(failed.polling, "a 429 is not a refusal").toBe(true);
    expect(failed.notFound).toBe(false);
  });
});
