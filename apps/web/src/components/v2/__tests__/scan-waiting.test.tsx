// Scorer sheets §4.5.2 — the Waiting screen: a side is still TBD, so there is
// no pad and no stream. It re-renders the server page every POLL_MS, only
// while it exists, and on tab return through G1's own hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { ScanWaiting } from "@/components/v2/scan-waiting";
import { POLL_MS } from "@/components/v2/scorepad/use-fixture-stream";

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Listener = () => void;
function recordingTarget() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener: (type: string, fn: Listener) => void (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: Listener) =>
      void (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
  };
}
const fire = (t: { listeners: Record<string, Listener[]> }, type: string) => {
  for (const fn of [...(t.listeners[type] ?? [])]) fn();
};

describe("ScanWaiting (scorer sheets §4.5.2)", () => {
  it("re-renders the page every POLL_MS — and not before", () => {
    renderIsland(ScanWaiting, { home: "Winner of R1·1", away: "Ben Lim", meta: "Court 3" });
    vi.advanceTimersByTime(POLL_MS - 1);
    expect(router.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops the moment Waiting unmounts (only while waiting)", () => {
    const island = renderIsland(ScanWaiting, { home: "A", away: "B", meta: "" });
    island.unmount();
    vi.advanceTimersByTime(POLL_MS * 3);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("re-renders on a tab return too — G1's floor, the same hook, and not on a hide", () => {
    const doc = { ...recordingTarget(), visibilityState: "hidden" as DocumentVisibilityState };
    const win = recordingTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    renderIsland(ScanWaiting, { home: "A", away: "B", meta: "" });
    fire(doc, "visibilitychange");
    expect(router.refresh, "a hide re-renders nothing").not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    fire(doc, "visibilitychange");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    fire(win, "focus");
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("names both sides, the TBD one by its slot label", () => {
    const island = renderIsland(ScanWaiting, { home: "Winner of R1·1", away: "Ben Lim", meta: "" });
    expect(island.text()).toContain("Winner of R1·1");
    expect(island.text()).toContain("Ben Lim");
  });
});
