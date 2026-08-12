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

// review finding 5: openDb() wired NO db.onversionchange / req.onblocked
// handler, so a future schema bump (a later tab calling `indexedDB.open(db,
// N+1)`) would leave THIS tab's connection open forever, blocking that
// tab's upgrade indefinitely. Node has no real `indexedDB` (confirmed
// throughout this file), so proving the wiring needs a global to open
// against — NOT the banned `fake-indexeddb` package (the S10 brief forbids
// adding it) and NOT the `describe.skipIf` block above (that one is real
// IndexedDB persistence, deliberately left for a browser pass). This is a
// hand-rolled ~40-line stub, scoped to exactly what openDb() touches
// (open/onupgradeneeded/onsuccess/onblocked, objectStoreNames.contains,
// createObjectStore→createIndex, db.onversionchange/close) — enough to
// prove the two handlers are ATTACHED, never a general IDB emulation.
describe("indexedDbQueueStore — onversionchange/onblocked wiring (review finding 5)", () => {
  type Listener = (() => void) | null;

  class FakeDb {
    onversionchange: Listener = null;
    closeCalls = 0;
    objectStoreNames = { contains: () => false };
    createObjectStore() {
      return { createIndex() {} };
    }
    close() {
      this.closeCalls += 1;
    }
  }

  class FakeOpenRequest {
    onupgradeneeded: Listener = null;
    onsuccess: Listener = null;
    onerror: Listener = null;
    onblocked: Listener = null;
    error: unknown = null;
    constructor(public result: FakeDb) {}
  }

  /** Installs a minimal `indexedDB` global whose `.open()` returns a
   *  request that fires `onupgradeneeded` then `onsuccess` on a later
   *  microtask (never synchronously — openDb() attaches its handlers
   *  AFTER calling `.open()`, in the same synchronous tick, so firing
   *  eagerly would call handlers that are not assigned yet). Always
   *  restore in a `finally` — this global does not exist in Node by
   *  default, and every OTHER test in this file depends on that. */
  function installFakeIndexedDB() {
    const db = new FakeDb();
    const req = new FakeOpenRequest(db);
    const opens: { name: string; version: number | undefined }[] = [];
    const fakeFactory = {
      open(name: string, version?: number) {
        opens.push({ name, version });
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req as unknown as IDBOpenDBRequest;
      },
    };
    Object.defineProperty(globalThis, "indexedDB", { value: fakeFactory, configurable: true });
    return { db, req, opens };
  }

  function uninstallFakeIndexedDB() {
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
  }

  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  it("req.onblocked is a real handler, not left null", async () => {
    const { req } = installFakeIndexedDB();
    try {
      indexedDbQueueStore("scorepad-onblocked-check"); // openDb() runs synchronously inside this call
      expect(typeof req.onblocked).toBe("function");
      expect(() => req.onblocked?.()).not.toThrow(); // firing it must not crash the open
    } finally {
      uninstallFakeIndexedDB();
    }
  });

  it("a successfully opened db closes itself on db.onversionchange, so it never blocks a later tab's upgrade", async () => {
    const { db } = installFakeIndexedDB();
    try {
      indexedDbQueueStore("scorepad-onversionchange-check");
      await settle(); // let the queued onupgradeneeded/onsuccess fire
      expect(typeof db.onversionchange).toBe("function");
      expect(db.closeCalls).toBe(0);
      db.onversionchange?.(); // simulates another tab requesting a version bump
      expect(db.closeCalls).toBe(1);
    } finally {
      uninstallFakeIndexedDB();
    }
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
