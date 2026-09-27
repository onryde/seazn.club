// apps/web/cache-handler/redis-client.mjs
// @ts-check
/**
 * Redis client for the Next cache handler. Fail-open: every call has a
 * fallback. State lives on globalThis so the natively-imported handler and
 * the bundled app code (peer-revalidate, /api/health) share one client.
 */
import Redis from "ioredis";

export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 10_000;

const KEY = Symbol.for("seazn.nextCache.redis");

/** @returns {{client: any, failures: number, openUntil: number, warned: Set<string>}} */
function state() {
  const g = /** @type {any} */ (globalThis);
  return (g[KEY] ??= { client: undefined, failures: 0, openUntil: 0, warned: new Set() });
}

/** @param {string} key @param {string} msg @param {object} [extra] */
export function warnOnce(key, msg, extra = {}) {
  const s = state();
  if (s.warned.has(key)) return;
  s.warned.add(key);
  console.warn(JSON.stringify({ level: 40, name: "next-cache", msg, ...extra }));
}

export function nextCacheRedis() {
  const s = state();
  if (s.client !== undefined) return s.client;
  const url = process.env.REDIS_URL;
  if (process.env.NEXT_CACHE_REDIS !== "1" || !url) return (s.client = null);
  try {
    const client = new Redis(url, {
      connectTimeout: 1000,
      commandTimeout: 150,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    // A hard outage never reaches `ready`, so withRedis skips it without
    // counting a failure and the breaker never logs it. These two listeners
    // give it one line down and one line up. Never log the URL: it carries
    // the password.
    client.on("error", (err) => {
      warnOnce("conn", "redis connection error; serving from machine memory", { err: String(err) });
    });
    client.on("ready", () => {
      const st = state();
      if (!st.warned.has("conn")) return; // first ready at boot is not a recovery
      st.warned.delete("conn");
      console.warn(JSON.stringify({ level: 30, name: "next-cache", msg: "redis connection restored; shared cache resumed" }));
    });
    s.client = client;
  } catch {
    // An unparseable REDIS_URL throws synchronously. /api/health calls
    // cacheStatus() outside any try, so this must not throw.
    s.client = null;
    warnOnce("redis-url", "REDIS_URL unparseable; Redis tier off");
  }
  return s.client;
}

/**
 * @template T
 * @param {(r: any) => Promise<T>} fn
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function withRedis(fn, fallback) {
  const s = state();
  const r = nextCacheRedis();
  if (!r) return fallback;
  if (r.status !== "ready") return fallback; // connecting: not a failure
  const now = Date.now();
  if (now < s.openUntil) return fallback;
  try {
    const v = await fn(r);
    if (s.failures >= BREAKER_FAILURES) {
      s.warned.delete("breaker");
      console.warn(JSON.stringify({ level: 30, name: "next-cache", msg: "redis back; shared cache resumed" }));
    }
    s.failures = 0;
    s.openUntil = 0;
    return v;
  } catch (err) {
    s.failures += 1;
    if (s.failures >= BREAKER_FAILURES) {
      s.openUntil = now + BREAKER_OPEN_MS;
      warnOnce("breaker", "redis failing; serving from machine memory", { err: String(err) });
    }
    return fallback;
  }
}

/** @returns {"redis" | "memory" | "degraded"} */
export function cacheStatus() {
  const s = state();
  const r = nextCacheRedis();
  if (!r) return "memory";
  if (r.status !== "ready" || Date.now() < s.openUntil) return "degraded";
  return "redis";
}

/** @param {object | null} client */
export function __setRedisForTests(client) {
  state().client = client;
}

export function __resetRedisStateForTests() {
  const g = /** @type {any} */ (globalThis);
  const c = g[KEY]?.client;
  if (c && typeof c.disconnect === "function") c.disconnect();
  delete g[KEY];
}
