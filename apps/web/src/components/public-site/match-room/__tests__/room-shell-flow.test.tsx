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
vi.mock("../camera-loader", async (actual) => ({
  ...(await actual<typeof import("../camera-loader")>()),
  joinOwnCamera: (token: string) => join.fn(token),
}));

import { RoomShell, Screen } from "../room-shell";
import { CameraGaveUpNotice } from "../room-cards";
import { initialRoomState } from "../room-state";
import { RECOVER_BACKOFF_MS, RECOVER_MAX_ATTEMPTS, STAMP_RETRY_MS } from "../camera-session";
import type { RoomSnapshot } from "../room-snapshot";
import type { MeetingLink, OwnCamera } from "../camera-loader";
import { PRESENCE_SETTLE_MS, PRESENCE_TICK_MS } from "../opponent-presence";
import { useOpponentPresence } from "../use-own-camera";

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
    otherAccount: false,
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
    onFault: () => () => {},
  };
}
/** A live camera whose guard the test can make fail closed (I-1). */
function faultingCamera() {
  let listener: (() => void) | null = null;
  const left = { n: 0 };
  const cam: OwnCamera = {
    ...liveCamera(),
    leave: async () => void (left.n += 1),
    onFault(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return { cam, left, fault: () => listener?.() };
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
    /** A producer change: the SDK emits nothing for it (review I8). */
    setSilently(l: MeetingLink | null) {
      current = l;
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
    meet.setSilently({ joinedAt: Date.now() - PRESENCE_SETTLE_MS, peers: [{ userId: "rtk-opp", videoLive: false }] });
    expect(presenceOf(island), "premise: nothing re-read yet").toBe(true);
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

  it("the server dropping the pill (the game ends) hides it on that very render — never one stale frame of the old answer", async () => {
    const live: MeetingLink = { joinedAt: Date.now() - PRESENCE_SETTLE_MS, peers: [{ userId: "rtk-opp", videoLive: true }] };
    const camera = { link: () => live, onLinkChange: () => () => {} };
    const seen: (boolean | null)[] = [];
    function Probe({ opponent }: { opponent: RoomSnapshot["opponentPresence"] }) {
      seen.push(useOpponentPresence(camera, opponent));
      return null;
    }
    const island = renderIsland<{ opponent: RoomSnapshot["opponentPresence"] }>(Probe, { opponent: { participantId: "rtk-opp" } });
    await settle();
    expect(seen.at(-1), "premise: the pill is up").toBe(true);
    const from = seen.length;
    island.rerender({ opponent: null });
    await settle();
    const after = seen.slice(from);
    expect(after.length, "anti-vacuity: renders after the drop").toBeGreaterThan(0);
    expect(after, "every render after the drop").toEqual(after.map(() => null));
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

// T14 re-review 3, I-1 (controller ruling 2026-10-12), through the REAL shell,
// hook and session: our guard fails closed → the player sees OUR notice, the
// stamp goes to the server with their own seat, the camera re-joins with
// their own token, and the stamp closes.
describe("I-1: our guard's fault, through the real shell — stamped, re-joined, never blamed", () => {
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
  const you = { colour: "white" as const, name: "Bo Lind", checkedIn: true };
  let stamps: { url: string; body: unknown }[] = [];
  /** The camera-fault answers to fail, in order: 0 ⇒ the network is down. */
  let faultFailures: { status: number; code?: string }[] = [];
  function stubFetch() {
    stamps = [];
    faultFailures = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ method: String(init.method), url });
        if (init.method === "POST" && url.includes("/external-play/room/camera-fault?")) {
          const body = JSON.parse(String(init.body)) as { state: string };
          stamps.push({ url, body });
          const fail = faultFailures.shift();
          if (fail?.status === 0) throw new TypeError("Failed to fetch");
          if (fail) return new Response(JSON.stringify({ ok: false, error: { code: fail.code ?? "INTERNAL" } }), { status: fail.status });
          return ok({ open: body.state === "start" });
        }
        if (init.method === "POST" && url.startsWith("/api/v1/fixtures/f1/external-play/room?")) return ok(seatAnswers.shift()?.());
        if (init.method === "GET") return ok(getAnswer());
        return new Response("{}", { status: 500 });
      }),
    );
  }
  /** What the Screen is handed — the shell's own tree stops at it; the
   *  notice-vs-banner render for each status is room-shell.test.tsx's. */
  const cameraStatus = (island: Island) => {
    const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
    return (propsOf(screen!).camera as { status: string }).status;
  };

  it("live game: recovering (the notice, never the camera-off banner) → the stamp opens on OUR seat → a fresh join with our token → live, the stamp closes", async () => {
    stubFetch();
    const live = snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } });
    getAnswer = () => snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } });
    seatAnswers = [() => ({ snapshot: getAnswer(), seat: { seated: true, participant: PARTICIPANT } })];
    const first = faultingCamera();
    join.fn.mockResolvedValueOnce(first.cam).mockResolvedValueOnce(liveCamera());
    const island = renderIsland(RoomShell, { initial: live, token: "tok", selfPath: "/x" });
    await settle();
    expect(join.fn.mock.calls, "premise: the re-entry claim joined the camera").toEqual([["own-rtk-token"]]);
    expect(screenOf(island)).toBe("live");
    expect(cameraStatus(island), "premise: live").toBe("live");

    first.fault();
    await Promise.resolve();
    expect(cameraStatus(island), "ours, said so: recovering — never off or failed").toBe("recovering");
    expect(stamps.map((x) => x.body), "the stamp opened on OUR seat, by id").toEqual([{ state: "start", participantId: "p-own" }]);
    expect(stamps[0]!.url, "with the personal link").toContain("t=tok");

    await settle();
    expect(first.left.n, "the old camera's leave was awaited").toBe(1);
    expect(join.fn.mock.calls, "a fresh join with the seat's own token").toEqual([["own-rtk-token"], ["own-rtk-token"]]);
    expect(stamps.map((x) => (x.body as { state: string }).state)).toEqual(["start", "end"]);
    expect(cameraStatus(island), "back").toBe("live");
    expect(screenOf(island)).toBe("live");
    island.unmount();
  });

  // T14 fix round 6, M-3: through the REAL shell → session → room-api: a
  // stamp the server did not take is sent again on the ladder; a final 4xx
  // (the cap's 429) is not.
  it("a stamp the server did not take (a 503, then the network down) is re-sent on the ladder until it lands, and the end waits behind it; the cap's 429 is final — sent once", async () => {
    const live = () => snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } });
    let checked = 0;
    for (const c of [
      { failures: [{ status: 503 }, { status: 0 }], states: ["start", "start", "start", "end"] },
      { failures: [{ status: 429, code: "CAMERA_FAULT_CAP_REACHED" }], states: ["start", "end"] },
    ]) {
      stubFetch();
      faultFailures = [...c.failures];
      getAnswer = live;
      seatAnswers = [() => ({ snapshot: getAnswer(), seat: { seated: true, participant: PARTICIPANT } })];
      const first = faultingCamera();
      join.fn.mockReset();
      join.fn.mockResolvedValueOnce(first.cam).mockResolvedValueOnce(liveCamera());
      const island = renderIsland(RoomShell, { initial: live(), token: "tok", selfPath: "/x" });
      await settle();
      expect(cameraStatus(island), "premise: live").toBe("live");
      first.fault();
      await settle();
      expect(cameraStatus(island), "premise: back at once").toBe("live");
      await settle(STAMP_RETRY_MS.reduce((a, b) => a + b, 0) + 1_000);
      expect(stamps.map((x) => (x.body as { state: string }).state), JSON.stringify(c.failures)).toEqual(c.states);
      expect(faultFailures, "every scripted failure was met").toEqual([]);
      island.unmount();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("on the check-in (refused for camera, camera up): a fault keeps the player on the check-in — never the camera-required card — and the seat is re-asked once back", async () => {
    stubFetch();
    seatAnswers = [
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } }),
      () => ({ snapshot: snap({ you, creation: { state: "creating" } }), seat: { seated: true, participant: PARTICIPANT } }),
    ];
    const first = faultingCamera();
    let release!: (c: OwnCamera) => void;
    join.fn.mockResolvedValueOnce(first.cam).mockReturnValueOnce(new Promise<OwnCamera>((r) => (release = r)));
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle();
    expect(screenOf(island), "premise: camera up, re-claim pending").toBe("checkin");
    first.fault();
    await settle(10_000);
    expect(join.fn, "premise: the re-join is in flight").toHaveBeenCalledTimes(2);
    expect(screenOf(island), "ours: still the check-in, not card 2").toBe("checkin");
    expect(seatPosts(), "no re-claim while the camera is away").toBe(1);
    release(liveCamera());
    await settle(1_500);
    expect(seatPosts(), "back: the seat is asked again").toBe(2);
    expect(screenOf(island)).toBe("creating");
    island.unmount();
  });
  // T14 fix round 5, ruling 2: the re-join keeps failing (a network error,
  // not our guard) → after RECOVER_MAX_ATTEMPTS the camera gives up and the
  // player is told to reload — and the Reload reloads. Fix round 6, I-2: the
  // stamp stays open through the give-up; the reload's re-seat closes it.
  it("re-joins that keep failing GIVE UP: the stamp opens and STAYS open (fix round 6, I-2), the status is gave_up (never off or failed), nothing joins after", async () => {
    stubFetch();
    const live = snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } });
    getAnswer = () => snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentPresence: { participantId: "rtk-opp" } });
    seatAnswers = [() => ({ snapshot: getAnswer(), seat: { seated: true, participant: PARTICIPANT } })];
    const first = faultingCamera();
    join.fn.mockResolvedValueOnce(first.cam).mockRejectedValue(new Error("network: join timed out"));
    const island = renderIsland(RoomShell, { initial: live, token: "tok", selfPath: "/x" });
    await settle();
    expect(cameraStatus(island), "premise: live").toBe("live");
    first.fault();
    await settle();
    expect(cameraStatus(island)).toBe("recovering");
    const total = Array.from({ length: RECOVER_MAX_ATTEMPTS }, (_, i): number => RECOVER_BACKOFF_MS[Math.min(i, RECOVER_BACKOFF_MS.length - 1)]!).reduce((a, b) => a + b, 0);
    await settle(total - 1);
    expect(cameraStatus(island), "a moment before the last wait ends: still trying").toBe("recovering");
    await settle(1_000);
    expect(cameraStatus(island), "out of attempts: told to reload").toBe("gave_up");
    expect(join.fn, "the first join, then exactly N re-joins").toHaveBeenCalledTimes(1 + RECOVER_MAX_ATTEMPTS);
    expect(stamps.map((x) => (x.body as { state: string }).state), "our window, left open: the reload's re-seat closes it").toEqual(["start"]);
    expect(stamps.map((x) => (x.body as { participantId: string }).participantId)).toEqual(["p-own"]);
    await settle(60_000);
    expect(join.fn, "given up: nothing joins by itself").toHaveBeenCalledTimes(1 + RECOVER_MAX_ATTEMPTS);
    expect(screenOf(island)).toBe("live");
    island.unmount();
    await settle();
    expect(stamps.map((x) => (x.body as { state: string }).state), "the unmount sends no end either").toEqual(["start"]);
  });

  it("on a refused check-in, a camera that gave up keeps the player on the check-in — never the camera-required card", async () => {
    stubFetch();
    seatAnswers = [() => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } })];
    const first = faultingCamera();
    join.fn.mockResolvedValueOnce(first.cam).mockRejectedValue(new Error("network"));
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle();
    first.fault();
    await settle(120_000);
    expect(cameraStatus(island), "premise: given up").toBe("gave_up");
    expect(screenOf(island), "ours: the check-in, with the notice — not card 2").toBe("checkin");
    island.unmount();
  });

  it("the Reload reloads the page (the fresh page's join is the way back)", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const s0 = snap({ you, game: LIVE_GAME, cameraPolicy: "required" });
    const state = initialRoomState(s0, T0);
    const noop = async () => null;
    const island = renderIsland(Screen, {
      screen: { kind: "live" },
      state,
      room: { state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never,
      camera: { status: "gave_up", stream: null, enable: () => {}, link: () => null, onLinkChange: () => () => {} },
      busy: false,
      tryAgain: () => {},
      relinkHref: "/x",
      locale: "en",
      t: ((k: string) => k) as never,
      plural: ((k: string) => k) as never,
    });
    // The harness's walk can meet one element more than once: count elements, not visits.
    const notices = [...new Set(walk(island.tree()).filter((e) => typeof propsOf(e).onReload === "function"))];
    expect(notices, "one give-up notice, with its reload").toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    (propsOf(notices[0]!).onReload as () => void)();
    expect(reload).toHaveBeenCalledTimes(1);
    island.unmount();

    // …and the notice's own button is what fires it.
    const onReload = vi.fn();
    const card = renderIsland(CameraGaveUpNotice, { onReload, t: ((k: string) => k) as never });
    const buttons = [...new Set(walk(card.tree()).filter((e) => propsOf(e)["data-testid"] === "room-camera-reload"))];
    expect(buttons).toHaveLength(1);
    (propsOf(buttons[0]!).onClick as () => void)();
    expect(onReload).toHaveBeenCalledTimes(1);
    card.unmount();
  });
});
