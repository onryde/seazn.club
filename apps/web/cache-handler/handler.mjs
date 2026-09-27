// apps/web/cache-handler/handler.mjs
// @ts-check
/**
 * Next.js incremental cache handler: per-machine memory (all kinds) + Redis
 * (unstable_cache / FETCH entries) + one shared tag-state hash copied into
 * Next's own tagsManifest before IncrementalCache judges freshness.
 * Spec: docs/superpowers/specs/2026-09-24-shared-redis-cache-handler-design.md
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { tagsManifest, areTagsExpired } from "next/dist/server/lib/incremental-cache/tags-manifest.external.js";
import { withRedis, warnOnce, connectAtBoot } from "./redis-client.mjs";
import { TAGS_HASH, HSET_IF_NEWER, HDEL_IF_OLDER, writeState, encodeField, decodeField } from "./tag-state.mjs";

connectAtBoot();

export const MAX_REDIS_BYTES = 1_048_576;
export const NO_TTL_EX = 2_592_000;
const DAY_MS = 86_400_000;
const L1_BYTES = (Number(process.env.NEXT_CACHE_L1_MB) || 64) * 1024 * 1024;
const LOCAL = Symbol.for("seazn.nextCache.local");
/** A tag this request already holds the newest local state for. */
const SYNCED = Promise.resolve();

/**
 * @returns {{l1: Map<string, {entry: any, bytes: number}>, bytes: number,
 *   writeAt: Map<string, number>, buildId: string | undefined, sweptAt: number}}
 */
function local() {
  const g = /** @type {any} */ (globalThis);
  return (g[LOCAL] ??= { l1: new Map(), bytes: 0, writeAt: new Map(), buildId: undefined, sweptAt: 0 });
}

export function __resetMachineStateForTests() {
  delete (/** @type {any} */ (globalThis))[LOCAL];
  tagsManifest.clear();
}

/**
 * The id that scopes Redis data keys (spec §7 version skew). Only an id
 * actually read from BUILD_ID is remembered: Turbopack's proxy constructs the
 * handler without `serverDistDir` on every request (adapter.js), and a
 * remembered fallback would pin every later instance to it.
 * @param {string | undefined} serverDistDir
 * @returns {string | undefined} undefined: unknown, so this instance is memory-only
 */
function buildId(serverDistDir) {
  const L = local();
  if (L.buildId) return L.buildId;
  if (serverDistDir) {
    try {
      const id = readFileSync(path.join(serverDistDir, "..", "BUILD_ID"), "utf8").trim();
      if (id) return (L.buildId = id);
    } catch {
      // unreadable: unknown below
    }
  }
  if (process.env.NODE_ENV !== "production") return "dev";
  // Production never shares an unscoped nc:dev: namespace across deploys.
  // `next build` writes BUILD_ID after collecting page data and before
  // generating static pages, so only page-data collection lands here by
  // design; a running server given a serverDistDir without one is
  // misdeployed, so say so once.
  if (serverDistDir && process.env.NEXT_PHASE !== "phase-production-build") {
    warnOnce("build-id", "BUILD_ID unreadable; this machine's next cache is memory-only (no Redis)");
  }
  return undefined;
}

/** @param {any} v */
function approxBytes(v) {
  if (!v) return 0;
  if (v.kind === "FETCH") return Buffer.byteLength(JSON.stringify(v.data ?? null));
  let n = 256;
  for (const k of ["html", "rscData", "body", "pageData", "buffer"]) {
    const x = v[k];
    if (typeof x === "string") n += Buffer.byteLength(x);
    else if (x && typeof x.length === "number") n += x.length;
    else if (x && typeof x === "object") n += Buffer.byteLength(JSON.stringify(x));
  }
  if (v.segmentData instanceof Map) for (const b of v.segmentData.values()) n += b?.length ?? 0;
  return n;
}

/** @param {string} key @param {any} entry */
function remember(key, entry) {
  const L = local();
  forget(key);
  const bytes = approxBytes(entry.value);
  L.l1.set(key, { entry, bytes });
  L.bytes += bytes;
  for (const [k, e] of L.l1) {
    if (L.bytes <= L1_BYTES) break;
    L.l1.delete(k);
    L.bytes -= e.bytes;
  }
}

