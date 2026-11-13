// An unreachable or silent Redis still answers within the connect wait.
//
// A command issued while the connection is still being established waits for
// it, up to REDIS_CONNECT_WAIT_MS (lib/cache.ts), instead of failing on the
// spot — so the first command after a cold start lands
// (cache-cold-start.redis.test.ts). That wait must stay a BOUND, because the
// client deliberately keeps `enableOfflineQueue: false` so a Redis outage
// fails fast instead of hanging requests. This file pins both outage shapes
// with no Redis at all, so it runs in every job:
//
//  - refused: nothing listens. The attempt fails at once, and the wait ends
//    with it: nobody sits out the bound for a Redis that has already said no.
//  - silent: a server that accepts the TCP connection and never answers (a
//    hung Redis, a black-holed proxy). The connection never becomes ready, so
//    the first commands sit out the bound ONCE; after that Redis reads as down
//    and every command fails at once, until a connection is ready again.
//
// Either way every helper falls back exactly as before: reads miss, writes
// no-op, leases read unavailable, and the limiter applies its policy — a
// fail-open limit allows, a fail-closed one answers 429.
import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import net from "node:net";
import type Redis from "ioredis";
import {
  REDIS_CONNECT_WAIT_MS,
  cacheDel,
  cacheDelPattern,
  cacheGet,
  cacheLeaseAcquire,
  cacheLeaseFill,
  cacheLeaseRelease,
  cacheReadRaw,
  cacheSet,
  incrWindow,
} from "@/lib/cache";
import { AUTH_LIMIT, EMAIL_LIMIT, MUTATION_LIMIT, rateLimit } from "@/lib/rate-limit";
import { HttpError } from "@/lib/errors";

const memo = globalThis as unknown as { _redis?: Redis | null };
const REDIS_URL = process.env.REDIS_URL;

/** Headroom for a loaded runner on top of the bound. */
const SLACK_MS = 1_000;
/** "At once": well inside the bound, so a call that sat the wait out cannot pass for one that did not. */
const AT_ONCE_MS = REDIS_CONNECT_WAIT_MS / 2;

function forgetClient(): void {
  const c = memo._redis;
  memo._redis = undefined;
  c?.disconnect();
}

type Outcome = { value: unknown } | { error: unknown };

interface FallbackCase {
  name: string;
  call(key: string): Promise<unknown>;
  /** What the call must settle to while Redis is unreachable. */
  expectFallback(outcome: Outcome): void;
}

const resolvesTo = (expected: unknown) => (outcome: Outcome) => {
  expect(outcome).toEqual({ value: expected });
};
const refusesWith429 = (outcome: Outcome) => {
  expect("error" in outcome).toBe(true);
  const err = (outcome as { error: unknown }).error;
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(429);
};

const CASES: FallbackCase[] = [
  { name: "cacheGet", call: (k) => cacheGet(k), expectFallback: resolvesTo(null) },
  { name: "cacheSet", call: (k) => cacheSet(k, { v: 1 }, 60), expectFallback: resolvesTo(undefined) },
  { name: "cacheDel", call: (k) => cacheDel(k), expectFallback: resolvesTo(undefined) },
  { name: "cacheDelPattern", call: (k) => cacheDelPattern(`${k}:*`), expectFallback: resolvesTo(undefined) },
  { name: "cacheReadRaw", call: (k) => cacheReadRaw(k), expectFallback: resolvesTo({ kind: "unavailable" }) },
  {
    name: "cacheLeaseAcquire",
    call: (k) => cacheLeaseAcquire(k, 5_000, "absent"),
    expectFallback: resolvesTo({ kind: "unavailable" }),
  },
  { name: "cacheLeaseFill", call: (k) => cacheLeaseFill(k, "t", { v: 1 }, 60), expectFallback: resolvesTo(false) },
  { name: "cacheLeaseRelease", call: (k) => cacheLeaseRelease(k, "t"), expectFallback: resolvesTo(undefined) },
  { name: "incrWindow", call: (k) => incrWindow(k, 60), expectFallback: resolvesTo(null) },
  { name: "rateLimit fail-open (MUTATION_LIMIT)", call: (k) => rateLimit(k, MUTATION_LIMIT), expectFallback: resolvesTo(undefined) },
  { name: "rateLimit fail-closed (EMAIL_LIMIT)", call: (k) => rateLimit(k, EMAIL_LIMIT), expectFallback: refusesWith429 },
  { name: "rateLimit fail-closed (AUTH_LIMIT)", call: (k) => rateLimit(k, AUTH_LIMIT), expectFallback: refusesWith429 },
];

