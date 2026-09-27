// apps/web/src/lib/__tests__/next-cache-handler.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { defaultConfig } from "next/dist/server/config-shared";
import Handler, { __resetMachineStateForTests, MAX_REDIS_BYTES, NO_TTL_EX } from "../../../cache-handler/handler.mjs";
import { __setRedisForTests, __resetRedisStateForTests } from "../../../cache-handler/redis-client.mjs";
import {
  TAGS_HASH, decodeField, encodeField, writeState, HSET_IF_NEWER, HDEL_IF_OLDER,
} from "../../../cache-handler/tag-state.mjs";

/**
 * The fake's model of HDEL_IF_OLDER's per-field test (the Lua lives in
 * tag-state.mjs): unparseable, or max(at, stale, expired) < cutoff.
 */
function sweepable(cur: string, cutoff: number) {
  const m = /^(\d+)\|([\s\S]*)$/.exec(cur);
  if (!m) return true;
  let s: unknown;
  try { s = JSON.parse(m[2]); } catch { return true; }
  if (s === null || typeof s !== "object") return true;
  const { stale, expired } = s as { stale?: unknown; expired?: unknown };
  let newest = Number(m[1]);
  if (typeof stale === "number" && stale > newest) newest = stale;
  if (typeof expired === "number" && expired > newest) newest = expired;
  return newest < cutoff;
}

function fakeRedis() {
  const kv = new Map<string, { v: string; ex?: number }>();
  const hash = new Map<string, string>();
  const calls: string[] = [];
  return {
    status: "ready", kv, hash, calls,
    async get(k: string) { calls.push("get"); return kv.get(k)?.v ?? null; },
    async set(k: string, v: string, ...a: unknown[]) {
      calls.push("set");
      if (a.includes("NX") && kv.has(k)) return null;
      const i = a.indexOf("EX"); kv.set(k, { v, ex: i >= 0 ? Number(a[i + 1]) : undefined }); return "OK";
    },
    async del(...k: string[]) { calls.push("del"); k.forEach((x) => kv.delete(x)); return k.length; },
    async hmget(_h: string, ...f: string[]) { calls.push("hmget"); return f.map((x) => hash.get(x) ?? null); },
    async eval(script: string, _n: number, _h: string, ...argv: string[]) {
      calls.push("eval");
      if (script === HSET_IF_NEWER) {
        for (let i = 0; i < argv.length; i += 2) {
          const cur = decodeField(hash.get(argv[i]))?.at ?? -1;
          if (decodeField(argv[i + 1])!.at >= cur) hash.set(argv[i], argv[i + 1]);
        }
        return 1;
      }
      if (script === HDEL_IF_OLDER) {
        const [cutoff, ...fields] = argv;
        let deleted = 0;
        for (const f of fields) {
          const cur = hash.get(f); // re-read NOW, as the script does
          if (cur !== undefined && sweepable(cur, Number(cutoff))) { hash.delete(f); deleted++; }
        }
        return deleted;
      }
      throw new Error("fake redis: unknown script");
    },
    async hscan() { calls.push("hscan"); return ["0", [...hash.entries()].flat()]; },
    async hdel(_h: string, ...f: string[]) { calls.push("hdel"); f.forEach((x) => hash.delete(x)); return f.length; },
  };
}

const MAX = { expire: defaultConfig.cacheLife.max.expire };
const fetchValue = (revalidate: number | false = 30) =>
  ({ kind: "FETCH", data: { headers: {}, body: '{"n":1}', status: 200, url: "" }, tags: ["division:d1"], revalidate });
const fetchCtx = { kind: "FETCH", tags: ["division:d1"], softTags: [] };

let redis: ReturnType<typeof fakeRedis>;
beforeEach(() => { vi.stubEnv("NEXT_CACHE_REDIS", "1"); redis = fakeRedis(); __setRedisForTests(redis); });
afterEach(() => { __resetMachineStateForTests(); __resetRedisStateForTests(); vi.unstubAllEnvs(); });