/** @param {string} key */
function forget(key) {
  const L = local();
  const e = L.l1.get(key);
  if (!e) return;
  L.l1.delete(key);
  L.bytes -= e.bytes;
}

/** @param {string} raw */
function decodeData(raw) {
  try {
    const d = JSON.parse(raw);
    if (d?.v !== 1 || d.value?.kind !== "FETCH" || typeof d.lastModified !== "number") return null;
    return { lastModified: d.lastModified, value: d.value };
  } catch {
    return null;
  }
}

/** @param {string} tag @param {{at: number, stale?: number, expired?: number}} s */
function applyLocal(tag, s) {
  const L = local();
  if ((L.writeAt.get(tag) ?? -1) > s.at) return; // newest write wins
  L.writeAt.set(tag, s.at);
  /** @type {{stale?: number, expired?: number}} */
  const m = {};
  if (s.stale !== undefined) m.stale = s.stale;
  if (s.expired !== undefined) m.expired = s.expired;
  tagsManifest.set(tag, m);
}

/** @param {any} entry @param {any} ctx @returns {string[]} */
function tagsOf(entry, ctx) {
  if (ctx?.kind === "FETCH") return [...(ctx.tags ?? []), ...(ctx.softTags ?? []), ...(entry.value?.tags ?? [])];
  const header = entry.value?.headers?.["x-next-cache-tags"];
  return typeof header === "string" ? header.split(",") : [];
}

/** @param {typeof withRedis} redis */
function maybeSweep(redis) {
  const L = local();
  const now = Date.now();
  if (now - L.sweptAt < DAY_MS) return;
  void redis(async (r) => {
    // Stamped only once Redis runs this: an invalidation that cannot reach
    // Redis must not use up the machine's sweep for the day.
    L.sweptAt = now;
    if ((await r.set("nc:sweep", "1", "EX", 86_400, "NX")) !== "OK") return;
    const cutoff = now - 365 * DAY_MS;
    let cursor = "0";
    do {
      const [next, flat] = await r.hscan(TAGS_HASH, cursor, "COUNT", 500);
      cursor = next;
      const dead = [];
      for (let i = 0; i < flat.length; i += 2) {
        const s = decodeField(flat[i + 1]);
        if (!s || Math.max(s.at, s.stale ?? 0, s.expired ?? 0) < cutoff) dead.push(flat[i]);
      }
      // Never a bare HDEL: another machine may rewrite a field between this
      // HSCAN and the delete. The script re-reads each field and deletes it
      // only if it is still dead.
      if (dead.length) await r.eval(HDEL_IF_OLDER, 1, TAGS_HASH, cutoff, ...dead);
    } while (cursor !== "0");
  }, undefined);
}

export default class SharedCacheHandler {
  /** @param {{serverDistDir?: string, revalidatedTags?: string[]}} ctx */
  constructor(ctx) {
    this.buildId = buildId(ctx?.serverDistDir);
    /** Tags Next already knows were revalidated this request (FileSystemCache's `ctx.revalidatedTags`). */
    this.revalidatedTags = ctx?.revalidatedTags ?? [];
    /**
     * Tag -> the sync that covers it in this request. A promise, not a flag:
     * a concurrent read sharing a tag must wait for the in-flight HMGET
     * rather than be judged against the manifest it is about to replace.
     * @type {Map<string, Promise<void>>}
     */
    this.memo = new Map();
  }

  /**
   * Every Redis call goes through here: an instance with no known build id
   * is memory-only (no read, no write), so a build never serves or seeds
   * another build's entries.
   * @template T
   * @param {(r: any) => Promise<T>} fn
   * @param {T} fallback
   * @returns {Promise<T>}
   */
  redis(fn, fallback) {
    return this.buildId === undefined ? Promise.resolve(fallback) : withRedis(fn, fallback);
  }

  /** @param {string} key */
  dataKey(key) {
    return `nc:${this.buildId}:${key}`;
  }

  /** @param {string[]} tags */
  async syncTags(tags) {
    const unique = [...new Set(tags)];
    const missing = unique.filter((t) => !this.memo.has(t));
    if (missing.length > 0) {
      // One HMGET per request for these tags; stored before it resolves.
      const sync = this.redis((r) => r.hmget(TAGS_HASH, ...missing), null).then((raw) => {
        if (!raw) return;
        missing.forEach((tag, i) => {
          const s = decodeField(raw[i]);
          if (s) applyLocal(tag, s);
        });
      });
      for (const t of missing) this.memo.set(t, sync);
    }
    await Promise.all(unique.map((t) => this.memo.get(t)));
  }

