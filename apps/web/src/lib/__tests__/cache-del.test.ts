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

import { cacheDel } from "../cache";

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
