import "server-only";
// Single-flight cache-aside for a public document many readers miss at once
// (public hub perf T2, 2026-09-24).
//
// The plain cache-aside (`cachedFor`, usecases/public.ts) lets every reader
// that misses rebuild. That is harmless for a document read now and then, and
// ruinous for the competition hub: a score write DELs `pub:v1:hub:{id}` and
// pushes to every open tab, every tab refetches inside the same second, and
// each miss was a full rebuild (~9 + 13 x divisions queries) through a
// 12-connection pool. Here ONE caller takes a short lease (lib/cache.ts) and
// rebuilds; everyone else waits a bounded moment for its result.
//
// The rules, in the order a caller meets them:
//   1. A stored document that parses (and passes `isValid`) is served. One
//      GET — the same cost a hit always had.
//   2. On a miss, take the lease. The winner builds, then FILLS — a
//      compare-and-set against its own lease, so a write that DELeted the key
//      mid-build (and the lease with it) refuses the fill, and a document that
//      read the database before that write never goes back under the key. A
//      failed build gives the lease straight back.
//   3. A caller that finds a lease held polls the key with short sleeps for at
//      most `waitMs`. If the key empties meanwhile (the holder failed, its
//      lease expired, or a write deleted it) the caller takes the lease itself.
//   4. Out of patience: the last-known-good copy (`stale.key`, written in the
//      same step as every successful fill) if there is one, else a build of its
//      own — never a hang and never a 500 because of the lease. A caller that
//      builds without the lease writes nothing.
//   5. Redis unreachable or unconfigured at any point: build directly and
//      write nothing, which is what the plain cache-aside amounted to.
//
// Freshness (the spectator R10 promise). After a write's DEL, the key only
// ever holds a document whose build STARTED after that DEL: a fill needs its
// own marker still in place, the DEL removed every marker set before it, and a
// marker is always set before its build reads anything. A caller can be
// handed an older document only as the last-known-good copy — only after it
// has waited `waitMs` with a rebuild still in flight — and the fill that
// completes that rebuild overwrites the copy in the same Redis step, so once a
// fresh build has landed nobody is served the pre-write document again.
import { cacheLeaseAcquire, cacheLeaseFill, cacheLeaseRelease, cacheReadRaw, type RawRead } from "@/lib/cache";

export interface SingleFlightOptions<T> {
  key: string;
  ttlSeconds: number;
  build: () => Promise<T>;
  /** Shape check for anything read back from Redis. A value that fails it is
   *  a miss (and is replaced by the rebuild), never served and never thrown. */
  isValid?: (hit: unknown) => boolean;
  /** How long a rebuild may hold the key before its lease expires on its own
   *  — the bound on a crashed holder. Longer than a slow build. */
  leaseMs: number;
  /** How long a caller that finds a rebuild in flight polls for its result.
   *  0: build at once without the lease (and write nothing). */
  waitMs: number;
  /** The last-known-good copy, served only to a caller whose wait ran out. */
  stale?: { key: string; ttlSeconds: number };
}

/** First poll after this long, doubling up to POLL_MAX_MS: a 1.5 s wait is
 *  eight GETs, not fifteen — each one a billed Upstash command. */
export const POLL_FIRST_MS = 50;
export const POLL_MAX_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Accepted<T> = { ok: true; value: T } | { ok: false };

function accept<T>(read: RawRead, isValid?: (hit: unknown) => boolean): Accepted<T> {
  if (read.kind !== "value") return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return { ok: false };
  }
  if (isValid && !isValid(parsed)) return { ok: false };
  return { ok: true, value: parsed as T };
}

async function buildUnderLease<T>(o: SingleFlightOptions<T>, token: string): Promise<T> {
  let value: T;
  try {
    value = await o.build();
  } catch (err) {
    await cacheLeaseRelease(o.key, token);
    throw err;
  }
  await cacheLeaseFill(o.key, token, value, o.ttlSeconds, o.stale);
  return value;
}

/** The key is empty (or holds a value this build rejects): try to take it.
 *  Returns null when someone else holds it now. */
async function takeOver<T>(o: SingleFlightOptions<T>, read: RawRead): Promise<{ value: T } | null> {
  const lease = await cacheLeaseAcquire(o.key, o.leaseMs, read.kind === "value" ? "replace" : "absent");
  if (lease.kind === "acquired") return { value: await buildUnderLease(o, lease.token) };
  if (lease.kind === "unavailable") return { value: await o.build() };
  return null;
}

export async function cachedSingleFlight<T>(o: SingleFlightOptions<T>): Promise<T> {
  const first = await cacheReadRaw(o.key);
  const hit = accept<T>(first, o.isValid);
  if (hit.ok) return hit.value;
  if (first.kind === "unavailable") return o.build();
  if (first.kind !== "leased") {
    const took = await takeOver(o, first);
    if (took) return took.value;
  }

  const deadline = Date.now() + o.waitMs;
  let delay = POLL_FIRST_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, POLL_MAX_MS);
    const read = await cacheReadRaw(o.key);
    const got = accept<T>(read, o.isValid);
    if (got.ok) return got.value;
    if (read.kind === "unavailable") return o.build();
    if (read.kind === "leased") continue;
    const took = await takeOver(o, read);
    if (took) return took.value;
  }

  if (o.stale) {
    const copy = accept<T>(await cacheReadRaw(o.stale.key), o.isValid);
    if (copy.ok) return copy.value;
  }
  return o.build();
}
