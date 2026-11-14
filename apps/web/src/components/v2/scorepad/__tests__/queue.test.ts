// Pure ordering/idempotency operations over a QueueStore — no network
// anywhere in this file or in queue.ts. pipeline.ts is the only caller that
// talks to a transport; these tests use memoryQueueStore() as the store,
// since queue.ts's behaviour must not depend on which QueueStore backs it
// (that contract is queue-store.test.ts's job).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingEvent } from "../types";
import { memoryQueueStore, type QueueStore } from "../queue-store";
import {
  depth,
  dropHeld,
  enqueue,
  enqueueHeld,
  flushHeldBefore,
  markAcked,
  markDropped,
  mutateHeld,
  peekInOrder,
  queueStatus,
  recordAttempt,
  releaseHeld,
  renegotiateExpectedSeq,
  restampBehindDropped,
  takeBackHeld,
} from "../queue";

/** A `heldUntil` still ahead for the whole run: a tap that is held. */
const STILL_HELD = Date.now() + 3_600_000;

function event(idempotencyKey: string, overrides: Partial<PendingEvent> = {}): PendingEvent {
  return {
    localId: `local-${idempotencyKey}`,
    idempotencyKey,
    type: "core.note",
    payload: { text: idempotencyKey },
    expectedSeq: 0,
    createdAt: "2026-08-12T00:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

describe("enqueue / peekInOrder / depth", () => {
  it("depth is 0 for an empty queue", async () => {
    const store = memoryQueueStore();
    expect(await depth(store)).toBe(0);
  });

  it("enqueue adds events, peekInOrder returns them oldest-first, depth counts them", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a"));
    await enqueue(store, event("b"));
    await enqueue(store, event("c"));
    expect((await peekInOrder(store)).map((e) => e.idempotencyKey)).toEqual(["a", "b", "c"]);
    expect(await depth(store)).toBe(3);
  });

  it("enqueuing the SAME idempotencyKey twice does not duplicate the entry", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a"));
    await enqueue(store, event("a", { attempts: 1 })); // e.g. a recovered pending event re-enqueued on resume
    expect(await depth(store)).toBe(1);
    expect((await peekInOrder(store))[0]?.attempts).toBe(1);
  });
});

describe("markAcked / markDropped", () => {
  it("markAcked removes the event from the queue", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a"));
    await enqueue(store, event("b"));
    await markAcked(store, "a");
    expect((await peekInOrder(store)).map((e) => e.idempotencyKey)).toEqual(["b"]);
  });

  it("markDropped removes the event from the queue", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a"));
    await enqueue(store, event("b"));
    await markDropped(store, "a");
    expect((await peekInOrder(store)).map((e) => e.idempotencyKey)).toEqual(["b"]);
  });

  it("marking an unknown key is a no-op, not an error", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a"));
    await expect(markAcked(store, "ghost")).resolves.toBeUndefined();
    await expect(markDropped(store, "ghost")).resolves.toBeUndefined();
    expect(await depth(store)).toBe(1);
  });
});

describe("recordAttempt", () => {
  it("bumps attempts/lastError on an existing event WITHOUT moving its position", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a"));
    await enqueue(store, event("b"));
    await enqueue(store, event("c"));
    await recordAttempt(store, "b", { attempts: 2, lastError: "fetch failed" });
    const list = await peekInOrder(store);
    expect(list.map((e) => e.idempotencyKey)).toEqual(["a", "b", "c"]);
    expect(list[1]).toMatchObject({ idempotencyKey: "b", attempts: 2, lastError: "fetch failed" });
  });

  it("is a no-op on an event that is no longer queued (already resolved elsewhere)", async () => {
    const store = memoryQueueStore();
    await expect(recordAttempt(store, "ghost", { attempts: 1 })).resolves.toBeUndefined();
    expect(await depth(store)).toBe(0);
  });
});