describe("SharedCacheHandler", () => {
  it("cold machine reads a FETCH entry another machine wrote", async () => {
    await new Handler({}).set("k1", fetchValue(), { fetchCache: true });
    __resetMachineStateForTests(); // now "machine B", empty memory
    const got = await new Handler({}).get("k1", fetchCtx);
    expect(got?.value).toEqual(fetchValue());
  });

  it("page kinds never go to Redis", async () => {
    await new Handler({}).set("/p", { kind: "APP_PAGE", html: "<p/>", rscData: Buffer.from("x"), headers: {} }, {});
    expect([...redis.kv.keys()]).toEqual([]);
  });

  it("TTL: revalidate+3600, and the 30-day cap for entries with no time limit", async () => {
    const h = new Handler({});
    await h.set("a", fetchValue(30), { fetchCache: true });
    await h.set("b", fetchValue(false), { fetchCache: true });
    const ex = (k: string) => [...redis.kv.entries()].find(([key]) => key.endsWith(`:${k}`))![1].ex;
    expect(ex("a")).toBe(30 + 3600);
    expect(ex("b")).toBe(NO_TTL_EX);
  });

  it("oversize values stay in memory only", async () => {
    const big = { ...fetchValue(), data: { ...fetchValue().data, body: "x".repeat(MAX_REDIS_BYTES + 1) } };
    await new Handler({}).set("big", big, { fetchCache: true });
    expect(redis.kv.size).toBe(0);
  });

  it("poisoned Redis value → miss + DEL", async () => {
    redis.kv.set("nc:dev:bad", { v: "{not json" });
    expect(await new Handler({}).get("bad", fetchCtx)).toBeNull();
    expect(redis.kv.has("nc:dev:bad")).toBe(false);
  });

  it("build id scopes data keys", async () => {
    await new Handler({}).set("k", fetchValue(), { fetchCache: true });
    expect([...redis.kv.keys()]).toEqual(["nc:dev:k"]);
  });

  it("an invalidation on A reaches B's manifest; newest write wins ('max' then expire:0)", async () => {
    const a = new Handler({});
    await a.set("k1", fetchValue(), { fetchCache: true });
    await a.revalidateTag("division:d1", MAX);
    await a.revalidateTag("division:d1", { expire: 0 });
    __resetMachineStateForTests();
    await new Handler({}).get("k1", fetchCtx);
    const m = tagsManifest.get("division:d1")!;
    expect(m.expired).toBeLessThanOrEqual(Date.now()); // expire:0 won, not the year-ahead 'max'
  });

  it("tags fetched once per request, again after resetRequestCache", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    redis.calls.length = 0;
    await h.get("k1", fetchCtx); await h.get("k1", fetchCtx);
    expect(redis.calls.filter((c) => c === "hmget")).toHaveLength(1);
    h.resetRequestCache();
    await h.get("k1", fetchCtx);
    expect(redis.calls.filter((c) => c === "hmget")).toHaveLength(2);
  });

  it("memory survives a new handler instance (Next constructs one per request)", async () => {
    await new Handler({}).set("k1", fetchValue(), { fetchCache: true });
    __setRedisForTests(null);
    expect((await new Handler({}).get("k1", fetchCtx))?.value).toEqual(fetchValue());
  });

  it("Redis failing → serves L1, still returns", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    redis.hmget = async () => { throw new Error("timeout"); };
    expect((await h.get("k1", fetchCtx))?.value).toEqual(fetchValue());
  });

  it("clock skew: a tag stamped a few ms ahead by another machine still expires the entry once reached", async () => {
    const { areTagsExpired } = await import("next/dist/server/lib/incremental-cache/tags-manifest.external");
    const lastModified = Date.now() - 1;
    const skewed = Date.now() + 5; // the writer's clock runs 5 ms ahead
    redis.hash.set("division:skew", `${skewed}|${JSON.stringify({ stale: skewed, expired: skewed })}`);
    const h = new Handler({});
    await h.set("ks", { ...fetchValue(), tags: ["division:skew"] }, { fetchCache: true });
    h.resetRequestCache();
    await h.get("ks", { kind: "FETCH", tags: ["division:skew"], softTags: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(areTagsExpired(["division:skew"], lastModified)).toBe(true);
  });

  it("revalidateTag writes the hash through the Lua script", async () => {
    await new Handler({}).revalidateTag(["division:d1"], { expire: 0 });
    expect(decodeField(redis.hash.get("division:d1"))?.expired).toBeLessThanOrEqual(Date.now());
    expect(TAGS_HASH).toBe("nc:tags");
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief: each block below pins a guard the 12 tests above let
// through under mutation (see the task-3 report for the mutant table).
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** The fake answers on microtasks, so one macrotask lets a background sweep finish. */
const flush = () => new Promise((r) => setTimeout(r, 0));
/** A tag state written `daysAgo` days ago, stale and expired at that same moment. */
const stateFrom = (daysAgo: number) => {
  const t = Date.now() - daysAgo * DAY_MS;
  return encodeField({ at: t, stale: t, expired: t });
};

describe("daily tag-hash sweep", () => {
  it("deletes year-old and unparseable fields; keeps anything written, stale or expiring within the year", async () => {
    const t = Date.now() - 400 * DAY_MS;
    redis.hash.set("division:ancient", stateFrom(400));
    redis.hash.set("division:junk", "nope");
    redis.hash.set("division:recent", stateFrom(300));
    redis.hash.set("division:expires-ahead", encodeField({ at: t, stale: t, expired: Date.now() + DAY_MS }));
    await new Handler({}).revalidateTag("division:d1", { expire: 0 }); // kicks the sweep off
    await flush();
    expect(redis.calls).toContain("hscan");
    expect([...redis.hash.keys()].sort()).toEqual(["division:d1", "division:expires-ahead", "division:recent"]);
  });

  it("a field another machine rewrites between the HSCAN and the delete survives", async () => {
    redis.hash.set("division:old", stateFrom(400));
    const fresh = encodeField(writeState({}, { expire: 0 }, Date.now()));
    const scan = redis.hscan;
    redis.hscan = async () => {
      const page = await scan();
      redis.hash.set("division:old", fresh); // machine B revalidates it right after A's scan
      return page;
    };
    await new Handler({}).revalidateTag("division:d1", { expire: 0 });
    await flush();
    expect(redis.calls).toContain("hscan");
    expect(redis.hash.get("division:old")).toBe(fresh);
  });
});

describe("daily tag-hash sweep: scheduling", () => {
  it("runs at most once a day per machine, and only on the machine that takes the daily lock", async () => {
    const lockAsks: unknown[][] = [];
    const set = redis.set;
    redis.set = async (k: string, v: string, ...a: unknown[]) => {
      if (k === "nc:sweep") lockAsks.push(a);
      return set(k, v, ...a);
    };
    const a = new Handler({});
    await a.revalidateTag("division:d1", { expire: 0 }); await flush();
    await a.revalidateTag("division:d1", { expire: 0 }); await flush();
    expect(lockAsks).toEqual([["EX", 86_400, "NX"]]); // asked once, not once per invalidation
    expect(redis.calls.filter((c) => c === "hscan")).toHaveLength(1);
    __resetMachineStateForTests(); // machine B: has not swept today, but A holds the lock
    await new Handler({}).revalidateTag("division:d1", { expire: 0 }); await flush();
    expect(lockAsks).toHaveLength(2);
    expect(redis.calls.filter((c) => c === "hscan")).toHaveLength(1);
  });
});

afterEach(() => { vi.restoreAllMocks(); });

const withBody = (body: string) => ({ ...fetchValue(), data: { ...fetchValue().data, body } });

describe("tag sync: newest write wins, and a tie takes the shared state", () => {
  it("a newer {expire:0} from another machine replaces this machine's older 'max' state whole, not per field", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    await h.revalidateTag("division:d1", MAX); // this machine: stale now, expired a year ahead
    const mine = decodeField(redis.hash.get("division:d1"))!;
    expect(mine.expired!).toBeGreaterThan(mine.at + DAY_MS); // what a per-field max would keep
    const theirs = writeState({}, { expire: 0 }, mine.at + 1); // machine B, 1 ms later
    redis.hash.set("division:d1", encodeField(theirs));
    await new Handler({}).get("k1", fetchCtx); // this machine's next request
    expect(tagsManifest.get("division:d1")).toEqual({ stale: theirs.stale, expired: theirs.expired });
  });

  it("an older shared state never overwrites this machine's newer invalidation (its own Redis write failed)", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    redis.hash.set("division:d1", encodeField(writeState({}, MAX, Date.now() - 1_000))); // B's 'max', 1 s ago
    redis.eval = async () => { throw new Error("timeout"); }; // our write never lands
    await h.revalidateTag("division:d1", { expire: 0 });
    const mine = { ...tagsManifest.get("division:d1") };
    expect(mine.expired!).toBeLessThanOrEqual(Date.now());
    await new Handler({}).get("k1", fetchCtx); // the next request reads B's older state
    expect(tagsManifest.get("division:d1")).toEqual(mine);
  });

  it("a same-millisecond tie takes the shared state, as HSET_IF_NEWER (>=) and newest() do", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    const t = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t);
    redis.eval = async () => { throw new Error("timeout"); }; // ours never reaches Redis
    await h.revalidateTag("division:d1", { expire: 0 }); // local: stale = expired = t
    const theirs = writeState({}, MAX, t); // machine B's 'max' in the same ms: what Redis holds
    redis.hash.set("division:d1", encodeField(theirs));
    await new Handler({}).get("k1", fetchCtx);
    expect(tagsManifest.get("division:d1")).toEqual({ stale: t, expired: theirs.expired });
  });

  it("revalidateTag updates this machine's manifest even with Redis down", async () => {
    __setRedisForTests(null);
    const t = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t);
    await new Handler({}).revalidateTag("division:d1", { expire: 0 });
    expect(tagsManifest.get("division:d1")).toEqual({ stale: t, expired: t });
  });

  it("revalidateTag builds on the tag's current state, as Next's FileSystemCache does", async () => {
    const t = Date.now();
    tagsManifest.set("division:d1", { stale: t - 10, expired: t - 10 }); // an earlier {expire:0}
    vi.spyOn(Date, "now").mockReturnValue(t);
    await new Handler({}).revalidateTag("division:d1", {}); // durations without expire keep the old expiry
    expect(tagsManifest.get("division:d1")).toEqual({ stale: t, expired: t - 10 });
    expect(decodeField(redis.hash.get("division:d1"))).toEqual({ at: t, stale: t, expired: t - 10 });
  });
});

