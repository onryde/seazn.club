# T2 review: commit 02d9fe2f1 (single-flight hub rebuild + cached slug lookups)

Reviewer, 2026-09-27. Read-only. I reviewed against the plan's T2 row,
`AGENTS.md` and the `RULES.md` owner checklist. `lib/db.ts` and its tests were
out of scope (T3 is editing them). I did not run any tests. Everything below
comes from reading the code. The Next data-cache and Fly timing claims are
reasoned from code comments and config, not observed.

**Verdict: Needs fixes.** The lease itself is correct: atomic, token-checked,
PX-bounded, and it fails open exactly like the plain cache-aside did. The
slug-lookup invalidation is complete for every in-app writer. But the
freshness argument, that the key only ever holds a document built after the
write, rests on an assumption the hub build does not meet: that the build
reads Postgres. It actually reads division details through Next's
`unstable_cache`. So a pre-write document can still be filled, and
single-flight now hands it to every tab, where before each tab built its own.

## 1. Spec compliance

| Brief (plan T2 row) | Result |
|---|---|
| Single-flight rebuild (Redis SET NX lock) | Done. A lease sits under the hub key itself (`cache.ts` `cacheLeaseAcquire`, `SET … PX … NX`) and the fill is a compare-and-set (`LEASE_FILL_LUA`). |
| Losers serve stale | Done, in a different form: a separate last-known-good key `pub:v1:hub-stale:{id}` (EX 60), written in the same Lua step as each fill and served only after a bounded wait. |
| "Mark-stale instead of delete on score" | **Deviation, harmless.** Writers still DEL the key. The stale copy lives beside it, so no writer changed. The justification is sound: a DEL mid-build also removes the lease. |
| `findCompetition` folded into the cached path | Done as a separate cached lookup: `findCompetitionRef` → `pub:v1:comp-ref:{org}:{comp}`, and `findOrgRef` → `pub:v1:org-ref:{org}` (15 s, lease-filled, a 404 is never cached). |

## 2. Strengths (load-bearing only)

- **The Lua is right.** Fill does GET-compare, then SET with EX, then an
  optional stale SET, all in one EVAL, and returns 0 before writing anything
  when the marker differs (Lua `false ~= marker` covers an absent key).
  Release is delete-if-mine. Acquire uses a random UUID token and always sets
  a PX, including in `replace` mode. `cache-lease.redis.test.ts` checks each
  of these against a real Redis, so a Lua mutant cannot hide behind the fake.
- **Fail-open matches the old behaviour.** Any thrown or unconfigured call
  reads as `unavailable`, and the caller builds and writes nothing, the same
  as old `cacheGet → null`, build, and a `cacheSet` that silently failed.
- **Every key has a TTL, and there are no per-request keys.** Document keys
  use EX, the stale copy EX 60, leases PX 8000 or 5000. A 404 lookup creates a
  PX-bounded lease that is released at once; refusals are never stored.
- **Privacy enumeration is complete** (grep -a over apps, packages, scripts,
  services and `db/migration`, including functions):
  - `competitions.visibility` and `slug` are written only by `patchCompetition`.
  - Delete only by `deleteCompetition`.
  - Org slug only by `PATCH /api/orgs/[id]`, and only through a rename.
  - Nothing in the app deletes an org; the only org deletes are in smoke,
    bench and seed scripts.
  - Staff moderation cannot move the gate: `admin-orgs.ts:45` suspension
    writes `status`, and the admin discovery route writes
    `discovery_featured`/`blocked`. Neither the old `findCompetition` nor
    `public_competitions_v` (V397: visibility only) filtered on those, so
    nothing regressed.
  - Every drop runs after commit. `public-competition-ref.redis.test.ts`
    drives the real write paths against Postgres and Redis.
- **The tests check values that tell right from wrong.** Versions 1 vs 2, a
  seeded "yesterday" stale copy vs the builder's document, builder-call counts
  rather than Redis-call counts, and an ORDER-sensitive fresh-vs-copy case.

## 3. Issues

### Important

