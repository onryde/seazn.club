// The overlay's ONE timer (_THEMES.md §6, design §3.6). A match clock is DATA:
// the engine stamps `asOf` only when something is scored or a period turns,
// so left alone the cell freezes for minutes and reads as broken on air. This
// hook advances the display from the endpoint's anchor plus elapsed wall time,
// re-anchors on every push, HOLDS at half-time (the endpoint omits `clock`
// while no play phase is running), shows nothing before kick-off or after
// full-time, and subtracts the transport's presentation offset so a delayed
// goal and the clock land together (R2's alignment, unit-level here).
//
// `environment: "node"` — driven through renderIsland with setInterval and
// Date.now stubbed. The hook's own test (match-centre/__tests__/use-live-fixture.test.ts)
// uses vi.useFakeTimers; a 1 Hz clock is easier to witness by capturing the
// callback, so this file keeps the captured-setInterval form on purpose.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useOverlayClock, NO_CLOCK_STATUSES } from "../use-overlay-clock";
import { VOID_STATUSES } from "@/components/v2/stages-panel";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

// RE-PIN (2026-09-09): `VOID_STATUSES` (stages-panel.tsx) is the console's own
// authority for "cancelled | abandoned | forfeited". Importing the whole panel
// module into this "use client" hook would drag its console dependencies into
// the overlay bundle — an OBS browser source, where page weight IS the feature
// (overlay-tokens.ts makes the identical call about V3_SKINS). So the hook
// keeps a LOCAL literal, and this test is what keeps it from silently drifting
// off the console's own set — proven equal here, in a file that never ships.
describe("NO_CLOCK_STATUSES carries VOID_STATUSES without importing the panel", () => {
  it("equals scheduled/decided/finalized plus the console's own VOID_STATUSES", () => {
    expect(NO_CLOCK_STATUSES).toEqual(new Set(["scheduled", "decided", "finalized", ...VOID_STATUSES]));
  });
});

type Clock = OverlayLiveData["clock"];

function stubTick(): { tick: () => void; armed: () => number } {
  let cb: (() => void) | null = null;
  let armed = 0;
  vi.stubGlobal("setInterval", ((fn: () => void, ms?: number) => {
    if (ms !== 1000) throw new Error(`the clock must be 1 Hz, got ${ms}`);
    cb = fn;
    armed += 1;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  vi.stubGlobal("clearInterval", (() => {}) as typeof clearInterval);
  return { tick: () => { if (!cb) throw new Error("no interval armed"); cb(); }, armed: () => armed };
}

function harness(clock: Clock, status: string, offset = 0) {
  let latest: string | null = null;
  const island = renderIsland(
    (p: { clock: Clock; status: string; offset: number }) => {
      latest = useOverlayClock(p.clock, p.status, p.offset);
      return null;
    },
    { clock, status, offset },
  );
  return { island, read: () => latest };
}

const ANCHOR: NonNullable<Clock> = { phase: "H1", anchorSeconds: 761, anchorAtWallMs: 1_000_000 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("useOverlayClock", () => {
  it("shows the anchor at mount and advances by wall time on each 1 Hz tick", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(ANCHOR, "in_play");
    expect(h.read()).toBe("12:41");
    now.mockReturnValue(1_001_000); t.tick();
    expect(h.read()).toBe("12:42");
    now.mockReturnValue(1_017_000); t.tick();
    expect(h.read()).toBe("12:58");
    expect(t.armed()).toBe(1);
  });

  it("re-anchors on a push (a goal re-stamps asOf) instead of drifting from its own count", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(ANCHOR, "in_play");
    now.mockReturnValue(1_030_000); t.tick();
    expect(h.read()).toBe("13:11");
    // RE-PIN: the harness's prop-update call (`island.rerender` /
    // `island.update`, _hook-harness.tsx:388+) — use its real name.
    h.island.rerender({ clock: { phase: "H1", anchorSeconds: 1_800, anchorAtWallMs: 1_030_000 }, status: "in_play", offset: 0 });
    expect(h.read()).toBe("30:00");
  });

  it("holds the last displayed value at half-time (clock absent while in_play), and resumes on the next anchor", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(ANCHOR, "in_play");
    now.mockReturnValue(1_005_000); t.tick();
    expect(h.read()).toBe("12:46");
    h.island.rerender({ clock: undefined, status: "in_play", offset: 0 });
    expect(h.read(), "half-time: the cell holds, it does not blank").toBe("12:46");
    h.island.rerender({ clock: { phase: "H2", anchorSeconds: 2_700, anchorAtWallMs: 1_900_000 }, status: "in_play", offset: 0 });
    now.mockReturnValue(1_900_000);
    expect(h.read()).toBe("45:00");
  });

  it("shows nothing before kick-off and after the decision, whatever the anchor says", () => {
    stubTick();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(harness(undefined, "scheduled").read()).toBeNull();
    expect(harness(ANCHOR, "decided").read()).toBeNull();
    expect(harness(ANCHOR, "finalized").read()).toBeNull();
  });

  it("subtracts the presentation offset, so under delayMs the clock does not run ahead of the delayed goal", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_010_000);
    const h = harness(ANCHOR, "in_play", 3_000);
    // wall +10 s, offset 3 s → the PICTURE is at +7 s.
    expect(h.read()).toBe("12:48");
    now.mockReturnValue(1_011_000); t.tick();
    expect(h.read()).toBe("12:49");
  });

  it("never runs backwards: a wall clock behind the anchor reads the anchor", () => {
    stubTick();
    vi.spyOn(Date, "now").mockReturnValue(999_000);
    expect(harness(ANCHOR, "in_play").read()).toBe("12:41");
  });
});
