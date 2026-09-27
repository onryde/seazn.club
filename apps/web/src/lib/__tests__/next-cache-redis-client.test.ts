// apps/web/src/lib/__tests__/next-cache-redis-client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  withRedis, cacheStatus, nextCacheRedis, __setRedisForTests, __resetRedisStateForTests,
  BREAKER_FAILURES, BREAKER_OPEN_MS,
} from "../../../cache-handler/redis-client.mjs";

// The module logs one JSON line per breaker transition via console.warn; keep
// the run quiet and let the warning tests count lines by pino level.
let warn: MockInstance<typeof console.warn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { __resetRedisStateForTests(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const fake = (over: Record<string, unknown> = {}) => ({ status: "ready", ...over });
const levels = () => warn.mock.calls.map(([line]) => (JSON.parse(String(line)) as { level: number }).level);
const redisDown = async (): Promise<never> => { throw new Error("timeout"); };
async function trip() {
  for (let i = 0; i < BREAKER_FAILURES; i++) await withRedis(redisDown, "fb");
}

describe("withRedis", () => {
  it("flag off → never constructs a client, returns fallback, status memory", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", ""); vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    const fn = vi.fn();
    expect(await withRedis(fn, "fb")).toBe("fb");
    expect(fn).not.toHaveBeenCalled();
    expect(nextCacheRedis()).toBeNull();
    expect(cacheStatus()).toBe("memory");
  });

  it("not-yet-ready client → fallback WITHOUT counting a failure (boot)", async () => {
    const c = fake({ status: "connecting" });
    __setRedisForTests(c);
    for (let i = 0; i < BREAKER_FAILURES + 2; i++) expect(await withRedis(async () => "x", "fb")).toBe("fb");
    c.status = "ready";
    expect(await withRedis(async () => "x", "fb")).toBe("x"); // breaker never opened
  });

  it("opens after N consecutive failures, skips for BREAKER_OPEN_MS, then probes", async () => {
    vi.useFakeTimers();
    __setRedisForTests(fake());
    const boom = vi.fn(async () => { throw new Error("timeout"); });
    for (let i = 0; i < BREAKER_FAILURES; i++) await withRedis(boom, "fb");
    expect(cacheStatus()).toBe("degraded");
    const ok = vi.fn(async () => "x");
    expect(await withRedis(ok, "fb")).toBe("fb");
    expect(ok).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BREAKER_OPEN_MS + 1);
    expect(await withRedis(ok, "fb")).toBe("x");
    expect(cacheStatus()).toBe("redis");
  });

  it("a success resets the failure count", async () => {
    __setRedisForTests(fake());
    const boom = async () => { throw new Error("x"); };
    for (let i = 0; i < BREAKER_FAILURES - 1; i++) await withRedis(boom, 0);
    await withRedis(async () => 1, 0);
    for (let i = 0; i < BREAKER_FAILURES - 1; i++) await withRedis(boom, 0);
    expect(cacheStatus()).toBe("redis");
  });

  it("boot misses leave the failure count at zero: N-1 real failures after boot still do not trip", async () => {
    const c = fake({ status: "connecting" });
    __setRedisForTests(c);
    for (let i = 0; i < BREAKER_FAILURES + 2; i++) await withRedis(async () => "x", "fb");
    c.status = "ready";
    for (let i = 0; i < BREAKER_FAILURES - 1; i++) await withRedis(redisDown, "fb");
    expect(cacheStatus()).toBe("redis");
    expect(await withRedis(async () => "x", "fb")).toBe("x");
  });

  it("stays open for the whole BREAKER_OPEN_MS window and probes exactly at its end", async () => {
    vi.useFakeTimers();
    __setRedisForTests(fake());
    await trip();
    const ok = vi.fn(async () => "x");
    vi.advanceTimersByTime(BREAKER_OPEN_MS - 1);
    expect(await withRedis(ok, "fb")).toBe("fb");
    expect(ok).not.toHaveBeenCalled();
    expect(cacheStatus()).toBe("degraded");
    vi.advanceTimersByTime(1);
    expect(await withRedis(ok, "fb")).toBe("x");
  });

  it("a failed probe re-opens the breaker at once, and the outage warns only once", async () => {
    vi.useFakeTimers();
    __setRedisForTests(fake());
    const failing = vi.fn(redisDown);
    for (let i = 0; i < BREAKER_FAILURES; i++) await withRedis(failing, "fb");
    vi.advanceTimersByTime(BREAKER_OPEN_MS);
    expect(await withRedis(failing, "fb")).toBe("fb");
    expect(failing).toHaveBeenCalledTimes(BREAKER_FAILURES + 1); // the probe really ran
    const ok = vi.fn(async () => "x");
    expect(await withRedis(ok, "fb")).toBe("fb");
    expect(ok).not.toHaveBeenCalled();
    expect(cacheStatus()).toBe("degraded");
    expect(levels()).toEqual([40]);
  });

  it("recovery logs once and re-arms the outage warning for the next outage", async () => {
    vi.useFakeTimers();
    __setRedisForTests(fake());
    await trip();
    vi.advanceTimersByTime(BREAKER_OPEN_MS);
    expect(await withRedis(async () => "x", "fb")).toBe("x");
    expect(await withRedis(async () => "y", "fb")).toBe("y"); // a healthy call is not a second recovery
    await trip();
    expect(levels()).toEqual([40, 30, 40]);
  });

  it("a success after fewer than BREAKER_FAILURES failures is not a recovery: nothing is logged", async () => {
    __setRedisForTests(fake());
    for (let i = 0; i < BREAKER_FAILURES - 1; i++) await withRedis(redisDown, "fb");
    expect(await withRedis(async () => "x", "fb")).toBe("x");
    expect(levels()).toEqual([]);
  });

  it("a command in flight that succeeds after the breaker trips closes it: the next call reaches Redis", async () => {
    __setRedisForTests(fake());
    let release: (v: string) => void = () => {};
    const late = withRedis(() => new Promise<string>((resolve) => { release = resolve; }), "fb");
    await trip();
    expect(cacheStatus()).toBe("degraded");
    release("late");
    expect(await late).toBe("late");
    expect(cacheStatus()).toBe("redis");
    const ok = vi.fn(async () => "x");
    expect(await withRedis(ok, "fb")).toBe("x");
    expect(ok).toHaveBeenCalledTimes(1);
    expect(levels()).toEqual([40, 30]);
  });
});

