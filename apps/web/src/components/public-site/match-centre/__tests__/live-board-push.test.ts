// T16 (controller ruling, T10 carry) — spectators receive pushed moves. The
// producer (lib/realtime `publishRoomBroadcast`) sends `board_state` on
// `fixture:{id}`; the fixture page already holds ONE private subscription to
// that topic, owned by the match centre's `useLiveFixture` (realtime-js hands
// a second `channel()` on the same topic the SAME channel object, so a second
// subscriber would neither join nor be told — live-fixture-channel.ts's
// reason). So the hook relays the board to `live-board-channel`, and the watch
// island listens there.
//
// Driven through the real hook with a fake Supabase client (vitest is
// `environment: "node"`): the payload the producer builds is the one relayed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { LiveFixtureData } from "../../live-score-data";
import type { PublicBoardPush } from "@/server/external-play/public-view";

type Binding = { type: string; event: string; cb: (msg: { payload?: unknown }) => void };
const fake = vi.hoisted(() => ({ bindings: [] as Binding[], topics: [] as string[], unsubscribed: 0 }));
vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({
    realtime: { setAuth: async () => undefined },
    channel: (topic: string) => {
      fake.topics.push(topic);
      const ch = {
        on: (type: string, filter: { event: string }, cb: Binding["cb"]) => {
          fake.bindings.push({ type, event: filter.event, cb });
          return ch;
        },
        subscribe: (cb: (status: string) => void) => {
          cb("SUBSCRIBED");
          return ch;
        },
        unsubscribe: () => {
          fake.unsubscribed += 1;
        },
      };
      return ch;
    },
  }),
}));
vi.mock("../../live-score-data", async () => {
  const actual = await vi.importActual<typeof import("../../live-score-data")>("../../live-score-data");
  return {
    ...actual,
    fetchLiveFixture: vi.fn(async () => ({ status: "scheduled", summary: null, outcome: null })),
    fetchPublicRealtimeToken: vi.fn(async (id: string) => ({ token: "t", channel: `fixture:${id}` })),
  };
});

import { useLiveFixture } from "../use-live-fixture";
import { subscribeBoardPush } from "../live-board-channel";

// The producer's own copy (lib/realtime → spectatorBoard), after 1.e4 e5 2.Nf3.
const PUSH: PublicBoardPush = {
  fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
  lastMove: "g1f3",
  turn: "black",
  ply: 3,
  whiteMs: 590_000,
  blackMs: 595_000,
  over: false,
};
const scheduled = { status: "scheduled", summary: null, outcome: null } as LiveFixtureData;

function mount(fixtureId: string, realtime = true) {
  function Probe(p: { fixtureId: string; realtime: boolean }) {
    useLiveFixture(p.fixtureId, scheduled, p.realtime);
    return null;
  }
  return renderIsland(Probe, { fixtureId, realtime });
}
const emit = (event: string, payload: unknown) => {
  let reached = 0;
  for (const b of fake.bindings) {
    if (b.type === "broadcast" && b.event === event) {
      b.cb({ payload });
      reached += 1;
    }
  }
  return reached;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  fake.bindings.length = 0;
  fake.topics.length = 0;
  fake.unsubscribed = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("the match centre's subscription relays the board to the watch island", () => {
  it("a board_state on fixture:{id} reaches a listener for THAT fixture, as the producer built it", async () => {
    const got: PublicBoardPush[] = [];
    const other: PublicBoardPush[] = [];
    const off = subscribeBoardPush("fx-1", (p) => got.push(p));
    const offOther = subscribeBoardPush("fx-2", (p) => other.push(p));
    mount("fx-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.topics).toEqual(["fixture:fx-1"]);
    expect(emit("board_state", PUSH), "anti-vacuity: the hook bound board_state").toBe(1);
    expect(got).toEqual([PUSH]);
    expect(other, "another fixture's island hears nothing").toEqual([]);
    off();
    offOther();
  });

  it("only the board travels: a payload with extra keys is relayed without them; a malformed one is never relayed", async () => {
    const got: PublicBoardPush[] = [];
    const off = subscribeBoardPush("fx-1", (p) => got.push(p));
    mount("fx-1");
    await vi.advanceTimersByTimeAsync(0);
    emit("board_state", { ...PUSH, drawOfferBy: "white", token: "secret" });
    expect(got).toEqual([PUSH]);
    const bad: unknown[] = [
      null,
      "x",
      { ...PUSH, fen: 3 },
      { ...PUSH, turn: "red" },
      { ...PUSH, ply: -1 },
      { ...PUSH, ply: 2.5 },
      { ...PUSH, whiteMs: "1" },
      { ...PUSH, blackMs: Number.NaN },
      { ...PUSH, over: "no" },
      { ...PUSH, lastMove: "e2-e4" },
    ];
    for (const b of bad) emit("board_state", b);
    expect(got, "anti-vacuity: none of the malformed payloads relayed").toHaveLength(1);
    expect(bad.length).toBe(10);
    off();
  });

  it("the negative pair: state_changed still refreshes the match centre and relays no board", async () => {
    const got: PublicBoardPush[] = [];
    const off = subscribeBoardPush("fx-1", (p) => got.push(p));
    mount("fx-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(emit("state_changed", { v: 1 })).toBe(1);
    expect(got).toEqual([]);
    off();
  });

  it("an unsubscribed listener hears nothing more", async () => {
    const got: PublicBoardPush[] = [];
    const off = subscribeBoardPush("fx-1", (p) => got.push(p));
    mount("fx-1");
    await vi.advanceTimersByTimeAsync(0);
    emit("board_state", PUSH);
    off();
    emit("board_state", { ...PUSH, ply: 4, turn: "white", lastMove: "b8c6" });
    expect(got).toEqual([PUSH]);
  });
});
