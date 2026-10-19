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

vi.mock("@sentry/nextjs", () => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { Screen } from "../room-shell";
import { Checkin } from "../checkin";
import { OwnTile } from "../own-tile";
import { HANDOVER_CEILING_MS, HANDOVER_COVER_MS } from "../camera-handover";
import { initialRoomState, roomReducer, type RoomState } from "../room-state";
import type { RoomSnapshot } from "../room-snapshot";
import type { CameraTestView } from "../camera-test";
import type { RoomScreen } from "../room-screen";

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
    opponentCamera: null,
    ownParticipantId: null,
    frozen: null,
    canAct: true,
    otherAccount: null,
    account: { state: "ok" },
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    heldUntil: null,
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
    camera: { status: "idle", stream: null, enable: () => {} } as never,
    busy: false,
    tryAgain,
    relinkHref: "/x",
    locale: "en",
    t: ((k: string) => k) as never,
    plural: ((k: string) => k) as never,
  };
}
const stateOf = (s: RoomSnapshot, seat: RoomState["seat"] = null): RoomState => ({ ...initialRoomState(s, T0), seat });
/** D23-fix-2: what the Screen is handed while Check in's own seat claim is in flight — the state a cover is for. A cover
 *  with NOTHING in flight is a false statement and ends (see the end table below), so every test that wants one standing
 *  starts from a claim on its way. */
