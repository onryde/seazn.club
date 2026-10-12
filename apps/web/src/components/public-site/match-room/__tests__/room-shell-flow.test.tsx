// T14 — the camera-required check-in, driven through the REAL shell, the
// real transport (use-room), the real camera hook and session, the real
// reducer and screen decision. Faked only at the two outer edges: the HTTP
// fetch (our own room routes' envelopes) and RealtimeKit's join. Cameras-off
// play is the e2e's; this is the path the e2e cannot take (no camera in CI).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (k: string) => k,
  usePlural: () => (k: string, n: number) => `${k}:${n}`,
  useLocale: () => "en",
}));
const join = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../camera-loader", () => ({ joinOwnCamera: (token: string) => join.fn(token) }));

import { RoomShell } from "../room-shell";
import type { RoomSnapshot } from "../room-snapshot";
import type { OwnCamera } from "../camera-loader";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
let tick = 0;
function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  tick += 1;
  return {
    fixtureId: "f1",
    serverNow: new Date(T0 + tick).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 20 * 60_000).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true },
    cameraPolicy: "required",
    opponentCameraLive: true,
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
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data, requestId: "r" }), { status: 200 });
const PARTICIPANT = { participantId: "p-own", authToken: "own-rtk-token" };
const TRACK = { id: "cam" } as unknown as MediaStreamTrack;

type Call = { method: string; url: string };
let calls: Call[] = [];
// Thunks: each answer is composed when the server would compose it, so its
// serverNow is later than every earlier read (the reducer drops stale ones).
let seatAnswers: (() => unknown)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  tick = 0;
  join.fn.mockReset();
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(public tracks: MediaStreamTrack[]) {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url });
      if (init.method === "POST" && url.startsWith("/api/v1/fixtures/f1/external-play/room?")) return ok(seatAnswers.shift()?.());
      if (init.method === "GET") return ok(snap());
      return new Response("{}", { status: 500 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
function liveCamera(): OwnCamera {
  return { track: () => TRACK, onChange: () => () => {}, enable: async () => {}, leave: async () => {} };
}
type Island = { tree: () => ReturnType<typeof walk> };
const screenOf = (island: Island) => {
  const root = walk(island.tree()).find((e) => propsOf(e)["data-testid"] === "match-room");
  return propsOf(root!)["data-screen"];
};
const roomOf = (island: Island) => {
  const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
  return propsOf(screen!).room as { claim: () => Promise<unknown> };
};
const seatPosts = () => calls.filter((c) => c.method === "POST" && c.url.includes("/external-play/room?")).length;

describe("camera required: check in → refused for camera → the camera joins with OUR token → the seat is taken", () => {
  it("joins RealtimeKit with the participant token from the refusal, re-claims, and lands on 'both in'", async () => {
    seatAnswers = [
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } }),
      () => ({
        snapshot: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, creation: { state: "creating" } }),
        seat: { seated: true, participant: PARTICIPANT },
      }),
    ];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    expect(screenOf(island)).toBe("checkin");
    expect(join.fn, "no camera before the server hands a token").not.toHaveBeenCalled();

    await roomOf(island).claim(); // Check in
    await settle();
    expect(join.fn.mock.calls).toEqual([["own-rtk-token"]]);
    expect(screenOf(island), "camera up, seat being re-asked: still the check-in, not card 2").toBe("checkin");
    expect(seatPosts()).toBe(1);

    await settle(1_500);
    expect(seatPosts(), "the seat is asked again once the camera is live").toBe(2);
    expect(screenOf(island)).toBe("creating");
    expect(calls.every((c) => c.url.includes("t=tok")), "every call carries the personal link").toBe(true);
    island.unmount();
  });

  it("a camera that cannot start (permission denied) shows card 2 — and never re-claims on its own", async () => {
    seatAnswers = [() => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } })];
    join.fn.mockRejectedValue(new Error("NotAllowedError"));
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle(10_000);
    expect(screenOf(island)).toBe("cameraRequired");
    expect(seatPosts()).toBe(1);
    island.unmount();
  });

  it("a camera that stays up but the server still refuses: three re-claims, then card 2 (bounded, never a loop)", async () => {
    const refusal = () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } });
    seatAnswers = [refusal, refusal, refusal, refusal, refusal, refusal];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    for (let i = 0; i < 6; i += 1) await settle(1_500);
    expect(seatPosts()).toBe(1 + 3);
    expect(screenOf(island)).toBe("cameraRequired");
    expect(join.fn, "one join for the whole flow").toHaveBeenCalledTimes(1);
    island.unmount();
  });

  it("cameras OFF: no RealtimeKit join at all, whatever the seat answer carries", async () => {
    seatAnswers = [() => ({ snapshot: snap({ cameraPolicy: "off" }), seat: { seated: true, participant: PARTICIPANT } })];
    const island = renderIsland(RoomShell, { initial: snap({ cameraPolicy: "off" }), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle(5_000);
    expect(join.fn).not.toHaveBeenCalled();
    island.unmount();
  });

  it("re-entry with cameras on (already checked in): the room claims once on mount to rejoin the camera", async () => {
    seatAnswers = [() => ({ snapshot: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true } }), seat: { seated: true, participant: PARTICIPANT } })];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, {
      initial: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true } }),
      token: "tok",
      selfPath: "/x",
    });
    await settle();
    expect(seatPosts()).toBe(1);
    expect(join.fn.mock.calls).toEqual([["own-rtk-token"]]);
    island.rerender({ initial: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true } }), token: "tok", selfPath: "/x" });
    await settle();
    expect(seatPosts(), "once, not per render").toBe(1);
    island.unmount();
  });
});