/**
 * Run every case at once and time each. A case still pending past the bound
 * plus slack is reported as hung rather than left to the suite timeout.
 */
async function runAll(round: string): Promise<{ name: string; ms: number; outcome: Outcome | "hung" }[]> {
  const ceiling = REDIS_CONNECT_WAIT_MS + SLACK_MS;
  return Promise.all(
    CASES.map(async (c, i) => {
      const started = performance.now();
      const settled: Promise<Outcome> = c.call(`test:unreachable:${round}:${i}`).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<"hung">((r) => {
        timer = setTimeout(() => r("hung"), ceiling);
      });
      const outcome = await Promise.race([settled, hung]);
      clearTimeout(timer);
      return { name: c.name, ms: performance.now() - started, outcome };
    }),
  );
}

function expectFallbacks(results: Awaited<ReturnType<typeof runAll>>): void {
  expect(results.filter((r) => r.outcome === "hung").map((r) => r.name)).toEqual([]);
  for (const [i, r] of results.entries()) {
    try {
      CASES[i]!.expectFallback(r.outcome as Outcome);
    } catch (err) {
      throw new Error(`${r.name}: wrong fallback — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  expect(results).toHaveLength(CASES.length);
  expect(results.length).toBe(12);
}

const slowerThan = (results: Awaited<ReturnType<typeof runAll>>, ms: number) =>
  results.filter((r) => r.ms >= ms).map((r) => `${r.name} ${Math.round(r.ms)}ms`);

describe("an unreachable Redis fails within the connect wait", () => {
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();

  afterEach(async () => {
    forgetClient();
    for (const s of sockets) s.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    if (REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = REDIS_URL;
  });

  /** A port nothing listens on: bound once, then released. */
  async function refusedPort(): Promise<number> {
    const s = net.createServer();
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    const port = (s.address() as net.AddressInfo).port;
    s.close();
    await once(s, "close");
    return port;
  }

  /** A server that accepts connections and never says a word. */
  async function silentServer(): Promise<number> {
    const s = net.createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {});
    });
    servers.push(s);
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    return (s.address() as net.AddressInfo).port;
  }

  it("refused: every helper falls back at once, on the first call and every call after", async () => {
    process.env.REDIS_URL = `redis://127.0.0.1:${await refusedPort()}`;
    forgetClient();

    const first = await runAll("refused-1");
    expectFallbacks(first);
    expect(slowerThan(first, AT_ONCE_MS)).toEqual([]);
    expect(memo._redis?.status).not.toBe("ready");

    const second = await runAll("refused-2");
    expectFallbacks(second);
    expect(slowerThan(second, AT_ONCE_MS)).toEqual([]);
  });

  it("silent: the first calls wait out the bound once — never longer — and every call after falls back at once", async () => {
    process.env.REDIS_URL = `redis://127.0.0.1:${await silentServer()}`;
    forgetClient();

    const first = await runAll("silent-1");
    expectFallbacks(first);
    // The connection was accepted and never became ready: this is the waiting path, not a refusal.
    expect(sockets.size).toBeGreaterThan(0);
    expect(memo._redis?.status).toBe("connect");
    // Each sat out the wait (the timer, not an event, released it) and none hung past it.
    expect(first.filter((r) => r.ms < REDIS_CONNECT_WAIT_MS - 50).map((r) => r.name)).toEqual([]);

    const second = await runAll("silent-2");
    expectFallbacks(second);
    expect(slowerThan(second, AT_ONCE_MS)).toEqual([]);
  });
});
