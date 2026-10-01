// W1-driving Task 11 (ruling 46, D10): runQueue — N in-process workers, each
// opened once, pulling the next plan item off a shared cursor, results stored
// by plan index. The state transitions, empty case first:
//   no items → no worker opened, [];
//   items → each worker opened at most once, never more workers than items;
//   an item finishes → its result lands at ITS plan index, whatever finished first;
//   an item throws → crashed(item, index, error) at its index, every other index kept;
//   crashed or open throws → the queue ABORTS: no further item starts, the
//     in-flight ones finish, and runQueue rejects with that error;
//   a second call on the same inputs → the same answer (no state carried over).
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WORKERS, TurnDeadlineExceeded, WorkersOutOfRange, oneAtATime, runQueue } from "../lib/workers.ts";

/** A deadline no task in these tests comes near: they settle in microtasks. */
const ROOMY_MS = 60_000;

/** Yields to the microtask queue `n` times: an interleaving the property picks, deterministic per seed. */
async function yields(n: number): Promise<void> {
  for (let k = 0; k < n; k++) await Promise.resolve();
}

describe("runQueue — empty case first", () => {
  it("empty case first: no items opens no worker and returns []", async () => {
    let opened = 0;
    expect(await runQueue([], 4, async () => { opened++; return {}; }, async () => 1, () => 0)).toEqual([]);
    expect(opened).toBe(0);
  });
});

