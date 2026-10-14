// T17B fix 2, D15 — the camera test wired through the REAL Screen and its real hook (renderIsland runs useState /
// useEffect / useCallback): under "required" the check-in gets the test; a seat answer that carried a participant
// token (the SDK has, or is taking, the camera) turns it to "handed" and it never asks for the camera; leaving the
// check-in releases the test camera; "optional" and "off" get today's check-in. Over the platform's getUserMedia,
// stubbed with fake tracks (vitest is node: no camera).
//
// Single sport, deliberately: online play exists only for boardgame chess (supportsOnlinePlay).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (k: string) => k,
  usePlural: () => (k: string, n: number) => `${k}:${n}`,
  useLocale: () => "en",
}));

import { Screen } from "../room-shell";
import { Checkin } from "../checkin";
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
