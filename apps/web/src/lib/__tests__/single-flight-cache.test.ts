// `cachedSingleFlight` (lib/single-flight-cache.ts) — the cache-aside a public
// document is REBUILT through when many readers miss at once.
//
// Why it exists (public hub perf T2, 2026-09-24): a score write DELs
// `pub:v1:hub:{competitionId}` and pushes to every open tab, and every tab
// refetches inside the same second. The plain cache-aside (`cachedFor`,
// usecases/public.ts) let EVERY one of those misses rebuild the document —
// ~9 + 13 x divisions queries each, through a 12-connection pool.
//
// What is pinned here, each against the in-memory lease fake (the Lua itself
// is proven on a real Redis in `cache-lease.redis.test.ts`):
//   - N concurrent misses run the builder ONCE (counted on the builder);
//   - a caller that finds a rebuild in flight gets the FRESH value when it
//     lands inside the wait, the last-known-good copy when it does not, and
//     rebuilds on its own when there is no copy — it never hangs on a lease;
//   - a rebuild that was in flight when a write deleted the key is never
//     cached: the next reader rebuilds and sees the write;
//   - a dead holder's lease expires on its own, and a failed build releases
//     its lease at once;
//   - with Redis down, every call builds directly, as the plain cache-aside
//     did.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache", async (importOriginal) => {
  const { fakeLeaseCache } = await import("./_fake-lease-cache");
  return { ...(await importOriginal<typeof import("@/lib/cache")>()), ...fakeLeaseCache.module() };
});

import { fakeLeaseCache as redis } from "./_fake-lease-cache";
import { cachedSingleFlight, type SingleFlightOptions } from "../single-flight-cache";

const KEY = "pub:v1:test-doc:c1";
const STALE_KEY = "pub:v1:test-doc-stale:c1";

interface Doc {
  version: number;
  builtBy: string;
}

/** A promise with its resolver outside — a builder parked until the test says go. */
function gate<T = void>() {
  let open!: (v: T) => void;
  const opened = new Promise<T>((r) => (open = r));
  return { opened, open };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The "database" every builder reads — a write moves it. */
let db = { version: 1 };
let builds = 0;

function opts(over: Partial<SingleFlightOptions<Doc>> & { builtBy?: string; hold?: Promise<unknown> } = {}): SingleFlightOptions<Doc> {
  const { builtBy = "caller", hold, ...rest } = over;
  return {
    key: KEY,
    ttlSeconds: 15,
    leaseMs: 5_000,
    waitMs: 1_000,
    stale: { key: STALE_KEY, ttlSeconds: 60 },
    isValid: (v) => typeof (v as Doc | null)?.version === "number",
    build: async () => {
      builds += 1;
      // The builder reads the database FIRST, then may be held — exactly the
      // order a real rebuild has: its queries ran before whatever happens next.
      const version = db.version;
      if (hold) await hold;
      return { version, builtBy };
    },
    ...rest,
  };
}

beforeEach(() => {
  redis.reset();
  db = { version: 1 };
  builds = 0;
});

describe("cachedSingleFlight — one rebuild per miss, however many readers", () => {
  it("20 concurrent misses run the builder exactly once, and all 20 get its document", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => cachedSingleFlight(opts(slowBuild(40, `r${i}`)))),
    );

    expect(builds).toBe(1);
    const builders = new Set(results.map((r) => r.builtBy));
    expect(builders.size).toBe(1);
    expect(results.every((r) => r.version === 1)).toBe(true);
    expect(redis.peek(KEY)).toEqual(results[0]);
  });

  it("a hit never runs the builder", async () => {
    redis.seed(KEY, { version: 7, builtBy: "earlier" });

    const doc = await cachedSingleFlight(opts());

    expect(doc).toEqual({ version: 7, builtBy: "earlier" });
    expect(builds).toBe(0);
    expect(redis.count("acquire")).toBe(0);
  });

  it("a successful rebuild also writes the last-known-good copy", async () => {
    const doc = await cachedSingleFlight(opts());

    expect(redis.peek(STALE_KEY)).toEqual(doc);
  });
});

