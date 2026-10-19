// T17B fix 2, D24 — the SEAM: room-state's reducer is pure and takes the instant of a drop in the event; the hook that
// really sends the move is what stamps it (`at: Date.now()`). A reducer suite alone proves the reducer, with an `at` the
// test typed in — the inert-seam shape. This drives the REAL useRoom `act` through the hook harness (real useReducer,
// real useCallback) with the move's POST left hanging, and reads the guess the room holds while it is in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { useRoom } from "../use-room";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const c = new Chess();
for (const m of ["e2e4", "e7e5"]) c.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
const GAME: RoomGame = {
  gameId: "g1",
  moves: ["e2e4", "e7e5"],
  fen: c.fen(),
  lastMove: ["e7", "e5"],
  turn: "white",
  whiteMs: 10_000,
  blackMs: 300_000,
  clockAsOf: new Date(T0).toISOString(),
  clockRunning: true,
  drawOfferBy: null,
  over: false,
};
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
    you: { colour: "white", name: "Bo Lind", checkedIn: true },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
    cameraPolicy: "off",
    opponentCamera: null,
    ownParticipantId: null,
    frozen: null,
    canAct: true,
    otherAccount: null,
    account: { state: "ok" },
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: GAME,
    held: false,
    result: null,
    watchUrl: null,
    heldUntil: null,
    realtime: null,
  };
}

type Room = ReturnType<typeof useRoom>;
/** What the hook hands its caller, carried as props of an element the harness can read back (the repo's hook-test
 *  shape: a component's own variables cannot be assigned from inside it). */
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRoom.act stamps a move's drop for the optimistic clock (D24)", () => {
  it("a move sent 1 s into a 10 s clock leaves a guess of 9 s + 5 s while its POST is still out; a resign leaves none", async () => {
    const posts: unknown[] = [];
    // Every call hangs: the move is "in flight to Lichess" for the whole test.
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
      return new Promise(() => {});
    });
    const island = renderIsland(Probe, { snap: snap() });
    expect(roomOf(island).state.optimistic, "the empty case: nothing in flight").toBeNull();

    vi.advanceTimersByTime(1_000); // the player thinks for a second
    void roomOf(island).act({ kind: "move", uci: "g1f3" });
    expect(posts, "the move went out").toEqual([{ kind: "move", uci: "g1f3" }]);
    expect(roomOf(island).state.optimistic, "10 s − 1 s + 5 s, stamped on the server's clock").toEqual({
      gameId: "g1",
      ply: 3,
      ms: 14_000,
      at: T0 + 1_000,
    });
  });

  it("a resign sent the same way leaves no guess (only a move earns the increment)", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const island = renderIsland(Probe, { snap: snap() });
    vi.advanceTimersByTime(1_000);
    void roomOf(island).act({ kind: "resign" });
    expect(roomOf(island).state.pending).toEqual({ kind: "act", action: { kind: "resign" } });
    expect(roomOf(island).state.optimistic).toBeNull();
  });
});
