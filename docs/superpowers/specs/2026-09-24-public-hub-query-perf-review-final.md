# Final whole-branch review: `724206bed..268615f5c`, 2026-09-27

**Scope:** 9 commits, as named in the brief: T1 (V418), the T1 test
follow-up, T3 ×3 (db pool options and comments), T2 ×2 (single-flight hub and
R10 uncached rebuild), and T4 ×2 (parallel lanes and laterals, then the
review fixes).

**Verdict: Approved.** I found no Critical or Important cross-task issue.
Every per-task finding is closed (see review-T1 through T4). The items below
are nits and informational follow-ups.

I ran no suites: I had no database of my own. The two CI-wiring guards
(`redis-suite-ci-wiring.test.ts`, `db-suite-ci-wiring.test.ts`) only read
files, and I checked their conditions by reading `ci.yml` rather than by
running them.

## Cross-task interactions

**T2 rebuild vs T4.** The Redis rebuild (`public.ts` `cachedHub`) now reaches
T4's code like this:

1. It calls `loadCompetitionHub(…, { uncached: true })`.
2. That reads the shell with `readPublicCompetitionShell`.
3. It then calls `readEveryPublicDivision(…, { uncached })`
   (`competition-hub.ts:630`).
4. That calls `readPublicDivisionDetail(d, { sequential: true })`, whose
   fixture query ends on `st.seq, v.id`.

So the rebuild gets both the tiebreak and the one-connection-per-division
fan-out. The fixture-order test runs the hub list with `uncached` both true
and false (`public-division-fixture-order.test.ts:165-172`).

T2's R10 test double still behaves correctly:

- `getPublicDivision`'s cache key parts are still
  `["pub-div-v3", division.id]`, and the returned function is called with no
  arguments. So the new `read` option changes neither the real cache key nor
  the double's key, and the premise `hits` contains `pub-div-v3` holds.
- `readEveryPublicDivision` reads the divisions from the fresh uncached
  shell.

**V418 vs T4's me.ts.** V418 publishes `members[].person_id` as `p.id`, from
`entrant_members em join persons p … merged_into is null`. T4's EXISTS goes
through the person's own `entrant_members` row, and then through the same
view by id, with the same consent, profile and visibility arms. The two are
equivalent.

The fenced lateral builds one view row per membership, which is one
`org_has_feature` call each. The me.ts test pins this at 1 call against 12
or more before. me.ts restates no publish rule, so V418's "exactly one
second copy" (`public-leaders.ts`) still holds.

**V418's index vs T4's ORDER BY.** `fixtures_division_round_idx (division_id,
round_no, seq_in_round)` can no longer satisfy the full four-key ORDER BY by
itself. It still serves the division filter and a presorted prefix, so
Postgres can use an incremental sort. With a hundred-odd rows per division,
the cost is negligible. Informational.

**T3's pool vs T4's lanes.** More parallel lanes mean a machine opens more of
its 12 pooled connections during bursts. Each new connection pays the
`fetch_types` round trip that T3 pinned on. It stays within the budget of 60
connections, 3 machines × 12. Informational.

**T2 lease vs T4.** The rebuild's division reads are sequential per division,
as they were before T4. The rebuild's duration is unchanged in shape, so the
lease timing is unaffected.

## Checks

| Check | Result |
|---|---|
| `.only` / `.skip` / `fit` / `xit` / `todo` | None. Every gate is `describe.skipIf(!HAS_DB…)`. |
| `console.*` / `debugger` / TODO in production code | None. |
| New DB-gated suites | `public-site/__tests__/*` run in the smoke-db step (`ci.yml:762`, job `DATABASE_URL` `:553`). usecases `h*` (hub-single-flight, hub-rebuild-reads-postgres, hub-cache-poisoned-entry) also run in smoke-db (`[i-z]` excluded `:588`). `me-player-stats-published-identity` runs in smoke-db-usecases (`[a-h]` excluded `:957`, `DATABASE_URL` `:944`). Both jobs run Postgres as the `postgres` superuser, which the `set local track_functions` in the T1 and me.ts suites needs. |
| Redis-gated suites | Both new ones (`cache-lease.redis`, `public-competition-ref.redis`) are named in the step that sets `REDIS_URL` (`ci.yml:851-853`), which is exactly what `redis-suite-ci-wiring.test.ts` asserts. |
| OpenAPI | No change needed. No `server/api-v1` schema, no zod response schema and no route contract changed. The only route edit (`api/orgs/[id]`) is an ordering change after commit. The hub and org-live documents keep their shapes. |
| i18n and dictionaries | No change needed. No user-facing string was added. The new text is pino log lines, code comments and English `HttpError` messages, which follow the API's existing convention. The poster's stage name is the same stored value, read from a different place. |
| Smoke | `scripts/smoke.ts` (T1) adds two pass-scoping checks on the public entrants document. It runs on PRs. |

## Duplicate helpers

- `readEveryPublicDivision` is the only every-division read.
- `publicHubCacheKey` (`hub-doc-cache-keys.ts:20`) is the reader's authority,
  but the four existing writers still spell the literal:
  - `revalidate.ts:175`
  - `schedule.ts:137`
  - `player-stats-refresh.ts:563`
  - `scoring.ts:896`

  `hub-single-flight.test.ts:220` pins the helper to that literal, so drift
  goes red. Nit: point the writers at the helper so there is one authority.
- In tests, the in-flight `probe` and `peakOf` are copied between the two
  identity suites. Nit, test-only.

## Nits and informational follow-ups

1. **`public-entrants-entitlement-once.test.ts:353,380`:** `console.info`
   measurement lines, labelled "Reported for the task log". Tests are exempt
   from `no-console` (`apps/web/eslint.config.mjs:136-137`), and six other
   test files do the same. It is noise in CI logs. Nit: drop it or leave it.
2. **`usecases/public.ts:545`:** the API v1 public schedule still orders on
   `(round_no, seq_in_round)` only. HTML pages and the embed now order ties
   by stage seq and id, while the API returns them in plan order. This is not
   a regression, but the product and its API now disagree on tie order.
   Follow-up: use the same four-key ORDER BY there.
3. **`data.ts:698`:** this predates the branch. `liveNow` is
   `order by f.scheduled_at nulls last limit 12`. With more than 12
   in-play matches sharing a start time, which 12 appear depends on the plan.
   Follow-up: add `f.id` to that ORDER BY.
