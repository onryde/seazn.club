# Shared Redis cache handler — design

**Status:** draft for owner review, 2026-09-24
**Trigger:** Sentry SEAZN-CLUB-PROD-1 (Postgres 53300, 2026-09-23 21:25 UTC)

## 1. Why

On 2026-09-23 three prod machines cold-booted at 21:18 UTC. At 21:25:44–48 one
spectator's hub and player-matches views fanned out per-division
`unstable_cache` rebuilds (`pub-hub`, `pub-div` × every division of the
competition). Every machine's Next data cache was empty, so every rebuild went
to Postgres at once; with `DB_POOL_MAX=20` on five machines the database
refused 30 connections in four seconds (17 × "remaining connection slots are
reserved…", 13 × "sorry, too many clients already").

The immediate fix was env-only (3 machines in lhr, `DB_POOL_MAX=12`; budget
36 + ~10 ≤ 57 usable of `max_connections=60`). This design removes the
underlying shape: Next's data cache is **per machine and ephemeral** (default
handler: memory + `.next/cache` on a VM disk with no `[mounts]`), so a fresh or
restarted machine rebuilds everything from Postgres, and invalidations reach
sibling machines only through an HTTP fan-out that a suspended machine misses.

## 2. Goal (owner: option C)

1. **Warm cold start** — a fresh machine serves public pages without querying
   Postgres for data another machine has already cached.
2. **One coherent invalidation** — a tag invalidated once is seen by every
   machine on its next read; `peer-revalidate` (Fly 6PN DNS fan-out +
   `/api/internal/revalidate`) is retired.

### Non-goals

- Page output (ISR HTML/RSC) in Redis — stays per machine (§4).
- `"use cache"` / `cacheHandlers` (plural) — not used in `apps/web/src`.
- `revalidatePath` for news posts (`firePostRevalidate`) — untagged and
  already machine-local; unchanged.
- Cloudflare purge (`purgeCdn`) — unchanged.
- The `pub:v1:*` Redis document layer in `usecases/public.ts` — unchanged; it
  is a separate cache-aside for the public API.

## 3. Decisions (owner, 2026-09-24)

| # | Question | Ruling |
|---|---|---|
| D1 | What is this for? | C — warm cold start **and** coherent invalidation |
| D2 | Behaviour when Redis is unreachable | A — fall back to machine-local memory; staleness bounded by entry TTL (30 s / 300 s), same bound as a missed peer POST today |
| D3 | What lives in Redis | Approach 1 — **data entries only** (`unstable_cache`, kind FETCH) + one shared tag-state hash; page output stays in local memory |
| D4 | Rollout | Two PRs: dual-run behind a flag, then delete peer-revalidate |

Rejected: everything-in-Redis (page bodies are large and cheap to re-render
from warm data; adds bandwidth and size risk for little gain); an off-the-shelf
handler library (`@neshca/cache-handler` / forks — Next 16.2 support unverified,
and tag semantics would be the library's, not Next's).

## 4. How Next decides freshness (verified against `next@16.2.9`)

- `IncrementalCache` constructs `new CurCacheHandler({...})` **per
  IncrementalCache instance** (`server/lib/incremental-cache/index.js` ~L101),
  i.e. roughly per request. Handler instance fields do not survive a request.
- After `handler.get()` returns, `IncrementalCache` itself checks the entry
  against the **in-process** tags manifest
  (`tags-manifest.external.js`: `tagsManifest: Map<tag, {stale?, expired?}>`,
  `areTagsExpired`, `areTagsStale`):
  - FETCH kind: tags = `ctx.tags` + `ctx.softTags`; expired → `null`
    (rebuild now); stale → serve + background rebuild.
  - APP_PAGE / APP_ROUTE: tags from the stored `x-next-cache-tags` header.
- The default `FileSystemCache.revalidateTag(tags, durations)` writes that
  manifest: `stale = now`; if `durations.expire !== undefined`,
  `expired = now + expire * 1000`. So `revalidateTag(t, "max")` → stale now,
  expiry far future; `revalidateTag(t, { expire: 0 })` → stale and expired now.
- `unstable_cache` reads through the handler unless nested inside another
  `unstable_cache`, `force-no-store`, on-demand revalidate, or draft mode
  (`spec-extension/unstable-cache.js` ~L146) — same as today.
