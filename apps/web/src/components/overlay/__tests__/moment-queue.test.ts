// The moment queue — a PURE reducer (stream overlay W2 Task 4).
//
// Pure on purpose. `apps/web` vitest is `environment: "node"`, so nothing here
// can see a rendered slab; the whole of the wave's timing logic therefore lives
// in a function this file can drive, and the hook around it is thin enough to
// be proven by the e2e instead. A reducer that needed a DOM to test would have
// put the queue beyond reach of every test in this repo.
import { describe, expect, it } from "vitest";
import { INITIAL, momentQueueReducer as reduce, nextDeadline } from "../moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "../moment-timing";
import type { OverlayMoment } from "@/lib/overlay-moments";
import { slabPlacementFor } from "../theme-registry";
import { builtinModules } from "@seazn/engine/sports";

const m = (seq: number, kind = "goal"): OverlayMoment => ({
  seq,
  kind,
  headline: kind.toUpperCase(),
  tone: "led",
});
const T = { foldMs: OVERLAY_MOMENT_FOLD_MS, holdMs: OVERLAY_MOMENT_HOLD_MS };
const enqueue = (state: typeof INITIAL, moments: OverlayMoment[], now: number) =>
  reduce(state, { type: "enqueue", moments, now, ...T });
const tick = (state: typeof INITIAL, now: number) => reduce(state, { type: "tick", now, ...T });

/** Idle, ignoring `seen` — which by design does NOT reset, and is exactly what
 *  stops the transport's repeated window re-firing a slab it has shown. */
const IDLE = { current: null, queue: [], deadline: null };

describe("the timing constants", () => {
  it("hold is four seconds and the fold a quarter — pinned on the DEFAULTS", () => {
    // The e2e's budget is derived from these, so moving one moves the budget
    // with it rather than leaving a flat timeout beside a derived cost.
    expect(OVERLAY_MOMENT_HOLD_MS).toBe(4_000);
    expect(OVERLAY_MOMENT_FOLD_MS).toBe(250);
  });
});

