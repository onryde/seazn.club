// The append/replay protocol (S10 replay ruling): pure decision functions
// (resolveConflict, deepEqual, reconcile) plus the thin network-driving
// functions (sendOne, drainQueue) that consume an INJECTED transport double
// — no real server anywhere in this file.
import { describe, expect, it } from "vitest";
import type { AppendSuccess, LedgerSlotEvent, OwnIdentity, PendingEvent } from "../types";
import { memoryQueueStore } from "../queue-store";
import { peekInOrder } from "../queue";
import {
  deepEqual,
  drainQueue,
  reconcile,
  resolveConflict,
  sendOne,
  type AppendCallResult,
  type AppendEventBody,
  type ScoringTransport,
} from "../pipeline";

function event(idempotencyKey: string, overrides: Partial<PendingEvent> = {}): PendingEvent {
  return {
    localId: `local-${idempotencyKey}`,
    idempotencyKey,
    type: "core.note",
    payload: { text: idempotencyKey },
    expectedSeq: 10,
    createdAt: "2026-08-12T00:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

const ME: OwnIdentity = { recordedBy: "user-1", deviceLinkId: null };
const success = (seq: number): AppendSuccess => ({ seq, state_summary: { seq }, outcome: null, status: "in_play" });

/** A scripted ScoringTransport double. `appendScript` is a FIFO queue of
 *  canned responses PER idempotency_key — each call to appendEvent for that
 *  key shifts the next entry, and a key running out of scripted responses
 *  throws (a test bug, not a code-under-test failure: it means sendOne made
 *  more append calls than the scenario expected). `slotsBySinceSeq` and
 *  `lastSeq`/`lastSeqThrows` model the two GET endpoints independently, by
 *  their real call signature (since_seq / fixtureId), never by which pending
 *  event triggered the call — exactly like the real HTTP API. */
function fakeTransport(config: {
  appendScript: Record<string, AppendCallResult[]>;
  slotsBySinceSeq?: Record<number, LedgerSlotEvent[]>;
  listEventsSinceThrows?: boolean;
  lastSeq?: number;
  lastSeqThrows?: boolean;
}) {
  const script = new Map(Object.entries(config.appendScript).map(([k, v]) => [k, [...v]]));
  const calls: { fixtureId: string; body: AppendEventBody }[] = [];
  const listCalls: { fixtureId: string; sinceSeq: number }[] = [];

  const transport: ScoringTransport = {
    async appendEvent(fixtureId, body) {
      calls.push({ fixtureId, body });
      const queue = script.get(body.idempotency_key);
      if (!queue || queue.length === 0) {
        throw new Error(`fakeTransport: no scripted response left for ${body.idempotency_key}`);
      }
      return queue.shift()!;
    },
    async listEventsSince(fixtureId, sinceSeq) {
      listCalls.push({ fixtureId, sinceSeq });
      if (config.listEventsSinceThrows) throw new Error("network error listing events");
      return config.slotsBySinceSeq?.[sinceSeq] ?? [];
    },
    async getLastSeq() {
      if (config.lastSeqThrows) throw new Error("network error reading state");
      if (config.lastSeq === undefined) throw new Error("fakeTransport: lastSeq not configured");
      return config.lastSeq;
    },
  };
  return { transport, calls, listCalls };
}

describe("resolveConflict — pure 409 ledger-slot decision", () => {
  const ours: LedgerSlotEvent = { seq: 11, type: "core.note", payload: { text: "a" }, recorded_by: "user-1", device_link_id: null };
  const foreign: LedgerSlotEvent = { seq: 11, type: "core.note", payload: { text: "SOMEONE ELSE" }, recorded_by: "user-2", device_link_id: null };

  it("no slot at all (unreadable or absent) → indeterminate, even when currentSeq is known", () => {
    expect(resolveConflict(event("a"), null, ME, 41)).toEqual({ kind: "indeterminate" });
    expect(resolveConflict(event("a"), null, ME, null)).toEqual({ kind: "indeterminate" });
  });

  it("slot matches type + deep-equal payload + our own recorded_by/device_link_id → already-applied", () => {
    expect(resolveConflict(event("a"), ours, ME, 41)).toEqual({ kind: "already-applied" });
  });

  it("slot matches on type/payload but a DIFFERENT recorded_by → foreign, not ours", () => {
    const sameContentDifferentAuthor: LedgerSlotEvent = { ...ours, recorded_by: "user-2" };
    expect(resolveConflict(event("a"), sameContentDifferentAuthor, ME, 41)).toEqual({
      kind: "renegotiate",
      expectedSeq: 41,
    });
  });

  it("foreign slot + a known currentSeq → renegotiate to exactly that seq", () => {
    expect(resolveConflict(event("a"), foreign, ME, 41)).toEqual({ kind: "renegotiate", expectedSeq: 41 });
  });

  it("foreign slot but currentSeq unavailable from either source → indeterminate, not a guess", () => {
    expect(resolveConflict(event("a"), foreign, ME, null)).toEqual({ kind: "indeterminate" });
  });

  it("payload equality is DEEP, not reference — key order must not matter", () => {
    const a = event("a", { payload: { x: 1, y: { z: 2 } } });
    const slot: LedgerSlotEvent = {
      seq: 11,
      type: "core.note",
      payload: { y: { z: 2 }, x: 1 },
      recorded_by: "user-1",
      device_link_id: null,
    };
    expect(resolveConflict(a, slot, ME, 41)).toEqual({ kind: "already-applied" });
  });
});

describe("resolveConflict — undefined-vs-null identity normalisation (review finding 1)", () => {
  // transport.ts's listEventsSince casts the ledger JSON with no runtime
  // validation prior to this fix, so an OMITTED key comes back `undefined`
  // at runtime despite LedgerSlotEvent's own type saying `string | null`.
  // A strict `===` against our own `null` would then read an ALREADY-
  // APPLIED own event as FOREIGN, renegotiate, and resend a real duplicate
  // — the exact failure the append/replay protocol exists to prevent.
  const asSlot = (o: object): LedgerSlotEvent => o as LedgerSlotEvent;

  it("recorded_by: slot OMITS the key (undefined) but identity holds null → still ours", () => {
    const slot = asSlot({ seq: 11, type: "core.note", payload: { text: "a" }, device_link_id: null });
    const identity: OwnIdentity = { recordedBy: null, deviceLinkId: null };
    expect(resolveConflict(event("a"), slot, identity, 41)).toEqual({ kind: "already-applied" });
  });

  it("recorded_by: identity holds undefined (forced, defends BOTH sides) but slot holds null → still ours", () => {
    const slot: LedgerSlotEvent = {
      seq: 11,
      type: "core.note",
      payload: { text: "a" },
      recorded_by: null,
      device_link_id: null,
    };
    const identity = { recordedBy: undefined, deviceLinkId: null } as unknown as OwnIdentity;
    expect(resolveConflict(event("a"), slot, identity, 41)).toEqual({ kind: "already-applied" });
  });

  it("device_link_id: slot OMITS the key (undefined) but identity holds null → still ours", () => {
    const slot = asSlot({ seq: 11, type: "core.note", payload: { text: "a" }, recorded_by: "user-1" });
    const identity: OwnIdentity = { recordedBy: "user-1", deviceLinkId: null };
    expect(resolveConflict(event("a"), slot, identity, 41)).toEqual({ kind: "already-applied" });
  });

  it("device_link_id: identity holds undefined (forced, defends BOTH sides) but slot holds null → still ours", () => {
    const slot: LedgerSlotEvent = {
      seq: 11,
      type: "core.note",
      payload: { text: "a" },
      recorded_by: "user-1",
      device_link_id: null,
    };
    const identity = { recordedBy: "user-1", deviceLinkId: undefined } as unknown as OwnIdentity;
    expect(resolveConflict(event("a"), slot, identity, 41)).toEqual({ kind: "already-applied" });
  });

  it("normalisation does NOT paper over a genuinely FOREIGN row — mirror-image guard", () => {
    const slot: LedgerSlotEvent = {
      seq: 11,
      type: "core.note",
      payload: { text: "a" },
      recorded_by: "user-2", // genuinely different, not merely absent
      device_link_id: null,
    };
    expect(resolveConflict(event("a"), slot, ME, 41)).toEqual({ kind: "renegotiate", expectedSeq: 41 });
  });
});

describe("deepEqual", () => {
  it("primitives, including NaN and signed zero via Object.is semantics", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("nested objects/arrays regardless of key order", () => {
    expect(deepEqual({ a: [1, 2, { b: "x" }] }, { a: [1, 2, { b: "x" }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it("different key sets are never equal, even if one key's value is undefined", () => {
    expect(deepEqual({ a: undefined }, {})).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("reconcile — pure optimistic-vs-server comparison", () => {
  it("matching states report 'match' and hand back the server's copy", () => {
    const optimistic = { phase: "live", score: { home: 1, away: 0 } };
    const server = { phase: "live", score: { home: 1, away: 0 } };
    expect(reconcile(optimistic, server)).toEqual({ kind: "match", state: server });
  });

  it("a real divergence reports both sides, never silently prefers one", () => {
    const optimistic = { phase: "live", score: { home: 1, away: 0 } };
    const server = { phase: "live", score: { home: 1, away: 1 } }; // e.g. a concurrent second scorer
    expect(reconcile(optimistic, server)).toEqual({ kind: "diverged", optimistic, server });
  });
});

describe("sendOne — the mutation-checked replay contract", () => {
  it("MUTATION TARGET: the initial send uses the event's persisted expectedSeq verbatim, never a freshly recomputed one", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 7 });
    await store.put(pending);
    // If sendOne ever "renegotiates blindly" on the FIRST attempt (e.g. reads
    // getLastSeq before sending instead of only after a proven-foreign 409),
    // this would send 99, not 7 — see the mutation-check note in the final
    // report for how this was verified to actually catch that regression.
    const { transport, calls } = fakeTransport({
      appendScript: { a: [{ kind: "ok", data: success(8) }] },
      lastSeq: 99,
    });
    await sendOne(transport, store, "fx-1", pending, ME);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.expected_seq).toBe(7);
    expect(calls[0]?.body.idempotency_key).toBe("a"); // never regenerated either
  });

  it("a plain success acks and removes the event from the queue", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);
    const { transport } = fakeTransport({ appendScript: { a: [{ kind: "ok", data: success(11) }] } });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({ kind: "acked", localId: "local-a", idempotencyKey: "a", result: success(11) });
    expect(await peekInOrder(store)).toEqual([]);
  });

  it("409 whose slot holds OUR event → dropped, never resent", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10, type: "core.note", payload: { text: "a" } });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: { a: [{ kind: "conflict", currentSeq: 12, message: "seq conflict" }] },
      slotsBySinceSeq: {
        10: [{ seq: 11, type: "core.note", payload: { text: "a" }, recorded_by: "user-1", device_link_id: null }],
      },
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({ kind: "already-applied", localId: "local-a", idempotencyKey: "a" });
    expect(await peekInOrder(store)).toEqual([]); // dropped
    expect(calls).toHaveLength(1); // NEVER resent
  });

  it("409 whose slot holds a FOREIGN event → renegotiated and resent exactly once", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: {
        a: [
          { kind: "conflict", currentSeq: 15, message: "seq conflict" },
          { kind: "ok", data: success(16) },
        ],
      },
      slotsBySinceSeq: {
        10: [{ seq: 11, type: "core.note", payload: { text: "SOMEONE ELSE" }, recorded_by: "user-2", device_link_id: null }],
      },
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({ kind: "acked", localId: "local-a", idempotencyKey: "a", result: success(16) });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.expected_seq).toBe(10); // original
    expect(calls[1]?.body.expected_seq).toBe(15); // renegotiated to current_seq from the 409 body
    expect(calls[1]?.body.idempotency_key).toBe("a"); // same key, never regenerated
    expect(await peekInOrder(store)).toEqual([]); // resolved
  });

  it("a foreign slot with no current_seq in the 409 body falls back to a fresh state read", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: {
        a: [
          { kind: "conflict", currentSeq: null, message: "seq conflict, no body seq" },
          { kind: "ok", data: success(21) },
        ],
      },
      slotsBySinceSeq: {
        10: [{ seq: 11, type: "core.note", payload: { text: "SOMEONE ELSE" }, recorded_by: "user-2", device_link_id: null }],
      },
      lastSeq: 20,
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome.kind).toBe("acked");
    expect(calls[1]?.body.expected_seq).toBe(20); // from the fresh state read, not the body
  });

  it("409 with an UNREADABLE slot (listEventsSince throws) → stays queued, never resends", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: { a: [{ kind: "conflict", currentSeq: 15, message: "seq conflict" }] },
      listEventsSinceThrows: true,
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({ kind: "stayed-queued", localId: "local-a", idempotencyKey: "a", reason: "indeterminate" });
    expect(calls).toHaveLength(1); // no resend on an unreadable slot
    const remaining = await peekInOrder(store);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.expectedSeq).toBe(10); // NOT renegotiated — nothing proven yet
    expect(remaining[0]?.attempts).toBe(1);
    expect(remaining[0]?.lastError).toBeTruthy();
  });

  it("409 with an ABSENT slot (ledger hasn't reached expectedSeq+1 yet) → stays queued, never resends", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: { a: [{ kind: "conflict", currentSeq: 15, message: "seq conflict" }] },
      slotsBySinceSeq: { 10: [] }, // fetch succeeded but no row at seq 11
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({ kind: "stayed-queued", localId: "local-a", idempotencyKey: "a", reason: "indeterminate" });
    expect(calls).toHaveLength(1);
    expect((await peekInOrder(store))[0]?.expectedSeq).toBe(10);
  });

  it("a second conflict on the renegotiated resend stops after exactly two calls, keeping the renegotiated seq persisted", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: {
        a: [
          { kind: "conflict", currentSeq: 15, message: "first conflict" },
          { kind: "conflict", currentSeq: 22, message: "second conflict" },
        ],
      },
      slotsBySinceSeq: {
        10: [{ seq: 11, type: "core.note", payload: { text: "SOMEONE ELSE" }, recorded_by: "user-2", device_link_id: null }],
      },
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({ kind: "stayed-queued", localId: "local-a", idempotencyKey: "a", reason: "conflict-again" });
    expect(calls).toHaveLength(2); // resent exactly once, not looped again within this call
    const remaining = await peekInOrder(store);
    expect(remaining[0]?.expectedSeq).toBe(15); // the FIRST renegotiation is durably kept
  });

  it("422 is surfaced (full detail in the outcome) AND removed so it does not spin forever", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: { a: [{ kind: "rejected", code: "INVALID_EVENT", message: "unknown entrant" }] },
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({
      kind: "rejected",
      localId: "local-a",
      idempotencyKey: "a",
      code: "INVALID_EVENT",
      message: "unknown entrant",
    });
    expect(await peekInOrder(store)).toEqual([]); // not retried forever
    expect(calls).toHaveLength(1); // and not retried at all — 422 is deterministic poison
  });

  it("a network failure leaves the event queued with attempts/lastError recorded, and never resends blindly", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10, attempts: 2 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({
      appendScript: { a: [{ kind: "network-error", message: "fetch failed" }] },
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toEqual({ kind: "stayed-queued", localId: "local-a", idempotencyKey: "a", reason: "network" });
    expect(calls).toHaveLength(1);
    const remaining = await peekInOrder(store);
    expect(remaining[0]?.attempts).toBe(3);
    expect(remaining[0]?.expectedSeq).toBe(10); // untouched
    expect(remaining[0]?.lastError).toBe("fetch failed");
  });
});

