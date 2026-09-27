// apps/web/src/lib/__tests__/next-cache-two-machines.redis.test.ts
//
// The seam proof for the shared Redis cacheHandler. Each `run` below is a
// separate Node process (one "Fly machine": cache-handler/__tests__/machine.mjs)
// with its own memory, Next's real IncrementalCache and unstable_cache, and the
// real handler.mjs. The processes share nothing but one real Redis, so what one
// process sees of another's write went through Redis and nowhere else.
// Spec: docs/superpowers/specs/2026-09-24-shared-redis-cache-handler-design.md
//
// Isolation: CI runs this file alongside the other *.redis.test.ts suites on
// one Redis, concurrently, so it never FLUSHes. Data keys live under a
// BUILD_ID unique to this run, tags carry a run-unique name, the Lua cases use
// their own hash, and afterAll deletes exactly what this run created.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Redis from "ioredis";
import { defaultConfig } from "next/dist/server/config-shared";
import { INFINITE_CACHE } from "next/dist/lib/constants";
import { NO_TTL_EX } from "../../../cache-handler/handler.mjs";
import {
  TAGS_HASH, HSET_IF_NEWER, HDEL_IF_OLDER, decodeField, encodeField, writeState,
} from "../../../cache-handler/tag-state.mjs";

const HAS_REDIS = !!process.env.REDIS_URL;
const MACHINE = path.resolve(__dirname, "../../../cache-handler/__tests__/machine.mjs");
/** A machine that has not exited by now is hung; kill it and go red. */
const MACHINE_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;
const MAX = { expire: defaultConfig.cacheLife.max.expire };

/** Unique to this run: every data key this file writes lives under nc:<it>:. */
const BUILD_ID = `t5-${Date.now().toString(36)}-${process.pid}-${randomUUID().slice(0, 8)}`;
let buildRoot = "";
/** build id -> the serverDistDir whose sibling BUILD_ID file holds it */
const dists = new Map<string, string>();
/** Every tag a machine was handed: this run's fields in the shared nc:tags. */
const tagsTouched = new Set<string>();

function distFor(id: string): string {
  let d = dists.get(id);
  if (!d) {
    const dotNext = path.join(buildRoot, id, ".next");
    mkdirSync(dotNext, { recursive: true });
    writeFileSync(path.join(dotNext, "BUILD_ID"), `${id}\n`);
    d = path.join(dotNext, "server");
    dists.set(id, d);
  }
  return d;
}

type RunOpts = { buildId?: string; env?: Record<string, string | undefined> };

/**
 * One fresh machine runs `ops` and exits. It runs as production does: a
 * readable BUILD_ID beside serverDistDir (without one a production machine is
 * memory-only, and every test here would pass vacuously), NODE_ENV=production,
 * not inside `next build`, and the Redis tier switched on.
 */
const run = (ops: object[], opts: RunOpts = {}) => {
  for (const o of ops) if ("tag" in o && typeof o.tag === "string") tagsTouched.add(o.tag);
  return JSON.parse(execFileSync(process.execPath, [MACHINE, JSON.stringify(ops)], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_PHASE: undefined,
      NEXT_CACHE_REDIS: "1",
      MACHINE_SERVER_DIST_DIR: distFor(opts.buildId ?? BUILD_ID),
      ...opts.env,
    },
    encoding: "utf8",
    timeout: MACHINE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  }).trim().split("\n").at(-1)!);
};

async function scanKeys(r: Redis, match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", match, "COUNT", 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys.sort();
}

