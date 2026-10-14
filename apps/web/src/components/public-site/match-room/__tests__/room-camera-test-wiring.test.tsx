// T17B fix 2, D15 — the camera test wired through the REAL Screen and its real hook (renderIsland runs useState /
// useEffect / useCallback): under "required" the check-in gets the test; a seat answer that carried a participant
// token (the SDK has, or is taking, the camera) turns it to "handed" and it never asks for the camera; leaving the
// check-in releases the test camera; "optional" and "off" get today's check-in. Over the platform's getUserMedia,
// stubbed with fake tracks (vitest is node: no camera).
//
// Single sport, deliberately: online play exists only for boardgame chess (supportsOnlinePlay).
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (k: string) => k,
  usePlural: () => (k: string, n: number) => `${k}:${n}`,
  useLocale: () => "en",
}));

import { Screen } from "../room-shell";
import { Checkin } from "../checkin";
import { OwnTile } from "../own-tile";
import { HANDOVER_COVER_MS } from "../camera-handover";
import { initialRoomState, type RoomState } from "../room-state";
import type { RoomSnapshot } from "../room-snapshot";
import type { CameraTestView } from "../camera-test";

const T0 = Date.parse("2026-10-14T16:50:00.000Z");

function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 20 * 60_000).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 300, incrementSeconds: 0 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
    cameraPolicy: "required",
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
const noop = async () => null;
const tryAgain = vi.fn();
function props(state: RoomState): Parameters<typeof Screen>[0] {
  return {
    screen: { kind: "checkin" } as never,
    state,
    room: { state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never,
    camera: { status: "idle", stream: null, enable: () => {}, link: () => null, onLinkChange: () => () => {} } as never,
    busy: false,
    tryAgain,
    relinkHref: "/x",
    locale: "en",
    t: ((k: string) => k) as never,
    plural: ((k: string) => k) as never,
  };
}
const stateOf = (s: RoomSnapshot, seat: RoomState["seat"] = null): RoomState => ({ ...initialRoomState(s, T0), seat });

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  stop() {
    this.readyState = "ended";
  }
}
function stubCamera() {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { track, stream, getUserMedia };
}

type Island = ReturnType<typeof renderIsland<Parameters<typeof Screen>[0]>>;
type TestProp = { view: CameraTestView; onTest: () => void; onFrame: (s: MediaStream) => void; onHandOver: () => void } | null;
const checkin = (island: Island) => {
  const found = [...new Set(walk(island.tree()))].filter((e) => e.type === Checkin);
  expect(found, "premise: one check-in").toHaveLength(1);
  return propsOf(found[0]!);
};
const testOf = (island: Island) => checkin(island).cameraTest as TestProp;
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.unstubAllGlobals();
  tryAgain.mockReset();
});

