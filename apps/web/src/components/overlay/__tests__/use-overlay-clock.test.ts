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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useOverlayClock, NO_CLOCK_STATUSES, clockLabelAt, heldOffset } from "../use-overlay-clock";
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
  it("equals scheduled/decided/finalized/needs_decision plus the console's own VOID_STATUSES", () => {
    // W2a: a held fixture (`needs_decision`) has no play running — no clock.
    expect(NO_CLOCK_STATUSES).toEqual(new Set(["scheduled", "decided", "finalized", "needs_decision", ...VOID_STATUSES]));
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

// A 45-minute half, as `project.ts` now projects it (F16). Every case that
// wants the clock to ADVANCE needs the length, because without one the hook
// holds — which is the whole point of the last describe in this file.
const HALF_SECONDS = 45 * 60;
const ANCHOR: NonNullable<Clock> = {
  phase: "H1",
  anchorSeconds: 761,
  anchorAtWallMs: 1_000_000,
  nominalSeconds: HALF_SECONDS,
};

// A push re-reads the wall clock from a zero-delay timer (see the hook), so the
// timers are faked for the whole file: nothing may fire after its test ended.
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    h.island.rerender({ clock: { ...ANCHOR, anchorSeconds: 1_800, anchorAtWallMs: 1_030_000 }, status: "in_play", offset: 0 });
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
    h.island.rerender({ clock: { ...ANCHOR, phase: "H2", anchorSeconds: 2_700, anchorAtWallMs: 1_900_000 }, status: "in_play", offset: 0 });
    now.mockReturnValue(1_900_000);
    // Exactly the nominal length: the whistle minute is a real reading, not
    // added time — the ceiling is inclusive.
    expect(h.read()).toBe("45:00");
  });

  // ESLint L3: the label is now derived from (the clock being shown, the last
  // tick's wall time). The hold must therefore arm NOTHING and drop the running
  // timer — a live interval during half-time would creep the held reading.
  // `stubTick` above never really clears, so this case tracks clears itself.
  it("half-time HOLD clears the running timer and arms none — the held reading cannot creep; a no-clock status ends the hold", () => {
    let cb: (() => void) | null = null;
    let armed = 0;
    let lastId = 0;
    const cleared: number[] = [];
    vi.stubGlobal("setInterval", ((fn: () => void) => {
      cb = fn;
      armed += 1;
      lastId += 1;
      return lastId as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);
    vi.stubGlobal("clearInterval", ((id: number) => {
      cleared.push(id);
      if (id === lastId) cb = null;
    }) as unknown as typeof clearInterval);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(ANCHOR, "in_play");
    now.mockReturnValue(1_005_000);
    (cb as (() => void) | null)?.();
    expect(h.read()).toBe("12:46");

    h.island.rerender({ clock: undefined, status: "in_play", offset: 0 });
    expect(cleared, "the running timer must stop at the whistle").toEqual([1]);
    now.mockReturnValue(1_600_000);
    (cb as (() => void) | null)?.(); // only a still-armed interval could fire here
    expect(h.read()).toBe("12:46");
    // A second absent push holds the same reading.
    h.island.rerender({ clock: undefined, status: "in_play", offset: 0 });
    expect(h.read()).toBe("12:46");
    expect(armed, "nothing re-armed during the hold").toBe(1);

    // A status with no clock ends the hold for good: back in play without a
    // clock shows nothing, never the stale pre-whistle reading.
    h.island.rerender({ clock: undefined, status: "finalized", offset: 0 });
    expect(h.read()).toBeNull();
    h.island.rerender({ clock: undefined, status: "in_play", offset: 0 });
    expect(h.read()).toBeNull();
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

  it("holds at the stamped elapsed when running is false — and arms no timer", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const paused = { ...ANCHOR, running: false as const };
    const h = harness(paused, "in_play");
    expect(h.read()).toBe("12:41");
    expect(t.armed()).toBe(0);
    now.mockReturnValue(1_060_000);
    // No interval — wall time alone must not advance a paused clock.
    expect(h.read()).toBe("12:41");
    h.island.rerender({ clock: { ...paused, running: true }, status: "in_play", offset: 0 });
    expect(t.armed()).toBe(1);
    now.mockReturnValue(1_061_000);
    t.tick();
    expect(h.read()).toBe("13:42");
  });
});

// A push is read against NOW, not against the last tick. `tickAt` is set only by
// the 1 Hz interval, and the interval is not armed while a clock is absent,
// paused or unbounded — so a first live push, or a resume, was read against a
// tick minutes old, clamped to elapsed-zero, and showed the anchor ("45:00" for
// a true "45:03") until the next tick came a second later.
describe("useOverlayClock — a push is read against the wall clock now", () => {
  it("a first live push (no clock, then a clock) shows the elapsed time at once, not the bare anchor", () => {
    stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(undefined, "scheduled");
    expect(h.read()).toBeNull();
    // Three seconds pass with nothing armed — no tick has run since mount.
    now.mockReturnValue(1_003_000);
    h.island.rerender({ clock: ANCHOR, status: "in_play", offset: 0 });
    vi.advanceTimersByTime(0);
    // 761 s anchor + 3 s since it was stamped = 764 s = 12:44 (the bare anchor is 12:41).
    expect(h.read()).toBe("12:44");
  });

  it("a resume push (paused, then running) shows the elapsed time at once", () => {
    stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const paused = { ...ANCHOR, running: false as const };
    const h = harness(paused, "in_play");
    expect(h.read()).toBe("12:41");
    // Ten minutes of pause, then the resume is stamped and reaches us 3 s later.
    now.mockReturnValue(1_600_000);
    h.island.rerender({
      clock: { ...ANCHOR, running: true, anchorAtWallMs: 1_597_000 },
      status: "in_play",
      offset: 0,
    });
    vi.advanceTimersByTime(0);
    expect(h.read()).toBe("12:44");
  });

  it("the re-read is cancelled when the push is withdrawn first — a held reading cannot creep", () => {
    stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness(undefined, "scheduled");
    now.mockReturnValue(1_003_000);
    h.island.rerender({ clock: ANCHOR, status: "in_play", offset: 0 });
    // The whistle blows before the re-read fires: the clock is absent again.
    h.island.rerender({ clock: undefined, status: "in_play", offset: 0 });
    now.mockReturnValue(1_600_000);
    vi.advanceTimersByTime(0);
    // Held at what was last shown (anchor + 0 s against the unmoved tick), not 22:44.
    expect(h.read()).toBe("12:41");
  });
});

// F16 (product ruling 2026-09-10, `_THEMES.md` §3). Driven live on a real
// fixture the football clock read `1205:25` — twenty hours — because it ticks
// from the fold's anchor with no ceiling. A club that starts a match and never
// ends it is ordinary, and this is the one element on screen that keeps
// moving, so an absurd value is both the most visible defect and the most
// likely one.
describe("useOverlayClock — the ceiling (F16)", () => {
  /** The wall time that produced the live defect: 20 h 05 m after an anchor at
   *  12:41 of the half. `12:41 + 20h = 1205:25` — the exact number that was on
   *  air. */
  const TWENTY_HOURS_LATER = 1_000_000 + 20 * 60 * 60 * 1000;

  it("shows `45+` past the half's nominal length, never 1205:25", () => {
    stubTick();
    vi.spyOn(Date, "now").mockReturnValue(TWENTY_HOURS_LATER);
    const label = harness(ANCHOR, "in_play").read();
    expect(label, "the live defect, at the value it actually displayed").not.toBe("1205:25");
    expect(label).toBe("45+");
  });

  it("crosses over one second past the whistle, and not one second before it", () => {
    const t = stubTick();
    // 2699 s into a 2700 s half — still a digit.
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000 + (HALF_SECONDS - 1 - 761) * 1000);
    const h = harness(ANCHOR, "in_play");
    expect(h.read()).toBe("44:59");
    now.mockReturnValue(1_000_000 + (HALF_SECONDS - 761) * 1000); t.tick();
    expect(h.read(), "the whistle minute itself is a real reading").toBe("45:00");
    now.mockReturnValue(1_000_000 + (HALF_SECONDS + 1 - 761) * 1000); t.tick();
    expect(h.read()).toBe("45+");
  });

  it("takes the label from the fixture's OWN length — a 20-minute period reads `20+`", () => {
    // The differential that stops a hardcoded 45 passing: same anchor, same
    // wall time, different declared length, different label.
    stubTick();
    vi.spyOn(Date, "now").mockReturnValue(TWENTY_HOURS_LATER);
    const ice = { phase: "P1", anchorSeconds: 761, anchorAtWallMs: 1_000_000, nominalSeconds: 20 * 60 };
    expect(harness(ice, "in_play").read()).toBe("20+");
  });

  it("HOLDS at the anchor when no length is declared — and arms no timer at all", () => {
    // The fallback branch. `project.ts` emits a clock with no `nominalSeconds`
    // only for a state whose cfg it cannot read; without a bound the honest
    // reading is the last elapsed a scorer actually recorded, which still moves
    // on every push. A timer here would recompute one constant for the life of
    // an OBS browser source.
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(TWENTY_HOURS_LATER);
    const noLength: NonNullable<Clock> = { phase: "H1", anchorSeconds: 761, anchorAtWallMs: 1_000_000 };
    const h = harness(noLength, "in_play");
    expect(h.read(), "unbounded ticking is what put 1205:25 on air").toBe("12:41");
    expect(t.armed(), "no ceiling means nothing to advance towards").toBe(0);
    // A push still moves it — held, not frozen.
    now.mockReturnValue(TWENTY_HOURS_LATER);
    h.island.rerender({
      clock: { phase: "H1", anchorSeconds: 1_800, anchorAtWallMs: TWENTY_HOURS_LATER },
      status: "in_play",
      offset: 0,
    });
    expect(h.read()).toBe("30:00");
  });

  it("arms the timer again as soon as a push brings a length", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const h = harness({ phase: "H1", anchorSeconds: 761, anchorAtWallMs: 1_000_000 }, "in_play");
    expect(t.armed()).toBe(0);
    h.island.rerender({ clock: ANCHOR, status: "in_play", offset: 0 });
    expect(t.armed(), "the length is a dependency of the effect, not just of the reading").toBe(1);
    now.mockReturnValue(1_060_000); t.tick();
    expect(h.read()).toBe("13:41");
  });
});

