// The FIRST Redis command after a process starts, against a REAL Redis.
//
// `client()` (lib/cache.ts) builds the ioredis client on first use and, with
// `lazyConnect: false`, starts connecting at that moment. It also sets
// `enableOfflineQueue: false`, so a command issued before the socket is
// `ready` is not queued: ioredis rejects it on the spot ("Stream isn't
// writeable…"). The command that CAUSED the client to be built is always such
// a command, so before the connect wait every cold start lost its first one:
// a cache read missed, a fail-open limit (MUTATION_LIMIT, CONSENT_LIMIT…)
// silently skipped its count, and a fail-closed limit (AUTH_LIMIT,
// EMAIL_LIMIT) refused the request as a Redis "outage". Prod machines
// suspend/resume and staging machines stop/start, so it recurred all day.
//
// Each case below starts from "never connected" (the memoised client cleared)
// so the helper under test sends the first command the new client ever sees.
// A probe connection of its own arranges the keys and reads what landed.
//
// The other side of the bound — an unreachable or silent Redis still answers
// within REDIS_CONNECT_WAIT_MS, and at once after that — needs no Redis and
// lives in cache-unreachable.test.ts, which runs in every job.
//
// Skipped without REDIS_URL; CI runs it in the Redis-gated step (ci.yml).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import Redis from "ioredis";
import * as cache from "@/lib/cache";
import { EMAIL_LIMIT, MUTATION_LIMIT, rateLimit } from "@/lib/rate-limit";

const HAS_REDIS = !!process.env.REDIS_URL;
const REDIS_URL = process.env.REDIS_URL;
const uniq = () => `test:cold:${randomUUID()}`;

const memo = globalThis as unknown as { _redis?: Redis | null };

/** Forget the memoised client, so the next helper call builds — and connects — a new one. */
function forgetClient(): void {
  const c = memo._redis;
  memo._redis = undefined;
  c?.disconnect();
}

/** The client the helpers are using now (built by the last helper call). */
function liveClient(): Redis {
  const c = memo._redis;
  if (!c) throw new Error("no memoised Redis client — call a helper first");
  return c;
}

/**
 * One case per exported helper that sends a Redis command: arrange through
 * the probe, call the helper as the cold client's FIRST command, then prove
 * from the probe that the command really ran.
 */
interface ColdCase {
  helper: string;
  run(probe: Redis, key: string): Promise<void>;
}

const COLD_CASES: ColdCase[] = [
  {
    helper: "cacheGet",
    async run(probe, key) {
      await probe.set(key, JSON.stringify({ v: 1 }), "EX", 60);
      forgetClient();
      expect(await cache.cacheGet(key)).toEqual({ v: 1 });
    },
  },
  {
    helper: "cacheSet",
    async run(probe, key) {
      forgetClient();
      await cache.cacheSet(key, { v: 2 }, 60);
      expect(await probe.get(key)).toBe(JSON.stringify({ v: 2 }));
    },
  },
  {
    helper: "cacheDel",
    async run(probe, key) {
      await probe.set(key, "x", "EX", 60);
      forgetClient();
      await cache.cacheDel(key);
      expect(await probe.exists(key)).toBe(0);
    },
  },
  {
    helper: "cacheDelPattern",
    async run(probe, key) {
      await probe.set(`${key}:a`, "x", "EX", 60);
      await probe.set(`${key}:b`, "x", "EX", 60);
      forgetClient();
      await cache.cacheDelPattern(`${key}:*`);
      expect(await probe.exists(`${key}:a`, `${key}:b`)).toBe(0);
    },
  },
  {
    helper: "cacheReadRaw",
    async run(probe, key) {
      await probe.set(key, JSON.stringify("doc"), "EX", 60);
      forgetClient();
      expect(await cache.cacheReadRaw(key)).toEqual({ kind: "value", raw: JSON.stringify("doc") });
    },
  },
  {
    helper: "cacheLeaseAcquire",
    async run(probe, key) {
      forgetClient();
      const lease = await cache.cacheLeaseAcquire(key, 5_000, "absent");
      expect(lease.kind).toBe("acquired");
      expect(await probe.get(key)).toBe(`lease:${(lease as { token: string }).token}`);
    },
  },
  {
    helper: "cacheLeaseFill",
    async run(probe, key) {
      const token = randomUUID();
      await probe.set(key, `lease:${token}`, "PX", 5_000);
      forgetClient();
      expect(await cache.cacheLeaseFill(key, token, { v: 3 }, 60)).toBe(true);
      expect(await probe.get(key)).toBe(JSON.stringify({ v: 3 }));
    },
  },
  {
    helper: "cacheLeaseRelease",
    async run(probe, key) {
      const token = randomUUID();
      await probe.set(key, `lease:${token}`, "PX", 5_000);
      forgetClient();
      await cache.cacheLeaseRelease(key, token);
      expect(await probe.exists(key)).toBe(0);
    },
  },
  {
    helper: "incrWindow",
    async run(probe, key) {
      forgetClient();
      const window = await cache.incrWindow(key, 60);
      expect(window?.count).toBe(1);
      expect(window!.ttlMs).toBeGreaterThan(0);
      expect(await probe.get(key)).toBe("1");
    },
  },
];

/**
 * The exports of lib/cache.ts that are functions but send no Redis command of
 * their own. Every OTHER exported function must have a cold case above, so a
 * helper added later cannot skip the connect wait unseen.
 */
