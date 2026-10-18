// Capacity tests 30, 31 and 34, the client half (spec §5.7.9, §6.1 (3), §8.1): the REAL useRoom (real reducer, real effects
// under the repo's hook harness) with fetch stubbed at the boundary and the clock faked, reading WHEN each seat POST went out.
//
//   - the queued claim loop: one claim per `pollMs` (never under the floor), with no upper bound, and at once when the tab
//     comes back into view - and not once the answer stops being `queued`;
//   - a 429 received while the card shows the line starts NO countdown and the loop goes on at its normal cadence (test 31);
//   - a 429 anywhere else starts the seat wait: disabled for exactly Retry-After seconds on the MONOTONIC clock, no request
//     sent meanwhile, a second 429 restarts it, and a bad header counts as 60 (test 34).
//
// The seat door and the line door are one URL to the browser (the server picks the door from the caller's own stay), so one
// stub covers both. What a real browser paints is match-room.spec.ts's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { LINE_POLL_MIN_MS, LINE_POLL_MS, CAMERA_EVIDENCE_MAX_POLLS, SEAT_ASK_WINDOW_S, type LineWire, type RoomSnapshot } from "../room-snapshot";
import { useRoom } from "../use-room";
import { useSeatWait } from "../seat-wait";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
function snap(): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: new Date(T0).toISOString(),
    opensAt: new Date(T0).toISOString(),
    deadline: new Date(T0 + 10 * 60_000).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 1, limitSeconds: 300, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Bo Lind", checkedIn: false },
    opponent: { colour: "black", name: "Ada Okonkwo", checkedIn: false },
    cameraPolicy: "required",
    opponentCamera: null,
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
  void room;
  return null;
}
function Probe({ snap: s }: { snap: RoomSnapshot }) {
  return <Slot room={useRoom(s, "tok")} />;
}
type Island = ReturnType<typeof renderIsland<{ snap: RoomSnapshot }>>;
const roomOf = (island: Island): Room => {
  const slot = island.tree().find((el) => el.type === Slot);
  if (!slot) throw new Error("the probe rendered no slot");
  return propsOf(slot).room as Room;
};

const wire = (over: Partial<LineWire> | Record<string, unknown> = {}): LineWire => ({
  position: 4,
  etaS: 40,
  pollMs: LINE_POLL_MS,
  closesAt: new Date(T0 + 12 * 60_000).toISOString(),
  mayTimeOut: false,
  left: null,
  ...over,
}) as LineWire;
const QUEUED = (over: Partial<LineWire> | Record<string, unknown> = {}) => ({ seated: false, reason: "queued", participant: null, line: wire(over) });
const STARTING = { seated: false, reason: "camera_starting", participant: null };

type Reply = { status?: number; retryAfter?: string; seat?: unknown; line?: unknown };
let p0 = 0;
/** The offsets (ms on the monotonic clock, from the start of the test) at which a seat POST went out. The script's last reply repeats. */
function stubServer(script: Reply[]): number[] {
  const posts: number[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ ok: true, data: snap(), requestId: "t" }), { status: 200 });
    }
    const r = script[Math.min(posts.length, script.length - 1)]!;
    posts.push(Math.round(performance.now() - p0));
    if (r.status !== undefined && r.status !== 200) {
      return new Response(JSON.stringify({ ok: false, error: { code: "RATE_LIMITED" }, requestId: "t" }), {
        status: r.status,
        headers: r.retryAfter === undefined ? {} : { "retry-after": r.retryAfter },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: { snapshot: snap(), seat: r.seat ?? null, create: null }, requestId: "t" }), { status: 200 });
  });
  return posts;
}

