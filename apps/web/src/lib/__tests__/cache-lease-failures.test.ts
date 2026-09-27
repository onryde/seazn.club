// Public hub perf T2 review: a lease call that THROWS is logged — throttled —
// where a lease call that answers "no" is not.
//
// Every lease primitive fails open (lib/cache.ts): a thrown GET reads as
// `unavailable`, a thrown fill as "not landed". That is right for a blip and
// silent for a systematic failure: a provider that rejected the two-key EVAL,
// or a key of the wrong TYPE (WRONGTYPE on every GET), would quietly turn every
// hub poll into a 1.5 s wait and a rebuild, with nothing in the logs. So a
// throw is logged, at most once per interval per operation (a stampede of
// polls against a dead Redis must not become a stampede of log lines), and a
// normal refusal — a fill whose lease a write deleted, a GET that finds
// nothing — logs nothing.
//
// ioredis is replaced with a fake whose commands this file scripts; the real
// Lua and TTLs are pinned against a real Redis in cache-lease.redis.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({
  get: vi.fn(async (key: string): Promise<string | null> => {
    void key;
    return null;
  }),
  set: vi.fn(async (...args: unknown[]): Promise<string | null> => {
    void args;
    return "OK";
  }),
  eval: vi.fn(async (...args: unknown[]): Promise<unknown> => {
    void args;
    return 1;
  }),
}));
vi.mock("ioredis", () => ({
  default: class FakeRedis {
    on() {
      return this;
    }
    get(key: string) {
      return redis.get(key);
    }
    set(...args: unknown[]) {
      return redis.set(...args);
    }
    eval(...args: unknown[]) {
      return redis.eval(...args);
    }
  },
}));
const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));
vi.mock("@/server/logger", () => ({ log: logMock }));

import {
  LEASE_FAILURE_LOG_INTERVAL_MS,
  __resetLeaseFailureLogForTests,
  cacheLeaseAcquire,
  cacheLeaseFill,
  cacheLeaseRelease,
  cacheReadRaw,
} from "../cache";

const memo = globalThis as { _redis?: unknown };
const REDIS_URL = process.env.REDIS_URL;
const WRONGTYPE = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");

/** The ops the logger was told about, in order. */
const warnedOps = () => logMock.warn.mock.calls.map((c) => (c[0] as { op: string }).op);

beforeEach(() => {
  memo._redis = undefined;
  process.env.REDIS_URL = "redis://localhost:6379";
  vi.clearAllMocks();
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue("OK");
  redis.eval.mockResolvedValue(1);
  __resetLeaseFailureLogForTests();
});

afterEach(() => {
  vi.useRealTimers();
  memo._redis = undefined;
  if (REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = REDIS_URL;
});

describe("a lease call that throws is logged", () => {
  it("a GET that throws reads as unavailable AND says so", async () => {
    redis.get.mockRejectedValue(WRONGTYPE);

    expect(await cacheReadRaw("pub:v1:hub:c1")).toEqual({ kind: "unavailable" });
    expect(warnedOps()).toEqual(["read"]);
    expect(logMock.warn.mock.calls[0]![0]).toMatchObject({ op: "read", key: "pub:v1:hub:c1", err: WRONGTYPE.message });
  });

  it("a fill whose EVAL throws is 'not landed' AND says so", async () => {
    redis.eval.mockRejectedValue(new Error("ERR unknown command 'eval'"));

    expect(await cacheLeaseFill("pub:v1:hub:c1", "t", { v: 1 }, 15, { key: "pub:v1:hub-stale:c1", ttlSeconds: 60 })).toBe(false);
    expect(warnedOps()).toEqual(["fill"]);
  });

  it("an acquire whose SET throws, and a release whose EVAL throws, each say so", async () => {
    redis.set.mockRejectedValue(new Error("Connection is closed."));
    redis.eval.mockRejectedValue(new Error("Connection is closed."));

    expect(await cacheLeaseAcquire("pub:v1:hub:c1", 8_000, "absent")).toEqual({ kind: "unavailable" });
    await expect(cacheLeaseRelease("pub:v1:hub:c1", "t")).resolves.toBeUndefined();
    expect(warnedOps()).toEqual(["acquire", "release"]);
  });
});

describe("throttled, per operation", () => {
  it("a systematic failure logs once per interval per operation, then again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    redis.get.mockRejectedValue(WRONGTYPE);
    redis.eval.mockRejectedValue(WRONGTYPE);

    for (let i = 0; i < 20; i++) await cacheReadRaw(`pub:v1:hub:c${i}`);
    await cacheLeaseFill("pub:v1:hub:c1", "t", { v: 1 }, 15);
    expect(warnedOps(), "twenty failing GETs, one line — and the fill has its own").toEqual(["read", "fill"]);

    vi.setSystemTime(Date.now() + LEASE_FAILURE_LOG_INTERVAL_MS - 1);
    await cacheReadRaw("pub:v1:hub:c1");
    expect(warnedOps()).toEqual(["read", "fill"]);

    vi.setSystemTime(Date.now() + 1);
    await cacheReadRaw("pub:v1:hub:c1");
    expect(warnedOps()).toEqual(["read", "fill", "read"]);
  });
});

describe("a normal answer is not a failure", () => {
  it("a fill refused because the lease is gone, a GET that finds nothing, a lease already held: nothing is logged", async () => {
    redis.eval.mockResolvedValue(0);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(null);

    expect(await cacheLeaseFill("pub:v1:hub:c1", "t", { v: 1 }, 15)).toBe(false);
    expect(await cacheReadRaw("pub:v1:hub:c1")).toEqual({ kind: "absent" });
    expect(await cacheLeaseAcquire("pub:v1:hub:c1", 8_000, "absent")).toEqual({ kind: "held" });
    await cacheLeaseRelease("pub:v1:hub:c1", "t");
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("Redis not configured at all is not a failure either", async () => {
    delete process.env.REDIS_URL;

    expect(await cacheReadRaw("pub:v1:hub:c1")).toEqual({ kind: "unavailable" });
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});