describe("cachedSingleFlight — a caller that finds a rebuild in flight", () => {
  it("gets the FRESH document when the rebuild lands inside its wait — not the older copy it could have had", async () => {
    // The older copy exists and differs, so serving it would be visible.
    redis.seed(STALE_KEY, { version: 0, builtBy: "yesterday" });
    const hold = gate();
    const builder = cachedSingleFlight(opts({ builtBy: "builder", hold: hold.opened }));
    await sleep(5);
    expect(redis.isLeased(KEY)).toBe(true);

    const loser = cachedSingleFlight(opts({ builtBy: "loser", waitMs: 1_000 }));
    setTimeout(() => hold.open(), 80);

    expect(await loser).toEqual({ version: 1, builtBy: "builder" });
    expect(await builder).toEqual({ version: 1, builtBy: "builder" });
    expect(builds).toBe(1);
  });

  it("gets the last-known-good copy, without building, when the rebuild outlasts its wait", async () => {
    redis.seed(STALE_KEY, { version: 0, builtBy: "yesterday" });
    const hold = gate();
    const builder = cachedSingleFlight(opts({ builtBy: "builder", hold: hold.opened }));
    await sleep(5);

    const started = Date.now();
    const loser = await cachedSingleFlight(opts({ builtBy: "loser", waitMs: 120 }));
    const waited = Date.now() - started;

    expect(loser).toEqual({ version: 0, builtBy: "yesterday" });
    expect(builds).toBe(1); // the holder's only
    // Bounded: it gave up near its wait, it did not sit out the 5 s lease.
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(1_000);
    hold.open();
    await builder;
  });

  it("rebuilds on its own when there is no copy to fall back on — and never hangs on the held lease", async () => {
    const hold = gate();
    const builder = cachedSingleFlight(opts({ builtBy: "builder", hold: hold.opened }));
    await sleep(5);

    const loser = await cachedSingleFlight(opts({ builtBy: "loser", waitMs: 100 }));

    expect(loser).toEqual({ version: 1, builtBy: "loser" });
    expect(builds).toBe(2);
    // The loser held no lease, so it wrote nothing: the key is still the
    // holder's to fill.
    expect(redis.isLeased(KEY)).toBe(true);
    expect(redis.count("fill")).toBe(0);
    hold.open();
    await builder;
    expect(redis.peek(KEY)).toEqual({ version: 1, builtBy: "builder" });
  });

  it("never serves a last-known-good copy that fails the shape check", async () => {
    redis.seed(STALE_KEY, { shape: "from an older build" });
    const hold = gate();
    const builder = cachedSingleFlight(opts({ builtBy: "builder", hold: hold.opened }));
    await sleep(5);

    const loser = await cachedSingleFlight(opts({ builtBy: "loser", waitMs: 60 }));

    expect(loser).toEqual({ version: 1, builtBy: "loser" });
    hold.open();
    await builder;
  });

  it("with no wait (waitMs 0) builds at once and writes nothing", async () => {
    const hold = gate();
    const builder = cachedSingleFlight(opts({ builtBy: "builder", hold: hold.opened }));
    await sleep(5);

    const started = Date.now();
    const loser = await cachedSingleFlight(opts({ builtBy: "loser", waitMs: 0, stale: undefined }));

    expect(loser.builtBy).toBe("loser");
    expect(Date.now() - started).toBeLessThan(50);
    expect(redis.count("fill")).toBe(0);
    hold.open();
    await builder;
  });
});

describe("cachedSingleFlight — leases end", () => {
  it("a holder that died leaves a lease that EXPIRES, and the next caller rebuilds and caches", async () => {
    // A lease nobody will ever fill: the holder's machine went away mid-build.
    const dead = await redis.acquire(KEY, 80, "absent");
    expect(dead.kind).toBe("acquired");

    // Inside the lease: no copy, no wait — builds for itself, writes nothing.
    const during = await cachedSingleFlight(opts({ builtBy: "during", waitMs: 0, stale: undefined }));
    expect(during.builtBy).toBe("during");
    expect(redis.isLeased(KEY)).toBe(true);

    await sleep(100);
    const after = await cachedSingleFlight(opts({ builtBy: "after" }));

    expect(after.builtBy).toBe("after");
    expect(redis.peek(KEY)).toEqual(after);
  });

  it("a failed rebuild releases its lease at once: a waiting caller takes over long before the lease would expire", async () => {
    const failing = cachedSingleFlight(
      opts({
        leaseMs: 10_000,
        build: async () => {
          builds += 1;
          await sleep(30);
          throw new Error("db went away");
        },
      }),
    );
    // Settled now, so its rejection is handled while the waiter runs.
    const failed = failing.then(
      () => null,
      (err: unknown) => err,
    );
    await sleep(5);

    const started = Date.now();
    const waiter = await cachedSingleFlight(opts({ builtBy: "waiter", waitMs: 2_000, leaseMs: 10_000 }));

    expect(await failed).toEqual(new Error("db went away"));
    expect(waiter.builtBy).toBe("waiter");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(redis.peek(KEY)).toEqual(waiter);
  });
});

