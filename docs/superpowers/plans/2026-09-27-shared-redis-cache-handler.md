# Shared Redis Cache Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Redis-backed Next.js `cacheHandler` so a fresh Fly machine serves public pages from shared data (no Postgres burst) and a tag invalidated once is seen by every machine; `peer-revalidate` keeps POSTing during a dual-run (PR 1) and is deleted in PR 2.

**Architecture:** `apps/web/cache-handler/handler.mjs` replaces Next's default incremental cache. Every kind lives in a byte-bounded per-machine memory tier (L1); `unstable_cache` entries (kind `FETCH`) are also stored in Redis under a build-scoped key. Tag state lives in one Redis hash `nc:tags`, newest write wins by a stored write time, and the handler copies it into Next's own in-process `tagsManifest` before `IncrementalCache` judges freshness, so Next's `"max"` vs `{expire: 0}` semantics are unchanged. `broadcastRevalidate` writes the same tag state eagerly (bounded 1.5 s) so the realtime push still waits for it.

**Tech Stack:** Next.js 16.2.9 (standalone), Node 26, TypeScript 7, ioredis 5, vitest (node env), Playwright, Fly-managed Upstash Redis (London, pay-as-you-go, TLS off), pnpm.

**Spec:** `docs/superpowers/specs/2026-09-24-shared-redis-cache-handler-design.md` (owner-approved 2026-09-24; corrected 2026-09-27 — newest-write-wins merge, in-handler sweep, smoke reality). Read it before any task.

## Global Constraints

- Redis tier is OFF unless `NEXT_CACHE_REDIS === "1"` **and** `REDIS_URL` is set; otherwise the handler is memory-only.
- Redis client options exactly: `connectTimeout: 1000`, `commandTimeout: 150`, `maxRetriesPerRequest: 0`, `enableOfflineQueue: false`; `error` events swallowed.
- Breaker: 5 consecutive failures → skip Redis for 10 000 ms. A client whose `status !== "ready"` is skipped **without** counting a failure (boot must not trip the breaker).
- Data key `nc:{buildId}:{cacheKey}`, value JSON `{ v: 1, lastModified, value }`, `EX` = `revalidate + 3600` s, or `2_592_000` s (30 days) when `revalidate` is not a positive number.
- Values whose serialised size is over `1_048_576` bytes never go to Redis (L1 only), logged once per key per process.
- Tag hash `nc:tags`, field = tag, value = `"{at}|{json}"`, json = `{ stale?, expired? }` (epoch ms). No TTL. Written only through the `HSET_IF_NEWER` Lua script.
- Tag merge rule: **newest write wins** by `at`. Never a per-field max.
- `broadcastRevalidate` Redis write is bounded by `PUSH_AFTER_DELETE_BOUND_MS` (1500) from `apps/web/src/lib/cache.ts`.
- `"max"` duration is `defaultConfig.cacheLife.max.expire` from `next/dist/server/config-shared` — derived, never typed.
- L1 cap `NEXT_CACHE_L1_MB` MB, default 64.
- Handler files are plain ESM `.mjs` with `// @ts-check` + JSDoc: no `@/` imports, no `server-only`, no TypeScript syntax (Next loads the handler by native `import()` outside the bundle).
- All module state on `globalThis` under `Symbol.for(...)` keys (Next constructs a handler per `IncrementalCache`, roughly per request; the app bundle and the native import get two module copies).
- `/api/health` stays HTTP 200 on a Redis outage (Fly health check).
- No user-facing strings → no locale work.
- Package manager is pnpm. A fresh worktree has no `node_modules`: run `pnpm install --frozen-lockfile` in the worktree root first (see the `seazn-local-env` skill).
- Tests: always `cd <abs worktree>/apps/web &&` in the **same** shell call, JSON reporter, and confirm `.testResults[].name` shows your file. Real-Redis suites are named `*.redis.test.ts` and must be listed in `ci.yml` (enforced by `src/lib/__tests__/redis-suite-ci-wiring.test.ts`).

**Verify command template** (used by every task; `$W` = absolute worktree path, `$S` = session scratchpad):

```bash
cd $W/apps/web && rtk proxy pnpm exec vitest run <path> --reporter=json --outputFile=$S/v.json; \
  jq '{passed:.numPassedTests,total:.numTotalTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]}' $S/v.json
```

## Review Focus

1. **`"max"` then `{expire: 0}` on the same tag within one request** (`fireScoreRevalidate` ordering) — the later expiry must win on every machine; a per-field max silently turns it into stale-while-revalidate. Pinned in Task 1 (unit) and Task 5 (two processes).
2. **Machine boots while Redis is still connecting** — first requests must fall back to memory without opening the breaker, then use Redis once `ready`. Pinned in Task 2.
3. **Entry with no time TTL** (`pub-player-gate-tag`, figures outside live play) — Redis key must get the 30-day `EX`, never live forever. Pinned in Task 3.
4. **Redis hangs mid-request** — a page read must not take longer than one `commandTimeout` per Redis call and must still serve from L1. Pinned in Task 2 (breaker) and Task 3 (fallback read).
5. **Build-ID change between deploys** — a new build must not read an old build's data key, while an old build's tag invalidation still reaches the new build. Pinned in Task 3.

---

## File map

| File | Responsibility |
|---|---|
| `apps/web/cache-handler/tag-state.mjs` (new) | Pure tag-state arithmetic (mirror of `FileSystemCache.revalidateTag`), encode/decode of hash fields, newest-wins choice, `HSET_IF_NEWER` Lua source, `TAGS_HASH`. Shared by handler and `peer-revalidate.ts`. |
| `apps/web/cache-handler/redis-client.mjs` (new) | Lazy ioredis singleton on `globalThis`, `withRedis(fn, fallback)` with breaker, `cacheStatus()`, test seams. |
| `apps/web/cache-handler/handler.mjs` (new) | The `cacheHandler` class: L1, Redis data tier, tag sync into `tagsManifest`, `revalidateTag`, daily sweep. |
| `apps/web/cache-handler/__tests__/machine.mjs` (new) | Child-process "machine" used by the two-machine Redis test. |
| `apps/web/next.config.js` | `cacheHandler` + `cacheMaxMemorySize: 0`. |
| `apps/web/src/lib/peer-revalidate.ts` | `publishTagState` + dual-run in `broadcastRevalidate`. |
| `apps/web/src/app/api/health/route.ts` | `cache` field. |
| `apps/web/src/lib/__tests__/next-cache-*.test.ts` (new) | Unit suites. |
| `apps/web/src/lib/__tests__/next-cache-two-machines.redis.test.ts` (new) | Seam proof across processes. |
| `apps/web/src/server/public-site/__tests__/cold-start.redis.test.ts` (new) | SEAZN-CLUB-PROD-1 regression. |
| `apps/web/e2e/shared-cache.spec.ts` (new) + `.github/workflows/e2e.yml` job | Two prod servers, one Redis. |
| `.github/workflows/ci.yml` | Redis suites listed; smoke asserts `cache: memory`. |
| `.env.example`, `apps/web/.env.example`, `docs/ops/next-cache.md` (new) | Env + runbook. |

---

### Task 1: Tag-state arithmetic

**Files:**
- Create: `apps/web/cache-handler/tag-state.mjs`
- Test: `apps/web/src/lib/__tests__/next-cache-tag-state.test.ts`

**Interfaces:**
- Produces:
  - `TAGS_HASH: "nc:tags"`
  - `nextTagEntry(existing: {stale?: number, expired?: number}, durations: {expire?: number} | undefined, now: number): {stale?: number, expired?: number}`
  - `writeState(existing, durations, now): {stale?: number, expired?: number, at: number}`
  - `encodeField(state: {at: number, stale?: number, expired?: number}): string` → `"{at}|{json}"`
  - `decodeField(raw: string | null | undefined): {at: number, stale?: number, expired?: number} | null`
  - `newest(a, b)` → the one with the greater `at` (ties → `b`), either may be null
  - `HSET_IF_NEWER: string` (Lua; `KEYS[1]` hash, `ARGV` = field, value, field, value…)

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/next-cache-tag-state.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { defaultConfig } from "next/dist/server/config-shared";
import {
  nextTagEntry, writeState, encodeField, decodeField, newest,
} from "../../../cache-handler/tag-state.mjs";

