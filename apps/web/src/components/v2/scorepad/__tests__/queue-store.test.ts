// ONE shared, table-driven contract suite run against BOTH QueueStore
// implementations (S10 brief: "same contract test suite runs against BOTH
// stores, not two hand-written ones"). `indexedDbQueueStore` degrades to a
// memory store whenever `indexedDB` is undefined — true for every vitest run
// in this repo (apps/web/vitest.config.ts pins `environment: "node"`, and
// Node ships no IndexedDB implementation) — so under this suite the second
// describe block below exercises the FALLBACK path for real, and the
// IndexedDB-specific mechanics (real persistence across a reopened
// connection) live in their own explicitly-skipped block further down.
import { describe, expect, it, beforeEach } from "vitest";
import type { PendingEvent } from "../types";
import { indexedDbQueueStore, memoryQueueStore, type QueueStore } from "../queue-store";

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

function describeQueueStoreContract(label: string, makeStore: () => QueueStore | Promise<QueueStore>): void {
  describe(`QueueStore contract — ${label}`, () => {
    let store: QueueStore;

    beforeEach(async () => {
      store = await makeStore();
      await store.clear(); // isolates from any prior test against a persistent backend
    });

    it("starts empty", async () => {
      expect(await store.list()).toEqual([]);
    });

    it("put appends new entries in insertion order", async () => {
      await store.put(event("a"));
      await store.put(event("b"));
      await store.put(event("c"));
      expect((await store.list()).map((e) => e.idempotencyKey)).toEqual(["a", "b", "c"]);
    });

    it("put on an EXISTING key replaces the value in place, without moving its position", async () => {
      await store.put(event("a"));
      await store.put(event("b"));
      await store.put(event("c"));
      await store.put(event("b", { attempts: 5, lastError: "boom", expectedSeq: 9 }));

      const list = await store.list();
      expect(list.map((e) => e.idempotencyKey)).toEqual(["a", "b", "c"]); // position unchanged
      expect(list[1]).toEqual(event("b", { attempts: 5, lastError: "boom", expectedSeq: 9 })); // content updated
    });

    it("delete removes the matching entry and preserves the order of the rest", async () => {
      await store.put(event("a"));
      await store.put(event("b"));
      await store.put(event("c"));
      await store.delete("b");
      expect((await store.list()).map((e) => e.idempotencyKey)).toEqual(["a", "c"]);
    });

    it("delete on an unknown key is a no-op, not an error", async () => {
      await store.put(event("a"));
      await expect(store.delete("does-not-exist")).resolves.toBeUndefined();
      expect(await store.list()).toEqual([event("a")]);
    });

    it("clear empties the store", async () => {
      await store.put(event("a"));
      await store.put(event("b"));
      await store.clear();
      expect(await store.list()).toEqual([]);
    });

    it("a longer mixed sequence preserves order end to end", async () => {
      await store.put(event("a"));
      await store.put(event("b"));
      await store.delete("a");
      await store.put(event("c"));
      await store.put(event("b", { attempts: 1 })); // in-place update of b
      await store.put(event("d"));
      expect((await store.list()).map((e) => e.idempotencyKey)).toEqual(["b", "c", "d"]);
    });
  });
}

describeQueueStoreContract("memoryQueueStore", () => memoryQueueStore());
describeQueueStoreContract(
  "indexedDbQueueStore (this environment has no `indexedDB` global, so this exercises its documented memory fallback)",
  () => indexedDbQueueStore("scorepad-contract-shared"),
);

describe("indexedDbQueueStore SSR/Node fallback", () => {
  it("returns a working store when `indexedDB` is undefined, rather than throwing", async () => {
    expect(typeof indexedDB).toBe("undefined"); // pins the precondition this test actually needs
    const store = indexedDbQueueStore("scorepad-fallback-check");
    await store.put(event("only"));
    expect(await store.list()).toEqual([event("only")]);
  });
});

// Real IndexedDB-only mechanics: skipped here because Node has no
// `indexedDB` implementation and this repo may not add fake-indexeddb as a
// new dependency (S10 brief). A later pass in this worktree, once a
// route/harness exists to host the pad in a real browser, drives this with
// Playwright — see the S10 session prompt's E2E note about mounting a
// test-only harness route and exercising tab death/offline/drain for real.
// Do NOT delete this block to "fix" the skip — it documents exactly what
// still needs browser coverage.
describe.skipIf(typeof indexedDB === "undefined")(
  "indexedDbQueueStore — real IndexedDB persistence (browser only)",
  () => {
    it("a second store opened against the same dbName sees data the first one wrote — survives 'reload'", async () => {
      const dbName = `scorepad-idb-persist-${Date.now()}`;
      const first = indexedDbQueueStore(dbName);
      await first.put(event("a"));
      const second = indexedDbQueueStore(dbName); // simulates reopening after a tab reload
      expect(await second.list()).toEqual([event("a")]);
    });

    it("two different dbNames do not see each other's data", async () => {
      const a = indexedDbQueueStore(`scorepad-idb-iso-a-${Date.now()}`);
      const b = indexedDbQueueStore(`scorepad-idb-iso-b-${Date.now()}`);
      await a.put(event("a"));
      expect(await b.list()).toEqual([]);
    });
  },
);