describe("cachedSingleFlight — a write during a rebuild", () => {
  it("after a write's DEL, the next served document reflects the write", async () => {
    const before = await cachedSingleFlight(opts());
    db = { version: 2 };
    await redis.del(KEY);

    const after = await cachedSingleFlight(opts());

    expect(before.version).toBe(1);
    expect(after.version).toBe(2);
  });

  it("a rebuild that read BEFORE a write and finishes AFTER its DEL is not cached — the next reader sees the write", async () => {
    // The race the plain cache-aside lost (hub-push-retry-ttl.test.ts names
    // it): the stale document went back under the key for its whole TTL.
    const hold = gate();
    const inFlight = cachedSingleFlight(opts({ builtBy: "pre-write", hold: hold.opened }));
    await sleep(5);

    // The write: commit, then the writer's DEL — exactly scoring's order.
    db = { version: 2 };
    await redis.del(KEY);
    hold.open();
    const own = await inFlight;

    // Its own caller asked before the write, and gets what it built…
    expect(own.version).toBe(1);
    // …but the fill was refused, so nothing pre-write sits under the key.
    expect(redis.peek(KEY)).toBeUndefined();

    const next = await cachedSingleFlight(opts({ builtBy: "post-write" }));
    expect(next.version).toBe(2);
    expect(redis.peek(KEY)).toEqual(next);
  });

  it("callers waiting on a rebuild that a write overtook get the POST-write document", async () => {
    redis.seed(STALE_KEY, { version: 0, builtBy: "yesterday" });
    const hold = gate();
    const inFlight = cachedSingleFlight(opts({ builtBy: "pre-write", hold: hold.opened }));
    await sleep(5);
    const waiter = cachedSingleFlight(opts({ builtBy: "waiter", waitMs: 1_500 }));
    await sleep(5);

    db = { version: 2 };
    await redis.del(KEY);

    // The waiter finds the key empty on its next poll, takes the lease, and
    // rebuilds after the write.
    const got = await waiter;
    hold.open();
    await inFlight;

    expect(got.version).toBe(2);
    expect(redis.peek(KEY)).toMatchObject({ version: 2 });
  });
});

describe("cachedSingleFlight — shape checks and a missing Redis", () => {
  it("an entry that fails the shape check is rebuilt and REPLACED, never served", async () => {
    redis.seed(KEY, { shape: "from an older build" });

    const doc = await cachedSingleFlight(opts({ builtBy: "rebuilt" }));

    expect(doc).toEqual({ version: 1, builtBy: "rebuilt" });
    expect(redis.peek(KEY)).toEqual(doc);
  });

  it("an entry that is not JSON at all is a miss, not a throw", async () => {
    redis.seed(KEY, "not json {");

    await expect(cachedSingleFlight(opts())).resolves.toEqual({ version: 1, builtBy: "caller" });
  });

  it("with Redis unavailable every call builds directly — the plain cache-aside's behaviour", async () => {
    redis.down = true;

    const docs = await Promise.all([1, 2, 3].map((i) => cachedSingleFlight(opts({ builtBy: `r${i}` }))));

    expect(builds).toBe(3);
    expect(docs.map((d) => d.builtBy)).toEqual(["r1", "r2", "r3"]);
  });

  it("a builder that throws on a plain miss rejects its caller with the builder's own error", async () => {
    const err = Object.assign(new Error("competition not found"), { status: 404 });

    await expect(
      cachedSingleFlight(
        opts({
          build: async () => {
            throw err;
          },
        }),
      ),
    ).rejects.toBe(err);
    expect(redis.isLeased(KEY)).toBe(false);
  });
});

/** A builder that takes `ms` — so 20 callers genuinely overlap. */
function slowBuild(ms: number, builtBy: string): Partial<SingleFlightOptions<Doc>> {
  return {
    build: async () => {
      builds += 1;
      const version = db.version;
      await sleep(ms);
      return { version, builtBy };
    },
  };
}