describe("renegotiateExpectedSeq", () => {
  it("updates expectedSeq on an existing event WITHOUT moving its position", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a", { expectedSeq: 4 }));
    await enqueue(store, event("b", { expectedSeq: 5 }));
    await renegotiateExpectedSeq(store, "a", 41);
    const list = await peekInOrder(store);
    expect(list.map((e) => e.idempotencyKey)).toEqual(["a", "b"]);
    expect(list[0]?.expectedSeq).toBe(41);
    expect(list[1]?.expectedSeq).toBe(5); // untouched
  });

  it("leaves every OTHER field on the event untouched", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("a", { expectedSeq: 4, attempts: 2, type: "cricket.ball" }));
    await renegotiateExpectedSeq(store, "a", 41);
    expect((await peekInOrder(store))[0]).toEqual(event("a", { expectedSeq: 41, attempts: 2, type: "cricket.ball" }));
  });

  it("is a no-op on an event that is no longer queued", async () => {
    const store = memoryQueueStore();
    await expect(renegotiateExpectedSeq(store, "ghost", 9)).resolves.toBeUndefined();
  });
});

// fix/pad-second-tap-in-flight review I-2. Every queued entry was stamped
// assuming each entry ahead of it lands one slot apiece; an entry that leaves
// WITHOUT landing (a 422, a dead-letter, an undo whose target never existed)
// frees its slot, and the entries behind it would otherwise claim a seq the
// ledger never reaches — a 409 with no slot to inspect, forever.
describe("restampBehindDropped", () => {
  const stamps = async (store: ReturnType<typeof memoryQueueStore>) =>
    (await peekInOrder(store)).map((e) => [e.idempotencyKey, e.expectedSeq] as const);

  it("empty case: nothing dropped moves nothing, and an empty queue restamps nothing", async () => {
    const empty = memoryQueueStore();
    expect(await restampBehindDropped(empty, [], new Set())).toEqual([]);
    expect(await restampBehindDropped(empty, ["a"], new Set(["a"]))).toEqual([]);

    const store = memoryQueueStore();
    await enqueue(store, event("b", { expectedSeq: 1 }));
    expect(await restampBehindDropped(store, ["b"], new Set())).toEqual([]);
    expect(await stamps(store)).toEqual([["b", 1]]);
  });

  it("the head dropped: every never-sent entry behind it moves down one slot, in place, nothing else touched", async () => {
    const store = memoryQueueStore();
    // `a` is the head that left the queue (already deleted, as sendOne's markDropped leaves it).
    await enqueue(store, event("b", { expectedSeq: 1, type: "cricket.ball" }));
    await enqueue(store, event("c", { expectedSeq: 2 }));

    const moved = await restampBehindDropped(store, ["a", "b", "c"], new Set(["a"]));

    expect(moved.map((e) => e.idempotencyKey), "both followers re-aimed").toEqual(["b", "c"]);
    expect(await stamps(store)).toEqual([
      ["b", 0],
      ["c", 1],
    ]);
    expect((await peekInOrder(store))[0]).toEqual(event("b", { expectedSeq: 0, type: "cricket.ball" }));
  });

  it("the head AND an entry bound to it dropped: each survivor moves by the number of drops ahead of it", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("b", { expectedSeq: 1 })); // between the head and its bound follower
    await enqueue(store, event("d", { expectedSeq: 3 })); // behind both

    const moved = await restampBehindDropped(store, ["a", "b", "v", "d"], new Set(["a", "v"]));

    expect(moved).toHaveLength(2);
    expect(await stamps(store)).toEqual([
      ["b", 0],
      ["d", 1],
    ]);
  });

  it("an entry already SENT keeps its stamp (a resend replays the original expected_seq); a never-sent one behind it still moves", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("b", { expectedSeq: 0, attempts: 1 })); // e.g. another tab sharing this queue re-aimed and sent it
    await enqueue(store, event("c", { expectedSeq: 2 }));

    const moved = await restampBehindDropped(store, ["a", "b", "c"], new Set(["a"]));

    expect(moved.map((e) => e.idempotencyKey)).toEqual(["c"]);
    expect(await stamps(store)).toEqual([
      ["b", 0],
      ["c", 1],
    ]);
  });

  it("an entry named in the order but no longer queued is not resurrected", async () => {
    const store = memoryQueueStore();
    await enqueue(store, event("c", { expectedSeq: 2 }));

    const moved = await restampBehindDropped(store, ["a", "b", "c"], new Set(["a"]));

    expect(moved.map((e) => e.idempotencyKey)).toEqual(["c"]);
    expect(await stamps(store)).toEqual([["c", 1]]);
  });

  // Review m1. The re-aim writes each survivor back whole (put-as-replace), so a
  // copy read before an EARLIER survivor's write is stale by the time it is
  // written: a dock edit (`mutateHeld`) or a hold ending (`releaseHeld`) that
  // landed in between would be overwritten. Each case edits the LATER survivor
  // while the re-aim is still writing the one ahead of it.
  describe("an edit made while the re-aim is writing the entry AHEAD survives, and the edited entry still moves", () => {
    /** `memoryQueueStore`, with the FIRST `put` held until `release()`. */
    function storeHoldingFirstPut() {
      const inner = memoryQueueStore();
      let held = false;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atGate = new Promise<void>((r) => (reached = r));
      const store: QueueStore = {
        list: () => inner.list(),
        delete: (key) => inner.delete(key),
        clear: () => inner.clear(),
        async put(e) {
          if (!held) {
            held = true;
            reached();
            await gate;
          }
          return inner.put(e);
        },
      };
      return { store, inner, atGate, release };
    }

    it("a dock edit (mutateHeld) of a held tap behind the head", async () => {
      const { store, inner, atGate, release } = storeHoldingFirstPut();
      await enqueue(inner, event("b", { expectedSeq: 1 }));
      await enqueue(inner, event("c", { expectedSeq: 2, heldUntil: STILL_HELD }));

      const restamp = restampBehindDropped(store, ["a", "b", "c"], new Set(["a"]));
      await atGate; // writing `b`
      expect(await mutateHeld(inner, "c", (e) => ({ ...e, payload: { text: "c", scorer: "p9" } })), "rig: c is held").toBe(true);
      release();
      const moved = await restamp;

      expect(moved.map((e) => e.idempotencyKey)).toEqual(["b", "c"]);
      const c = (await peekInOrder(inner)).find((e) => e.idempotencyKey === "c");
      expect(c?.payload, "the scorer picked on the dock is still on the tap").toEqual({ text: "c", scorer: "p9" });
      expect(c?.expectedSeq, "and it was still re-aimed").toBe(1);
    });

    it("a hold that ended (releaseHeld) on a tap behind the head is not re-held", async () => {
      const { store, inner, atGate, release } = storeHoldingFirstPut();
      await enqueue(inner, event("b", { expectedSeq: 1 }));
      await enqueue(inner, event("c", { expectedSeq: 2, heldUntil: STILL_HELD }));

      const restamp = restampBehindDropped(store, ["a", "b", "c"], new Set(["a"]));
      await atGate;
      await releaseHeld(inner, "c");
      expect((await peekInOrder(inner)).find((e) => e.idempotencyKey === "c")?.heldUntil, "rig: released").toBeUndefined();
      release();
      await restamp;

      const c = (await peekInOrder(inner)).find((e) => e.idempotencyKey === "c");
      expect(c?.heldUntil, "a re-held tap has no tick left to send it").toBeUndefined();
      expect(c?.expectedSeq).toBe(1);
    });
  });
});

