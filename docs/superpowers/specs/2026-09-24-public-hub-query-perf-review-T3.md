# T3 review: commit d3534314c (`idle_timeout` 20 → 60, `fetch_types` pinned on)

Reviewer, 2026-09-24. Read-only. I reviewed against the plan's T3 row and the
Decisions block in `2026-09-24-public-hub-query-perf.md`, plus `AGENTS.md` and
the `RULES.md` owner checklist. I did not run any tests. Everything below comes
from reading the code, the installed postgres.js 3.4.9 source, `fly.toml`,
`fly.stg.toml` and `ci.yml`. The Fly behaviour described here is reasoned from
the config, not observed.

**Verdict: Needs fixes.** The code change is correct and the churn win is real.
But the claim that makes 60 s safe for suspended machines ("60 s still drains
the pool well before a suspend", `apps/web/src/lib/db.ts:41-43`, and the commit
message) is false for this deployment. That same claim was part of the basis the
owner approved. The comment has to be corrected, and the owner should
re-confirm the 60 s value with the correct facts. The value itself may well
stand.

## 1. Spec compliance

| Brief item | Result |
|---|---|
| `idle_timeout` 20 → 60, owner-approved "idle_timeout: 60 ok" | Done. The value sits in `IDLE_TIMEOUT_S` (`db.ts:49`), `connectionOptions()` returns it (`db.ts:69`), and `getClient()` passes it through (`db.ts:80,87`). |
| `fetch_types` stays on | Done. The option is left at its default (`db.ts:82`). |
| The false premise behind `fetch_types` (plan Decisions, 2026-09-24) | **Verified in source.** `connection.js:768-788` `fetchArrayTypes()` selects every `typcategory = 'A'` element type and registers both a parser and a serializer for each array OID. That includes builtins, because `types.js` has no array OIDs of its own and `options.shared.typeArrayMap` starts empty (`index.js:498`). It runs per connection: `needsTypes` is reset on every `connected()` (`connection.js:368`, then `:562-564`). A raw JS array parameter is sent with an unknown type, and the server-described array OID then needs `options.serializers[oid]`, which only the fetch installs. Off would mean arrays read back as `"{a,b}"` and `any(${ids})` fails to serialise. The claim holds. |
| Tests | db-options +1, db-singleton +1, and the new db-array-types, which is real-DB. |

## 2. Strengths (load-bearing only)

- `db-array-types.test.ts` goes through the app's REAL `sql` client, in both
  directions: text[]/uuid[] read back, and text/uuid `any(${[…]})` sent. Setting
  `fetch_types: false` in `getClient()` turns both tests red.
- **It does run in CI.** The `smoke-db` job (`ci.yml:512`) has
  `DATABASE_URL` at job scope (`ci.yml:553`). Its step at `ci.yml:761-762` runs
  `src/server src/lib` under apps/web, and that includes
  `src/lib/__tests__/db-array-types.test.ts`. The collection reconciliation at
  `ci.yml:815` lists the same paths. `ci.yml` triggers on `pull_request` only
  (`ci.yml:6-7`), which matches the rest of the repo. In the unit job it
  self-skips, which is correct.
- Only one production `postgres()` client exists (`db.ts:83`). Every other
  `postgres()` call is a one-shot script, smoke, bench or e2e helper, or
  `server/migration/verify-court-migration.ts:55` (`max: 1`, one-shot). None of
  them sets `idle_timeout`, and none needs to match. Nothing in `apps/web/src`
  keeps session-scoped state on the pool (no session advisory locks, no
  `reserve()`, no `LISTEN`, no session `set role`), so a longer idle life leaks
  nothing.

## 3. Issues

### Important

