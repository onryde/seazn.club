// apps/web/src/lib/__tests__/next-cache-redis-client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventEmitter } from "node:events";
import {
  withRedis, cacheStatus, nextCacheRedis, __setRedisForTests, __resetRedisStateForTests,
  BREAKER_FAILURES, BREAKER_OPEN_MS, FIRST_READY_WAIT_MS,
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

  it("the connection-error line is pinned whole: host:port and code, never the password", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://:s3cret@127.0.0.1:1");
    nextCacheRedis();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5000 });
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      level: 40, name: "next-cache", msg: "redis connection error; serving from machine memory",
      err: "Error: connect ECONNREFUSED 127.0.0.1:1", code: "ECONNREFUSED",
    });
    expect(warn.mock.calls.flat().join("\n")).not.toContain("s3cret");
  });

  it("a real connection failure logs its errno code: Node's AggregateError alone prints only \"AggregateError\"", async () => {
    // localhost resolves to ::1 and 127.0.0.1, so Node's happy-eyeballs
    // connect fails with an AggregateError (or a plain Error where localhost
    // has one address); either way the line must carry the code, not the URL.
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://:s3cret@localhost:1");
    nextCacheRedis();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5000 });
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ level: 40, name: "next-cache", code: "ECONNREFUSED" });
    expect(warn.mock.calls.flat().join("\n")).not.toContain("s3cret");
  });

  it("an AggregateError with no code of its own logs its first coded child's code", () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://:s3cret@127.0.0.1:1");
    const r = nextCacheRedis();
    const coded = (code: string) => Object.assign(new Error("connect failed"), { code });
    r?.emit("error", new AggregateError([new Error("no code"), coded("ETIMEDOUT"), coded("ECONNREFUSED")]));
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ code: "ETIMEDOUT" });
    __resetRedisStateForTests(); // a fresh outage: the aggregate's own code wins over its children
    const r2 = nextCacheRedis();
    r2?.emit("error", Object.assign(new AggregateError([coded("ETIMEDOUT")]), { code: "ECONNREFUSED" }));
    expect(JSON.parse(String(warn.mock.calls[1][0]))).toMatchObject({ code: "ECONNREFUSED" });
    expect(warn.mock.calls.flat().join("\n")).not.toContain("s3cret");
  });

  it("flag on → builds one fail-fast ioredis client and reuses it; against a dead server a boot call waits the bound once, then falls back", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    const r = nextCacheRedis();
    expect(r).not.toBeNull();
    expect(nextCacheRedis()).toBe(r);
    expect(r?.options).toMatchObject({
      connectTimeout: 1000, commandTimeout: 150, maxRetriesPerRequest: 0, enableOfflineQueue: false,
    });
    expect(r?.listenerCount("error")).toBeGreaterThan(0); // ECONNREFUSED must not surface as unhandled
    const fn = vi.fn(async () => "x");
    let t = performance.now();
    expect(await withRedis(fn, "fb")).toBe("fb");
    expect(performance.now() - t).toBeGreaterThanOrEqual(FIRST_READY_WAIT_MS - 20);
    t = performance.now();
    expect(await withRedis(fn, "fb")).toBe("fb"); // never a second wait
    expect(performance.now() - t).toBeLessThan(100);
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

/**
 * A controllable ioredis: the REAL nextCacheRedis constructs it (vi.doMock) and
 * attaches its real listeners; the test decides when it becomes ready or drops.
 */
class FakeIORedis extends EventEmitter {
  static made: FakeIORedis[] = [];
  status = "connecting";
  constructor(readonly url: string, readonly options: object) {
    super();
    FakeIORedis.made.push(this);
  }
  disconnect() { this.status = "end"; }
  up() { this.status = "ready"; this.emit("ready"); }
  down() { this.status = "reconnecting"; this.emit("close"); }
}

describe("the first ready at boot (G1): one bounded wait, never again", () => {
  let rc: typeof import("../../../cache-handler/redis-client.mjs");
  beforeEach(async () => {
    FakeIORedis.made = [];
    vi.doMock("ioredis", () => ({ default: FakeIORedis }));
    vi.resetModules();
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("REDIS_URL", "redis://:s3cret@127.0.0.1:1");
    rc = await import("../../../cache-handler/redis-client.mjs");
  });
  afterEach(() => { vi.doUnmock("ioredis"); vi.resetModules(); });

  const booted = () => {
    const c = rc.nextCacheRedis() as unknown as FakeIORedis;
    expect(FakeIORedis.made).toEqual([c]); // the real constructor path, not an injected fake
    return c;
  };
  /** True while `p` is unsettled once pending microtasks run (no clock moves). */
  async function pending(p: Promise<unknown>) {
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    return !settled;
  }

  it("the first op after construction waits for the first ready and reaches Redis when it lands inside the bound", async () => {
    vi.useFakeTimers();
    const c = booted();
    const fn = vi.fn(async () => "x");
    const p = rc.withRedis(fn, "fb");
    await vi.advanceTimersByTimeAsync(rc.FIRST_READY_WAIT_MS - 1);
    expect(await pending(p)).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    c.up();
    expect(await p).toBe("x");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // the bound's timer is cleared, not left to fire
  });

  it("a client that never becomes ready is waited for once, FIRST_READY_WAIT_MS, then later ops skip with no wait", async () => {
    expect(rc.FIRST_READY_WAIT_MS).toBe(1000); // the ruling's bound
    vi.useFakeTimers();
    booted();
    const fn = vi.fn(async () => "x");
    const p = rc.withRedis(fn, "fb");
    await vi.advanceTimersByTimeAsync(rc.FIRST_READY_WAIT_MS - 1);
    expect(await pending(p)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe("fb");
    const later = rc.withRedis(fn, "fb");
    expect(await pending(later)).toBe(false);
    expect(await later).toBe("fb");
    expect(vi.getTimerCount()).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it("after the first ready, a dropped connection skips at once: an outage adds no wait and no breaker failure", async () => {
    vi.useFakeTimers();
    const c = booted();
    c.up(); // no op saw it ready: only the client's own ready event can say so
    c.down();
    const fn = vi.fn(async () => "x");
    const p = rc.withRedis(fn, "fb");
    expect(await pending(p)).toBe(false);
    expect(await p).toBe("fb");
    expect(vi.getTimerCount()).toBe(0);
    expect(fn).not.toHaveBeenCalled();
    // …and those skips are not breaker failures: on reconnect, N-1 real
    // failures still leave the breaker closed.
    for (let i = 0; i < rc.BREAKER_FAILURES + 2; i++) await rc.withRedis(fn, "fb");
    c.up();
    for (let i = 0; i < rc.BREAKER_FAILURES - 1; i++) await rc.withRedis(redisDown, "fb");
    expect(await rc.withRedis(fn, "fb")).toBe("x");
  });

  it("boot misses are never breaker failures: the timed-out wait, then instant skips, then N-1 real failures still do not trip", async () => {
    vi.useFakeTimers();
    const c = booted();
    const first = rc.withRedis(async () => "x", "fb");
    await vi.advanceTimersByTimeAsync(rc.FIRST_READY_WAIT_MS);
    expect(await first).toBe("fb");
    for (let i = 0; i < rc.BREAKER_FAILURES + 2; i++) expect(await rc.withRedis(async () => "x", "fb")).toBe("fb");
    c.up();
    for (let i = 0; i < rc.BREAKER_FAILURES - 1; i++) await rc.withRedis(redisDown, "fb");
    expect(rc.cacheStatus()).toBe("redis");
    const ok = vi.fn(async () => "x");
    expect(await rc.withRedis(ok, "fb")).toBe("x");
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("concurrent first ops share one wait: one timer, one extra ready listener, and all reach Redis", async () => {
    vi.useFakeTimers();
    const c = booted();
    const listeners = c.listenerCount("ready");
    const ps = [1, 2, 3].map((n) => rc.withRedis(async () => n, 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(c.listenerCount("ready")).toBe(listeners + 1);
    c.up();
    expect(await Promise.all(ps)).toEqual([1, 2, 3]);
    expect(c.listenerCount("ready")).toBe(listeners); // the wait's listener is removed
  });

  it("the boot wait never keeps the process alive: its timer is unref'd", async () => {
    const c = booted();
    const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timeouts();
    const p = rc.withRedis(async () => "x", "fb"); // real timers: the wait is armed synchronously
    expect(timeouts()).toBe(before);
    c.up();
    expect(await p).toBe("x");
  });

  it.each([
    ["flag on, a running server", "1", "phase-production-server", 1],
    ["flag on, next build", "1", "phase-production-build", 0],
    ["flag off", "0", "phase-production-server", 0],
  ] as const)("loading the handler module connects at boot: %s", async (_name, flag, phase, made) => {
    vi.stubEnv("NEXT_CACHE_REDIS", flag); vi.stubEnv("NEXT_PHASE", phase);
    vi.resetModules();
    await import("../../../cache-handler/handler.mjs");
    expect(FakeIORedis.made).toHaveLength(made);
  });
});
