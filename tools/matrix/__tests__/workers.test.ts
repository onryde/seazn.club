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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WORKERS, TurnDeadlineExceeded, TurnsClosed, WorkersOutOfRange, oneAtATime, runQueue, sharedTurns } from "../lib/workers.ts";
import { deferred, handClock } from "./hand-clock.ts";

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
  // W1d item 18 (D11): the cap STAYS 8. The comment above it used to invite the next wave to raise it; D11 declined
  // (parallelism is the shard matrix, which is free jobs), so the comment names D11 and the declaration is read as text:
  // a raise is a diff to this test, never a silent one.
  it("MAX_WORKERS stays 8 and its comment names D11: the declaration is text-pinned beside the decision, with no standing invitation to raise it", () => {
    const text = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "workers.ts"), "utf8");
    const at = text.indexOf("export const MAX_WORKERS");
    expect(at, "workers.ts no longer declares MAX_WORKERS").toBeGreaterThan(0);
    expect(text.slice(at).split("\n")[0]).toBe("export const MAX_WORKERS = 8;");
    // The comment block directly above the declaration (contiguous `//` lines).
    const above = text.slice(0, at).trimEnd().split("\n");
    const block: string[] = [];
    for (let i = above.length - 1; i >= 0 && above[i]!.startsWith("//"); i--) block.unshift(above[i]!);
    const comment = block.join("\n");
    expect(block.length, "no comment above MAX_WORKERS").toBeGreaterThan(0);
    expect(comment).toMatch(/\bD11\b/);
    expect(comment).toMatch(/stays 8/);
    expect(comment, "the stale invitation").not.toMatch(/may raise it/);
    // The decision, in its own words, and no imperative invitation in other words (a mutant that reworded the
    // invitation to "raise it when the wave needs more" survived the one-phrase check above).
    expect(comment).toMatch(/raising it is a decision, not a drift/);
    expect(comment, "an imperative invitation").not.toMatch(/\braise it\b/i);
    expect(MAX_WORKERS).toBe(8);
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

// Fix round 4 (ruling T12-R5): the run's turns trip the moment a deadline
// fires, but the timed-out case reaches `crashed` (which aborts the queue)
// only after it has closed its DB handles — real I/O. A lane that freed up in
// between took the next item. `halted` is the queue's abort flag read from
// the trip itself. Transitions, empty case first: a halt that never answers
// (nothing changes); a halt raised while items are in flight (no lane takes
// another, the in-flight finish, the queue rejects with the halt); a halt
// raised after the last item was taken (nothing left to take, and the queue
// still rejects — a halted run never reads as a finished one).
describe("runQueue — a halt stops the queue before an abort reaches it (T12-R5)", () => {
  it("empty case first: a halt that never answers changes nothing — every item runs once, in plan order, and it was asked before each take", async () => {
    let asked = 0;
    const out = await runQueue([0, 1, 2, 3], 2, async () => null, async (_w, x) => { await yields(x); return x; }, () => -1, () => { asked++; return null; });
    expect(out).toEqual([0, 1, 2, 3]);
    expect(asked).toBeGreaterThanOrEqual(4);
  });
  it("once it answers, no lane takes another item: the item in flight finishes, and runQueue rejects with the halt's answer", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const trip = new Error("the run's turns tripped");
    const halt: { now: Error | null } = { now: null };
    const p = runQueue([0, 1, 2, 3, 4, 5], 2, async () => null, async (_w, x, i) => {
      started.push(i);
      // Raised while item 0 is still in flight, before either lane takes again.
      if (i === 1) halt.now = trip;
      await yields(i === 0 ? 6 : 1);
      finished.push(i);
      return x;
    }, () => -1, () => halt.now);
    await expect(p).rejects.toBe(trip);
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([1, 0]);
  });
  it("a halt raised after the last item was taken leaves nothing to stop, and the queue still rejects with it", async () => {
    const trip = new Error("tripped at the end");
    const halt: { now: Error | null } = { now: null };
    const ran: number[] = [];
    const p = runQueue([0, 1], 2, async () => null, async (_w, x, i) => { ran.push(i); if (i === 1) halt.now = trip; await yields(2); return x; }, () => -1, () => halt.now);
    await expect(p).rejects.toBe(trip);
    expect(ran).toEqual([0, 1]);
  });
});