- The `cacheHandler` file is added to the standalone trace
  (`build/collect-build-traces.js` ~L152), so its imports (`ioredis`) ship in
  the standalone output.

**Consequence:** a custom handler does not re-implement freshness. It only has
to (a) store entries and (b) make the in-process `tagsManifest` reflect
**shared** tag state before `IncrementalCache` consults it. Next's own
`"max"` vs `{expire:0}` semantics — which `revalidate.ts` relies on, including
its load-bearing ordering comment in `fireScoreRevalidate` — are preserved
unchanged.

## 5. Upstash facts (prod)

Fly-managed Upstash, **London**, pay-as-you-go, TLS off (Fly private network),
eviction **on** (owner, 2026-09-24).

| Limit | Value | Design response |
|---|---|---|
| Price | $0.20 / 100K commands | ≈1–2 commands per page view; `HMGET` of N fields = 1 command |
| Throughput | 10,000 commands/s | far below need |
| Max request | 10 MB | values > **1 MB** skip Redis (memory only), logged once per key per process |
| Max entry | 100 MB | n/a |
| Storage | 10 GB | data keys have TTL + build-id prefix; expected MBs |
| Eviction | random among TTL keys when full | data keys: a miss, harmless. Tag hash has **no TTL**; its loss is tolerated (§7) |

Staging also has Redis (owner, 2026-09-24).

## 6. Design

### 6.1 Units

**`apps/web/cache-handler.mjs`** — wired by `next.config.js`
`cacheHandler: require.resolve("./cache-handler.mjs")`,
`cacheMaxMemorySize: 0` (disables Next's own memory layer; ours replaces it).
Plain ESM, no `@/` imports, no `server-only` (it loads outside the bundle).
Implements `get`, `set`, `revalidateTag`, `resetRequestCache`.

All state is **module-level on `globalThis`** (see §4), exported for tests:

- `L1` — byte-bounded LRU (default 64 MB, env `NEXT_CACHE_L1_MB`), all kinds.
- `redis` — dedicated ioredis client, lazily created when
  `NEXT_CACHE_REDIS === "1"` and `REDIS_URL` is set. Options:
  `connectTimeout: 1000`, `commandTimeout: 150`, `maxRetriesPerRequest: 0`,
  `enableOfflineQueue: false`; `error` events swallowed (logged via breaker).
- `breaker` — after 5 consecutive Redis failures, skip Redis for 10 s, then
  probe. One log line on open, one on close.
- `requestTagMemo` — per-request map tag → state, cleared by
  `resetRequestCache()`, so one render issues at most one `HMGET` per distinct
  tag set.

**Redis keys**

- Data: `nc:{buildId}:{cacheKey}` → JSON `{ v: 1, lastModified, value }`,
  `SET … EX ttl` where `ttl = revalidate + 3600` s, or 30 days when
  `revalidate` is `false`/absent (`pub-player-gate-tag`, figures outside live
  play). `buildId` read once from `.next/BUILD_ID` via `serverDistDir`.
- Tags: one hash `nc:tags`, field = tag, value = `"{at}|{json}"` where json is
  `{ stale?, expired? }` (epoch ms) and `at` is the write time. Writes go
  through a Lua script that sets a field only if its `at` is ≥ the stored
  one, so concurrent writers from different machines cannot regress a tag.
  No TTL. Not build-scoped.

**`apps/web/src/lib/peer-revalidate.ts`** — same exported seam
`broadcastRevalidate(tags, mode)`. PR 1: additionally computes the same tag
state as §4 (`swr` → stale now, expiry per `"max"` profile; `expire` →
stale = expired = now) and `HSET`s it, bounded to
`PUSH_AFTER_DELETE_BOUND_MS` (1.5 s), before resolving. PR 2: the HTTP
fan-out, DNS lookup, `/api/internal/revalidate` route and `PEER_REVALIDATE`
are deleted; the function name is kept so the nine call sites in
`public-site/revalidate.ts` are untouched.

The tag-state arithmetic lives in **one** module shared by the handler and
`peer-revalidate.ts` (plain `.mjs` importable from both), so the two writers
cannot drift.

### 6.2 Read path — `get(key, ctx)`

1. L1 hit → entry. Else if FETCH kind and Redis available → `GET nc:{buildId}:{key}`;
   hit → parse; invalid JSON or `v` mismatch → treat as miss and `DEL`; valid
   → populate L1.
2. Collect the entry's tags (FETCH: `ctx.tags` + `ctx.softTags`; page kinds:
   `x-next-cache-tags` header). Fetch any not already in `requestTagMemo` with
   one `HMGET nc:tags …`.
