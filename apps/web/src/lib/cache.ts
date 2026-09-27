import "server-only";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { log } from "@/server/logger";

/**
 * Redis (Upstash) client + cache-aside helpers (doc 02 §5.3, doc 05 §8).
 *
 * Everything here is **fail-open**: if REDIS_URL is unset or Redis is
 * unreachable, cache reads miss and writes no-op, so the app falls back to
 * Postgres. Redis is a latency optimisation, never a correctness dependency.
 */
const globalForRedis = globalThis as unknown as { _redis?: Redis | null };

function client(): Redis | null {
  if (globalForRedis._redis !== undefined) return globalForRedis._redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    globalForRedis._redis = null;
    return null;
  }
  const redis = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // Don't let a Redis outage crash the process; we fail open per call.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on("error", () => {
    /* swallow — callers handle null/misses */
  });
  globalForRedis._redis = redis;
  return redis;
}

/** True when a Redis URL is configured (cache is active). */
export function cacheEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/** Get + JSON-parse a cached value, or null on miss/error. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const c = client();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** JSON-serialise + set with a TTL (seconds). No-op on error. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* fail open */
  }
}

/**
 * Delete keys by their full names with ONE direct DEL, and no SCAN. When the
 * names are already known, `cacheDelPattern` below walks the whole keyspace to
 * find them. No-op on error, and when handed no keys (a bare DEL is an arity
 * error).
 */
export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const c = client();
  if (!c) return;
  try {
    await c.del(...keys);
  } catch {
    /* fail open */
  }
}

/**
 * R10 I1: the longest a public-cache writer waits on its literal-key DEL before
 * sending its realtime pushes anyway. ioredis has no command timeout (`client()`
 * above sets none), so a Redis that stops answering without dropping the
 * connection would never settle the DEL. Every push would then be lost while
 * every subscribed page polls only as a slow safety net.
 */
export const PUSH_AFTER_DELETE_BOUND_MS = 1_500;

/**
 * Run `send` EXACTLY ONCE: when `deleted` settles, or after
 * PUSH_AFTER_DELETE_BOUND_MS, whichever comes first (R10 I1). Not awaited, so it
 * never holds the caller's response. Whichever of the two comes first sends; the
 * other finds `sent` and does nothing, so a DEL that settles after the bound
 * never sends twice. A DEL that settles first clears the timer, so nothing stays
 * armed after it.
 *
 * Both public-cache writers send through here, so the two cannot drift: a score
 * write (`invalidatePublicCache`, usecases/scoring.ts) and a schedule write
 * (`afterScheduleWrite`, usecases/schedule.ts, R10c m1). Each caller still
 * attaches its own logging `.catch` first (F4), so a failed delete is logged
 * with the keys it was for. `send` must not throw.
 *
 * A `deleted` that REJECTS still sends, and leaves nothing unhandled (R10d n1).
 * `.then(once, once)` handles both outcomes. `.finally(once)` would pass the
 * rejection on to a derived promise nobody holds, which is an unhandled
 * rejection. A bare `cacheDel(key)` can reject: `client()` sits outside its try,
 * and ioredis throws synchronously on a REDIS_URL it cannot parse.
 */
export function sendAfterDeleteOrBound(deleted: Promise<unknown>, send: () => void): void {
  let sent = false;
  const once = () => {
    if (sent) return;
    sent = true;
    clearTimeout(bound);
    send();
  };
  const bound = setTimeout(once, PUSH_AFTER_DELETE_BOUND_MS);
  void deleted.then(once, once);
}

/** Delete keys matching a glob pattern (e.g. "ent:{org}:*"). No-op on error. */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    const stream = c.scanStream({ match: pattern, count: 100 });
    const pipeline = c.pipeline();
    let any = false;
    for await (const keys of stream as AsyncIterable<string[]>) {
      for (const k of keys) {
        pipeline.del(k);
        any = true;
      }
    }
    if (any) await pipeline.exec();
  } catch {
    /* fail open */
  }
}

// ---------------------------------------------------------------------------
// Leases — the primitives `lib/single-flight-cache.ts` rebuilds a hot public
// document through (public hub perf T2, 2026-09-24).
//
// A lease is a MARKER stored under the document's own key while one caller
// rebuilds it: `lease:<random token>`, with a short PX. Holding it in the same
// key is the whole design, and the reason is the writers. Every public-cache
// writer invalidates by DEL of the document key (`invalidatePublicCache`,
// `afterScheduleWrite`, `dropNamedPublicDocuments`, the stats refresh), so a
// write that lands mid-rebuild deletes the marker with it — and a fill is a
// compare-and-set against the filler's own marker, so that rebuild, which read
// the database before the write, can no longer put its document back. Nothing
// a writer does changes; a new writer that DELs the key is covered the day it
// ships. (The same scheme is memcached's "lease" from Facebook's 2013 paper.)
//
// Fail-open like everything above: an unreachable or unconfigured Redis reads
// as `unavailable`, and the caller builds directly, exactly as a cache miss
// did before leases existed.
// ---------------------------------------------------------------------------

const LEASE_PREFIX = "lease:";

/** At most one log line per lease operation per this long. */
export const LEASE_FAILURE_LOG_INTERVAL_MS = 60_000;
const leaseFailureLoggedAt = new Map<string, number>();

/**
 * A lease call that THREW, as opposed to one that answered "no". Both fail
 * open, but a throw that keeps happening — a provider rejecting the EVAL, a
 * key of the wrong type answering WRONGTYPE to every GET — silently turns
 * every poll into a bounded wait plus a rebuild, which is worse than having
 * no lease at all. Logged, throttled per operation, so a dead Redis under a
 * stampede of polls is one line a minute per operation, not one per poll.
 */
