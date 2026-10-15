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
import { CameraBlockedCard, CameraGaveUpNotice } from "../room-cards";
import { initialRoomState } from "../room-state";
import { RECOVER_BACKOFF_MS, RECOVER_MAX_ATTEMPTS, STAMP_RETRY_MS } from "../camera-session";
import { CAMERA_EVIDENCE_MAX_POLLS, CAMERA_REPORT_HEARTBEAT_MS, cameraEvidenceDelayMs, type RoomSnapshot } from "../room-snapshot";
import type { MeetingLink, OwnCamera } from "../camera-loader";
import { IDLE_POLL_MS, SETTLED_POLL_MS } from "../use-room";

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
    opponentCamera: null,
    // The participant every seat answer here hands back is the one the server holds: a claim's snapshot is composed
    // AFTER its seat (external-play-room.test.ts, R3-1). The R3-1 cases below move it.
    ownParticipantId: "p-own",
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
const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data, requestId: "r" }), { status: 200 });
const PARTICIPANT = { participantId: "p-own", authToken: "own-rtk-token" };
const TRACK = { id: "cam" } as unknown as MediaStreamTrack;

type Call = { method: string; url: string; at: number; body: string | null };
let calls: Call[] = [];
// Thunks: each answer is composed when the server would compose it, so its
// serverNow is later than every earlier read (the reducer drops stale ones).
let seatAnswers: (() => unknown)[] = [];
/** What a GET room answers; the check-in by default. */
// A Response is a refusal by status (fix round 4b).
let getAnswer: () => RoomSnapshot | Response = () => snap();

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
      calls.push({ method: String(init.method), url, at: Date.now(), body: init.body === undefined ? null : String(init.body) });
      // D16: the camera's report for the opponent's pill (room camera-report) - taken, as the server would.
      if (init.method === "POST" && url.includes("/external-play/room/camera-report?")) return ok({ outcome: "written" });
      if (init.method === "POST" && url.startsWith("/api/v1/fixtures/f1/external-play/room?")) {
        // A thunk may answer with a whole Response (a refusal by status, R3-1). A seat call nobody scripted is never
        // answered (it is still counted): a runaway re-claim stops at its first extra call instead of spinning.
        const thunk = seatAnswers.shift();
        if (thunk === undefined) return new Promise<Response>(() => {});
        const answer = thunk();
        return answer instanceof Response ? answer : ok(answer);
      }
      if (init.method === "GET") {
        const a = getAnswer();
        return a instanceof Response ? a : ok(a);
      }
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

  // T17B fix 2 (D2): the seat waits for the camera's own report. `camera_starting` is not a terminal card — the room
  // re-asks on the back-off schedule (D21: cameraEvidenceDelayMs); `camera_blocked` is, and its one action reloads.
  /** What the shell hands the screen: is the room still re-asking a starting camera? (The check-in's own button is
   *  drawn from it — checkin-privacy.test.tsx paints that.) */
  const checkingOf = (island: Island) => {
    const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
    return propsOf(screen!).checkingCamera;
  };
  /** D23-fix: what the shell hands the screen as "the poll budget on camera_starting is spent" (the hand-over's words end on it). */
  const budgetSpentOf = (island: Island) => {
    const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
    return propsOf(screen!).startBudgetSpent;
  };
  const checkInOf = (island: Island) => {
    const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
    return propsOf(screen!).tryAgain as () => void;
  };
  const starting = () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_starting", participant: PARTICIPANT } });

  it("camera_starting: the check-in stays up and says it is checking, the room re-asks on the back-off schedule, and the seat lands", async () => {
    seatAnswers = [
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } }),
      starting,
      starting,
      () => ({
        snapshot: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, creation: { state: "creating" } }),
        seat: { seated: true, participant: PARTICIPANT },
      }),
    ];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle(1_500); // the camera is up: the presence retry asks again …
    expect(seatPosts()).toBe(2);
    expect(screenOf(island), "starting is the check-in, never a card").toBe("checkin");
    expect(checkingOf(island), "the button waits, and says why").toBe(true);
    expect(budgetSpentOf(island), "still inside the budget: nothing spent").toBe(false);
    await settle(cameraEvidenceDelayMs(1) - 1);
    expect(seatPosts(), "not before the first step").toBe(2);
    await settle(1);
    expect(seatPosts(), "… then the room re-asks after the first step").toBe(3);
    await settle(cameraEvidenceDelayMs(2) - 1);
    expect(seatPosts(), "the second wait is the LONGER one: not after another first step").toBe(3);
    await settle(1);
    expect(seatPosts()).toBe(4);
    expect(screenOf(island)).toBe("creating");
    expect(checkingOf(island)).toBe(false);
    await settle(60_000);
    expect(seatPosts(), "seated: the polling stops").toBe(4);
    island.unmount();
  });

  it("camera_starting that never resolves is BOUNDED: CAMERA_EVIDENCE_MAX_POLLS re-asks, then the check-in button is offered again — and pressing it starts a new wait", async () => {
    seatAnswers = [
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } }),
      ...Array.from({ length: 1 + CAMERA_EVIDENCE_MAX_POLLS + 1 }, () => starting),
    ];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle(1_500);
    expect(seatPosts()).toBe(2);
    for (let t = 0; t < 120_000; t += 500) await settle(500);
    expect(seatPosts(), "two claims, then exactly the bound").toBe(2 + CAMERA_EVIDENCE_MAX_POLLS);
    expect(screenOf(island)).toBe("checkin");
    expect(checkingOf(island), "the check-in button is offered again").toBe(false);
    expect(budgetSpentOf(island), "the budget is spent: the hand-over's words have nothing left to wait for").toBe(true);
    checkInOf(island)(); // the check-in's own press (Screen wires onCheckIn to it)
    await settle(0);
    expect(checkingOf(island), "the press starts a fresh wait").toBe(true);
    expect(budgetSpentOf(island), "and a fresh budget").toBe(false);
    await settle(cameraEvidenceDelayMs(1));
    expect(seatPosts(), "the press, then a fresh poll — on the FIRST step again, not the last").toBe(2 + CAMERA_EVIDENCE_MAX_POLLS + 2);
    island.unmount();
  });

  it("D21: the re-asks land on the schedule — 1, 3, 7, 15, 23 seconds after the first camera_starting answer, never a poll a second (counted)", async () => {
    seatAnswers = [
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } }),
      ...Array.from({ length: 1 + CAMERA_EVIDENCE_MAX_POLLS + 1 }, () => starting),
    ];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle(1_500);
    for (let t = 0; t < 120_000; t += 250) await settle(250);
    const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/external-play/room?"));
    expect(posts.length).toBe(2 + CAMERA_EVIDENCE_MAX_POLLS);
    // The first starting answer is the second POST; every re-ask is measured from it.
    const base = posts[1]!.at;
    const offsets = posts.slice(2).map((c) => Math.round((c.at - base) / 250) * 250);
    // Derived from the ruling's table, summed here, never read back from the shell.
    const ruling = [1_000, 2_000, 4_000, 8_000, 8_000];
    let acc = 0;
    const want = ruling.slice(0, CAMERA_EVIDENCE_MAX_POLLS).map((d) => (acc += d));
    expect(offsets).toEqual(want);
    expect(offsets, "the ruling's instants").toEqual([1_000, 3_000, 7_000, 15_000, 23_000]);
    island.unmount();
  });

  it("D21: a camera_starting answer WITHOUT a token (the call budget was spent) leaves the camera joined, keeps polling on the schedule, and the seat still lands", async () => {
    const deferred = () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_starting", participant: null } });
    seatAnswers = [
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } }),
      starting,
      deferred,
      deferred,
      () => ({
        snapshot: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, creation: { state: "creating" } }),
        seat: { seated: true, participant: PARTICIPANT },
      }),
    ];
    const cam = faultingCamera();
    join.fn.mockResolvedValue(cam.cam);
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle(1_500);
    expect(seatPosts()).toBe(2);
    await settle(cameraEvidenceDelayMs(1)); // starting → deferred
    await settle(cameraEvidenceDelayMs(2)); // deferred → deferred
    expect(seatPosts()).toBe(4);
    expect(screenOf(island), "a deferral is the check-in still checking, never a card").toBe("checkin");
    expect(checkingOf(island)).toBe(true);
    expect(cam.left.n, "the camera was NOT taken down by an answer with no token").toBe(0);
    await settle(cameraEvidenceDelayMs(3));
    expect(seatPosts()).toBe(5);
    expect(screenOf(island)).toBe("creating");
    expect(join.fn, "one join for the whole flow: the token was kept, so nothing re-joined").toHaveBeenCalledTimes(1);
    expect(cam.left.n).toBe(0);
    island.unmount();
  });

  it("camera_blocked: the blocked card, whose one action reloads — and the room never re-asks on its own", async () => {
    seatAnswers = [
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } }),
      () => ({ snapshot: snap(), seat: { seated: false, reason: "camera_blocked", participant: PARTICIPANT } }),
    ];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle(1_500);
    expect(seatPosts()).toBe(2);
    expect(screenOf(island)).toBe("cameraBlocked");
    await settle(30_000);
    expect(seatPosts(), "no re-ask: only a reload can cure it").toBe(2);
    expect(join.fn, "the camera stayed joined with the refusal's token").toHaveBeenCalledTimes(1);
    island.unmount();

    // The card's one action is the reload, and its own button is what fires it.
    const onReload = vi.fn();
    const card = renderIsland(CameraBlockedCard, { onReload, t: ((k: string) => k) as never });
    // The card is a StateCard whose `action` slot holds its one button.
    const cards = [...new Set(walk(card.tree()).filter((e) => propsOf(e).testId === "room-state-camera-blocked"))];
    expect(cards).toHaveLength(1);
    const action = propsOf(cards[0]!).action as Parameters<typeof propsOf>[0];
    const buttons = [action, ...walk(action)].filter((e) => typeof propsOf(e).onClick === "function");
    expect([...new Set(buttons)], "one action").toHaveLength(1);
    expect(propsOf(buttons[0]!)["data-testid"]).toBe("room-state-reload");
    (propsOf(buttons[0]!).onClick as () => void)();
    expect(onReload).toHaveBeenCalledTimes(1);
    card.unmount();

    // …and the screen hands the card the page's reload.
    const reload = vi.fn();
    const s0 = snap();
    const state = initialRoomState(s0, T0);
    const noop = async () => null;
    const screen = renderIsland(Screen, {
      screen: { kind: "cameraBlocked" },
      state,
      room: { state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never,
      camera: { status: "live", stream: null, enable: () => {} },
      busy: false,
      tryAgain: () => {},
      relinkHref: "/x",
      locale: "en",
      t: ((k: string) => k) as never,
      plural: ((k: string) => k) as never,
      reload,
    });
    const blocked = [...new Set(walk(screen.tree()).filter((e) => e.type === CameraBlockedCard))];
    expect(blocked).toHaveLength(1);
    expect(propsOf(blocked[0]!).onReload).toBe(reload);
    screen.unmount();
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

  it("T17B fix 2 (D10): re-entry on a board the organiser closed claims nothing and joins no camera — the closed card, polling on", async () => {
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, {
      initial: snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: true }, boardClosed: true }),
      token: "tok",
      selfPath: "/x",
    });
    await settle(1_000);
    expect(screenOf(island)).toBe("boardClosed");
    expect(seatPosts(), "no seat claim on a closed board").toBe(0);
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
    const base = { cameraPolicy: "off" as const, opponentCamera: null, you: { colour: "white" as const, name: "Bo Lind", checkedIn: true }, game: live };
    const actAnswers: (() => Response)[] = [
      () => new Response(JSON.stringify({ ok: false, error: { code: "not_found" } }), { status: 404 }),
      () => ok({ ok: false, reconcile: true, reason: "rejected" }),
      () => ok({ ok: true, applied: true }),
      () => new Response(JSON.stringify({ ok: false, error: { code: "not_found" } }), { status: 404 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ method: String(init.method), url, at: Date.now(), body: init.body === undefined ? null : String(init.body) });
        // D16: the camera's report for the opponent's pill (room camera-report) - taken, as the server would.
        if (init.method === "POST" && url.includes("/external-play/room/camera-report?")) return ok({ outcome: "written" });
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
      opponentCamera: "live",
      ...over,
    });
  const presenceOf = (island: Island) => {
    const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
    return propsOf(screen!).presence as "live" | "off" | "unknown" | null;
  };
  const roomApiOnly = () => calls.every((c) => c.url.startsWith("/api/v1/fixtures/f1/external-play/room"));
  const reports = () =>
    calls
      .filter((c) => c.method === "POST" && c.url.includes("/external-play/room/camera-report?"))
      .map((c) => JSON.parse(c.body!) as { state: string; heartbeat: boolean });

  it("D16: the pill is the snapshot's opponentCamera, on every render - live, off, unknown, none - and every call the page made is our own room API", async () => {
    let checked = 0;
    for (const want of ["live", "off", "unknown", null] as const) {
      getAnswer = () => inPlay({ opponentCamera: want });
      seatAnswers = [() => ({ snapshot: inPlay({ opponentCamera: want }), seat: { seated: true, participant: PARTICIPANT }, create: null })];
      join.fn.mockReset();
      join.fn.mockResolvedValue(liveCamera());
      calls = [];
      const island = renderIsland(RoomShell, { initial: inPlay({ opponentCamera: want }), token: "tok", selfPath: "/x" });
      await settle();
      expect(screenOf(island), String(want)).toBe("live");
      expect(presenceOf(island), `the server said ${String(want)}`).toBe(want);
      expect(calls.length, "anti-vacuity: the room did talk to the server").toBeGreaterThan(0);
      expect(roomApiOnly(), `${String(want)}: no call left our own room API`).toBe(true);
      island.unmount();
      checked += 1;
    }
    expect(checked, "anti-vacuity: every wire value").toBe(4);
  });

  it("the server changing the pill reaches the page on the next read, and dropping it (the game ends) hides it on that very read - never a stale frame", async () => {
    getAnswer = () => inPlay({ opponentCamera: "live" });
    seatAnswers = [() => ({ snapshot: inPlay({ opponentCamera: "live" }), seat: { seated: true, participant: PARTICIPANT }, create: null })];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: inPlay({ opponentCamera: "live" }), token: "tok", selfPath: "/x" });
    await settle();
    expect(presenceOf(island), "premise: the pill is up").toBe("live");
    getAnswer = () => inPlay({ opponentCamera: "unknown" });
    await settle(IDLE_POLL_MS);
    expect(presenceOf(island), "stale report: unknown").toBe("unknown");
    getAnswer = () => inPlay({ opponentCamera: null });
    await settle(IDLE_POLL_MS);
    expect(presenceOf(island), "dropped").toBeNull();
    island.unmount();
  });

  it("cameras off: no pill whatever the snapshot carries (a stale server value never draws one)", async () => {
    getAnswer = () => inPlay({ cameraPolicy: "off", opponentCamera: "live" });
    seatAnswers = [() => ({ snapshot: inPlay({ cameraPolicy: "off", opponentCamera: "live" }), seat: { seated: true, participant: null }, create: null })];
    const island = renderIsland(RoomShell, { initial: inPlay({ cameraPolicy: "off", opponentCamera: "live" }), token: "tok", selfPath: "/x" });
    await settle();
    expect(presenceOf(island)).toBeNull();
    island.unmount();
  });

  it("D16 through the REAL shell, hook, session and request: the camera joins and reports live as a change; a heartbeat every CAMERA_REPORT_HEARTBEAT_MS repeats it; the camera going off reports off", async () => {
    getAnswer = () => inPlay();
    seatAnswers = [() => ({ snapshot: inPlay(), seat: { seated: true, participant: PARTICIPANT }, create: null })];
    let onChange: ((enabled: boolean, track: MediaStreamTrack | null) => void) | null = null;
    join.fn.mockResolvedValue({
      ...liveCamera(),
      onChange(cb: (enabled: boolean, track: MediaStreamTrack | null) => void) {
        onChange = cb;
        return () => void (onChange = null);
      },
    } satisfies OwnCamera);
    const island = renderIsland(RoomShell, { initial: inPlay(), token: "tok", selfPath: "/x" });
    await settle();
    expect(reports(), "joined: one change").toEqual([{ state: "live", heartbeat: false }]);
    await settle(CAMERA_REPORT_HEARTBEAT_MS);
    expect(reports().at(-1), "30 s on: a heartbeat of the same state").toEqual({ state: "live", heartbeat: true });
    const n = reports().length;
    onChange!(false, null);
    await settle();
    expect(reports().slice(n), "the camera went off: a change, not a heartbeat").toEqual([{ state: "off", heartbeat: false }]);
    await settle(CAMERA_REPORT_HEARTBEAT_MS);
    expect(reports().at(-1), "and off stays fresh by heartbeat too").toEqual({ state: "off", heartbeat: true });
    expect(
      calls.filter((c) => c.url.includes("/camera-report?")).every((c) => c.url.includes("t=tok") || c.url.includes("tok")),
      "each report names the caller's link token like every room call",
    ).toBe(true);
    island.unmount();
  });

  it("a seat in no meeting reports nothing: the pill of someone who never joined is the unknown the server says, not a claim from here", async () => {
    getAnswer = () => inPlay();
    seatAnswers = [() => ({ snapshot: inPlay(), seat: { seated: true, participant: null }, create: null })];
    join.fn.mockResolvedValue(liveCamera());
    const island = renderIsland(RoomShell, { initial: inPlay(), token: "tok", selfPath: "/x" });
    await settle(CAMERA_REPORT_HEARTBEAT_MS * 2);
    expect(reports()).toEqual([]);
    island.unmount();
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
        calls.push({ method: String(init.method), url, at: Date.now(), body: init.body === undefined ? null : String(init.body) });
        // D16: the camera's report for the opponent's pill (room camera-report) - taken, as the server would.
        if (init.method === "POST" && url.includes("/external-play/room/camera-report?")) return ok({ outcome: "written" });
        if (init.method === "POST" && url.includes("/external-play/room/camera-fault?")) {
          const body = JSON.parse(String(init.body)) as { state: string };
          stamps.push({ url, body });
          const fail = faultFailures.shift();
          if (fail?.status === 0) throw new TypeError("Failed to fetch");
          if (fail) return new Response(JSON.stringify({ ok: false, error: { code: fail.code ?? "INTERNAL" } }), { status: fail.status });
          return ok({ open: body.state === "start" });
        }
        if (init.method === "POST" && url.startsWith("/api/v1/fixtures/f1/external-play/room?")) return ok(seatAnswers.shift()?.());
        if (init.method === "GET") {
        const a = getAnswer();
        return a instanceof Response ? a : ok(a);
      }
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
    const live = snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentCamera: "live" });
    getAnswer = () => snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentCamera: "live" });
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
    const live = () => snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentCamera: "live" });
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
    const live = snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentCamera: "live" });
    getAnswer = () => snap({ you, game: LIVE_GAME, cameraPolicy: "required", opponentCamera: "live" });
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
      camera: { status: "gave_up", stream: null, enable: () => {} },
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