describe("which tags a read syncs", () => {
  it("every tag Next will judge: a FETCH read's ctx tags and softTags, and a page's x-next-cache-tags header", async () => {
    const tags = ["t-ctx", "t-soft", "t-page-a", "t-page-b"];
    for (const tag of tags) redis.hash.set(tag, encodeField(writeState({}, { expire: 0 }, 1_000)));
    const h = new Handler({});
    await h.set("f", fetchValue(), { fetchCache: true });
    await h.get("f", { kind: "FETCH", tags: ["t-ctx"], softTags: ["t-soft"] });
    const page = { kind: "APP_PAGE", html: "", rscData: Buffer.from(""), headers: { "x-next-cache-tags": "t-page-a,t-page-b" } };
    await h.set("/p", page, {});
    await h.get("/p", { kind: "APP_PAGE" });
    for (const tag of tags) expect(tagsManifest.get(tag), tag).toEqual({ stale: 1_000, expired: 1_000 });
  });
});

describe("Redis data tier", () => {
  it("an old-shape, non-FETCH or undated Redis value is a miss and is deleted", async () => {
    const lastModified = Date.now();
    const bad: Record<string, unknown> = {
      v2: { v: 2, lastModified, value: fetchValue() },
      page: { v: 1, lastModified, value: { kind: "APP_PAGE", html: "" } },
      undated: { v: 1, value: fetchValue() },
    };
    for (const [k, v] of Object.entries(bad)) redis.kv.set(`nc:dev:${k}`, { v: JSON.stringify(v) });
    for (const k of Object.keys(bad)) expect(await new Handler({}).get(k, fetchCtx), k).toBeNull();
    expect(redis.kv.size).toBe(0);
  });

  it("an L1 hit costs no Redis GET, and a page-kind miss never reads Redis", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    redis.calls.length = 0;
    expect((await h.get("k1", fetchCtx))?.value).toEqual(fetchValue());
    expect(await h.get("/missing", { kind: "APP_PAGE" })).toBeNull();
    expect(redis.calls).not.toContain("get");
    __resetMachineStateForTests(); // positive pair: a FETCH miss in L1 does read Redis
    await new Handler({}).get("k1", fetchCtx);
    expect(redis.calls).toContain("get");
  });

  it("set(key, null) deletes the entry from this machine's memory and from Redis", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    expect(redis.kv.has("nc:dev:k1")).toBe(true);
    await h.set("k1", null, {});
    expect(redis.kv.has("nc:dev:k1")).toBe(false);
    __setRedisForTests(null); // memory only: the L1 copy must be gone too
    expect(await new Handler({}).get("k1", fetchCtx)).toBeNull();
  });

  it("data keys carry the build id read from BUILD_ID beside serverDistDir", async () => {
    const dist = mkdtempSync(path.join(tmpdir(), "nc-build-"));
    try {
      mkdirSync(path.join(dist, "server"));
      writeFileSync(path.join(dist, "BUILD_ID"), "b-123\n");
      await new Handler({ serverDistDir: path.join(dist, "server") }).set("k", fetchValue(), { fetchCache: true });
      expect([...redis.kv.keys()]).toEqual(["nc:b-123:k"]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("TTL: a FETCH entry with no revalidate at all also gets the 30-day cap", async () => {
    const { revalidate, ...noRevalidate } = fetchValue();
    expect(revalidate).toBe(30);
    await new Handler({}).set("c", noRevalidate, { fetchCache: true });
    expect(redis.kv.get("nc:dev:c")?.ex).toBe(NO_TTL_EX);
  });

  it("the 1 MiB limit is on the serialised value's UTF-8 bytes: exactly 1 MiB is shared, one byte more is not", async () => {
    const h = new Handler({});
    const serialised = (v: unknown) => Buffer.byteLength(JSON.stringify({ v: 1, lastModified: Date.now(), value: v }));
    const pad = MAX_REDIS_BYTES - serialised(withBody(""));
    await h.set("at-limit", withBody("x".repeat(pad)), { fetchCache: true });
    // One byte more but not one character more: "é" is two bytes in UTF-8.
    await h.set("over-limit", withBody("x".repeat(pad - 1) + "é"), { fetchCache: true });
    expect([...redis.kv.keys()]).toEqual(["nc:dev:at-limit"]);
    expect(Buffer.byteLength(redis.kv.get("nc:dev:at-limit")!.v)).toBe(MAX_REDIS_BYTES);
  });

  it("an oversize value is still served from this machine's memory, and logged once per key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = withBody("x".repeat(MAX_REDIS_BYTES));
    const h = new Handler({});
    await h.set("big", big, { fetchCache: true });
    await h.set("big", big, { fetchCache: true });
    expect(redis.kv.size).toBe(0);
    expect((await h.get("big", fetchCtx))?.value).toEqual(big);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0][0])) as { key: string; bytes: number };
    expect(line.key).toBe("big");
    expect(line.bytes).toBeGreaterThan(MAX_REDIS_BYTES);
  });
});

