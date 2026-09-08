// The in-play band's polling schedule (Competition Desk W4). These run in
// `environment: "node"` like the rest of `apps/web`, which is exactly why the
// schedule was extracted: inside `useEffect` none of it is reachable from a
// unit test, and the band shipped in W3 with the wrong schedule behind a
// green suite.
import { describe, expect, it } from "vitest";
import {
  LIVE_POLL_MS,
  QUIET_POLL_MS,
  bandPollMs,
  startBandPolling,
  type BandPollDeps,
} from "@/components/v2/desk/band-poll";

interface Harness {
  deps: BandPollDeps;
  /** Every interval started, in order, with the period it was given. */
  started: { id: number; ms: number }[];
  cleared: number[];
  /** Interval ids still running. */
  live: () => number[];
  /** Run one tick of every running interval. */
  tick: () => void;
  setVisible: (v: boolean) => void;
  /** Fire the visibilitychange listeners, as the browser would. */
  fireVisibility: () => void;
  refreshes: number;
}

function harness(visible = true): Harness {
  const fns = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  let nextId = 1;
  let isVisible = visible;
  const h: Harness = {
    started: [],
    cleared: [],
    refreshes: 0,
    live: () => [...fns.keys()],
    tick: () => {
      for (const fn of [...fns.values()]) fn();
    },
    setVisible: (v) => {
      isVisible = v;
    },
    fireVisibility: () => {
      for (const fn of [...listeners]) fn();
    },
    deps: {
      setInterval: (fn, ms) => {
        const id = nextId++;
        fns.set(id, fn);
        h.started.push({ id, ms });
        return id;
      },
      clearInterval: (id) => {
        h.cleared.push(id);
        fns.delete(id);
      },
      addVisibilityListener: (fn) => void listeners.add(fn),
      removeVisibilityListener: (fn) => void listeners.delete(fn),
      isVisible: () => isVisible,
    },
  };
  return h;
}

describe("bandPollMs", () => {
  it("polls faster while live than while quiet, and both are finite", () => {
    // The relation is the assertion that survives a re-tune. Pinning only the
    // two constants would let a change that made them EQUAL — which is the
    // regression that costs money — pass by moving both.
    expect(bandPollMs(true)).toBeLessThan(bandPollMs(false));
    expect(Number.isFinite(bandPollMs(false))).toBe(true);
    // …and the values themselves, so a re-tune is a deliberate edit here.
    expect(bandPollMs(true)).toBe(LIVE_POLL_MS);
    expect(bandPollMs(false)).toBe(QUIET_POLL_MS);
  });

  it("keeps polling when nothing is live — the W3 defect this replaces", () => {
    // W3 returned early from the effect when `live` was false and started no
    // interval at all. A band that renders `null` while quiet cannot see the
    // day's first fixture start, so quiet is precisely the state that must
    // keep asking. `> 0` is the whole claim; the cadence is the test above.
    expect(bandPollMs(false)).toBeGreaterThan(0);
  });
});

describe("startBandPolling", () => {
  it("starts one interval at the live cadence and refreshes on each tick", () => {
    const h = harness();
    startBandPolling(true, () => h.refreshes++, h.deps);
    expect(h.started).toEqual([{ id: 1, ms: LIVE_POLL_MS }]);
    // Not on start: the band is server-rendered, so a fetch here would ask
    // for the state it was just given.
    expect(h.refreshes).toBe(0);
    h.tick();
    h.tick();
    expect(h.refreshes).toBe(2);
  });

  it("starts at the QUIET cadence when nothing is live", () => {
    const h = harness();
    startBandPolling(false, () => h.refreshes++, h.deps);
    expect(h.started).toEqual([{ id: 1, ms: QUIET_POLL_MS }]);
    h.tick();
    expect(h.refreshes).toBe(1);
  });

  it("stops on teardown — both the timer and the listener", () => {
    const h = harness();
    const stop = startBandPolling(true, () => h.refreshes++, h.deps);
    stop();
    expect(h.cleared).toEqual([1]);
    expect(h.live()).toEqual([]);
    // The listener is gone too: firing visibility after teardown must not
    // resurrect the poll. A cleanup that cleared only the timer would leave a
    // listener able to start a fresh one on the next tab switch.
    h.fireVisibility();
    expect(h.live()).toEqual([]);
    h.tick();
    expect(h.refreshes).toBe(0);
  });

  it("pauses while the tab is hidden and catches up once when it returns", () => {
    const h = harness();
    startBandPolling(true, () => h.refreshes++, h.deps);

    h.setVisible(false);
    h.fireVisibility();
    expect(h.live(), "a hidden tab must not hold a running interval").toEqual([]);
    h.tick();
    expect(h.refreshes).toBe(0);

    h.setVisible(true);
    h.fireVisibility();
    // One immediate refresh — the band is as stale as the time away — then a
    // fresh interval at the same cadence.
    expect(h.refreshes).toBe(1);
    expect(h.started.at(-1)).toEqual({ id: 2, ms: LIVE_POLL_MS });
    h.tick();
    expect(h.refreshes).toBe(2);
  });

  it("starts nothing while the tab is already hidden at mount", () => {
    const h = harness(false);
    startBandPolling(false, () => h.refreshes++, h.deps);
    expect(h.started).toEqual([]);
    // …but it is still listening, so the first tab switch starts it.
    h.setVisible(true);
    h.fireVisibility();
    expect(h.started).toEqual([{ id: 1, ms: QUIET_POLL_MS }]);
  });

  it("never runs two intervals at once across repeated visibility changes", () => {
    const h = harness();
    startBandPolling(true, () => h.refreshes++, h.deps);
    for (let i = 0; i < 3; i++) {
      h.setVisible(false);
      h.fireVisibility();
      h.setVisible(true);
      h.fireVisibility();
    }
    expect(h.live()).toHaveLength(1);
    h.refreshes = 0;
    h.tick();
    expect(h.refreshes, "one tick must produce exactly one refresh").toBe(1);
  });

  it("a repeated visible event does not stack a second interval", () => {
    // This is the case the alternating loop above CANNOT see, and finding
    // that out was the point of mutating: dropping the `stop()` inside
    // `start()` left every test green, because every path the suite drove
    // went hidden (which stops) before it went visible (which starts). Two
    // `visibilitychange` events with no hidden state between them is the one
    // path where that guard is load-bearing, and it doubles the request rate
    // for the rest of the tab's life if it is missing.
    const h = harness();
    startBandPolling(true, () => h.refreshes++, h.deps);
    h.fireVisibility();
    h.fireVisibility();
    expect(h.live(), "a second visible event stacked another interval").toHaveLength(1);
    h.refreshes = 0;
    h.tick();
    expect(h.refreshes).toBe(1);
  });
});
