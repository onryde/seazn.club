// T17B fix 2, D21-fix-4 (review I1) - the BROWSER's hop of `heldParticipantId`: the real useRoom `claim` puts the id of the
// participant whose token the room holds on the seat POST, and sends nothing when it holds none.
//
// Why a hook test and not the builder's (room-api.test.ts): claimSeat(fixtureId, token, held) was tested with a held id TYPED
// IN. What reaches the wire in production is whatever `claim` passes, read from the reducer's seat - and a refactor that
// passed `null` there left every other suite green while the server went back to refreshing a token on every poll (75% of a
// thirty-board round's vendor calls, D22). This drives the REAL hook (real reducer, real callback, the real stale-closure
// ref) through two claims with fetch stubbed at the boundary and reads the bodies it was handed. The route's hop is
// route-seat-wire.test.ts's; what a real browser sends is match-room.spec.ts's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { useRoom } from "../use-room";
import type { RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
function snap(): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 20 * 60_000).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 300, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
    cameraPolicy: "required",
    opponentPresence: null,
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
    realtime: null,
  };
}

type Room = ReturnType<typeof useRoom>;
function Slot({ room }: { room: Room }) {
  void room; // read back through its props, never rendered
  return null;
}
function Probe({ snap: s }: { snap: RoomSnapshot }) {
  return <Slot room={useRoom(s, "tok")} />;
}
const roomOf = (island: ReturnType<typeof renderIsland<{ snap: RoomSnapshot }>>): Room => {
  const slot = island.tree().find((el) => el.type === Slot);
  if (!slot) throw new Error("the probe rendered no slot");
  return propsOf(slot).room as Room;
};

/** What the browser POSTed to the SEAT route (not the room's GET reads, and not the camera door). */
type Sent = { url: string; body: string | null };
function stubSeatServer(answers: unknown[]): Sent[] {
  const sent: Sent[] = [];
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: typeof init?.body === "string" ? init.body : null });
    const seat = answers[Math.min(n, answers.length - 1)];
    n += 1;
    return new Response(JSON.stringify({ ok: true, data: { snapshot: snap(), seat, create: null }, requestId: "t" }), { status: 200 });
  });
  return sent;
}
const TOKEN = { participantId: "pt-held-1", authToken: "jwt-1" };
const REFUSED_WITH_TOKEN = { seated: false, reason: "camera_required", participant: TOKEN };
const STARTING_TOKENLESS = { seated: false, reason: "camera_starting", participant: null };
const REFUSED_NO_TOKEN = { seated: false, reason: "camera_required", participant: null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRoom.claim sends the participant the room holds (D21-fix-4, I1)", () => {
  it("the FIRST claim carries no body (the room holds nothing); the SECOND names the participant the first answer handed over", async () => {
    const sent = stubSeatServer([REFUSED_WITH_TOKEN, STARTING_TOKENLESS]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    expect(sent.length, "anti-vacuity: the first claim went out").toBe(1);
    expect(sent[0]!.body, "nothing held: no body at all").toBeNull();
    expect(roomOf(island).state.seat, "premise: the answer's token is the room's now").toMatchObject({ participant: TOKEN });

    await roomOf(island).claim();
    expect(sent.length).toBe(2);
    expect(sent[1]!.url, "to the seat route, with the personal link").toMatch(/\/external-play\/room\?t=tok$/);
    expect(JSON.parse(sent[1]!.body!), "the held participant, by id").toEqual({ heldParticipantId: TOKEN.participantId });
  });

  it("the room KEEPS the id across a tokenless camera_starting, so a THIRD claim still names it (the reducer's half of the hop)", async () => {
    const sent = stubSeatServer([REFUSED_WITH_TOKEN, STARTING_TOKENLESS, STARTING_TOKENLESS]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    await roomOf(island).claim();
    await roomOf(island).claim();
    expect(sent.length).toBe(3);
    expect(JSON.parse(sent[2]!.body!)).toEqual({ heldParticipantId: TOKEN.participantId });
  });

  it("the pair: a room that was handed NO token sends none (a tokenless refusal is 'holds none', never an id invented)", async () => {
    const sent = stubSeatServer([REFUSED_NO_TOKEN, REFUSED_NO_TOKEN]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    await roomOf(island).claim();
    expect(sent.map((s) => s.body), "two claims, neither with a body").toEqual([null, null]);
  });
});
