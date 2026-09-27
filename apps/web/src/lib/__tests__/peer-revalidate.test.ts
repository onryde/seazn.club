import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The receiving side of a peer POST is the REAL route handler; only Next's
// `revalidateTag` is recorded, so "applied on the peer" is observable.
const applied = vi.hoisted(() => [] as Array<{ tag: string; profile: unknown }>);
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidateTag: (tag: string, profile: unknown) => {
    applied.push({ tag, profile });
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
// ioredis is swapped for a recorder so the REAL flag gate (`nextCacheRedis`
// reads NEXT_CACHE_REDIS and REDIS_URL) decides whether a client exists. A
// client planted with `__setRedisForTests` skips that gate, so the flag table
// below cannot use one.
const redisBuilt = vi.hoisted(() => [] as Array<{ evals: Array<{ script: string; args: unknown[] }> }>);
vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");
  class RecordingRedis extends EventEmitter {
    status = "ready";
    evals: Array<{ script: string; args: unknown[] }> = [];
    constructor() {
      super();
      redisBuilt.push(this);
    }
    async eval(script: string, _numKeys: number, ...args: unknown[]) {
      this.evals.push({ script, args });
      return 1;
    }
    disconnect() {
      this.status = "end";
    }
  }
  return { default: RecordingRedis };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/internal/revalidate/route";
import { broadcastRevalidate, publishTagState, PEER_REVALIDATE_MAX_TAGS as LIMIT } from "@/lib/peer-revalidate";
import {
  __setRedisForTests,
  __resetRedisStateForTests,
  BREAKER_FAILURES,
  FIRST_READY_WAIT_MS,
} from "../../../cache-handler/redis-client.mjs";
import { decodeField, HSET_IF_NEWER, TAGS_HASH } from "../../../cache-handler/tag-state.mjs";
import Handler, { __resetMachineStateForTests } from "../../../cache-handler/handler.mjs";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { PUSH_AFTER_DELETE_BOUND_MS } from "../cache";
import { defaultConfig } from "next/dist/server/config-shared";

afterEach(() => {
  vi.unstubAllEnvs();
  applied.length = 0;
  for (const fn of Object.values(logMock)) fn.mockClear();
});

function arm() {
  vi.stubEnv("PEER_REVALIDATE", "1");
  vi.stubEnv("FLY_APP_NAME", "seazn-club-prod");
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("FLY_PRIVATE_IP", "fdaa::3");
}

describe("broadcastRevalidate", () => {
  it("no-ops when PEER_REVALIDATE is not enabled", async () => {
    const fetchFn = vi.fn();
    await broadcastRevalidate(["division:d1"], "swr", { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs tags to every peer except itself, with the secret header", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    await broadcastRevalidate(["division:d1", "competition:c1"], "swr", {
      resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"],
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(String(url)).toBe("http://[fdaa::4]:3000/api/internal/revalidate");
    expect(init.headers["x-cron-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toEqual({ tags: ["division:d1", "competition:c1"], mode: "swr" });
  });

  it("swallows resolver and fetch failures (fail-open)", async () => {
    arm();
    await expect(
      broadcastRevalidate(["division:d1"], "swr", {
        resolveIps: async () => {
          throw new Error("dns down");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("broadcastRevalidate — more tags than one peer POST may carry", () => {
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `division:d${i}`);
  type Outcome = number | "network error";

  /** Peers whose every POST goes through the real route handler, unless
   *  `refuse` answers for that body first. Records each attempt. */
  function peers(refuse: (ip: string, tags: string[]) => Outcome | undefined = () => undefined) {
    const posts: Array<{ ip: string; tags: string[]; outcome: Outcome }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const ip = /\[(.+)\]/.exec(String(url))![1]!;
      const body = JSON.parse(String(init!.body)) as { tags: string[] };
      const refused = refuse(ip, body.tags);
      if (refused === "network error") {
        posts.push({ ip, tags: body.tags, outcome: refused });
        throw new TypeError("fetch failed");
      }
      const res =
        refused === undefined
          ? await POST(new NextRequest(String(url), init as ConstructorParameters<typeof NextRequest>[1]))
          : new Response(null, { status: refused });
      posts.push({ ip, tags: body.tags, outcome: res.status });
      return res;
    }) as typeof fetch;
    return { posts, fetchFn };
  }

  it.each([
    ["exactly the limit", LIMIT, 1, "swr", "max"],
    ["the limit plus one", LIMIT + 1, 2, "swr", "max"],
    ["twice the limit plus one", 2 * LIMIT + 1, 3, "expire", { expire: 0 }],
  ] as const)(
    "%s (%i tags) goes to every peer in %i POST(s) the route accepts, and every tag is applied there",
    async (_label, count, batches, mode, profile) => {
      arm();
      const sent = tags(count);
      const { posts, fetchFn } = peers();

      await broadcastRevalidate(sent, mode, { resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"], fetchFn });

      for (const ip of ["fdaa::4", "fdaa::5"]) {
        const mine = posts.filter((p) => p.ip === ip);
        expect(mine.map((p) => p.outcome), `${ip}: one accepted POST per batch`).toEqual(Array(batches).fill(200));
        expect(mine.flatMap((p) => p.tags).sort(), `${ip}: every tag, once`).toEqual([...sent].sort());
      }
      expect(applied.map((a) => a.tag).sort()).toEqual([...sent, ...sent].sort());
      expect(applied.every((a) => JSON.stringify(a.profile) === JSON.stringify(profile))).toBe(true);
      expect(logMock.warn).not.toHaveBeenCalled();
    },
  );

  it("failed batches — a network error, or a peer refusing one — log ONE warning per peer (batch count, first error), and every other batch is still sent and applied", async () => {
    arm();
    const sent = tags(2 * LIMIT + 1);
    const [first, second, third] = [sent.slice(0, LIMIT), sent.slice(LIMIT, 2 * LIMIT), sent.slice(2 * LIMIT)];
    const { posts, fetchFn } = peers((ip, batch) => {
      if (ip === "fdaa::4" && batch.includes(first[0]!)) return "network error";
      if (ip === "fdaa::4" && batch.includes(second[0]!)) return 503;
      if (ip === "fdaa::5" && batch.includes(second[0]!)) return "network error";
      return undefined;
    });

    await expect(
      broadcastRevalidate(sent, "swr", { resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"], fetchFn }),
    ).resolves.toBeUndefined();

    expect(posts.length, "every batch was attempted to every peer").toBe(6);
    expect(applied.map((a) => a.tag).sort()).toEqual([...third, ...first, ...third].sort());
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    expect(logMock.warn).toHaveBeenCalledWith(
      { peer: "fdaa::4", mode: "swr", failedBatches: 2, batches: 3, err: expect.any(TypeError), tags: first },
      expect.any(String),
    );
    expect(logMock.warn).toHaveBeenCalledWith(
      { peer: "fdaa::5", mode: "swr", failedBatches: 1, batches: 3, err: expect.any(TypeError), tags: second },
      expect.any(String),
    );
  });

  it("a peer refusing its only failed batch logs the refusal's status as the first error", async () => {
    arm();
    const sent = tags(LIMIT + 1);
    const { fetchFn } = peers((_ip, batch) => (batch.includes(sent[LIMIT]!) ? 503 : undefined));

    await broadcastRevalidate(sent, "expire", { resolveIps: async () => ["fdaa::4"], fetchFn });

    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn).toHaveBeenCalledWith(
      { peer: "fdaa::4", mode: "expire", failedBatches: 1, batches: 2, status: 503, tags: [sent[LIMIT]] },
      expect.any(String),
    );
  });
});

describe("publishTagState", () => {
  afterEach(() => { __resetRedisStateForTests(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  function evalRecorder() {
    const hash = new Map<string, string>();
    return { status: "ready", hash,
      eval: vi.fn(async (_s: string, _n: number, _h: string, ...argv: string[]) => {
        for (let i = 0; i < argv.length; i += 2) hash.set(argv[i], argv[i + 1]); return 1; }) };
  }

  it("expire → stale = expired = now; swr → expired = now + max profile", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1");
    const r = evalRecorder(); __setRedisForTests(r);
    await publishTagState(["division:a"], "expire", 1_000);
    await publishTagState(["competition:c"], "swr", 1_000);
    expect(decodeField(r.hash.get("division:a"))).toEqual({ at: 1_000, stale: 1_000, expired: 1_000 });
    expect(decodeField(r.hash.get("competition:c"))!.expired).toBe(1_000 + defaultConfig.cacheLife.max.expire * 1000);
  });

  it("a hung Redis resolves at the push bound, not later", async () => {
    vi.useFakeTimers(); vi.stubEnv("NEXT_CACHE_REDIS", "1");
    __setRedisForTests({ status: "ready", eval: () => new Promise(() => {}) });
    let done = false;
    void publishTagState(["division:a"], "expire").then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it("broadcastRevalidate publishes even when peer fan-out is disabled", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); vi.stubEnv("PEER_REVALIDATE", "");
    const r = evalRecorder(); __setRedisForTests(r);
    await broadcastRevalidate(["division:a"], "expire");
    expect(r.eval).toHaveBeenCalledOnce();
  });
});

/** A client that records the hash as HSET_IF_NEWER would leave it, and
 *  answers the handler's once-a-day sweep claim with "already claimed". */
function hashRecorder() {
  const hash = new Map<string, string>();
  return {
    status: "ready",
    hash,
    scripts: [] as string[],
    async eval(script: string, _n: number, _h: string, ...argv: string[]) {
      this.scripts.push(script);
      for (let i = 0; i < argv.length; i += 2) {
        const cur = decodeField(hash.get(argv[i]))?.at ?? -1;
        if (decodeField(argv[i + 1])!.at >= cur) hash.set(argv[i], argv[i + 1]);
      }
      return 1;
    },
    async set() {
      return null;
    },
  };
}

describe("publishTagState writes what the cache handler's own revalidateTag writes", () => {
  afterEach(() => {
    __resetRedisStateForTests();
    __resetMachineStateForTests();
    vi.useRealTimers();
  });

  // The durations Next hands the handler for each profile the app fires
  // (next/dist/server/revalidation-utils.js: `{ expire: cacheLife.expire }`):
  // "max" is the "swr" broadcast, `{ expire: 0 }` the "expire" one.
  it.each([
    ["swr", { expire: defaultConfig.cacheLife.max.expire }],
    ["expire", { expire: 0 }],
  ] as const)(
    "%s: the same field, byte for byte, as handler.revalidateTag(tags, %o) at the same instant — whatever the tag held before",
    async (mode, durations) => {
      const now = 1_790_000_000_000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const tags = ["division:a", "competition:c"];
      // The handler folds the tag's previous local state into its write; the
      // broadcast has none. A prior entry with both fields set shows the
      // difference cannot reach the stored value.
      tagsManifest.set("division:a", { stale: now - 5_000, expired: now + 9_000_000 });

      const viaHandler = hashRecorder();
      __setRedisForTests(viaHandler);
      await new Handler({}).revalidateTag(tags, durations);
      __resetRedisStateForTests();

      const viaBroadcast = hashRecorder();
      __setRedisForTests(viaBroadcast);
      await publishTagState(tags, mode, now);

      expect(viaHandler.scripts).toContain(HSET_IF_NEWER);
      expect(viaBroadcast.scripts).toEqual([HSET_IF_NEWER]);
      for (const tag of tags) {
        expect(viaHandler.hash.get(tag), tag).toBeDefined();
        expect(viaBroadcast.hash.get(tag), tag).toBe(viaHandler.hash.get(tag));
        expect(decodeField(viaBroadcast.hash.get(tag)), tag).toEqual(decodeField(viaHandler.hash.get(tag)));
      }
    },
  );

  it("the two modes write different states (the table above cannot pass with them swapped)", async () => {
    const swr = hashRecorder();
    __setRedisForTests(swr);
    await publishTagState(["t"], "swr", 1_000);
    const expire = hashRecorder();
    __setRedisForTests(expire);
    await publishTagState(["t"], "expire", 1_000);
    expect(decodeField(swr.hash.get("t"))).toEqual({
      at: 1_000,
      stale: 1_000,
      expired: 1_000 + defaultConfig.cacheLife.max.expire * 1000,
    });
    expect(decodeField(expire.hash.get("t"))).toEqual({ at: 1_000, stale: 1_000, expired: 1_000 });
  });

  it("an empty tag list writes nothing and resolves at once", async () => {
    const r = hashRecorder();
    __setRedisForTests(r);
    await publishTagState([], "expire", 1_000);
    expect(r.scripts).toEqual([]);
  });
});

describe("broadcastRevalidate — PEER_REVALIDATE and NEXT_CACHE_REDIS are independent", () => {
  beforeEach(() => {
    // Importing handler.mjs ran connectAtBoot with the flag off, which settled
    // the client as null; start each case from an unbuilt one.
    __resetRedisStateForTests();
    redisBuilt.length = 0;
  });
  afterEach(() => {
    __resetRedisStateForTests();
  });

  it.each([
    ["on", "on"],
    ["off", "on"],
    ["on", "off"],
    ["off", "off"],
  ] as const)("PEER_REVALIDATE %s, NEXT_CACHE_REDIS %s: each transport runs on its own flag", async (peers, redis) => {
    arm();
    if (peers === "off") vi.stubEnv("PEER_REVALIDATE", "");
    vi.stubEnv("REDIS_URL", "redis://cache.internal:6379");
    vi.stubEnv("NEXT_CACHE_REDIS", redis === "on" ? "1" : "");
    const fetchFn = vi.fn(async () => new Response("{}"));

    await broadcastRevalidate(["division:a"], "expire", { resolveIps: async () => ["fdaa::3", "fdaa::4"], fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(peers === "on" ? 1 : 0);
    const evals = redisBuilt.flatMap((c) => c.evals);
    expect(redisBuilt).toHaveLength(redis === "on" ? 1 : 0);
    expect(evals).toHaveLength(redis === "on" ? 1 : 0);
    if (redis === "on") {
      expect(evals[0]!.script).toBe(HSET_IF_NEWER);
      expect(evals[0]!.args.slice(0, 2)).toEqual([TAGS_HASH, "division:a"]);
      expect(decodeField(evals[0]!.args[2] as string)).toMatchObject({ stale: expect.any(Number) });
    }
  });
});

describe("broadcastRevalidate — a degraded Redis never holds the peers or the caller", () => {
  const peerIps = async () => ["fdaa::3", "fdaa::4"];
  afterEach(() => {
    __resetRedisStateForTests();
    vi.useRealTimers();
  });

  /** Starts a broadcast under fake timers and reports when it settled. */
  function start(fetchFn: typeof fetch) {
    const state = { done: false, err: undefined as unknown };
    void broadcastRevalidate(["division:a"], "expire", { resolveIps: peerIps, fetchFn }).then(
      () => {
        state.done = true;
      },
      (err: unknown) => {
        state.err = err;
      },
    );
    return state;
  }

  it("a Redis that never answers: the peers are POSTed at once, and the broadcast resolves at the bound", async () => {
    arm();
    vi.stubEnv("NEXT_CACHE_REDIS", "1");
    vi.useFakeTimers();
    __setRedisForTests({ status: "ready", eval: () => new Promise(() => {}) });
    const fetchFn = vi.fn(async () => new Response("{}"));

    const s = start(fetchFn as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn, "the peer POST does not wait on Redis").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PUSH_AFTER_DELETE_BOUND_MS - 1);
    expect(s.done, "still waiting on the Redis write inside the bound").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s).toEqual({ done: true, err: undefined });
  });

  it("the breaker is open: nothing is sent to Redis, the peers are POSTed, and the broadcast resolves at once", async () => {
    arm();
    vi.stubEnv("NEXT_CACHE_REDIS", "1");
    const failing = { status: "ready", eval: vi.fn(async () => Promise.reject(new Error("timeout"))) };
    __setRedisForTests(failing);
    for (let i = 0; i < BREAKER_FAILURES; i++) await publishTagState(["division:a"], "expire");
    expect(failing.eval).toHaveBeenCalledTimes(BREAKER_FAILURES);
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => new Response("{}"));

    const s = start(fetchFn as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(s).toEqual({ done: true, err: undefined });
    expect(failing.eval, "the open breaker skipped Redis").toHaveBeenCalledTimes(BREAKER_FAILURES);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("Redis unreachable since boot: one shared first-ready wait, inside the bound; the next broadcast skips at once", async () => {
    arm();
    vi.stubEnv("NEXT_CACHE_REDIS", "1");
    vi.useFakeTimers();
    const { EventEmitter } = await import("node:events");
    const down = Object.assign(new EventEmitter(), { status: "reconnecting", eval: vi.fn() });
    __setRedisForTests(down);
    const fetchFn = vi.fn(async () => new Response("{}"));

    const first = start(fetchFn as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(FIRST_READY_WAIT_MS).toBeLessThan(PUSH_AFTER_DELETE_BOUND_MS);
    await vi.advanceTimersByTimeAsync(FIRST_READY_WAIT_MS);
    expect(first).toEqual({ done: true, err: undefined });

    const second = start(fetchFn as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ done: true, err: undefined });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(down.eval).not.toHaveBeenCalled();
  });
});

describe("publishTagState — the bound's timer", () => {
  afterEach(() => {
    __resetRedisStateForTests();
    vi.useRealTimers();
  });

  it("a write that lands inside the bound leaves no timer armed behind it", async () => {
    vi.useFakeTimers();
    __setRedisForTests(hashRecorder());
    await publishTagState(["division:a"], "expire");
    expect(vi.getTimerCount()).toBe(0);
  });
});
