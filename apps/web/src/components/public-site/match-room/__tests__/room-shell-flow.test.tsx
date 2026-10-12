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
import type { MeetingLink, OwnCamera } from "../camera-loader";
import { PRESENCE_SETTLE_MS, PRESENCE_TICK_MS } from "../opponent-presence";

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
    opponentPresence: null,
    frozen: null,
    canAct: true,
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
/** What a GET room answers; the check-in by default. */
let getAnswer: () => RoomSnapshot = () => snap();

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  tick = 0;
  getAnswer = () => snap();
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
      if (init.method === "GET") return ok(getAnswer());
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
  return {
    track: () => TRACK,
    onChange: () => () => {},
    enable: async () => {},
    leave: async () => {},
    link: () => null,
    onLinkChange: () => () => {},
  };
}
/** A camera whose meeting link the test moves, as the SDK's signalling would. */
function meetingCamera() {
  let current: MeetingLink | null = null;
  const listeners = new Set<() => void>();
  const cam: OwnCamera = {
    ...liveCamera(),
    link: () => current,
    onLinkChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  return {
    cam,
    set(l: MeetingLink | null) {
      current = l;
      for (const cb of [...listeners]) cb();
    },
  };
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

  it("m7: re-entry on a game already over claims nothing — there is no camera to rejoin for a finished board", async () => {
    join.fn.mockResolvedValue(liveCamera());
    const over = {
      gameId: "g1",
      moves: ["f2f3", "e7e5", "g2g4", "d8h4"],
      fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
      lastMove: ["d8", "h4"] as [string, string],
      turn: "white" as const,
      whiteMs: 590_000,
      blackMs: 592_000,
      clockAsOf: new Date(T0).toISOString(),
      clockRunning: false,
      drawOfferBy: null,
      over: true,
    };
    const island = renderIsland(RoomShell, {
      initial: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, game: over, canAct: false }),
      token: "tok",
      selfPath: "/x",
    });
    await settle(1_000);
    expect(screenOf(island)).toBe("over");
    expect(seatPosts(), "no seat claim for a finished game").toBe(0);
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

describe("I2: a refused act never stops the room — it re-reads, backing off when refusals repeat", () => {
  it("play's 404 and a Lichess refusal each re-read; the second in a row waits 1s; an accepted act resets; the poll carries on", async () => {
    const live = {
      gameId: "g1",
      moves: ["e2e4", "e7e5"],
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      lastMove: ["e7", "e5"] as [string, string],
      turn: "white" as const,
      whiteMs: 590_000,
      blackMs: 592_000,
      clockAsOf: new Date(T0).toISOString(),
      clockRunning: false,
      drawOfferBy: null,
      over: false,
    };
    const base = { cameraPolicy: "off" as const, opponentPresence: null, you: { colour: "white" as const, name: "Bo Lind", checkedIn: true }, game: live };
    const actAnswers: (() => Response)[] = [
      () => new Response(JSON.stringify({ ok: false, error: { code: "not_found" } }), { status: 404 }),
      () => ok({ ok: false, reconcile: true, reason: "rejected" }),
      () => ok({ ok: true, applied: true }),
      () => new Response(JSON.stringify({ ok: false, error: { code: "not_found" } }), { status: 404 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ method: String(init.method), url });
        if (init.method === "POST" && url.includes("/external-play/room/act?")) return actAnswers.shift()!();
        if (init.method === "GET") return ok(snap(base));
        return new Response("{}", { status: 500 });
      }),
    );
    const island = renderIsland(RoomShell, { initial: snap(base), token: "tok", selfPath: "/x" });
    await settle();
    const gets = () => calls.filter((c) => c.method === "GET").length;
    const act = () => (roomOf(island) as unknown as { act: (a: { kind: "resign" }) => Promise<void> }).act({ kind: "resign" });
    const g0 = gets();

    void act(); // 1st failure in a row (play's 404): re-read at once
    await settle();
    expect(gets(), "the first refusal re-reads at once").toBe(g0 + 1);
    expect(screenOf(island), "a 404 from play is not the room vanishing").toBe("live");

    void act(); // 2nd in a row (Lichess refused): back off 1s
    await settle();
    expect(gets(), "the second waits").toBe(g0 + 1);
    await settle(999);
    expect(gets()).toBe(g0 + 1);
    await settle(1);
    expect(gets(), "…and re-reads after 1s").toBe(g0 + 2);

    void act(); // accepted: the streak resets, re-read at once
    await settle();
    expect(gets()).toBe(g0 + 3);
    void act(); // a fresh first failure: at once again
    await settle();
    expect(gets(), "an accepted act resets the back-off").toBe(g0 + 4);
    expect(actAnswers.length, "anti-vacuity: every answer was served").toBe(0);

    // The poll is still alive (a live game, no realtime ⇒ LIVE_POLL_MS).
    await settle(3_000);
    expect(gets(), "polling never stopped").toBeGreaterThan(g0 + 4);
    expect(screenOf(island)).toBe("live");
    island.unmount();
  });
});

