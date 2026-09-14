import "server-only";
import Redis from "ioredis";

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