3. Merge into `tagsManifest`: **newest write wins**, by the write timestamp
   `at` stored with each tag (see §6.1 Redis keys). A remote state replaces
   the local one only if its `at` is later than the last `at` this machine
   applied for that tag. (Corrected 2026-09-27: a per-field `max` merge would
   keep a `"max"` write's year-ahead `expired` over a later `{expire:0}`'s
   `expired = now`, silently turning a score expiry into stale-while-
   revalidate. Next's own `FileSystemCache` is last-write-wins.)
4. Return the entry; `IncrementalCache` applies Next's rules.

Redis unavailable at step 1 or 2 → continue with L1 and the local manifest.

### 6.3 Write path — `set(key, data, ctx)`

Write L1. If FETCH kind, serialised size ≤ 1 MB and Redis available → `SET`
with TTL (§6.1). Oversize → L1 only, logged once per key per process.
`data === null` → delete from L1 and Redis.

### 6.4 Invalidation — `revalidateTag(tags, durations)`

Called by Next at the end of the request that invoked `revalidateTag`. Apply
the §4 arithmetic to the local `tagsManifest` **and** `HSET nc:tags`. The
realtime push does not wait on this path (Next flushes after the response);
it waits on `broadcastRevalidate` (§6.1), which writes the same state
eagerly. Writing the same state twice is idempotent: equal `at`, same value.

### 6.5 Cold start

Empty L1; data from Redis; pages re-render from warm data; Postgres untouched
for anything another machine cached. This is the SEAZN-CLUB-PROD-1 regression
(§8.3).

### 6.6 Slideshow and other push consumers

`slideshow.tsx`, `use-live-competition.ts`, `use-board-actions.ts` refresh on
a `division:{id}` broadcast after a 1 s debounce; the refresh may land on any
machine. Ordering today: `fireScoreRevalidate` → peer POSTs →
`dropNamedPublicDocuments` → `sendAfterDeleteOrBound` → push. After: peer POST
replaced by the Redis `HSET`, push still gated on it (≤ 1.5 s). A suspended
or restarting machine now sees the invalidation on its next read, which the
peer POST could not deliver.

## 7. Failure modes

| Case | Behaviour |
|---|---|
| Redis down / slow | 150 ms command timeout, breaker opens after 5 failures; L1 + local manifest only. Cross-machine staleness ≤ entry TTL (30 s / 300 s). **Accepted (D2):** a slideshow whose refresh lands on a machine that missed the tag shows the old score until the next push or its 5-min subscribed poll — the same exposure a missed peer POST has today. |
| Tag hash evicted or lost | Machines keep their local manifest (newest write wins). A machine that never saw a tag may serve stale ≤ entry TTL. Entries with no time TTL (`pub-player-gate-tag`) get the 30-day Redis TTL as an upper bound. |
| Poisoned / old-shape value | Parse failure or `v` mismatch → miss + `DEL` (pattern of `hub-cache-poisoned-entry.test.ts`). |
| Deploy / version skew | Data keys are build-scoped; the tag hash is shared, so a rolling deploy's invalidations reach both builds. |
| Clock skew between machines | Timestamps are `Date.now()`, as in Next's own cache. Fly clocks are NTP-synced (ms); a test pins that a few-ms skew does not change a verdict. |
| Oversize value | Memory only, logged. |
| No `REDIS_URL` / flag off (local, CI default) | Memory-only handler — today's single-machine behaviour. |
| Tag hash growth | At most once a day (a `SET nc:sweep NX EX 86400` lock), the handler `HSCAN`s `nc:tags` in the background and deletes fields whose `at`, `stale` and `expired` are all more than 1 year old. (Corrected 2026-09-27: the cron schedulers live outside this repo, so a new cron route would be an inert seam.) |

## 8. Testing (all four types; each fails without the change; mutation-checked)

1. **Unit (fake Redis).** Tag arithmetic parity: expected `{stale, expired}`
   is produced by running Next's own `FileSystemCache.revalidateTag` on the
   same input, not a typed table. Max-merge never regresses a tag. 1 MB skip.
   Poisoned value → miss + `DEL`. Breaker opens after 5, recovers after 10 s.
   Flag off → Redis never constructed. State survives constructing a second
   handler instance (the per-request construction in §4).
2. **Two machines, real Redis (the seam proof).** Two `IncrementalCache`
   instances, each with our handler, one real Redis (CI service container).
   A: `unstable_cache` populate → B: hit from Redis with empty L1.
   A: `revalidateTag(div, {expire:0})` → B: `null`. A: `"max"` → B: stale.
   Mutations: remove the merge step → red; remove the `HSET` in
   `revalidateTag` → red.
3. **Regression SEAZN-CLUB-PROD-1.** Cold L1 + warm Redis serves the hub and
   player-matches loaders with **0** Postgres statements (`statementCount()`
   delta, `lib/db.ts`); the same with Redis off shows > 0 (positive pair).
4. **Push ordering.** The realtime send happens only after
   `broadcastRevalidate`'s `HSET` resolves or the 1.5 s bound. Mutation: send
   before awaiting → red.
5. **E2E.** Two prod-build servers on different ports, one Redis. Score on A;
   B's division page and slideshow show it right after the push, not after
   30 s. Dedicated job with a Redis service (`e2e.yml` runs on push to `main`
   and `workflow_dispatch` only — dispatch it against the branch).
6. **Smoke.** `/api/health` gains `cache: "redis" | "memory" | "degraded"`
   (always HTTP 200 — Fly's health check must not fail on a Redis outage).
   CI's `smoke-e2e` runs without Redis and asserts `memory`; there is no stg
   smoke job in this repo, so the stg rollout step asserts `redis` by hand.
   (Corrected 2026-09-27.)

Existing suites that must stay green: the real-incremental-cache tests under
`server/usecases/__tests__/` (`score-revalidate-in-request`,
`player-stats-refresh-after`, `person-writes-public-page-revalidate`,
`division-policy-revalidate`), `lib/__tests__/peer-revalidate.test.ts`,
`app/api/internal/revalidate/route.test.ts` (deleted in PR 2),
`public-site/__tests__/revalidate.test.ts`.

## 9. Rollout

**PR 1 — handler + dual-run.** Handler behind `NEXT_CACHE_REDIS=1`;
`broadcastRevalidate` writes Redis **and** still POSTs peers. Stg first:
watch Upstash commands/day, Postgres connection peak after a machine restart
(`pg_stat_activity`), and cross-machine invalidation. Then prod, soak about
one week. Rollback: unset `NEXT_CACHE_REDIS`.

**PR 2 — retire peer-revalidate.** Delete the HTTP fan-out, DNS lookup,
`/api/internal/revalidate`, `PEER_REVALIDATE` (fly secrets, both
`.env.example`s), and correct the `fly.toml` comment ("peers stay
ISR-coherent via /api/internal/revalidate"; machine ceiling). Rollback after
PR 2 is a revert.

## 10. Premises

| Premise | Status |
|---|---|
| Staging has `REDIS_URL` | Owner-confirmed |
| `ioredis` reaches standalone output via the `cacheHandler` file | Verified (`collect-build-traces.js` traces `cacheHandler`) |
| Custom handler replaces the default; `unstable_cache` reads it | Verified (`incremental-cache/index.js`, `unstable-cache.js`) |
| Handler is constructed per `IncrementalCache` | Verified — state must be module-level |
| Freshness is judged against the in-process `tagsManifest` after `get` | Verified (`index.js` FETCH branch + page branch) |
| Largest data-entry sizes (`pub-player-v17`, `overlay-fold-v4`, `pub-player-figures-v2`) | **Open** — measure in PR 1 before enabling on prod; the 1 MB skip is the safety net |
| Upstash eviction on | Owner, 2026-09-24 — design tolerates either |
| `"max"` profile's `expire` value as passed to `revalidateTag(tags, durations)` | **Open** — read from Next's cache-life defaults in PR 1 and derive, never hard-code |