describe("D15 through the real Screen: the camera test before Check in", () => {
  it("the empty case first: 'optional' and 'off' get today's check-in — no test (counted)", () => {
    let checked = 0;
    for (const cameraPolicy of ["optional", "off"] as const) {
      const island = renderIsland(Screen, props(stateOf(snap({ cameraPolicy }))));
      expect(testOf(island), cameraPolicy).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("'required': test → painted frame → live; Check in is the room's own; hand-over stops the camera at once", async () => {
    const cam = stubCamera();
    const island = renderIsland(Screen, props(stateOf(snap())));
    expect(testOf(island)!.view.status, "before the test").toBe("idle");
    expect(checkin(island).onCheckIn, "Check in is the room's seat claim").toBe(tryAgain);
    testOf(island)!.onTest();
    await settle();
    expect(cam.getUserMedia.mock.calls).toEqual([[{ video: true, audio: false }]]);
    expect(testOf(island)!.view).toEqual({ status: "testing", stream: cam.stream, failure: null });
    testOf(island)!.onFrame(cam.stream);
    await settle();
    expect(testOf(island)!.view.status).toBe("live");
    testOf(island)!.onHandOver();
    await settle();
    expect(cam.track.readyState, "released before the seat is asked for").toBe("ended");
    expect(testOf(island)!.view.status).toBe("handed");
  });

  it("a seat answer with a participant token: the test is handed, and asks for no camera — the SDK has it", async () => {
    const cam = stubCamera();
    const seat = { seated: false, reason: "camera_starting", participant: { authToken: "t", participantId: "p1" } } as unknown as RoomState["seat"];
    const island = renderIsland(Screen, props(stateOf(snap(), seat)));
    expect(testOf(island)!.view.status).toBe("handed");
    testOf(island)!.onTest();
    await settle();
    expect(cam.getUserMedia, "no second grab of the camera").not.toHaveBeenCalled();
  });

  it("leaving the check-in (checked in) releases the test camera, and the test is gone", async () => {
    const cam = stubCamera();
    const island = renderIsland(Screen, props(stateOf(snap())));
    testOf(island)!.onTest();
    await settle();
    expect(cam.track.readyState).toBe("live");
    island.rerender(props(stateOf(snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true } }))));
    await settle();
    expect(cam.track.readyState, "the camera light goes off").toBe("ended");
    expect(testOf(island), "a checked-in player has no test").toBeNull();
  });

  it("unmounting the room releases the test camera", async () => {
    const cam = stubCamera();
    const island = renderIsland(Screen, props(stateOf(snap())));
    testOf(island)!.onTest();
    await settle();
    island.unmount();
    expect(cam.track.readyState).toBe("ended");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T17B fix 2, D23 — Check in stops the test camera before the seat is asked for; the tile must not go blank until the
// SDK's video arrives. Through the REAL Screen and its real hooks: the last frame is drawn BEFORE the stop, covers
// the tile, and goes when the SDK's own video paints a frame (or at the bound).
// NOT provable here: the SDK's real video (no RealtimeKit join exists off stg) — the "SDK frame" is the tile's own
// onFrame, called with the camera hook's stream, exactly as OwnTile's frame proof calls it.

type HandoverProp = {
  view: { status: string; frame: unknown };
  register: (el: HTMLVideoElement | null) => void;
  onSdkFrame: (s: MediaStream) => void;
} | null;
const handoverOf = (island: Island) => checkin(island).handover as HandoverProp;
/** Check is hookless: call it for its tree, as the unit suite does, and find the tile it draws. */
const tileOf = (island: Island) => {
  const tree = Checkin(checkin(island) as Parameters<typeof Checkin>[0]);
  const tiles = [...new Set(walk(tree))].filter((e) => e.type === OwnTile);
  expect(tiles, "premise: one tile on the check-in").toHaveLength(1);
  return propsOf(tiles[0]!);
};

function stubDocumentCanvas(track: FakeTrack) {
  const drawn: { trackAtDraw: string; size: [number, number] }[] = [];
  const made: unknown[] = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("canvas");
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => drawn.push({ trackAtDraw: track.readyState, size: [c.width, c.height] }),
        }),
      };
      made.push(c);
      return c;
    },
  });
  return { drawn, made };
}
const video = (w = 640, h = 480) => ({ videoWidth: w, videoHeight: h }) as unknown as HTMLVideoElement;
const sdkStream = {} as MediaStream;

async function liveCheckin(island: Island, cam: ReturnType<typeof stubCamera>) {
  testOf(island)!.onTest();
  await settle();
  testOf(island)!.onFrame(cam.stream);
  await settle();
  expect(testOf(island)!.view.status, "premise: a proven camera, Check in open").toBe("live");
}