describe("machine memory (L1)", () => {
  it("evicts the least-recently-used entry past NEXT_CACHE_L1_MB, and a read counts as a use", async () => {
    vi.stubEnv("NEXT_CACHE_L1_MB", "1"); // read once at module load, so take a fresh copy
    vi.resetModules();
    const { default: SmallL1 } = await import("../../../cache-handler/handler.mjs");
    __setRedisForTests(null); // memory only
    const entry = withBody("x".repeat(400_000)); // three of these exceed 1 MiB, two do not
    const h = new SmallL1({});
    await h.set("a", entry, { fetchCache: true });
    await h.set("b", entry, { fetchCache: true });
    expect(await h.get("a", fetchCtx)).not.toBeNull(); // a is now used more recently than b
    await h.set("c", entry, { fetchCache: true });
    expect(await h.get("b", fetchCtx)).toBeNull();
    expect(await h.get("a", fetchCtx)).not.toBeNull();
    expect(await h.get("c", fetchCtx)).not.toBeNull();
  });

  it("a second copy of the module shares this machine's memory (Symbol.for on globalThis)", async () => {
    await new Handler({}).set("k1", fetchValue(), { fetchCache: true });
    vi.resetModules();
    const copy = await import("../../../cache-handler/handler.mjs");
    expect(copy.default).not.toBe(Handler); // really a second module instance
    __setRedisForTests(null);
    expect((await new copy.default({}).get("k1", fetchCtx))?.value).toEqual(fetchValue());
  });
});