describe("I8: the opponent pill comes from the player's own meeting join — never a server call", () => {
  const LIVE_GAME = {
    gameId: "g1",
    moves: ["e2e4", "e7e5"],
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    lastMove: ["e7", "e5"] as [string, string],
    turn: "white" as const,
    whiteMs: 590_000,
    blackMs: 592_000,
    clockAsOf: new Date(T0).toISOString(),
    clockRunning: false,
    drawOfferBy: null,
    over: false,
  };
  const inPlay = (over: Partial<RoomSnapshot> = {}) =>
    snap({
      you: { colour: "white", name: "Bo Lind", checkedIn: true },
      game: LIVE_GAME,
      opponentPresence: { participantId: "rtk-opp" },
      ...over,
    });
  const presenceOf = (island: Island) => {
    const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
    return propsOf(screen!).presence as boolean | null;
  };
  const roomApiOnly = () => calls.every((c) => c.url.startsWith("/api/v1/fixtures/f1/external-play/room"));

  it("no pill until joined AND settled; live, off when the camera stops, off when the opponent leaves, none with the socket down — and every call the page made is our own room API", async () => {
    getAnswer = () => inPlay();
    seatAnswers = [() => ({ snapshot: inPlay(), seat: { seated: true, participant: PARTICIPANT }, create: null })];
    const meet = meetingCamera();
    join.fn.mockResolvedValue(meet.cam);
    const island = renderIsland(RoomShell, { initial: inPlay(), token: "tok", selfPath: "/x" });
    await settle();
    expect(screenOf(island)).toBe("live");
    expect(join.fn, "the camera joined").toHaveBeenCalledTimes(1);
    expect(presenceOf(island), "the camera is not in the meeting yet").toBeNull();

    meet.set({ joinedAt: Date.now(), peers: [{ userId: "rtk-opp", videoLive: true }] });
    await settle();
    expect(presenceOf(island), "joined, not settled: no pill rather than a guess").toBeNull();
    await settle(PRESENCE_SETTLE_MS);
    expect(presenceOf(island), "settled, the opponent on camera").toBe(true);

    // Producer changes emit nothing in the SDK: the local tick reads them.
    meet.set({ joinedAt: Date.now() - PRESENCE_SETTLE_MS, peers: [{ userId: "rtk-opp", videoLive: false }] });
    await settle(PRESENCE_TICK_MS);
    expect(presenceOf(island), "in the meeting, camera off").toBe(false);
    meet.set({ joinedAt: Date.now() - PRESENCE_SETTLE_MS, peers: [{ userId: "rtk-arbiter", videoLive: true }] });
    await settle(PRESENCE_TICK_MS);
    expect(presenceOf(island), "the opponent left; someone else's camera never counts").toBe(false);
    meet.set(null);
    await settle();
    expect(presenceOf(island), "socket down: no pill").toBeNull();

    expect(calls.length, "anti-vacuity: the room did talk to the server").toBeGreaterThan(1);
    expect(roomApiOnly(), "no call left our own room API").toBe(true);
    island.unmount();
  });

  it("unknown shows no pill: the server says no pill (null), or the camera never joined — whatever the meeting holds", async () => {
    // Server: no pill here (e.g. an override) — even a live opponent shows nothing.
    getAnswer = () => inPlay({ opponentPresence: null });
    seatAnswers = [() => ({ snapshot: inPlay({ opponentPresence: null }), seat: { seated: true, participant: PARTICIPANT }, create: null })];
    const meet = meetingCamera();
    join.fn.mockResolvedValue(meet.cam);
    const a = renderIsland(RoomShell, { initial: inPlay({ opponentPresence: null }), token: "tok", selfPath: "/x" });
    await settle();
    meet.set({ joinedAt: Date.now() - PRESENCE_SETTLE_MS, peers: [{ userId: "rtk-opp", videoLive: true }] });
    await settle(PRESENCE_TICK_MS);
    expect(presenceOf(a)).toBeNull();
    a.unmount();

    // The join failed (camera denied, vendor down): no link, no pill.
    getAnswer = () => inPlay();
    seatAnswers = [() => ({ snapshot: inPlay(), seat: { seated: true, participant: PARTICIPANT }, create: null })];
    join.fn.mockReset();
    join.fn.mockRejectedValue(new Error("vendor down"));
    const b = renderIsland(RoomShell, { initial: inPlay(), token: "tok", selfPath: "/x" });
    await settle(PRESENCE_SETTLE_MS + PRESENCE_TICK_MS);
    expect(join.fn).toHaveBeenCalledTimes(1);
    expect(presenceOf(b)).toBeNull();
    b.unmount();
  });
});
