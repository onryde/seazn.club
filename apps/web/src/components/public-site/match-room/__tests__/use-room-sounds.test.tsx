// T17B fix 2, D19 — the sounds hook through the harness's real useEffect/useRef: each new state the room renders is
// one observation; the switch decides whether a sound is PLAYED, never whether the room keeps watching (so turning
// sounds on never replays a ply that arrived while they were off). A gesture anywhere on the page is what unlocks
// audio; the hook itself never creates a context. Low time rides the same hook, on the server's clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { useRoomSounds, useSoundSwitch } from "../use-room-sounds";
import { initialRoomState, roomReducer, type RoomState } from "../room-state";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";
import type { RoomAudio } from "../room-audio";
import { soundPrefStore } from "../sound-pref";

const T0 = Date.parse("2026-10-14T18:00:00.000Z");
function game(moves: string[], over: Partial<RoomGame> = {}): RoomGame {
  const c = new Chess();
  for (const m of moves) c.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
  return {
    gameId: "g1",
    moves,
    fen: c.fen(),
    lastMove: null,
    turn: c.turn() === "w" ? "white" : "black",
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
const fakeAudio = () => ({ unlock: vi.fn(), play: vi.fn() }) satisfies RoomAudio;
type P = { state: RoomState; on: boolean; audio: RoomAudio };
function Probe({ state, on, audio }: P) {
  useRoomSounds(state, on, audio);
  return null;
}
const read = (at: number, moves: string[], over: Partial<RoomGame> = {}) => (s: RoomState) =>
  roomReducer(s, { type: "snapshot", snap: snap(game(moves, over), at), receivedAt: at });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRoomSounds (D19) — the room's renders in, sounds out", () => {
  // The room's clock is the server's: the wall clock sits at the fixtures' instant, so a 10-minute clock is 10 minutes.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  it("the load is silent; each new ply plays once; a re-render of the same state plays nothing", () => {
    const audio = fakeAudio();
    let state = initialRoomState(snap(game(["e2e4"])), T0);
    const island = renderIsland(Probe, { state, on: true, audio });
    expect(audio.play, "the load").not.toHaveBeenCalled();
    state = read(T0 + 1_000, ["e2e4", "e7e5"])(state);
    island.rerender({ state, on: true, audio });
    expect(audio.play.mock.calls).toEqual([["opponentMove"]]);
    island.rerender({ state, on: true, audio });
    island.rerender({ state: { ...state }, on: true, audio });
    expect(audio.play, "the same board, rendered again").toHaveBeenCalledTimes(1);
  });

  it("switched off: nothing plays — and turning it back on replays NOTHING that arrived meanwhile", () => {
    const audio = fakeAudio();
    let state = initialRoomState(snap(game(["e2e4"])), T0);
    const island = renderIsland(Probe, { state, on: false, audio });
    state = read(T0 + 1_000, ["e2e4", "e7e5"])(state);
    island.rerender({ state, on: false, audio });
    expect(audio.play).not.toHaveBeenCalled();
    island.rerender({ state, on: true, audio });
    expect(audio.play, "the ply that came while off stays unheard").not.toHaveBeenCalled();
    state = read(T0 + 2_000, ["e2e4", "e7e5", "g1f3"])(state);
    island.rerender({ state, on: true, audio });
    expect(audio.play.mock.calls).toEqual([["move"]]);
  });

  it("the hook never creates audio itself; with no document (a server render) it adds no listener and never throws", () => {
    const audio = fakeAudio();
    expect(typeof document, "premise: vitest is node").toBe("undefined");
    expect(() => renderIsland(Probe, { state: initialRoomState(snap(game(["e2e4"])), T0), on: true, audio })).not.toThrow();
    expect(audio.unlock).not.toHaveBeenCalled();
  });

  it("a gesture anywhere on the page (a tap, a key) unlocks audio — and leaving the room removes the listeners", () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("document", {
      addEventListener: (type: string, l: EventListener) => listeners.set(type, l),
      removeEventListener: (type: string, l: EventListener) => listeners.get(type) === l && listeners.delete(type),
    });
    const audio = fakeAudio();
    const island = renderIsland(Probe, { state: initialRoomState(snap(game(["e2e4"])), T0), on: true, audio });
    expect([...listeners.keys()].sort()).toEqual(["keydown", "pointerdown"]);
    listeners.get("pointerdown")!(new Event("pointerdown"));
    listeners.get("keydown")!(new Event("keydown"));
    expect(audio.unlock).toHaveBeenCalledTimes(2);
    island.unmount();
    expect(listeners.size, "removed on the way out").toBe(0);
  });

  it("low time: the player's own running clock crossing 10 s plays it once; the opponent's never does", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const audio = fakeAudio();
    // White (the player) to move at ply 2 with 12 s, as of now: the clock runs down through 10 s.
    const mine = initialRoomState(snap(game(["e2e4", "e7e5"], { whiteMs: 12_000 })), T0);
    renderIsland(Probe, { state: mine, on: true, audio });
    vi.advanceTimersByTime(1_000);
    expect(audio.play, "11 s left").not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(audio.play.mock.calls).toEqual([["lowTime"]]);
    vi.advanceTimersByTime(5_000);
    expect(audio.play, "once").toHaveBeenCalledTimes(1);

    // Black to move, both clocks at 12 s: the OPPONENT's clock runs down through 10 s — not the player's low time —
    // and the player's own 12 s stands still.
    const theirs = initialRoomState(snap(game(["e2e4", "e7e5", "g1f3"], { whiteMs: 12_000, blackMs: 12_000, clockAsOf: new Date(Date.now()).toISOString() }), Date.now()), Date.now());
    const other = fakeAudio();
    renderIsland(Probe, { state: theirs, on: true, audio: other });
    vi.advanceTimersByTime(5_000);
    expect(other.play).not.toHaveBeenCalled();
  });
});

describe("useSoundSwitch (D19): the header's toggle", () => {
  it("default ON; a press turns it off and remembers it; turning it on plays a short preview — it is a tap, so audio is unlocked", () => {
    const device = new Map<string, string>();
    const store = soundPrefStore(() => ({ getItem: (k: string) => device.get(k) ?? null, setItem: (k: string, v: string) => device.set(k, v) }) as unknown as Storage);
    const audio = fakeAudio();
    function Switch() {
      const s = useSoundSwitch(store, audio);
      return <button data-on={String(s.on)} onClick={s.toggle} />;
    }
    const island = renderIsland(Switch, {});
    const press = () => {
      const found = [...new Set(walk(island.tree()))].filter((e) => e.type === "button");
      expect(found).toHaveLength(1);
      (propsOf(found[0]!).onClick as () => void)();
      return propsOf(found[0]!)["data-on"];
    };
    expect(press(), "default on").toBe("true");
    expect(store.get()).toBe(false);
    expect(audio.play, "turning off is silent").not.toHaveBeenCalled();
    press();
    expect(store.get()).toBe(true);
    expect(audio.unlock).toHaveBeenCalled();
    expect(audio.play.mock.calls).toEqual([["move"]]);
  });
});
