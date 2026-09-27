// apps/web/cache-handler/__tests__/machine.mjs
// @ts-check
/**
 * One "Fly machine": a fresh Node process with its own memory, Next's real
 * IncrementalCache and unstable_cache, and our handler. Used by
 * src/lib/__tests__/next-cache-two-machines.redis.test.ts.
 *
 *   node machine.mjs '<json ops>'  ->  one JSON line on stdout, one result per op
 *
 * Ops:
 *   {op:"set", key, tag, body}                 -> {ok: true}
 *   {op:"get", key, tag}                       -> {found, isStale, body}
 *   {op:"revalidate", tag, expire?}            -> {ok: true}  (no expire: the "max" profile's)
 *   {op:"cached", key, tag, produce, revalidate?}
 *     unstable_cache(producer, [key], {tags: [tag], revalidate}) called once;
 *     the producer returns `produce`      -> {value, produced: producer calls}
 *
 * Env: MACHINE_SERVER_DIST_DIR becomes IncrementalCache's serverDistDir; the
 * handler reads BUILD_ID beside it, and a production machine without one is
 * memory-only. NEXT_CACHE_REDIS and REDIS_URL are the handler's own switches.
 */
import { AsyncLocalStorage } from "node:async_hooks";

// Nothing may hang the suite: a machine still alive after 10s exits loudly.
// Unref'd, so it never itself keeps the process alive.
setTimeout(() => {
  console.error("machine: still running after 10s");
  process.exit(2);
}, 10_000).unref();

// Next's node server installs this global before any server module loads.
// Without it Next's storages are fakes whose run() throws, and unstable_cache
// runs its producer inside one. Static imports would be evaluated before this
// line, so Next is imported dynamically below.
/** @type {any} */ (globalThis).AsyncLocalStorage ??= AsyncLocalStorage;

const { IncrementalCache } = await import("next/dist/server/lib/incremental-cache/index.js");
const { unstable_cache } = await import("next/dist/server/web/spec-extension/unstable-cache.js");
const { defaultConfig } = await import("next/dist/server/config-shared.js");
const { __resetRedisStateForTests } = await import("../redis-client.mjs");
// Imported last: loading the handler connects its Redis client (connectAtBoot),
// and nothing between here and the first op yields to I/O, so the first op
// runs against a client that is still connecting, as on a machine that takes
// a request the moment it boots (G1).
const { default: Handler } = await import("../handler.mjs");

/** @type {any[]} */
const ops = JSON.parse(process.argv[2]);
const cache = new IncrementalCache({
  dev: false,
  requestHeaders: {},
  fetchCacheKeyPrefix: "",
  serverDistDir: process.env.MACHINE_SERVER_DIST_DIR,
  getPrerenderManifest: () => /** @type {any} */ ({
    version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [], preview: { previewModeId: "x" },
  }),
  CurCacheHandler: /** @type {any} */ (Handler),
});
// unstable_cache outside a request reads the cache from this global.
/** @type {any} */ (globalThis).__incrementalCache = cache;

let produced = 0;
/** @type {unknown} */
let produceValue = null;
// One function, so its source (part of unstable_cache's key) is the same on
// every machine; what it returns comes from the op.
const producer = async () => {
  produced += 1;
  return produceValue;
};

/** @type {object[]} */
const out = [];
let code = 0;
try {
  for (const o of ops) {
    if (o.op === "set") {
      await cache.set(o.key, { kind: /** @type {any} */ ("FETCH"), data: { headers: {}, body: o.body, status: 200, url: "" }, tags: [o.tag], revalidate: 300 },
        /** @type {any} */ ({ fetchCache: true, tags: [o.tag], revalidate: 300 }));
      out.push({ ok: true });
    } else if (o.op === "get") {
      const e = await cache.get(o.key, /** @type {any} */ ({ kind: "FETCH", tags: [o.tag], softTags: [], revalidate: 300 }));
      out.push({ found: !!e, isStale: e?.isStale ?? null, body: e?.value?.data?.body ?? null });
    } else if (o.op === "revalidate") {
      const expire = o.expire === undefined ? defaultConfig.cacheLife?.max?.expire : o.expire;
      await cache.revalidateTag([o.tag], { expire });
      out.push({ ok: true });
    } else if (o.op === "cached") {
      produceValue = o.produce;
      const before = produced;
      const value = await unstable_cache(producer, [o.key], { tags: [o.tag], revalidate: o.revalidate ?? 300 })();
      out.push({ value, produced: produced - before });
    } else {
      throw new Error(`machine: unknown op ${JSON.stringify(o)}`);
    }
  }
} catch (err) {
  console.error(err);
  code = 1;
}

// A live ioredis client keeps the process alive: disconnect it, then exit
// once stdout has flushed (a pipe write on macOS can still be pending).
__resetRedisStateForTests();
process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(code));
