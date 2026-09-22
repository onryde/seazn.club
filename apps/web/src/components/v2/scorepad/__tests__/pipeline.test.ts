// The append/replay protocol (S10 replay ruling): pure decision functions
// (resolveConflict, deepEqual, reconcile) plus the thin network-driving
// functions (sendOne, drainQueue) that consume an INJECTED transport double
// — no real server anywhere in this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  throttleBackoffMs,
  THROTTLE_BASE_MS,
  THROTTLE_MAX_MS,
  THROTTLE_SERVER_MAX_MS,
  type AppendCallResult,
  type AppendEventBody,
  type ScoringTransport,
} from "../pipeline";
import { sessionTransport } from "../transport";

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

  it("slot matches type + deep-equal payload + our own recorded_by/device_link_id, AND this is a RETRY (attempts > 0) → already-applied", () => {
    expect(resolveConflict(event("a", { attempts: 1 }), ours, ME, 41)).toEqual({ kind: "already-applied" });
  });

  it("Task 10 fix round 3 (R65/R67, F2 mechanism) — slot content-matches but this is the event's FIRST attempt (attempts === 0) → renegotiates, NEVER already-applied", () => {
    // The exact shape that dropped a legitimate second point live: a fresh
    // event (never sent before) 409s against a ledger slot that happens to be
    // byte-identical (e.g. a genuinely different, legitimately repeated
    // scorer action). Content match alone is not proof of a retry.
    expect(resolveConflict(event("a", { attempts: 0 }), ours, ME, 41)).toEqual({
      kind: "renegotiate",
      expectedSeq: 41,
    });
  });

  it("R65 mirror case — attempts === 0 AND currentSeq unavailable → indeterminate, never a guessed already-applied", () => {
    expect(resolveConflict(event("a", { attempts: 0 }), ours, ME, null)).toEqual({ kind: "indeterminate" });
  });

  it("slot matches on type/payload but a DIFFERENT recorded_by → foreign, not ours (even on a retry)", () => {
    const sameContentDifferentAuthor: LedgerSlotEvent = { ...ours, recorded_by: "user-2" };
    expect(resolveConflict(event("a", { attempts: 1 }), sameContentDifferentAuthor, ME, 41)).toEqual({
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

  it("payload equality is DEEP, not reference — key order must not matter (on a retry)", () => {
    const a = event("a", { payload: { x: 1, y: { z: 2 } }, attempts: 1 });
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

  // Task 10 fix round 3 (R65): each of these is exercised as a RETRY
  // (attempts: 1) — this describe block's own subject is identity
  // normalisation (undefined-vs-null), not the attempts gate, so every case
  // stays a genuine "our own retried event landed" scenario under the new
  // rule rather than silently becoming a renegotiate that this block was
  // never written to check.
  it("recorded_by: slot OMITS the key (undefined) but identity holds null → still ours", () => {
    const slot = asSlot({ seq: 11, type: "core.note", payload: { text: "a" }, device_link_id: null });
    const identity: OwnIdentity = { recordedBy: null, deviceLinkId: null };
    expect(resolveConflict(event("a", { attempts: 1 }), slot, identity, 41)).toEqual({ kind: "already-applied" });
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
    expect(resolveConflict(event("a", { attempts: 1 }), slot, identity, 41)).toEqual({ kind: "already-applied" });
  });

  it("device_link_id: slot OMITS the key (undefined) but identity holds null → still ours", () => {
    const slot = asSlot({ seq: 11, type: "core.note", payload: { text: "a" }, recorded_by: "user-1" });
    const identity: OwnIdentity = { recordedBy: "user-1", deviceLinkId: null };
    expect(resolveConflict(event("a", { attempts: 1 }), slot, identity, 41)).toEqual({ kind: "already-applied" });
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
    expect(resolveConflict(event("a", { attempts: 1 }), slot, identity, 41)).toEqual({ kind: "already-applied" });
  });

  it("normalisation does NOT paper over a genuinely FOREIGN row — mirror-image guard", () => {
    const slot: LedgerSlotEvent = {
      seq: 11,
      type: "core.note",
      payload: { text: "a" },
      recorded_by: "user-2", // genuinely different, not merely absent
      device_link_id: null,
    };
    expect(resolveConflict(event("a", { attempts: 1 }), slot, ME, 41)).toEqual({ kind: "renegotiate", expectedSeq: 41 });
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

  it("409 whose slot holds OUR event AND this is a RETRY (attempts > 0) → dropped, never resent", async () => {
    const store = memoryQueueStore();
    // attempts: 1 — R65's gate: a 409 that matches content is "already
    // applied" only when this exact queued event was already sent before
    // with an unknown outcome. Without that history, see the dedicated
    // "F2/R63" describe block below for the (fixed) opposite case.
    const pending = event("a", { expectedSeq: 10, type: "core.note", payload: { text: "a" }, attempts: 1 });
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
    // attempts: 1 — R65's gate: e2's 409 slot content-matches, and this
    // proves it as a genuine RETRY landing (see the "F2/R63" describe block
    // below for the attempts:0 case, which now renegotiates instead).
    await store.put(event("e2", { expectedSeq: 101, payload: { text: "e2" }, attempts: 1 }));
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

// ---------------------------------------------------------------------------
// Task 10 fix round 3 — B07a bench live run R59 found a legitimate second
// point silently dropped (rr-r2-c1: two consecutive `generic.score
// {by: alpha, points: 1}` half taps from one device, only ONE landed).
// Round 2 built a repro proving the mechanism (resolveConflict's old
// content-only "already-applied" verdict); this block is that repro,
// committed and green against the fix, plus its own mirror-image guard.
// ---------------------------------------------------------------------------
describe("F2/R63 — two legitimate identical consecutive taps (fix round 3, R65)", () => {
  it("BOTH land as distinct rows: a fresh event's 409 against a byte-matching slot renegotiates, it is not silently dropped", async () => {
    const store = memoryQueueStore();
    // Two REAL, separately-tapped events — same device, same type, same
    // payload (a scorer awarding the same entrant the same single point
    // twice in a row is completely legitimate). Neither has been sent
    // before (attempts: 0, the default) — e2's STALE expectedSeq (5,
    // identical to e1's, rather than a correctly-recomputed 6) is exactly
    // what a live client can hand a held entry when the ahead-of-it count
    // it captured at submit time turns out short by the time it drains —
    // see pipeline.ts's own doc for why the exact live trigger stays
    // unestablished; this proves the MECHANISM once such a 409 lands.
    await store.put(event("e1", { type: "generic.score", payload: { by: "id-alpha", points: 1 }, expectedSeq: 5 }));
    await store.put(event("e2", { type: "generic.score", payload: { by: "id-alpha", points: 1 }, expectedSeq: 5 }));

    const { transport, calls } = fakeTransport({
      appendScript: {
        // e1 lands cleanly at seq 6.
        e1: [{ kind: "ok", data: success(6) }],
        // e2's stale expected_seq=5 no longer matches the ledger tip (now
        // 6), so the server 409s exactly like a real SEQ_CONFLICT — and,
        // because e1 and e2 are genuinely identical taps, the row AT that
        // slot happens to byte-match e2's own payload.
        e2: [
          { kind: "conflict", currentSeq: 6, message: "conflict" },
          { kind: "ok", data: success(7) }, // the renegotiated resend
        ],
      },
      slotsBySinceSeq: {
        5: [{ seq: 6, type: "generic.score", payload: { by: "id-alpha", points: 1 }, recorded_by: "user-organiser", device_link_id: "dl-1" }],
      },
    });

    const identity: OwnIdentity = { recordedBy: "user-organiser", deviceLinkId: "dl-1" };
    const report = await drainQueue(transport, store, "fx-rr-r2-c1", identity);

    expect(report.outcomes.map((o) => o.kind)).toEqual(["acked", "acked"]);
    expect(calls).toHaveLength(3); // e1 once, e2 twice (original + renegotiated resend)
    expect(calls[1]?.body.expected_seq).toBe(5); // e2's original stale seq, sent verbatim first
    expect(calls[2]?.body.expected_seq).toBe(6); // renegotiated to the 409 body's current_seq
    expect(await peekInOrder(store)).toEqual([]); // both resolved, nothing left queued
  });

  it("MUTATION-CHECKED MIRROR: a genuine RETRY (network error, then reconnect) whose resend 409s against its own already-landed row STILL drops — the original S10 duplicate protection survives", async () => {
    const store = memoryQueueStore();
    const pending = event("e1", { type: "generic.score", payload: { by: "id-alpha", points: 1 }, expectedSeq: 5 });
    await store.put(pending);

    // First drain: the network eats the response. The client never learns
    // whether the server actually applied it.
    const { transport: firstPass } = fakeTransport({
      appendScript: { e1: [{ kind: "network-error", message: "fetch failed" }] },
    });
    const first = await drainQueue(firstPass, store, "fx-rr-r2-c1", ME);
    expect(first.outcomes).toEqual([{ kind: "stayed-queued", localId: "local-e1", idempotencyKey: "e1", reason: "network" }]);
    const requeued = await peekInOrder(store);
    expect(requeued[0]?.attempts).toBe(1); // recordAttempt ran — THIS is what makes the resend below a recognized retry

    // Reconnect: the SAME event (same idempotencyKey, same expectedSeq, now
    // attempts:1) is resent. The server, it turns out, DID apply it the
    // first time (the response was lost, not the write) — so this resend
    // 409s against a slot that is genuinely its own.
    const { transport: secondPass, calls } = fakeTransport({
      appendScript: { e1: [{ kind: "conflict", currentSeq: 6, message: "conflict" }] },
      slotsBySinceSeq: {
        5: [{ seq: 6, type: "generic.score", payload: { by: "id-alpha", points: 1 }, recorded_by: "user-1", device_link_id: null }],
      },
    });
    const second = await drainQueue(secondPass, store, "fx-rr-r2-c1", ME);

    expect(second.outcomes).toEqual([{ kind: "already-applied", localId: "local-e1", idempotencyKey: "e1" }]);
    expect(calls).toHaveLength(1); // no third send — dropped, not resent
    expect(await peekInOrder(store)).toEqual([]); // dropped, nothing left queued
  });
});

// ---------------------------------------------------------------------------
// Task 10 fix round 4 (B07a, ruling R68) — review finding C1: round 3's gate
// (`event.attempts > 0`) is correct, but nothing durably marked an event as
// "sent" until AFTER an OBSERVED failure (network-error/indeterminate 409/
// conflict-again — the three recordAttempt call sites round 3 shipped). A
// send whose response is never observed at all (tab death mid-flight — no
// client timeout in transport.ts) left `attempts` at 0 forever, so a resend
// that lands on the server's Redis replay-cache-miss path 409ed against its
// own already-landed row while still reading attempts===0 — misread as
// fresh, renegotiated, DUPLICATED. Fix: sendOne now persists a pre-send
// marker to the store BEFORE calling the transport at all, unconditionally.
// resolveConflict itself is unchanged — it still judges the value AS LOADED
// at the start of the CURRENT call, never that call's own just-written
// marker, which is what keeps F2 (a genuinely first-ever send) renegotiating
// instead of misreading itself as its own prior attempt.
// ---------------------------------------------------------------------------
describe("Task 10 fix round 4 (R68/C1) — a resend after an unobserved send still drops as already-applied", () => {
  it("C1: an unobserved send that actually landed is dropped on resend, never duplicated", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10, type: "core.note", payload: { text: "a" } }); // attempts: 0, genuinely fresh
    await store.put(pending);

    // First "mount": the send leaves the wire but the tab dies before any
    // response is ever read back — modelled with a transport whose
    // appendEvent hangs until explicitly released. Fired but NOT awaited
    // yet: we need to inspect what is durably persisted the instant BEFORE
    // any outcome is observed — exactly the window a real tab death cuts
    // through.
    let releaseHang: ((r: AppendCallResult) => void) | undefined;
    const hangingTransport: ScoringTransport = {
      appendEvent: () =>
        new Promise<AppendCallResult>((resolve) => {
          releaseHang = resolve;
        }),
      listEventsSince: async () => [],
      getLastSeq: async () => {
        throw new Error("unused in this phase");
      },
    };
    const firstAttempt = sendOne(hangingTransport, store, "fx-1", pending, ME);
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks past the pre-send write, up to the hung network call

    const midFlight = (await peekInOrder(store))[0];
    // The fix's whole point: on 8b5476e93 (pre-fix) nothing writes here
    // before an outcome is observed, so midFlight.attempts reads 0, not 1.
    expect(midFlight?.attempts).toBe(1);

    // Let the abandoned first call resolve harmlessly (a belated network
    // error — the real browser never gets this far) so nothing leaks past
    // this test.
    releaseHang?.({ kind: "network-error", message: "abandoned — models a tab death, never actually observed live" });
    await firstAttempt;

    // Second "mount": resumes with whatever the store now holds — the exact
    // record a reload would load. The original send in fact landed
    // server-side (see the matching ledger slot below); the server's Redis
    // replay cache missed on this resend, so it 409s.
    const reloaded = (await peekInOrder(store))[0]!;
    const { transport, calls } = fakeTransport({
      appendScript: { a: [{ kind: "conflict", currentSeq: 11, message: "seq conflict" }] },
      slotsBySinceSeq: {
        10: [{ seq: 11, type: "core.note", payload: { text: "a" }, recorded_by: "user-1", device_link_id: null }],
      },
    });

    const outcome = await sendOne(transport, store, "fx-1", reloaded, ME);

    expect(outcome).toEqual({ kind: "already-applied", localId: "local-a", idempotencyKey: "a" });
    expect(calls).toHaveLength(1); // NO second append — the exact duplicate C1 found
    expect(await peekInOrder(store)).toEqual([]);
  });

  it("F2 stays fixed: a genuinely first-ever send (never marked before) still renegotiates against an identical prior event, both land", async () => {
    const store = memoryQueueStore();
    // Two REAL, separately-tapped events, same device — neither has EVER
    // been through sendOne before (attempts: 0, the true default, not
    // hand-constructed). e2's stale expectedSeq collides with e1's landed
    // row once e1 lands first.
    await store.put(event("e1", { type: "generic.score", payload: { by: "id-alpha", points: 1 }, expectedSeq: 5 }));
    await store.put(event("e2", { type: "generic.score", payload: { by: "id-alpha", points: 1 }, expectedSeq: 5 }));

    const { transport, calls } = fakeTransport({
      appendScript: {
        e1: [{ kind: "ok", data: success(6) }],
        e2: [
          { kind: "conflict", currentSeq: 6, message: "conflict" },
          { kind: "ok", data: success(7) },
        ],
      },
      slotsBySinceSeq: {
        5: [
          {
            seq: 6,
            type: "generic.score",
            payload: { by: "id-alpha", points: 1 },
            recorded_by: "user-organiser",
            device_link_id: "dl-1",
          },
        ],
      },
    });

    const identity: OwnIdentity = { recordedBy: "user-organiser", deviceLinkId: "dl-1" };
    const report = await drainQueue(transport, store, "fx-1", identity);

    expect(report.outcomes.map((o) => o.kind)).toEqual(["acked", "acked"]); // BOTH land, never dropped
    expect(calls).toHaveLength(3); // e1 once, e2 twice (original + renegotiated resend)
    expect(await peekInOrder(store)).toEqual([]);
  });

  it("a genuine network-error retry still drops on its 409 resend — the original S10 duplicate protection is untouched by this fix", async () => {
    const store = memoryQueueStore();
    const pending = event("b", { type: "core.note", payload: { text: "b" }, expectedSeq: 20 });
    await store.put(pending);

    const { transport: firstPass } = fakeTransport({
      appendScript: { b: [{ kind: "network-error", message: "offline" }] },
    });
    const first = await sendOne(firstPass, store, "fx-1", pending, ME);
    expect(first).toEqual({ kind: "stayed-queued", localId: "local-b", idempotencyKey: "b", reason: "network" });
    const requeued = (await peekInOrder(store))[0]!;
    expect(requeued.attempts).toBe(1); // the OBSERVED failure marks it too — same value the pre-send marker already wrote

    const { transport: secondPass, calls } = fakeTransport({
      appendScript: { b: [{ kind: "conflict", currentSeq: 21, message: "conflict" }] },
      slotsBySinceSeq: {
        20: [{ seq: 21, type: "core.note", payload: { text: "b" }, recorded_by: "user-1", device_link_id: null }],
      },
    });
    const outcome = await sendOne(secondPass, store, "fx-1", requeued, ME);

    expect(outcome).toEqual({ kind: "already-applied", localId: "local-b", idempotencyKey: "b" });
    expect(calls).toHaveLength(1); // no resend
    expect(await peekInOrder(store)).toEqual([]);
  });

  it("ordering: the pre-send marker is durably persisted BEFORE the transport call, not after", async () => {
    const store = memoryQueueStore();
    const pending = event("a", { expectedSeq: 10 });
    await store.put(pending);

    const order: string[] = [];
    const observingTransport: ScoringTransport = {
      appendEvent: async () => {
        const stored = (await store.list()).find((e) => e.idempotencyKey === "a");
        order.push(`transport-call:attempts=${stored?.attempts}`);
        return { kind: "ok", data: success(11) };
      },
      listEventsSince: async () => [],
      getLastSeq: async () => 10,
    };

    await sendOne(observingTransport, store, "fx-1", pending, ME);

    // A single, unambiguous assertion: by the time the transport function
    // ran, the store already read attempts:1 — the marker write's promise
    // was awaited to completion before appendEvent was ever invoked. If the
    // marker moved to AFTER the send (or never happened), this reads
    // "attempts=0" instead and the test fails.
    expect(order).toEqual(["transport-call:attempts=1"]);
  });

  it("an old-shape record (attempts field absent/corrupted) never throws and stays on the SAFE side: healed to a real number, treated as never-sent", async () => {
    const store = memoryQueueStore();
    const corrupted = event("a", { expectedSeq: 10 });
    // Force the field out entirely — a hypothetical this type has never
    // actually shipped: `attempts` has been a required PendingEvent field
    // since the chassis's first commit (cc907a0b6, S10/#419), so no real
    // persisted queue can lack it. Tested anyway, belt-and-braces, per R68's
    // explicit ask about old-shape queues.
    const { attempts, ...withoutAttempts } = corrupted;
    void attempts;
    await store.put(withoutAttempts as unknown as PendingEvent);

    const { transport } = fakeTransport({
      appendScript: { a: [{ kind: "network-error", message: "offline" }] },
    });

    const outcome = await sendOne(transport, store, "fx-1", withoutAttempts as unknown as PendingEvent, ME);

    expect(outcome).toEqual({ kind: "stayed-queued", localId: "local-a", idempotencyKey: "a", reason: "network" });
    const remaining = await peekInOrder(store);
    // Healed to a real number (1), never NaN (`undefined + 1`) — and never
    // treated as an already-sent retry on the strength of a corrupted or
    // missing counter.
    expect(remaining[0]?.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// W1 (2026-09-22) — the customer harm of an edge challenge, proven one layer
// out. `transport.test.ts` pins the classification; only THIS can see whether
// the scorer keeps the tap, because the drop is `markDropped` in `sendOne` and
// a transport-only test never reaches it. Driven through the REAL
// `sessionTransport` against a fetch double, so the two halves cannot agree
// with each other about a shape neither of them produces.
// ---------------------------------------------------------------------------
describe("an edge challenge does not cost the scorer a tap", () => {
  /** A challenge/block page: an HTML body, so `res.json()` throws. */
  const challenge = (status: number) =>
    ({
      ok: false,
      status,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }) as unknown as Response;

  const envelope403 = () =>
    ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({ ok: false, error: { code: "FORBIDDEN", message: "device link revoked" } }),
    }) as unknown as Response;

  it("a 403 challenge leaves the event QUEUED rather than dropping it", async () => {
    const store = memoryQueueStore();
    const pending = event("cf1", { expectedSeq: 1 });
    await store.put(pending);
    const transport = sessionTransport({ fetchFn: async () => challenge(403) });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "network" });
    // THE assertion: `markDropped` was not called. This is the whole defect.
    expect(await peekInOrder(store)).toHaveLength(1);
  });

  it("…while a 403 that really IS ours still drops, so this did not become retry-forever", async () => {
    const store = memoryQueueStore();
    const pending = event("cf2", { expectedSeq: 1 });
    await store.put(pending);
    const transport = sessionTransport({ fetchFn: async () => envelope403() });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "rejected", code: "FORBIDDEN" });
    expect(await peekInOrder(store)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// W1 (2026-09-21), spec §4.6 — a throttled retry must not feed the limiter it
// is waiting on. The delay is DERIVED from the limiter's own fixed window, not
// picked; the server's own `Retry-After` outranks it when one arrives.
// ---------------------------------------------------------------------------
describe("throttle backoff", () => {
  // The derivation, pinned to its source of truth rather than to a number
  // typed in beside it: `SCORING_LIMIT` is a FIXED window, so the shortest
  // wait that can possibly clear it is one whole window. Move the server's
  // window and this test moves the client with it.
  it("the base wait is the limiter's own window, read out of scoring.ts", () => {
    const src = readFileSync(join(process.cwd(), "src/server/usecases/scoring.ts"), "utf8");
    const windowSeconds = /SCORING_LIMIT\s*=\s*\{[^}]*windowSeconds:\s*(\d+)/.exec(src)?.[1];
    expect(windowSeconds, "SCORING_LIMIT's windowSeconds is no longer readable").toBeDefined();
    expect(THROTTLE_BASE_MS).toBe(Number(windowSeconds) * 1000);
  });

  it("doubles per send, stays monotonic, and is bounded by the cap it declares", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((sends) => throttleBackoffMs(sends, null));
    expect(waits[0]).toBe(THROTTLE_BASE_MS); // the first throttle waits exactly one window
    for (let i = 1; i < waits.length; i++) {
      const prev = waits[i - 1]!;
      expect(waits[i]!).toBeGreaterThanOrEqual(prev);
      expect(waits[i]!).toBeLessThanOrEqual(THROTTLE_MAX_MS);
      if (prev * 2 <= THROTTLE_MAX_MS) expect(waits[i]).toBe(prev * 2);
    }
    expect(waits.at(-1)).toBe(THROTTLE_MAX_MS); // the cap is REACHED, not merely declared
  });

  it("a server Retry-After outranks the computed backoff", () => {
    expect(throttleBackoffMs(1, THROTTLE_BASE_MS * 3)).toBe(THROTTLE_BASE_MS * 3);
  });

  // Owner ruling 2026-09-21: obey generously, guess conservatively. This is
  // the case the old behaviour got WRONG — 30s is past our own 8s guess, so
  // clamping to `THROTTLE_MAX_MS` silently overrode a server that had told us
  // exactly what it wanted. The expected value differs from BOTH ceilings on
  // purpose; against either constant alone this test could not witness the
  // regression it exists for.
  it("honours a Retry-After well past our own guessed cap, verbatim", () => {
    const thirtySeconds = 30_000;
    expect(thirtySeconds).toBeGreaterThan(THROTTLE_MAX_MS); // the premise, not an assumption
    expect(thirtySeconds).toBeLessThan(THROTTLE_SERVER_MAX_MS);
    expect(throttleBackoffMs(1, thirtySeconds)).toBe(thirtySeconds);
  });

  // Still bounded, and the bound now matters more than it reads: nothing under
  // `src/server/api-v1` sets `Retry-After` (verified 2026-09-21), and
  // Cloudflare sits in front of this app, so every value this branch receives
  // today is set by an edge we do not configure in this repo. A header we do
  // not own must not be able to freeze a courtside queue behind a chip that
  // says "Catching up".
  it("…but is still bounded, so one unowned header cannot park a queue for an hour", () => {
    expect(throttleBackoffMs(1, 60 * 60 * 1000)).toBe(THROTTLE_SERVER_MAX_MS);
  });

  it("does NOT re-enter the limiter before the delay has passed", async () => {
    const store = memoryQueueStore();
    const pending = event("p1", { expectedSeq: 1, retryNotBefore: Date.now() + THROTTLE_MAX_MS });
    await store.put(pending);
    const { transport, calls } = fakeTransport({ appendScript: { p1: [{ kind: "ok", data: success(2) }] } });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(calls).toHaveLength(0); // THE assertion: the limiter was never touched
    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "throttled" });
    const remaining = await peekInOrder(store);
    expect(remaining).toHaveLength(1); // the tap is kept
    // No send happened, so the pre-send marker must not move either — a
    // backoff that counted its own refusals would inflate itself to the cap.
    expect(remaining[0]?.attempts).toBe(0);
  });

  it("sends again once the delay has passed", async () => {
    const store = memoryQueueStore();
    const pending = event("p2", { expectedSeq: 1, retryNotBefore: Date.now() - 1 });
    await store.put(pending);
    const { transport, calls } = fakeTransport({ appendScript: { p2: [{ kind: "ok", data: success(2) }] } });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(calls).toHaveLength(1);
    expect(outcome.kind).toBe("acked");
  });

  it("a 429 stamps a retryNotBefore at least the computed delay out", async () => {
    const store = memoryQueueStore();
    const pending = event("p3", { expectedSeq: 1, attempts: 0 });
    await store.put(pending);
    const { transport } = fakeTransport({
      appendScript: { p3: [{ kind: "throttled", message: "Too many requests", retryAfterMs: null }] },
    });
    const before = Date.now();

    await sendOne(transport, store, "fx-1", pending, ME);

    const remaining = (await peekInOrder(store))[0]!;
    expect(remaining.retryNotBefore).toBeGreaterThanOrEqual(before + throttleBackoffMs(1, null));
  });

  it("honours the server's Retry-After when the 429 carries one", async () => {
    const store = memoryQueueStore();
    const pending = event("p4", { expectedSeq: 1, attempts: 0 });
    await store.put(pending);
    const { transport } = fakeTransport({
      appendScript: { p4: [{ kind: "throttled", message: "slow down", retryAfterMs: THROTTLE_MAX_MS }] },
    });
    const before = Date.now();

    await sendOne(transport, store, "fx-1", pending, ME);

    const remaining = (await peekInOrder(store))[0]!;
    // Strictly longer than the backoff this send would otherwise have chosen,
    // so the assertion cannot pass on the computed value by coincidence.
    expect(throttleBackoffMs(1, null)).toBeLessThan(THROTTLE_MAX_MS);
    expect(remaining.retryNotBefore).toBeGreaterThanOrEqual(before + THROTTLE_MAX_MS);
  });
});

// ---------------------------------------------------------------------------
// W1 (2026-09-21) — a throttled write is throttled, never "offline".
// `use-pad-pipeline` raises the offline chip on `reason === "network"` alone,
// so the reason this function returns is what the scorer is told.
// ---------------------------------------------------------------------------
describe("throttled", () => {
  it("a throttled send stays queued WITHOUT claiming the pad is offline", async () => {
    const store = memoryQueueStore();
    const pending = event("t1", { expectedSeq: 1, attempts: 0 });
    await store.put(pending);
    const { transport } = fakeTransport({
      appendScript: { t1: [{ kind: "throttled", message: "Too many requests", retryAfterMs: null }] },
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "throttled" });
    expect(await peekInOrder(store)).toHaveLength(1); // the tap is NOT lost
    expect((await peekInOrder(store))[0]?.lastError).toBe("Too many requests");
  });

  // The SECOND place a 429 can land, and the easy one to leave lying: the
  // post-renegotiation tail reports "conflict-again" or "network", so a
  // throttled resend was about to be filed as a connectivity failure — the
  // very lie this task exists to remove, one branch deeper.
  it("a throttled RESEND is throttled too, not relabelled as a network failure", async () => {
    const store = memoryQueueStore();
    const pending = event("t2", { expectedSeq: 5, attempts: 0 });
    await store.put(pending);
    const { transport } = fakeTransport({
      appendScript: {
        t2: [
          { kind: "conflict", currentSeq: 99, message: "stale" },
          { kind: "throttled", message: "Too many requests", retryAfterMs: null },
        ],
      },
      slotsBySinceSeq: {
        5: [{ seq: 6, type: "core.note", payload: { text: "SOMEONE ELSE" }, recorded_by: "user-2", device_link_id: null }],
      },
    });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "throttled" });
    expect(await peekInOrder(store)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// W1 (2026-09-21) — the queue always makes progress.
//
// Task 4 classifies the four terminal undo refusals we know about. This is the
// backstop for the ones we do not: any event still conflicting after
// renegotiation, past a bounded number of drain passes, is surfaced instead of
// left at the head blocking every write behind it.
// ---------------------------------------------------------------------------
describe("conflict ceiling", () => {
  /** The 409 → foreign slot → renegotiate → 409 again shape, scripted once. */
  function conflictTwiceOn(key: string, secondAttempt: AppendCallResult) {
    return fakeTransport({
      appendScript: { [key]: [{ kind: "conflict", currentSeq: 99, message: "stale" }, secondAttempt] },
      slotsBySinceSeq: {
        5: [{ seq: 6, type: "core.note", payload: { text: "SOMEONE ELSE" }, recorded_by: "user-2", device_link_id: null }],
      },
    });
  }

  // THE differential case, and the reason the ceiling counts its own passes
  // instead of reusing `attempts`. `attempts` is a PRE-SEND marker written on
  // every physical send of EVERY outcome kind, so an event that merely sat on
  // dead venue wifi arrives at its first genuine seq race with the ceiling
  // already armed — and gets dead-lettered for losing that race once. Offline
  // THEN contended is the normal condition of a courtside device.
  //
  // Fixtured with attempts well past the ceiling and ZERO conflict passes: the
  // two counters must not be the same counter.
  it("does NOT dead-letter on a first genuine race just because the pad had been offline", async () => {
    const store = memoryQueueStore();
    const pending = event("c0", { expectedSeq: 5, attempts: 7, conflictPasses: 0 });
    await store.put(pending);
    const { transport } = conflictTwiceOn("c0", { kind: "conflict", currentSeq: 99, message: "stale again" });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "conflict-again" });
    const remaining = await peekInOrder(store);
    expect(remaining).toHaveLength(1); // the scorer's point is NOT dropped
    expect(remaining[0]?.conflictPasses).toBe(1); // …and this race was counted
  });

  it("dead-letters an event that keeps conflicting after the ceiling", async () => {
    const store = memoryQueueStore();
    // Both counters set: a real event with spent conflict passes has also made
    // sends. It is `conflictPasses` that arms the ceiling.
    const pending = event("c1", { expectedSeq: 5, attempts: 2, conflictPasses: 2 });
    await store.put(pending);
    const { transport } = conflictTwiceOn("c1", { kind: "conflict", currentSeq: 99, message: "stale again" });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "rejected", code: "QUEUE_STALLED" });
    expect(await peekInOrder(store)).toHaveLength(0); // head cleared
  });

  it("below the ceiling it still renegotiates rather than giving up", async () => {
    const store = memoryQueueStore();
    const pending = event("c2", { expectedSeq: 5, attempts: 0, conflictPasses: 0 });
    await store.put(pending);
    const { transport } = conflictTwiceOn("c2", { kind: "conflict", currentSeq: 99, message: "stale again" });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "conflict-again" });
    expect(await peekInOrder(store)).toHaveLength(1); // still queued, by design
  });

  // THE load-bearing negative, in both places a network failure can land. An
  // offline venue must queue forever; a ceiling that catches network failures
  // turns a wifi blip into lost rallies, which is a worse defect than the
  // wedge this whole wave exists to fix.
  //
  // The FIRST-SEND case alone cannot witness that: it returns before the
  // ceiling is ever consulted, so it stays green under a mutant that deletes
  // the `second.kind === "conflict"` guard entirely. The RESEND case is the
  // one that reaches the tail the ceiling actually lives in — it is the mutant
  // killer, and the reason both are here.
  it("NEVER dead-letters a network failure on the FIRST send, however many attempts", async () => {
    const store = memoryQueueStore();
    const pending = event("n1", { expectedSeq: 5, attempts: 500, conflictPasses: 5 });
    await store.put(pending);
    const { transport } = fakeTransport({ appendScript: { n1: [{ kind: "network-error", message: "offline" }] } });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "network" });
    expect(await peekInOrder(store)).toHaveLength(1);
  });

  it("NEVER dead-letters a network failure on the RESEND either, well past the ceiling", async () => {
    const store = memoryQueueStore();
    // conflictPasses deliberately PAST the ceiling: this case must stay lethal
    // to a mutant that drops the `second.kind === "conflict"` guard, and it can
    // only be lethal if the counter the ceiling reads is already spent.
    const pending = event("n2", { expectedSeq: 5, attempts: 500, conflictPasses: 5 });
    await store.put(pending);
    const { transport } = conflictTwiceOn("n2", { kind: "network-error", message: "offline" });

    const outcome = await sendOne(transport, store, "fx-1", pending, ME);

    expect(outcome).toMatchObject({ kind: "stayed-queued", reason: "network" });
    expect(await peekInOrder(store)).toHaveLength(1); // the tap is NOT lost
  });
});