describe("cacheStatus", () => {
  it("a client still connecting reports degraded, not redis", () => {
    __setRedisForTests(fake({ status: "connecting" }));
    expect(cacheStatus()).toBe("degraded");
  });
});

describe("nextCacheRedis", () => {
  it("flag on without REDIS_URL → no client, status memory", () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "");
    expect(nextCacheRedis()).toBeNull();
    expect(cacheStatus()).toBe("memory");
  });

  it.each(["0", "false", "true"])("NEXT_CACHE_REDIS=%s → no client: only \"1\" turns the tier on", (flag) => {
    vi.stubEnv("NEXT_CACHE_REDIS", flag); vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    expect(nextCacheRedis()).toBeNull();
    expect(cacheStatus()).toBe("memory");
  });

  it("flag on with an unparseable REDIS_URL → no client, memory, and one warning that omits the URL", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://:s3cret@host:99999");
    expect(() => nextCacheRedis()).not.toThrow();
    expect(nextCacheRedis()).toBeNull();
    expect(cacheStatus()).toBe("memory"); // /api/health calls this outside any try
    const fn = vi.fn(async () => "x");
    expect(await withRedis(fn, "fb")).toBe("fb");
    expect(fn).not.toHaveBeenCalled();
    expect(levels()).toEqual([40]);
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).not.toContain("s3cret");
    expect(logged).not.toContain("99999");
  });

  it("connection errors warn once per outage and the next ready logs recovery once (hard outages bypass the breaker)", () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://:s3cret@127.0.0.1:1");
    const r = nextCacheRedis();
    expect(r).not.toBeNull();
    // Synchronous on purpose: no real ECONNREFUSED can interleave with these emits.
    r?.emit("ready"); // the first ready at boot is not a recovery
    expect(levels()).toEqual([]);
    r?.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:1"));
    r?.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:1"));
    expect(levels()).toEqual([40]);
    r?.emit("ready");
    r?.emit("ready");
    expect(levels()).toEqual([40, 30]);
    r?.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:1"));
    expect(levels()).toEqual([40, 30, 40]);
    expect(warn.mock.calls.flat().join("\n")).not.toContain("s3cret");
  });

  it("flag on → builds one fail-fast ioredis client and reuses it; boot calls fall back", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    const r = nextCacheRedis();
    expect(r).not.toBeNull();
    expect(nextCacheRedis()).toBe(r);
    expect(r?.options).toMatchObject({
      connectTimeout: 1000, commandTimeout: 150, maxRetriesPerRequest: 0, enableOfflineQueue: false,
    });
    expect(r?.listenerCount("error")).toBeGreaterThan(0); // ECONNREFUSED must not surface as unhandled
    const fn = vi.fn(async () => "x");
    expect(await withRedis(fn, "fb")).toBe("fb");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a second module copy (the natively-imported handler) shares the client and breaker via globalThis", async () => {
    const c = fake();
    __setRedisForTests(c);
    vi.resetModules();
    const copy = await import("../../../cache-handler/redis-client.mjs");
    expect(copy.withRedis).not.toBe(withRedis); // genuinely a second instance, or this proves nothing
    expect(copy.nextCacheRedis()).toBe(c);
    await trip();
    expect(copy.cacheStatus()).toBe("degraded");
  });
});
