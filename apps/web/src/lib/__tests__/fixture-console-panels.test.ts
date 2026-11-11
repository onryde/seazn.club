// The fixture console's header panel bar (owner request 2026-11-11): five panels, ONE open at a time, same button
// order for every sport, Remote scoring alone closes itself after 20 s idle, and leaving the Lineup panel with unsaved
// edits asks first. Expected values are literals from the owner's request, never read back from the code under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextOpenPanel, type OpenPanel } from "@/lib/fixture-stream-mount";
import {
  PANEL_ORDER,
  REMOTE_SCORING_IDLE_MS,
  autoCloseMsFor,
  remoteScoringIdleMs,
  createIdleTimer,
  idleActivityHandlers,
  offeredPanels,
  requestPanel,
  type PanelKey,
} from "@/lib/fixture-console-panels";

const ALL: PanelKey[] = ["stream", "handover", "lineup", "rules", "actions"];

describe("button order", () => {
  it("is Stream · Remote scoring · Lineup · Match rules · Match actions", () => {
    expect([...PANEL_ORDER]).toEqual(["stream", "handover", "lineup", "rules", "actions"]);
  });

  it("offeredPanels keeps that order for every one of the 32 offer combinations, and drops only what is not offered", () => {
    let checked = 0;
    for (let mask = 0; mask < 32; mask++) {
      const offer = Object.fromEntries(ALL.map((k, i) => [k, (mask & (1 << i)) !== 0])) as Record<PanelKey, boolean>;
      const got = offeredPanels(offer);
      expect(got, `mask ${mask}`).toEqual(ALL.filter((k) => offer[k]));
      checked++;
    }
    expect(checked).toBe(32);
  });
});

describe("ONE panel open at a time (5 x 5 sequence)", () => {
  it("after opening each panel from every starting state, exactly the clicked one is open; clicking it again closes it", () => {
    let steps = 0;
    for (const from of [null, ...ALL] as OpenPanel[]) {
      for (const clicked of ALL) {
        const after = nextOpenPanel(from, clicked);
        // exactly one panel is open (a single value), and it is not the previous one unless that was the one clicked
        expect(after === null ? 0 : ALL.filter((k) => k === after).length).toBe(from === clicked ? 0 : 1);
        expect(after).toBe(from === clicked ? null : clicked);
        steps++;
      }
    }
    expect(steps).toBe(30);
  });

  it("a walk through all five in turn leaves exactly one open after every step, Match actions included", () => {
    let open: OpenPanel = null;
    const seen: OpenPanel[] = [];
    for (const k of [...ALL, ...ALL.slice(0, -1).reverse()]) {
      open = nextOpenPanel(open, k);
      seen.push(open);
      expect(open).toBe(k);
    }
    expect(seen).toHaveLength(9);
  });
});

describe("Remote scoring idle auto-close", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only Remote scoring closes itself, after 20 s", () => {
    expect(REMOTE_SCORING_IDLE_MS).toBe(20_000);
    // The DEFAULT is pinned (rule 20), not the live value: no override, no env => 20 s.
    expect(remoteScoringIdleMs(undefined, undefined)).toBe(20_000);
    expect(ALL.map((k) => [k, autoCloseMsFor(k)])).toEqual([
      ["stream", null],
      ["handover", 20_000],
      ["lineup", null],
      ["rules", null],
      ["actions", null],
    ]);
  });

  it("fires 20 s after the last interaction, not 20 s after opening", () => {
    const onIdle = vi.fn();
    const t = createIdleTimer(REMOTE_SCORING_IDLE_MS, onIdle);
    t.restart();
    vi.advanceTimersByTime(19_000);
    t.restart(); // an interaction at 19 s
    vi.advanceTimersByTime(19_000); // 38 s after opening: would have fired at 20 s without the restart
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1); // one-shot
  });

  it("pointer, keyboard, focus, copy, scroll, wheel and touch inside the panel each restart the timer (the wrapper's real handlers)", () => {
    const restart = vi.fn();
    const h = idleActivityHandlers(restart);
    const names = Object.keys(h).sort();
    expect(names).toEqual(
      [
        "onClickCapture",
        "onCopyCapture",
        "onFocusCapture",
        "onKeyDownCapture",
        "onPointerDownCapture",
        "onPointerMoveCapture",
        "onScrollCapture",
        "onTouchStartCapture",
        "onWheelCapture",
      ],
    );
    for (const n of names) (h as Record<string, () => void>)[n]!();
    expect(restart).toHaveBeenCalledTimes(9);
  });

  it("stop() cancels it", () => {
    const onIdle = vi.fn();
    const t = createIdleTimer(1000, onIdle);
    t.restart();
    t.stop();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("leaving the Lineup panel with unsaved edits asks first", () => {
  it("clean: the click goes through; dirty: any way out is held for the prompt, nothing changes", () => {
    let held = 0;
    let passed = 0;
    for (const clicked of [...ALL, "close"] as const) {
      const clean = requestPanel("lineup", clicked, false);
      expect(clean.confirm).toBe(false);
      expect(clean.next).toBe(clicked === "lineup" || clicked === "close" ? null : clicked);
      passed++;
      const dirty = requestPanel("lineup", clicked, true);
      expect(dirty).toEqual({ next: "lineup", confirm: true });
      held++;
    }
    expect(passed).toBe(6);
    expect(held).toBe(6);
  });

  it("dirty edits only matter while Lineup is the open panel", () => {
    for (const current of [null, "stream", "handover", "rules", "actions"] as OpenPanel[]) {
      expect(requestPanel(current, "lineup", true)).toEqual({ next: "lineup", confirm: false });
    }
    expect(requestPanel("rules", "close", true)).toEqual({ next: null, confirm: false });
  });
});

describe("Remote scoring idle delay is tunable for e2e", () => {
  it("a positive override wins (window first, then env); anything else falls back to the 20 s default", () => {
    expect(remoteScoringIdleMs(3_600_000, undefined)).toBe(3_600_000);
    expect(remoteScoringIdleMs(undefined, "5000")).toBe(5000);
    expect(remoteScoringIdleMs(111, "5000")).toBe(111);
    const bad: unknown[] = [0, -1, NaN, Infinity, "", "abc", null, {}];
    for (const v of bad) expect(remoteScoringIdleMs(v, v), `bad override ${String(v)}`).toBe(REMOTE_SCORING_IDLE_MS);
    expect(bad.length).toBeGreaterThan(0);
  });
});

describe("createIdleTimer with its DEFAULT timers (browser `this` rule)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls setTimeout/clearTimeout detached from the timers object: a browser throws Illegal invocation otherwise", () => {
    const calls: string[] = [];
    const strict = (name: string) =>
      function (this: unknown) {
        if (this !== globalThis) throw new TypeError("Illegal invocation");
        calls.push(name);
        return 1;
      };
    vi.stubGlobal("setTimeout", strict("set"));
    vi.stubGlobal("clearTimeout", strict("clear"));
    const t = createIdleTimer(1000, () => {});
    expect(() => t.restart()).not.toThrow();
    expect(() => t.restart()).not.toThrow(); // second arm also clears the first
    expect(() => t.stop()).not.toThrow();
    expect(calls).toEqual(["set", "clear", "set", "clear"]);
  });
});