// ---------------------------------------------------------------------------
// S2-5 ruling 110 — the viewers' overlay follows the SHARED football clock (design §7.2, §7.4, §10): the projection's
// anchor is the newest `football.clock` event at its server `recorded_at` (`server/overlay/project.ts`), and the label
// is read on the SERVER's clock (this machine's plus the measured offset), minus the presentation delay, in match time
// with ruling 109's added time. Every expected label below is worked by hand from those rules, never computed by the
// code under test. The cases above this line are other sports' (and football's before ruling 110), untouched.
// ---------------------------------------------------------------------------
const S0 = 1_000_000_000;
/** 2 × 45, no extra time: the wire's `matchTime`, as the projection copies it off the engine's cfg. */
const MT = { halves: 2 as const, halfMinutes: 45, extraTime: { enabled: false, halfMinutes: 15 } };
/** Start at H1 600 s, recorded at S0 (server time). */
const FOOTBALL: NonNullable<Clock> = {
  phase: "H1",
  anchorSeconds: 600,
  anchorAtWallMs: S0,
  running: true,
  nominalSeconds: 45 * 60,
  matchTime: MT,
};

function footballHarness(clock: Clock, serverOffsetMs: () => number | null, delayMs = 0) {
  let latest: string | null = null;
  const island = renderIsland(
    (p: { clock: Clock }) => {
      latest = useOverlayClock(p.clock, "in_play", delayMs, serverOffsetMs);
      return null;
    },
    { clock },
  );
  return { island, read: () => latest };
}

