// The lease primitives (lib/cache.ts) and the single-flight rebuild built on
// them (lib/single-flight-cache.ts), against a REAL Redis.
//
// `single-flight-cache.test.ts` drives the orchestration through an in-memory
// fake that promises the same semantics; only a real server can prove the Lua
// keeps those promises — that a fill is refused once the key no longer holds
// the filler's own lease, that a release never deletes someone else's, and
// that a lease's PX actually expires it. Skipped without REDIS_URL; CI runs it
// in the Redis-gated step (ci.yml), which owns REDIS_URL for itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import {
  cacheDel,
  cacheLeaseAcquire,
  cacheLeaseFill,
  cacheLeaseRelease,
  cacheReadRaw,
  incrWindow,
} from "@/lib/cache";
import { cachedSingleFlight } from "@/lib/single-flight-cache";

const HAS_REDIS = !!process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `test:lease:${randomUUID()}`;

describe.skipIf(!HAS_REDIS)("cache leases (real Redis)", () => {
  // A second, independent connection to look at what is really stored.
  let probe: Redis;

  beforeAll(async () => {
    probe = new Redis(process.env.REDIS_URL!);
    for (let i = 0; i < 50; i++) {
      if ((await incrWindow(`warmup:${randomUUID()}`, 5)) !== null) return;
      await sleep(100);
    }
    throw new Error("Redis did not become ready");
  });

  afterAll(async () => {
    await probe?.quit().catch(() => {});
    const g = globalThis as unknown as { _redis?: { quit?: () => Promise<unknown> } };
    await g._redis?.quit?.().catch(() => {});
  });

  describe("acquire", () => {
    it("`absent` takes an empty key once; a second caller finds it held", async () => {
      const key = uniq();
      const first = await cacheLeaseAcquire(key, 5_000, "absent");
      const second = await cacheLeaseAcquire(key, 5_000, "absent");

      expect(first.kind).toBe("acquired");
      expect(second.kind).toBe("held");
      expect(await cacheReadRaw(key)).toEqual({ kind: "leased" });
    });

    it("`absent` never takes a key that holds a document", async () => {
      const key = uniq();
      await probe.set(key, JSON.stringify({ v: 1 }), "EX", 60);

      expect((await cacheLeaseAcquire(key, 5_000, "absent")).kind).toBe("held");
      expect(await cacheReadRaw(key)).toEqual({ kind: "value", raw: '{"v":1}' });
    });

    it("`replace` takes a key over a document it has rejected", async () => {
      const key = uniq();
      await probe.set(key, JSON.stringify({ shape: "old" }), "EX", 60);

      expect((await cacheLeaseAcquire(key, 5_000, "replace")).kind).toBe("acquired");
      expect(await cacheReadRaw(key)).toEqual({ kind: "leased" });
    });

    it("a lease EXPIRES after its PX: a holder that died hands the key on by itself", async () => {
      const key = uniq();
      expect((await cacheLeaseAcquire(key, 100, "absent")).kind).toBe("acquired");
      expect((await cacheLeaseAcquire(key, 100, "absent")).kind).toBe("held");

      await sleep(180);

      expect(await cacheReadRaw(key)).toEqual({ kind: "absent" });
      expect((await cacheLeaseAcquire(key, 100, "absent")).kind).toBe("acquired");
    });
  });

  describe("fill — a compare-and-set against the filler's own lease", () => {
    it("lands the document, with its TTL, and the last-known-good copy with ITS TTL", async () => {
      const key = uniq();
      const staleKey = uniq();
      const lease = await cacheLeaseAcquire(key, 5_000, "absent");
      if (lease.kind !== "acquired") throw new Error("no lease");

      const landed = await cacheLeaseFill(key, lease.token, { v: 2 }, 15, { key: staleKey, ttlSeconds: 60 });

      expect(landed).toBe(true);
      expect(await probe.get(key)).toBe('{"v":2}');
      expect(await probe.get(staleKey)).toBe('{"v":2}');
      const ttl = await probe.ttl(key);
      const staleTtl = await probe.ttl(staleKey);
      expect(ttl).toBeGreaterThan(10);
      expect(ttl).toBeLessThanOrEqual(15);
      expect(staleTtl).toBeGreaterThan(15);
      expect(staleTtl).toBeLessThanOrEqual(60);
    });

    it("is REFUSED once a write has DELeted the key mid-build — the pre-write document never goes back", async () => {
      const key = uniq();
      const staleKey = uniq();
      await probe.set(staleKey, '{"v":0}', "EX", 60);
      const lease = await cacheLeaseAcquire(key, 5_000, "absent");
      if (lease.kind !== "acquired") throw new Error("no lease");

      // The writer's DEL: the same `cacheDel` every public-cache writer sends.
      await cacheDel(key);
      const landed = await cacheLeaseFill(key, lease.token, { v: 1 }, 15, { key: staleKey, ttlSeconds: 60 });

      expect(landed).toBe(false);
      expect(await probe.get(key)).toBeNull();
      // Nor did it touch the last-known-good copy.
      expect(await probe.get(staleKey)).toBe('{"v":0}');
    });

    it("is REFUSED for a token that is not the one holding the key", async () => {
      const key = uniq();
      const mine = await cacheLeaseAcquire(key, 5_000, "absent");
      if (mine.kind !== "acquired") throw new Error("no lease");

      const landed = await cacheLeaseFill(key, randomUUID(), { v: "impostor" }, 15);

      expect(landed).toBe(false);
      expect(await cacheReadRaw(key)).toEqual({ kind: "leased" });
      // The real holder still can.
      expect(await cacheLeaseFill(key, mine.token, { v: "mine" }, 15)).toBe(true);
      expect(await probe.get(key)).toBe('{"v":"mine"}');
    });

    it("is REFUSED once another caller has replaced the lease (a slow holder overtaken)", async () => {
      const key = uniq();
      const slow = await cacheLeaseAcquire(key, 5_000, "absent");
      const fast = await cacheLeaseAcquire(key, 5_000, "replace");
      if (slow.kind !== "acquired" || fast.kind !== "acquired") throw new Error("no lease");

      expect(await cacheLeaseFill(key, slow.token, { v: "slow" }, 15)).toBe(false);
      expect(await cacheLeaseFill(key, fast.token, { v: "fast" }, 15)).toBe(true);
      expect(await probe.get(key)).toBe('{"v":"fast"}');
    });
  });

  describe("release — only by the lease's owner", () => {
    it("the owner's release empties the key", async () => {
      const key = uniq();
      const lease = await cacheLeaseAcquire(key, 5_000, "absent");
      if (lease.kind !== "acquired") throw new Error("no lease");

      await cacheLeaseRelease(key, lease.token);

      expect(await probe.exists(key)).toBe(0);
    });

    it("a release with ANOTHER token leaves the holder's lease in place", async () => {
      const key = uniq();
      const holder = await cacheLeaseAcquire(key, 5_000, "absent");
      if (holder.kind !== "acquired") throw new Error("no lease");

      await cacheLeaseRelease(key, randomUUID());

      expect(await cacheReadRaw(key)).toEqual({ kind: "leased" });
      expect(await cacheLeaseFill(key, holder.token, { v: 1 }, 15)).toBe(true);
    });

    it("a late release never deletes a document someone else has since filled", async () => {
      const key = uniq();
      const first = await cacheLeaseAcquire(key, 100, "absent");
      if (first.kind !== "acquired") throw new Error("no lease");
      await sleep(150); // first's lease expired
      const second = await cacheLeaseAcquire(key, 5_000, "absent");
      if (second.kind !== "acquired") throw new Error("no lease");
      expect(await cacheLeaseFill(key, second.token, { v: "second" }, 15)).toBe(true);

      await cacheLeaseRelease(key, first.token);

      expect(await probe.get(key)).toBe('{"v":"second"}');
    });
  });

  describe("cachedSingleFlight on a real Redis", () => {
    it("20 concurrent misses run the builder exactly once", async () => {
      const key = uniq();
      let builds = 0;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          cachedSingleFlight({
            key,
            ttlSeconds: 15,
            leaseMs: 5_000,
            waitMs: 1_500,
            build: async () => {
              builds += 1;
              await sleep(60);
              return { built: builds };
            },
          }),
        ),
      );

      expect(builds).toBe(1);
      expect(results.every((r) => r.built === 1)).toBe(true);
      expect(await probe.get(key)).toBe('{"built":1}');
    });

    it("a rebuild overtaken by a write's DEL is not cached; the next read rebuilds with the write", async () => {
      const key = uniq();
      let version = 1;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const inFlight = cachedSingleFlight({
        key,
        ttlSeconds: 15,
        leaseMs: 5_000,
        waitMs: 1_500,
        build: async () => {
          const v = version;
          await held;
          return { v };
        },
      });
      await sleep(20);

      version = 2;
      await cacheDel(key);
      release();
      expect(await inFlight).toEqual({ v: 1 });
      expect(await probe.get(key)).toBeNull();

      const next = await cachedSingleFlight({
        key,
        ttlSeconds: 15,
        leaseMs: 5_000,
        waitMs: 1_500,
        build: async () => ({ v: version }),
      });
      expect(next).toEqual({ v: 2 });
      expect(await probe.get(key)).toBe('{"v":2}');
    });
  });
});