describe.skipIf(!HAS_REDIS)("two machines share one Redis", () => {
  const tag = `division:e2e-${Date.now()}`;
  let r: Redis;
  let sweepExisted = true;

  beforeAll(async () => {
    buildRoot = mkdtempSync(path.join(tmpdir(), "nc-two-machines-"));
    r = new Redis(process.env.REDIS_URL!);
    // A machine's first revalidateTag claims the day's sweep (nc:sweep, NX);
    // remove that claim afterwards only if this run is what made it.
    sweepExisted = (await r.exists("nc:sweep")) === 1;
  });

  afterAll(async () => {
    if (r) {
      if (tagsTouched.size > 0) await r.hdel(TAGS_HASH, ...tagsTouched);
      for (const id of dists.keys()) {
        const keys = await scanKeys(r, `nc:${id}:*`);
        if (keys.length > 0) await r.del(...keys);
      }
      if (!sweepExisted) await r.del("nc:sweep");
      await r.quit();
    }
    if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
  });

  it("B (cold memory) serves what A cached", () => {
    run([{ op: "set", key: "k-share", tag, body: "v1" }]);
    expect(run([{ op: "get", key: "k-share", tag }])).toEqual([{ found: true, isStale: false, body: "v1" }]);
  });

  it("A's {expire:0} makes B return nothing", () => {
    run([{ op: "set", key: "k-exp", tag: `${tag}-x`, body: "v1" }]);
    run([{ op: "revalidate", tag: `${tag}-x`, expire: 0 }]);
    expect(run([{ op: "get", key: "k-exp", tag: `${tag}-x` }])[0].found).toBe(false);
  });

  it("A's 'max' makes B serve stale", () => {
    run([{ op: "set", key: "k-max", tag: `${tag}-m`, body: "v1" }]);
    run([{ op: "revalidate", tag: `${tag}-m` }]);
    expect(run([{ op: "get", key: "k-max", tag: `${tag}-m` }])[0]).toMatchObject({ found: true, isStale: true });
  });

  it("'max' then {expire:0} from different machines: expiry wins on a third", () => {
    run([{ op: "set", key: "k-both", tag: `${tag}-b`, body: "v1" }]);
    run([{ op: "revalidate", tag: `${tag}-b` }]);
    run([{ op: "revalidate", tag: `${tag}-b`, expire: 0 }]);
    expect(run([{ op: "get", key: "k-both", tag: `${tag}-b` }])[0].found).toBe(false);
  });

  it("A's write is in Redis under nc:<the BUILD_ID beside serverDistDir>:<key>, with revalidate + 1h as its TTL", async () => {
    // Without this, an unread BUILD_ID (memory-only machine) would leave every
    // "B misses" case above green for the wrong reason.
    run([{ op: "set", key: "k-seam", tag: `${tag}-seam`, body: "v-seam" }]);
    const raw = await r.get(`nc:${BUILD_ID}:k-seam`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ v: 1, value: { kind: "FETCH", data: { body: "v-seam" }, revalidate: 300 } });
    const ttl = await r.ttl(`nc:${BUILD_ID}:k-seam`);
    expect(ttl).toBeGreaterThan(300 + 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(300 + 3600);
  });

  it("B with NEXT_CACHE_REDIS unset misses what A cached (memory-only), while a flag-on C still serves it", () => {
    // The negative twin of "B (cold memory) serves what A cached": the same
    // fresh-process get, minus Redis. C proves A's entry was there to miss.
    run([{ op: "set", key: "k-flag-off", tag: `${tag}-off`, body: "v1" }]);
    expect(run([{ op: "get", key: "k-flag-off", tag: `${tag}-off` }], { env: { NEXT_CACHE_REDIS: undefined } }))
      .toEqual([{ found: false, isStale: null, body: null }]);
    expect(run([{ op: "get", key: "k-flag-off", tag: `${tag}-off` }]))
      .toEqual([{ found: true, isStale: false, body: "v1" }]);
  });

  it("G1: a fresh machine whose FIRST op is an unstable_cache read gets A's value from Redis without calling its producer", () => {
    // Each machine's first operation runs while its boot-time Redis client is
    // still connecting; it must wait for that first ready, not miss.
    const t = `${tag}-g1`;
    expect(run([{ op: "cached", key: "g1-read", tag: t, produce: "from-A" }]))
      .toEqual([{ value: "from-A", produced: 1 }]);
    expect(run([{ op: "cached", key: "g1-read", tag: t, produce: "from-B" }]))
      .toEqual([{ value: "from-A", produced: 0 }]);
  });

  it("G1 negative: with NEXT_CACHE_REDIS unset, that same first read calls its producer", () => {
    const t = `${tag}-g1-off`;
    run([{ op: "cached", key: "g1-off", tag: t, produce: "from-A" }]);
    expect(run([{ op: "cached", key: "g1-off", tag: t, produce: "from-B" }], { env: { NEXT_CACHE_REDIS: undefined } }))
      .toEqual([{ value: "from-B", produced: 1 }]);
    // ...while a flag-on machine is served A's value: the miss above is the flag's.
    expect(run([{ op: "cached", key: "g1-off", tag: t, produce: "from-C" }]))
      .toEqual([{ value: "from-A", produced: 0 }]);
  });

  it("G1: a fresh machine whose FIRST op is a revalidateTag lands it in nc:tags", async () => {
    const t = `${tag}-g1-rev`;
    const before = Date.now();
    expect(run([{ op: "revalidate", tag: t, expire: 0 }])).toEqual([{ ok: true }]);
    const after = Date.now();
    const s = decodeField(await r.hget(TAGS_HASH, t));
    expect(s).not.toBeNull();
    expect(s!.at).toBeGreaterThanOrEqual(before);
    expect(s!.at).toBeLessThanOrEqual(after);
    expect(s).toEqual(writeState({}, { expire: 0 }, s!.at));
  });

  it("an unstable_cache entry with revalidate:false (INFINITE_CACHE) lands with the 30-day TTL cap", async () => {
    const id = `${BUILD_ID}-ttl`;
    run([{ op: "cached", key: "ttl", tag: `${tag}-ttl`, produce: "v", revalidate: false }], { buildId: id });
    const keys = await scanKeys(r, `nc:${id}:*`);
    expect(keys).toHaveLength(1);
    // The stored revalidate is Next's uncapped INFINITE_CACHE, so the TTL
    // below is the handler's cap and not a coincidence of the input.
    expect(JSON.parse((await r.get(keys[0]))!).value.revalidate).toBe(INFINITE_CACHE);
    const ttl = await r.ttl(keys[0]);
    expect(ttl).toBeGreaterThan(NO_TTL_EX - 60);
    expect(ttl).toBeLessThanOrEqual(NO_TTL_EX);
  });
});