  /** @param {string} key @param {any} ctx */
  async get(key, ctx) {
    const L = local();
    let entry = L.l1.get(key)?.entry ?? null;
    if (entry) {
      remember(key, entry); // bump recency
    } else if (ctx?.kind === "FETCH") {
      const raw = await this.redis((r) => r.get(this.dataKey(key)), null);
      if (raw) {
        entry = decodeData(raw);
        if (entry) remember(key, entry);
        else void this.redis((r) => r.del(this.dataKey(key)), null);
      }
    }
    if (!entry) return null;
    await this.syncTags(tagsOf(entry, ctx));
    return this.expired(entry, ctx) ? null : entry;
  }

  /**
   * FileSystemCache.get's own tag checks (next@16.3.6 file-system-cache.js
   * 214-248, unchanged since 16.2.9), which this handler replaces.
   * IncrementalCache re-checks FETCH entries, but checks page tags only
   * inside the revalidate window (APP_PAGE/APP_ROUTE, never PAGES); past it
   * the page is merely stale and served while it re-renders. A tag-expired
   * page must be a miss HERE so the request renders fresh.
   * @param {any} entry @param {any} ctx
   */
  expired(entry, ctx) {
    const kind = entry.value?.kind;
    if (kind === "APP_PAGE" || kind === "APP_ROUTE" || kind === "PAGES") {
      const header = entry.value.headers?.["x-next-cache-tags"];
      if (typeof header !== "string") return false;
      const cacheTags = header.split(",");
      return cacheTags.length > 0 && areTagsExpired(cacheTags, entry.lastModified);
    }
    if (kind === "FETCH") {
      const combined = ctx?.kind === "FETCH" ? [...(ctx.tags ?? []), ...(ctx.softTags ?? [])] : [];
      if (combined.some((t) => this.revalidatedTags.includes(t))) return true;
      return areTagsExpired(combined, entry.lastModified);
    }
    return false;
  }

  /** @param {string} key @param {any} data @param {any} _ctx */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Next passes ctx; routing keys off data.kind
  async set(key, data, _ctx) {
    if (data === null) {
      forget(key);
      await this.redis((r) => r.del(this.dataKey(key)), null);
      return;
    }
    const entry = { lastModified: Date.now(), value: data };
    remember(key, entry);
    if (data.kind !== "FETCH") return;
    const raw = JSON.stringify({ v: 1, ...entry });
    const bytes = Buffer.byteLength(raw);
    if (bytes > MAX_REDIS_BYTES) {
      warnOnce(`oversize:${key}`, "next-cache entry over 1 MB kept in machine memory only", { key, bytes });
      return;
    }
    // next@16.3.6 unstable_cache stores revalidate:false as INFINITE_CACHE
    // (4_294_967_294 s) and an absent revalidate as a year (31_536_000), so
    // the 30-day cap must be a min, not only the no-limit branch.
    const ex = typeof data.revalidate === "number" && data.revalidate > 0
      ? Math.min(data.revalidate + 3600, NO_TTL_EX)
      : NO_TTL_EX;
    await this.redis((r) => r.set(this.dataKey(key), raw, "EX", ex), null);
  }

  /** @param {string | string[]} tags @param {{expire?: number}} [durations] */
  async revalidateTag(tags, durations) {
    const list = typeof tags === "string" ? [tags] : [...tags];
    if (list.length === 0) return;
    const now = Date.now();
    /** @type {string[]} */
    const argv = [];
    for (const tag of list) {
      const s = writeState(tagsManifest.get(tag) ?? {}, durations, now);
      applyLocal(tag, s);
      this.memo.set(tag, SYNCED);
      argv.push(tag, encodeField(s));
    }
    await this.redis((r) => r.eval(HSET_IF_NEWER, 1, TAGS_HASH, ...argv), null);
    maybeSweep((fn, fallback) => this.redis(fn, fallback));
  }

  resetRequestCache() {
    this.memo.clear();
  }
}
