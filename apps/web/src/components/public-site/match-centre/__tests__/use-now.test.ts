// Spectator surface W1, Task 10 review fix round 1 (IMPORTANT 4) —
// `useNow()`'s own ticking contract: the value it returns actually advances
// over time, and stops updating (no crash, no further ticks) after unmount.
// Driven through the shared `_hook-harness` (`renderIsland`) with fake
// timers — this workspace's vitest runs `environment: "node"`, no jsdom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useNow } from "../use-now";

function mount(intervalMs?: number) {
  let latest!: number;
  function Probe(props: { intervalMs?: number; onReady: (n: number) => void }) {
    const now = useNow(props.intervalMs);
    props.onReady(now);
    return null;
  }
  const island = renderIsland(Probe, { intervalMs, onReady: (n) => (latest = n) });
  return {
    get current() {
      return latest;
    },
    unmount: () => island.unmount(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useNow", () => {
  it("advances after each tick — fake timers moving the clock forward, not a re-render alone", () => {
    const hook = mount(1000);
    const first = hook.current;

    vi.advanceTimersByTime(1000); // fake timers move Date.now() forward too
    const second = hook.current;
    expect(second).toBeGreaterThan(first);
    expect(second - first).toBe(1000);

    vi.advanceTimersByTime(1000);
    const third = hook.current;
    expect(third).toBeGreaterThan(second);
    expect(third - second).toBe(1000);
  });

  it("stops ticking after unmount — no further advances, no crash", () => {
    const hook = mount(1000);
    const before = hook.current;
    hook.unmount();

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(hook.current).toBe(before); // no `onReady` fired after unmount
  });
});
