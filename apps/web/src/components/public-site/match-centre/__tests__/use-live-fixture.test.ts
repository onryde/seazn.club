// Spectator surface W1, Task 10 — `useLiveFixture`'s own transport contract:
// the initial document renders immediately, a poll tick after POLL_MS
// replaces the WHOLE document with the fresh fetch, and a failed fetch keeps
// the last known data (never throws to the UI). This workspace's vitest runs
// `environment: "node"` (no jsdom), so the hook is driven through the shared
// `_hook-harness` (`renderIsland`) with fake timers + a module-mocked
// `fetchLiveFixture` — the same convention `use-fixture-stream.test.ts` uses
// for this exact shape of transport hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { LiveFixtureData } from "../../live-score-data";
import type { UseLiveFixtureOptions, UseLiveFixtureResult } from "../use-live-fixture";

vi.mock("../../live-score-data", async () => {
  const actual = await vi.importActual<typeof import("../../live-score-data")>("../../live-score-data");
  return {
    ...actual,
    fetchLiveFixture: vi.fn(),
    fetchPublicRealtimeToken: vi.fn(async () => {
      throw new Error("not entitled");
    }),
  };
});

import { fetchLiveFixture } from "../../live-score-data";
import { POLL_MS, useLiveFixture } from "../use-live-fixture";

function mount(
  fixtureId: string,
  initial: LiveFixtureData,
  realtime: boolean,
  options?: UseLiveFixtureOptions<LiveFixtureData>,
) {
  let latest!: UseLiveFixtureResult;
  function Probe(props: { fixtureId: string; initial: LiveFixtureData; realtime: boolean; options?: UseLiveFixtureOptions<LiveFixtureData>; onReady: (r: UseLiveFixtureResult) => void }) {
    const result = useLiveFixture(props.fixtureId, props.initial, props.realtime, props.options);
    props.onReady(result);
    return null;
  }
  const onReady = (r: UseLiveFixtureResult) => (latest = r);
  const island = renderIsland(Probe, { fixtureId, initial, realtime, options, onReady });
  return {
    get current() {
      return latest;
    },
    /** Re-render with a DIFFERENT options object — what a caller that mints its
     *  `fetcher` inline does on every one of its own renders. Everything else
     *  about the island is held identical, so the only thing that moved is the
     *  option. */
    rerender: (next?: UseLiveFixtureOptions<LiveFixtureData>) =>
      island.rerender({ fixtureId, initial, realtime, options: next, onReady }),
    unmount: () => island.unmount(),
  };
}