- **`apps/web/src/lib/db.ts:40-43`, and the commit message: the stated safety
  argument is false.** Both `fly.toml:34-38` and `fly.stg.toml:30-34` run an
  HTTP check on `/api/health` every **30 s**. `app/api/health/route.ts:5`
  runs `select 1` on the pooled `sql`. So on any started machine the pool is
  touched at least every 30 s. With `idle_timeout` 60 it can **never** drain,
  however long Fly waits before suspending. Every suspend (prod peers above
  `min_machines_running = 1`, `fly.toml:21-23`, and every stg machine,
  `fly.stg.toml:23` `min_machines_running = 0`) freezes at least one open
  backend connection, plus any opened by traffic in the 60 s before. At 20 s
  this already happened on about 2/3 of suspends (the last check was under 20 s
  ago). T3 makes it every suspend.

  What a frozen socket costs, not observed:
  - (a) It keeps a server backend slot until resume, or until the server
    reaps it. Project memory `project_prod_db_connection_budget` puts that at
    about 39 min (keepalive), and the slot counts against the 57-slot budget.
    It matters most when a deploy destroys suspended machines while their
    replacements open fresh pools.
  - (b) A wake-up after the server has reaped it sends the first query into a
    dead socket. postgres.js rejects the in-flight query and does not retry,
    so that one request fails with ECONNRESET / CONNECTION_CLOSED, or hangs if
    the packets are blackholed.

  **The real mechanism is also the real win.** At 20 s every 30 s health check
  reconnected: about 2,880 reconnects per started machine per day, which is
  most of the observed ~4.1k/day. At 60 s (any value above 30) that goes to
  zero.

  **Fix:**
  - Rewrite the `db.ts:35-47` comment and the plan's T3 basis with this
    mechanism (idle_timeout must stay above the 30 s health-check interval, and
    the pool never drains on a started machine).
  - Record it as a false premise in the Decisions block.
  - Put the trade back to the owner: a big churn cut against one frozen
    connection per suspended machine.
  - Suggested evidence before shipping: look in Sentry for
    CONNECTION_CLOSED / ECONNRESET clustered right after a machine resumes in
    the 20 s era. stg, which suspends constantly, is the canary after merge.

### Minor

- `db-options.test.ts:41-49`, `db-singleton.test.ts:45-52`: both pin the
  literal `60`, typed twice. That checks the constant against itself (a derived
  bound is a tautology), and it does not encode the rule that actually matters.
  Fix: derive the bound from its source. Parse the `/api/health` check
  `interval` from `fly.toml` and `fly.stg.toml` and assert `idleTimeout` is
  greater than it. That test turns red if someone lowers the timeout or slows
  the check, which is exactly how the churn would come back.
- `db-singleton.test.ts:51` checks that the options *object* does not carry
  `fetch_types: false`. postgres.js still turns it off from the URL:
  `?fetch_types=false` resolves to `false` (`index.js:474-475`). An explicit
  option always wins over the URL and env. Fix: pass `fetch_types: true`
  explicitly in `getClient()` (`db.ts:83-89`) and pin `=== true`. That makes
  the guard immune to a connection string nobody reviews.
- `db-singleton.test.ts:45`: the pass-through test cannot tell pass-through
  from a hardcoded `idle_timeout: 60` in `getClient()`, because
  `connectionOptions().idleTimeout` is a constant that ignores url and env.
  Not worth making it env-tunable just for this. Accept it as a pin rather
  than a seam proof.

## 4. Gap hunt

- **Connection budget at peak:** unchanged. `max` is still
  `DB_POOL_MAX` per machine (3 × 12 = 36 per project memory). `idle_timeout`
  only sets how long idle connections linger, so the change raises the baseline
  connection count, not the ceiling. The frozen-backend case above is the only
  way past that ceiling.
- **`max_lifetime`** still defaults to 30-60 min, randomised (`index.js:515`),
  so warm connections are still recycled. Nothing pins or needs to pin that.