const coverProps = (state: RoomState): Parameters<typeof Screen>[0] => ({ ...props(state), busy: true });

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
  vi.mocked(Sentry.addBreadcrumb).mockClear();
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
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
    expect(handoverOf(island)!.view).toEqual({ status: "idle", frame: null });
    expect(tileOf(island).frozen ?? null).toBeNull();
  });

  it("the preview's frame is drawn WHILE the camera is still live, then the camera stops; the cover holds that frame", async () => {
    const cam = stubCamera();
    const canvases = stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
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
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
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

  it("no SDK video: the PICTURE is gone at the bound, not before; the words stay and the tile still listens for the SDK's frame (D23-fix m1)", async () => {
    vi.useFakeTimers();
    const cam = stubCamera();
    stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 1);
    expect(handoverOf(island)!.view.status).toBe("covering");
    expect(tileOf(island).frozen, "one tick early: the picture").not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(handoverOf(island)!.view).toEqual({ status: "connecting", frame: null });
    expect(tileOf(island).frozen ?? null, "no picture").toBeNull();
    expect(tileOf(island).connecting, "but the words stay over the silhouette").toBe(true);
    expect(tileOf(island).onFrame, "and the SDK's frame still ends it").toBe(handoverOf(island)!.onSdkFrame);
    expect(Sentry.addBreadcrumb, "nothing ended yet: nothing reported").not.toHaveBeenCalled();
    // The SDK's video arrives late: the words go, and the end is reported once, as late (the stg measurement).
    vi.advanceTimersByTime(2_500);
    handoverOf(island)!.onSdkFrame(sdkStream);
    await settle();
    expect(handoverOf(island)!.view).toEqual({ status: "over", frame: null, by: "sdk" });
    expect(tileOf(island).connecting, "words gone").toBe(false);
    expect(vi.mocked(Sentry.addBreadcrumb).mock.calls).toEqual([
      [{ category: "chess.camera.handover", level: "info", message: "camera handover ended", data: { by: "sdk", ms: HANDOVER_COVER_MS + 2_500, pictureExpired: true } }],
    ]);
  });

  it("an SDK frame inside the bound is reported once as not late", async () => {
    vi.useFakeTimers();
    const cam = stubCamera();
    stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    vi.advanceTimersByTime(1_500);
    handoverOf(island)!.onSdkFrame(sdkStream);
    handoverOf(island)!.onSdkFrame(sdkStream);
    await settle();
    expect(vi.mocked(Sentry.addBreadcrumb).mock.calls.map((c) => c[0]!.data)).toEqual([{ by: "sdk", ms: 1_500, pictureExpired: false }]);
  });

  it("unmounting the room mid-cover leaves no timer behind and reports nothing (D23-fix m5)", async () => {
    vi.useFakeTimers();
    for (const waited of [0, HANDOVER_COVER_MS + 1_000]) {
      const cam = stubCamera();
      stubDocumentCanvas(cam.track);
      const island = renderIsland(Screen, coverProps(stateOf(snap())));
      await liveCheckin(island, cam);
      handoverOf(island)!.register(video());
      testOf(island)!.onHandOver();
      await settle();
      vi.advanceTimersByTime(waited);
      expect(handoverOf(island)!.view.status, `premise: still active after ${waited} ms`).toBe(waited === 0 ? "covering" : "connecting");
      island.unmount();
      expect(vi.getTimerCount(), `after ${waited} ms`).toBe(0);
      vi.advanceTimersByTime(HANDOVER_CEILING_MS * 2);
      expect(Sentry.addBreadcrumb, "the page left: no end to report").not.toHaveBeenCalled();
    }
  });

  it("a preview that never painted (no size) leaves no cover — and Check in still stops the camera", async () => {
    const cam = stubCamera();
    const canvases = stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
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

// D23-fix m2: the words end when there is nothing left to wait for, not only on the SDK's frame or the clock.
describe("D23-fix: the cover ends when the room knows the camera is not coming (failed, gave up, the screen left, the budget spent)", () => {
  afterEach(() => vi.useRealTimers());

  const ENDS_GAME = {
    gameId: "g1",
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
  type P = Parameters<typeof Screen>[0];
  const withCamera = (p: P, status: string): P => ({ ...p, camera: { ...p.camera, status } as never });
  const withScreen = (p: P, kind: string): P => ({
    ...p,
    screen: (kind === "creating" ? { kind, retryAt: null } : { kind }) as never,
  });
  /** D23-fix-2 (the cards): what each screen means for a cover standing over the tile. The check-in is where it is born,
   *  the live board is where it follows the tile (a quick check-in beats the SDK's video), and the creating card is
   *  where the claim is answered and the game is not up yet; EVERY OTHER screen has no tile coming up for the player, so
   *  a cover standing across one would resurface on re-entry as a false "Connecting…". A Record over the union: a new
   *  screen kind is a compile error here until someone decides which it is. */
  const SCREEN_VERDICT: Record<RoomScreen["kind"], "ends" | "keeps"> = {
    unavailable: "ends",
    repairing: "ends",
    offForClub: "ends",
    revoked: "ends",
    seatHeld: "ends",
    relink: "ends",
    // The signed-in account is not the seat's: a card, no tile coming up for the viewer - a cover would resurface as a false "Connecting…".
    wrongAccount: "ends",
    over: "ends",
    held: "ends",
    live: "keeps",
    notOpened: "ends",
    batchWait: "ends",
    cameraRequired: "ends",
    cameraLost: "ends",
    cameraBlocked: "ends",
    videoDown: "ends",
    creating: "keeps",
    closed: "ends",
    boardClosed: "ends",
    checkin: "keeps",
  };
  const screensWhere = (v: "ends" | "keeps") => Object.entries(SCREEN_VERDICT).filter(([, x]) => x === v).map(([k]) => k);
  /** A cover is up (the picture or the words, by `phase`); returns the island and the props it is rendered with. */
  async function covered(phase: "covering" | "connecting") {
    vi.useFakeTimers();
    const cam = stubCamera();
    stubDocumentCanvas(cam.track);
    // A game on file, so the seams and the result have a board to draw when the Screen is taken to them.
    const base = coverProps(stateOf(snap({ game: ENDS_GAME as never })));
    const island = renderIsland(Screen, base);
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    if (phase === "connecting") vi.advanceTimersByTime(HANDOVER_COVER_MS + 500);
    expect(handoverOf(island)!.view.status, `premise: ${phase}`).toBe(phase);
    // Rendering again with the same props is the room's own re-render: the cover stands (the empty case of every end).
    island.rerender(base);
    await settle();
    expect(handoverOf(island)!.view.status, "premise: a plain re-render ends nothing").toBe(phase);
    return { island, base };
  }

  /** The cover's state lives in the Screen's hook and is read from the check-in's props: after a change that took the
   *  Screen off the check-in (a seam, the result) it is read by going back to the check-in with everything else as it was. */
  async function viewBack(island: Island, changed: P) {
    island.rerender({ ...changed, screen: { kind: "checkin" } as never });
    await settle();
    return handoverOf(island);
  }

  const meetingSeat = { seated: true, participant: { authToken: "t", participantId: "p1" } } as unknown as RoomState["seat"];
  const ENDS: { name: string; by: string; change: (p: P) => P }[] = [
    { name: "the camera failed", by: "failed", change: (p) => withCamera(p, "failed") },
    { name: "the camera gave up", by: "failed", change: (p) => withCamera(p, "gave_up") },
    // (a) nothing in flight: the claim answered or failed, no poll, and no camera on its way.
    { name: "nothing is in flight (claim cleared, no poll, camera idle, no meeting)", by: "idle", change: (p) => ({ ...p, busy: false }) },
    { name: "nothing is in flight, the camera is off", by: "idle", change: (p) => ({ ...withCamera(p, "off"), busy: false }) },
    ...screensWhere("ends").map((k) => ({ name: `the screen became ${k}`, by: "left", change: (p: P) => withScreen(p, k) })),
    { name: "the seat's camera_starting poll budget ran out", by: "budget", change: (p) => ({ ...p, startBudgetSpent: true }) },
  ];
  const KEEPS: { name: string; change: (p: P) => P }[] = [
    { name: "the camera is joining", change: (p) => withCamera(p, "joining") },
    { name: "the camera is recovering", change: (p) => withCamera(p, "recovering") },
    { name: "the camera is live", change: (p) => withCamera(p, "live") },
    { name: "the camera is idle (claim in flight)", change: (p) => withCamera(p, "idle") },
    // The claim is answered and nothing is pending, but the camera is on its way: that is the happy path.
    { name: "claim answered, camera joining", change: (p) => ({ ...withCamera(p, "joining"), busy: false }) },
    { name: "claim answered, camera recovering", change: (p) => ({ ...withCamera(p, "recovering"), busy: false }) },
    { name: "claim answered, camera live", change: (p) => ({ ...withCamera(p, "live"), busy: false }) },
    {
      name: "claim answered with a participant, camera not started yet (idle) — the SDK is about to join",
      change: (p) => ({ ...p, busy: false, state: { ...p.state, seat: meetingSeat } }),
    },
    { name: "claim answered camera_starting, the room is polling", change: (p) => ({ ...p, busy: false, checkingCamera: true }) },
    ...screensWhere("keeps").map((k) => ({ name: `the screen is ${k}`, change: (p: P) => withScreen(p, k) })),
    { name: "the budget is not spent", change: (p) => ({ ...p, startBudgetSpent: false }) },
  ];

  it("each end stops it, from the picture and from the words alone, and reports how — and each keep leaves it standing (counted)", async () => {
    let checked = 0;
    for (const phase of ["covering", "connecting"] as const) {
      for (const e of ENDS) {
        const { island, base } = await covered(phase);
        vi.mocked(Sentry.addBreadcrumb).mockClear();
        island.rerender(e.change(base));
        await settle();
        expect((await viewBack(island, e.change(base)))!.view, `${e.name} (${phase})`).toEqual({ status: "over", frame: null, by: e.by });
        expect(vi.mocked(Sentry.addBreadcrumb).mock.calls.map((c) => [c[0]!.data?.by, c[0]!.data?.pictureExpired]), `${e.name} (${phase}): reported once`).toEqual([
          [e.by, phase === "connecting"],
        ]);
        island.unmount();
        checked += 1;
      }
      for (const k of KEEPS) {
        const { island, base } = await covered(phase);
        vi.mocked(Sentry.addBreadcrumb).mockClear();
        island.rerender(k.change(base));
        await settle();
        expect((await viewBack(island, k.change(base)))!.view.status, `${k.name} (${phase})`).toBe(phase);
        expect(Sentry.addBreadcrumb, `${k.name} (${phase})`).not.toHaveBeenCalled();
        island.unmount();
        checked += 1;
      }
    }
    expect(checked, `anti-vacuity: ${ENDS.length} ends and ${KEEPS.length} keeps, two phases`).toBe(2 * (ENDS.length + KEEPS.length));
    expect(screensWhere("ends").length + screensWhere("keeps").length, "every screen kind is classified").toBe(Object.keys(SCREEN_VERDICT).length);
  });

  // D23-fix-3 (reviewer's ruling on D23-fix-2 (b)): there is no failure counter. The cover ends when NOTHING is in flight,
  // and a failed call is read through what it leaves, not counted. Both halves are driven through the REAL reducer.
  const failedSeatCall = (s: RoomState): RoomState => {
    const sent = roomReducer(s, { type: "seat_sent" });
    expect(sent.pending, "premise: the call is out").toEqual({ kind: "seat" });
    const failed = roomReducer(sent, { type: "seat_failed", status: 500 });
    expect(failed.pending, "premise: the call failed and is no longer pending").toBeNull();
    return failed;
  };
  const STARTING_SEAT = { seated: false, reason: "camera_starting", participant: { authToken: "t", participantId: "p1" } } as unknown as RoomState["seat"];

  it("the FIRST claim failing (no seat, no poll, camera idle) ends the cover at once as 'idle' — and the pair: the same cover with the claim still out stands", async () => {
    const { island, base } = await covered("covering");
    expect(handoverOf(island)!.view.status, "premise: covered, the first claim out (busy)").toBe("covering");
    vi.mocked(Sentry.addBreadcrumb).mockClear();
    const failed = { ...base, busy: false, state: failedSeatCall(base.state) };
    expect([failed.state.seat, failed.checkingCamera], "premise: nothing answered, nothing polling").toEqual([null, undefined]);
    island.rerender(failed);
    await settle();
    expect(handoverOf(island)!.view, "ended").toEqual({ status: "over", frame: null, by: "idle" });
    expect(vi.mocked(Sentry.addBreadcrumb).mock.calls.map((c) => c[0]!.data?.by), "reported once, as idle").toEqual(["idle"]);
  });

  // "off" is in the list on purpose: with the camera joining, recovering or live (or idle with the meeting's token in hand)
  // `cameraComing` already keeps the cover, so only a camera that is OFF shows that the room's own polling is a keep by itself.
  it("ONE failed camera_starting poll does NOT end the cover while the room is still polling — whatever the camera's state (counted); the budget ends it, not the failure", async () => {
    let checked = 0;
    for (const cameraStatus of ["idle", "joining", "recovering", "live", "off"]) {
      for (const phase of ["covering", "connecting"] as const) {
        const { island, base } = await covered(phase);
        vi.mocked(Sentry.addBreadcrumb).mockClear();
        // The claim was answered camera_starting (the room polls), then a poll failed (a 5xx / a dropped connection).
        const answered = roomReducer(roomReducer(base.state, { type: "seat_sent" }), {
          type: "seat_answered",
          answer: { snapshot: base.state.snap, seat: STARTING_SEAT } as never,
          receivedAt: T0,
        });
        const polling = withCamera({ ...base, busy: false, state: answered, checkingCamera: true }, cameraStatus);
        island.rerender(polling);
        await settle();
        expect(handoverOf(island)!.view.status, `${cameraStatus}/${phase}: answered camera_starting, polling`).toBe(phase);
        const failedPoll = { ...polling, state: failedSeatCall(answered) };
        expect([failedPoll.state.seat, failedPoll.checkingCamera, failedPoll.busy], "premise: the poll failed, the room still polls").toEqual([STARTING_SEAT, true, false]);
        island.rerender(failedPoll);
        await settle();
        expect(handoverOf(island)!.view.status, `${cameraStatus}/${phase}: one failed poll does not end the cover`).toBe(phase);
        expect(Sentry.addBreadcrumb, `${cameraStatus}/${phase}: nothing reported`).not.toHaveBeenCalled();
        // The polls run out (the room's own bound): THAT ends it, as ever.
        island.rerender({ ...failedPoll, startBudgetSpent: true, checkingCamera: false });
        await settle();
        expect(handoverOf(island)!.view, `${cameraStatus}/${phase}: the spent budget ends it`).toEqual({ status: "over", frame: null, by: "budget" });
        island.unmount();
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 5 camera states x 2 phases").toBe(10);
  });

  it("a camera that failed with NO hand-over in progress reports nothing and covers nothing (the empty case)", async () => {
    const island = renderIsland(Screen, withCamera(props(stateOf(snap())), "failed"));
    await settle();
    expect(handoverOf(island)!.view).toEqual({ status: "idle", frame: null });
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  it("the ceiling: words that nothing ever ends are stopped at HANDOVER_CEILING_MS, reported as such (a frame proof that never fires)", async () => {
    const { island } = await covered("connecting");
    vi.advanceTimersByTime(HANDOVER_CEILING_MS - HANDOVER_COVER_MS - 500 - 1);
    expect(handoverOf(island)!.view.status, "one tick before").toBe("connecting");
    vi.advanceTimersByTime(1);
    expect(handoverOf(island)!.view).toEqual({ status: "over", frame: null, by: "ceiling" });
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
    // The seat is answered; the SDK is on its way to the first frame: something is in flight.
    camera: { ...props(stateOf(snap())).camera, status: "joining" } as never,
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
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
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

  it("D23-fix: on the live board the PICTURE goes at its bound but the words stay over the tile, still listening for the SDK's frame — which removes them", async () => {
    vi.useFakeTimers();
    const cam = stubCamera();
    stubDocumentCanvas(cam.track);
    const island = renderIsland(Screen, coverProps(stateOf(snap())));
    await liveCheckin(island, cam);
    handoverOf(island)!.register(video());
    testOf(island)!.onHandOver();
    await settle();
    island.rerender(liveProps());
    await settle();
    expect(strip(island).frozen, "premise: the picture is up on the live tile").not.toBeNull();
    expect(strip(island).connecting, "and no words-only state yet").toBe(false);
    vi.advanceTimersByTime(HANDOVER_COVER_MS);
    await settle();
    expect(strip(island).frozen ?? null, "no picture").toBeNull();
    expect(strip(island).connecting, "the words stay").toBe(true);
    expect(typeof strip(island).onFrame, "and the tile listens for the SDK's frame").toBe("function");
    (strip(island).onFrame as (s: MediaStream) => void)(sdkStream);
    await settle();
    expect(strip(island).connecting, "removed").toBe(false);
    expect(strip(island).onFrame, "nothing left to prove").toBeUndefined();
  });

  it("a live board that never saw a Check in hand-over (a returning player) has no cover (the empty case)", () => {
    const island = renderIsland(Screen, liveProps());
    expect(strip(island).frozen ?? null).toBeNull();
    expect(strip(island).onFrame).toBeUndefined();
  });
});