describe("momentQueueReducer", () => {
  it("idle → in → hold → out → idle, each on its own deadline", () => {
    let s = enqueue(INITIAL, [m(1)], 0);
    expect(s).toMatchObject({ current: m(1), phase: "in", deadline: 250 });
    s = tick(s, 250);
    expect(s).toMatchObject({ phase: "hold", deadline: 4_250 });
    s = tick(s, 4_000);
    expect(s.phase, "a tick BEFORE the deadline changes nothing").toBe("hold");
    s = tick(s, 4_250);
    expect(s).toMatchObject({ phase: "out", deadline: 4_500 });
    s = tick(s, 4_500);
    expect(s).toMatchObject(IDLE);
  });

  it("FIFO: the second moment starts only once the first has folded away", () => {
    let s = enqueue(INITIAL, [m(1, "goal"), m(2, "card.yellow")], 0);
    expect(s.current, "the head shows at once").toMatchObject({ seq: 1 });
    expect(s.queue.map((q) => q.seq), "the rest wait").toEqual([2]);
    for (const now of [250, 4_250, 4_500]) s = tick(s, now);
    expect(s).toMatchObject({ current: m(2, "card.yellow"), phase: "in" });
    expect(s.queue).toEqual([]);
  });

  it("FIFO holds ACROSS batches — a later arrival goes behind what is already waiting", () => {
    // The single-batch case cannot see this: with an empty queue, prepending
    // and appending give the same list. Two batches are what tell them apart,
    // and two batches is the ordinary case — the transport polls.
    let s = enqueue(INITIAL, [m(1, "goal"), m(2, "six")], 0);
    s = enqueue(s, [m(3, "four")], 1_000);
    expect(s.queue.map((q) => q.seq)).toEqual([2, 3]);
  });

  it("a moment arriving mid-slab QUEUES rather than interrupting the one on air", () => {
    let s = enqueue(INITIAL, [m(1)], 0);
    s = tick(s, 250);
    s = enqueue(s, [m(2, "six")], 1_000);
    expect(s).toMatchObject({ current: m(1), phase: "hold", deadline: 4_250 });
    expect(s.queue.map((q) => q.seq)).toEqual([2]);
  });

  it("the same moment enqueued twice is shown ONCE — a poll that repeats the window must not repeat the slab", () => {
    // The transport re-sends the whole `recent` window on every tick. Without
    // this the same six would fire every 15 seconds for as long as it stayed in
    // the window.
    let s = enqueue(INITIAL, [m(1, "six")], 0);
    s = enqueue(s, [m(1, "six")], 100);
    expect(s.queue).toEqual([]);
    s = enqueue(s, [m(1, "six"), m(2, "four")], 200);
    expect(s.queue.map((q) => q.seq)).toEqual([2]);
  });

  it("dedupe is on seq AND kind — ONE event can raise two moments and both must show", () => {
    // A set-winning point raises the set won and the match point it opens, on
    // the same `seq`. Deduping on seq alone would silently drop one.
    const s = enqueue(INITIAL, [
      { seq: 50, kind: "setWon", headline: "SET 1", tone: "led" },
      { seq: 50, kind: "point.match", headline: "MATCH POINT", tone: "led" },
    ], 0);
    expect(s.current?.kind).toBe("setWon");
    expect(s.queue.map((q) => q.kind)).toEqual(["point.match"]);
    // And the batch dedupes against ITSELF, not only against history: a
    // genuinely repeated moment inside one array is still shown once.
    const twice = enqueue(INITIAL, [m(9, "six"), m(9, "six")], 0);
    expect(twice.queue).toEqual([]);
    expect(twice.current).toMatchObject({ seq: 9 });
  });

  it("a moment already SHOWN is not re-shown after it leaves the queue", () => {
    let s = enqueue(INITIAL, [m(7, "six")], 0);
    for (const now of [250, 4_250, 4_500]) s = tick(s, now);
    expect(s).toMatchObject(IDLE);
    s = enqueue(s, [m(7, "six")], 5_000);
    expect(s.current, "the window still carries it; it has had its turn").toBeNull();
  });

  it("enqueueing nothing is a no-op, and ticking an idle queue is too", () => {
    expect(enqueue(INITIAL, [], 0)).toEqual(INITIAL);
    expect(tick(INITIAL, 9_999)).toEqual(INITIAL);
  });

  it("`foldMs: 0` (reduced motion) still passes through every phase", () => {
    // The phases are the CONTRACT — the e2e reads `data-phase` — so reduced
    // motion must shorten them, never skip them.
    const R = { foldMs: 0, holdMs: OVERLAY_MOMENT_HOLD_MS };
    let s = reduce(INITIAL, { type: "enqueue", moments: [m(1)], now: 0, ...R });
    expect(s).toMatchObject({ phase: "in", deadline: 0 });
    s = reduce(s, { type: "tick", now: 0, ...R });
    expect(s).toMatchObject({ phase: "hold", deadline: 4_000 });
    s = reduce(s, { type: "tick", now: 4_000, ...R });
    expect(s.phase).toBe("out");
    s = reduce(s, { type: "tick", now: 4_000, ...R });
    expect(s).toMatchObject(IDLE);
  });

  it("nextDeadline is the timer's ONLY input — null when idle, the deadline otherwise", () => {
    expect(nextDeadline(INITIAL)).toBeNull();
    const s = enqueue(INITIAL, [m(1)], 1_000);
    expect(nextDeadline(s)).toBe(1_250);
  });

  it("a LATE tick that overshoots several deadlines advances one phase, not all of them", () => {
    // A backgrounded OBS source gets no timers. On return the clock has jumped
    // minutes; the slab must not skip its phases in one frame and flash.
    let s = enqueue(INITIAL, [m(1)], 0);
    s = tick(s, 600_000);
    expect(s).toMatchObject({ phase: "hold", deadline: 604_000 });
    // And the NEXT phase still waits its own hold out — the overshoot is not
    // carried forward as credit.
    s = tick(s, 601_000);
    expect(s.phase, "still holding: 601s is inside the new deadline").toBe("hold");
    s = tick(s, 604_000);
    expect(s).toMatchObject({ phase: "out" });
  });
});

describe("slabPlacementFor — which scorebug the slab attaches to", () => {
  it("bar and bug answer for themselves", () => {
    expect(slabPlacementFor("bar", "cricket")).toBe("bar");
    expect(slabPlacementFor("bug", "cricket")).toBe("bug");
    expect(slabPlacementFor("bar", "football")).toBe("bar");
    expect(slabPlacementFor("bug", "football")).toBe("bug");
  });

  it("SLATE paints no scorebug — it composites one, and the slab follows THAT", () => {
    // §4a: slate renders `defaultThemeFor(sportKey)` on top of itself. Reading
    // `?style=` alone gave the slab bar geometry under slate while the BUG was
    // on screen — wrong for ten of the eleven sports, and right for cricket
    // only by accident, which is why both halves are asserted here.
    expect(slabPlacementFor("slate", "cricket"), "cricket composites the bar").toBe("bar");
    for (const sport of ["football", "hockey", "tennis", "badminton", "volleyball"]) {
      expect(slabPlacementFor("slate", sport), `${sport} composites the bug`).toBe("bug");
    }
  });

  it("every sport the registry serves resolves to a placement the CSS defines", () => {
    // A third placement would render an unstyled slab rather than fail.
    for (const style of ["bar", "bug", "slate"] as const) {
      for (const sport of builtinModules.map((m) => m.key)) {
        expect(["bar", "bug"]).toContain(slabPlacementFor(style, sport));
      }
    }
  });
});