const MAX = { expire: defaultConfig.cacheLife.max.expire };
const CASES: Array<[string, { expire?: number } | undefined]> = [
  ["max", MAX], ["expire0", { expire: 0 }], ["stats-comp", { expire: 31_536_000 }],
  ["no-durations", undefined], ["durations-without-expire", {}],
];

describe("nextTagEntry mirrors Next's FileSystemCache.revalidateTag", () => {
  beforeEach(() => tagsManifest.clear());
  for (const [name, durations] of CASES) {
    for (const existing of [{}, { stale: 1, expired: 9e15 }]) {
      it(`${name} over ${JSON.stringify(existing)}`, async () => {
        const fs = new FileSystemCache({} as ConstructorParameters<typeof FileSystemCache>[0]);
        tagsManifest.set("t", { ...existing });
        const before = Date.now();
        await fs.revalidateTag("t", durations);
        const fromNext = tagsManifest.get("t")!;
        // Next stamped `now` itself: with durations it lands in `stale`,
        // without them only `expired` is rewritten.
        const now = (durations ? fromNext.stale : fromNext.expired)!;
        expect(now).toBeGreaterThanOrEqual(before);
        expect(nextTagEntry(existing, durations, now)).toEqual(fromNext);
      });
    }
  }
});

describe("newest write wins", () => {
  it("a later {expire:0} beats an earlier 'max' even though its expired is smaller", () => {
    const max = writeState({}, MAX, 1_000);
    const exp = writeState({}, { expire: 0 }, 1_001);
    expect(max.expired!).toBeGreaterThan(exp.expired!); // the per-field-max trap
    expect(newest(max, exp)).toBe(exp);
    expect(newest(exp, max)).toBe(exp);
  });
  it("round-trips through the hash encoding and rejects garbage", () => {
    const s = writeState({}, { expire: 0 }, 42);
    expect(decodeField(encodeField(s))).toEqual(s);
    expect(decodeField("nope")).toBeNull();
    expect(decodeField("12|{bad")).toBeNull();
    expect(decodeField(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (module not found). Use the verify template with `src/lib/__tests__/next-cache-tag-state.test.ts`.

- [ ] **Step 3: Implement**

```js
// apps/web/cache-handler/tag-state.mjs
// @ts-check
/**
 * Shared tag-state arithmetic for the Redis cache handler (handler.mjs) and
 * peer-revalidate.ts. Plain ESM: Next loads the handler outside the bundle.
 * Spec: docs/superpowers/specs/2026-09-24-shared-redis-cache-handler-design.md §4, §6.
 */

export const TAGS_HASH = "nc:tags";

/**
 * Mirror of next@16.2.9 FileSystemCache.revalidateTag
 * (server/lib/incremental-cache/file-system-cache.js:53-75). A parity test
 * runs Next's own class against this, so an upgrade that changes the rule
 * turns the test red instead of drifting.
 * @param {{stale?: number, expired?: number}} existing
 * @param {{expire?: number} | undefined} durations
 * @param {number} now
 */
export function nextTagEntry(existing, durations, now) {
  if (durations) {
    const e = { ...existing, stale: now };
    if (durations.expire !== undefined) e.expired = now + durations.expire * 1000;
    return e;
  }
  return { ...existing, expired: now };
}

/**
 * @param {{stale?: number, expired?: number}} existing
 * @param {{expire?: number} | undefined} durations
 * @param {number} now
 * @returns {{stale?: number, expired?: number, at: number}}
 */
export function writeState(existing, durations, now) {
  const { stale, expired } = nextTagEntry(existing, durations, now);
  /** @type {{stale?: number, expired?: number, at: number}} */
  const s = { at: now };
  if (stale !== undefined) s.stale = stale;
  if (expired !== undefined) s.expired = expired;
  return s;
}

/** @param {{at: number, stale?: number, expired?: number}} s */
export function encodeField(s) {
  const { at, ...rest } = s;
  return `${at}|${JSON.stringify(rest)}`;
}

/** @param {string | null | undefined} raw */
export function decodeField(raw) {
  if (typeof raw !== "string") return null;
  const bar = raw.indexOf("|");
  if (bar <= 0) return null;
  const at = Number(raw.slice(0, bar));
  if (!Number.isFinite(at)) return null;
  try {
    const rest = JSON.parse(raw.slice(bar + 1));
    if (rest === null || typeof rest !== "object") return null;
    return { ...rest, at };
  } catch {
    return null;
  }
}

/**
 * Newest write wins (ties → b). Never merge per field: a "max" write's
 * year-ahead `expired` must not survive a later {expire:0}.
 * @template {{at: number}} T
 * @param {T | null} a @param {T | null} b @returns {T | null}
 */
export function newest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return b.at >= a.at ? b : a;
}

/** Sets each field only when its `at` is >= the stored one. */
export const HSET_IF_NEWER = `
for i = 1, #ARGV, 2 do
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  local curAt = cur and tonumber(string.match(cur, '^(%d+)|')) or -1
  local newAt = tonumber(string.match(ARGV[i + 1], '^(%d+)|'))
  if newAt and newAt >= curAt then redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
end
return 1`;
```

- [ ] **Step 4: Run, expect PASS** (10 parity cases + 2). Mutation check: change `newest` to `b.stale > a.stale ? b : a` → the first "newest write wins" test must go red; revert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/cache-handler/tag-state.mjs apps/web/src/lib/__tests__/next-cache-tag-state.test.ts
git commit -m "feat(cache): tag-state arithmetic mirrored from Next's FileSystemCache"
```

---

### Task 2: Redis client, breaker and status

**Files:**
- Create: `apps/web/cache-handler/redis-client.mjs`
- Test: `apps/web/src/lib/__tests__/next-cache-redis-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `nextCacheRedis(): import("ioredis").Redis | null`
  - `withRedis<T>(fn: (r: Redis) => Promise<T>, fallback: T): Promise<T>`
  - `cacheStatus(): "redis" | "memory" | "degraded"`
  - `warnOnce(key: string, msg: string, extra?: object): void`
  - Test seams: `__setRedisForTests(client: object | null): void`, `__resetRedisStateForTests(): void`
  - Constants: `BREAKER_FAILURES = 5`, `BREAKER_OPEN_MS = 10_000`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/next-cache-redis-client.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withRedis, cacheStatus, nextCacheRedis, __setRedisForTests, __resetRedisStateForTests,
  BREAKER_FAILURES, BREAKER_OPEN_MS,
} from "../../../cache-handler/redis-client.mjs";

afterEach(() => { __resetRedisStateForTests(); vi.useRealTimers(); vi.unstubAllEnvs(); });

const fake = (over: Record<string, unknown> = {}) => ({ status: "ready", ...over });

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
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found).

- [ ] **Step 3: Implement**

```js
// apps/web/cache-handler/redis-client.mjs
// @ts-check
/**
 * Redis client for the Next cache handler. Fail-open: every call has a
 * fallback. State lives on globalThis so the natively-imported handler and
 * the bundled app code (peer-revalidate, /api/health) share one client.
 */
import Redis from "ioredis";

export const BREAKER_FAILURES = 5;
export const BREAKER_OPEN_MS = 10_000;

const KEY = Symbol.for("seazn.nextCache.redis");

/** @returns {{client: any, failures: number, openUntil: number, warned: Set<string>}} */
function state() {
  const g = /** @type {any} */ (globalThis);
  return (g[KEY] ??= { client: undefined, failures: 0, openUntil: 0, warned: new Set() });
}

/** @param {string} key @param {string} msg @param {object} [extra] */
export function warnOnce(key, msg, extra = {}) {
  const s = state();
  if (s.warned.has(key)) return;
  s.warned.add(key);
  console.warn(JSON.stringify({ level: 40, name: "next-cache", msg, ...extra }));
}

export function nextCacheRedis() {
  const s = state();
  if (s.client !== undefined) return s.client;
  const url = process.env.REDIS_URL;
  if (process.env.NEXT_CACHE_REDIS !== "1" || !url) return (s.client = null);
  try {
    const client = new Redis(url, {
      connectTimeout: 1000,
      commandTimeout: 150,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    client.on("error", () => {});
    s.client = client;
  } catch {
    s.client = null; // an unparseable REDIS_URL throws synchronously
  }
  return s.client;
}

/**
 * @template T
 * @param {(r: any) => Promise<T>} fn
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function withRedis(fn, fallback) {
  const s = state();
  const r = nextCacheRedis();
  if (!r) return fallback;
  if (r.status !== "ready") return fallback; // connecting: not a failure
  const now = Date.now();
  if (now < s.openUntil) return fallback;
  try {
    const v = await fn(r);
    if (s.failures >= BREAKER_FAILURES) {
      s.warned.delete("breaker");
      console.warn(JSON.stringify({ level: 30, name: "next-cache", msg: "redis back; shared cache resumed" }));
    }
    s.failures = 0;
    s.openUntil = 0;
    return v;
  } catch (err) {
    s.failures += 1;
    if (s.failures >= BREAKER_FAILURES) {
      s.openUntil = now + BREAKER_OPEN_MS;
      warnOnce("breaker", "redis failing; serving from machine memory", { err: String(err) });
    }
    return fallback;
  }
}

/** @returns {"redis" | "memory" | "degraded"} */
export function cacheStatus() {
  const s = state();
  const r = nextCacheRedis();
  if (!r) return "memory";
  if (r.status !== "ready" || Date.now() < s.openUntil) return "degraded";
  return "redis";
}

/** @param {object | null} client */
export function __setRedisForTests(client) {
  state().client = client;
}

export function __resetRedisStateForTests() {
  const g = /** @type {any} */ (globalThis);
  const c = g[KEY]?.client;
  if (c && typeof c.disconnect === "function") c.disconnect();
  delete g[KEY];
}
```

- [ ] **Step 4: Run, expect PASS (4).** Mutation: delete the `status !== "ready"` line → the "boot" test goes red; revert.

- [ ] **Step 5: Commit**

```bash
git add apps/web/cache-handler/redis-client.mjs apps/web/src/lib/__tests__/next-cache-redis-client.test.ts
git commit -m "feat(cache): fail-open Redis client with breaker for the Next cache handler"
```

---

### Task 3: The cache handler

**Files:**
- Create: `apps/web/cache-handler/handler.mjs`
- Test: `apps/web/src/lib/__tests__/next-cache-handler.test.ts`

**Interfaces:**
- Consumes: Task 1 (`TAGS_HASH`, `writeState`, `encodeField`, `decodeField`, `HSET_IF_NEWER`), Task 2 (`withRedis`, `warnOnce`).
- Produces:
  - `default class SharedCacheHandler { constructor(ctx: {serverDistDir?: string}); get(key: string, ctx: {kind: string, tags?: string[], softTags?: string[]}): Promise<{lastModified: number, value: any} | null>; set(key: string, data: any | null, ctx: object): Promise<void>; revalidateTag(tags: string | string[], durations?: {expire?: number}): Promise<void>; resetRequestCache(): void }`
  - `__resetMachineStateForTests(): void` — clears L1, write-time map, build id, sweep stamp **and** Next's `tagsManifest` (simulates a different machine's memory).
  - Constants: `MAX_REDIS_BYTES = 1_048_576`, `NO_TTL_EX = 2_592_000`.

- [ ] **Step 1: Write the failing test** (a Map-backed fake Redis with the commands the handler uses)

```ts
// apps/web/src/lib/__tests__/next-cache-handler.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { defaultConfig } from "next/dist/server/config-shared";
import Handler, { __resetMachineStateForTests, MAX_REDIS_BYTES, NO_TTL_EX } from "../../../cache-handler/handler.mjs";
import { __setRedisForTests, __resetRedisStateForTests } from "../../../cache-handler/redis-client.mjs";
import { TAGS_HASH, decodeField } from "../../../cache-handler/tag-state.mjs";

function fakeRedis() {
  const kv = new Map<string, { v: string; ex?: number }>();
  const hash = new Map<string, string>();
  const calls: string[] = [];
  return {
    status: "ready", kv, hash, calls,
    async get(k: string) { calls.push("get"); return kv.get(k)?.v ?? null; },
    async set(k: string, v: string, ...a: unknown[]) {
      calls.push("set");
      if (a.includes("NX") && kv.has(k)) return null;
      const i = a.indexOf("EX"); kv.set(k, { v, ex: i >= 0 ? Number(a[i + 1]) : undefined }); return "OK";
    },
    async del(...k: string[]) { calls.push("del"); k.forEach((x) => kv.delete(x)); return k.length; },
    async hmget(_h: string, ...f: string[]) { calls.push("hmget"); return f.map((x) => hash.get(x) ?? null); },
    async eval(_s: string, _n: number, _h: string, ...argv: string[]) {
      calls.push("eval");
      for (let i = 0; i < argv.length; i += 2) {
        const cur = decodeField(hash.get(argv[i]))?.at ?? -1;
        if (decodeField(argv[i + 1])!.at >= cur) hash.set(argv[i], argv[i + 1]);
      }
      return 1;
    },
    async hscan() { calls.push("hscan"); return ["0", [...hash.entries()].flat()]; },
    async hdel(_h: string, ...f: string[]) { f.forEach((x) => hash.delete(x)); return f.length; },
  };
}

const MAX = { expire: defaultConfig.cacheLife.max.expire };
const fetchValue = (revalidate: number | false = 30) =>
  ({ kind: "FETCH", data: { headers: {}, body: '{"n":1}', status: 200, url: "" }, tags: ["division:d1"], revalidate });
const fetchCtx = { kind: "FETCH", tags: ["division:d1"], softTags: [] };

let redis: ReturnType<typeof fakeRedis>;
beforeEach(() => { vi.stubEnv("NEXT_CACHE_REDIS", "1"); redis = fakeRedis(); __setRedisForTests(redis); });
afterEach(() => { __resetMachineStateForTests(); __resetRedisStateForTests(); vi.unstubAllEnvs(); });

describe("SharedCacheHandler", () => {
  it("cold machine reads a FETCH entry another machine wrote", async () => {
    await new Handler({}).set("k1", fetchValue(), { fetchCache: true });
    __resetMachineStateForTests(); // now "machine B", empty memory
    const got = await new Handler({}).get("k1", fetchCtx);
    expect(got?.value).toEqual(fetchValue());
  });

  it("page kinds never go to Redis", async () => {
    await new Handler({}).set("/p", { kind: "APP_PAGE", html: "<p/>", rscData: Buffer.from("x"), headers: {} }, {});
    expect([...redis.kv.keys()]).toEqual([]);
  });

  it("TTL: revalidate+3600, and the 30-day cap for entries with no time limit", async () => {
    const h = new Handler({});
    await h.set("a", fetchValue(30), { fetchCache: true });
    await h.set("b", fetchValue(false), { fetchCache: true });
    const ex = (k: string) => [...redis.kv.entries()].find(([key]) => key.endsWith(`:${k}`))![1].ex;
    expect(ex("a")).toBe(30 + 3600);
    expect(ex("b")).toBe(NO_TTL_EX);
  });

  it("oversize values stay in memory only", async () => {
    const big = { ...fetchValue(), data: { ...fetchValue().data, body: "x".repeat(MAX_REDIS_BYTES + 1) } };
    await new Handler({}).set("big", big, { fetchCache: true });
    expect(redis.kv.size).toBe(0);
  });

  it("poisoned Redis value → miss + DEL", async () => {
    redis.kv.set("nc:dev:bad", { v: "{not json" });
    expect(await new Handler({}).get("bad", fetchCtx)).toBeNull();
    expect(redis.kv.has("nc:dev:bad")).toBe(false);
  });

  it("build id scopes data keys", async () => {
    await new Handler({}).set("k", fetchValue(), { fetchCache: true });
    expect([...redis.kv.keys()]).toEqual(["nc:dev:k"]);
  });

  it("an invalidation on A reaches B's manifest; newest write wins ('max' then expire:0)", async () => {
    const a = new Handler({});
    await a.set("k1", fetchValue(), { fetchCache: true });
    await a.revalidateTag("division:d1", MAX);
    await a.revalidateTag("division:d1", { expire: 0 });
    __resetMachineStateForTests();
    await new Handler({}).get("k1", fetchCtx);
    const m = tagsManifest.get("division:d1")!;
    expect(m.expired).toBeLessThanOrEqual(Date.now()); // expire:0 won, not the year-ahead 'max'
  });

  it("tags fetched once per request, again after resetRequestCache", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    redis.calls.length = 0;
    await h.get("k1", fetchCtx); await h.get("k1", fetchCtx);
    expect(redis.calls.filter((c) => c === "hmget")).toHaveLength(1);
    h.resetRequestCache();
    await h.get("k1", fetchCtx);
    expect(redis.calls.filter((c) => c === "hmget")).toHaveLength(2);
  });

  it("memory survives a new handler instance (Next constructs one per request)", async () => {
    await new Handler({}).set("k1", fetchValue(), { fetchCache: true });
    __setRedisForTests(null);
    expect((await new Handler({}).get("k1", fetchCtx))?.value).toEqual(fetchValue());
  });

  it("Redis failing → serves L1, still returns", async () => {
    const h = new Handler({});
    await h.set("k1", fetchValue(), { fetchCache: true });
    redis.hmget = async () => { throw new Error("timeout"); };
    expect((await h.get("k1", fetchCtx))?.value).toEqual(fetchValue());
  });

  it("clock skew: a tag stamped a few ms ahead by another machine still expires the entry once reached", async () => {
    const { areTagsExpired } = await import("next/dist/server/lib/incremental-cache/tags-manifest.external");
    const lastModified = Date.now() - 1;
    const skewed = Date.now() + 5; // the writer's clock runs 5 ms ahead
    redis.hash.set("division:skew", `${skewed}|${JSON.stringify({ stale: skewed, expired: skewed })}`);
    const h = new Handler({});
    await h.set("ks", { ...fetchValue(), tags: ["division:skew"] }, { fetchCache: true });
    h.resetRequestCache();
    await h.get("ks", { kind: "FETCH", tags: ["division:skew"], softTags: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(areTagsExpired(["division:skew"], lastModified)).toBe(true);
  });

  it("revalidateTag writes the hash through the Lua script", async () => {
    await new Handler({}).revalidateTag(["division:d1"], { expire: 0 });
    expect(decodeField(redis.hash.get("division:d1"))?.expired).toBeLessThanOrEqual(Date.now());
    expect(TAGS_HASH).toBe("nc:tags");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found).

- [ ] **Step 3: Implement**

```js
// apps/web/cache-handler/handler.mjs
// @ts-check
/**
 * Next.js incremental cache handler: per-machine memory (all kinds) + Redis
 * (unstable_cache / FETCH entries) + one shared tag-state hash copied into
 * Next's own tagsManifest before IncrementalCache judges freshness.
 * Spec: docs/superpowers/specs/2026-09-24-shared-redis-cache-handler-design.md
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external.js";
import { withRedis, warnOnce } from "./redis-client.mjs";
import { TAGS_HASH, HSET_IF_NEWER, writeState, encodeField, decodeField } from "./tag-state.mjs";

export const MAX_REDIS_BYTES = 1_048_576;
export const NO_TTL_EX = 2_592_000;
const DAY_MS = 86_400_000;
const L1_BYTES = (Number(process.env.NEXT_CACHE_L1_MB) || 64) * 1024 * 1024;
const LOCAL = Symbol.for("seazn.nextCache.local");

/**
 * @returns {{l1: Map<string, {entry: any, bytes: number}>, bytes: number,
 *   writeAt: Map<string, number>, buildId: string | undefined, sweptAt: number}}
 */
function local() {
  const g = /** @type {any} */ (globalThis);
  return (g[LOCAL] ??= { l1: new Map(), bytes: 0, writeAt: new Map(), buildId: undefined, sweptAt: 0 });
}

export function __resetMachineStateForTests() {
  delete (/** @type {any} */ (globalThis))[LOCAL];
  tagsManifest.clear();
}

/** @param {string | undefined} serverDistDir */
function buildId(serverDistDir) {
  const L = local();
  if (L.buildId) return L.buildId;
  try {
    L.buildId = serverDistDir ? readFileSync(path.join(serverDistDir, "..", "BUILD_ID"), "utf8").trim() : "dev";
  } catch {
    L.buildId = "dev";
  }
  return L.buildId;
}

/** @param {any} v */
function approxBytes(v) {
  if (!v) return 0;
  if (v.kind === "FETCH") return Buffer.byteLength(JSON.stringify(v.data ?? null));
  let n = 256;
  for (const k of ["html", "rscData", "body", "pageData", "buffer"]) {
    const x = v[k];
    if (typeof x === "string") n += Buffer.byteLength(x);
    else if (x && typeof x.length === "number") n += x.length;
    else if (x && typeof x === "object") n += Buffer.byteLength(JSON.stringify(x));
  }
  if (v.segmentData instanceof Map) for (const b of v.segmentData.values()) n += b?.length ?? 0;
  return n;
}

/** @param {string} key @param {any} entry */
function remember(key, entry) {
  const L = local();
  forget(key);
  const bytes = approxBytes(entry.value);
  L.l1.set(key, { entry, bytes });
  L.bytes += bytes;
  for (const [k, e] of L.l1) {
    if (L.bytes <= L1_BYTES) break;
    L.l1.delete(k);
    L.bytes -= e.bytes;
  }
}

/** @param {string} key */
function forget(key) {
  const L = local();
  const e = L.l1.get(key);
  if (!e) return;
  L.l1.delete(key);
  L.bytes -= e.bytes;
}

/** @param {string} raw */
function decodeData(raw) {
  try {
    const d = JSON.parse(raw);
    if (d?.v !== 1 || d.value?.kind !== "FETCH" || typeof d.lastModified !== "number") return null;
    return { lastModified: d.lastModified, value: d.value };
  } catch {
    return null;
  }
}

/** @param {string} tag @param {{at: number, stale?: number, expired?: number}} s */
function applyLocal(tag, s) {
  const L = local();
  if ((L.writeAt.get(tag) ?? -1) > s.at) return; // newest write wins
  L.writeAt.set(tag, s.at);
  /** @type {{stale?: number, expired?: number}} */
  const m = {};
  if (s.stale !== undefined) m.stale = s.stale;
  if (s.expired !== undefined) m.expired = s.expired;
  tagsManifest.set(tag, m);
}

/** @param {any} entry @param {any} ctx @returns {string[]} */
function tagsOf(entry, ctx) {
  if (ctx?.kind === "FETCH") return [...(ctx.tags ?? []), ...(ctx.softTags ?? []), ...(entry.value?.tags ?? [])];
  const header = entry.value?.headers?.["x-next-cache-tags"];
  return typeof header === "string" ? header.split(",") : [];
}

function maybeSweep() {
  const L = local();
  const now = Date.now();
  if (now - L.sweptAt < DAY_MS) return;
  L.sweptAt = now;
  void withRedis(async (r) => {
    if ((await r.set("nc:sweep", "1", "EX", 86_400, "NX")) !== "OK") return;
    const cutoff = now - 365 * DAY_MS;
    let cursor = "0";
    do {
      const [next, flat] = await r.hscan(TAGS_HASH, cursor, "COUNT", 500);
      cursor = next;
      const dead = [];
      for (let i = 0; i < flat.length; i += 2) {
        const s = decodeField(flat[i + 1]);
        if (!s || Math.max(s.at, s.stale ?? 0, s.expired ?? 0) < cutoff) dead.push(flat[i]);
      }
      if (dead.length) await r.hdel(TAGS_HASH, ...dead);
    } while (cursor !== "0");
  }, undefined);
}

export default class SharedCacheHandler {
  /** @param {{serverDistDir?: string}} ctx */
  constructor(ctx) {
    this.buildId = buildId(ctx?.serverDistDir);
    /** @type {Set<string>} tags already synced from Redis in this request */
    this.memo = new Set();
  }

  /** @param {string} key */
  dataKey(key) {
    return `nc:${this.buildId}:${key}`;
  }

  /** @param {string[]} tags */
  async syncTags(tags) {
    const missing = [...new Set(tags)].filter((t) => !this.memo.has(t));
    if (missing.length === 0) return;
    missing.forEach((t) => this.memo.add(t));
    const raw = await withRedis((r) => r.hmget(TAGS_HASH, ...missing), null);
    if (!raw) return;
    missing.forEach((tag, i) => {
      const s = decodeField(raw[i]);
      if (s) applyLocal(tag, s);
    });
  }

  /** @param {string} key @param {any} ctx */
  async get(key, ctx) {
    const L = local();
    let entry = L.l1.get(key)?.entry ?? null;
    if (entry) {
      remember(key, entry); // bump recency
    } else if (ctx?.kind === "FETCH") {
      const raw = await withRedis((r) => r.get(this.dataKey(key)), null);
      if (raw) {
        entry = decodeData(raw);
        if (entry) remember(key, entry);
        else void withRedis((r) => r.del(this.dataKey(key)), null);
      }
    }
    if (!entry) return null;
    await this.syncTags(tagsOf(entry, ctx));
    return entry;
  }

  /** @param {string} key @param {any} data @param {any} _ctx */
  async set(key, data, _ctx) {
    if (data === null) {
      forget(key);
      await withRedis((r) => r.del(this.dataKey(key)), null);
      return;
    }
    const entry = { lastModified: Date.now(), value: data };
    remember(key, entry);
    if (data.kind !== "FETCH") return;
    const raw = JSON.stringify({ v: 1, ...entry });
    const bytes = Buffer.byteLength(raw);
    if (bytes > MAX_REDIS_BYTES) {
      warnOnce(`oversize:${key}`, "next-cache entry over 1 MB kept in machine memory only", { key, bytes });
      return;
    }
    const ex = typeof data.revalidate === "number" && data.revalidate > 0 ? data.revalidate + 3600 : NO_TTL_EX;
    await withRedis((r) => r.set(this.dataKey(key), raw, "EX", ex), null);
  }

  /** @param {string | string[]} tags @param {{expire?: number}} [durations] */
  async revalidateTag(tags, durations) {
    const list = typeof tags === "string" ? [tags] : [...tags];
    if (list.length === 0) return;
    const now = Date.now();
    /** @type {string[]} */
    const argv = [];
    for (const tag of list) {
      const s = writeState(tagsManifest.get(tag) ?? {}, durations, now);
      applyLocal(tag, s);
      this.memo.add(tag);
      argv.push(tag, encodeField(s));
    }
    await withRedis((r) => r.eval(HSET_IF_NEWER, 1, TAGS_HASH, ...argv), null);
    maybeSweep();
  }

  resetRequestCache() {
    this.memo.clear();
  }
}
```

- [ ] **Step 4: Run, expect PASS (12).** Mutations, one at a time, each must turn ≥1 test red, then revert:
  1. in `applyLocal`, replace the newest-wins guard with a per-field max (`m.expired = Math.max(tagsManifest.get(tag)?.expired ?? 0, s.expired ?? 0)`) → "newest write wins" red.
  2. delete `await this.syncTags(...)` in `get` → "invalidation reaches B" red.
  3. change `NO_TTL_EX` use to `undefined` EX → TTL test red.

- [ ] **Step 5: Commit**

```bash
git add apps/web/cache-handler/handler.mjs apps/web/src/lib/__tests__/next-cache-handler.test.ts
git commit -m "feat(cache): shared Redis cacheHandler with newest-wins tag sync"
```

---

### Task 4: Wire it into Next and prove the build carries it

**Files:**
- Modify: `apps/web/next.config.js` (the `nextConfig` object, next to `output: "standalone"` at line 29)
- Test: `apps/web/src/lib/__tests__/next-cache-config.test.ts`

**Interfaces:**
- Consumes: Task 3's file path.
- Produces: `nextConfig.cacheHandler` (absolute path ending `cache-handler/handler.mjs`), `nextConfig.cacheMaxMemorySize === 0`.

- [ ] **Step 1: Failing test**

```ts
// apps/web/src/lib/__tests__/next-cache-config.test.ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { nextConfig } from "../../../next.config.js";

describe("next.config wires the shared cache handler", () => {
  it("points cacheHandler at an existing handler file and disables Next's own memory cache", () => {
    expect(nextConfig.cacheHandler).toMatch(/cache-handler\/handler\.mjs$/);
    expect(existsSync(nextConfig.cacheHandler!)).toBe(true);
    expect(nextConfig.cacheMaxMemorySize).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`cacheHandler` undefined).

- [ ] **Step 3: Implement** — in `nextConfig`, directly under `output: "standalone",`:

```js
  // Shared cache (spec 2026-09-24-shared-redis-cache-handler-design.md):
  // memory per machine + Redis for unstable_cache entries + one shared tag
  // hash. Redis tier is inert unless NEXT_CACHE_REDIS=1 and REDIS_URL is set.
  cacheHandler: path.join(import.meta.dirname, "cache-handler/handler.mjs"),
  cacheMaxMemorySize: 0,
```

- [ ] **Step 4: Run, expect PASS.** Then prove the standalone build carries the handler and ioredis (premise §10). Follow the `seazn-local-env` skill for the prod build; then:

```bash
cd $W && SKIP_TYPECHECK=1 pnpm --filter web build > $S/build.log 2>&1; echo EXIT=$?
jq -r '.config.cacheHandler, .config.cacheMaxMemorySize' apps/web/.next/required-server-files.json
ls apps/web/.next/standalone/apps/web/cache-handler/
ls -d apps/web/.next/standalone/node_modules/.pnpm/ioredis@* | head -1
```

Expected: `EXIT=0`; `cacheHandler` is a path ending `cache-handler/handler.mjs`; `0`; the directory lists `handler.mjs redis-client.mjs tag-state.mjs`; an ioredis dir exists. If the `cache-handler/` files are missing from standalone, add `"/*": [..., "cache-handler/**/*"]` to `outputFileTracingIncludes` and add a `COPY` of `apps/web/cache-handler` in the Dockerfile runner stage next to line 102, then re-run this step. Record the outcome in the commit message.

Also start the standalone server once with `NEXT_CACHE_REDIS` unset and hit a public page twice; the server log must contain no `next-cache` warning and the second hit must return 200.

- [ ] **Step 5: Commit**

```bash
git add apps/web/next.config.js apps/web/src/lib/__tests__/next-cache-config.test.ts
git commit -m "feat(cache): wire the shared cacheHandler into next.config"
```

---

### Task 5: Two machines, real Redis (the seam proof)

**Files:**
- Create: `apps/web/cache-handler/__tests__/machine.mjs`
- Create: `apps/web/src/lib/__tests__/next-cache-two-machines.redis.test.ts`
- Modify: `.github/workflows/ci.yml` (the Redis step at ~line 837 in job `smoke-db`: append this suite's path to its `npm test … run` list)

**Interfaces:**
- Consumes: Task 3 handler, real `IncrementalCache`.
- Produces: `machine.mjs` CLI: `node machine.mjs '<json ops>'` → prints one JSON line of results. Ops: `{op:"set", key, tag, body}`, `{op:"get", key, tag}` → `{found, isStale, body}`, `{op:"revalidate", tag, expire}` (`expire` omitted → `"max"` profile expiry).

- [ ] **Step 1: Write the machine script**

```js
// apps/web/cache-handler/__tests__/machine.mjs
// One "Fly machine": a fresh Node process with its own memory, the real
// IncrementalCache, and our handler. Used by next-cache-two-machines.redis.test.ts.
import { IncrementalCache } from "next/dist/server/lib/incremental-cache/index.js";
import { defaultConfig } from "next/dist/server/config-shared.js";
import Handler from "../handler.mjs";

const ops = JSON.parse(process.argv[2]);
const cache = new IncrementalCache({
  dev: false,
  requestHeaders: {},
  fetchCacheKeyPrefix: "",
  getPrerenderManifest: () => ({ version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [], preview: { previewModeId: "x" } }),
  CurCacheHandler: Handler,
});
const out = [];
for (const o of ops) {
  if (o.op === "set") {
    await cache.set(o.key, { kind: "FETCH", data: { headers: {}, body: o.body, status: 200, url: "" }, tags: [o.tag], revalidate: 300 },
      { fetchCache: true, tags: [o.tag], revalidate: 300 });
    out.push({ ok: true });
  } else if (o.op === "get") {
    const e = await cache.get(o.key, { kind: "FETCH", tags: [o.tag], softTags: [], revalidate: 300 });
    out.push({ found: !!e, isStale: e?.isStale ?? null, body: e?.value?.data?.body ?? null });
  } else if (o.op === "revalidate") {
    const expire = o.expire === undefined ? defaultConfig.cacheLife.max.expire : o.expire;
    await cache.revalidateTag([o.tag], { expire });
    out.push({ ok: true });
  }
}
console.log(JSON.stringify(out));
process.exit(0);
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/web/src/lib/__tests__/next-cache-two-machines.redis.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Redis from "ioredis";

const HAS_REDIS = !!process.env.REDIS_URL;
const MACHINE = path.resolve(__dirname, "../../../cache-handler/__tests__/machine.mjs");
const run = (ops: object[]) =>
  JSON.parse(execFileSync(process.execPath, [MACHINE, JSON.stringify(ops)], {
    env: { ...process.env, NEXT_CACHE_REDIS: "1" }, encoding: "utf8",
  }).trim().split("\n").at(-1)!);

describe.skipIf(!HAS_REDIS)("two machines share one Redis", () => {
  const tag = `division:e2e-${Date.now()}`;
  beforeAll(async () => {
    const r = new Redis(process.env.REDIS_URL!);
    await r.flushdb(); r.disconnect();
  });

  it("B (cold memory) serves what A cached", () => {
    run([{ op: "set", key: "k-share", tag, body: "v1" }]);
    expect(run([{ op: "get", key: "k-share", tag }])).toEqual([{ found: true, isStale: false, body: "v1" }]);
  });

  it("A's {expire:0} makes B return nothing", () => {
    run([{ op: "set", key: "k-exp", tag: `${tag}-x`, body: "v1" }]);
    run([{ op: "revalidate", tag: `${tag}-x`, expire: 0 }]);
    expect(run([{ op: "get", key: "k-exp", tag: `${tag}-x` }])[0].found).toBe(false);
  });

  it("A's 'max' makes B serve stale", () => {
    run([{ op: "set", key: "k-max", tag: `${tag}-m`, body: "v1" }]);
    run([{ op: "revalidate", tag: `${tag}-m` }]);
    expect(run([{ op: "get", key: "k-max", tag: `${tag}-m` }])[0]).toMatchObject({ found: true, isStale: true });
  });

  it("'max' then {expire:0} from different machines: expiry wins on a third", () => {
    run([{ op: "set", key: "k-both", tag: `${tag}-b`, body: "v1" }]);
    run([{ op: "revalidate", tag: `${tag}-b` }]);
    run([{ op: "revalidate", tag: `${tag}-b`, expire: 0 }]);
    expect(run([{ op: "get", key: "k-both", tag: `${tag}-b` }])[0].found).toBe(false);
  });
});
```

- [ ] **Step 3: Run with a local Redis, expect PASS (4).** Start one if needed: `docker run -d --rm -p 6379:6379 --name nc-redis redis:7`. Then `REDIS_URL=redis://localhost:6379` + the verify template on this file. Confirm `total: 4` (not 0 — a skip means REDIS_URL did not reach vitest).

- [ ] **Step 4: Mutations** (each must redden ≥1 case; revert each): (a) delete `await this.syncTags(...)` in `handler.mjs` `get`; (b) replace the `r.eval(...)` in `revalidateTag` with `Promise.resolve()`; (c) in `HSET_IF_NEWER`, change `>=` to `<`.

- [ ] **Step 5: CI wiring.** Append `src/lib/__tests__/next-cache-two-machines.redis.test.ts` to the `smoke-db` Redis step's path list in `.github/workflows/ci.yml`. Run `src/lib/__tests__/redis-suite-ci-wiring.test.ts` with the verify template → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/cache-handler/__tests__/machine.mjs apps/web/src/lib/__tests__/next-cache-two-machines.redis.test.ts .github/workflows/ci.yml
git commit -m "test(cache): two-process seam proof against a real Redis"
```

---

### Task 6: `broadcastRevalidate` writes shared tag state (dual-run)

**Files:**
- Modify: `apps/web/src/lib/peer-revalidate.ts` (whole `broadcastRevalidate`, lines 33–78)
- Test: `apps/web/src/lib/__tests__/peer-revalidate.test.ts` (extend), `apps/web/src/server/public-site/__tests__/revalidate.test.ts` (extend: push ordering)

**Interfaces:**
- Consumes: Task 1 (`writeState`, `encodeField`, `TAGS_HASH`, `HSET_IF_NEWER`), Task 2 (`withRedis`, `__setRedisForTests`), `PUSH_AFTER_DELETE_BOUND_MS` from `@/lib/cache`, `defaultConfig` from `next/dist/server/config-shared`.
- Produces: `publishTagState(tags: string[], mode: "swr" | "expire", now?: number): Promise<void>` (exported); `broadcastRevalidate` signature unchanged, now resolves only after both the Redis write (≤ bound) and the peer POSTs settle.

- [ ] **Step 1: Failing tests** — add to `peer-revalidate.test.ts`:

```ts
import { publishTagState, broadcastRevalidate } from "../peer-revalidate";
import { __setRedisForTests, __resetRedisStateForTests } from "../../../cache-handler/redis-client.mjs";
import { decodeField } from "../../../cache-handler/tag-state.mjs";
import { PUSH_AFTER_DELETE_BOUND_MS } from "../cache";
import { defaultConfig } from "next/dist/server/config-shared";

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
```

And in `public-site/__tests__/revalidate.test.ts` add an ordering case: with a Redis fake whose `eval` resolves only when the test releases it, call `fireScoreRevalidate("d", "c")`, pass its return value as `peersExpired` into `sendAfterDeleteOrBound(peersExpired, send)`, assert `send` has **not** run before release and **has** run right after (use `vi.useFakeTimers()` and stay under `PUSH_AFTER_DELETE_BOUND_MS`). Write it against the file's existing mock setup (read the file's top `vi.mock` blocks first and reuse them).

- [ ] **Step 2: Run both files, expect FAIL** (`publishTagState` not exported).

- [ ] **Step 3: Implement** — replace lines 33–78 of `peer-revalidate.ts` with:

```ts
/** Writes each tag's state to the shared Redis hash the cache handler reads
 *  (spec 2026-09-24 §6.1). Resolves when the write lands or at the push
 *  bound, whichever is first, and never rejects: the realtime push waits on
 *  this so a refresh landing on any machine sees the invalidation. */
export async function publishTagState(
  tags: string[],
  mode: "swr" | "expire",
  now: number = Date.now(),
): Promise<void> {
  if (tags.length === 0) return;
  const durations = mode === "expire" ? { expire: 0 } : { expire: defaultConfig.cacheLife.max.expire };
  const argv = tags.flatMap((tag) => [tag, encodeField(writeState({}, durations, now))]);
  const write = withRedis((r) => r.eval(HSET_IF_NEWER, 1, TAGS_HASH, ...argv), null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PUSH_AFTER_DELETE_BOUND_MS);
  });
  await Promise.race([write.then(() => undefined), bound]);
  clearTimeout(timer);
}

export async function broadcastRevalidate(
  tags: string[],
  mode: "swr" | "expire",
  deps: BroadcastDeps = {},
): Promise<void> {
  const published = publishTagState(tags, mode);
  await Promise.all([published, fanOutToPeers(tags, mode, deps)]);
}

/** Dual-run transport, deleted in PR 2 once the shared tag hash has soaked. */
async function fanOutToPeers(tags: string[], mode: "swr" | "expire", deps: BroadcastDeps): Promise<void> {
  // ← move the ORIGINAL body of broadcastRevalidate (old lines 38–77) here
  //   verbatim, unchanged: env gate, batching, send, toPeer, resolveIps.
}
```

Add imports at the top (below `import { log } …`):

```ts
import { defaultConfig } from "next/dist/server/config-shared";
import { PUSH_AFTER_DELETE_BOUND_MS } from "@/lib/cache";
import { withRedis } from "../../cache-handler/redis-client.mjs";
import { TAGS_HASH, HSET_IF_NEWER, encodeField, writeState } from "../../cache-handler/tag-state.mjs";
```

The comment inside `fanOutToPeers` is an instruction to you, not code to ship: paste the original body in its place and delete the comment.

- [ ] **Step 4: Run both files + `app/api/internal/revalidate/route.test.ts`, expect PASS** (all pre-existing peer tests still green). Mutation: in `broadcastRevalidate` drop `published` from the `Promise.all` → the ordering test must go red; revert. Then `cd $W/apps/web && rtk proxy pnpm exec tsc --noEmit -p . 2>&1 | tail -5` → no errors in touched files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/peer-revalidate.ts apps/web/src/lib/__tests__/peer-revalidate.test.ts apps/web/src/server/public-site/__tests__/revalidate.test.ts
git commit -m "feat(cache): broadcastRevalidate publishes shared tag state before the push (dual-run)"
```

---

### Task 7: Regression — SEAZN-CLUB-PROD-1 cold start makes no Postgres queries

**Files:**
- Create: `apps/web/src/server/public-site/__tests__/cold-start.redis.test.ts`
- Modify: `.github/workflows/ci.yml` (same Redis step: append this path)

**Interfaces:**
- Consumes: `getPublicDivision(orgSlug, compSlug, divSlug)` (`server/public-site/data.ts:893`), `getPublicCompetitionHub(orgSlug, compSlug)` (`competition-hub.ts:1073`), `statementCount()` (`lib/db.ts:22`), Task 3 handler + `__resetMachineStateForTests`, real `IncrementalCache` set as `globalThis.__incrementalCache` (unstable_cache's no-work-store path reads it, `unstable-cache.js:60`).

- [ ] **Step 1: Failing test.** Seed one org/competition/division with fixtures using the same seeding helpers the existing public-site DB tests use (open `apps/web/src/server/public-site/__tests__/` and reuse the seeding block of a `HAS_DB`-gated suite that calls `getPublicDivision`; if none calls it, reuse the org/competition/division seeding from `server/usecases/__tests__/score-revalidate-in-request.test.ts`). Then:

```ts
import { IncrementalCache } from "next/dist/server/lib/incremental-cache";
import Handler, { __resetMachineStateForTests } from "../../../../cache-handler/handler.mjs";
import { __resetRedisStateForTests } from "../../../../cache-handler/redis-client.mjs";
import { statementCount } from "@/lib/db";
import { getPublicDivision } from "../data";
import { getPublicCompetitionHub } from "../competition-hub";

const HAS = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;

function installCache() {
  (globalThis as any).__incrementalCache = new IncrementalCache({
    dev: false, requestHeaders: {}, fetchCacheKeyPrefix: "",
    getPrerenderManifest: () => ({ version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [], preview: { previewModeId: "x" } }) as any,
    CurCacheHandler: Handler as any,
  });
}
async function statementsFor(fn: () => Promise<unknown>) {
  const before = statementCount(); await fn(); return statementCount() - before;
}

describe.skipIf(!HAS)("SEAZN-CLUB-PROD-1: a cold machine with warm Redis", () => {
  // seeded: orgSlug, compSlug, divSlug (from the reused seeding block)
  const load = () => Promise.all([getPublicDivision(orgSlug, compSlug, divSlug), getPublicCompetitionHub(orgSlug, compSlug)]);

  it("serves division + hub with zero Postgres statements", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1"); installCache();
    expect(await statementsFor(load)).toBeGreaterThan(0);     // machine A warms Redis
    __resetMachineStateForTests(); installCache();             // machine B: empty memory
    expect(await statementsFor(load)).toBe(0);
  });

  it("positive pair: with the Redis tier off the cold machine queries Postgres", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", ""); __resetRedisStateForTests(); __resetMachineStateForTests(); installCache();
    await load();
    __resetMachineStateForTests(); installCache();
    expect(await statementsFor(load)).toBeGreaterThan(0);
  });
});
```

Note: `unstable_cache` writes the entry asynchronously on the no-store path; if the first assertion passes but the second sees > 0, `await new Promise((r) => setTimeout(r, 50))` after the warm load before resetting, and record that in the test with a one-line comment.

- [ ] **Step 2: Run with local Postgres (per `seazn-local-env`: `db:apply` + `sync:sports`) and Redis, expect FAIL only if Tasks 3–4 are absent; with them present expect PASS (2).** Confirm `total: 2`, not skipped.

- [ ] **Step 3: Mutation:** in `handler.mjs` `get`, make the FETCH Redis branch return `null` → the zero-statement case must go red; revert.

- [ ] **Step 4: CI wiring** — append the path to the `smoke-db` Redis step; rerun `redis-suite-ci-wiring.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/public-site/__tests__/cold-start.redis.test.ts .github/workflows/ci.yml
git commit -m "test(cache): cold machine with warm Redis makes no Postgres queries (SEAZN-CLUB-PROD-1)"
```

---

### Task 8: `/api/health` reports cache mode; smoke asserts it

**Files:**
- Modify: `apps/web/src/app/api/health/route.ts`
- Test: `apps/web/src/app/api/health/route.test.ts` (create)
- Modify: `.github/workflows/ci.yml` job `smoke-e2e`, right after the health poll at ~line 1407

- [ ] **Step 1: Failing test**

```ts
// apps/web/src/app/api/health/route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => [{ "?column?": 1 }]) }));
import { GET } from "./route";
import { __setRedisForTests, __resetRedisStateForTests } from "../../../../cache-handler/redis-client.mjs";

afterEach(() => { __resetRedisStateForTests(); vi.unstubAllEnvs(); });

describe("/api/health cache field", () => {
  it("memory when the Redis tier is off", async () => {
    expect(await (await GET()).json()).toEqual({ ok: true, db: "up", cache: "memory" });
  });
  it("degraded is still HTTP 200", async () => {
    vi.stubEnv("NEXT_CACHE_REDIS", "1");
    __setRedisForTests({ status: "reconnecting" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).cache).toBe("degraded");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (no `cache` field).

- [ ] **Step 3: Implement**

```ts
import { sql } from "@/lib/db";
import { cacheStatus } from "../../../../cache-handler/redis-client.mjs";

export async function GET() {
  const cache = cacheStatus();
  try {
    await sql`select 1`;
    return Response.json({ ok: true, db: "up", cache });
  } catch {
    return Response.json({ ok: false, db: "down", cache }, { status: 503 });
  }
}
```

- [ ] **Step 4: Run, expect PASS (2).** Add to `smoke-e2e` after the server-up poll:

```yaml
      - name: Health reports the cache mode (no Redis in this job → memory)
        run: |
          body=$(curl -sf http://localhost:3000/api/health)
          echo "$body"
          test "$(echo "$body" | jq -r .cache)" = "memory"
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/health/route.ts apps/web/src/app/api/health/route.test.ts .github/workflows/ci.yml
git commit -m "feat(health): report cache mode (redis|memory|degraded), always 200 on Redis faults"
```

---

### Task 9: E2E — two prod servers, one Redis

**Files:**
- Create: `apps/web/e2e/shared-cache.spec.ts`
- Modify: `.github/workflows/e2e.yml` — new job `e2e-shared-cache`

**Interfaces:**
- Consumes: the whole stack. Server A on `:3000` (`PLAYWRIGHT_BASE`), server B on `:3001` (`SHARED_CACHE_PEER_BASE`), both with `NEXT_CACHE_REDIS=1`, `REDIS_URL=redis://localhost:6379`, `PEER_REVALIDATE` unset (so only Redis can carry the invalidation — the dual-run POST is deliberately off here).

- [ ] **Step 1: Write the spec.** Seed and score exactly as `apps/web/e2e/hub-knockout.spec.ts` does (reuse its `beforeAll` seeding and its score-submission helper calls verbatim; they post through server A). Then:

```ts
// apps/web/e2e/shared-cache.spec.ts
import { test, expect } from "@playwright/test";
const B = process.env.SHARED_CACHE_PEER_BASE;
test.skip(!B, "needs a second server sharing Redis (SHARED_CACHE_PEER_BASE)");

test("a score saved on A shows on B's division page without waiting for the 30 s window", async ({ page, request }) => {
  // 1. seed org/competition/division/fixture (copied from hub-knockout.spec.ts beforeAll)
  // 2. warm B: open the public division page on B and read the fixture's score cell
  await page.goto(`${B}${divisionPath}`);
  await expect(page.getByTestId(scoreCellTestId)).toHaveText(scoreBefore);
  // 3. save a score through A (same API call hub-knockout.spec.ts uses)
  // 4. B reflects it well inside the 30 s REVALIDATE_FAST window
  await expect.poll(async () => {
    await page.goto(`${B}${divisionPath}`);
    return page.getByTestId(scoreCellTestId).textContent();
  }, { timeout: 10_000, intervals: [500] }).toBe(scoreAfter);
  // 5. health on both says redis
  for (const base of [process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000", B!]) {
    expect((await (await request.get(`${base}/api/health`)).json()).cache).toBe("redis");
  }
});
```

Fill `divisionPath`, `scoreCellTestId`, `scoreBefore`, `scoreAfter` from what `hub-knockout.spec.ts` seeds and asserts; `git grep -n "getByTestId" apps/web/e2e/hub-knockout.spec.ts` lists the testids it already relies on.

- [ ] **Step 2: Negative pair.** Run once locally with server B started **without** `NEXT_CACHE_REDIS` (memory only, no peer POST): the poll must time out (B serves its stale page for 30 s). Record the failing output in the task notes; this is what proves the test can see the defect.

- [ ] **Step 3: Positive run locally.** Build once (Task 4 command). Start Redis (`docker run -d --rm -p 6379:6379 redis:7`). Start A and B:

```bash
cd $W && (NEXT_CACHE_REDIS=1 REDIS_URL=redis://localhost:6379 PORT=3000 node apps/web/.next/standalone/apps/web/server.js > $S/a.log 2>&1; echo EXIT=$? >> $S/a.log) &
cd $W && (NEXT_CACHE_REDIS=1 REDIS_URL=redis://localhost:6379 PORT=3001 node apps/web/.next/standalone/apps/web/server.js > $S/b.log 2>&1; echo EXIT=$? >> $S/b.log) &
cd $W/apps/web && E2E_PROD_TARGET=1 PLAYWRIGHT_BASE=http://localhost:3000 SHARED_CACHE_PEER_BASE=http://localhost:3001 \
  pnpm exec playwright test e2e/shared-cache.spec.ts --reporter=line
```

Use `localhost`, never `127.0.0.1`, for `PLAYWRIGHT_BASE`. Expected: 1 passed.

- [ ] **Step 4: CI job.** In `e2e.yml`, add `e2e-shared-cache` by copying the `e2e-serial` job (its build, DB and server-start steps) and changing: add a `services.redis` block identical to `ci.yml`'s `smoke-db` Redis service; set `NEXT_CACHE_REDIS: "1"` and `REDIS_URL: redis://localhost:6379` on both server-start steps; start a second server on `PORT=3001`; run only `e2e/shared-cache.spec.ts` with `SHARED_CACHE_PEER_BASE: http://localhost:3001`. Read the file first — the trigger and job layout have changed several times (AGENTS.md).

- [ ] **Step 5: Dispatch it on the branch** after pushing: `gh workflow run e2e.yml --ref <branch> -f pr=<n>`; wait for the run; a `cancelled` status is not a pass (a push to `main` cancels dispatched e2e).

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/shared-cache.spec.ts .github/workflows/e2e.yml
git commit -m "test(e2e): score on one server is visible on another through the shared cache"
```

---

### Task 10: Measure entry sizes, document env and runbook

**Files:**
- Create: `docs/ops/next-cache.md`
- Modify: `.env.example`, `apps/web/.env.example` (next to the existing `REDIS_URL` / `PEER_REVALIDATE` entries)

- [ ] **Step 1: Measure.** With the Task 9 two-server setup running and one realistic competition seeded (≥ 8 divisions, ≥ 40 fixtures, a player with matches in several divisions), open the hub, a division, a fixture and a player card on server A, then:

```bash
redis-cli --scan --pattern 'nc:*' | while read k; do echo "$(redis-cli strlen "$k") $k"; done | sort -n | tail -10
```

Record the top 10 sizes in `docs/ops/next-cache.md`. If any key other than a figures/overlay entry exceeds 256 KB, stop and report it to the controller before continuing (spec §10 open premise).

- [ ] **Step 2: Env docs** — add under the Redis block of both `.env.example` files:

```
# Shared Next cache (spec 2026-09-24-shared-redis-cache-handler-design.md).
# "1" turns on the Redis tier of apps/web/cache-handler; unset = memory only.
NEXT_CACHE_REDIS=
# Per-machine memory cap for the Next cache, in MB (default 64).
NEXT_CACHE_L1_MB=
```

- [ ] **Step 3: Runbook** `docs/ops/next-cache.md` with: what the three tiers are; the env vars; `/api/health` `cache` values and what `degraded` means (serving from memory, staleness ≤ 30 s / 300 s); how to inspect (`redis-cli hget nc:tags division:<id>`, the `nc:{buildId}:*` keys); how to roll back (unset `NEXT_CACHE_REDIS`, `fly secrets unset`, restart); the measured sizes from Step 1; the Upstash plan facts from spec §5.

- [ ] **Step 4: Commit**

```bash
git add docs/ops/next-cache.md .env.example apps/web/.env.example
git commit -m "docs(cache): runbook, env vars, measured entry sizes"
```

---

### Task 11: Branch gate, PR, and staged rollout (controller + owner)

- [ ] **Step 1: Full gate on the branch** (the controller runs it, never trusts a subagent's summary): `tsc`, `rtk proxy pnpm lint` (read `✖ N problems`), the whole `apps/web` vitest with JSON reporter (counts pasted), the Redis suites with `REDIS_URL` set, and the Task 9 e2e run.
- [ ] **Step 2: Final whole-branch review** by the `reviewer` agent against the spec; fix findings; re-run Step 1.
- [ ] **Step 3: Open PR 1** (`Fixes SEAZN-CLUB-PROD-1` is NOT used — the issue is already resolved; reference it by URL). Smoke CI runs on the PR; e2e only via dispatch (Task 9 Step 5).
- [ ] **Step 4: Staging (owner runs):** `fly secrets set NEXT_CACHE_REDIS=1 -a seazn-club-stg`; `curl -s https://stg.seazn.club/api/health | jq .cache` → `"redis"`; restart one machine and confirm the Postgres connection peak stays flat (`pg_stat_activity` count during the first page loads); score a fixture and confirm a second machine's page shows it within a few seconds; watch the Upstash command count for a day.
- [ ] **Step 5: Production (owner runs):** same as Step 4 on `seazn-club-prod`; soak one week with `PEER_REVALIDATE` still on.

---

## PR 2 — retire peer-revalidate (after the prod soak)

Plan in detail when PR 1 has soaked; the tasks are:

1. Delete `fanOutToPeers`, `flyPeerIps`, `BroadcastDeps`, `PEER_REVALIDATE_MAX_TAGS` from `peer-revalidate.ts`; `broadcastRevalidate(tags, mode)` becomes `publishTagState(tags, mode)`. Update `peer-revalidate.test.ts`.
2. Delete `apps/web/src/app/api/internal/revalidate/route.ts` and `route.test.ts`; grep the tree (`git grep -n "internal/revalidate"`) for any other reference.
3. Remove `PEER_REVALIDATE` from both `.env.example` files and `fly secrets unset PEER_REVALIDATE` on stg and prod (owner).
4. Correct `fly.toml` comment lines 23–27 ("peers stay ISR-coherent via /api/internal/revalidate", "Ceiling is 3 machines") to describe the shared tag hash and the connection budget (`machines × DB_POOL_MAX + ~10 ≤ 57`).
5. Re-run Task 5, Task 7 and Task 9 suites — they must stay green with no peer POSTs at all.