describe("runQueue — rule 10: interleaved completions, crashes, aborts, halts and worker counts", () => {
  // One generated run: n items, w workers, each item a number of yields (its
  // completion order), a subset that throw, optionally one whose crash
  // aborts, and optionally one that raises the halt mid-item (fix round 4,
  // T12-R5: the run's turns tripped while it was in flight). Invariants after
  // EVERY step (each item start and finish), and on the outcome. Reach counts
  // below prove each shape was exercised.
  const shape = fc.record({
    items: fc.array(fc.record({ yields: fc.nat({ max: 8 }), fails: fc.boolean() }), { minLength: 0, maxLength: 20 }),
    workers: fc.integer({ min: 1, max: MAX_WORKERS }),
    abortAt: fc.option(fc.nat({ max: 19 }), { nil: null }),
    haltAt: fc.option(fc.nat({ max: 19 }), { nil: null, freq: 2 }),
  });

  it("results come back in plan order, every item runs exactly once, crashes map through crashed, and an abort or a halt stops the queue — reach counted", async () => {
    const reach = { runs: 0, empty: 0, items: 0, crashes: 0, aborts: 0, halts: 0, haltsThatStoppedATake: 0, outOfOrder: 0, concurrent: 0, fewerItemsThanWorkers: 0 };
    await fc.assert(fc.asyncProperty(shape, async ({ items, workers, abortAt, haltAt }) => {
      const n = items.length;
      const abortIndex = abortAt !== null && abortAt < n && items[abortAt]!.fails ? abortAt : null;
      const haltIndex = haltAt !== null && haltAt < n ? haltAt : null;
      const runs = new Array<number>(n).fill(0);
      const crashedAt = new Array<number>(n).fill(0);
      const finishOrder: number[] = [];
      const opened: number[] = [];
      let active = 0;
      let maxActive = 0;
      let abortRaised = false;
      let startedAfterAbort = 0;
      let haltRaised = false;
      let startedAfterHalt = 0;
      const abortError = new Error("abort");
      const haltError = new Error("halt");
      const step = (): void => {
        // After every step: never more items in flight than workers, and never an item run twice.
        expect(active).toBeLessThanOrEqual(workers);
        expect(runs.every((r) => r <= 1)).toBe(true);
      };
      const outcome = await runQueue(items, workers, async (w) => { opened.push(w); return w; }, async (_w, item, i) => {
        if (abortRaised) startedAfterAbort++;
        if (haltRaised) startedAfterHalt++;
        runs[i]!++;
        active++;
        maxActive = Math.max(maxActive, active);
        step();
        await yields(item.yields);
        if (i === haltIndex) haltRaised = true;
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
      }, () => (haltRaised ? haltError : null)).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));

      // Never more workers opened than the bound or the items, and each opened once.
      expect(opened.length).toBeLessThanOrEqual(Math.min(workers, n));
      expect(new Set(opened).size).toBe(opened.length);
      expect(active).toBe(0); // every started item finished before runQueue settled
      expect(startedAfterAbort).toBe(0);
      // T12-R5: no item starts once the halt is raised, whichever lane frees up next.
      expect(startedAfterHalt).toBe(0);
      if (!abortRaised && !haltRaised) {
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
        // Whichever stopped the queue is what it rejects with (both raised: either).
        expect(abortRaised && haltRaised ? [abortError, haltError] : [abortRaised ? abortError : haltError]).toContain(outcome.e);
        // An abort never re-runs an item, and never runs the aborting one twice.
        expect(runs.every((r) => r <= 1)).toBe(true);
        if (abortRaised) { expect(runs[abortIndex!]).toBe(1); reach.aborts++; }
        if (haltRaised) {
          reach.halts++;
          // The shape that matters: items were left, and only the halt kept them from starting.
          if (!abortRaised && runs.some((r) => r === 0)) reach.haltsThatStoppedATake++;
        }
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
    console.info(`runQueue sweep: ${JSON.stringify(reach)}`);
    expect(reach.runs).toBe(300);
    for (const [k, v] of Object.entries(reach)) expect(v, `reach.${k}`).toBeGreaterThan(0);
  });
});

// Found live at T11 Step 7 (w1drv-t11-w3): the case-org provision's
// entitlement bust flips the run's ONE owner to staff for two admin calls and
// back (tools/bench/lib/plan.ts bustOrgEntitlements). Workers share that
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
// worker behind it. Fix round 2 (ruling T12-R3): the timed-out request is not
// aborted and may still land — inside the NEXT holder's window, where its 401
// would be read as that case's red. So the family fails CLOSED: a deadline on
// any turn trips every lock made by the same sharedTurns, and no further turn
// is admitted. Transitions, empty case first: a task settles inside its
// deadline (its own answer, its timer cleared); a task outlives it (ITS caller
// gets TurnDeadlineExceeded by name, the family trips); a task queued behind
// it, a later call, and a task on the family's other lock (each refused with
// TurnsClosed, never run); a turn already running on another lock when the
// trip fires (admitted before it: it finishes); a bad deadline (refused).
describe("sharedTurns / oneAtATime — m-2 + T12-R3: a task past its deadline fails by name and closes the family", () => {
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
  it("a task that never settles rejects ITS caller with TurnDeadlineExceeded at the deadline, naming the turn; the family trips and the task queued behind it is refused by name, never run", async () => {
    vi.useFakeTimers();
    const turns = sharedTurns(1_000);
    expect(turns.deadlineMs).toBe(1_000);
    expect(turns.tripped()).toBeNull();
    const lock = turns.lock("case-org provision");
    const hung = lock(never);
    const caught = hung.catch((e: unknown) => e);
    let nextRan = false;
    const next = lock(async () => { nextRan = true; return "next"; }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(turns.tripped()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const e = await caught;
    expect(e).toBeInstanceOf(TurnDeadlineExceeded);
    expect(e).toMatchObject({ name: "TurnDeadlineExceeded", label: "case-org provision", ms: 1_000 });
    expect(String(e)).toMatch(/^TurnDeadlineExceeded: case-org provision: held its turn past the 1000ms deadline/);
    expect(turns.tripped()).toBe(e);
    const refused = await next;
    expect(refused).toBeInstanceOf(TurnsClosed);
    expect(refused).toMatchObject({ name: "TurnsClosed", label: "case-org provision", tripped: e });
    expect(String(refused)).toMatch(/^TurnsClosed: case-org provision: refused — the run's shared turns closed when case-org provision held its turn past the 1000ms deadline/);
    expect(nextRan).toBe(false);
    // A later call is refused too, and starts no timer.
    let laterRan = false;
    await expect(lock(async () => { laterRan = true; })).rejects.toBeInstanceOf(TurnsClosed);
    expect(laterRan).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("one family, two locks: a deadline on one closes the other — a turn already running there finishes, every later one is refused", async () => {
    vi.useFakeTimers();
    const turns = sharedTurns(1_000);
    const provision = turns.lock("case-org provision");
    const signIn = turns.lock("workers' sign-in");
    let release: (v: string) => void = () => {};
    const hung = provision(never).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    // Admitted at 500ms, so its own deadline (1500ms) is still ahead when the provision trips at 1000ms.
    const running = signIn(() => new Promise<string>((r) => { release = r; }));
    const queuedSignIn = signIn(async () => "never admitted").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(499);
    expect(turns.tripped()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await hung).toBeInstanceOf(TurnDeadlineExceeded);
    release("admitted before the trip");
    expect(await running).toBe("admitted before the trip");
    const q = await queuedSignIn;
    expect(q).toBeInstanceOf(TurnsClosed);
    expect(q).toMatchObject({ label: "workers' sign-in", tripped: { label: "case-org provision" } });
    await expect(signIn(async () => "late")).rejects.toBeInstanceOf(TurnsClosed);
    // A second family is untouched: each run gets its own.
    expect(await sharedTurns(1_000).lock("other run")(async () => "free")).toBe("free");
  });
  // Fix round 4: the clock seam itself. Transitions, empty case first: a turn
  // that settles (one deadline set, at the family's ms, then cleared); a turn
  // that hangs (its deadline is the one live timer, and firing it trips the
  // family by name); a task queued behind it (refused, and it sets no timer).
  it("fix round 4: a family's deadlines run on the clock it is given — set at its deadline when a turn begins, cleared when the task settles, and firing one by hand trips the family with no wall time passing", async () => {
    const hc = handClock();
    const turns = sharedTurns(1_000, hc.clock);
    const lock = turns.lock("staff window");
    expect(await lock(async () => "ok")).toBe("ok");
    expect(hc.timers.map((t) => t.ms)).toEqual([1_000]);
    expect(hc.live()).toEqual([]);
    const began = deferred();
    const hung = lock(() => { began.resolve(); return never<string>(); }).catch((e: unknown) => e);
    let queuedRan = false;
    const queued = lock(async () => { queuedRan = true; return "never admitted"; }).catch((e: unknown) => e);
    await began.promise;
    expect(hc.live().map((t) => t.ms)).toEqual([1_000]);
    expect(turns.tripped()).toBeNull();
    hc.fireTheOne();
    const e = await hung;
    expect(e).toBeInstanceOf(TurnDeadlineExceeded);
    expect(e).toMatchObject({ label: "staff window", ms: 1_000 });
    expect(turns.tripped()).toBe(e);
    expect(await queued).toBeInstanceOf(TurnsClosed);
    expect(queuedRan).toBe(false);
    expect(hc.timers).toHaveLength(2);
    expect(hc.live()).toEqual([]);
  });
  // Fix round 4: the deadline is fired by hand once the hung turn has begun,
  // so no 40ms timer decides anything (the order here was already FIFO and
  // microtask-only; now the trip is too).
  it("on three workers sharing one lock, a hung turn closes it: no task queued behind it or called after it runs, each is refused by name, and the queue aborts on the first", async () => {
    const hc = handClock();
    const turns = sharedTurns(40, hc.clock);
    const lock = turns.lock("staff window");
    const items = [0, 1, 2, 3, 4, 5, 6];
    const HUNG = 2;
    const ran: number[] = [];
    const refusedItems: number[] = [];
    const hungBegan = deferred();
    const queue = runQueue(
      items, 3, async (n) => n,
      async (_w, item) => lock(async () => { if (item === HUNG) { hungBegan.resolve(); return never<string>(); } ran.push(item); await yields(2); return `done ${item}`; }),
      (item, _i, e) => { if (e instanceof TurnsClosed) refusedItems.push(item); throw e; },
    ).catch((e: unknown) => e);
    await hungBegan.promise;
    expect(turns.tripped()).toBeNull();
    hc.fireTheOne();
    const err = await queue;
    // The first error to reach the queue is the deadline or a refusal it caused; either names the hung turn.
    const named = err instanceof TurnsClosed ? err.tripped : err;
    expect(named).toBeInstanceOf(TurnDeadlineExceeded);
    expect(named).toMatchObject({ label: "staff window", ms: 40 });
    expect(turns.tripped()).toBe(named);
    // Items 0 and 1 took their turns before the hung one; nothing ran after it.
    expect(ran).toEqual([0, 1]);
    expect(ran.every((i) => i < HUNG)).toBe(true);
    expect(refusedItems.length).toBeGreaterThan(0);
    expect(refusedItems.every((i) => i > HUNG)).toBe(true);
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