const NOT_REDIS_COMMANDS = new Set(["cacheEnabled", "sendAfterDeleteOrBound", "__resetLeaseFailureLogForTests"]);

describe.skipIf(!HAS_REDIS)("the first command on a cold client (real Redis)", () => {
  let probe: Redis;

  beforeAll(async () => {
    probe = new Redis(REDIS_URL!);
    await probe.ping();
  });

  afterEach(() => {
    forgetClient();
    process.env.REDIS_URL = REDIS_URL;
  });

  afterAll(async () => {
    await probe?.quit().catch(() => {});
  });

  it("every Redis-command helper is in the sweep", () => {
    const helpers = Object.entries(cache)
      .filter(([name, value]) => typeof value === "function" && !NOT_REDIS_COMMANDS.has(name))
      .map(([name]) => name)
      .sort();
    expect(helpers.length).toBeGreaterThan(0);
    expect(COLD_CASES.map((c) => c.helper).sort()).toEqual(helpers);
  });

  it("each helper's first command on a brand-new client lands", async () => {
    let checked = 0;
    const failures: string[] = [];
    for (const coldCase of COLD_CASES) {
      try {
        await coldCase.run(probe, uniq());
      } catch (err) {
        failures.push(`${coldCase.helper}: ${err instanceof Error ? err.message : String(err)}`);
      }
      checked += 1;
    }
    expect(failures).toEqual([]);
    expect(checked).toBe(COLD_CASES.length);
    expect(checked).toBe(9);
  });

  it("a fail-CLOSED limit does not refuse the first request after a cold start, and counts it", async () => {
    const id = uniq();
    forgetClient();
    await expect(rateLimit(id, EMAIL_LIMIT)).resolves.toBeUndefined();
    expect(await probe.get(`rl:${id}`)).toBe("1");
    // The next request, on the now-warm client, counts on from there.
    await rateLimit(id, EMAIL_LIMIT);
    expect(await probe.get(`rl:${id}`)).toBe("2");
  });

  it("a fail-OPEN limit counts the first request after a cold start", async () => {
    const id = uniq();
    forgetClient();
    await rateLimit(id, MUTATION_LIMIT);
    expect(await probe.get(`rl:${id}`)).toBe("1");
    await rateLimit(id, MUTATION_LIMIT);
    expect(await probe.get(`rl:${id}`)).toBe("2");
  });

  it("a burst of first requests on one cold client all count, sharing one wait", async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);
    try {
      const key = uniq();
      const BURST = 25; // > EventEmitter's default 10 listeners, so a wait per caller would warn
      forgetClient();
      const windows = await Promise.all(Array.from({ length: BURST }, () => cache.incrWindow(key, 60)));
      expect(windows.map((w) => w?.count).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
        Array.from({ length: BURST }, (_, i) => i + 1),
      );
      expect(await probe.get(key)).toBe(String(BURST));
      await new Promise((r) => setImmediate(r));
      expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("a command issued while a dropped connection is reconnecting waits for it and lands", async () => {
    const key = uniq();
    forgetClient();
    expect((await cache.incrWindow(key, 60))?.count).toBe(1);
    const c = liveClient();
    const clientId = await c.client("ID");
    const reconnecting = once(c, "reconnecting");
    await probe.client("KILL", "ID", String(clientId));
    await reconnecting;
    expect(c.status).not.toBe("ready");

    expect((await cache.incrWindow(key, 60))?.count).toBe(2);
    expect(await probe.get(key)).toBe("2");
  });

  // Outage → recovery → drop, through a TCP proxy this test opens and closes in
  // front of the real Redis: a failed connection attempt marks Redis down (no
  // waiting while it is), the next `ready` clears that, and a later drop of an
  // established connection waits for its reconnect again.
  it("after an outage recovers, a later dropped connection is waited for again", async () => {
    const upstream = new URL(REDIS_URL!);
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((down) => {
      const up = net.connect(Number(upstream.port || 6379), upstream.hostname);
      for (const s of [down, up]) {
        sockets.add(s);
        s.on("error", () => {});
        s.on("close", () => sockets.delete(s));
      }
      down.pipe(up);
      up.pipe(down);
    });
    const sever = () => {
      for (const s of sockets) s.destroy();
    };
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (proxy.address() as net.AddressInfo).port;
    proxy.close();
    await once(proxy, "close");

    try {
      // Outage: nothing listens on the port, so every attempt is refused.
      process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
      forgetClient();
      const key = uniq();
      expect(await cache.incrWindow(key, 60)).toBeNull();
      const c = liveClient();
      expect(c.status).not.toBe("ready");

      // Recovery.
      const ready = once(c, "ready");
      proxy.listen(port, "127.0.0.1");
      await once(proxy, "listening");
      await ready;
      expect((await cache.incrWindow(key, 60))?.count).toBe(1);

      // A drop of the now-established connection: the next command waits for the reconnect.
      const reconnecting = once(c, "reconnecting");
      sever();
      await reconnecting;
      expect(c.status).not.toBe("ready");
      expect((await cache.incrWindow(key, 60))?.count).toBe(2);
      expect(await probe.get(key)).toBe("2");
    } finally {
      forgetClient();
      sever();
      proxy.close();
    }
  });
});