- **Project memory `project_prod_db_connection_budget`** (another session's)
  says "idle_timeout empties the pool first" before a suspend. That was already
  wrong at 20 s, for the same health-check reason. It should be corrected at
  the source, but that is the orchestrator's call, not this reviewer's.
- **Docs:** no other doc cites the 20 s value except a historical plan
  (`docs/superpowers/plans/2026-07-12-perf-approach-a.md:127`). Nothing stale
  to fix.

---

# Re-review: follow-up commit a0610fd2c (2026-09-27)

Checked against the T3 findings above. The value (60) is owner-confirmed and
was not re-examined. Read-only, tests not run.

**Verdict: Needs fixes (comment only).** The derived bound, the parser and
the explicit `fetch_types: true` are right. One new claim is false, and two
claims are stated more strongly than the evidence supports.

## Earlier findings: status

| T3 finding | Status |
|---|---|
| False "60 s still drains the pool before a suspend" | **Fixed.** Removed from `db.ts` and the commit. The claim no longer appears anywhere in the committed tree. The new WHY is correct: `fly.toml:34-38` and `fly.stg.toml:30-35` check `/api/health` every `"30s"`, `app/api/health/route.ts:5` runs `select 1` on the `@/lib/db` pool, and stg has `min_machines_running = 0` (`fly.stg.toml:23`). |
| Tests pinned the literal 60 against itself | **Fixed.** `db-options.test.ts` and `db-singleton.test.ts` now `it.each` over both fly configs and assert `idleTimeout` is strictly greater than the interval read from the file. Lowering the timeout to 30 or slowing the check to 60 s fails them. The 60 s pin stays as a separately labelled owner decision, which is fine. |
| `fetch_types` could be turned off from the URL | **Fixed.** `db.ts` passes `fetch_types: true` explicitly, and `db-singleton.test.ts` pins `=== true`. postgres.js resolves `k in o` before the URL query and env (`index.js:474`), so the explicit option wins. |
| Pass-through can't be told from a literal | Accepted and documented in the test comment. Fine. |

## The parser (`__tests__/_fly-health-check.ts`)

- **Handles both files' real formatting.** Both have an indented
  `[[http_service.checks]]` header, space-padded `key = "value"` lines, a
  block that ends at `[[vm]]`, and no CRLF.
- **Throws rather than passing vacuously.** It throws on each of: a missing
  block, a changed `path`, a trailing comment, single quotes, a missing
  interval, and compound durations such as `"1m30s"`. `intervalS > 0` is also
  asserted. `REPO_ROOT` resolves to the repo root, five levels up from
  `apps/web/src/lib/__tests__`.
- **Not collected as a suite.** `apps/web/vitest.config.ts` sets no
  `include`, so vitest's default `**/*.{test,spec}.?(c|m)[jt]s?(x)` applies.
  What keeps it out is the lack of a `.test.`/`.spec.` suffix, not the
  underscore. It is the same convention as `_fake-lease-cache.ts` and `_seed.ts`.

## Issues

- **Minor.** `apps/web/src/lib/db.ts:62`,
  `lib/__tests__/db-singleton.test.ts:70` and the commit message say
  "`PGFETCH_TYPES` would turn it off". **That is false.** postgres.js reads the
  env var as `env['PG'+K] || default` (`index.js:476`) and leaves the string
  uncoerced, because `fetch_types` is not in `ints`. So `"false"` or `"0"` is a
  truthy string, `needsTypes` stays truthy, and types are fetched. Only a URL
  query param `false`/`disable` (`index.js:475`) turns it off. Fix: drop
  "(or PGFETCH_TYPES)" in both places.
- **Minor.** `db.ts:40-43` says "At 20 s every check found the pool drained
  … which (not user traffic) was the ~24.7k reconnects". Two problems: it is
  "every check" only on an otherwise idle machine, and 2,880 × 6 ≈ 17.3k of
  24.7k, so the attribution is "most of", not "all". Fix: say "on an idle
  machine, each check re-dialled … most of the ~24.7k".
- **Minor.** `db.ts:52-54`:
  - "~39 min — when the server reaps the idle backend" is really
    server-side TCP keepalive declaring a frozen peer dead, not idle reaping.
    The figure comes from session memory (1800 s + 9×60 s), not from anything
    in the repo.
  - The Sentry "zero issues over 90 days" drops the plan's own caveat: the
    unmerged `fix/sentry-server-instrumentation` branch means there may be
    capture gaps.

  Fix: word it as "server TCP keepalive (≈1800 s + 9×60 s probes, per the
  Supabase settings observed 2026-09-24)". Then either add the Sentry caveat
  or move the dated Sentry observation to the plan's Decisions block, since a
  dated metric in code goes stale.
- **Nit.** `_fly-health-check.ts:13` hard-codes the list of fly configs. A
  third web-app config (for example a preview app) would not be checked. Fix
  (optional): glob `fly*.toml` at the repo root, or assert that the list
  equals the glob result.
