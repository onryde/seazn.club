// R10 H4: `cacheDel`, the literal-key delete.
//
// `invalidatePublicCache` (usecases/scoring.ts) used to drop
// `pub:v1:fixture:{id}` and `pub:v1:hub:{competitionId}` with
// `cacheDelPattern`. That is a SCAN over the whole keyspace (COUNT 100) for two
// keys whose names are already known. The realtime pushes wait on those two
// deletes, so every score's push waited on two full-keyspace walks.
//
// ioredis is replaced with a recording fake, so this pins which Redis command
// is sent and how failures are handled. It does not measure latency.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => ({
  constructed: 0,
  del: vi.fn(async (...keys: string[]) => keys.length),
  scanStream: vi.fn(),
  pipeline: vi.fn(),
}));

vi.mock("ioredis", () => ({
  default: class FakeRedis {
    constructor() {
      redis.constructed += 1;
    }
    on() {
      return this;
    }
    del(...keys: string[]) {
      return redis.del(...keys);
    }
    scanStream(...args: unknown[]) {
      return redis.scanStream(...args);
    }
    pipeline(...args: unknown[]) {
      return redis.pipeline(...args);
    }
  },
}));

import { PUSH_AFTER_DELETE_BOUND_MS, cacheDel, sendAfterDeleteOrBound } from "../cache";

// `client()` memoises the connection on this global, so each test starts from
// "never connected" and states its own REDIS_URL.
const memo = globalThis as { _redis?: unknown };
const REDIS_URL = process.env.REDIS_URL;

beforeEach(() => {
  memo._redis = undefined;
  redis.constructed = 0;
  redis.del.mockReset();
  redis.scanStream.mockReset();
  redis.pipeline.mockReset();
});

afterEach(() => {
  memo._redis = undefined;
  if (REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = REDIS_URL;
});

describe("cacheDel", () => {
  it("sends ONE direct DEL carrying every key, and never a SCAN", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    redis.del.mockResolvedValue(2);

    await cacheDel("pub:v1:fixture:f1", "pub:v1:hub:c1");

    expect(redis.del.mock.calls).toEqual([["pub:v1:fixture:f1", "pub:v1:hub:c1"]]);
    expect(redis.scanStream).not.toHaveBeenCalled();
    expect(redis.pipeline).not.toHaveBeenCalled();
  });

  it("fails open: a DEL that rejects resolves, like its siblings", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    redis.del.mockRejectedValue(new Error("Connection is closed."));

    await expect(cacheDel("pub:v1:hub:c1")).resolves.toBeUndefined();
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it("with no REDIS_URL it resolves without constructing a client", async () => {
    delete process.env.REDIS_URL;

    await expect(cacheDel("pub:v1:hub:c1")).resolves.toBeUndefined();
    expect(redis.constructed).toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });

  // A bare `DEL` with no key is a Redis arity error. Failing open would hide
  // it, but it would still be a wasted round trip.
  it("with no keys it sends nothing", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";

    await cacheDel();

    expect(redis.del).not.toHaveBeenCalled();
  });
});

// R10d n1 — `sendAfterDeleteOrBound` is exported beside `cacheDel`, and a
// caller can hand it a bare `cacheDel(key)`. That promise CAN reject: `client()`
// sits outside `cacheDel`'s try, and ioredis throws synchronously on a
// REDIS_URL it cannot parse. The helper must then still send once and leave
// nothing rejected behind it: `.finally` passes the rejection on to a promise
// nobody holds, which Node reports as an unhandled rejection (and, outside
// Next's server, throws on).
describe("sendAfterDeleteOrBound — a delete that REJECTS", () => {
  const macrotask = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

  it("sends exactly once and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // A plain rejected promise, never a `vi.fn`'s return value: a spy attaches
      // its own handlers to what it returns, which would mark this HANDLED.
      const failure = new Error("Invalid URL");
      let sends = 0;
      sendAfterDeleteOrBound(Promise.reject(failure), () => {
        sends += 1;
      });

      // Node reports an unhandled rejection once the microtask queue drains.
      await macrotask();
      expect(unhandled, "the helper left a rejected promise with no handler").toEqual([]);
      expect(sends, "a rejected delete must still send, at once").toBe(1);

      // The bound's timer was cleared by that send: nothing more, ever.
      await macrotask(PUSH_AFTER_DELETE_BOUND_MS + 100);
      expect(sends, "the bound sent a second time").toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the resolving twin: sends exactly once, at once", async () => {
    let sends = 0;
    sendAfterDeleteOrBound(Promise.resolve(), () => {
      sends += 1;
    });
    await macrotask();
    expect(sends).toBe(1);
    await macrotask(PUSH_AFTER_DELETE_BOUND_MS + 100);
    expect(sends).toBe(1);
  });
});
