// Pure ordering/idempotency operations over a QueueStore — no network
// anywhere in this file or in queue.ts. pipeline.ts is the only caller that
// talks to a transport; these tests use memoryQueueStore() as the store,
// since queue.ts's behaviour must not depend on which QueueStore backs it
// (that contract is queue-store.test.ts's job).
import { describe, expect, it } from "vitest";
import type { PendingEvent } from "../types";
import { memoryQueueStore } from "../queue-store";
import {
  depth,
  enqueue,
  markAcked,
  markDropped,
  peekInOrder,
  queueStatus,
  recordAttempt,
  renegotiateExpectedSeq,
  restampBehindDropped,
} from "../queue";

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