// Lost updates (review rr4). Every write below replaces a whole entry with a
// copy it read first, so two of them on one entry, both reading before either
// writes (list, list, put, put), lose the first write. A queue that answers in
// call order (IndexedDB runs the requests on one object store that way) does
// exactly that whenever the second call is made while the first one's read is
// answered and its write not yet issued. Each case makes the second call after
// every number of the first call's queue answers, so it lands in every window
// the first one opens, and checks that BOTH effects are in the queue.
describe("two queue writes to one entry, the second made at any point of the first, both take effect", () => {
  /**
   * `memoryQueueStore`, but every call waits its turn, one at a time in the
   * order it was made, and moves only when the test calls `step()`: one step
   * RUNS the oldest waiting call against the store, the next HANDS its answer
   * back to the caller. Between the two, a call made now is issued before
   * anything the caller does with the answer — as on IndexedDB, where a read's
   * transaction completes, and another one already asked for can run, before
   * the reader's code resumes. A read made before a write was issued answers
   * without it.
   */
  function steppedStore() {
    const inner = memoryQueueStore();
    const waiting: { run: () => Promise<unknown>; settle: (answer: { value?: unknown; error?: unknown }) => void }[] = [];
    let ran: (() => void) | undefined;
    const turn = <T,>(op: () => Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        waiting.push({ run: op, settle: (a) => ("error" in a ? reject(a.error) : resolve(a.value as T)) });
      });
    const store: QueueStore = {
      list: () => turn(() => inner.list()),
      put: (e) => turn(() => inner.put(e)),
      delete: (key) => turn(() => inner.delete(key)),
      clear: () => turn(() => inner.clear()),
    };
    const idle = () => new Promise<void>((resolve) => setImmediate(resolve));
    return {
      store,
      inner,
      /** Hand back the answer of the call that last ran, or else run the oldest waiting call; false when neither. */
      async step(): Promise<boolean> {
        await idle();
        if (ran !== undefined) {
          const handBack = ran;
          ran = undefined;
          handBack();
          await idle();
          return true;
        }
        const next = waiting.shift();
        if (next === undefined) return false;
        const answer = await next.run().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        ran = () => next.settle(answer);
        return true;
      },
    };
  }

  /** Track a call's outcome without awaiting it. */
  function watch<T>(p: Promise<T>) {
    const box: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    p.then(
      (value) => Object.assign(box, { settled: true, value }),
      (error: unknown) => Object.assign(box, { settled: true, error }),
    );
    return box;
  }

  /** `b` and `c` queued behind `a`, which left without landing (already deleted, as a refusal leaves it); `c` is a held tap. */
  async function seed(inner: QueueStore) {
    await enqueue(inner, event("b", { expectedSeq: 1 }));
    await enqueue(inner, event("c", { expectedSeq: 2, heldUntil: STILL_HELD }));
  }
  const reaim = (store: QueueStore) => restampBehindDropped(store, ["a", "b", "c"], new Set(["a"]));
  const entry = async (inner: QueueStore, key: string) => (await inner.list()).find((e) => e.idempotencyKey === key);

  /** Run `first`, make `second` after `n` of the queue's answers, answer everything; undefined once `first` settles within `n`. */
  async function race(n: number, first: (s: QueueStore) => Promise<unknown>, second: (s: QueueStore) => Promise<unknown>) {
    const { store, inner, step } = steppedStore();
    await seed(inner);
    const a = watch(first(store));
    for (let i = 0; i < n; i++) await step();
    if (a.settled) return undefined;
    const b = watch(second(store));
    for (let i = 0; i < 100 && !(a.settled && b.settled); i++) await step();
    expect([a.settled, b.settled], `n=${n}: rig: both calls answered`).toEqual([true, true]);
    expect([a.error, b.error], `n=${n}`).toEqual([undefined, undefined]);
    return { inner, store, step, first: a.value, second: b.value };
  }

  const PICKED = { text: "c", scorer: "p9" };
  const AGAINST_THE_REAIM: readonly {
    name: string;
    run: (s: QueueStore) => Promise<unknown>;
    check: (n: number, inner: QueueStore, moved: PendingEvent[], result: unknown) => Promise<void>;
  }[] = [
    {
      name: "the held tap's hold ending (releaseHeld) — not re-held, and re-aimed",
      run: (s) => releaseHeld(s, "c"),
      check: async (n, inner) => {
        const c = await entry(inner, "c");
        expect(c?.heldUntil, `n=${n}: released`).toBeUndefined();
        expect(c?.expectedSeq, `n=${n}: re-aimed into the freed slot`).toBe(1);
      },
    },
    {
      name: "a leaving control releasing every held tap (flushHeldBefore, pad-flush) — not re-held, and re-aimed",
      run: (s) => flushHeldBefore(s, Date.now()),
      check: async (n, inner) => {
        const c = await entry(inner, "c");
        expect(c?.heldUntil, `n=${n}: released`).toBeUndefined();
        expect(c?.expectedSeq, `n=${n}: re-aimed into the freed slot`).toBe(1);
      },
    },
    {
      name: "a dock pick on the held tap (mutateHeld) — the pick kept, and re-aimed",
      run: (s) => mutateHeld(s, "c", (e) => ({ ...e, payload: PICKED })),
      check: async (n, inner, _moved, picked) => {
        const c = await entry(inner, "c");
        expect(picked, `n=${n}: the pick found the tap held`).toBe(true);
        expect(c?.payload, `n=${n}: the scorer picked is on the tap`).toEqual(PICKED);
        expect(c?.expectedSeq, `n=${n}: re-aimed into the freed slot`).toBe(1);
        expect(c?.heldUntil, `n=${n}: still held`).toBe(STILL_HELD);
      },
    },
    {
      name: "the send's pre-send marker (recordAttempt) — recorded, and the stamp is the one the re-aim reported",
      run: (s) => recordAttempt(s, "c", { attempts: 1 }),
      check: async (n, inner, moved) => {
        const c = await entry(inner, "c");
        expect(c?.attempts, `n=${n}: the marker is on the tap`).toBe(1);
        // Moved before the marker landed (re-aimed), or seen as sent and left where it was stamped.
        const reported = moved.some((e) => e.idempotencyKey === "c");
        expect(c?.expectedSeq, `n=${n}: the queue holds what the re-aim reported (moved: ${reported})`).toBe(reported ? 1 : 2);
      },
    },
    {
      name: "a take-back of the held tap (dropHeld) — gone, never written back",
      run: (s) => dropHeld(s, "c"),
      check: async (n, inner, _moved, dropped) => {
        expect(dropped, `n=${n}: taken back`).toBe(true);
        expect(await entry(inner, "c"), `n=${n}: a taken-back tap is not in the queue`).toBeUndefined();
      },
    },
  ];

  for (const competitor of AGAINST_THE_REAIM) {
    it(`a re-aim behind a dropped tap, against ${competitor.name}`, async () => {
      // The windows: every queue answer the re-aim waits for when it runs alone.
      const alone = steppedStore();
      await seed(alone.inner);
      const solo = watch(reaim(alone.store));
      let calls = 0;
      while (!solo.settled && (await alone.step())) calls += 1;
      expect(calls, "rig: the re-aim alone reads and writes the queue").toBeGreaterThan(0);

      let windows = 0;
      for (let n = 0; n <= calls + 1; n++) {
        const run = await race(n, reaim, competitor.run);
        if (run === undefined) break;
        windows += 1;
        expect((await entry(run.inner, "b"))?.expectedSeq, `n=${n}: the entry ahead is re-aimed too`).toBe(0);
        await competitor.check(n, run.inner, run.first as PendingEvent[], run.second);
      }
      expect(windows, "points of the re-aim the second write was made at").toBe(calls);
    });
  }

  // The take-back and the hold ending are both decided on one read of the held
  // tap: never both. Taken back means it is gone for good; refused means it was
  // released and stays queued, to be sent.
  for (const [firstName, first, second] of [
    ["the take-back first", (s: QueueStore) => dropHeld(s, "c"), (s: QueueStore) => releaseHeld(s, "c")],
    ["the hold ending first", (s: QueueStore) => releaseHeld(s, "c"), (s: QueueStore) => dropHeld(s, "c")],
  ] as const) {
    it(`a take-back racing the held tap's hold ending, ${firstName}: taken back XOR released, never both`, async () => {
      let windows = 0;
      const outcomes = { takenBack: 0, released: 0 };
      for (let n = 0; n < 20; n++) {
        const run = await race(n, first, second);
        if (run === undefined) break;
        windows += 1;
        const dropped = (firstName === "the take-back first" ? run.first : run.second) as boolean;
        const c = await entry(run.inner, "c");
        if (dropped) {
          outcomes.takenBack += 1;
          expect(c, `n=${n}: taken back, so it is not in the queue to be sent`).toBeUndefined();
        } else {
          outcomes.released += 1;
          expect(c?.heldUntil, `n=${n}: refused, so it was released and stays queued`).toBeUndefined();
          expect(c?.expectedSeq, `n=${n}`).toBe(2);
        }
      }
      expect(windows, "points of the first call the second was made at").toBeGreaterThanOrEqual(2);
      expect(outcomes.takenBack + outcomes.released, "outcomes checked").toBe(windows);
    });
  }

  // The drain sends a held tap once its `heldUntil` has passed, even before its
  // own tick has run, so the answer that deletes it can arrive while its hold
  // ending (or a late dock pick) is still writing it back. A delete that ran
  // between that write's read and its put was undone: the answered tap back in
  // the queue, to be sent again.
  const LATE_WRITES = [
    ["its hold ending (releaseHeld)", (s: QueueStore) => releaseHeld(s, "c")],
    ["a dock pick (mutateHeld)", (s: QueueStore) => mutateHeld(s, "c", (e) => ({ ...e, payload: PICKED }))],
  ] as const;
  const ANSWERS = [
    ["acked (markAcked)", markAcked],
    ["refused (markDropped)", markDropped],
  ] as const;
  for (const [writeName, write] of LATE_WRITES) {
    for (const [answerName, answer] of ANSWERS) {
      it(`a held tap ${answerName} while ${writeName} is writing it stays out of the queue`, async () => {
        let windows = 0;
        for (let n = 0; n < 20; n++) {
          const run = await race(n, write, (s) => answer(s, "c"));
          if (run === undefined) break;
          windows += 1;
          expect(await entry(run.inner, "c"), `n=${n}: answered, so gone for good`).toBeUndefined();
          expect((await entry(run.inner, "b"))?.expectedSeq, `n=${n}: nothing else touched`).toBe(1);
        }
        expect(windows, "points of the write the answer was made at").toBeGreaterThanOrEqual(2);
      });
    }
  }

  // Review rr5 (I). A held tap's entry waited its turn behind the write already
  // running, while a plain tap made just after it was written at once: the plain
  // tap went into the queue first, stamped one past the held tap now behind it.
  /** Take back what a case left held, so no release tick outlives the test. */
  async function takeBackLeftovers(run: { store: QueueStore; step: () => Promise<boolean> }, keys: readonly string[]) {
    for (const key of keys) {
      const gone = watch(dropHeld(run.store, key));
      for (let i = 0; i < 50 && !gone.settled; i++) await run.step();
      expect(gone.settled, `rig: ${key} cleared`).toBe(true);
    }
  }

  it("a plain tap made right after a held tap, at any point of a queue write already running, is queued behind it", async () => {
    const alone = steppedStore();
    await seed(alone.inner);
    const solo = watch(reaim(alone.store));
    let calls = 0;
    while (!solo.settled && (await alone.step())) calls += 1;

    let windows = 0;
    for (let n = 0; n <= calls + 1; n++) {
      const run = await race(n, reaim, (s) =>
        Promise.all([enqueueHeld(s, event("h", { expectedSeq: 3 }), 3_600_000, () => {}), enqueue(s, event("p", { expectedSeq: 4 }))]),
      );
      if (run === undefined) break;
      windows += 1;
      expect((await peekInOrder(run.inner)).map((e) => e.idempotencyKey), `n=${n}: in the order they were tapped`).toEqual([
        "b",
        "c",
        "h",
        "p",
      ]);
      await takeBackLeftovers(run, ["h"]);
    }
    expect(windows, "points of the running write the two taps were made at").toBe(calls);
  });

  // The flip side of writing the held tap at once: when its release of the taps
  // held before it runs, a held tap made AFTER it can already be in the queue.
  it("a held tap releases the held taps made before it, never one made after it, at any point of a queue write already running", async () => {
    const alone = steppedStore();
    await seed(alone.inner);
    const solo = watch(reaim(alone.store));
    let calls = 0;
    while (!solo.settled && (await alone.step())) calls += 1;

    let windows = 0;
    for (let n = 0; n <= calls + 1; n++) {
      const due = { first: 0, second: 0 };
      const run = await race(n, reaim, (s) =>
        Promise.all([
          enqueueHeld(s, event("h1", { expectedSeq: 3 }), 3_600_000, () => (due.first += 1)),
          enqueueHeld(s, event("h2", { expectedSeq: 4 }), 3_600_000, () => (due.second += 1)),
        ]),
      );
      if (run === undefined) break;
      windows += 1;
      const held = (key: string) => peekInOrder(run.inner).then((all) => all.find((e) => e.idempotencyKey === key)?.heldUntil !== undefined);
      expect([await held("c"), await held("h1"), await held("h2")], `n=${n}: c and h1 released, h2 still held`).toEqual([false, false, true]);
      expect(due, `n=${n}: h1's release said once, h2's never`).toEqual({ first: 1, second: 0 });
      await takeBackLeftovers(run, ["h2"]);
    }
    expect(windows, "points of the running write the two held taps were made at").toBe(calls);
  });
});

