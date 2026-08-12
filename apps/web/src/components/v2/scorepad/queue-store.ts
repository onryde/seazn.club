// Durable storage seam for the offline queue (S10 scope item 2: "pending
// events in IndexedDB keyed by idempotency_key, surviving tab death and
// reload"). QueueStore is deliberately tiny — list/put/delete/clear — so
// queue.ts's ordering/idempotency operations (enqueue, peek-in-order,
// mark-acked, mark-dropped, recordAttempt, renegotiate) can all be expressed
// in terms of these four primitives without the store needing to know
// anything about the append/replay protocol.
import type { PendingEvent } from "./types";

export interface QueueStore {
  /** All pending events, in insertion order (oldest first). */
  list(): Promise<PendingEvent[]>;
  /** Insert a new event, or REPLACE an existing one with the same
   *  `idempotencyKey` in place — a replace must not change its position in
   *  `list()`'s order (queue.ts's `recordAttempt`/`renegotiateExpectedSeq`
   *  depend on this: bumping `attempts` or renegotiating `expectedSeq` on an
   *  already-queued event must not reorder the queue). */
  put(event: PendingEvent): Promise<void>;
  /** Remove the event with this idempotencyKey. A no-op if absent. */
  delete(idempotencyKey: string): Promise<void>;
  /** Remove every pending event. */
  clear(): Promise<void>;
}

/**
 * In-memory QueueStore — the SSR/Node fallback and the default for tests
 * that don't care about persistence. A `Map` preserves insertion order, and
 * critically, re-`set`ting an EXISTING key does not move it (iteration order
 * is insertion order; only a delete-then-add re-inserts at the end) — that
 * is exactly the "replace in place" contract `QueueStore.put` needs, for
 * free.
 */
export function memoryQueueStore(): QueueStore {
  const events = new Map<string, PendingEvent>();
  return {
    async list() {
      return [...events.values()];
    },
    async put(event) {
      events.set(event.idempotencyKey, event);
    },
    async delete(idempotencyKey) {
      events.delete(idempotencyKey);
    },
    async clear() {
      events.clear();
    },
  };
}

const STORE_NAME = "pending-events";
const SEQ_INDEX = "by-seq-no";

/** Store-internal monotonic ordering key. IndexedDB's own primary key here
 *  is `idempotencyKey` (a UUID, so its natural key ordering is NOT insertion
 *  order — "do NOT rely on key ordering of UUIDs" per the S10 brief), so
 *  `list()` sorts by this instead. Never exposed outside this file. */
interface StoredRecord extends PendingEvent {
  _seqNo: number;
}

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
        store.createIndex(SEQ_INDEX, "_seqNo", { unique: false });
      }
    };
    // Review finding 5: without these two handlers, a future schema bump
    // (a later tab/deploy calling `indexedDB.open(dbName, N+1)`) blocks
    // indefinitely — an open connection here never yields, and that other
    // tab's own `onblocked` never clears while this one stays open.
    // `onversionchange` fires on THIS already-open connection when some
    // OTHER context requests the bump — closing it lets that upgrade
    // proceed. `onblocked` is the mirror case (THIS open being the one
    // stuck behind a stale connection); there is nothing to recover here
    // beyond surfacing it, since a store held open elsewhere is outside
    // this file's control.
    req.onblocked = () => {
      console.warn(`indexedDB.open(${dbName}) blocked by another connection on an older version`);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error(`indexedDB.open(${dbName}) failed`));
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function stripSeqNo(record: StoredRecord): PendingEvent {
  const { _seqNo, ...event } = record;
  void _seqNo;
  return event;
}

/**
 * Real IndexedDB-backed QueueStore — survives tab death/reload, which is the
 * entire point of this tree. Hand-written (no `idb` package in this
 * workspace, and the S10 brief forbids adding one) but small: one DB open,
 * one object store, one secondary index for ordering.
 *
 * GUARD: Node has no `indexedDB` global (true for every vitest run in this
 * repo, and for any SSR render), so this degrades to `memoryQueueStore()`
 * whenever the global is absent, rather than throwing. That is the SAME
 * `QueueStore` contract either way — see __tests__/queue-store.test.ts,
 * which runs the shared contract suite against whatever this returns.
 */
export function indexedDbQueueStore(dbName: string): QueueStore {
  if (typeof indexedDB === "undefined") {
    return memoryQueueStore();
  }

  const dbPromise = openDb(dbName);

  return {
    async list() {
      const db = await dbPromise;
      const tx = db.transaction(STORE_NAME, "readonly");
      const records = await reqToPromise<StoredRecord[]>(tx.objectStore(STORE_NAME).index(SEQ_INDEX).getAll());
      await txDone(tx);
      return records.sort((a, b) => a._seqNo - b._seqNo).map(stripSeqNo);
    },

    async put(event) {
      const db = await dbPromise;
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const existing = await reqToPromise<StoredRecord | undefined>(store.get(event.idempotencyKey));
      let seqNo = existing?._seqNo;
      if (seqNo === undefined) {
        // Fresh key — append after whatever currently sorts last.
        const cursor = await reqToPromise<IDBCursorWithValue | null>(
          store.index(SEQ_INDEX).openCursor(null, "prev"),
        );
        seqNo = cursor ? (cursor.value as StoredRecord)._seqNo + 1 : 0;
      }
      store.put({ ...event, _seqNo: seqNo } satisfies StoredRecord);
      await txDone(tx);
    },

    async delete(idempotencyKey) {
      const db = await dbPromise;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(idempotencyKey);
      await txDone(tx);
    },

    async clear() {
      const db = await dbPromise;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      await txDone(tx);
    },
  };
}