const scheduled: LiveFixtureData = {
  status: "scheduled",
  summary: null,
  outcome: null,
} as LiveFixtureData;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useLiveFixture", () => {
  it("renders the initial data immediately, before any poll has fired", () => {
    const hook = mount("fx-1", scheduled, false);
    expect(hook.current.data).toBe(scheduled);
    expect(hook.current.transport).toBe("poll");
    expect(fetchLiveFixture).not.toHaveBeenCalled();
  });

  it("a poll tick after POLL_MS replaces the WHOLE document with the fresh fetch", async () => {
    const next: LiveFixtureData = {
      status: "in_play",
      summary: { headline: "1 – 0" },
      outcome: null,
    } as LiveFixtureData;
    vi.mocked(fetchLiveFixture).mockResolvedValueOnce(next);
    const hook = mount("fx-1", scheduled, false);
    expect(hook.current.data).toBe(scheduled); // positive pair: unchanged before the tick

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchLiveFixture).toHaveBeenCalledWith("fx-1");
    expect(hook.current.data).toBe(next); // the WHOLE document, not a merge
  });

  it("a failed poll fetch keeps the last known data — never throws to the UI", async () => {
    vi.mocked(fetchLiveFixture).mockRejectedValueOnce(new Error("offline"));
    const hook = mount("fx-1", scheduled, false);

    await expect(vi.advanceTimersByTimeAsync(POLL_MS)).resolves.not.toThrow();
    expect(hook.current.data).toBe(scheduled); // unchanged, not undefined/null
  });

  it("never arms a poll timer when the fixture is already decided at mount", async () => {
    const decided: LiveFixtureData = { status: "decided", summary: null, outcome: null } as LiveFixtureData;
    mount("fx-1", decided, false);

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(fetchLiveFixture).not.toHaveBeenCalled();
  });

  // Review fix round 1 (MINOR 10) — a poll in flight when the component
  // unmounts must not apply its result once it lands.
  it("a poll fetch that resolves AFTER unmount does not update state (no crash, no stale write)", async () => {
    let resolveFetch!: (v: LiveFixtureData) => void;
    vi.mocked(fetchLiveFixture).mockImplementationOnce(
      () =>
        new Promise<LiveFixtureData>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const hook = mount("fx-1", scheduled, false);
    await vi.advanceTimersByTimeAsync(POLL_MS); // arms the tick; fetch now in flight
    hook.unmount();

    const late: LiveFixtureData = { status: "in_play", summary: null, outcome: null } as LiveFixtureData;
    expect(() => resolveFetch(late)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0); // flush the now-resolved promise's continuation
    expect(hook.current.data).toBe(scheduled); // unchanged — the guarded setState never applied
  });

  // ---- Stream overlay W1 (design §3.3): generic fetcher + presentation delay ----

  it("polls the public fixture URL by default — every existing caller is byte-identical", async () => {
    // The default fetcher IS `fetchLiveFixture` (mocked here), called with the id.
    vi.mocked(fetchLiveFixture).mockResolvedValueOnce({ ...scheduled, status: "in_play" } as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false);
    expect(hook.current.presentationNowOffsetMs, "no delay → offset 0, by value").toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchLiveFixture).toHaveBeenCalledWith("fx-1");
    expect(hook.current.data.status).toBe("in_play");
  });

  it("uses the fetcher it is given, and then never calls fetchLiveFixture (one transport, two payloads)", async () => {
    const own = vi.fn(async (id: string) => ({ ...scheduled, status: "in_play", summary: { headline: `own:${id}` } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher: own });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(own).toHaveBeenCalledWith("fx-1");
    expect(fetchLiveFixture).not.toHaveBeenCalled();
    expect(hook.current.data.summary?.headline).toBe("own:fx-1");
  });

  // Review fix round 1 (Important) — `fetcher` referential stability was
  // DOCUMENTED and unenforced. `refresh` used to list it as a `useCallback`
  // dependency, so a caller minting an inline arrow handed the poll effect a
  // new `refresh` every render, which cleared and re-armed the 15 s interval
  // every render — a poll that can starve for ever, silently. It is held in a
  // ref now, re-pointed in the render body. This is the case that pins both
  // halves; without `hook.rerender` no test in this file could see it at all,
  // because `renderIsland` holds ONE props object for the island's life.
  it("a fetcher whose identity changes every render does NOT re-arm the poll — the newest one is called on the ORIGINAL schedule", async () => {
    const a = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: "a" } }) as LiveFixtureData);
    const b = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: "b" } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher: a });

    await vi.advanceTimersByTimeAsync(POLL_MS - 1000); // t = 14 000 — no tick yet
    hook.rerender({ fetcher: b }); // a new options object AND a new fetcher identity
    await vi.advanceTimersByTimeAsync(1000); // t = 15 000 — the ORIGINAL interval's first tick

    expect(b, "the interval was never cleared, so it fired on its own schedule").toHaveBeenCalledWith("fx-1");
    expect(a, "the ref is re-pointed every render, so the stale fetcher is never called").not.toHaveBeenCalled();
    expect(hook.current.data.summary?.headline).toBe("b");
  });

  it("without options arms ONLY the poll timer — no drain timer (the positive pair for the delay cases)", () => {
    mount("fx-1", scheduled, false);
    // One pending timer: the POLL_MS interval. A drain interval would make it two.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("delayMs: a snapshot received at t is presented at t + delayMs, on the 1 s drain, and the offset is exposed by value", async () => {
    const fetcher = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: "1 — 1" } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher, delayMs: 3000 });
    expect(hook.current.presentationNowOffsetMs).toBe(3000);
    expect(vi.getTimerCount(), "poll + drain").toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);              // received at POLL_MS
    expect(hook.current.data.summary?.headline, "not yet — 3 s have not passed").toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);                 // drains at +1 s, +2 s: still held
    expect(hook.current.data.summary?.headline).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);                 // +3 s: presented
    expect(hook.current.data.summary?.headline).toBe("1 — 1");
  });

  it("delayMs: successive snapshots present in order, each one delayMs after ITS OWN receipt", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ({ ...scheduled, status: "in_play", summary: { headline: `s${++n}` } }) as LiveFixtureData);
    const hook = mount("fx-1", scheduled, false, { fetcher, delayMs: 2000 });
    // The poll interval ticks at fixed POLL_MS boundaries, so the two receipts
    // are POLL_MS apart: s1 at t = 15 000, s2 at t = 30 000. The 1 s drain
    // presents each 2 s after ITS OWN receipt — s1 at t = 17 000, s2 at
    // t = 32 000 — so at t = 30 500 the presented snapshot is still s1.
    await vi.advanceTimersByTimeAsync(POLL_MS);              // t = 15 000: s1 received
    await vi.advanceTimersByTimeAsync(500);                  // t = 15 500: s1 presented at 17 000 (below)
    await vi.advanceTimersByTimeAsync(POLL_MS);              // t = 30 500: s1 long presented, s2 received at 30 000
    expect(hook.current.data.summary?.headline).toBe("s1");
    await vi.advanceTimersByTimeAsync(2000);                 // t = 32 500: s2 became due at 32 000
    expect(hook.current.data.summary?.headline).toBe("s2");
  });

  // Mutation finding (task 1, step 5): deleting `refresh`'s try/catch leaves
  // every case in this file GREEN and SILENT — the interval never awaits
  // `refresh()`, so a rejection just escapes and nothing observes it. "Never
  // throws to the UI" was therefore untested. The overlay polls an endpoint
  // that is allowed to die (design §3.1, step 2b), so this pins it: catch a
  // process-level unhandled rejection, which is exactly what escapes.
  it("a rejected fetch is swallowed INSIDE refresh — no unhandled rejection escapes the poll interval", async () => {
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const fetcher = vi.fn(async (): Promise<LiveFixtureData> => {
        throw new Error("overlay endpoint is dead");
      });
      const hook = mount("fx-1", scheduled, false, { fetcher });
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(hook.current.data).toBe(scheduled);
      // The rejection is created under fake timers; node only reports an
      // unhandled one on a later REAL turn, so hand the loop one.
      vi.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(escaped, "refresh's own catch is the only thing keeping this empty").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("delayMs: two snapshots BOTH due at one drain tick — the newest wins and the older is never painted", async () => {
    // The case above never puts two snapshots in the buffer at once, so it
    // cannot witness WHICH due snapshot the drain picks. Here the first fetch
    // is held in flight until t = 29 500 and the second poll lands at
    // t = 30 000, so at the t = 32 000 tick (due = 30 000) BOTH are due.
    let releaseFirst!: (v: LiveFixtureData) => void;
    const s1 = { ...scheduled, status: "in_play", summary: { headline: "s1" } } as LiveFixtureData;
    const s2 = { ...scheduled, status: "in_play", summary: { headline: "s2" } } as LiveFixtureData;
    const fetcher = vi
      .fn(async () => s2)
      .mockImplementationOnce(
        () =>
          new Promise<LiveFixtureData>((resolve) => {
            releaseFirst = resolve;
          }),
      );
    const hook = mount("fx-1", scheduled, false, { fetcher, delayMs: 2000 });

    await vi.advanceTimersByTimeAsync(POLL_MS);              // t = 15 000: poll 1 fires, held in flight
    await vi.advanceTimersByTimeAsync(14_500);               // t = 29 500: still nothing received
    expect(hook.current.data.summary?.headline, "nothing received yet").toBeUndefined();
    releaseFirst(s1);
    await vi.advanceTimersByTimeAsync(0);                    // s1 RECEIVED at t = 29 500
    await vi.advanceTimersByTimeAsync(500);                  // t = 30 000: poll 2 → s2 RECEIVED at 30 000
    await vi.advanceTimersByTimeAsync(1000);                 // t = 31 000, due = 29 000: neither yet
    expect(hook.current.data.summary?.headline, "s1 is not due until 31 500").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);                 // t = 32 000, due = 30 000: BOTH due
    expect(hook.current.data.summary?.headline, "the newest DUE snapshot, never s1").toBe("s2");
  });
});