/** A document the room can listen on: `fire` runs the visibilitychange listeners with the given state. */
function stubDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: (type: string, fn: () => void) => {
      if (type === "visibilitychange") listeners.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === "visibilitychange") listeners.delete(fn);
    },
  };
  vi.stubGlobal("document", doc);
  return {
    fire: (state: "visible" | "hidden") => {
      doc.visibilityState = state;
      for (const fn of [...listeners]) fn();
    },
    count: () => listeners.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  p0 = performance.now();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the fake clock under these tests is a real witness (anti-vacuity)", () => {
  it("performance.now() advances with the fake timers and does NOT follow a change of the system clock", async () => {
    const a = performance.now();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(performance.now() - a).toBe(5_000);
    vi.setSystemTime(T0 + 3_600_000);
    expect(performance.now() - a, "an hour on Date.now() is not an hour on the monotonic clock").toBe(5_000);
  });
});

describe("useRoom - the queued claim loop (spec §5.7.9, test 30)", () => {
  it("claims again after pollMs - not a millisecond before - and goes on with NO upper bound (past CAMERA_EVIDENCE_MAX_POLLS)", async () => {
    const posts = stubServer([{ seat: QUEUED({ pollMs: 3_000 }) }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    expect(posts.length, "the first claim").toBe(1);
    await vi.advanceTimersByTimeAsync(3_000 - 1);
    expect(posts.length, "1 ms before pollMs: nothing").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(posts.length, "AT pollMs: the second claim").toBe(2);
    const gaps = () => posts.slice(1).map((p, i) => p - posts[i]!);
    const MORE = CAMERA_EVIDENCE_MAX_POLLS + 20;
    for (let i = 0; i < MORE; i++) await vi.advanceTimersByTimeAsync(3_000);
    expect(posts.length, "claims made well past the camera_starting bound").toBe(2 + MORE);
    expect(MORE, "premise: the loop outlasted the bound that does not apply").toBeGreaterThan(CAMERA_EVIDENCE_MAX_POLLS);
    expect(new Set(gaps()), "every claim exactly pollMs after the last answer").toEqual(new Set([3_000]));
    expect(roomOf(island).state.seat, "still in line").toMatchObject({ reason: "queued" });
  });

  it("a hostile pollMs (0, 1, negative, null from NaN, absent) never makes the room claim faster than LINE_POLL_MIN_MS; each counted", async () => {
    // Expected from the rule (spec §5.7.9): the floor for a number under it, LINE_POLL_MS for no usable number.
    const CASES: [string, Record<string, unknown>, number][] = [
      ["0", { pollMs: 0 }, LINE_POLL_MS],
      ["1", { pollMs: 1 }, LINE_POLL_MIN_MS],
      ["negative", { pollMs: -5_000 }, LINE_POLL_MS],
      ["NaN (JSON null)", { pollMs: Number.NaN }, LINE_POLL_MS],
      ["absent", { pollMs: undefined }, LINE_POLL_MS],
      ["slower is the server's to ask for", { pollMs: 7_000 }, 7_000],
    ];
    let checked = 0;
    for (const [label, over, want] of CASES) {
      vi.clearAllTimers();
      const posts = stubServer([{ seat: QUEUED(over) }]);
      const island = renderIsland(Probe, { snap: snap() });
      await roomOf(island).claim();
      await vi.advanceTimersByTimeAsync(want - 1);
      expect(posts.length, `${label}: nothing before ${want} ms`).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(posts.length, `${label}: the next claim at ${want} ms`).toBe(2);
      expect(posts[1]! - posts[0]!, `${label}: never under the floor`).toBeGreaterThanOrEqual(LINE_POLL_MIN_MS);
      island.unmount();
      checked += 1;
    }
    expect(checked, "cases checked").toBe(CASES.length);
  });

  it("a tab coming back into view claims AT ONCE while the card shows the line - and a hidden one does not", async () => {
    const doc = stubDocument();
    const posts = stubServer([{ seat: QUEUED({ pollMs: 7_000 }) }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    expect(posts.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    doc.fire("hidden");
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.length, "hidden: no claim").toBe(1);
    doc.fire("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.length, "visible: the claim goes now, not at pollMs").toBe(2);
    expect(posts[1]! - 1_000, "1 s into a 7 s wait").toBeLessThan(7_000);
    expect(doc.count(), "listeners registered (anti-vacuity)").toBeGreaterThan(0);
  });

  it("once the answer is no longer queued the loop is gone: no timer-driven claim and a visibility change claims nothing", async () => {
    const doc = stubDocument();
    const posts = stubServer([{ seat: QUEUED({ pollMs: 3_000 }) }, { seat: STARTING }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(posts.length, "premise: two claims, the second answered camera_starting").toBe(2);
    expect(roomOf(island).state.seat).toMatchObject({ reason: "camera_starting" });
    await vi.advanceTimersByTimeAsync(10 * 3_000);
    expect(posts.length, "no further claim from the line's loop (camera_starting is room-shell's to re-ask)").toBe(2);
    doc.fire("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(posts.length, "and a tab coming back claims nothing").toBe(2);
  });
});

describe("useRoom - a 429 never pauses the line (spec §6.1 (3), test 31)", () => {
  it("a 429 with a Retry-After received while the card shows the line starts NO countdown, and the next claim goes at the normal cadence", async () => {
    const posts = stubServer([{ seat: QUEUED({ pollMs: 3_000 }) }, { status: 429, retryAfter: "23" }, { seat: QUEUED({ pollMs: 3_000 }) }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(posts.length, "premise: the second claim was the refused one").toBe(2);
    expect(roomOf(island).seatWaitS, "no countdown").toBeNull();
    expect(roomOf(island).state.seat, "the card still shows the line").toMatchObject({ reason: "queued" });
    await vi.advanceTimersByTimeAsync(3_000 - 1);
    expect(posts.length, "not before the normal cadence").toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(posts.length, "the next claim at the normal cadence, not 23 s later").toBe(3);
    expect(posts[2]! - posts[1]!, "3 s after the refused one").toBe(3_000);
    expect(roomOf(island).seatWaitS).toBeNull();
  });
});

describe("useRoom - the seat 429 wait (spec §6.1 (3), test 34)", () => {
  it("Retry-After: 23 disables the button at 22.999 s and brings it back at 23 s, NOT before; nothing is sent meanwhile", async () => {
    const posts = stubServer([{ status: 429, retryAfter: "23" }, { seat: STARTING }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    expect(posts.length, "the refused claim").toBe(1);
    expect(roomOf(island).seatWaitS, "the countdown starts at the header's value").toBe(23);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(roomOf(island).seatWaitS, "ticks in whole seconds").toBe(13);
    for (let i = 0; i < 3; i++) expect(await roomOf(island).claim(), "a press during the wait sends nothing").toBeNull();
    await vi.advanceTimersByTimeAsync(13_000 - 1);
    expect(roomOf(island).seatWaitS, "22.999 s: still shut").not.toBeNull();
    expect(await roomOf(island).claim(), "22.999 s: a press is stopped by the guard").toBeNull();
    expect(posts.length, "no request all wait long (anti-vacuity: the refused one is the only one)").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(roomOf(island).seatWaitS, "23 s: back").toBeNull();
    await roomOf(island).claim();
    expect(posts.length, "and the press now goes out").toBe(2);
  });

  it("the countdown is on the MONOTONIC clock: a system clock moved an hour forward neither ends the wait early nor stretches it", async () => {
    const posts = stubServer([{ status: 429, retryAfter: "23" }, { seat: STARTING }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(await roomOf(island).claim(), "an hour later on Date.now(): still waiting").toBeNull();
    await vi.advanceTimersByTimeAsync(13_000 - 1);
    expect(await roomOf(island).claim(), "22.999 s of monotonic time").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(roomOf(island).seatWaitS).toBeNull();
    vi.setSystemTime(Date.now() - 2 * 3_600_000);
    await roomOf(island).claim();
    expect(posts.length, "(the clock moved back: the press still goes)").toBe(2);
  });

  it("a second 429 restarts the countdown from ITS header, not the first's", async () => {
    const posts = stubServer([{ status: 429, retryAfter: "23" }, { status: 429, retryAfter: "7" }, { seat: STARTING }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    await vi.advanceTimersByTimeAsync(23_000);
    expect(roomOf(island).seatWaitS).toBeNull();
    await roomOf(island).claim();
    expect(posts.length).toBe(2);
    expect(roomOf(island).seatWaitS, "the new header").toBe(7);
    await vi.advanceTimersByTimeAsync(7_000 - 1);
    expect(await roomOf(island).claim(), "6.999 s: shut").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await roomOf(island).claim();
    expect(posts.length, "7 s: the press goes").toBe(3);
  });

  it("a missing, zero, negative or non-numeric header each count as 60, and 61+ is clamped to 60 (each counted)", async () => {
    const CASES: [string, string | undefined][] = [
      ["missing", undefined],
      ["zero", "0"],
      ["negative", "-3"],
      ["non-numeric", "soon"],
      ["over the window", "300"],
    ];
    let checked = 0;
    for (const [label, header] of CASES) {
      vi.clearAllTimers();
      const posts = stubServer([{ status: 429, ...(header === undefined ? {} : { retryAfter: header }) }, { seat: STARTING }]);
      const island = renderIsland(Probe, { snap: snap() });
      await roomOf(island).claim();
      expect(roomOf(island).seatWaitS, `${label}: ${SEAT_ASK_WINDOW_S}`).toBe(SEAT_ASK_WINDOW_S);
      await vi.advanceTimersByTimeAsync(SEAT_ASK_WINDOW_S * 1_000 - 1);
      expect(await roomOf(island).claim(), `${label}: 59.999 s still shut`).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(roomOf(island).seatWaitS, `${label}: back at 60 s`).toBeNull();
      expect(posts.length, `${label}: one request only until then`).toBe(1);
      island.unmount();
      checked += 1;
    }
    expect(checked, "cases checked").toBe(CASES.length);
  });

  it("a tab coming back into view while waiting sends no seat request (the guard is every caller's)", async () => {
    const doc = stubDocument();
    const posts = stubServer([{ status: 429, retryAfter: "23" }]);
    const island = renderIsland(Probe, { snap: snap() });
    await roomOf(island).claim();
    doc.fire("visible");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(posts.length, "only the refused claim; a visibility change reads the room (GET), it claims nothing").toBe(1);
  });
});

describe("useSeatWait - restart", () => {
  function WaitProbe() {
    const w = useSeatWait();
    return <Slot room={w as unknown as Room} />;
  }
  const waitOf = (island: ReturnType<typeof renderIsland<Record<string, never>>>) => {
    const slot = island.tree().find((el) => el.type === Slot);
    return propsOf(slot!).room as ReturnType<typeof useSeatWait>;
  };

  it("start() while a wait runs restarts it from the new value: 10 s into 23 s, start('30') ends 30 s later, not at 23 s and not at 20 s", async () => {
    const island = renderIsland(WaitProbe, {});
    expect(waitOf(island).remainingS, "idle").toBeNull();
    expect(waitOf(island).blocked()).toBe(false);
    waitOf(island).start("23");
    await vi.advanceTimersByTimeAsync(10_000);
    waitOf(island).start("30");
    expect(waitOf(island).remainingS).toBe(30);
    await vi.advanceTimersByTimeAsync(23_000 - 10_000 + 1);
    expect(waitOf(island).blocked(), "past the FIRST wait's end: still shut").toBe(true);
    await vi.advanceTimersByTimeAsync(30_000 - (23_000 - 10_000 + 1) - 1);
    expect(waitOf(island).blocked(), "29.999 s after the restart").toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(waitOf(island).blocked(), "30 s after the restart: open").toBe(false);
    expect(waitOf(island).remainingS).toBeNull();
  });
});