// Review rr5 (m3). "Still held" is one rule, the drain's: the window has not run
// out (`heldUntil` still ahead) — the drain sends a tap from its last moment on,
// whether or not its release has been written (its tick not yet run, or waiting
// behind another write). So a take-back, a drop and a dock pick refuse it from
// that moment too, and change nothing: one that took it back could remove a tap
// already on the wire.
describe("a held tap whose window has run out, its release not yet written, is no longer held", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const END = 1_800_000_000_000;
  const PICKED = { text: "c", scorer: "p9" };
  const ACTS: readonly [string, (s: QueueStore) => Promise<unknown>, (answer: unknown) => boolean][] = [
    ["a take-back (takeBackHeld)", (s) => takeBackHeld(s, "c", ["c", "d"], new Set(["c"])), (moved) => moved !== null],
    ["a drop (dropHeld)", (s) => dropHeld(s, "c"), (dropped) => dropped === true],
    ["a dock pick (mutateHeld)", (s) => mutateHeld(s, "c", (e) => ({ ...e, payload: PICKED })), (picked) => picked === true],
  ];
  for (const [name, act, accepted] of ACTS) {
    it(`${name}: accepted while the window lasts, refused from its last moment on with the queue untouched`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      let checked = 0;
      for (const [at, held] of [
        [END - 1, true],
        [END, false],
        [END + 5_000, false],
      ] as const) {
        vi.setSystemTime(at);
        const store = memoryQueueStore();
        await enqueue(store, event("c", { expectedSeq: 1, heldUntil: END }));
        await enqueue(store, event("d", { expectedSeq: 2 }));
        const before = await peekInOrder(store);
        expect(accepted(await act(store)), `${at - END}ms from the window's end: ${held ? "held" : "not held"}`).toBe(held);
        if (held) expect(await peekInOrder(store), "accepted, so it acted").not.toEqual(before);
        else expect(await peekInOrder(store), "refused, so nothing moved or left").toEqual(before);
        checked += 1;
      }
      expect(checked, "moments checked").toBe(3);
    });
  }
});

describe("queueStatus", () => {
  it("is 'offline' whenever the connection is offline, regardless of depth", () => {
    expect(queueStatus({ depth: 0, connection: "offline", blocked: false })).toBe("offline");
    expect(queueStatus({ depth: 3, connection: "offline", blocked: true })).toBe("offline");
  });

  it("is 'empty' when online with nothing queued", () => {
    expect(queueStatus({ depth: 0, connection: "online", blocked: false })).toBe("empty");
  });

  it("is 'blocked' when online, something queued, and the front of the queue cannot proceed", () => {
    expect(queueStatus({ depth: 1, connection: "online", blocked: true })).toBe("blocked");
  });

  it("is 'pending' when online, something queued, and nothing blocking it", () => {
    expect(queueStatus({ depth: 2, connection: "online", blocked: false })).toBe("pending");
  });
});
