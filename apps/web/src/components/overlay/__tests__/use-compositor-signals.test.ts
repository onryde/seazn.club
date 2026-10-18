// R2005 changes 2 and 10 — the compositor host's console signals, through the REAL hook on fake timers: ready ONCE
// after the first snapshot and the assets, the alive beat every OVERLAY_ALIVE_EVERY_MS after ready (never before, never
// without the host, never doubled by a remount), and score-stale on change only.
//
// Expected periods are typed from their authorities (Owed 18: 2 s; compositor spec §6: 10 s), never read back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useCompositorSignals } from "../use-compositor-signals";

const NOW = 1_700_000_000_000;
const BEAT = 2_000; // Owed 18, `cef_alive_every_ms`
const STALE = 10_000; // compositor spec §6

let lines: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  lines = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type P = { enabled: boolean; contentReady: boolean; lastSuccessAt: number; assetsReady?: () => Promise<void> };
function Probe(props: P) {
  useCompositorSignals(props);
  return null;
}
const mount = (p: P) => renderIsland<P>(Probe, p);
const count = (line: string) => lines.filter((l) => l === line).length;
const alive = () => count("seazn:alive");

describe("ready (change 2)", () => {
  it("is logged once, only after the first snapshot rendered AND the assets resolved", async () => {
    let release!: () => void;
    const assets = new Promise<void>((r) => (release = r));
    const island = mount({ enabled: true, contentReady: false, lastSuccessAt: NOW, assetsReady: () => assets });
    await vi.advanceTimersByTimeAsync(5 * BEAT);
    expect(lines, "no snapshot yet: nothing at all").toEqual([]);
    island.rerender({ enabled: true, contentReady: true, lastSuccessAt: NOW, assetsReady: () => assets });
    await vi.advanceTimersByTimeAsync(5 * BEAT);
    expect(count("seazn:ready"), "fonts/images still loading").toBe(0);
    expect(alive(), "no beat before ready").toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(count("seazn:ready")).toBe(1);
    // Re-renders, a second snapshot, contentReady blinking: still exactly one.
    island.rerender({ enabled: true, contentReady: false, lastSuccessAt: NOW + 1, assetsReady: () => assets });
    island.rerender({ enabled: true, contentReady: true, lastSuccessAt: NOW + 2, assetsReady: () => assets });
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    expect(count("seazn:ready")).toBe(1);
  });

  it("without the host: never, whatever else holds", async () => {
    mount({ enabled: false, contentReady: true, lastSuccessAt: NOW });
    await vi.advanceTimersByTimeAsync(STALE * 3);
    expect(lines).toEqual([]);
  });
});

describe("the alive beat (change 10, Owed 18)", () => {
  it("no seazn:alive before ready", async () => {
    mount({ enabled: true, contentReady: false, lastSuccessAt: NOW });
    await vi.advanceTimersByTimeAsync(10 * BEAT);
    expect(alive()).toBe(0);
  });

  it("after ready: exactly k lines at k × 2 000 ms and k − 1 at 1 ms before, k = 1..5", async () => {
    mount({ enabled: true, contentReady: true, lastSuccessAt: NOW });
    await vi.advanceTimersByTimeAsync(0);
    expect(count("seazn:ready")).toBe(1);
    let checked = 0;
    for (let k = 1; k <= 5; k++) {
      await vi.advanceTimersByTimeAsync(BEAT - 1);
      expect(alive(), `1 ms before beat ${k}`).toBe(k - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(alive(), `at beat ${k}`).toBe(k);
      checked++;
    }
    console.log(`beats checked: ${checked}`);
    expect(checked).toBe(5);
  });

  it("without the host: 0 lines after 10 beats' worth of time", async () => {
    mount({ enabled: false, contentReady: true, lastSuccessAt: NOW });
    await vi.advanceTimersByTimeAsync(10 * BEAT);
    expect(alive()).toBe(0);
  });

  it("unmount stops it; a remount beats once per interval, never doubled", async () => {
    const island = mount({ enabled: true, contentReady: true, lastSuccessAt: NOW });
    await vi.advanceTimersByTimeAsync(2 * BEAT);
    expect(alive()).toBe(2);
    island.unmount();
    await vi.advanceTimersByTimeAsync(3 * BEAT);
    expect(alive(), "nothing beats after unmount").toBe(2);
    mount({ enabled: true, contentReady: true, lastSuccessAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4 * BEAT);
    expect(alive(), "4 intervals after the remount's ready: 4 more, not 8").toBe(6);
  });
});

describe("score stale (change 2), on change only", () => {
  const stale = () => lines.filter((l) => l.startsWith("seazn:score-stale="));

  it("false at ready, true at exactly SCORE_STALE_AFTER_MS after the last success (not 1 ms before), false on the next", async () => {
    const island = mount({ enabled: true, contentReady: true, lastSuccessAt: NOW });
    await vi.advanceTimersByTimeAsync(0);
    expect(stale()).toEqual(["seazn:score-stale=false"]);
    await vi.advanceTimersByTimeAsync(STALE - 1);
    expect(stale(), "9 999 ms: still fresh").toEqual(["seazn:score-stale=false"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stale()).toEqual(["seazn:score-stale=false", "seazn:score-stale=true"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stale(), "stays true without repeating").toHaveLength(2);
    island.rerender({ enabled: true, contentReady: true, lastSuccessAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(stale()).toEqual(["seazn:score-stale=false", "seazn:score-stale=true", "seazn:score-stale=false"]);
  });

  it("healthy polls every 5 s never emit a second line", async () => {
    let last = NOW;
    const island = mount({ enabled: true, contentReady: true, lastSuccessAt: last });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      last = Date.now();
      island.rerender({ enabled: true, contentReady: true, lastSuccessAt: last });
    }
    expect(stale()).toEqual(["seazn:score-stale=false"]);
  });

  it("nothing before ready, and nothing without the host", async () => {
    mount({ enabled: true, contentReady: false, lastSuccessAt: NOW - STALE * 2 });
    mount({ enabled: false, contentReady: true, lastSuccessAt: NOW - STALE * 2 });
    await vi.advanceTimersByTimeAsync(STALE * 2);
    expect(stale()).toEqual([]);
  });
});