function logLeaseFailure(op: "read" | "acquire" | "fill" | "release", key: string, err: unknown): void {
  const now = Date.now();
  const last = leaseFailureLoggedAt.get(op);
  if (last !== undefined && now - last < LEASE_FAILURE_LOG_INTERVAL_MS) return;
  leaseFailureLoggedAt.set(op, now);
  log.warn(
    { op, key, err: err instanceof Error ? err.message : String(err) },
    "cache lease: a Redis call threw — failing open, so rebuilds are not single-flight until it recovers (logged at most once a minute per operation)",
  );
}

/** Test seam: forget when each operation last logged. */
export function __resetLeaseFailureLogForTests(): void {
  leaseFailureLoggedAt.clear();
}

/** What a raw GET found under a lease-guarded key. */
export type RawRead =
  | { kind: "unavailable" }
  | { kind: "absent" }
  /** Another caller is rebuilding it. */
  | { kind: "leased" }
  /** A stored document, still serialised. */
  | { kind: "value"; raw: string };

export type LeaseAttempt =
  | { kind: "acquired"; token: string }
  /** Someone else's lease, or a document, got there first. */
  | { kind: "held" }
  | { kind: "unavailable" };

/** GET a lease-guarded key without parsing it. */
export async function cacheReadRaw(key: string): Promise<RawRead> {
  try {
    const c = client();
    if (!c) return { kind: "unavailable" };
    const raw = await c.get(key);
    if (raw === null) return { kind: "absent" };
    if (raw.startsWith(LEASE_PREFIX)) return { kind: "leased" };
    return { kind: "value", raw };
  } catch (err) {
    logLeaseFailure("read", key, err);
    return { kind: "unavailable" };
  }
}

/**
 * Take the rebuild lease on `key` for `leaseMs`.
 *
 * `absent`: only when nothing is there (SET NX) — the ordinary miss.
 * `replace`: over whatever is there (plain SET) — for a stored value the
 * caller has already rejected as the wrong shape, which NX could never take.
 * Replacing is safe for freshness: the marker is set before the build reads
 * anything, so every write whose DEL came before it is already committed, and
 * every write whose DEL comes after it deletes the marker and refuses the fill.
 */
export async function cacheLeaseAcquire(
  key: string,
  leaseMs: number,
  mode: "absent" | "replace",
): Promise<LeaseAttempt> {
  try {
    const c = client();
    if (!c) return { kind: "unavailable" };
    const token = randomUUID();
    const marker = LEASE_PREFIX + token;
    const ok =
      mode === "absent"
        ? await c.set(key, marker, "PX", leaseMs, "NX")
        : await c.set(key, marker, "PX", leaseMs);
    return ok === "OK" ? { kind: "acquired", token } : { kind: "held" };
  } catch (err) {
    logLeaseFailure("acquire", key, err);
    return { kind: "unavailable" };
  }
}

// Compare-and-set: the document lands ONLY if the key still holds the
// filler's own marker. A DEL since the lease was taken (a write), an expiry
// (a holder slower than its lease) or another caller's `replace` all leave
// something else there, and the fill is refused. The last-known-good copy
// (KEYS[2], optional) is written in the same step, so it only ever holds a
// document that was, at that instant, the current one.
export const LEASE_FILL_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
if KEYS[2] then redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4]) end
return 1`;

// Delete-if-mine: a failed build hands the key back at once instead of making
// every waiter sit out the lease. Never deletes another caller's lease, or a
// document someone else filled.
export const LEASE_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Store `value` under `key` for `ttlSeconds` — and, if given, under the
 * last-known-good `stale.key` too — ONLY while `key` still holds this
 * caller's lease. Returns whether it landed. Never throws.
 */
export async function cacheLeaseFill(
  key: string,
  token: string,
  value: unknown,
  ttlSeconds: number,
  stale?: { key: string; ttlSeconds: number },
): Promise<boolean> {
  try {
    const c = client();
    if (!c) return false;
    const raw = JSON.stringify(value);
    const landed = stale
      ? await c.eval(LEASE_FILL_LUA, 2, key, stale.key, LEASE_PREFIX + token, raw, String(ttlSeconds), String(stale.ttlSeconds))
      : await c.eval(LEASE_FILL_LUA, 1, key, LEASE_PREFIX + token, raw, String(ttlSeconds));
    return Number(landed) === 1;
  } catch (err) {
    logLeaseFailure("fill", key, err);
    return false;
  }
}

/** Give a lease back, if it is still this caller's. Never throws. */
export async function cacheLeaseRelease(key: string, token: string): Promise<void> {
  try {
    const c = client();
    if (!c) return;
    await c.eval(LEASE_RELEASE_LUA, 1, key, LEASE_PREFIX + token);
  } catch (err) {
    // Fail open — the lease expires on its own.
    logLeaseFailure("release", key, err);
  }
}

// INCR + set-TTL-on-first-hit as one atomic server-side step. Done as a single
// Lua EVAL rather than INCR then EXPIRE so (a) a crash/error can't strand a key
// with no TTL — which would lock that identifier out forever — and (b) it bills
// as one Upstash command instead of two on pay-as-you-go.
const INCR_WINDOW_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * Fixed-window counter. Returns the new count for `key` within the window, or
 * null if Redis is unavailable (caller decides the fallback policy). The TTL is
 * set atomically on the first increment of a window.
 */
export async function incrWindow(key: string, windowSeconds: number): Promise<number | null> {
  const c = client();
  if (!c) return null;
  try {
    const n = await c.eval(INCR_WINDOW_LUA, 1, key, String(windowSeconds));
    return Number(n);
  } catch {
    return null;
  }
}