// Final re-review 3, R3-1: a re-pair's newcomer retires the meeting the player who STAYED is seated in (R2-2), and
// its participants go with it. Their room — open, untouched — must re-claim the seat by itself, once, and move the
// camera to the new meeting. The trigger is the SERVER's word (the snapshot's ownParticipantId), never a guess from
// the camera's own link: a drop or a kick the server did not retire leaves the participant on file.
describe("R3-1: the meeting is retired under a seated player — one quiet re-claim, the camera moves, never a loop", () => {
  const NEW = { participantId: "p-new", authToken: "new-rtk-token" };
  const seatedSnap = (own: string | null, over: Partial<RoomSnapshot> = {}) =>
    snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, ownParticipantId: own, ...over });
  /** A live camera that counts its leaves and can drop its own meeting link (a roomLeft). */
  function trackedCamera() {
    const left = { n: 0 };
    const m = meetingCamera();
    const cam: OwnCamera = { ...m.cam, leave: async () => void (left.n += 1) };
    return { cam, left, drop: () => m.set(null) };
  }
  /** Mount a seated player (the re-entry claim seats them on the meeting `p-own`). */
  async function seatedRoom(first: OwnCamera, ...later: OwnCamera[]) {
    seatAnswers = [() => ({ snapshot: seatedSnap("p-own"), seat: { seated: true, participant: PARTICIPANT } })];
    join.fn.mockReset();
    join.fn.mockResolvedValueOnce(first);
    for (const c of later) join.fn.mockResolvedValueOnce(c);
    getAnswer = () => seatedSnap("p-own");
    const island = renderIsland(RoomShell, { initial: seatedSnap("p-own"), token: "tok", selfPath: "/x" });
    await settle();
    expect(join.fn.mock.calls, "premise — seated, the camera in the first meeting").toEqual([["own-rtk-token"]]);
    expect(seatPosts(), "premise — the re-entry claim only").toBe(1);
    return island;
  }

  it("retired ⇒ ONE quiet re-claim on the next read; its token moves the camera to the new meeting (old one left); seated again on the camera-up retry — never card 2, and nothing more after", async () => {
    const old = trackedCamera();
    const fresh = trackedCamera();
    const island = await seatedRoom(old.cam, fresh.cam);
    await settle(IDLE_POLL_MS);
    expect(seatPosts(), "a read that finds the participant in place asks nothing").toBe(1);

    seatAnswers = [
      () => ({ snapshot: seatedSnap("p-new"), seat: { seated: false, reason: "camera_required", participant: NEW } }),
      () => ({ snapshot: seatedSnap("p-new"), seat: { seated: true, participant: NEW } }),
    ];
    getAnswer = () => seatedSnap(null); // the newcomer's seat retired the meeting
    await settle(IDLE_POLL_MS);
    await settle();
    expect(seatPosts(), "one quiet re-claim").toBe(2);
    expect(join.fn.mock.calls, "the camera joined the NEW meeting with the re-claim's token").toEqual([["own-rtk-token"], ["new-rtk-token"]]);
    expect(old.left.n, "the retired meeting is left").toBe(1);
    expect(screenOf(island), "the camera settling: the check-in, never card 2").toBe("checkin");

    getAnswer = () => seatedSnap("p-new");
    await settle(1_500);
    expect(seatPosts(), "the camera-up retry takes the seat").toBe(3);
    expect(screenOf(island)).toBe("checkin");
    for (let i = 0; i < 3; i += 1) await settle(IDLE_POLL_MS);
    expect(seatPosts(), "in place again: nothing more").toBe(3);
    expect(join.fn).toHaveBeenCalledTimes(2);
    island.unmount();
  });

  it("a drop or a kick the server did not retire — the camera's own link gone, the participant still on file — never re-claims; nor does the sweep's end of the meeting (same participant)", async () => {
    const cam = trackedCamera();
    const island = await seatedRoom(cam.cam);
    cam.drop(); // roomLeft: a socket drop, a media-node drop, an arbiter's kick — the client cannot tell them apart
    for (let i = 0; i < 3; i += 1) await settle(IDLE_POLL_MS);
    expect(cam.left.n, "a drop is not a leave").toBe(0);
    getAnswer = () => seatedSnap("p-own", { phase: "closed" }); // the sweep ended the meeting: its row and participant stay
    for (let i = 0; i < 2; i += 1) await settle(IDLE_POLL_MS);
    expect(seatPosts(), "no re-claim").toBe(1);
    expect(join.fn, "no re-join").toHaveBeenCalledTimes(1);
    // T17B fix 2 (D8a): the closed card is where the camera ends — left once, and never joined again.
    expect(cam.left.n).toBe(1);
    island.unmount();
  });

  it("a refused re-claim is never a loop: a 409 (VIDEO_MEETING_PAIRING_CHANGED) leaves the server's answer as it was and nothing is asked again; a CHANGED answer (the new meeting minted) asks once more; a refusal with no token stops for good", async () => {
    const cam = trackedCamera();
    const island = await seatedRoom(cam.cam);
    const refused = () =>
      new Response(JSON.stringify({ ok: false, error: { code: "VIDEO_MEETING_PAIRING_CHANGED", message: "x" }, requestId: "r" }), { status: 409 });
    seatAnswers = [refused];
    getAnswer = () => seatedSnap(null);
    for (let i = 0; i < 4; i += 1) await settle(IDLE_POLL_MS);
    expect(seatPosts(), "one re-claim, refused — then nothing, read after read").toBe(2);
    expect(join.fn).toHaveBeenCalledTimes(1);

    // The server's answer changes (the new meeting minted a participant): one more re-claim — and this one is refused
    // with no token (the video service is down): the existing card, and the room stops asking.
    seatAnswers = [() => ({ snapshot: seatedSnap("p-new"), seat: { seated: false, reason: "video_unavailable", participant: null } })];
    getAnswer = () => seatedSnap("p-new");
    await settle(IDLE_POLL_MS);
    await settle();
    expect(seatPosts(), "a changed answer asks once more").toBe(3);
    expect(screenOf(island), "the existing state copy").toBe("videoDown");
    for (let i = 0; i < 4; i += 1) await settle(IDLE_POLL_MS);
    expect(seatPosts(), "and stops").toBe(3);
    expect(join.fn).toHaveBeenCalledTimes(1);
    island.unmount();
  });

  it("the retry budget is per participant: a seat that took all three camera-up retries still gets three in the new meeting", async () => {
    const old = trackedCamera();
    const fresh = trackedCamera();
    join.fn.mockReset();
    join.fn.mockResolvedValueOnce(old.cam).mockResolvedValueOnce(fresh.cam);
    const refusal = (p: typeof PARTICIPANT, own: string) => () => ({
      snapshot: seatedSnap(own),
      seat: { seated: false, reason: "camera_required", participant: p },
    });
    // Check in, then three retries — seated on the last.
    seatAnswers = [
      refusal(PARTICIPANT, "p-own"),
      refusal(PARTICIPANT, "p-own"),
      refusal(PARTICIPANT, "p-own"),
      () => ({ snapshot: seatedSnap("p-own"), seat: { seated: true, participant: PARTICIPANT } }),
    ];
    getAnswer = () => seatedSnap("p-own");
    const island = renderIsland(RoomShell, { initial: snap({ ownParticipantId: null }), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle();
    for (let i = 0; i < 3; i += 1) await settle(1_500);
    expect(seatPosts(), "premise — check-in + all three retries").toBe(4);
    expect(screenOf(island), "premise — seated").toBe("checkin");

    // What the server holds, as its answers would say it: retired (none), then the re-claim mints the new one.
    let onFile: string | null = null;
    getAnswer = () => seatedSnap(onFile);
    seatAnswers = [
      () => {
        onFile = "p-new";
        return refusal(NEW, "p-new")();
      },
      () => ({ snapshot: seatedSnap("p-new"), seat: { seated: true, participant: NEW } }),
    ];
    await settle(IDLE_POLL_MS);
    await settle(1_500);
    expect(join.fn.mock.calls, "the camera moved to the new meeting").toEqual([["own-rtk-token"], ["new-rtk-token"]]);
    expect(seatPosts(), "the quiet re-claim, then the new meeting's own camera-up retry").toBe(6);
    expect(screenOf(island), "seated again, never card 2").toBe("checkin");
    for (let i = 0; i < 2; i += 1) await settle(IDLE_POLL_MS);
    expect(seatPosts(), "and nothing more").toBe(6);
    island.unmount();
  });
});