describe.skipIf(!HAS_REDIS)("tag-state Lua scripts on a real Redis", () => {
  // The handler suite drives these scripts through a TypeScript model of
  // them, so a wrong Lua script stays green there. These run the real strings.
  const HASH = `nc:test:${BUILD_ID}:lua`;
  let r: Redis;

  beforeAll(() => {
    r = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    if (!r) return;
    await r.del(HASH);
    await r.quit();
  });

  it("HSET_IF_NEWER: newer wins, a tie applies, older is rejected, absent is created; one call, many fields", async () => {
    await r.del(HASH);
    const now = Date.now();
    await r.hset(HASH,
      "newer", encodeField({ at: now - 10, expired: now - 10 }),
      "tie", encodeField({ at: now, stale: now }),
      "older", encodeField({ at: now, expired: now }),
    );
    const incoming = {
      newer: encodeField({ at: now, expired: now }),
      tie: encodeField({ at: now, expired: now + 1 }),
      older: encodeField({ at: now - 1, stale: now - 1 }),
      absent: encodeField({ at: now, stale: now }),
    };
    expect(await r.eval(HSET_IF_NEWER, 1, HASH, ...Object.entries(incoming).flat())).toBe(1);
    expect(await r.hgetall(HASH)).toEqual({
      newer: incoming.newer,
      tie: incoming.tie,
      older: encodeField({ at: now, expired: now }),
      absent: incoming.absent,
    });
  });

  it("HSET_IF_NEWER: a malformed stored field is overwritten; a malformed incoming value is never written", async () => {
    await r.del(HASH);
    await r.hset(HASH, "stored-garbage", "garbage", "stored-no-bar", "12345", "kept", encodeField({ at: 1 }));
    const good = encodeField({ at: 5, expired: 5 });
    await r.eval(HSET_IF_NEWER, 1, HASH,
      "stored-garbage", good,
      "stored-no-bar", good,
      "kept", "garbage",
      "never-created", `1e3|{}`,
    );
    expect(await r.hgetall(HASH)).toEqual({
      "stored-garbage": good,
      "stored-no-bar": good,
      kept: encodeField({ at: 1 }),
    });
  });

  it("HDEL_IF_OLDER re-reads every candidate: only the unparseable and the wholly older-than-cutoff go, and it returns that count", async () => {
    await r.del(HASH);
    const now = Date.now();
    const cutoff = now - 365 * DAY_MS;
    const old = cutoff - DAY_MS;
    const cases: Record<string, { raw: string; dead: boolean }> = {
      "all-old": { raw: encodeField({ at: old, stale: old, expired: old }), dead: true },
      "fresh-at": { raw: encodeField({ at: now, stale: old, expired: old }), dead: false },
      "old-at-fresh-stale": { raw: encodeField({ at: old, stale: now }), dead: false },
      "old-at-fresh-expired": { raw: encodeField({ at: old, expired: now }), dead: false },
      "at-equals-cutoff": { raw: encodeField({ at: cutoff }), dead: false },
      "at-cutoff-minus-1": { raw: encodeField({ at: cutoff - 1 }), dead: true },
      garbage: { raw: "garbage", dead: true },
      "bad-json": { raw: `${now}|{not json`, dead: true },
      "json-null": { raw: `${now}|null`, dead: true },
      "json-number": { raw: `${now}|42`, dead: true },
      "exponent-at": { raw: `1e3|{}`, dead: true },
      "old-empty": { raw: `${old}|{}`, dead: true },
      "fresh-empty": { raw: `${now}|{}`, dead: false },
      "string-stale-ignored": { raw: `${old}|${JSON.stringify({ stale: String(now) })}`, dead: true },
      // A 'max' write 400 days ago: at and stale are past the cutoff, but its
      // year-long expiry landed only 35 days ago, so it is still live state.
      "max-400-days-ago": { raw: encodeField(writeState({}, MAX, now - 400 * DAY_MS)), dead: false },
    };
    await r.hset(HASH, ...Object.entries(cases).flatMap(([f, c]) => [f, c.raw]));
    const candidates = [...Object.keys(cases), "absent-field"];
    const deleted = await r.eval(HDEL_IF_OLDER, 1, HASH, cutoff, ...candidates);
    const dead = Object.keys(cases).filter((f) => cases[f].dead);
    const live = Object.keys(cases).filter((f) => !cases[f].dead);
    expect(deleted).toBe(dead.length);
    expect(Object.keys(await r.hgetall(HASH)).sort()).toEqual(live.sort());
  });

  it("HDEL_IF_OLDER race: a field rewritten fresh between the sweep's HSCAN and the delete survives; a still-old one is deleted", async () => {
    await r.del(HASH);
    const now = Date.now();
    const cutoff = now - 365 * DAY_MS;
    const old = encodeField({ at: cutoff - DAY_MS, stale: cutoff - DAY_MS, expired: cutoff - DAY_MS });
    await r.hset(HASH, "rewritten", old, "still-old", old);
    // The sweep's HSCAN judges both dead, as the handler's maybeSweep does...
    const [, flat] = await r.hscan(HASH, "0", "COUNT", 500);
    const judgedDead: string[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const s = decodeField(flat[i + 1]);
      if (!s || Math.max(s.at, s.stale ?? 0, s.expired ?? 0) < cutoff) judgedDead.push(flat[i]);
    }
    expect(judgedDead.sort()).toEqual(["rewritten", "still-old"]);
    // ...then another machine revalidates one of them before the delete lands.
    const fresh = encodeField(writeState({}, { expire: 0 }, Date.now()));
    await r.eval(HSET_IF_NEWER, 1, HASH, "rewritten", fresh);
    expect(await r.eval(HDEL_IF_OLDER, 1, HASH, cutoff, ...judgedDead)).toBe(1);
    expect(await r.hget(HASH, "rewritten")).toBe(fresh);
    expect(await r.hexists(HASH, "still-old")).toBe(0);
  });
});