describe("D23 through the real Screen: the tile is never blank between Check in's stop and the SDK's video", () => {
  afterEach(() => vi.useRealTimers());

  it("the empty case first: before Check in nothing covers the tile", async () => {
    const island = renderIsland(Screen, props(stateOf(snap())));
    expect(handoverOf(island)!.view).toEqual({ status: "idle", frame: null });
    expect(tileOf(island).frozen ?? null).toBeNull();
  });

  it("the preview's frame is drawn WHILE the camera is still live, then the camera stops; the cover holds that frame", async () => {
    const cam = stubCamera();
    const canvases = stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, props(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video(640, 480));
    testOf(island)!.onHandOver();
    await settle();
    expect(canvases.drawn, "one frame drawn, from the live preview").toEqual([{ trackAtDraw: "live", size: [640, 480] }]);
    expect(cam.track.readyState, "and the camera released after it").toBe("ended");
    expect(testOf(island)!.view.status).toBe("handed");
    expect(handoverOf(island)!.view.status).toBe("covering");
    expect(tileOf(island).frozen, "the tile shows the drawn canvas").toBe(canvases.made[0]);
  });

  it("the SDK's own video painting a frame removes the cover — and a frame of nothing earlier does not", async () => {
    const cam = stubCamera();
    stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, props(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    // The tile's frame proof is wired to the cover, not to the (now ended) camera test.
    expect(tileOf(island).onFrame, "the tile listens for the SDK's frame").toBe(handoverOf(island)!.onSdkFrame);
    expect(handoverOf(island)!.view.status, "still covering until it does").toBe("covering");
    handoverOf(island)!.onSdkFrame(sdkStream);
    await settle();
    expect(handoverOf(island)!.view).toEqual({ status: "over", frame: null, by: "sdk" });
    expect(tileOf(island).frozen ?? null).toBeNull();
    expect(tileOf(island).onFrame, "nothing left to prove").toBeUndefined();
  });

  it("no SDK video ever: the cover is gone at the bound, and not before", async () => {
    vi.useFakeTimers();
    const cam = stubCamera();
    stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, props(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 1);
    expect(handoverOf(island)!.view.status).toBe("covering");
    vi.advanceTimersByTime(1);
    expect(handoverOf(island)!.view).toEqual({ status: "over", frame: null, by: "timeout" });
    expect(tileOf(island).frozen ?? null).toBeNull();
  });

  it("a preview that never painted (no size) leaves no cover — and Check in still stops the camera", async () => {
    const cam = stubCamera();
    const canvases = stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, props(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video(0, 0));
    testOf(island)!.onHandOver();
    await settle();
    expect(canvases.drawn).toEqual([]);
    expect(handoverOf(island)!.view.status).toBe("idle");
    expect(cam.track.readyState).toBe("ended");
  });

  it("a retried Check in (already handed over, the tile showing the SDK's camera) draws no second cover", async () => {
    const cam = stubCamera();
    const canvases = stubDocumentCanvas(cam.track);
    const seat = { seated: false, reason: "camera_starting", participant: { authToken: "t", participantId: "p1" } } as unknown as RoomState["seat"];
    const island = renderIsland(Screen, props(stateOf(snap(), seat)));
    expect(testOf(island)!.view.status, "premise: handed").toBe("handed");
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    expect(canvases.drawn, "the video on show is the SDK's, not the test's: nothing to freeze").toEqual([]);
    expect(handoverOf(island)!.view.status).toBe("idle");
  });

  it("'optional' and 'off' have no test, so no cover and no hand-over wiring on their check-in", () => {
    for (const cameraPolicy of ["optional", "off"] as const) {
      const island = renderIsland(Screen, props(stateOf(snap({ cameraPolicy }))));
      expect(checkin(island).cameraTest, cameraPolicy).toBeNull();
      expect((handoverOf(island)?.view ?? { status: "idle" }).status, cameraPolicy).toBe("idle");
    }
  });
});

describe("D23 on the live board: the cover follows the tile into the room (a quick check-in beats the SDK's video)", () => {
  afterEach(() => vi.useRealTimers());

  const game = {
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    turn: "white",
    whiteMs: 300_000,
    blackMs: 300_000,
    clockAsOf: new Date(T0).toISOString(),
    clockRunning: false,
    over: false,
    lastMove: null,
    moves: [],
    drawOfferBy: null,
    startedAt: new Date(T0).toISOString(),
  };
  const liveProps = (): Parameters<typeof Screen>[0] => ({
    ...props(stateOf(snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, game: game as never }))),
    screen: { kind: "live" } as never,
  });
  const strip = (island: Island) => {
    const strips = [...new Set(walk(island.tree()))].filter((e) => typeof e.type === "function" && e.type.name === "TileStrip");
    expect(strips, "premise: one tile strip on the live board").toHaveLength(1);
    const el = strips[0]!;
    const tree = (el.type as (p: unknown) => ReactElement)(propsOf(el));
    const tiles = [...new Set(walk(tree))].filter((e) => e.type === OwnTile);
    expect(tiles, "premise: one tile in the strip").toHaveLength(1);
    return propsOf(tiles[0]!);
  };

  it("Check in, then the board comes up before the SDK's video: the live tile holds the same frame, and the SDK's frame removes it", async () => {
    const cam = stubCamera();
    const canvases = stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, props(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    island.rerender(liveProps());
    await settle();
    const covered = strip(island);
    expect(covered.frozen, "the same kept frame, now over the room's tile").toBe(canvases.made[0]);
    expect(typeof covered.onFrame, "the tile listens for the SDK's frame").toBe("function");
    expect(typeof covered.videoRef).toBe("function");
    (covered.onFrame as (s: MediaStream) => void)(sdkStream);
    await settle();
    expect(strip(island).frozen ?? null, "removed").toBeNull();
    expect(strip(island).onFrame, "nothing left to prove").toBeUndefined();
  });

  it("a live board that never saw a Check in hand-over (a returning player) has no cover (the empty case)", () => {
    const island = renderIsland(Screen, liveProps());
    expect(strip(island).frozen ?? null).toBeNull();
    expect(strip(island).onFrame).toBeUndefined();
  });
});
