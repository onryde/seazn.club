# Cloudflare Cron Triggers for the scheduled ops jobs — design

**Status:** approved by owner 2026-09-28. Plan: `docs/superpowers/plans/2026-09-28-cloudflare-cron-triggers.md`. Amendments made while planning are in §12.
**Scope:** Phase 1 only. Phases 2 and 3 of the wider "Cloudflare as the async layer" direction are parked (see §10).

## 1. Problem

Seven cron-shaped routes in `apps/web` are fired by GitHub Actions `schedule:` workflows in the separate repo `onryde/seazn.club.workflow` (moved there by #757, 2026-09-09). GitHub does not fire them on time, and the drops are invisible.

Measured 2026-09-27 from `gh run list -R onryde/seazn.club.workflow --event schedule`, week 2026-09-20..26:

| Workflow | Cron | Expected runs | Actual runs |
|---|---|---|---|
| Registrations Sweep | `37 * * * *` | 168 | **39** |
| Billing Events Sweep | `23 * * * *` | 168 | **38** |
| Funnel Reminders | `17 * * * *` | 168 | **37** |
| AI Preview Retention | `41 3 * * *` | 7 | 7, fired ~08:47 (**~5h late**) |
| Billing Quantity Reconcile | `41 6 * * *` | 7 | 7, fired ~12:00 (**~5h late**) |
| Billing AI Credit Grant | `17 7 * * *` | 7 | 7, fired ~12:40 (**~5.5h late**) |
| Weekly News Digest | `17 8 * * 1` | 1 | 1 |

Every run that fired concluded `success`, so the Actions tab shows green throughout. (Workflow names gained or lost a ` STAGE` suffix on 09-25; the counts above combine both names.)

**What a customer feels today:**
- Registration T-24h payment reminders, expiry of unpaid entries, and waitlist promotion run roughly every 4h, not hourly.
- Stuck Stripe webhook events are repaired roughly every 4h.
- Funnel draft reminders run roughly every 4h.
- The daily AI-credit grant lands around lunchtime UTC rather than at 07:17.

## 2. Goals and non-goals

**Goals**
1. Each job fires on its intended cadence. Pass bar: ≥ 23 runs per 24h for each hourly job, and each daily job starts within 15 minutes of its slot.
2. A missed or late run raises an alert. It must never be silent.
3. No route behaviour changes, except the news-digest weekly guard (§5).
4. A route that exists with no schedule fails CI.

**Non-goals**
- Moving `simulation-nightly.yml` (monthly, 180 min, checks out the source repo with a PAT) or `help-shots.yml`. Both stay on GitHub Actions.
- Any change to how the Next app on Fly runs the job bodies.
- Stripe webhook queueing. Dropped: the route already has an atomic exactly-once claim (`runEvent`), returns 5xx so Stripe retries for up to 3 days, and can be replayed from `/admin/billing-events`. A queue would add a moving part without adding reliability.

## 3. Architecture

```
Cloudflare Cron Trigger (hourly, :17)
  └─ Worker seazn-cron-{stg|prod}  (apps/cron-worker)
       ├─ schedule table → jobs due at this firing
       ├─ for each job, sequentially:
       │    Sentry check-in (in_progress)
       │    POST https://{host}/api/... with x-cron-secret
       │    Sentry check-in (ok | error)
       └─ one structured log line per job
            ▼
Next app on Fly (unchanged routes) → Postgres
```

- **Location:** a new pnpm workspace `apps/cron-worker` (owner ruling 2026-09-28: this repo, not the workflow repo). `pnpm-workspace.yaml` already globs `apps/*`.
- **Deployments:** one Worker per environment via wrangler `env`: `seazn-cron-stg` → `https://stg.seazn.club`, `seazn-cron-prod` → `https://seazn.club`.
- **Triggers:** one cron trigger per Worker, `17 * * * *`. That is 2 triggers per account, within the Workers Free limit of 5.
- **Cloudflare has no database access.** The Worker holds only its cron secret and a Sentry DSN, and sends no data to the app beyond the POST itself.

### Platform limits relied on (developers.cloudflare.com, read 2026-09-28)

| Limit | Free | Paid | This design |
|---|---|---|---|
| Cron triggers per account | 5 | 250 | 2 |
| CPU per invocation | 10 ms | 30 s default | a few ms; waiting on `fetch` does not count |
| Wall time per cron invocation | 15 min | 15 min | worst case ≈ 7 jobs × 60 s + retries |
| Subrequests per invocation | 50 | 10,000 | worst case 7 POSTs + 14 retries + 14 check-ins = 35 |

Start on Workers Free. If the CPU limit is ever hit (`exceededCpu` in Workers metrics), move to Workers Paid ($5/month). The code does not change.

## 4. The schedule table

This is a single typed constant in `apps/cron-worker/src/schedule.ts`, and it is the only place a schedule is declared. Times are UTC.

| id | Path | Due when (firing at HH:17) | Retry |
|---|---|---|---|
| `registrations` | `/api/cron/registrations` | every firing | yes |
| `billing-events` | `/api/cron/billing-events` | every firing | yes |
| `funnel-remind` | `/api/funnel/remind` | every firing | yes |
| `ai-previews` | `/api/cron/ai-previews` | HH = 03 | yes |
| `billing-quantity` | `/api/cron/billing-quantity` | HH = 06 | yes |
| `billing-grant` | `/api/cron/billing-grant` | HH = 07 | yes |
| `news-digest` | `/api/cron/news-digest` | Monday and HH = 08 | **never** |

- `dueJobs(scheduledTime: Date)` is a pure function over this table, and it is the unit under test.
- The firing time comes from `event.scheduledTime`, not from `Date.now()`, so a late-starting invocation still selects the slot it was scheduled for.
- The old per-workflow minute offsets (:23, :37, :41) existed to avoid GitHub's top-of-hour congestion. They do not matter on Cloudflare, so everything moves to :17.

## 5. Calling the app

- **Request:** `POST {BASE_URL}{path}` with header `x-cron-secret: {CRON_SECRET}` and an empty body. This is exactly what the curl steps send today; the route guards are unchanged (503 when the secret is unset, then 401 on mismatch).
- **Secrets:** a Worker secret `CRON_SECRET` per environment, set with `wrangler secret put --env stg|prod`. It must equal that Fly app's `CRON_SECRET` (`fly.stg.toml` = `seazn-club-stg`, `fly.toml` = `seazn-club-prod`), which is the same mirroring rule as today.
- **Per-job timeout:** 60 s, the same as today's `--max-time 60`, enforced by `AbortSignal.timeout`.
- **Retry policy** (tighter than today's `--retry 2 --retry-all-errors`):
  - Retry at most 2 times, with 2 s then 8 s backoff, **only** on a network error before a response, or on HTTP 502/503/504.
  - **Never** retry after a timeout: the server may already be running the job.
  - Never retry any job whose `retry` is `never`.
  - Never retry on a 4xx.
- **One failure does not stop the rest.** Jobs run sequentially and each result is recorded on its own.

### The news-digest weekly guard

`/api/cron/news-digest` is deliberately not idempotent (P3/D7). Its docstring says the weekly schedule is the only thing preventing duplicates, and every call creates a fresh draft per org. Today's workflow retries it on any error, so a slow run or dropped connection can already create up to 3 drafts per org. Moving schedulers is exactly when a double fire happens, so this phase adds a guard:

- **Rule:** at most one cron-originated weekly digest per org per ISO week (UTC).
- **Scope:** the cron path only. A console "generate digest" press must still create a fresh draft every time, since P3/D7 chose that on purpose. The guard must not swallow that press (AGENTS.md failure class 13: an idempotency guard that skips a legitimate new arrival).
- **Storage:** the implementation plan must read `sweepWeeklyDigests` / `generateWeeklyDigest` (`server/usecases/org-posts.ts`) and V358's `org_posts_auto_once` exemption before choosing where the guard lives. Per org is preferred over per run, so a sweep that crashed half-way can be re-run and finish the remaining orgs.
- **Tests, both directions:** a second cron call in the same ISO week creates no draft for an org that already has one; a console press after the cron call still creates one; a cron call in the following week creates one.

Even with the guard, the Worker never retries news-digest (defence in depth).

## 6. Observability: the absent-symptom guard

GitHub's failure mode was silence, so success signals alone are not enough.

- **Logs:** one JSON line per job with `{ env, job, scheduledTime, status, httpStatus, ms, attempts }`, via Workers Logs (`observability.enabled = true` in wrangler config).
- **Sentry Cron Monitors:** one monitor per job and environment (`cron-{env}-{job}`), each with the schedule from §4 and a check-in margin of 15 minutes. The Worker sends `in_progress` before the POST and `ok` or `error` after it, over Sentry's HTTP check-in endpoint (no SDK needed). Sentry alerts on **missed** and **late** check-ins as well as errors. That covers "the scheduler itself stopped", which no in-Worker log can report.
- **Open item (owner):** confirm the Sentry plan includes Crons monitors. Fallback if it does not: a `lastRunAt` per job, written by each route on success and surfaced as a `cron` block in `/api/health`, with an external uptime check alerting when any is older than twice its cadence.

## 7. Cutover

There must never be two schedulers for one environment at the same time, because of news-digest; the guard in §5 is a backstop, not permission to overlap.

1. **Probe (staging):** deploy `seazn-cron-stg` with an empty schedule plus `wrangler dev --test-scheduled` against staging, and confirm a Worker `fetch` to `https://stg.seazn.club/api/cron/ai-previews` gets the app's 200 rather than a Cloudflare challenge. The zone runs `browser_check: on` and `security_level: medium`. If it is challenged, switch `BASE_URL` to `https://seazn-club-stg.fly.dev`, after checking that the app serves that Host without redirecting to the canonical domain.
2. **Staging switch:** in the workflow repo, disable the staging legs. `gh workflow disable` keeps the files, so rollback is `gh workflow enable`. Each workflow holds both legs, so this means splitting each workflow into `-stg` and `-prod` files first, or gating the staging job behind a repo variable. Then deploy the full schedule to `seazn-cron-stg`.
3. **Staging soak, 72 h.** Pass means: ≥ 23 runs per 24h for each hourly job (from Sentry check-ins or Workers Logs), each daily job within 15 minutes, no error check-ins that aren't explained, and no duplicate digest.
4. **Production switch:** the same as step 2 for the prod legs, then a 72 h soak with the same bar.
5. **Cleanup:** delete the moved workflow files from `onryde/seazn.club.workflow`. Fix the stale "scheduled by `.github/workflows/...`" comments in the seven route files to point at `apps/cron-worker/src/schedule.ts`. Update the `reference_scheduled_cron_workflows_live_in_a_separate_repo` note.

**Rollback at any step:** remove the Worker's trigger (`"crons": []` and redeploy) and `gh workflow enable` the legs. Both take effect within minutes.

**Deploy:** a `cron-worker` job added to `prod.yml` (tag-triggered, like the app) and `stg.yml`, running `wrangler deploy --env prod|stg` with a scoped `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit on the Seazn Club account only). The implementation plan re-reads both workflow files before editing, since their triggers have changed before (see AGENTS.md on `e2e.yml`).

## 8. Testing

All four test types required by `docs/superpowers/RULES.md`:

| Type | What | Where |
|---|---|---|
| Unit | `dueJobs` for every hour of a week, including Monday 08, the three daily hours and a non-Monday 08. Retry policy: 502/503/504 and pre-response network errors retry; timeouts, 4xx and `news-digest` never do. | `apps/cron-worker` vitest |
| Drift guard | Every `apps/web/src/app/api/cron/*/route.ts`, plus `api/funnel/remind`, appears exactly once in the schedule table, and every table path resolves to a route file. Mutate the table (drop a row) and the test must go red. | `apps/cron-worker` vitest, reading the `apps/web` tree |
| Integration / E2E | `scheduled()` run through `@cloudflare/vitest-pool-workers` against a stub origin: correct header, sequential order, one 500 does not stop later jobs, check-ins bracket each POST. Then against a **local prod build** of the app (`seazn-local-env`), via `wrangler dev --test-scheduled` at a registrations-due slot: assert the real side effect in the DB (`reminded_at` stamped on a seeded pay-pending entry). This proves the seam through its real producer and consumer. | worker tests + one scripted local run |
| Regression | news-digest weekly guard, both directions (§5). | `apps/web` vitest, DB-backed |
| Smoke | After each deploy: a `wrangler`-triggered run of one idempotent job (`ai-previews`) against the target env returns 200, and its Sentry check-in shows `ok`. | deploy job step |

Per AGENTS.md: judge vitest green only from `--reporter=json` (`numPassedTests`/`numTotalTests`) and confirm `.testResults[].name`; run from `cd apps/cron-worker`.

## 9. Risks and open verifications

| # | Risk / unknown | Resolved by |
|---|---|---|
| R1 | The zone challenge catches Worker-originated requests | §7 step 1 probe; fallback to the `*.fly.dev` host |
| R2 | Sentry plan lacks Crons | Owner confirms; fallback in §6 |
| R3 | Workers Free CPU limit (10 ms) exceeded | Workers metrics `exceededCpu`; move to Paid ($5/month), no code change |
| R4 | Cloudflare delivers a cron firing twice or late | `scheduledTime`-keyed slot selection; every retryable job is already idempotent (route docstrings); news-digest guard |
| R5 | Secret mismatch between Worker and Fly | A 401 shows as an `error` check-in and alerts, unlike today's skip-with-warning |
| R6 | A job body exceeds 60 s | Timeout reports `error` and is not retried; alert; investigate the job, not the scheduler |

## 10. Parked (not in this phase)

Recorded so the findings are not lost. Owner ruling 2026-09-28: Phase 1 only for now.

- **Phase 2: a Fly process group for CPU-heavy jobs** (PDF, Excel, OG). This is **blocked** on the shared Redis `cacheHandler` work (branch `docs/shared-redis-cache-handler`), which the owner is parking. Until it ships, cache invalidation from a separate process group depends on peer-revalidate, which is unverified for process groups and is deleted by that work's PR 2. Do not build invalidation on `/api/internal/revalidate`.
- **Phase 3: AI plan as a job** (Cloudflare Workflows, a `jobs` row, Realtime status, HMAC-signed calls to `/api/internal/jobs/*`). Optional. Finding to carry forward: the AI plan allows up to 600 s per LLM round (`schedule-ai.ts:1781`, `ROUND_TIMEOUT_MS`), while Cloudflare's proxy read timeout is 125 s (524, not configurable below Enterprise). A run longer than 125 s would fail at the edge while the server keeps spending credits, and the plan exists only in the HTTP response. **Not yet measured:** whether real runs exceed 125 s. Measure from `competition_events` (`schedule.ai_generated`) and Cloudflare 524 counts before prioritising.
- **Out, with reasons:** Supabase Edge Functions (2 s CPU, Deno, second runtime), Hyperdrive (consumes the ~57-connection budget), OG images on Workers (edge caching covers most of the benefit), Stripe queue (§2).

## 11. False premises found while designing

- "The Stripe webhook needs a queue for reliability": false. See §2.
- "Cron routes are scheduled by in-repo workflows": false since #757. Route docstrings still say so (for example `news-digest/route.ts:17` cites `.github/workflows/news-digest-stg.yml`).
- "The scheduled jobs run hourly": false in practice. See §1.

## 12. Plan-time amendments (2026-09-28)

These were found while writing the plan. Each keeps the approved intent.

1. **`ACTIVE` gate plus a reachability probe.** Each Worker env carries `ACTIVE: "false"` until its cutover. While it is inactive, the hourly firing only sends `GET {BASE_URL}/api/health` and logs the status. That answers §9 R1 (does the zone challenge a Worker?) from real Cloudflare infrastructure for days before any job moves, and makes cutover a one-line reviewed PR (`ACTIVE: "true"`) instead of an out-of-band deploy.
2. **Manual run endpoint** (`POST /run?job=<id>` on the Worker's workers.dev host, `x-cron-secret` required). This keeps the `workflow_dispatch` manual rerun the GitHub workflows offer today, and it is how the post-deploy smoke in §8 runs; wrangler cannot trigger a deployed Worker's cron on demand. `news-digest` refuses a manual run (403): a manual digest is the console button's job.
3. **Run deadline.** Stop starting new attempts 12 min into an invocation (cron wall limit 15 min). A job skipped this way reports an `error` check-in with reason `deadline`, never silence.
4. **Worker tests run in plain Node vitest**, not `@cloudflare/vitest-pool-workers`. The Worker's logic is pure functions over injected `fetch`/`sleep`/`now`; `scheduled()` and `fetch()` are thin wrappers. Runtime parity is covered by the local E2E through `wrangler dev --test-scheduled` (§8), which runs the real workerd runtime.
5. **Digest guard mechanism** (§5 left it to the plan). The cron path stamps `auto_source.origin = "cron"` and `auto_source.cron_week = "<ISO week, UTC>"` (for example `2026-W40`). A new partial unique index `org_posts_digest_cron_once (org_id, auto_source->>'cron_week') where trigger = 'weekly_digest' and auto_source ? 'cron_week'` blocks a second cron digest in the same week, and the insert names that index as its `on conflict` arbiter. Console presses carry no `cron_week` key, so the index never sees them. `digestWindow` is a rolling `[now-7d, now)` window, so `window_start` could not serve as the weekly key.
6. **CI:** `ci.yml` never collects a new workspace's tests. The `gates` job gains a `pnpm --filter @seazn/cron-worker test` step. Typecheck is already covered because `npx turbo run typecheck` picks up any workspace with a `typecheck` script.