- **`lib/single-flight-cache.ts:31-38`, `usecases/public.ts:300-311`, and the
  commit message: the freshness proof does not hold for the hub.**
  - **The mechanism.** `loadCompetitionHub` (`competition-hub.ts:567,610`)
    reads the competition shell and every division's fixtures and standings
    through `getPublicCompetition` / `getPublicDivision`, which are
    `unstable_cache` wrapped (`data.ts:614,914`). A score expires the
    division tag only when the handler resolves (`scoring.ts:324-326`). Peer
    machines expire it only when `broadcastRevalidate` lands
    (`revalidate.ts:226`). Scoring does NOT wait for that before its DEL and
    push (`scoring.ts:896-920`), and it has no second DEL.
  - **The consequence.** A tab's refetch (250 ms debounce) that lands on a
    peer machine before the broadcast takes the lease after the DEL, as the
    proof requires. It then builds the PRE-score document from the peer's data
    cache and fills it: nothing DELs after it, so the fill lands and the stale
    copy is overwritten too.
  - **Why no retry saves it.** `generatedAt` is the build clock
    (`competition-hub.ts:576`), later than the push, so the client's push
    retry (`use-live-competition.ts:246`) accepts it as fresh.
  - **Before vs after T2.** Before, this race existed per tab, and later
    post-flush rebuilds overwrote the key (last writer wins). Now the
    earliest rebuild, the most likely one to be pre-flush, is served to every
    tab for `HUB_TTL_SECONDS`.
  - **Where it bites.** Peers run under live-event load, which is exactly
    the R10 case.
  - **Fix (pick one, orchestrator/owner call):**
    - (a) Build the Redis hub from Postgres directly: an uncached path through
      the division detail. Single-flight made the rebuild rare enough to
      afford it, and then the proof is actually true.
    - (b) Mirror `dropNamedPublicDocuments`' "TWICE" pattern
      (`revalidate.ts:153-160`): a deferred second DEL of the hub key after
      the handler flush and `peersExpired`, in `invalidatePublicCache`,
      `afterScheduleWrite` and the stats refresh. That bounds the damage but
      does not re-push, so tabs that already accepted the stale document only
      correct at their next poll.
    - Either way, soften the "nobody is served the pre-write document again"
      claim until it is true, and add a test that drives a real
      `loadCompetitionHub` through a still-cached division. The current hub
      tests mock the loader (`hub-single-flight.test.ts:35-38`) and cannot see
      this, which is recurring failure class 2.

### Minor

- `lib/cache.ts` (`cacheLeaseFill` catch, `LEASE_FILL_LUA` call) and
  `single-flight-cache.ts:87`: a fill that THROWS is indistinguishable from a
  normal refusal, and nothing logs it. If the provider ever systematically
  rejected the two-key EVAL, caching would silently stop, and every tab would
  wait 1.5 s and then rebuild: worse than before T2, with no signal. Likewise
  a WRONGTYPE key reads as `unavailable` forever, where the old plain `SET`
  self-healed it. Fix: log (sampled) when EVAL or GET throw, as opposed to
  returning 0. Optionally, log a fill refused after `build` took at least
  `leaseMs` (lease expiry, not a write).
- `.github/workflows/ci.yml:845`: the step keeps the `-- run` positional. The
  workspace script is already `vitest run` (`apps/web/package.json:12`), so
  `run` is a FILENAME FILTER. It drags every path containing "run" into this
  Redis+DB step. That is the exact defect `ci.yml:680-687` documents for the
  sibling step. The problem predates T2, but T2 rewrote this line. Fix: drop
  `run`. Otherwise the edit is minimal and correct: the two new suites are
  appended, `REDIS_URL` stays step-scoped, `DATABASE_URL` is job-scoped
  (`ci.yml:553`), and the `on:` triggers are unchanged.
- `app/api/orgs/[id]/route.ts:215`: `dropPublicOrgRefs` runs after
  `invalidateUserOrgs` and `invalidateSlugCache`. If either of those throws,
  the drop is skipped and the old org slug keeps resolving for up to the 15 s
  TTL. Fix: drop straight after the commit, or in a `finally`.
- `lib/__tests__/single-flight-cache.test.ts:186` asserts wall-clock
  `< 50 ms` on a loaded CI runner (4 cores, with Postgres and Redis
  containers). `cache-lease.redis.test.ts:74-76` takes a 100 ms PX and
  expects a second acquire to find it held, which assumes two round trips
  finish in under 100 ms. Both are low-odds flakes. Fix: widen to at least
  250 ms / a PX of at least 1000 ms, with the sleep scaled to match.
- `single-flight-cache.ts:112-124`: the 1.5 s wait is bounded only between
  Redis calls. ioredis has no command timeout (a known class here,
  `revalidate.ts:163-164`), so a stalled socket hangs a loser's GET. This is
  the same exposure the old `cachedFor` GET had, not a new class. Informational.

## 4. Gap hunt

- **Rolling deploy.** While old and new builds serve side by side, old
  `cachedFor` reads a `lease:…` marker, fails the JSON parse, misses, and
  writes with a plain unguarded `SET` over the lease. The new holder's fill is
  then refused, so for the rollout window the pre-T2 race is back. That is
  bounded and self-correcting, so it is noted only.
- **Withdrawn names.** `dropNamedPublicDocuments` sends one key list for both
  of its DELs, and the stale copy is in that list, so a document rebuilt from
  pre-flush data in the gap is removed by the second DEL. Correct.
- **Visibility.** When a competition goes private, its hub and stale keys stay
  in Redis until their TTL, but they sit behind the ref gate, which is dropped
  after commit, so neither is served. Correct.
- **Key growth.** None per request. The stale copy adds one key per
  competition read in the last 60 s.

---

# Re-review: fix commit e5848d2f3 (on d683f28fe), 2026-09-27