// Fix round 4b, through the real transport: while the organiser re-pairs the round, GET room answers the server's 409
// ROOM_BEING_REPAIRED (external-play-room.test.ts pins who is told). A real gap lasts minutes — many polls.
describe("fix round 4b: the room reads on through a re-pair, and stops only on a refusal", () => {
  const refusal = (status: number, code: string) => () =>
    new Response(JSON.stringify({ ok: false, error: { code, message: "x" }, requestId: "r" }), { status });
  const gets = () => calls.filter((c) => c.method === "GET").length;
  const checkedIn = () => snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true } });

  it("a gap longer than one poll: every read in it is 'being re-paired', the card replaces the stale board, the room keeps its cadence; the re-paired board's read is the check-in again", async () => {
    getAnswer = checkedIn;
    const island = renderIsland(RoomShell, { initial: checkedIn(), token: "tok", selfPath: "/x" });
    await settle();
    expect(screenOf(island), "premise — checked in").toBe("checkin");
    const before = gets();
    getAnswer = refusal(409, "ROOM_BEING_REPAIRED");
    for (let i = 0; i < 3; i += 1) await settle(IDLE_POLL_MS);
    expect(gets() - before, "three idle polls, all inside the gap").toBe(3);
    expect(screenOf(island), "told, in place of the old pairing").toBe("repairing");
    getAnswer = checkedIn;
    await settle(IDLE_POLL_MS);
    expect(gets() - before, "and the next").toBe(4);
    expect(screenOf(island), "re-paired: the room again").toBe("checkin");
    island.unmount();
  });

  it("a check-in sent into the gap is answered the same way: the card at once, and the room reads on to the re-paired board", async () => {
    getAnswer = () => snap();
    const island = renderIsland(RoomShell, { initial: snap(), token: "tok", selfPath: "/x" });
    await settle();
    seatAnswers = [refusal(409, "ROOM_BEING_REPAIRED")];
    getAnswer = refusal(409, "ROOM_BEING_REPAIRED");
    await roomOf(island).claim();
    await settle();
    expect(seatPosts(), "premise — the check-in went").toBe(1);
    expect(screenOf(island), "the seat's own answer: the card, before any read").toBe("repairing");
    const before = gets();
    await settle(IDLE_POLL_MS);
    expect(gets() - before, "never a stop: the next poll goes").toBe(1);
    getAnswer = () => snap();
    await settle(IDLE_POLL_MS);
    expect(screenOf(island), "re-paired: the check-in to send again").toBe("checkin");
    island.unmount();
  });

  it("a refusal stops it for good — the room's 404 (not theirs, a link refused, a board gone), a 401, a 403 — on the 'not available' card", async () => {
    let checked = 0;
    for (const [status, code] of [
      [404, "NOT_FOUND"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
    ] as const) {
      getAnswer = checkedIn;
      const island = renderIsland(RoomShell, { initial: checkedIn(), token: "tok", selfPath: "/x" });
      await settle();
      getAnswer = refusal(status, code);
      await settle(IDLE_POLL_MS);
      const stoppedAt = gets();
      for (let i = 0; i < 3; i += 1) await settle(IDLE_POLL_MS);
      expect(gets(), `${status}: no read after it`).toBe(stoppedAt);
      expect(screenOf(island), `${status}`).toBe("unavailable");
      island.unmount();
      checked += 1;
    }
    expect(checked, "anti-vacuity: refusals").toBe(3);
  });
});

