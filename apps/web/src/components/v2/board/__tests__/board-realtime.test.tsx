// Realtime push nudges, Task 13 (spec §4.2-4.3): the organiser schedule board.
//
// Two changes, both driven through the REAL `useBoardActions`:
//   - its `division:{id}` topics go PRIVATE: the competition's division door
//     (`lib/division-realtime-auth.ts`, real, fed by a stubbed `fetch`) sets its
//     token on the division family's client first; a refused door means no
//     channel;
//   - it gains a 60 s safety-net `router.refresh` poll that runs whether push
//     is up or not. Until now the board had NO poll: it relied on push alone,
//     so a board on a topic gone silent (D-b, or any missed push) never
//     refreshed until reload. This is the spec's regression row: "the board
//     keeps its safety-net poll (killed by setting it to infinity)".
//
// Applies to another sport: N/A (no sport rules).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refreshes: 0, push: () => {}, refresh: () => void (router.refreshes += 1) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: () => Promise.resolve({ conflicts: [] }) };
});

const rt = vi.hoisted(() => {
  interface Ch {
    name: string;
    handlers: Record<string, (m?: unknown) => void>;
    unsubscribed: number;
    on: (kind: string, opts: { event: string }, fn: (m?: unknown) => void) => Ch;
    subscribe: (cb?: (s: string) => void) => Ch;
    unsubscribe: () => Promise<string>;
  }
  const channels: Ch[] = [];
  const log: string[] = [];
  const families: string[] = [];
  let status = "SUBSCRIBED";
  const client = {
    realtime: {
      setAuth: async (token: string) => {
        log.push(`setAuth ${token}`);
      },
    },
    channel: (name: string, params?: { config?: { private?: boolean } }) => {
      log.push(`channel ${name} private=${params?.config?.private === true}`);
      const ch: Ch = {
        name,
        handlers: {},
        unsubscribed: 0,
        on(_k, opts, fn) {
          ch.handlers[opts.event] = fn;
          return ch;
        },
        subscribe(cb) {
          cb?.(status);
          return ch;
        },
        async unsubscribe() {
          ch.unsubscribed += 1;
          return "ok";
        },
      };
      channels.push(ch);
      return ch;
    },
  };
  return {
    channels,
    log,
    families,
    client,
    reset: () => {
      channels.length = 0;
      log.length = 0;
      families.length = 0;
      status = "SUBSCRIBED";
    },
    setStatus: (s: string) => {
      status = s;
    },
  };
});
vi.mock("@/lib/supabase-browser", () => ({
  realtimeClient: (family: string) => {
    rt.families.push(family);
    return rt.client;
  },
}));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { BOARD_POLL_MS, useBoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";
import {
  DIVISION_AUTH_BACKOFF_MS,
  DIVISION_TOKEN_REFRESH_MS,
  _resetDivisionRealtimeAuth,
  _setDivisionAuthRandom,
  acquireDivisionRealtime,
} from "@/lib/division-realtime-auth";

const COMP = "c-0001";
const division = (id: string) => ({ id, name: id, slug: id, status: "active", seq: 1 }) as BoardDivision;
const NO_FIXTURES: BoardFixture[] = [];

const door = { calls: [] as string[], answers: [] as { status: number; token?: string; divisionIds?: string[] }[], served: 0 };
function doorAnswers(...answers: typeof door.answers) {
  door.calls = [];
  door.served = 0;
  door.answers = answers;
}
async function fetchDoor(input: unknown) {
  door.calls.push(String(input));
  const a = door.answers[Math.min(door.served, door.answers.length - 1)]!;
  door.served += 1;
  if (a.status !== 200) return new Response(JSON.stringify({ ok: false }), { status: a.status });
  return new Response(
    JSON.stringify({ ok: true, data: { token: a.token, divisionIds: a.divisionIds, expiresAt: 0, url: "u", apikey: "k" } }),
    { status: 200 },
  );
}

function mountBoard(divisions: BoardDivision[], competitionId: string | null) {
  return renderIsland(
    (props: { divisions: BoardDivision[]; competitionId: string | null }) => {
      useBoardActions(props.divisions, NO_FIXTURES, {}, {}, true, props.competitionId);
      return null;
    },
    { divisions, competitionId },
  );
}

const ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchDoor);
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
  _resetDivisionRealtimeAuth();
  // The backoff's jitter at its middle: every wait is exactly its rung.
  _setDivisionAuthRandom(() => 0.5);
  rt.reset();
  router.refreshes = 0;
  doorAnswers({ status: 200, token: "door-token-1", divisionIds: ["d1", "d2"] });
});
afterEach(() => {
  _resetDivisionRealtimeAuth();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (ENV === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ENV;
});

describe("the board's safety-net poll (regression: the board had none)", () => {
  it("is the spec's 60 s", () => {
    expect(BOARD_POLL_MS).toBe(60_000);
  });

  it("refreshes every 60 s with push UP: nothing before, one at 60 s, two at 120 s", async () => {
    mountBoard([division("d1")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(1); // push is up
    await vi.advanceTimersByTimeAsync(BOARD_POLL_MS - 1);
    expect(router.refreshes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(router.refreshes).toBe(1);
    await vi.advanceTimersByTimeAsync(BOARD_POLL_MS);
    expect(router.refreshes).toBe(2);
  });

  it("refreshes every 60 s with no push at all (a refused door, and a board with no competition)", async () => {
    doorAnswers({ status: 403 });
    mountBoard([division("d1")], COMP);
    mountBoard([division("d1")], null);
    await vi.advanceTimersByTimeAsync(BOARD_POLL_MS);
    expect(rt.channels).toHaveLength(0);
    expect(router.refreshes).toBe(2);
  });

  it("stops on unmount", async () => {
    const board = mountBoard([division("d1")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    board.unmount();
    await vi.advanceTimersByTimeAsync(3 * BOARD_POLL_MS);
    expect(router.refreshes).toBe(0);
  });
});

describe("the board's division topics go private", () => {
  it("a 200: the competition's door, setAuth first, one PRIVATE channel per division on the division client", async () => {
    mountBoard([division("d1"), division("d2")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toEqual([`/api/v1/public/competitions/${COMP}/realtime-token`]);
    expect(rt.log[0]).toBe("setAuth door-token-1");
    expect(rt.log.slice(1).sort()).toEqual(["channel division:d1 private=true", "channel division:d2 private=true"]);
    expect(new Set(rt.families)).toEqual(new Set(["division"]));
  });

  it("a schedule_changed push refreshes the board at once", async () => {
    mountBoard([division("d1")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(rt.channels[0]!.handlers)).toEqual(["schedule_changed"]);
    rt.channels[0]!.handlers.schedule_changed!();
    expect(router.refreshes).toBe(1);
  });

  for (const status of [403, 404]) {
    it(`a ${status}: no setAuth and no channel (the 60 s poll carries the board)`, async () => {
      doorAnswers({ status });
      mountBoard([division("d1")], COMP);
      await vi.advanceTimersByTimeAsync(0);
      expect(door.calls).toHaveLength(1);
      expect(rt.log).toEqual([]);
    });
  }

  it("a 503 at boot: the door is asked again at the first rung and the topic joins", async () => {
    doorAnswers({ status: 503 }, { status: 200, token: "door-token-late", divisionIds: ["d1"] });
    mountBoard([division("d1")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toHaveLength(1);
    expect(rt.channels).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    expect(door.calls).toHaveLength(2);
    expect(rt.log[0]).toBe("setAuth door-token-late");
    expect(rt.channels).toHaveLength(1);
  });

  it("unmounted while the door is down: the retries stop", async () => {
    doorAnswers({ status: 503 });
    const board = mountBoard([division("d1")], COMP);
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    const asked = door.calls.length;
    expect(asked).toBeGreaterThan(1);
    board.unmount();
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS.reduce((a, b) => a + b, 0) * 2);
    expect(door.calls).toHaveLength(asked);
  });

  it("no competition: the door is not asked", async () => {
    mountBoard([division("d1")], null);
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toEqual([]);
    expect(rt.channels).toHaveLength(0);
  });

  it("a refresh that hands down the same divisions (new array, new objects) neither rejoins nor re-asks the door", async () => {
    const board = mountBoard([division("d1"), division("d2")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    board.rerender({ divisions: [division("d1"), division("d2")], competitionId: COMP });
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels).toHaveLength(2);
    expect(rt.channels.every((c) => c.unsubscribed === 0)).toBe(true);
    expect(door.calls).toHaveLength(1);
  });

  it("CHANNEL_ERROR re-fetches the door after the backoff and rejoins on the fresh token", async () => {
    rt.setStatus("CHANNEL_ERROR");
    doorAnswers({ status: 200, token: "door-token-1", divisionIds: ["d1"] }, { status: 200, token: "door-token-2", divisionIds: ["d1"] });
    mountBoard([division("d1")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    rt.setStatus("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(DIVISION_AUTH_BACKOFF_MS[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls).toHaveLength(2);
    expect(rt.channels.map((c) => [c.name, c.unsubscribed])).toEqual([
      ["division:d1", 1],
      ["division:d1", 0],
    ]);
    expect(rt.log.indexOf("setAuth door-token-2")).toBeLessThan(rt.log.lastIndexOf("channel division:d1 private=true"));
  });

  it("unmount lets the channels go and the door is asked nothing more", async () => {
    const board = mountBoard([division("d1")], COMP);
    await vi.advanceTimersByTimeAsync(0);
    board.unmount();
    expect(rt.channels[0]!.unsubscribed).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * DIVISION_TOKEN_REFRESH_MS);
    expect(door.calls).toHaveLength(1);
  });

  it("unmounted before the door answers: the late session is handed back — no 50-minute refresh, and another competition can hold the client", async () => {
    const board = mountBoard([division("d1")], COMP);
    board.unmount(); // the door's answer is still on its way
    await vi.advanceTimersByTimeAsync(0);
    expect(door.calls, "premise: the door was asked").toHaveLength(1);
    expect(rt.channels).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DIVISION_TOKEN_REFRESH_MS);
    expect(door.calls, "a refresh ran for a board that has gone").toHaveLength(1);
    doorAnswers({ status: 200, token: "door-token-next", divisionIds: ["d1"] });
    expect(await acquireDivisionRealtime("c-0002")).not.toBeNull();
  });
});
