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
import type { UseLiveFixtureResult } from "../use-live-fixture";

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

function mount(fixtureId: string, initial: LiveFixtureData, realtime: boolean) {
  let latest!: UseLiveFixtureResult;
  function Probe(props: { fixtureId: string; initial: LiveFixtureData; realtime: boolean; onReady: (r: UseLiveFixtureResult) => void }) {
    const result = useLiveFixture(props.fixtureId, props.initial, props.realtime);
    props.onReady(result);
    return null;
  }
  const island = renderIsland(Probe, { fixtureId, initial, realtime, onReady: (r) => (latest = r) });
  return {
    get current() {
      return latest;
    },
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
});