**Verdict: Approved.** Every T2 finding is closed. No new Critical or
Important issue. The one nit below does not block.

## 1. Every read on the uncached path

`loadCompetitionHub(…, { uncached: true })` is called only from
`usecases/public.ts:329`, which is the Redis rebuild. It reads:

- the shell, from `readPublicCompetitionShell` (`competition-hub.ts:583`);
- each division, from `readPublicDivisionDetail` (`competition-hub.ts:630`).
  Its division argument comes from that same fresh shell.

The two readers go straight to Postgres, either directly or through:

- `loadOrg` (`data.ts:483`);
- `withCourtVenueNames` (`data.ts:109`);
- `maskPublicEntrantNames` (`data.ts:736`), which reads fresh
  consent and member rows.

The rest of the loader also reads Postgres directly:

- `publicRegistrationInfo`;
- `activePublicSuspensionEntries`;
- `readEntrantMemberRefs`, through `divisionSquads` (`data.ts:879`);
- `readLeaderRows` (`competition-hub.ts:901`).

`renderProse` keeps no memo. In the loader's dependency set, `unstable_cache`
remains only in `getPublicCompetition`, `getPublicDivision` and the ISR
wrapper. None of them is on this path, and none of the dependencies uses
`"use cache"`.

Two reads are not live Postgres reads:

- `hasFeature`, the entitlement cache. It has its own invalidation, and a
  score write does not move it.
- `resolveModule`, the static module registry.

Neither can serve pre-score data. The two slug-lookup single-flight builders
(`public.ts:188`, `:456`) and `listOrgHomeCompetitions` also read direct SQL.

## 2. SQL identical

I extracted every `sql` template literal from the moved region, old
`data.ts:597-994` against new `:597-1018`, and removed leading whitespace.
Both sides have 95 lines and the same SHA-1 (`4b23edb5…`).

`git diff -w` shows the non-SQL code is moved unchanged. The only changes
are the function wrappers:

- the `unstable_cache(async () => {…})` bodies became named functions;
- the cached getters now call those functions.

Cache keys (`pub-comp`, `pub-div-v3`) and tags are unchanged.

## 3. ISR page path

`getPublicCompetitionHub` (`competition-hub.ts:1110`) still calls
`loadCompetitionHub(orgSlug, compSlug)` with the default `uncached = false`,
so the page keeps its cached reads. The second describe of
`hub-rebuild-reads-postgres.test.ts:225-241` pins that the page path hits
both `pub-comp` and `pub-div-v3` and serves the cached bucket while Postgres
disagrees.

## 4. The R10 test double

The double at `usecases/__tests__/hub-rebuild-reads-postgres.test.ts:43-62`
behaves as the brief asks:

- a miss returns the raw result;
- a hit returns `JSON.parse` of the stored body;
- entries are keyed by keyParts plus args;
- `revalidateTag` only records the tag and never drops an entry.

The test has teeth:

- With `uncached: true` removed from `public.ts:329`, the rebuild reads
  pre-score data from the double. `after` then equals `before`, and `:219`
  goes red.
- Reverting only the division half leaves `tables` and `match` stale.
- Reverting only the shell half leaves `divisionStatus` stale: it reads
  `setup` (the V209 default) against `active`.
- Premises `:206`, `:211` and `:218` guard against a vacuous pass.

It will run in smoke-db. It is not in the `[i-z]` exclude, and the smoke-db
job has a job-level `DATABASE_URL`. I did not run it (no DB of mine).

## 5. The ci.yml Redis step

`ci.yml:851` now selects exactly the 5 `*.redis.test.ts` files that exist in
the tree, and nothing else:

- rate-limit
- entitlements-cache-invalidation
- platform-fee-cache-isolation
- cache-lease
- public-competition-ref

No other path contains any of those five strings. `cache-lease-failures`
mocks ioredis and runs in the src/lib step.

## 6. Logging throttle

The throttle is bounded:

- `leaseFailureLoggedAt` (`cache.ts:166`) is keyed by `op`, a four-member
  union, so there is no per-key or per-request growth.
- Only a throw is logged. A normal refusal or "Redis not configured" is not.
- The throttle boundary is tested at interval-1 and at the interval
  (`cache-lease-failures.test.ts:128-134`).

## Prior minors

- **Org route ordering:** `dropPublicOrgRefs` now runs straight after the
  commit (`route.ts:208`). The new test at
  `public-competition-ref.redis.test.ts:223` makes `invalidateSlugCache`
  throw and would go red on the old ordering.
- **Timing flake:** `single-flight-cache.test.ts:190` is now pinned by read
  count, with the clock bound widened to 250 ms. The PX is 1000 ms with a
  1300 ms sleep.

## Nit (non-blocking)

- `competition-hub.ts:964,974`: the squad doc comment says the member lines
  come from "`getPublicDivision`'s cache". That is true only on the ISR path;
  on the Redis rebuild both reads are fresh. Fix: say "`getPublicDivision`'s
  cache on the page path".