describe("drainQueue — order-preserving across a mixed run", () => {
  it("processes ack, 409-ours, 409-foreign, network-error (stop), then resumes ack, ack on the next call — never out of order", async () => {
    const store = memoryQueueStore();
    await store.put(event("e1", { expectedSeq: 100 }));
    await store.put(event("e2", { expectedSeq: 101, payload: { text: "e2" } }));
    await store.put(event("e3", { expectedSeq: 102, payload: { text: "e3" } }));
    await store.put(event("e4", { expectedSeq: 103, payload: { text: "e4" } }));
    await store.put(event("e5", { expectedSeq: 104, payload: { text: "e5" } }));

    const { transport: firstPass } = fakeTransport({
      appendScript: {
        e1: [{ kind: "ok", data: success(101) }],
        e2: [{ kind: "conflict", currentSeq: 108, message: "conflict" }],
        e3: [
          { kind: "conflict", currentSeq: 108, message: "conflict" },
          { kind: "ok", data: success(109) },
        ],
        e4: [{ kind: "network-error", message: "offline" }],
        // e5 must never be called this pass — no script entry, so a call
        // would throw "no scripted response left" and fail the test.
      },
      slotsBySinceSeq: {
        101: [{ seq: 102, type: "core.note", payload: { text: "e2" }, recorded_by: "user-1", device_link_id: null }], // ours
        102: [{ seq: 103, type: "core.note", payload: { text: "FOREIGN" }, recorded_by: "user-2", device_link_id: null }],
      },
    });

    const first = await drainQueue(firstPass, store, "fx-1", ME);

    expect(first.outcomes.map((o) => o.kind)).toEqual(["acked", "already-applied", "acked", "stayed-queued"]);
    expect(first.outcomes.map((o) => o.idempotencyKey)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(first.stoppedEarly).toBe(true);
    expect((await peekInOrder(store)).map((e) => e.idempotencyKey)).toEqual(["e4", "e5"]); // e5 untouched, in order

    // "Reconnect": e4 now succeeds, and e5 (never touched) succeeds too.
    const { transport: secondPass } = fakeTransport({
      appendScript: {
        e4: [{ kind: "ok", data: success(110) }],
        e5: [{ kind: "ok", data: success(111) }],
      },
    });

    const second = await drainQueue(secondPass, store, "fx-1", ME);

    expect(second.outcomes.map((o) => o.kind)).toEqual(["acked", "acked"]);
    expect(second.outcomes.map((o) => o.idempotencyKey)).toEqual(["e4", "e5"]);
    expect(second.stoppedEarly).toBe(false);
    expect(await peekInOrder(store)).toEqual([]);
  });

  it("a 422 in the middle of the queue is surfaced in the report but does not block the events behind it", async () => {
    const store = memoryQueueStore();
    await store.put(event("e1", { expectedSeq: 200 }));
    await store.put(event("e2", { expectedSeq: 201, payload: { text: "e2" } }));
    await store.put(event("e3", { expectedSeq: 202, payload: { text: "e3" } }));

    const { transport } = fakeTransport({
      appendScript: {
        e1: [{ kind: "ok", data: success(201) }],
        e2: [{ kind: "rejected", code: "INVALID_EVENT", message: "bad payload" }],
        e3: [{ kind: "ok", data: success(203) }],
      },
    });

    const report = await drainQueue(transport, store, "fx-1", ME);

    expect(report.outcomes.map((o) => o.kind)).toEqual(["acked", "rejected", "acked"]);
    expect(report.stoppedEarly).toBe(false);
    expect(await peekInOrder(store)).toEqual([]); // poison removed, nothing left spinning
  });
});