describe("runQueue", () => {
  it("results land in plan order whatever finishes first", async () => {
    const delays = [30, 5, 20, 1, 10];
    const finished: number[] = [];
    const out = await runQueue(delays, 3, async (n) => n, async (_w, d, i) => { await new Promise((r) => setTimeout(r, d)); finished.push(i); return i; }, () => -1);
    expect(out).toEqual([0, 1, 2, 3, 4]);
    // The case has teeth only if completion order differed from plan order.
    expect(finished).not.toEqual([0, 1, 2, 3, 4]);
  });
  it("each worker opens once and is reused; never more workers than items", async () => {
    const opened: number[] = [];
    await runQueue([1, 2], 5, async (n) => { opened.push(n); return n; }, async () => 0, () => -1);
    expect(opened.sort()).toEqual([0, 1]);
  });
  it("…and over more items than workers, each of the N workers is opened exactly once and every item runs on one of them", async () => {
    const opened: number[] = [];
    const ranOn: number[] = [];
    await runQueue([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { opened.push(n); return n; }, async (w, _x, i) => { await yields(i % 3); ranOn.push(w); return w; }, () => -1);
    expect(opened.sort()).toEqual([0, 1, 2]);
    expect(ranOn).toHaveLength(7);
    expect(new Set(ranOn)).toEqual(new Set([0, 1, 2]));
  });
  it("a crash keeps every other index in place and is recorded at its own", async () => {
    const out = await runQueue(["a", "boom", "c"], 2, async () => null, async (_w, x) => { if (x === "boom") throw new Error("x"); return x; }, (x, i) => `crashed ${x}@${i}`);
    expect(out).toEqual(["a", "crashed boom@1", "c"]);
  });
  it("crashed receives the error the item threw", async () => {
    const seen: unknown[] = [];
    const err = new Error("the item's own error");
    await runQueue([1], 1, async () => null, async () => { throw err; }, (_x, _i, e) => { seen.push(e); return 0; });
    expect(seen).toEqual([err]);
  });
  it("workers outside 1..MAX_WORKERS are refused by name", async () => {
    await expect(runQueue([1], 0, async () => 0, async () => 0, () => 0)).rejects.toBeInstanceOf(WorkersOutOfRange);
    await expect(runQueue([1], MAX_WORKERS + 1, async () => 0, async () => 0, () => 0)).rejects.toBeInstanceOf(WorkersOutOfRange);
  });
  it("a fractional or non-numeric worker count is refused by name too, and the message names the bound", async () => {
    let checked = 0;
    for (const n of [1.5, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await expect(runQueue([1], n, async () => 0, async () => 0, () => 0), String(n)).rejects.toThrow(`is outside 1..${MAX_WORKERS}`);
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("MAX_WORKERS is 8 (ruling 46's local-env bound) and both ends of 1..8 are accepted", async () => {
    expect(MAX_WORKERS).toBe(8);
    expect(await runQueue([1, 2], 1, async () => 0, async (_w, x) => x, () => 0)).toEqual([1, 2]);
    expect(await runQueue([1, 2], MAX_WORKERS, async () => 0, async (_w, x) => x, () => 0)).toEqual([1, 2]);
  });
  it("a second call on the same inputs gives the same answer and opens its own workers again", async () => {
    let opened = 0;
    const call = () => runQueue([3, 1, 2], 2, async () => { opened++; return null; }, async (_w, x, i) => { await yields(x); return `${x}@${i}`; }, () => "x");
    expect(await call()).toEqual(["3@0", "1@1", "2@2"]);
    expect(await call()).toEqual(["3@0", "1@1", "2@2"]);
    expect(opened).toBe(4);
  });
});

describe("runQueue — an abort stops the queue (the run's environment refusals)", () => {
  it("crashed that THROWS aborts: runQueue rejects with that error, no later item starts, and the in-flight one finishes first", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const abort = new Error("the environment, not this case");
    const p = runQueue([0, 1, 2, 3, 4, 5], 2, async () => null, async (_w, x, i) => {
      started.push(i);
      await yields(i === 0 ? 1 : 6);
      if (x === 0) throw new Error("item 0");
      finished.push(i);
      return x;
    }, () => { throw abort; });
    await expect(p).rejects.toBe(abort);
    // Lane 0 aborted after item 0; lane 1 was running item 1 and finished it, then took nothing more.
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([1]);
  });
  it("a worker that cannot open aborts the same way: the open's error, and no item started after it", async () => {
    const started: number[] = [];
    const refused = new Error("sign-in refused");
    const p = runQueue([0, 1, 2, 3], 2, async (n) => { if (n === 1) { await yields(1); throw refused; } return n; }, async (_w, _x, i) => { started.push(i); await yields(4); return i; }, () => -1);
    await expect(p).rejects.toBe(refused);
    expect(started).toEqual([0]);
  });
});

describe("runQueue — rule 10: interleaved completions, crashes, aborts and worker counts", () => {
  // One generated run: n items, w workers, each item a number of yields (its
  // completion order), a subset that throw, and optionally one whose crash
  // aborts. Invariants after EVERY step (each item start and finish), and on
  // the outcome. Reach counts below prove each shape was exercised.
  const shape = fc.record({
    items: fc.array(fc.record({ yields: fc.nat({ max: 8 }), fails: fc.boolean() }), { minLength: 0, maxLength: 20 }),
    workers: fc.integer({ min: 1, max: MAX_WORKERS }),
    abortAt: fc.option(fc.nat({ max: 19 }), { nil: null }),
  });

  it("results come back in plan order, every item runs exactly once, crashes map through crashed, and an abort stops the queue — reach counted", async () => {
    const reach = { runs: 0, empty: 0, items: 0, crashes: 0, aborts: 0, outOfOrder: 0, concurrent: 0, fewerItemsThanWorkers: 0 };
    await fc.assert(fc.asyncProperty(shape, async ({ items, workers, abortAt }) => {
      const n = items.length;
      const abortIndex = abortAt !== null && abortAt < n && items[abortAt]!.fails ? abortAt : null;
      const runs = new Array<number>(n).fill(0);
      const crashedAt = new Array<number>(n).fill(0);
      const finishOrder: number[] = [];
      const opened: number[] = [];
      let active = 0;
      let maxActive = 0;
      let abortRaised = false;
      let startedAfterAbort = 0;
      const abortError = new Error("abort");
      const step = (): void => {
        // After every step: never more items in flight than workers, and never an item run twice.
        expect(active).toBeLessThanOrEqual(workers);
        expect(runs.every((r) => r <= 1)).toBe(true);
      };
      const outcome = await runQueue(items, workers, async (w) => { opened.push(w); return w; }, async (_w, item, i) => {
        if (abortRaised) startedAfterAbort++;
        runs[i]!++;
        active++;
        maxActive = Math.max(maxActive, active);
        step();
        await yields(item.yields);
        active--;
        finishOrder.push(i);
        step();
        if (item.fails) throw new Error(`fail ${i}`);
        return `ok ${i}`;
      }, (item, i, e) => {
        crashedAt[i]!++;
        expect(e).toEqual(new Error(`fail ${i}`));
        expect(item).toBe(items[i]);
        if (i === abortIndex) { abortRaised = true; throw abortError; }
        return `crashed ${i}`;
      }).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));

      // Never more workers opened than the bound or the items, and each opened once.
      expect(opened.length).toBeLessThanOrEqual(Math.min(workers, n));
      expect(new Set(opened).size).toBe(opened.length);
      expect(active).toBe(0); // every started item finished before runQueue settled
      expect(startedAfterAbort).toBe(0);
      if (abortIndex === null) {
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return false;
        expect(opened.length).toBe(Math.min(workers, n));
        // Plan order: index i holds item i's own result, whatever finished first.
        expect(outcome.r).toEqual(items.map((it, i) => (it.fails ? `crashed ${i}` : `ok ${i}`)));
        // Exactly once, each.
        expect(runs.every((r) => r === 1)).toBe(true);
        expect(crashedAt).toEqual(items.map((it) => (it.fails ? 1 : 0)));
        reach.crashes += items.filter((it) => it.fails).length;
      } else {
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return false;
        expect(outcome.e).toBe(abortError);
        // An abort never re-runs an item, and never runs the aborting one twice.
        expect(runs.every((r) => r <= 1)).toBe(true);
        expect(runs[abortIndex]).toBe(1);
        reach.aborts++;
      }
      reach.runs++;
      reach.items += n;
      if (n === 0) reach.empty++;
      if (n < workers) reach.fewerItemsThanWorkers++;
      if (finishOrder.some((x, k) => k > 0 && x < finishOrder[k - 1]!)) reach.outOfOrder++;
      if (maxActive > 1) reach.concurrent++;
      return true;
    }), { numRuns: 300, seed: Number(process.env.MATRIX_FC_SEED ?? 20261001) });
    // Anti-vacuity: every shape the property claims to cover was reached.
    expect(reach.runs).toBe(300);
    for (const [k, v] of Object.entries(reach)) expect(v, `reach.${k}`).toBeGreaterThan(0);
  });
});

// Found live at T11 Step 7 (w1drv-t11-w3): the case-org provision's
// entitlement bust flips the run's ONE owner to staff for two admin calls and
// back (scripts/bench/lib/plan.ts bustOrgEntitlements). Workers share that
// owner, so one worker's demotion landed inside another's window and the
// admin route answered 401 "Staff access required". oneAtATime is the lock
// that keeps those windows apart. Transitions, empty case first: never
// called; called while idle; called while busy (queued, FIFO); a task that
// rejects (its caller sees it, the next still runs); called again after it drained.
describe("oneAtATime — a run-wide lock for a resource the workers share", () => {
  it("empty case first: an idle lock (nothing queued) starts the first task at once and hands back its answer", async () => {
    const lock = oneAtATime("t", ROOMY_MS);
    let started = false;
    const p = lock(async () => { started = true; return "first"; });
    await yields(2);
    expect(started).toBe(true);
    expect(await p).toBe("first");
  });
  it("concurrent tasks never overlap, run in call order, and each caller gets its own task's answer", async () => {
    const lock = oneAtATime("t", ROOMY_MS);
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const task = (n: number, wait: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(n);
      await yields(wait);
      active--;
      return n * 10;
    };
    // The first waits longest: without the lock the others would start (and finish) inside it.
    const out = await Promise.all([lock(task(1, 9)), lock(task(2, 1)), lock(task(3, 4))]);
    expect(out).toEqual([10, 20, 30]);
    expect(order).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });
  it("a task that rejects rejects ITS caller only; the next queued task still runs, and the lock is free afterwards", async () => {
    const lock = oneAtATime("t", ROOMY_MS);
    const boom = new Error("bust refused");
    const ran: string[] = [];
    const first = lock(async () => { ran.push("a"); await yields(2); throw boom; });
    const second = lock(async () => { ran.push("b"); return "b"; });
    await expect(first).rejects.toBe(boom);
    expect(await second).toBe("b");
    expect(await lock(async () => { ran.push("c"); return "c"; })).toBe("c");
    expect(ran).toEqual(["a", "b", "c"]);
  });
  it("two locks are independent: each run gets its own", async () => {
    const a = oneAtATime("t", ROOMY_MS);
    const b = oneAtATime("t", ROOMY_MS);
    let active = 0;
    let maxActive = 0;
    const task = async () => { active++; maxActive = Math.max(maxActive, active); await yields(3); active--; };
    await Promise.all([a(task), b(task)]);
    expect(maxActive).toBe(2);
  });
});

// Fix round 1 m-2: a task that never settles (a hung fetch inside the staff
// window or a sign-in) used to hold the turn forever and park every other
// worker behind it. Transitions, empty case first: a task settles inside its
// deadline (its own answer, its timer cleared); a task outlives it (ITS caller
// gets TurnDeadlineExceeded by name, the turn passes on); the next task after
// a deadline (runs, with a fresh deadline of its own); a bad deadline (refused).
describe("oneAtATime — m-2: a task past its deadline fails by name and releases the turn", () => {
  afterEach(() => { vi.useRealTimers(); });
  const never = <T>(): Promise<T> => new Promise<T>(() => {});
  it("empty case first: a task that settles inside its deadline answers as before and leaves no timer behind — value, rejection and a synchronous throw alike", async () => {
    vi.useFakeTimers();
    const lock = oneAtATime("staff window", 1_000);
    expect(await lock(async () => "ok")).toBe("ok");
    await expect(lock(async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    await expect(lock((() => { throw new Error("sync"); }) as () => Promise<never>)).rejects.toThrow("sync");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a task that never settles rejects ITS caller with TurnDeadlineExceeded at the deadline, naming the turn; the task queued behind it then runs", async () => {
    vi.useFakeTimers();
    const lock = oneAtATime("case-org provision", 1_000);
    const hung = lock(never);
    const caught = hung.catch((e: unknown) => e);
    let nextRan = false;
    const next = lock(async () => { nextRan = true; return "next"; });
    await vi.advanceTimersByTimeAsync(999);
    expect(nextRan).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await caught;
    expect(e).toBeInstanceOf(TurnDeadlineExceeded);
    expect(e).toMatchObject({ name: "TurnDeadlineExceeded", label: "case-org provision", ms: 1_000 });
    expect(String(e)).toMatch(/^TurnDeadlineExceeded: case-org provision: held its turn past the 1000ms deadline/);
    expect(await next).toBe("next");
    expect(nextRan).toBe(true);
    // The task after a deadline gets a full deadline of its own, not what is left of the last one.
    const third = lock(never).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await third).toBeInstanceOf(TurnDeadlineExceeded);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("on three workers, an item whose turn hangs is that item's named failure, and every other worker's items complete", async () => {
    const lock = oneAtATime("staff window", 40);
    const items = [0, 1, 2, 3, 4, 5, 6];
    const HUNG = 2;
    const out = await runQueue(
      items, 3, async (n) => n,
      async (_w, item) => lock(async () => { if (item === HUNG) return never<string>(); await yields(2); return `done ${item}`; }),
      (_item, _i, e) => (e instanceof TurnDeadlineExceeded ? `failed ${e.name} ${e.label}` : `other ${String(e)}`),
    );
    expect(out[HUNG]).toBe("failed TurnDeadlineExceeded staff window");
    let completed = 0;
    for (const i of items.filter((x) => x !== HUNG)) { expect(out[i]).toBe(`done ${i}`); completed++; }
    expect(completed).toBe(items.length - 1);
  });
  it("a deadline that is not a positive whole number of ms is refused by name, before any task runs", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => oneAtATime("staff window", bad), String(bad)).toThrow(/^oneAtATime\(staff window\): the deadline must be a positive whole number of ms, got /);
    }
    expect(() => oneAtATime("staff window", 1)).not.toThrow();
  });
});

// Fix round 1 m-3 (rule 10): random durations, rejections, synchronous throws
// and idle gaps between calls. After every step exactly one task is running;
// tasks start in call order; each runs once; each caller gets its own task's
// value or rejection. The reach counters prove each branch was exercised.
describe("oneAtATime — m-3: the lock under random tasks (rule 10)", () => {
  it("mutual exclusion, FIFO starts, one run per task and each caller's own answer — reach counted", async () => {
    const reach = { runs: 0, tasks: 0, values: 0, rejections: 0, syncThrows: 0, gaps: 0, queuedBehind: 0 };
    class Mine extends Error { readonly n: number; constructor(n: number) { super(`task ${n}`); this.n = n; } }
    const step = fc.record({ wait: fc.nat({ max: 6 }), end: fc.constantFrom("value", "reject", "throw"), gap: fc.nat({ max: 3 }) });
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
      reach.runs++;
      const lock = oneAtATime("sweep", ROOMY_MS);
      let active = 0;
      let maxActive = 0;
      const starts: number[] = [];
      const ranTimes = new Array<number>(steps.length).fill(0);
      const calls: Promise<number>[] = [];
      for (const [n, st] of steps.entries()) {
        // An idle gap lets the lock drain, so a later call can find it free.
        if (st.gap > 0) { reach.gaps++; await yields(st.gap * 4); }
        if (active > 0) reach.queuedBehind++;
        const task = st.end === "throw"
          ? ((() => { ranTimes[n]!++; starts.push(n); reach.syncThrows++; throw new Mine(n); }) as () => Promise<number>)
          : async () => {
            ranTimes[n]!++;
            starts.push(n);
            active++;
            maxActive = Math.max(maxActive, active);
            expect(active).toBe(1);
            await yields(st.wait);
            expect(active).toBe(1);
            active--;
            if (st.end === "reject") throw new Mine(n);
            return n;
          };
        calls.push(lock(task));
      }
      const settled = await Promise.allSettled(calls);
      reach.tasks += steps.length;
      expect(maxActive).toBeLessThanOrEqual(1);
      expect(starts).toEqual(steps.map((_s, n) => n));
      expect(ranTimes).toEqual(steps.map(() => 1));
      for (const [n, st] of steps.entries()) {
        const got = settled[n]!;
        if (st.end === "value") { expect(got).toEqual({ status: "fulfilled", value: n }); reach.values++; }
        else {
          expect(got.status).toBe("rejected");
          expect((got as PromiseRejectedResult).reason).toBeInstanceOf(Mine);
          expect(((got as PromiseRejectedResult).reason as Mine).n).toBe(n);
          reach.rejections++;
        }
      }
    }), { numRuns: 150 });
    console.info(`oneAtATime sweep: ${JSON.stringify(reach)}`);
    for (const [k, v] of Object.entries(reach)) expect(v, k).toBeGreaterThan(0);
  });
});
