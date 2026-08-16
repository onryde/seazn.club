// R1 chassis soft-commit (task 4, spec §2.3): enqueueHeld / mutateHeld /
// releaseHeld / dropHeld / flushHeldBefore. A tap enters the durable queue
// IMMEDIATELY — `peekInOrder` sees it right away, same as a plain
// `enqueue()` — but its SEND is deferred `holdMs`. No transport/hook
// involved here, same "no network in this file" posture as queue.test.ts:
// the `onDue` callback each function invokes stands in for "the pipeline
// would drain now" (use-pad-pipeline.ts's `runDrain` is the real, later
// caller — see queue.ts's own header for why THIS task leaves that wiring
// unbuilt: no production skin calls `enqueueHeld` yet this wave).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingEvent } from "../types";
import { memoryQueueStore } from "../queue-store";
import { HOLD_MS, dropHeld, enqueueHeld, flushHeldBefore, mutateHeld, peekInOrder, releaseHeld } from "../queue";

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

describe("soft-commit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("held event is visible immediately but not sent until the window closes", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    const id = await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);

    expect(id).toBe("a");
    expect((await peekInOrder(store)).map((e) => e.idempotencyKey)).toEqual(["a"]);
    expect(sendSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("a new tap flushes the previous held event first", async () => {
    const store = memoryQueueStore();
    const sendSpyA = vi.fn();
    const sendSpyB = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpyA); // A's own deadline: t=6000
    await vi.advanceTimersByTimeAsync(1000); // t=1000, well inside A's window
    expect(vi.getTimerCount()).toBe(1); // just A's own release tick pending

    await enqueueHeld(store, event("b"), HOLD_MS, sendSpyB); // flushes A first; B's deadline: t=7000

    expect(sendSpyA).toHaveBeenCalledTimes(1); // A released (sent) by B's arrival
    expect(sendSpyB).not.toHaveBeenCalled(); // B still holding its own window

    const list = await peekInOrder(store);
    expect(list.find((e) => e.idempotencyKey === "a")?.heldUntil).toBeUndefined();
    expect(list.find((e) => e.idempotencyKey === "b")?.heldUntil).toBeDefined();

    // The flush must actually CANCEL A's own timer (queue.ts's cancelTick),
    // not merely leave it dangling — exactly one fake timer pending now
    // (B's), never A's-plus-B's. Asserted directly on vitest's own timer
    // count rather than on queue.ts's internal tick registry (not exported,
    // and shouldn't be just for this).
    expect(vi.getTimerCount()).toBe(1);

    // Separately, and NOT what the assertion above is proving: even if that
    // cancellation somehow failed and A's stale timer fired anyway, a
    // SECOND onDue call is independently guarded by clearHeldFlag's own
    // idempotency (an already-unheld entry's second clear attempt is a
    // no-op, `cleared === false` — see queue.ts). t=6500 is past A's
    // original schedule (t=6000) but still short of B's real one (t=7000).
    await vi.advanceTimersByTimeAsync(5500); // t=6500
    expect(sendSpyA).toHaveBeenCalledTimes(1); // still just once
    expect(sendSpyB).not.toHaveBeenCalled(); // B's own window hasn't closed yet

    await vi.advanceTimersByTimeAsync(500); // t=7000 — B's real deadline
    expect(sendSpyB).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // nothing left pending
  });

  it("mutateHeld lands in the sent payload", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a", { payload: { runs: 1 } }), HOLD_MS, sendSpy);
    const applied = await mutateHeld(store, "a", (e) => ({ ...e, payload: { runs: 4 } }));
    expect(applied).toBe(true);

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = (await peekInOrder(store)).find((e) => e.idempotencyKey === "a");
    expect(sent?.payload).toEqual({ runs: 4 });
  });

  it("mutateHeld is a no-op once the entry is no longer held", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    await releaseHeld(store, "a"); // released early — no longer held

    const applied = await mutateHeld(store, "a", (e) => ({ ...e, payload: { runs: 99 } }));
    expect(applied).toBe(false);
    expect((await peekInOrder(store)).find((e) => e.idempotencyKey === "a")?.payload).toEqual({ text: "a" });
  });

  it("dropHeld removes without send and without core.void", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    const dropped = await dropHeld(store, "a");
    expect(dropped).toBe(true);

    await vi.advanceTimersByTimeAsync(HOLD_MS);

    expect(sendSpy).not.toHaveBeenCalled();
    const list = await peekInOrder(store);
    expect(list).toEqual([]);
    expect(list.some((e) => e.type === "core.void")).toBe(false);
  });

  it("dropHeld returns false for an id that names no currently-held entry", async () => {
    const store = memoryQueueStore();
    expect(await dropHeld(store, "ghost")).toBe(false);
  });

  it("releaseHeld sends immediately without waiting out the rest of the window", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    await releaseHeld(store, "a");

    expect(sendSpy).toHaveBeenCalledTimes(1); // sent right away, not after HOLD_MS
    expect((await peekInOrder(store)).find((e) => e.idempotencyKey === "a")?.heldUntil).toBeUndefined();

    // The now-cancelled natural tick must never ALSO fire.
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("flushHeldBefore is a no-op when nothing is held", async () => {
    const store = memoryQueueStore();
    await expect(flushHeldBefore(store, Date.now())).resolves.toBeUndefined();
  });

  it("reload durability: held event survives store rehydrate with its remaining window intact", async () => {
    const store = memoryQueueStore();
    const sendSpy = vi.fn();

    await enqueueHeld(store, event("a"), HOLD_MS, sendSpy);
    await vi.advanceTimersByTimeAsync(2000); // 2s elapsed, 4s of the window remain

    // Simulate the reload boundary queue-store.ts's persistence already
    // crosses: a plain JSON round-trip is the same structured-clone-shaped
    // boundary IndexedDB's real put()/list() cross for a field this
    // ordinary (a number — no Map/Set/class instance). queue-store.ts
    // itself needed NO code change for `heldUntil` to survive this: put()
    // persists whatever fields PendingEvent carries, generically.
    const persisted = JSON.parse(JSON.stringify(await peekInOrder(store))) as PendingEvent[];
    const rehydrated = memoryQueueStore();
    for (const entry of persisted) await rehydrated.put(entry);

    const found = (await rehydrated.list()).find((e) => e.idempotencyKey === "a");
    expect(found?.heldUntil).toBeDefined();
    // Remaining window intact — an ABSOLUTE deadline, not reset to a fresh
    // HOLD_MS by the reload.
    expect(found!.heldUntil! - Date.now()).toBe(HOLD_MS - 2000);
  });

  it("a plain enqueue (no hold) is untouched: peekInOrder returns the SAME event either way", async () => {
    // R1 ruling: enqueue() without a hold must keep today's exact
    // behaviour — this suite imports it fresh (not re-exported wrapped)
    // to prove queue.ts's own pre-existing export is untouched.
    const { enqueue } = await import("../queue");
    const store = memoryQueueStore();
    await enqueue(store, event("plain"));
    const [only] = await peekInOrder(store);
    expect(only).toEqual(event("plain"));
    expect(only?.heldUntil).toBeUndefined();
  });
});
