// The clock a "+5 min" screen runs on (use-extend-clock.ts): null before it is read, then re-read AT each window edge - the opening and
// the deadline - and, for a steady clock, every cadence between them. Through the real hook under a fake clock; the island renders
// without a DOM, so a tiny component stands for the screen.
// Single-sport reason: no sport is involved - this is a timer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { EXTEND_CLOCK_MAX_SLEEP_MS, EXTEND_CLOCK_TICK_MS, useExtendClock } from "../use-extend-clock";

const T = Date.parse("2026-10-19T12:00:00.000Z");
type P = { active: boolean; edges: number[]; steady?: boolean };
const Probe = (p: P) => `${useExtendClock(p.active, p.edges, p.steady ?? false)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The hook's value as a probe component renders it, and every distinct reading it ever rendered (a re-render happens when a read
 *  changes the state, so the list is the list of reads). */
function mount(p: P) {
  let value: string | null = null;
  const reads: number[] = [];
  renderIsland(
    (props: P) => {
      value = Probe(props);
      if (value !== "null") reads.push(Number(value));
      return null;
    },
    p,
  );
  return { value: () => value, reads };
}

describe("useExtendClock", () => {
  it("null before the first read (nothing reads the clock during render), then the clock", () => {
    const m = mount({ active: true, edges: [T + 1000] });
    expect(m.value(), "the first render").toBe("null");
    vi.advanceTimersByTime(0);
    expect(m.value()).toBe(String(T));
  });

  it("lands exactly on each edge, however far away: the opening and the deadline", () => {
    const OPEN = T + 100_000;
    const CLOSE = T + 700_000;
    const m = mount({ active: true, edges: [OPEN, CLOSE] });
    vi.advanceTimersByTime(CLOSE - T);
    expect(Date.now()).toBe(CLOSE);
    expect(m.reads.includes(OPEN), "a read AT the opening").toBe(true);
    expect(m.reads.includes(CLOSE), "a read AT the deadline").toBe(true);
    expect(m.reads.includes(OPEN - 1) || m.reads.includes(OPEN + 1), "and not a near miss of it").toBe(false);
    const gaps = m.reads.slice(1).map((t, i) => t - m.reads[i]!);
    expect(gaps.length, "anti-vacuity: several reads").toBeGreaterThan(10);
    expect(Math.max(...gaps), "never longer than the longest sleep between reads").toBeLessThanOrEqual(EXTEND_CLOCK_MAX_SLEEP_MS);
    expect(vi.getTimerCount(), "after the last edge a non-steady clock stops").toBe(0);
  });

  it("a steady clock also ticks every cadence between edges, and never stops", () => {
    const m = mount({ active: true, edges: [T + 100_000], steady: true });
    vi.advanceTimersByTime(0);
    const first = Number(m.value());
    vi.advanceTimersByTime(EXTEND_CLOCK_TICK_MS);
    expect(Number(m.value()) - first, "one cadence later").toBe(EXTEND_CLOCK_TICK_MS);
    vi.advanceTimersByTime(200_000);
    expect(Number(m.value()), "long after the edge, still reading").toBeGreaterThan(T + 100_000);
    expect(vi.getTimerCount(), "still ticking").toBe(1);
  });

  it("inactive: no timer and no clock", () => {
    const m = mount({ active: false, edges: [T + 1000] });
    vi.advanceTimersByTime(60_000);
    expect(m.value()).toBe("null");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an edge already behind the clock is not slept toward (no zero-delay spin)", () => {
    const m = mount({ active: true, edges: [T - 5_000] });
    vi.advanceTimersByTime(0);
    expect(m.value()).toBe(String(T));
    expect(vi.getTimerCount(), "nothing ahead: a non-steady clock sleeps for good").toBe(0);
  });
});

