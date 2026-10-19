// Capacity test 11, the client half (spec §6.1 (1), §8.1): a board whose check-in batch has not opened re-reads the room ONCE,
// AT its `opensAt` plus a 0-2 s jitter, on the SERVER's clock - never before it, and never for a room that is not waiting.
//
// Drives the REAL useRoom (real reducer, real effects under the repo's hook harness) with fetch stubbed at the boundary and
// the clock faked, and reads WHEN the room read went out. The idle poll (IDLE_POLL_MS) is an existing, unrelated cadence; the
// opening instants below sit before its first tick, or are looked for among its ticks by their own offsets. What a real
// browser does with the answer is match-room.spec.ts's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { BATCH_REREAD_JITTER_MS, IDLE_POLL_MS, batchRereadDelayMs, useRoom } from "../use-room";
import type { RoomSnapshot } from "../room-snapshot";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");

function snap(over: Partial<RoomSnapshot> & { now?: number } = {}): RoomSnapshot {
  const { now = T0, ...rest } = over;
  return {
    fixtureId: "f1",
    serverNow: new Date(now).toISOString(),
    phase: "before",
    scheduledAt: null,
    roundOpenedAt: new Date(T0 - 60_000).toISOString(),
    opensAt: new Date(T0 + 5_000).toISOString(),
    deadline: new Date(T0 + 5_000 + 10 * 60_000).toISOString(),
    links: { fixture: "/fx", standings: "/st" },
    meta: { divisionName: "Open Blitz", roundNo: 1, boardNo: 21, limitSeconds: 300, incrementSeconds: 5 },
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
    heldUntil: null,
    realtime: null,
    ...rest,
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
const roomOf = (island: ReturnType<typeof renderIsland<{ snap: RoomSnapshot }>>): Room => {
  const slot = island.tree().find((el) => el.type === Slot);
  if (!slot) throw new Error("the probe rendered no slot");
  return propsOf(slot).room as Room;
};

/** The offsets (ms after T0) at which a room READ (GET) went out; each answers the next snapshot in `answers` (the last repeats). */
function stubRoomReads(answers: (() => RoomSnapshot)[]): number[] {
  const at: number[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") throw new Error("the wait must only READ");
    const make = answers[Math.min(at.length, answers.length - 1)]!;
    at.push(Date.now() - T0);
    return new Response(JSON.stringify({ ok: true, data: make(), requestId: "t" }), { status: 200 });
  });
  return at;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("batchRereadDelayMs (the pure half)", () => {
  const OPENS = new Date(T0 + 90_000).toISOString();
  it("is the time to opensAt on the SERVER's clock plus the jitter: never earlier, never negative", () => {
    expect(batchRereadDelayMs(OPENS, T0, 0)).toBe(90_000);
    expect(batchRereadDelayMs(OPENS, T0, 1_234)).toBe(91_234);
    expect(batchRereadDelayMs(OPENS, T0 + 90_000, 0), "at the opening").toBe(0);
    expect(batchRereadDelayMs(OPENS, T0 + 200_000, 0), "past it: now, not negative").toBe(0);
  });
  it("the jitter is clamped to 0..BATCH_REREAD_JITTER_MS (a bad random cannot push the read past the cap or before the door)", () => {
    expect(BATCH_REREAD_JITTER_MS, "the spec's 0 to 2 s").toBe(2_000);
    expect(batchRereadDelayMs(OPENS, T0, 99_000)).toBe(90_000 + BATCH_REREAD_JITTER_MS);
    expect(batchRereadDelayMs(OPENS, T0, -5_000)).toBe(90_000);
  });
});

describe("useRoom - the batch wait re-reads at opensAt (spec §6.1 (1))", () => {
  it("a waiting room reads ONCE at opensAt (jitter 0): nothing at opensAt - 1 ms, the read at opensAt, the answer is the open room", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const at = stubRoomReads([() => snap({ now: T0 + 5_000, phase: "open" })]);
    const island = renderIsland(Probe, { snap: snap() });
    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(at, "1 ms before the door: no read").toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at, "AT the door: one read").toEqual([5_000]);
    expect(roomOf(island).state.snap.phase, "the answer replaced the waiting snapshot").toBe("open");
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 5_000 - 1);
    expect(at, "an open room schedules no further re-read of its own (the idle poll's first tick is later)").toEqual([5_000]);
  });

  it("the jitter moves the read LATER by up to BATCH_REREAD_JITTER_MS and never earlier (random 0.5 and 0.999)", async () => {
    let checked = 0;
    for (const random of [0.5, 0.999]) {
      vi.clearAllTimers(); // the previous island's timers are not this iteration's
      vi.setSystemTime(T0);
      vi.spyOn(Math, "random").mockReturnValue(random);
      const at = stubRoomReads([() => snap({ now: T0 + 5_000, phase: "open" })]);
      renderIsland(Probe, { snap: snap() });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(at, `random ${random}: not at the door itself`).toEqual([]);
      await vi.advanceTimersByTimeAsync(BATCH_REREAD_JITTER_MS);
      expect(at.length, `random ${random}: read once within the jitter`).toBe(1);
      expect(at[0]!, `random ${random}`).toBeGreaterThanOrEqual(5_000);
      expect(at[0]!, `random ${random}`).toBeLessThanOrEqual(5_000 + BATCH_REREAD_JITTER_MS);
      expect(at[0]!, `random ${random}: the read follows its draw`).toBe(5_000 + Math.floor(random * BATCH_REREAD_JITTER_MS));
      checked += 1;
      vi.restoreAllMocks();
    }
    expect(checked, "draws checked").toBe(2);
  });

  it("the wait is on the SERVER's clock: a phone running two minutes FAST still waits the server's time, and one running slow does too", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let checked = 0;
    for (const skewMs of [120_000, -120_000]) {
      vi.clearAllTimers();
      // The snapshot says it is `serverNow`; this phone's clock reads `serverNow - skew`. The door is 5 s ahead on the SERVER's.
      vi.setSystemTime(T0 - skewMs);
      const at: number[] = [];
      vi.stubGlobal("fetch", async () => {
        at.push(Date.now() - (T0 - skewMs));
        return new Response(JSON.stringify({ ok: true, data: snap({ now: T0 + 5_000, phase: "open" }), requestId: "t" }), { status: 200 });
      });
      renderIsland(Probe, { snap: snap({ now: T0 }) });
      await vi.advanceTimersByTimeAsync(5_000 - 1);
      expect(at, `skew ${skewMs}: not before`).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(at, `skew ${skewMs}: at the door on the server's clock`).toEqual([5_000]);
      checked += 1;
      vi.unstubAllGlobals();
    }
    expect(checked, "skews checked").toBe(2);
  });

  it("a read that finds the door still shut schedules the next one at the new opensAt (the card does not stay up for ever)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const at = stubRoomReads([
      () => snap({ now: T0 + 5_000, opensAt: new Date(T0 + 8_000).toISOString() }),
      () => snap({ now: T0 + 8_000, phase: "open" }),
    ]);
    renderIsland(Probe, { snap: snap() });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(at, "two reads: at the first opensAt, then at the one the first answer named").toEqual([5_000, 8_000]);
  });

  it("a read that finds the door still shut with the SAME opensAt (a server clock a hair behind) re-reads again when that clock gets there", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const at = stubRoomReads([
      // The first read goes out at the door by this phone's clock; the server says it is 100 ms short of it.
      () => snap({ now: T0 + 4_900 }),
      () => snap({ now: T0 + 5_100, phase: "open" }),
    ]);
    renderIsland(Probe, { snap: snap() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(at, "the first read, at the door").toEqual([5_000]);
    await vi.advanceTimersByTimeAsync(100 - 1);
    expect(at, "not yet: the server's clock is 100 ms behind").toEqual([5_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at, "the next read, once the server's clock is at the door").toEqual([5_000, 5_100]);
  });

  it("the pair: a room that is NOT waiting (open, closed) schedules no re-read - the only reads are the idle poll's, at its own interval", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let checked = 0;
    for (const phase of ["open", "closed"] as const) {
      vi.clearAllTimers();
      vi.setSystemTime(T0);
      const at = stubRoomReads([() => snap({ now: T0, phase })]);
      renderIsland(Probe, { snap: snap({ phase }) });
      await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1);
      expect(at, `phase ${phase}: nothing before the first poll tick`).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(at, `phase ${phase}: the poll's own first tick`).toEqual([IDLE_POLL_MS]);
      checked += 1;
      vi.unstubAllGlobals();
    }
    expect(checked, "phases checked").toBe(2);
  });
});