describe("useOverlayClock — football follows the shared clock (S2-5 ruling 110)", () => {
  it("a football overlay reads match time: {H2, 0} reads 45:00, {H2, 2850} paused reads 90+2:30", () => {
    expect(clockLabelAt({ ...FOOTBALL, phase: "H2", anchorSeconds: 0, running: false }, S0, 0, null)).toBe("45:00");
    expect(clockLabelAt({ ...FOOTBALL, phase: "H2", anchorSeconds: 2_850, running: false }, S0, 0, null)).toBe("90+2:30");
    // Running from {H2, 0}: 61 s on the server's clock is 46:01.
    expect(clockLabelAt({ ...FOOTBALL, phase: "H2", anchorSeconds: 0 }, S0 + 61_000, 0, 0)).toBe("46:01");
  });

  it("the widest reading the bug must hold: the second half of extra time, 15 minutes over, reads 120+15:00", () => {
    const et = { ...MT, extraTime: { enabled: true, halfMinutes: 15 } };
    // ET_H2 starts at 105:00 and ends at 120:00; 1 800 s into it is 15:00 past its end.
    expect(clockLabelAt({ ...FOOTBALL, phase: "ET_H2", anchorSeconds: 1_800, running: false, matchTime: et }, S0, 0, null)).toBe(
      "120+15:00",
    );
  });

  it("a viewer machine 5 minutes fast reads the server's clock, the same label as a correct machine", () => {
    stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(S0 + 130_000);
    const correct = footballHarness(FOOTBALL, () => 0);
    expect(correct.read(), "a correct machine at S0 + 130 s: 600 + 130").toBe("12:10");
    correct.island.unmount();

    now.mockReturnValue(S0 + 300_000 + 130_000); // the same instant, on a machine five minutes fast
    const fast = footballHarness(FOOTBALL, () => -300_000);
    expect(fast.read(), "through the offset: the server's S0 + 130 s").toBe("12:10");
    expect(fast.read(), "not this machine's own clock, five minutes on (600 + 430)").not.toBe("17:10");
  });

  it("the delay offset still applies on top of the server offset", () => {
    stubTick();
    // Server now is S0 + 160 s (this machine reads it five minutes fast); the picture is 30 s behind: S0 + 130 s.
    vi.spyOn(Date, "now").mockReturnValue(S0 + 300_000 + 160_000);
    const h = footballHarness(FOOTBALL, () => -300_000, 30_000);
    expect(h.read()).toBe("12:10");
  });

  it("a paused football clock holds, and arms no timer", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(S0 + 5_000);
    const h = footballHarness({ ...FOOTBALL, anchorSeconds: 761, running: false }, () => -300_000);
    expect(h.read()).toBe("12:41");
    now.mockReturnValue(S0 + 600_000);
    vi.advanceTimersByTime(0);
    expect(h.read(), "wall time alone never moves a paused clock").toBe("12:41");
    expect(t.armed(), "no 1 Hz tick for a paused clock").toBe(0);
  });

  it("an offset that forms after mount is taken at the next tick; it is held until it moves by 1 s or more", () => {
    const t = stubTick();
    let measured: number | null = null;
    // The machine is five minutes fast; until a poll is answered there is no offset, and it reads its own clock.
    const now = vi.spyOn(Date, "now").mockReturnValue(S0 + 300_000 + 130_000);
    const h = footballHarness(FOOTBALL, () => measured);
    expect(h.read(), "no offset yet: this machine's clock (600 + 430)").toBe("17:10");
    measured = -300_000;
    now.mockReturnValue(S0 + 300_000 + 131_000); t.tick();
    expect(h.read(), "the offset forms: the server's S0 + 131 s").toBe("12:11");
    measured = -300_400; // a 400 ms move: held at -300 000 (read through -300 400 it would show 12:11 again)
    now.mockReturnValue(S0 + 300_000 + 132_000); t.tick();
    expect(h.read()).toBe("12:12");
    measured = -301_500; // a 1 500 ms move from the held offset: taken (held, it would show 12:13)
    now.mockReturnValue(S0 + 300_000 + 133_000); t.tick();
    expect(h.read()).toBe("12:11");
    measured = null; // a measurement that goes back to unknown keeps the held offset
    now.mockReturnValue(S0 + 300_000 + 134_000); t.tick();
    expect(h.read()).toBe("12:12");
  });

  it("a football clock ticks on its match time even with no nominal length on the wire", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(S0 + 130_000);
    const h = footballHarness({ ...FOOTBALL, nominalSeconds: undefined }, () => 0);
    expect(h.read()).toBe("12:10");
    now.mockReturnValue(S0 + 131_000); t.tick();
    expect(h.read(), "it advances: a football cfg always has its lengths").toBe("12:11");
    expect(t.armed()).toBe(1);
  });

  it("a poll that brings a different football cfg is a new clock: 30-minute halves start the second half at 30:00", () => {
    stubTick();
    vi.spyOn(Date, "now").mockReturnValue(S0);
    const second = { ...FOOTBALL, phase: "H2", anchorSeconds: 0, running: false };
    const h = footballHarness(second, () => 0);
    expect(h.read()).toBe("45:00");
    h.island.rerender({ clock: { ...second, matchTime: { ...MT, halfMinutes: 30 } } });
    expect(h.read()).toBe("30:00");
    // The hold keeps what was last SHOWN — the new cfg's reading, not the first poll's.
    h.island.rerender({ clock: undefined });
    expect(h.read(), "held across a clockless poll").toBe("30:00");
  });

  it("heldOffset: the pad's re-seat rule — forms, then moves by OFFSET_RESEAT_MS (1 000 ms) or more", () => {
    expect(heldOffset(null, null)).toBeNull();
    expect(heldOffset(null, -300_000)).toBe(-300_000);
    expect(heldOffset(-300_000, null)).toBe(-300_000);
    expect(heldOffset(-300_000, -300_999)).toBe(-300_000);
    expect(heldOffset(-300_000, -301_000)).toBe(-301_000);
    expect(heldOffset(-300_000, -299_000)).toBe(-299_000);
  });

  it("a non-football clock never reads the server offset: the same reading as with none", () => {
    // ANCHOR is the file's own (H1 761 at 1 000 000, a 45-minute half, no matchTime). Five seconds on it reads 12:46,
    // as the first case of this file reads it; an offset of five minutes must change nothing.
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let latest: string | null = null;
    renderIsland(
      (p: { clock: Clock }) => {
        latest = useOverlayClock(p.clock, "in_play", 0, () => -300_000);
        return null;
      },
      { clock: ANCHOR },
    );
    now.mockReturnValue(1_005_000); t.tick();
    expect(latest).toBe("12:46");
  });

  it("a non-football fixture keeps formatClockCapped's `45+` past the nominal, whatever the offset", () => {
    const t = stubTick();
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    let latest: string | null = null;
    renderIsland(
      (p: { clock: Clock }) => {
        latest = useOverlayClock(p.clock, "in_play", 0, () => -300_000);
        return null;
      },
      // 2 690 s at 2 000 000: twenty seconds on is 2 710 s, past the 2 700 s half. Read through the offset it would sit
      // at the anchor, 44:50; without it, it is in added time.
      { clock: { ...ANCHOR, anchorSeconds: 2_690, anchorAtWallMs: 2_000_000 } },
    );
    now.mockReturnValue(2_020_000); t.tick();
    expect(latest).toBe("45+");
  });
});