// T17B fix 2 (D8a), measured on stg: after the checkmate both cameras kept publishing (white 45 → 71.6 MB) until the
// sweep's teardown six minutes later, with no <video> on the page. Ruling: when the room reaches a closed or result
// phase the client leaves the meeting at once (its leave stops every local track: camera-loader.test.ts). The other
// direction too — a board that comes back (a voided result, re-paired) gets its camera back.
describe("the game ends: the camera leaves at once (T17B fix 2, D8a)", () => {
  const GAME_ON = {
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
  const RESULT = { outcome: "won" as const, method: "mate" as const, score: "1–0" };
  const inPlay = (over: Partial<RoomSnapshot> = {}) =>
    snap({ you: { colour: "white", name: "Bo Lind", checkedIn: true }, game: GAME_ON, opponentCamera: "live", ...over });
  const counted = () => {
    const left = { n: 0 };
    return { left, cam: { ...liveCamera(), leave: async () => void (left.n += 1) } satisfies OwnCamera };
  };

  it("a live board whose result lands leaves the meeting once — and no later poll, nor the unmount, joins or leaves again", async () => {
    getAnswer = () => inPlay();
    seatAnswers = [() => ({ snapshot: inPlay(), seat: { seated: true, participant: PARTICIPANT }, create: null })];
    const { left, cam } = counted();
    join.fn.mockResolvedValue(cam);
    const island = renderIsland(RoomShell, { initial: inPlay(), token: "tok", selfPath: "/x" });
    await settle();
    expect(screenOf(island)).toBe("live");
    expect(join.fn, "premise: the camera joined").toHaveBeenCalledTimes(1);
    expect(left.n, "premise: nothing left yet").toBe(0);

    getAnswer = () => inPlay({ game: { ...GAME_ON, over: true }, result: RESULT });
    await settle(IDLE_POLL_MS);
    expect(screenOf(island)).toBe("over");
    expect(left.n, "left at the result").toBe(1);

    for (let i = 0; i < 3; i += 1) await settle(IDLE_POLL_MS);
    expect([join.fn.mock.calls.length, left.n], "nothing joins after the result, and nothing leaves twice").toEqual([1, 1]);
    expect(seatPosts(), "no seat is asked after the result").toBe(1);
    island.unmount();
    expect(left.n, "the unmount has nothing left to leave").toBe(1);
  });

  it("the window closing with no game leaves too (card 6) — the closed phase, not only a result", async () => {
    const open = () => snap({ you: { colour: "white", name: "Bo Lind", checkedIn: false } });
    getAnswer = () => open();
    seatAnswers = [() => ({ snapshot: open(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } })];
    const { left, cam } = counted();
    join.fn.mockResolvedValue(cam);
    const island = renderIsland(RoomShell, { initial: open(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle();
    expect(join.fn, "premise: the camera joined for the check-in").toHaveBeenCalledTimes(1);
    getAnswer = () => snap({ phase: "closed" });
    await settle(IDLE_POLL_MS);
    expect(screenOf(island)).toBe("closed");
    expect(left.n).toBe(1);
    island.unmount();
  });

  // A board seen over stays over on this page (room-state mergeSnapshot keeps the game on file), so a result's way
  // back is a reload — a fresh mount, a fresh camera. The way back that IS reachable in-page: a hold with no game.
  it("the other direction: a hold with no game (card 6) leaves; when it lifts, the check-in gets a fresh camera", async () => {
    const open = () => snap({ you: { colour: "white", name: "Bo Lind", checkedIn: false }, opponentCamera: "live" });
    getAnswer = () => open();
    seatAnswers = [() => ({ snapshot: open(), seat: { seated: false, reason: "camera_required", participant: PARTICIPANT } })];
    const first = counted();
    const second = meetingCamera();
    join.fn.mockResolvedValueOnce(first.cam).mockResolvedValueOnce(second.cam);
    const island = renderIsland(RoomShell, { initial: open(), token: "tok", selfPath: "/x" });
    await roomOf(island).claim();
    await settle();
    expect(join.fn, "premise: joined for the check-in").toHaveBeenCalledTimes(1);

    getAnswer = () => snap({ held: true, canAct: false, opponentCamera: "live" });
    await settle(IDLE_POLL_MS);
    expect([screenOf(island), first.left.n], "held with no game: card 6, and left").toEqual(["closed", 1]);

    getAnswer = () => open();
    await settle(IDLE_POLL_MS);
    expect(screenOf(island), "the hold lifted").toBe("checkin");
    // Back where it was before the hold: the camera re-joins with the seat's own token, at once.
    expect(join.fn.mock.calls, "a fresh join").toEqual([["own-rtk-token"], ["own-rtk-token"]]);
    // D16: the pill is the server's word on the opponent's own report, so it follows the snapshot, not a meeting.
    const screen = walk(island.tree()).find((e) => propsOf(e).room !== undefined && propsOf(e).screen !== undefined);
    expect(propsOf(screen!).presence, "the pill reads the snapshot").toBe("live");
    void second;
    island.unmount();
  });
});

// T17B fix 2, D10b (controller ruling): a room that has shown a result kept it for good — it stopped reading — so the
// organiser's void (or a re-arm) never reached an open tab until a reload. A settled room reads on, slowly, and at once
// when its tab comes back into view.
describe("D10b: a settled room keeps a slow read — a void reaches an open tab without a reload", () => {
  const NO_RESULT = { outcome: "no_result" as const, method: null, score: "" };
  const settledRoom = () =>
    renderIsland(RoomShell, {
      initial: snap({ cameraPolicy: "off", you: { colour: "white", name: "Bo Lind", checkedIn: true }, result: NO_RESULT }),
      token: "tok",
      selfPath: "/x",
    });
  const gets = () => calls.filter((c) => c.method === "GET").length;

  it("the slow poll: nothing before SETTLED_POLL_MS, then a read — and the void it reads shows the closed board", async () => {
    getAnswer = () => snap({ cameraPolicy: "off", you: { colour: "white", name: "Bo Lind", checkedIn: true }, boardClosed: true });
    const island = settledRoom();
    await settle();
    expect(screenOf(island), "premise: the result card").toBe("over");
    await settle(SETTLED_POLL_MS - 1);
    expect(gets(), "slow: not at the idle cadence").toBe(0);
    await settle(1);
    expect(gets()).toBe(1);
    expect(screenOf(island), "the void reached the open tab").toBe("boardClosed");
    expect(SETTLED_POLL_MS, "slower than the idle poll").toBeGreaterThan(IDLE_POLL_MS);
    island.unmount();
  });

  it("the tab coming back into view reads at once; a hidden tab does not", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden", cookie: "" });
    vi.stubGlobal("document", doc);
    const island = settledRoom();
    await settle();
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(gets(), "hidden: nothing").toBe(0);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(gets(), "visible: one read").toBe(1);
    island.unmount();
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(gets(), "unmounted: the listener is gone").toBe(1);
  });
});
