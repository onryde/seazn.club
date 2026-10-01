# Cloudflare Cron Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Branch note: B0 (done, separate review).** This branch also carries batch B0. It consists of four stream fixes, `9c14e2909`, `7f9764de6`, `9a1994b7b` and `b73abe309`, plus that batch's own review follow-ups (`b3eeb5b79`, `585a31433`, `54059e0c0`, `946b04913` and `5e00acd38` as of 2026-10-01, and any later `(stream)` commit). They are already committed and are reviewed separately. They touch seven files: `apps/web/src/server/relay/ingest-cf.ts`, `apps/web/src/server/relay/__tests__/ingest-cf.test.ts`, `apps/web/src/app/directory/page.tsx`, `apps/web/src/app/directory/__tests__/streaming-tab.test.tsx`, `apps/web/src/server/usecases/stream-sessions.ts`, `apps/web/src/server/usecases/__tests__/stream-sessions.test.ts` and `apps/web/src/app/api/v1/orgs/[id]/stream-targets/__tests__/target-route.test.ts`. **Executors of this plan do not edit those seven files**, and do not rebase, squash, reorder or revert any B0 commit. Confirm the set before Task 1 with `git log --oneline origin/main..HEAD -- apps/web/src/server/relay apps/web/src/server/usecases/stream-sessions.ts apps/web/src/app/directory apps/web/src/app/api/v1/orgs`.

**Goal:** Fire the scheduled ops routes from a Cloudflare Worker instead of GitHub Actions `schedule:`. That covers the 7 routes GitHub fires today, plus `relay-sweep`, which nothing schedules today (R1). The Worker must fire on time, report every failed run, and never double-fire the non-idempotent news digest.

**Architecture:** A new workspace `apps/cron-worker` is deployed as two Workers (`seazn-cron-stg`, `seazn-cron-prod`), each with one hourly trigger at `:17`. A pure schedule table, keyed on the firing trigger and the scheduled time, picks the due jobs. Each job is a `POST` with `x-cron-secret` to the unchanged Next routes, and it writes one log line. A job that fails, or a money job whose `200` body reports failures (R3), also sends one Sentry **error event** tagged with the job. Sentry cron monitors are **deferred** (owner, 2026-10-01; see "Deferred" at the end). The news digest gets a DB-enforced once-per-ISO-week guard on its cron path only.

**Tech Stack:** Cloudflare Workers (wrangler, `wrangler.json`), TypeScript, vitest ^4.1.11 (Node environment), postgres.js (E2E only), Flyway SQL migration, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md`. Read §1–§13. §12 lists the plan-time amendments and §13 the pre-flight amendments and rulings (2026-10-01), which supersede the sections they name.

**Pre-flight review (2026-10-01):** `.superpowers/sdd/2026-09-28-cloudflare-cron-triggers/preflight.md` (gitignored, local to this worktree). Where its items landed:

| Item | Landed in |
|---|---|
| A1 V419 → V429 | Task 7, Task 8 |
| A2 `container` job via `.dockerignore` | Task 1 (the line), Task 6 (its guard), Task 9 (read the PR's `container` job) |
| A3 manual runs and Sentry | Superseded: no check-ins exist at all. Tasks 4 and 5 prove the Worker never calls a Sentry check-in endpoint |
| A4 drift test includes relay-sweep, floors at the measured counts | Task 6 |
| A5 `news.spec.ts` as a whole file | Task 7 |
| A6 relay-sweep comment and stale test titles | Task 8 |
| A7 smoke retries plus `::warning::` | Task 9 |
| A8 pinned `__scheduled` time plus process-group kill | Task 10 |
| A9 the 60 s premise | Global Constraints; spec §5 |
| m1 body read in its own try | Task 2 |
| m2 `User-Agent` | Tasks 2, 4 |
| m3 drift sweep by `x-cron-secret` | Task 6 |
| m4 `return null` vs `throw` | Task 7 |
| m5 ISO-week oracle note, single-sport reason | Task 7 |
| m6 `@types/node@^26` | Task 1 |
| m7 dry-run expectation | Task 9 |
| m8 typecheck after each TS task | Tasks 2–6, 10 |
| m9 lint scope | Self-review notes |
| R1 relay-sweep daily 04:17, no retry, manual allowed | Task 1 |
| R2 news-digest manual allowed, no retry | Tasks 1, 5 |
| R3 money jobs' in-body failures → error event | Tasks 1, 2, 4 |
| R4 `dueJobs(scheduledTime, cron)` | Tasks 1, 4, 5, 6 |
| R5 Sentry cron monitors: deferred | "Deferred" section; error events in Tasks 3, 4 |

## Global Constraints

- pnpm `10.34.5`, Node `>=26`. The workspace glob `apps/*` already exists in `pnpm-workspace.yaml`.
- TypeScript typecheck via `node ../../node_modules/typescript-native/bin/tsc --noEmit` (TS7), the same shape as `apps/web/package.json:10-14`.
- **Triggers (R4).** Each `JOBS` row names the trigger that fires it. Each Worker env registers exactly the distinct triggers of `JOBS`, which the drift test pins. Today there is one, `17 * * * *`, so the account uses 2 of the 5 triggers Workers Free allows. Capture-QR v2's `*/5 * * * *` would make it 4 of 5.
- **Per-job HTTP timeout: `60_000` ms.** This is **not** "the same as today" (A9). Today's `--max-time` is 60 s for registrations, funnel and news, 120 s for ai-previews and billing-events, and 300 s for billing-quantity and billing-grant. Measured runs take 8–25 s including runner setup, so 60 s is adequate. relay-sweep has never been scheduled, so its duration is unmeasured; read its first runs during the soak (Task 11).
- **Retries.** At most 2 retries, with `2_000` ms then `8_000` ms backoff, **only** on HTTP 502/503/504 or a thrown non-timeout network error that happens before any response, and only for rows with `retry: true`. Never retry `news-digest` (P3/D7) or `relay-sweep` (R1). Never retry a timeout or a 4xx. Once a response has arrived, its status alone decides, even if its body then fails to read (m1).
- Run deadline: `12 * 60_000` ms per invocation (the cron wall limit is 15 min).
- **Request headers:** `x-cron-secret`, and `user-agent: seazn-cron/1 (<ENV_NAME>)` on every job and on the probe. The zone runs Browser Integrity Check, which challenges a request that has no UA (m2).
- **R3 (owner, 2026-10-01).** A `200` from `billing-events`, `billing-quantity` or `billing-grant` whose named failure counters read above 0, or cannot be read, is `degraded`. A degraded job is never `ok`.
- **Sentry (R5: owner, 2026-10-01; cron monitoring deferred).** The Worker sends **no** check-ins and creates **no** monitors. When `SENTRY_DSN` is set, every job that is not `ok` (`error`, or `degraded` under R3) sends exactly one Sentry **error event** over the envelope endpoint, tagged `job`, `reason`, `run` (`scheduled`|`manual`) and `http_status`. It goes to the same project and DSN as the Fly app's own reporting, and it carries no response body (the `lib/sentry.ts` PII rule: ids and counts only). Event sends are best-effort: 5 s timeout, never throw, never block a job.
- **The run log.** Each job writes one `event:"job"` line. Each run writes one closing `event:"run"` line with `sentry: "on" | "off" | "misconfigured"`, so a missing DSN shows in the log rather than as silence.
- **Env vars per Worker env:** `ENV_NAME` (`stg`|`prod`), `BASE_URL`, `ACTIVE` (`"true"`|`"false"`, default `"false"`). **Secrets:** `CRON_SECRET`, plus `SENTRY_DSN`, which is required on prod and recommended on stg.
- **Never two schedulers per environment.** `ACTIVE` flips to `"true"` only after that environment's GitHub legs are gated off (Task 11).
- **Cloudflare writes: `STOP: owner OK required`.** Every step that writes to Cloudflare carries this marker. That covers the API token, every `wrangler secret put`, every deploy (including the merge to `main` and the `v*.*.*` tag, since they trigger `stg.yml` and `prod.yml`), every `BASE_URL` change, every `ACTIVE` flip, the rollback, and `wrangler tail`, which opens a tail session through the API. The dashboard's Workers Logs view is the read-only alternative to `wrangler tail`. An implementer who reaches a marked step stops and reports; it never runs the step. `wrangler deploy --dry-run` and local `wrangler dev` (never `--remote`) make no API calls and need no OK.
- **B0 files are out of bounds** (see the branch note above).
- Subagents run only the test files they changed. Do **not** run `apps/web` `tsc`/`lint` locally; CI covers it (`docs/superpowers/RULES.md`). The cron-worker's own `pnpm --filter @seazn/cron-worker typecheck` is cheap and allowed, and it is **owed after every task that adds or changes a `.ts` file under `apps/cron-worker`** (m8).
- Judge vitest green only from `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`), and confirm `.testResults[].name` shows the intended files (AGENTS.md "Verification traps"). A positional path that does not exist is silently ignored, so count the files listed.
- Every shell call is prefixed `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron &&`. The shell cwd resets between calls.
- Mutation checks restore from a `cp` backup, never `git checkout <file>`.

## Review Focus

1. **A cron firing arrives late** (invoked 09:02 for the 08:17 slot). It must still select the 08:17 slot's jobs. `dueJobs` keys on `scheduledTime`, not `Date.now()`; tested in Task 1.
2. **A secret mismatch** between the Worker and Fly (a 401 from the route). This must produce an `error` result, a log line and one error event, never a skip. Tested in Tasks 2 and 4.
3. **Sentry unreachable, or no DSN.** Jobs must still run and results must still log; the `event:"run"` line names the Sentry state. Tested in Tasks 3 and 4.
4. **Double fire of the Monday 08:17 slot**, from Cloudflare redelivery or an overlap during cutover. At most one cron digest per org, while a console press still creates one. Tested in Task 7.
5. **The manual `/run` endpoint** called with a missing, empty or wrong secret, an unknown job, or a `manual: false` row. It must return 401/404/403 and must never run the job. `news-digest` is runnable by hand (R2) but never retried. Tested in Task 5.
6. **A money job that answers `200` with failures inside** (R3). It must be `degraded`, never `ok`, and it must raise an error event, including when the counter sits past the 500-character log excerpt. Tested in Tasks 2 and 4.
7. **A second trigger** (R4). It must run only its own rows (never news-digest at Monday 08:05), never probe, and an unknown trigger must be refused by name. Tested in Tasks 1, 4 and 6.
8. **No cron monitoring** (R5 deferred). The Worker must never call a Sentry check-in endpoint. A week-long sweep in Task 4 and the manual path in Task 5 prove it.

---

### Task 1: Scaffold `apps/cron-worker` with the schedule table and `dueJobs`

**Files:**
- Create: `apps/cron-worker/package.json`
- Create: `apps/cron-worker/tsconfig.json`
- Create: `apps/cron-worker/vitest.config.ts`
- Create: `apps/cron-worker/src/schedule.ts`
- Test: `apps/cron-worker/test/schedule.test.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)
- Modify: `.dockerignore` (A2)
- Modify: `apps/web/src/__tests__/toolchain.test.ts` (m6: the cron-worker joins the `@types/node` major check)

**Interfaces:**
- Produces:
  - `type Due = { kind: "every" } | { kind: "daily"; hourUtc: number } | { kind: "weekly"; weekdayUtc: number; hourUtc: number }`. `every` means every firing of the row's own trigger.
  - `interface Job { id: string; path: string; trigger: string; due: Due; retry: boolean; manual: boolean; failureCounts?: readonly string[] }`
  - `const TRIGGER_CRON = "17 * * * *"` (the hourly trigger)
  - `const JOBS: readonly Job[]` (8 rows)
  - `function triggersOf(jobs?: readonly Job[]): string[]`
  - `function dueJobs(scheduledTime: Date, cron: string, jobs?: readonly Job[]): Job[]`
- `id` is a plain `string`, not a union, so a new job is one row and nothing else (R4).

- [ ] **Step 1: Create the package files**

`apps/cron-worker/package.json`:
```json
{
  "name": "@seazn/cron-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "node ../../node_modules/typescript-native/bin/tsc --noEmit",
    "dev": "wrangler dev --test-scheduled",
    "deploy:stg": "wrangler deploy --env stg",
    "deploy:prod": "wrangler deploy --env prod"
  },
  "devDependencies": {}
}
```

`apps/cron-worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2024"],
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

`apps/cron-worker/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

Then append to the repo-root `.dockerignore` (A2):
```
# apps/cron-worker never ships in the Fly image, and the builder stage never
# installs its devDependencies (wrangler, workers-types): the Dockerfile copies
# only the web/engine/reference manifests before `pnpm install`. Left in the
# context, ci.yml's container job (`turbo run typecheck` inside the image)
# would fail on it with TS2688.
apps/cron-worker
```

- [ ] **Step 2: Extend the toolchain guard, and watch it fail (m6)**

In `apps/web/src/__tests__/toolchain.test.ts`, in the test currently titled `"@types/node tracks the runtime major in both workspaces"`, change the list `["apps/web", "packages/engine"]` to `["apps/web", "packages/engine", "apps/cron-worker"]`, and retitle the test `"@types/node tracks the runtime major in every TS workspace"`. Change nothing else in that file.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t1-tool.json src/__tests__/toolchain.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].assertionResults[] | select(.status=="failed") | .title]' /tmp/cw-t1-tool.json
```
Expected: exactly the retitled test fails, on `apps/cron-worker @types/node` (`undefined`, expected `^26`).

- [ ] **Step 3: Install the dev dependencies**

Use the latest wrangler and workers-types. vitest is pinned to match `apps/web`, and `@types/node` to the runtime major:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && pnpm --filter @seazn/cron-worker add -D wrangler @cloudflare/workers-types vitest@^4.1.11 @types/node@^26 postgres
```

Then open `apps/cron-worker/package.json`. `"@types/node"` must read exactly `"^26"`, because `toolchain.test.ts` compares the string. If pnpm wrote a longer range, set it to `^26` by hand and re-run `pnpm install` so the lockfile agrees. Re-run the Step 2 command. Expected: the passed and total counts are equal. Record the resolved wrangler version in the commit message.

If `tsc` later reports duplicate global declarations between `@cloudflare/workers-types` and `@types/node`, drop `"node"` from `types`. Then add `/// <reference types="node" />` at the top of only the tests that use `node:fs`/`node:child_process` (`drift.test.ts`, `e2e.local.test.ts`).

- [ ] **Step 4: Write the failing test**

`apps/cron-worker/test/schedule.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { JOBS, TRIGGER_CRON, dueJobs, triggersOf, type Job } from "../src/schedule";

// Expected values come from the spec's table (§4) and the 2026-10-01 rulings
// (§13), never from JOBS itself.
const at = (iso: string) => new Date(iso);
const ids = (d: Date, cron = TRIGGER_CRON, jobs: readonly Job[] = JOBS) => dueJobs(d, cron, jobs).map((j) => j.id);
const HOURLY = ["registrations", "billing-events", "funnel-remind"];
const FAST = "*/5 * * * *";
// R4 fixture: the shape capture-QR v2's stream-tick will add. One row, its own trigger.
const TICK: Job = {
  id: "stream-tick",
  path: "/api/cron/stream-tick",
  trigger: FAST,
  due: { kind: "every" },
  retry: false,
  manual: true,
};

describe("dueJobs on the hourly trigger", () => {
  it("runs only the every-firing jobs at an ordinary hour", () => {
    expect(ids(at("2026-09-29T14:17:00Z"))).toEqual(HOURLY); // Tuesday
  });

  it("adds each daily job at its own hour, in table order", () => {
    expect(ids(at("2026-09-29T03:17:00Z"))).toEqual([...HOURLY, "ai-previews"]);
    expect(ids(at("2026-09-29T04:17:00Z"))).toEqual([...HOURLY, "relay-sweep"]); // R1
    expect(ids(at("2026-09-29T06:17:00Z"))).toEqual([...HOURLY, "billing-quantity"]);
    expect(ids(at("2026-09-29T07:17:00Z"))).toEqual([...HOURLY, "billing-grant"]);
  });

  it("runs news-digest on Monday 08 UTC and on no other day at 08", () => {
    expect(ids(at("2026-09-28T08:17:00Z"))).toEqual([...HOURLY, "news-digest"]); // Monday
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
      expect(ids(at(`${day}T08:17:00Z`))).toEqual(HOURLY);
    }
  });

  it("keys on the SCHEDULED hour: a late invocation still runs its own slot", () => {
    // Cloudflare hands a late invocation its slot's scheduledTime. Within the
    // hourly trigger, the minute is irrelevant.
    expect(ids(at("2026-09-28T08:59:59Z"))).toContain("news-digest");
    expect(ids(at("2026-09-28T09:00:00Z"))).not.toContain("news-digest");
  });

  it("over one full week: each every-firing job 168×, each daily 7×, the digest 1×", () => {
    const counts = new Map<string, number>();
    const start = Date.parse("2026-09-28T00:17:00Z"); // Monday
    for (let h = 0; h < 168; h++) {
      for (const id of ids(new Date(start + h * 3_600_000))) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      registrations: 168,
      "billing-events": 168,
      "funnel-remind": 168,
      "ai-previews": 7,
      "relay-sweep": 7,
      "billing-quantity": 7,
      "billing-grant": 7,
      "news-digest": 1,
    });
  });
});

describe("dueJobs is keyed on the firing trigger (R4)", () => {
  it("a trigger no row names selects nothing", () => {
    expect(ids(at("2026-09-28T08:05:00Z"), FAST)).toEqual([]);
    expect(ids(at("2026-09-28T08:17:00Z"), "")).toEqual([]);
  });

  it("a second trigger runs ONLY its own rows: never news-digest or an hourly row, even at Monday 08:05", () => {
    const withTick = [...JOBS, TICK];
    expect(ids(at("2026-09-28T08:05:00Z"), FAST, withTick)).toEqual(["stream-tick"]);
    expect(ids(at("2026-09-28T08:17:00Z"), TRIGGER_CRON, withTick)).toEqual([...HOURLY, "news-digest"]);
  });

  it("triggersOf lists each distinct trigger once; today only the hourly one (spec §3)", () => {
    expect(triggersOf()).toEqual(["17 * * * *"]);
    expect(triggersOf([...JOBS, TICK])).toEqual(["17 * * * *", FAST]);
  });
});

describe("JOBS table", () => {
  it("has unique ids and paths", () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    expect(new Set(JOBS.map((j) => j.path)).size).toBe(JOBS.length);
  });

  it("retry is off for exactly news-digest (P3/D7) and relay-sweep (R1); every job may be run by hand (R1, R2)", () => {
    expect(JOBS.filter((j) => !j.retry).map((j) => j.id)).toEqual(["relay-sweep", "news-digest"]);
    expect(JOBS.filter((j) => !j.manual)).toEqual([]);
  });

  it("every daily or weekly row hangs off the hourly trigger (on a faster one its hour test would pass every tick)", () => {
    const timed = JOBS.filter((j) => j.due.kind !== "every");
    expect(timed.map((j) => j.id), "rows checked").toEqual([
      "ai-previews",
      "relay-sweep",
      "billing-quantity",
      "billing-grant",
      "news-digest",
    ]);
    expect(timed.filter((j) => j.trigger !== TRIGGER_CRON)).toEqual([]);
  });

  it("R3: the money jobs name the exact failure counters of their 200 body", () => {
    // From the routes' return types inside lib/http.ts handler's { ok, data }
    // envelope: billing-events → sweepStuckEvents; billing-quantity →
    // reconcileGroupQuantities + sweepOrphanGroups + sweepStaleOrgAddonPrices;
    // billing-grant → grantMonthlyForAllWallets.
    const withCounts = Object.fromEntries(JOBS.filter((j) => j.failureCounts).map((j) => [j.id, j.failureCounts]));
    expect(withCounts).toEqual({
      "billing-events": ["data.failed", "data.alerted"],
      "billing-quantity": ["data.failed", "data.orphanGroups.failed", "data.addonPrices.alerted"],
      "billing-grant": ["data.failed"],
    });
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t1.json test/schedule.test.ts; jq '.numFailedTestSuites, .testResults[].message' /tmp/cw-t1.json
```
Expected: a suite failure, because `../src/schedule` cannot be resolved.

- [ ] **Step 6: Implement `src/schedule.ts`**

```ts
/**
 * The ONE place a scheduled job is declared. Each row names the Worker trigger
 * that fires it (`trigger`, mirrored in wrangler.json and pinned by
 * test/drift.test.ts) and when, among that trigger's firings, it is due.
 * `dueJobs` picks the rows for one firing. Times are UTC.
 *
 * Adding a job is one row here. If it brings a new trigger, add that cron to
 * both envs in wrangler.json; the drift test forces it. No other Worker code
 * changes (R4).
 * Spec: docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md §4, §13.
 */
export type Due =
  | { kind: "every" } // every firing of the row's own trigger
  | { kind: "daily"; hourUtc: number } // hourly trigger only
  | { kind: "weekly"; weekdayUtc: number; hourUtc: number }; // hourly trigger only

export interface Job {
  id: string;
  /** Route on the Next app, POSTed with `x-cron-secret`. */
  path: string;
  /** The cron expression of the Worker trigger that fires this row (R4). */
  trigger: string;
  due: Due;
  /** Safe to re-send after a 502/503/504 or a network error (the route is idempotent). */
  retry: boolean;
  /** May be run on demand through the Worker's `POST /run?job=`. */
  manual: boolean;
  /**
   * R3 (owner 2026-10-01): dotted paths into the route's 200 JSON body that
   * count failures. One above 0, or one that cannot be read, makes the run
   * `degraded`: never ok, and one Sentry error event.
   */
  failureCounts?: readonly string[];
}

/** The hourly trigger. Daily and weekly rows hang off it, and it alone runs the inactive probe. */
export const TRIGGER_CRON = "17 * * * *";

export const JOBS: readonly Job[] = [
  { id: "registrations", path: "/api/cron/registrations", trigger: TRIGGER_CRON, due: { kind: "every" }, retry: true, manual: true },
  {
    id: "billing-events",
    path: "/api/cron/billing-events",
    trigger: TRIGGER_CRON,
    due: { kind: "every" },
    retry: true,
    manual: true,
    failureCounts: ["data.failed", "data.alerted"],
  },
  { id: "funnel-remind", path: "/api/funnel/remind", trigger: TRIGGER_CRON, due: { kind: "every" }, retry: true, manual: true },
  { id: "ai-previews", path: "/api/cron/ai-previews", trigger: TRIGGER_CRON, due: { kind: "daily", hourUtc: 3 }, retry: true, manual: true },
  // R1 (owner 2026-10-01): daily 04:17. Never retried: a re-send after a 5xx can
  // overlap a pass still alive server-side, and the sweep's overlap safety
  // (per-session advisory locks) is unproven. A missed day costs nothing,
  // because the sweep owns nothing time-critical (relay-sweep.ts:2-3).
  { id: "relay-sweep", path: "/api/cron/relay-sweep", trigger: TRIGGER_CRON, due: { kind: "daily", hourUtc: 4 }, retry: false, manual: true },
  {
    id: "billing-quantity",
    path: "/api/cron/billing-quantity",
    trigger: TRIGGER_CRON,
    due: { kind: "daily", hourUtc: 6 },
    retry: true,
    manual: true,
    failureCounts: ["data.failed", "data.orphanGroups.failed", "data.addonPrices.alerted"],
  },
  {
    id: "billing-grant",
    path: "/api/cron/billing-grant",
    trigger: TRIGGER_CRON,
    due: { kind: "daily", hourUtc: 7 },
    retry: true,
    manual: true,
    failureCounts: ["data.failed"],
  },
  // NOT idempotent by design (P3/D7): never retried. A manual run IS allowed
  // (R2): the cron_week guard (org-posts.ts, V429) lets it fill only the orgs
  // still missing this ISO week's cron digest.
  {
    id: "news-digest",
    path: "/api/cron/news-digest",
    trigger: TRIGGER_CRON,
    due: { kind: "weekly", weekdayUtc: 1, hourUtc: 8 },
    retry: false,
    manual: true,
  },
];

/** Every distinct trigger the table uses: what wrangler.json must register. */
export function triggersOf(jobs: readonly Job[] = JOBS): string[] {
  return [...new Set(jobs.map((j) => j.trigger))];
}

function isDue(due: Due, t: Date): boolean {
  switch (due.kind) {
    case "every":
      return true;
    case "daily":
      return t.getUTCHours() === due.hourUtc;
    case "weekly":
      return t.getUTCDay() === due.weekdayUtc && t.getUTCHours() === due.hourUtc;
  }
}

/** The rows one firing runs, in table order. The firing TRIGGER picks the
 *  candidate rows (R4); the SCHEDULED time picks the slot, so a late
 *  invocation still runs its own slot's jobs. */
export function dueJobs(scheduledTime: Date, cron: string, jobs: readonly Job[] = JOBS): Job[] {
  return jobs.filter((j) => j.trigger === cron && isDue(j.due, scheduledTime));
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t1.json test/schedule.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t1.json
```
Expected: `12`, `12`, and the path ending `apps/cron-worker/test/schedule.test.ts`.

- [ ] **Step 8: Mutation checks, one at a time, each restored from a `cp` backup.**
  - Change news-digest's `weekdayUtc: 1` to `2`. Expected: the Monday test and the week-count test go red.
  - Delete `j.trigger === cron &&` from `dueJobs`. Expected: both "selects nothing" and "a second trigger" go red. This is the R4 seam.
  - Set relay-sweep's `retry` to `true`. Expected: the retry test goes red.

- [ ] **Step 9: Typecheck the package**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && pnpm --filter @seazn/cron-worker typecheck; echo EXIT=$?
```
Expected: `EXIT=0`.

- [ ] **Step 10: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker pnpm-lock.yaml .dockerignore apps/web/src/__tests__/toolchain.test.ts && git commit -m "feat(cron-worker): scaffold workspace with the trigger-keyed schedule table"
```

---

### Task 2: `callJob`, the HTTP call with the retry policy and the R3 read

**Files:**
- Create: `apps/cron-worker/src/call.ts`
- Test: `apps/cron-worker/test/call.test.ts`

**Interfaces:**
- Consumes: `Job` from `src/schedule.ts`.
- Produces:
  - `interface CallDeps { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number }`
  - `interface CallTarget { baseUrl: string; secret: string; userAgent: string }`
  - `interface CallOutcome { status: "ok" | "error" | "degraded"; httpStatus: number | null; attempts: number; ms: number; reason?: "http" | "timeout" | "network" | "deadline" | "counts"; degraded?: Record<string, number | "unreadable">; body?: string }`
  - `const JOB_TIMEOUT_MS = 60_000`, `const BACKOFF_MS = [2_000, 8_000] as const`
  - `function userAgent(envName: string): string`, which returns `seazn-cron/1 (<envName>)`
  - `function failureCountsOver0(job: Job, bodyText: string | null): Record<string, number | "unreadable">`
  - `function callJob(job: Job, target: CallTarget, deps: CallDeps, deadlineMs: number): Promise<CallOutcome>`

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/call.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, callJob, failureCountsOver0, userAgent, type CallDeps, type CallTarget } from "../src/call";
import { JOBS, type Job } from "../src/schedule";

const job = (id: string): Job => JOBS.find((j) => j.id === id)!;
const res = (status: number, body = "{}") => new Response(body, { status });
const billing = (data: unknown) => res(200, JSON.stringify({ ok: true, data }));
const timeoutErr = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
/** A response that ARRIVED but whose body then fails to read (m1). */
const brokenBody = (status: number) =>
  ({ ok: status >= 200 && status < 300, status, text: () => Promise.reject(new TypeError("body stream broke")) }) as unknown as Response;
const T: CallTarget = { baseUrl: "https://x", secret: "s", userAgent: userAgent("stg") };

function deps(responses: Array<Response | Error>): CallDeps & { fetch: ReturnType<typeof vi.fn>; sleeps: number[] } {
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetch = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch, sleep: async (ms) => void sleeps.push(ms), now: () => 0, sleeps } as never;
}

describe("callJob", () => {
  it("POSTs the route with the cron secret and a User-Agent, and reports ok", async () => {
    const d = deps([res(200, '{"swept":3}')]);
    const out = await callJob(job("registrations"), { ...T, baseUrl: "https://stg.seazn.club", secret: "s3cret" }, d, Infinity);
    expect(out).toMatchObject({ status: "ok", httpStatus: 200, attempts: 1, body: '{"swept":3}' });
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("https://stg.seazn.club/api/cron/registrations");
    expect(init.method).toBe("POST");
    expect(init.headers["x-cron-secret"]).toBe("s3cret");
    // m2: the zone's Browser Integrity Check challenges a request with no UA.
    expect(init.headers["user-agent"]).toBe("seazn-cron/1 (stg)");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([502, 503, 504])("retries a %i twice with 2s then 8s backoff", async (code) => {
    const d = deps([res(code), res(code), res(200)]);
    const out = await callJob(job("registrations"), T, d, Infinity);
    expect(out).toMatchObject({ status: "ok", attempts: 3 });
    expect(d.sleeps).toEqual([...BACKOFF_MS]);
  });

  it("gives up after 3 attempts and reports the last status", async () => {
    const d = deps([res(503), res(503), res(503)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({
      status: "error", httpStatus: 503, attempts: 3, reason: "http",
    });
  });

  it.each([400, 401, 403, 404, 500])("never retries a %i", async (code) => {
    const d = deps([res(code)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({
      status: "error", httpStatus: code, attempts: 1, reason: "http",
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("never retries a timeout: the server may already be running the job", async () => {
    const d = deps([timeoutErr()]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({
      status: "error", httpStatus: null, attempts: 1, reason: "timeout",
    });
  });

  it("retries a network error for an idempotent job", async () => {
    const d = deps([new TypeError("connection reset"), res(200)]);
    expect(await callJob(job("funnel-remind"), T, d, Infinity)).toMatchObject({ status: "ok", attempts: 2 });
  });

  it.each(["news-digest", "relay-sweep"])("never retries %s, not even on a 503 or a network error", async (id) => {
    for (const first of [res(503), new TypeError("reset")]) {
      const d = deps([first]);
      expect(await callJob(job(id), T, d, Infinity)).toMatchObject({ status: "error", attempts: 1 });
      expect(d.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not start an attempt past the deadline", async () => {
    const d = { ...deps([res(503)]), now: () => 1_000 };
    expect(await callJob(job("registrations"), T, d, 1_000)).toMatchObject({
      status: "error", attempts: 0, reason: "deadline",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  // m1: once a response has arrived, its STATUS decides. A body that fails to
  // read is reported, never retried as "network" (spec §5: only before a response).
  it("a 200 whose body read fails is still ok, and is not re-sent", async () => {
    const d = deps([brokenBody(200)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({ status: "ok", httpStatus: 200, attempts: 1 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("a 503 whose body read fails is retried because of its status", async () => {
    const d = deps([brokenBody(503), res(200)]);
    expect(await callJob(job("registrations"), T, d, Infinity)).toMatchObject({ status: "ok", attempts: 2 });
  });
});

describe("R3: failure counters inside a 200", () => {
  it("a counter above 0 makes the run degraded, never ok, and it is not re-sent", async () => {
    const d = deps([billing({ replayed: 2, failed: 1, alerted: 0 })]);
    expect(await callJob(job("billing-events"), T, d, Infinity)).toMatchObject({
      status: "degraded", httpStatus: 200, attempts: 1, reason: "counts", degraded: { "data.failed": 1 },
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("every counter at 0 is ok", async () => {
    const d = deps([billing({ replayed: 4, failed: 0, alerted: 0 })]);
    expect(await callJob(job("billing-events"), T, d, Infinity)).toMatchObject({ status: "ok" });
  });

  it("reads nested counters, from the FULL body rather than the 500-char log excerpt", async () => {
    const mismatches = Array.from({ length: 40 }, (_, i) => ({ orgId: `org-${i}`, priceId: `price_${i}` }));
    const data = { checked: 3, corrected: 0, failed: 0, orphanOrgs: 0, addonPrices: { mismatches, alerted: 0 }, orphanGroups: { failed: 2 } };
    expect(JSON.stringify({ ok: true, data }).length, "this case's premise").toBeGreaterThan(500);
    const out = await callJob(job("billing-quantity"), T, deps([billing(data)]), Infinity);
    expect(out).toMatchObject({ status: "degraded", degraded: { "data.orphanGroups.failed": 2 } });
    expect(out.body).toHaveLength(500);
  });

  it("a counter that cannot be read is degraded ('unreadable'), so a renamed field never reads as healthy", async () => {
    for (const r of [res(200, "<html>challenge</html>"), billing({ wallets: 3, granted: 3 }), brokenBody(200)]) {
      expect(await callJob(job("billing-grant"), T, deps([r]), Infinity)).toMatchObject({
        status: "degraded", degraded: { "data.failed": "unreadable" },
      });
    }
  });

  it("a job with no counters ignores its body", async () => {
    expect(await callJob(job("registrations"), T, deps([res(200, "<html>whatever</html>")]), Infinity)).toMatchObject({ status: "ok" });
  });

  it("failureCountsOver0 reports only the offenders", () => {
    expect(failureCountsOver0(job("billing-events"), JSON.stringify({ ok: true, data: { failed: 0, alerted: 3 } }))).toEqual({
      "data.alerted": 3,
    });
    expect(failureCountsOver0(job("registrations"), "<html>")).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t2.json test/call.test.ts; jq '.numFailedTestSuites' /tmp/cw-t2.json
```
Expected: `1`, because `../src/call` does not exist.

- [ ] **Step 3: Implement `src/call.ts`**

```ts
import type { Job } from "./schedule";

export interface CallDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Where, and as whom, a job is POSTed. */
export interface CallTarget {
  baseUrl: string;
  secret: string;
  userAgent: string;
}

export interface CallOutcome {
  /** "degraded" (R3): a 200 whose failure counters read above 0, or could not be read. */
  status: "ok" | "error" | "degraded";
  httpStatus: number | null;
  attempts: number;
  ms: number;
  reason?: "http" | "timeout" | "network" | "deadline" | "counts";
  /** R3: the offending counters, by dotted path. */
  degraded?: Record<string, number | "unreadable">;
  /** First 500 chars of the route's response, for the log line. */
  body?: string;
}

export const JOB_TIMEOUT_MS = 60_000;
export const BACKOFF_MS = [2_000, 8_000] as const;

const RETRYABLE = new Set([502, 503, 504]);
const BODY_EXCERPT = 500;

/** m2: the zone's Browser Integrity Check challenges a request with no User-Agent. */
export function userAgent(envName: string): string {
  return `seazn-cron/1 (${envName})`;
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * R3 (owner 2026-10-01): the `job.failureCounts` that read above 0, or that
 * cannot be read at all (not JSON, path missing, not a finite number), so a
 * renamed field can never read as healthy. Empty means healthy. It reads the
 * FULL body, because billing-quantity's mismatch list can push its counters
 * past the log excerpt.
 */
export function failureCountsOver0(job: Job, bodyText: string | null): Record<string, number | "unreadable"> {
  const out: Record<string, number | "unreadable"> = {};
  if (!job.failureCounts?.length) return out;
  let parsed: unknown;
  try {
    parsed = bodyText === null ? undefined : JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  for (const path of job.failureCounts) {
    const v = path
      .split(".")
      .reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), parsed);
    if (typeof v !== "number" || !Number.isFinite(v)) out[path] = "unreadable";
    else if (v > 0) out[path] = v;
  }
  return out;
}

/**
 * POST one job's route. Retries ONLY a 502/503/504 or a network error before
 * any response, and only when `job.retry`. It never retries a timeout (the
 * server may already be running the job), a 4xx, news-digest or relay-sweep.
 * Spec §5, §13.
 */
export async function callJob(job: Job, target: CallTarget, deps: CallDeps, deadlineMs: number): Promise<CallOutcome> {
  const started = deps.now();
  const maxAttempts = job.retry ? 1 + BACKOFF_MS.length : 1;
  let last: CallOutcome = { status: "error", httpStatus: null, attempts: 0, ms: 0, reason: "deadline" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await deps.sleep(BACKOFF_MS[attempt - 2]!);
    if (deps.now() >= deadlineMs) return { ...last, ms: deps.now() - started, reason: "deadline" };
    let res: Response;
    try {
      res = await deps.fetch(`${target.baseUrl}${job.path}`, {
        method: "POST",
        headers: { "x-cron-secret": target.secret, "user-agent": target.userAgent },
        signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
      });
    } catch (err) {
      if (isTimeout(err)) {
        return { status: "error", httpStatus: null, attempts: attempt, ms: deps.now() - started, reason: "timeout" };
      }
      last = { status: "error", httpStatus: null, attempts: attempt, ms: 0, reason: "network", body: String(err).slice(0, BODY_EXCERPT) };
      continue;
    }
    // m1: a response ARRIVED, so its status alone decides from here on.
    let text: string | null;
    try {
      text = await res.text();
    } catch {
      text = null;
    }
    const body = (text ?? "<body unreadable>").slice(0, BODY_EXCERPT);
    if (res.ok) {
      const degraded = failureCountsOver0(job, text);
      const ms = deps.now() - started;
      return Object.keys(degraded).length > 0
        ? { status: "degraded", httpStatus: res.status, attempts: attempt, ms, reason: "counts", degraded, body }
        : { status: "ok", httpStatus: res.status, attempts: attempt, ms, body };
    }
    last = { status: "error", httpStatus: res.status, attempts: attempt, ms: 0, reason: "http", body };
    if (!RETRYABLE.has(res.status)) break;
  }
  return { ...last, ms: deps.now() - started };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t2.json test/call.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t2.json
```
Expected: the two counts are equal (`23`), and only `call.test.ts` is listed.

- [ ] **Step 5: Mutation checks, one at a time, each restored from a `cp` backup.**
  - Change `maxAttempts` to always `3`. Expected: both "never retries news-digest / relay-sweep" cases go red.
  - Delete the `isTimeout` early return. Expected: the timeout test goes red.
  - Add `500` to `RETRYABLE`. Expected: the `never retries a 500` case goes red.
  - m1: move the `res.text()` read back inside the `fetch` try. Expected: "a 200 whose body read fails" goes red (classed `network`, re-sent, "unexpected extra fetch").
  - R3: pass `body` (the 500-char excerpt) to `failureCountsOver0` instead of `text`. Expected: the full-body test goes red.
  - R3: treat a missing counter as `0`. Expected: the `unreadable` test goes red.

- [ ] **Step 6: Typecheck the package** (the Task 1 Step 9 command). Expected: `EXIT=0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/call.ts apps/cron-worker/test/call.test.ts && git commit -m "feat(cron-worker): callJob with 5xx-only retry, status-first classification, R3 counters"
```

---

### Task 3: Sentry error events for failed jobs (no SDK)

R5 (owner, 2026-10-01): cron **monitoring is deferred** (see "Deferred" at the end). This task sends **error events only**, which are free on the Sentry plan. It sends no check-ins and creates no monitors.

**Files:**
- Create: `apps/cron-worker/src/sentry.ts`
- Test: `apps/cron-worker/test/sentry.test.ts`

**Interfaces:**
- Consumes: `CallOutcome` from `src/call.ts`.
- Produces:
  - `interface Dsn { origin: string; projectId: string; publicKey: string }`
  - `interface JobFailure extends CallOutcome { job: string }`
  - `function parseDsn(dsn: string | undefined): Dsn | null`
  - `function captureJobFailure(fetchFn: typeof fetch, dsn: Dsn, e: { environment: string; run: "scheduled" | "manual"; failure: JobFailure; eventId: string; nowMs: number }): Promise<void>` (never rejects)

Sentry envelope endpoint (re-read the docs page at execution time; the shape is what `Sentry.captureException` sends): `POST https://{ingest-host}/api/{project_id}/envelope/?sentry_key={public_key}&sentry_version=7`, with a newline-separated body: an envelope header `{event_id, sent_at}`, an item header `{"type":"event"}`, then the event JSON. **Why no SDK:** the Worker's logic stays pure functions over an injected `fetch` (spec §12.4), so every path is a plain-Node unit test. The DSN is the Fly app's own (`fly.toml`), so these events land beside the app's `captureError` reports.

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/sentry.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { captureJobFailure, parseDsn, type JobFailure } from "../src/sentry";

const DSN = "https://abc123@o42.ingest.de.sentry.io/4507";
const dsn = parseDsn(DSN)!;
const DEGRADED: JobFailure = {
  job: "billing-events",
  status: "degraded",
  httpStatus: 200,
  attempts: 1,
  ms: 40,
  reason: "counts",
  degraded: { "data.failed": 3 },
  body: '{"ok":true,"data":{"note":"org-secret-name"}}',
};
const send = (fetchFn: unknown, failure: JobFailure = DEGRADED, run: "scheduled" | "manual" = "scheduled") =>
  captureJobFailure(fetchFn as typeof fetch, dsn, {
    environment: "prod",
    run,
    failure,
    eventId: "0123456789abcdef0123456789abcdef",
    nowMs: Date.parse("2026-09-29T14:17:05Z"),
  });
const sentBody = (fetchFn: ReturnType<typeof vi.fn>) => String((fetchFn.mock.calls[0]! as unknown as [string, RequestInit])[1].body);

describe("parseDsn", () => {
  it("splits a DSN into ingest origin, project and public key", () => {
    expect(parseDsn(DSN)).toEqual({ origin: "https://o42.ingest.de.sentry.io", projectId: "4507", publicKey: "abc123" });
  });
  it.each([undefined, "", "not a url", "https://o42.ingest.sentry.io/4507"])("returns null for %j", (v) => {
    expect(parseDsn(v)).toBeNull();
  });
});

describe("captureJobFailure", () => {
  it("posts ONE envelope holding an error-level event tagged with the job", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await send(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://o42.ingest.de.sentry.io/api/4507/envelope/?sentry_key=abc123&sentry_version=7");
    expect(init.method).toBe("POST");
    const [header, item, event] = sentBody(fetchFn).split("\n").map((l) => JSON.parse(l));
    expect(header).toEqual({ event_id: "0123456789abcdef0123456789abcdef", sent_at: "2026-09-29T14:17:05.000Z" });
    expect(item).toEqual({ type: "event" });
    expect(event).toMatchObject({
      level: "error",
      environment: "prod",
      tags: { job: "billing-events", reason: "counts", run: "scheduled", http_status: "200" },
      fingerprint: ["cron-worker", "billing-events", "counts"],
      extra: { attempts: 1, degraded: { "data.failed": 3 } },
    });
    expect(event.exception.values[0]).toEqual({ type: "CronJobFailed", value: "billing-events reported data.failed=3" });
  });

  it("names a transport failure and a manual run", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await send(fetchFn, { job: "registrations", status: "error", httpStatus: null, attempts: 1, ms: 60_000, reason: "timeout" }, "manual");
    const event = JSON.parse(sentBody(fetchFn).split("\n")[2]!);
    expect(event.tags).toEqual({ job: "registrations", reason: "timeout", run: "manual", http_status: "none" });
    expect(event.exception.values[0].value).toBe("registrations failed: timeout");
  });

  it("never sends the route's response body (lib/sentry.ts PII rule: ids and counts only)", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await send(fetchFn);
    expect(sentBody(fetchFn)).not.toContain("org-secret-name");
  });

  it("never rejects when Sentry is down", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("sentry unreachable");
    });
    await expect(send(fetchFn)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t3.json test/sentry.test.ts; jq '.numFailedTestSuites' /tmp/cw-t3.json
```
Expected: `1`.

- [ ] **Step 3: Implement `src/sentry.ts`**

```ts
import type { CallOutcome } from "./call";

/**
 * Sentry ERROR EVENTS for failed jobs, without an SDK: one envelope POST over
 * an injected fetch, so the code stays a plain-Node unit test (spec §12.4).
 * Error events are free on the Sentry plan. Cron MONITORS are deferred (owner
 * 2026-10-01, spec §13.5), so this file sends no check-in, and
 * test/run.test.ts sweeps a week of firings to keep it that way.
 * It uses the same project and DSN as the Fly app's own reporting
 * (lib/sentry.ts captureError), and the same PII rule: ids and counts only,
 * never a response body.
 */
export interface Dsn {
  origin: string;
  projectId: string;
  publicKey: string;
}

export interface JobFailure extends CallOutcome {
  job: string;
}

const SENTRY_TIMEOUT_MS = 5_000;

export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !projectId) return null;
    return { origin: `${u.protocol}//${u.host}`, projectId, publicKey: u.username };
  } catch {
    return null;
  }
}

/** One error event for a job that was not ok. Best-effort by contract: a
 *  Sentry outage must never stop or fail a job, so this swallows every error. */
export async function captureJobFailure(
  fetchFn: typeof fetch,
  dsn: Dsn,
  e: { environment: string; run: "scheduled" | "manual"; failure: JobFailure; eventId: string; nowMs: number },
): Promise<void> {
  const f = e.failure;
  const reason = f.reason ?? f.status;
  const detail = f.degraded
    ? `reported ${Object.entries(f.degraded).map(([k, v]) => `${k}=${v}`).join(", ")}`
    : `failed: ${reason}${f.httpStatus === null ? "" : ` (HTTP ${f.httpStatus})`}`;
  const event = {
    event_id: e.eventId,
    timestamp: e.nowMs / 1000,
    platform: "javascript",
    level: "error",
    logger: "cron-worker",
    environment: e.environment,
    tags: { job: f.job, reason, run: e.run, http_status: f.httpStatus === null ? "none" : String(f.httpStatus) },
    fingerprint: ["cron-worker", f.job, reason],
    exception: { values: [{ type: "CronJobFailed", value: `${f.job} ${detail}` }] },
    // Never f.body: the route's response stays in Workers Logs.
    extra: { attempts: f.attempts, ms: f.ms, degraded: f.degraded ?? null },
  };
  const envelope = [
    JSON.stringify({ event_id: e.eventId, sent_at: new Date(e.nowMs).toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
  try {
    await fetchFn(`${dsn.origin}/api/${dsn.projectId}/envelope/?sentry_key=${encodeURIComponent(dsn.publicKey)}&sentry_version=7`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: envelope,
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    });
  } catch {
    // swallowed by contract
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t3.json test/sentry.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t3.json
```
Expected: the two counts are equal (`9`), and only `sentry.test.ts` is listed.

- [ ] **Step 5: Mutation checks, each restored from a `cp` backup.**
  - Remove the `try/catch` around `fetchFn`. Expected: "never rejects" goes red.
  - Add `body: f.body` to `extra`. Expected: the PII test goes red.

- [ ] **Step 6: Typecheck the package** (the Task 1 Step 9 command). Expected: `EXIT=0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/sentry.ts apps/cron-worker/test/sentry.test.ts && git commit -m "feat(cron-worker): Sentry error event per failed job, no SDK, no check-ins"
```

---

### Task 4: `runJobs`/`runDue` orchestration, the trigger seam, the `ACTIVE` gate and the `scheduled` handler

**Files:**
- Create: `apps/cron-worker/src/run.ts`
- Create: `apps/cron-worker/src/index.ts`
- Test: `apps/cron-worker/test/run.test.ts`

**Interfaces:**
- Consumes: `JOBS`, `TRIGGER_CRON`, `dueJobs`, `triggersOf`, `Job` (Task 1); `callJob`, `userAgent`, `CallDeps`, `CallOutcome` (Task 2); `parseDsn`, `captureJobFailure` (Task 3).
- Produces:
  - `interface Env { ENV_NAME: string; BASE_URL: string; ACTIVE: string; CRON_SECRET: string; SENTRY_DSN?: string }`
  - `interface RunDeps extends CallDeps { log: (line: Record<string, unknown>) => void; uuid: () => string }`
  - `interface JobResult extends CallOutcome { job: string }`
  - `interface RunContext { run: "scheduled" | "manual"; cron?: string }`
  - `const RUN_DEADLINE_MS = 12 * 60_000`
  - `function runJobs(jobs: readonly Job[], scheduledTime: Date, env: Env, deps: RunDeps, ctx: RunContext): Promise<JobResult[]>`
  - `function runDue(scheduledTime: Date, cron: string, env: Env, deps: RunDeps, jobs?: readonly Job[]): Promise<JobResult[]>`. The optional `jobs` is the table seam the R4 tests use.
  - `function liveDeps(): RunDeps`
  - `index.ts` default export `{ scheduled, fetch }` (`fetch` is wired in Task 5)

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/run.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { RUN_DEADLINE_MS, runDue, type Env, type RunDeps } from "../src/run";
import { JOBS, TRIGGER_CRON, type Job } from "../src/schedule";

const MONDAY_0817 = new Date("2026-09-28T08:17:00Z");
const TUESDAY_1417 = new Date("2026-09-29T14:17:00Z");
const MONDAY_0805 = new Date("2026-09-28T08:05:00Z");
const FAST = "*/5 * * * *";
const TICK: Job = { id: "stream-tick", path: "/api/cron/stream-tick", trigger: FAST, due: { kind: "every" }, retry: false, manual: true };
const WITH_TICK: readonly Job[] = [...JOBS, TICK];
// A healthy body for every route: the R3 counters read 0, the others ignore it.
const HEALTHY = JSON.stringify({ ok: true, data: { failed: 0, alerted: 0, orphanGroups: { failed: 0 }, addonPrices: { alerted: 0 } } });
const env = (over: Partial<Env> = {}): Env => ({
  ENV_NAME: "prod",
  BASE_URL: "https://seazn.club",
  ACTIVE: "true",
  CRON_SECRET: "s",
  SENTRY_DSN: "https://k@o1.ingest.sentry.io/9",
  ...over,
});
const isSentry = (u: string) => new URL(u).host.endsWith("sentry.io");

function harness(route: (url: string) => Response | Error = () => new Response(HEALTHY)) {
  const lines: Record<string, unknown>[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let clock = 0;
  let n = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (isSentry(url)) return new Response("{}", { status: 200 });
    const r = route(url);
    if (r instanceof Error) throw r;
    return r;
  });
  const deps: RunDeps = {
    fetch: fetch as never,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    log: (l) => void lines.push(l),
    uuid: () => `uuid-${++n}`,
  };
  return {
    deps,
    lines,
    calls,
    posts: () => calls.filter((c) => !isSentry(c.url)).map((c) => c.url),
    sentry: () => calls.filter((c) => isSentry(c.url)),
    events: () =>
      calls
        .filter((c) => isSentry(c.url))
        .map((c) => JSON.parse(String(c.init!.body).split("\n")[2]!) as { level: string; environment: string; tags: Record<string, string> }),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("runDue: jobs and the run log", () => {
  it("runs the due jobs in table order: one result and one job line each, then one run line", async () => {
    const h = harness();
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => [r.job, r.status])).toEqual([
      ["registrations", "ok"],
      ["billing-events", "ok"],
      ["funnel-remind", "ok"],
    ]);
    expect(h.posts()).toEqual([
      "https://seazn.club/api/cron/registrations",
      "https://seazn.club/api/cron/billing-events",
      "https://seazn.club/api/funnel/remind",
    ]);
    expect(h.lines.filter((l) => l.event === "job")).toHaveLength(3);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", run: "scheduled", cron: TRIGGER_CRON, jobs: 3, notOk: [], sentry: "on" });
    expect(h.sentry()).toEqual([]); // nothing failed, so nothing to report
  });

  it("one failing job does not stop the rest, and raises ONE error event tagged with that job", async () => {
    const h = harness((u) => (u.endsWith("/api/cron/registrations") ? new Response("no", { status: 401 }) : new Response(HEALTHY)));
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => r.status)).toEqual(["error", "ok", "ok"]);
    expect(h.lines.find((l) => l.job === "registrations")).toMatchObject({ event: "job", status: "error", httpStatus: 401, env: "prod" });
    expect(h.events()).toEqual([
      expect.objectContaining({ level: "error", environment: "prod", tags: expect.objectContaining({ job: "registrations", reason: "http", run: "scheduled" }) }),
    ]);
  });

  it("R3: a 200 whose failure counter reads > 0 is degraded and raises one event; zeros raise none", async () => {
    const bad = harness((u) =>
      new Response(u.endsWith("/billing-events") ? JSON.stringify({ ok: true, data: { replayed: 0, failed: 0, alerted: 2 } }) : HEALTHY),
    );
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), bad.deps);
    expect(results.find((r) => r.job === "billing-events")).toMatchObject({ status: "degraded", httpStatus: 200, degraded: { "data.alerted": 2 } });
    expect(bad.lines.find((l) => l.job === "billing-events")).toMatchObject({ event: "job", status: "degraded" });
    expect(bad.events()).toEqual([expect.objectContaining({ tags: expect.objectContaining({ job: "billing-events", reason: "counts" }) })]);
    const good = harness();
    await runDue(TUESDAY_1417, TRIGGER_CRON, env(), good.deps);
    expect(good.events()).toEqual([]);
  });

  it("past the run deadline: the remaining jobs report error/deadline and raise events, never silence", async () => {
    const h = harness((u) => {
      if (u.endsWith("/api/cron/registrations")) h.advance(RUN_DEADLINE_MS);
      return new Response(HEALTHY);
    });
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env(), h.deps);
    expect(results.map((r) => [r.job, r.status, r.reason])).toEqual([
      ["registrations", "ok", undefined],
      ["billing-events", "error", "deadline"],
      ["funnel-remind", "error", "deadline"],
    ]);
    expect(h.events().map((e) => e.tags.job)).toEqual(["billing-events", "funnel-remind"]);
  });

  it.each([
    [undefined, "off"],
    ["not a dsn", "misconfigured"],
  ])("SENTRY_DSN %j: jobs still run and the run line says sentry=%s", async (dsn, state) => {
    const h = harness(() => new Response("down", { status: 500 }));
    const results = await runDue(TUESDAY_1417, TRIGGER_CRON, env({ SENTRY_DSN: dsn }), h.deps);
    expect(results.map((r) => r.status)).toEqual(["error", "error", "error"]);
    expect(h.sentry()).toEqual([]);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", notOk: ["registrations", "billing-events", "funnel-remind"], sentry: state });
  });
});

describe("runDue: the R4 trigger seam", () => {
  it("refuses an unknown trigger by name: no job, no probe, no Sentry", async () => {
    for (const active of ["true", "false"]) {
      const h = harness();
      expect(await runDue(TUESDAY_1417, FAST, env({ ACTIVE: active }), h.deps)).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.lines).toEqual([expect.objectContaining({ event: "unknown-trigger", cron: FAST, env: "prod" })]);
    }
  });

  it("a second trigger runs only its own rows: never news-digest or an hourly row, even at Monday 08:05", async () => {
    const h = harness();
    const results = await runDue(MONDAY_0805, FAST, env(), h.deps, WITH_TICK);
    expect(results.map((r) => r.job)).toEqual(["stream-tick"]);
    expect(h.posts()).toEqual(["https://seazn.club/api/cron/stream-tick"]);
    expect(h.lines.at(-1)).toMatchObject({ event: "run", cron: FAST, jobs: 1 });
  });

  it("while inactive, a non-hourly trigger does nothing at all (the probe is hourly only)", async () => {
    const h = harness();
    expect(await runDue(MONDAY_0805, FAST, env({ ACTIVE: "false" }), h.deps, WITH_TICK)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.lines).toEqual([]);
  });
});

describe("runDue: the ACTIVE gate", () => {
  it("while inactive: the hourly firing probes /api/health only, with the cron User-Agent", async () => {
    const h = harness();
    const results = await runDue(MONDAY_0817, TRIGGER_CRON, env({ ACTIVE: "false" }), h.deps);
    expect(results).toEqual([]);
    expect(h.calls.map((c) => c.url)).toEqual(["https://seazn.club/api/health"]);
    expect((h.calls[0]!.init!.headers as Record<string, string>)["user-agent"]).toBe("seazn-cron/1 (prod)");
    expect(h.lines).toEqual([expect.objectContaining({ event: "probe", env: "prod", httpStatus: 200 })]);
  });
});

describe("R5: cron monitoring is deferred, so the Worker never calls a Sentry check-in endpoint", () => {
  it("over one full week of hourly firings with every job failing: events only, never a check-in", async () => {
    const h = harness(() => new Response("down", { status: 500 }));
    const start = Date.parse("2026-09-28T00:17:00Z"); // Monday
    let firings = 0;
    for (let i = 0; i < 168; i++, firings++) await runDue(new Date(start + i * 3_600_000), TRIGGER_CRON, env(), h.deps);
    expect(firings, "firings checked").toBe(168);
    // Spec §4 + R1: 3 every-firing rows × 168 + 4 daily rows × 7 + the weekly digest × 1. A 500 is never retried.
    expect(h.events(), "one event per failed job").toHaveLength(3 * 168 + 4 * 7 + 1);
    const paths = h.sentry().map((c) => new URL(c.url).pathname);
    expect(paths.filter((p) => !/^\/api\/9\/envelope\/$/.test(p)), "non-envelope Sentry calls").toEqual([]);
    expect(h.sentry().filter((c) => /\/cron\/|check_in/.test(c.url)), "check-in calls").toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t4.json test/run.test.ts; jq '.numFailedTestSuites' /tmp/cw-t4.json
```
Expected: `1`.

- [ ] **Step 3: Implement `src/run.ts`**

```ts
import { callJob, userAgent, type CallDeps, type CallOutcome } from "./call";
import { JOBS, TRIGGER_CRON, dueJobs, triggersOf, type Job } from "./schedule";
import { captureJobFailure, parseDsn } from "./sentry";

export interface Env {
  ENV_NAME: string;
  BASE_URL: string;
  /** "true" only after this env's GitHub legs are gated off (spec §7, §12.1). */
  ACTIVE: string;
  CRON_SECRET: string;
  /** Required on prod; recommended on stg. Unset means no events, and the run line says `sentry:"off"`. */
  SENTRY_DSN?: string;
}

export interface RunDeps extends CallDeps {
  log: (line: Record<string, unknown>) => void;
  uuid: () => string;
}

export interface JobResult extends CallOutcome {
  job: string;
}

export interface RunContext {
  run: "scheduled" | "manual";
  cron?: string;
}

export const RUN_DEADLINE_MS = 12 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Run the given jobs sequentially. Every job yields a result and a log line.
 * A job that is not ok (error, or degraded under R3) also raises ONE Sentry
 * error event when a DSN is set. One closing `event:"run"` line names the
 * Sentry state, so a missing DSN shows in the log rather than as silence.
 */
export async function runJobs(
  jobs: readonly Job[],
  scheduledTime: Date,
  env: Env,
  deps: RunDeps,
  ctx: RunContext,
): Promise<JobResult[]> {
  const deadline = deps.now() + RUN_DEADLINE_MS;
  const target = { baseUrl: env.BASE_URL, secret: env.CRON_SECRET, userAgent: userAgent(env.ENV_NAME) };
  const dsn = parseDsn(env.SENTRY_DSN);
  const at = scheduledTime.toISOString();
  const results: JobResult[] = [];
  for (const job of jobs) {
    const result: JobResult = { job: job.id, ...(await callJob(job, target, deps, deadline)) };
    if (dsn && result.status !== "ok") {
      await captureJobFailure(deps.fetch, dsn, {
        environment: env.ENV_NAME,
        run: ctx.run,
        failure: result,
        eventId: deps.uuid().replace(/-/g, ""),
        nowMs: deps.now(),
      });
    }
    deps.log({ event: "job", env: env.ENV_NAME, run: ctx.run, scheduledTime: at, ...result });
    results.push(result);
  }
  deps.log({
    event: "run",
    env: env.ENV_NAME,
    run: ctx.run,
    cron: ctx.cron ?? null,
    scheduledTime: at,
    jobs: results.length,
    notOk: results.filter((r) => r.status !== "ok").map((r) => r.job),
    sentry: dsn ? "on" : env.SENTRY_DSN ? "misconfigured" : "off",
  });
  return results;
}

/** The `scheduled` handler's body: one invocation of one trigger. */
export async function runDue(
  scheduledTime: Date,
  cron: string,
  env: Env,
  deps: RunDeps,
  jobs: readonly Job[] = JOBS,
): Promise<JobResult[]> {
  // R4: a trigger no row names is config drift (a dashboard-added cron, or
  // wrangler.json ahead of the table). Refuse it BY NAME and never guess.
  if (!triggersOf(jobs).includes(cron)) {
    deps.log({ event: "unknown-trigger", level: "error", env: env.ENV_NAME, cron, scheduledTime: scheduledTime.toISOString() });
    return [];
  }
  if (env.ACTIVE !== "true") {
    // Inactive: prove reachability from real Cloudflare infra (spec §9 R1)
    // without running a job, so two schedulers never overlap. Once an hour,
    // never on every tick of a faster trigger.
    if (cron === TRIGGER_CRON) await probe(scheduledTime, env, deps);
    return [];
  }
  return runJobs(dueJobs(scheduledTime, cron, jobs), scheduledTime, env, deps, { run: "scheduled", cron });
}

async function probe(scheduledTime: Date, env: Env, deps: RunDeps): Promise<void> {
  let httpStatus: number | null = null;
  let error: string | undefined;
  try {
    const res = await deps.fetch(`${env.BASE_URL}/api/health`, {
      headers: { "user-agent": userAgent(env.ENV_NAME) },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    httpStatus = res.status;
    await res.text().catch(() => undefined);
  } catch (err) {
    error = String(err);
  }
  deps.log({ event: "probe", env: env.ENV_NAME, scheduledTime: scheduledTime.toISOString(), httpStatus, error });
}

export function liveDeps(): RunDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (line) => console.log(JSON.stringify(line)),
    uuid: () => crypto.randomUUID(),
  };
}
```

`apps/cron-worker/src/index.ts`:
```ts
import { liveDeps, runDue, type Env } from "./run";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // R4: the firing trigger (controller.cron) picks the rows; the scheduled time picks the slot.
    ctx.waitUntil(runDue(new Date(controller.scheduledTime), controller.cron, env, liveDeps()).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t4.json test/run.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t4.json
```
Expected: `11`, `11`, and `run.test.ts`.

- [ ] **Step 5: Mutation checks, each restored from a `cp` backup.**
  - Replace `env.ACTIVE !== "true"` with `false`. Expected: the two inactive tests go red.
  - Delete the `cron === TRIGGER_CRON` guard on the probe. Expected: "a non-hourly trigger does nothing" goes red.
  - Change the event guard `result.status !== "ok"` to `result.status === "error"`. Expected: the R3 test goes red (a degraded money job reported nothing, AGENTS.md class 6).
  - Delete the unknown-trigger refusal. Expected: the refusal test goes red (no `unknown-trigger` line).
  - In `src/sentry.ts`, point the event URL at `/api/${dsn.projectId}/cron/x/${dsn.publicKey}/`. Expected: the week sweep goes red.

- [ ] **Step 6: Typecheck the package** (the Task 1 Step 9 command). Expected: `EXIT=0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/run.ts apps/cron-worker/src/index.ts apps/cron-worker/test/run.test.ts && git commit -m "feat(cron-worker): trigger-keyed runner with ACTIVE gate, probe, run log and error events"
```

---

### Task 5: The manual `POST /run?job=` endpoint

**Files:**
- Create: `apps/cron-worker/src/manual.ts`
- Modify: `apps/cron-worker/src/index.ts`
- Test: `apps/cron-worker/test/manual.test.ts`

**Interfaces:**
- Consumes: `JOBS`, `Job` (Task 1); `runJobs`, `Env`, `RunDeps` (Task 4).
- Produces:
  - `function handleManual(req: Request, env: Env, deps: RunDeps, jobs?: readonly Job[]): Promise<Response>`. The optional `jobs` is the table seam that keeps the `manual: false` guard reachable.
  - `function secretMatches(given: string | null, expected: string): boolean` (constant-time; an empty `expected` never matches)

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/manual.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { handleManual, secretMatches } from "../src/manual";
import type { Env, RunDeps } from "../src/run";
import { JOBS, type Job } from "../src/schedule";

const env: Env = { ENV_NAME: "stg", BASE_URL: "https://stg.seazn.club", ACTIVE: "false", CRON_SECRET: "s3cret" };
function deps() {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"deleted":0}'));
  const d: RunDeps = { fetch: fetch as never, sleep: async () => {}, now: () => 0, log: () => {}, uuid: () => "u" };
  return { d, fetch };
}
const req = (path: string, secret?: string, method = "POST") =>
  new Request(`https://seazn-cron-stg.example.workers.dev${path}`, {
    method,
    headers: secret === undefined ? {} : { "x-cron-secret": secret },
  });

describe("handleManual", () => {
  it("runs an idempotent job on demand, even while inactive", async () => {
    const { d, fetch } = deps();
    const res = await handleManual(req("/run?job=ai-previews", "s3cret"), env, d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ job: "ai-previews", status: "ok" }]);
    expect(fetch).toHaveBeenCalledWith("https://stg.seazn.club/api/cron/ai-previews", expect.anything());
  });

  it.each([[undefined], [""], ["wrong"]])("401 for secret %j, runs nothing", async (s) => {
    const { d, fetch } = deps();
    expect((await handleManual(req("/run?job=ai-previews", s), env, d)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("401 when the Worker has no secret configured, whatever is sent", async () => {
    const { d, fetch } = deps();
    expect((await handleManual(req("/run?job=ai-previews", ""), { ...env, CRON_SECRET: "" }, d)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("R2: news-digest runs on demand and is never re-sent", async () => {
    const { d, fetch } = deps();
    fetch.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    expect((await handleManual(req("/run?job=news-digest", "s3cret"), env, d)).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://stg.seazn.club/api/cron/news-digest", expect.anything());
  });

  it("403 for a row that says manual: false (no row does today; the guard stays reachable)", async () => {
    const { d, fetch } = deps();
    const locked: Job = { ...JOBS.find((j) => j.id === "ai-previews")!, id: "locked", manual: false };
    expect((await handleManual(req("/run?job=locked", "s3cret"), env, d, [locked])).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("404 for an unknown job, a wrong path or a GET", async () => {
    const { d } = deps();
    expect((await handleManual(req("/run?job=nope", "s3cret"), env, d)).status).toBe(404);
    expect((await handleManual(req("/other?job=ai-previews", "s3cret"), env, d)).status).toBe(404);
    expect((await handleManual(req("/run?job=ai-previews", "s3cret", "GET"), env, d)).status).toBe(404);
  });

  it("502 when the job itself failed", async () => {
    const { d, fetch } = deps();
    fetch.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    expect((await handleManual(req("/run?job=ai-previews", "s3cret"), env, d)).status).toBe(502);
  });

  it("R5: a failed manual run raises ONE error event tagged run=manual, and never touches a check-in endpoint", async () => {
    const { d, fetch } = deps();
    fetch.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    const withDsn: Env = { ...env, SENTRY_DSN: "https://k@o1.ingest.sentry.io/9" };
    expect((await handleManual(req("/run?job=ai-previews", "s3cret"), withDsn, d)).status).toBe(502);
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual(["https://stg.seazn.club/api/cron/ai-previews", "https://o1.ingest.sentry.io/api/9/envelope/?sentry_key=k&sentry_version=7"]);
    const event = JSON.parse(String(fetch.mock.calls[1]![1]!.body).split("\n")[2]!);
    expect(event.tags).toMatchObject({ job: "ai-previews", run: "manual" });
  });
});

describe("secretMatches", () => {
  it("matches only an identical non-empty secret", () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abd", "abc")).toBe(false);
    expect(secretMatches("ab", "abc")).toBe(false);
    expect(secretMatches(null, "abc")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t5.json test/manual.test.ts; jq '.numFailedTestSuites' /tmp/cw-t5.json
```
Expected: `1`.

- [ ] **Step 3: Implement `src/manual.ts` and wire `fetch` in `src/index.ts`**

`apps/cron-worker/src/manual.ts`:
```ts
import { runJobs, type Env, type RunDeps } from "./run";
import { JOBS, type Job } from "./schedule";

/** Constant-time compare; an unset/empty expected secret never matches. */
export function secretMatches(given: string | null, expected: string): boolean {
  if (!expected || given === null || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * `POST /run?job=<id>`: the manual rerun GitHub's workflow_dispatch gave us,
 * and the post-deploy smoke (spec §12.2). It runs regardless of ACTIVE. Every
 * row may be run by hand today (R1, R2), so `manual: false` is a guard kept
 * for a future row. A failed manual run is reported like a scheduled one: a
 * log line and one error event tagged run=manual.
 */
export async function handleManual(req: Request, env: Env, deps: RunDeps, jobs: readonly Job[] = JOBS): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/run") return json({ error: "not found" }, 404);
  if (!secretMatches(req.headers.get("x-cron-secret"), env.CRON_SECRET)) return json({ error: "unauthorized" }, 401);
  const job = jobs.find((j) => j.id === url.searchParams.get("job"));
  if (!job) return json({ error: "unknown job" }, 404);
  if (!job.manual) return json({ error: `${job.id} cannot be run manually` }, 403);
  const results = await runJobs([job], new Date(deps.now()), env, deps, { run: "manual" });
  return json(results, results.every((r) => r.status === "ok") ? 200 : 502);
}
```

`apps/cron-worker/src/index.ts` (full file):
```ts
import { handleManual } from "./manual";
import { liveDeps, runDue, type Env } from "./run";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // R4: the firing trigger (controller.cron) picks the rows; the scheduled time picks the slot.
    ctx.waitUntil(runDue(new Date(controller.scheduledTime), controller.cron, env, liveDeps()).then(() => undefined));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleManual(req, env, liveDeps());
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t5.json test/manual.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t5.json
```
Expected: the two counts are equal (`11`), and only `manual.test.ts` is listed.

- [ ] **Step 5: Mutation checks, each restored from a `cp` backup.**
  - Make `secretMatches` return `true`. Expected: the 401 cases go red.
  - Delete the `!job.manual` line. Expected: the 403 test goes red.

- [ ] **Step 6: Typecheck the package** (the Task 1 Step 9 command). Expected: `EXIT=0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/manual.ts apps/cron-worker/src/index.ts apps/cron-worker/test/manual.test.ts && git commit -m "feat(cron-worker): secret-gated manual run endpoint"
```

---

### Task 6: `wrangler.json`, the drift guard and CI wiring

**Files:**
- Create: `apps/cron-worker/wrangler.json`
- Test: `apps/cron-worker/test/drift.test.ts`
- Modify: `.github/workflows/ci.yml` (the `gates` job, after its `pnpm install --frozen-lockfile`, at about `:78`)

**Interfaces:**
- Consumes: `JOBS`, `triggersOf` (Task 1).
- Produces: `wrangler.json`, with the envs `stg` and `prod` that Tasks 9–11 depend on.

- [ ] **Step 1: Create `apps/cron-worker/wrangler.json`**

```json
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "seazn-cron",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-28",
  "workers_dev": true,
  "observability": { "enabled": true },
  "env": {
    "stg": {
      "name": "seazn-cron-stg",
      "triggers": { "crons": ["17 * * * *"] },
      "vars": { "ENV_NAME": "stg", "BASE_URL": "https://stg.seazn.club", "ACTIVE": "false" }
    },
    "prod": {
      "name": "seazn-cron-prod",
      "triggers": { "crons": ["17 * * * *"] },
      "vars": { "ENV_NAME": "prod", "BASE_URL": "https://seazn.club", "ACTIVE": "false" }
    }
  }
}
```

- [ ] **Step 2: Write the drift test**

`apps/cron-worker/test/drift.test.ts`:
```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { JOBS, triggersOf } from "../src/schedule";

const REPO = join(__dirname, "../../..");
const WEB_API = join(REPO, "apps/web/src/app/api");
/** x-cron-secret routes that no clock fires. Each entry is deliberate, and must still exist (a stale one reds). */
const NOT_SCHEDULED: Record<string, string> = {
  "/api/internal/revalidate": "event-driven peer cache revalidation between app instances; the app calls it, never a clock",
};

const routeFiles = (readdirSync(WEB_API, { recursive: true }) as string[]).filter(
  (f) => f === "route.ts" || f.endsWith(`${sep}route.ts`),
);
const toPath = (f: string) => `/api/${dirname(f).split(sep).join("/")}`;
// By BEHAVIOUR (m3, AGENTS.md class 16): a route that reads x-cron-secret is cron-shaped wherever it lives...
const secretRoutes = routeFiles
  .filter((f) => readFileSync(join(WEB_API, f), "utf8").includes("x-cron-secret"))
  .map(toPath)
  .sort();
// ...and by PLACE: anything under /api/cron is cron-shaped, however it spells its auth.
const cronDirRoutes = routeFiles.map(toPath).filter((p) => p.startsWith("/api/cron/")).sort();

describe("schedule ↔ routes drift guard", () => {
  it("the scans read the tree (anti-vacuity; floors measured 2026-10-01)", () => {
    expect(routeFiles.length, "route files scanned").toBeGreaterThanOrEqual(300); // 306 measured
    expect(secretRoutes.length, "x-cron-secret routes").toBeGreaterThanOrEqual(9); // 8 scheduled + revalidate
    expect(cronDirRoutes.length, "/api/cron routes").toBeGreaterThanOrEqual(7); // relay-sweep included (A4)
  });

  it("every cron-shaped route has exactly one schedule row, and every row a route", () => {
    const shaped = [...new Set([...secretRoutes, ...cronDirRoutes])].filter((p) => !(p in NOT_SCHEDULED)).sort();
    expect(JOBS.map((j) => j.path).sort()).toEqual(shaped);
  });

  it("every exemption is still a real x-cron-secret route", () => {
    expect(Object.keys(NOT_SCHEDULED).length, "exemptions checked").toBeGreaterThan(0);
    for (const p of Object.keys(NOT_SCHEDULED)) expect(secretRoutes, p).toContain(p);
  });

  it("every scheduled path resolves to a real route file", () => {
    for (const j of JOBS) expect(existsSync(join(WEB_API, j.path.replace(/^\/api\//, ""), "route.ts")), j.path).toBe(true);
  });
});

describe("wrangler.json ↔ schedule drift guard", () => {
  const cfg = JSON.parse(readFileSync(join(__dirname, "../wrangler.json"), "utf8"));

  it.each(["stg", "prod"])("%s registers exactly the triggers the table uses (R4)", (env) => {
    expect([...cfg.env[env].triggers.crons].sort()).toEqual(triggersOf().sort());
  });

  it.each(["stg", "prod"])("%s declares ENV_NAME, BASE_URL and an explicit ACTIVE flag", (env) => {
    const vars = cfg.env[env].vars;
    expect(vars.ENV_NAME).toBe(env);
    expect(vars.BASE_URL).toMatch(/^https:\/\//);
    expect(["true", "false"]).toContain(vars.ACTIVE);
  });

  it("the top-level (env-less) Worker has no trigger, so a bare `wrangler deploy` schedules nothing", () => {
    expect(cfg.triggers).toBeUndefined();
  });
});

describe("repo wiring", () => {
  it("A2: the Fly image's build context excludes this workspace", () => {
    // ci.yml's container job runs `turbo run typecheck` inside the builder image,
    // which never installs this workspace's devDependencies.
    const lines = readFileSync(join(REPO, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("apps/cron-worker");
  });
});
```

- [ ] **Step 3: Run the test to verify it passes, then prove it can fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t6.json test/drift.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t6.json
```
Expected: the two counts are equal (`10`).

Mutation checks. Restore each one before the next: `cp` backups for files you edit, and `rm -r` for planted directories, never `git checkout`.
- Delete the `billing-grant` row from `JOBS`. Expected: "exactly one schedule row" goes red.
- **R4 fail-safe, by behaviour:** plant `apps/web/src/app/api/ops/zz-drift-probe/route.ts` containing the line `// x-cron-secret`, which sits outside `/api/cron`. Expected: "exactly one schedule row" goes red. Then `rm -r apps/web/src/app/api/ops/zz-drift-probe`.
- **R4 fail-safe, by place:** plant `apps/web/src/app/api/cron/zz-drift-probe/route.ts` containing `export {};`. Expected: red. Then `rm -r` it.
- Change the stg cron to `"23 * * * *"`. Expected: the stg trigger test goes red.
- Add `"*/5 * * * *"` to prod's `crons`. Expected: the prod trigger test goes red, because that trigger has no row.
- Remove the `apps/cron-worker` line from `.dockerignore`. Expected: the wiring test goes red.

Confirm `git status --short apps/web/src/app/api` is empty afterwards.

- [ ] **Step 4: Wire the tests into CI.** Add this step to `.github/workflows/ci.yml`'s `gates` job, directly after its `- run: pnpm install --frozen-lockfile` line (about `:78`):

```yaml
      # apps/cron-worker is a workspace no other test step collects
      # (ci.yml runs apps/web and packages/engine by name). Its typecheck is
      # covered by `npx turbo run typecheck` below; the container job's
      # in-image typecheck never sees it (.dockerignore).
      - name: Cron worker tests
        run: pnpm --filter @seazn/cron-worker test
```

Re-read the lines around the insertion point first. Anchor on `pnpm install --frozen-lockfile` in the `gates:` job, not on a line number.

- [ ] **Step 5: Run the wiring guards that read `ci.yml`**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t6-wiring.json src/__tests__/toolchain.test.ts src/lib/__tests__/db-suite-ci-wiring.test.ts src/lib/__tests__/e2e-ci-wiring.test.ts src/lib/__tests__/redis-suite-ci-wiring.test.ts src/lib/__tests__/device-link-kek-wiring.test.ts; jq '.numPassedTests, .numTotalTests, .numFailedTestSuites, (.testResults | length)' /tmp/cw-t6-wiring.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/cw-t6-scripts.json scripts/__tests__/check-vitest-collection.test.ts scripts/matrix/__tests__/ci-wiring.test.ts; jq '.numPassedTests, .numTotalTests, .numFailedTestSuites, (.testResults | length)' /tmp/cw-t6-scripts.json
```
Expected: in each report the passed and total counts are equal, `numFailedTestSuites` is `0`, and the file counts are `5` and `2`. A smaller file count means a path was silently ignored.

- [ ] **Step 6: Run the whole package suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-all.json; jq '.numPassedTests, .numTotalTests, .numFailedTestSuites, [.testResults[].name | split("/") | last]' /tmp/cw-all.json
```
Expected: `76`, `76`, `0`, and 6 files listed (schedule, call, sentry, run, manual, drift).

- [ ] **Step 7: Typecheck the package** (the Task 1 Step 9 command). Expected: `EXIT=0`.

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/wrangler.json apps/cron-worker/test/drift.test.ts .github/workflows/ci.yml && git commit -m "feat(cron-worker): wrangler envs, behaviour-swept route/trigger drift guard, CI step"
```

---

### Task 7: The news-digest weekly guard (cron path only)

**Files:**
- Create: `db/migration/deltas/V429__weekly_digest_cron_once.sql`. **V429 is the ruled number (A1).** V419 is a different, live migration (`V419__discovery_excludes_drafts.sql`), so never cite V419 for this guard. Main topped out at V428 on 2026-10-01, and capture-QR v2 has already renumbered to V430/V431 around this one. Re-check first (`ls db/migration/deltas | sort -V | tail -1`). If V429 has been taken since, stop and report; do not renumber on your own, because capture-QR v2's docs cite V429 as this plan's migration.
- Modify: `apps/web/src/server/news/enrichment.ts` (add `isoWeekKeyUtc` below `digestWindow`, which is at about `:41`; merge the new import with `org-posts.ts`'s existing enrichment import at about `:48-56`)
- Modify: `apps/web/src/server/usecases/org-posts.ts`: `insertGeneratedPost` (about `:659-703`), `digestForOrg` (about `:1530` and `:1598-1613`), and `sweepWeeklyDigests` (the function starts at about `:1660`; its `digestForOrg` call is at about `:1714-1716`). Anchor on the text, not the line.
- Test: `apps/web/src/server/news/__tests__/iso-week.test.ts` (new)
- Test: `apps/web/src/server/usecases/__tests__/org-posts-digest.test.ts` (add one `it`)
- E2E (run, not edited): `apps/web/e2e/news.spec.ts`, **the whole file** (A5). `insertGeneratedPost` and `digestForOrg` change on the **console** path too (the branched insert), and that spec drives the "Generate digest" button (`news.spec.ts:139-206`).

**Interfaces:**
- Produces: `export function isoWeekKeyUtc(nowMs: number): string`, which returns for example `"2026-W40"`.
- `digestForOrg(..., opts: { skipIfEmpty?: boolean; cronWeek?: string })`. `insertGeneratedPost` params gain `arbiter?: "digest_cron_once"`.

- [ ] **Step 1: Write the failing unit test for the ISO week key**

`apps/web/src/server/news/__tests__/iso-week.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isoWeekKeyUtc } from "../enrichment";

const k = (iso: string) => isoWeekKeyUtc(Date.parse(iso));

describe("isoWeekKeyUtc", () => {
  it.each([
    ["2026-09-28T00:00:00Z", "2026-W40"], // Monday
    ["2026-10-04T23:59:59Z", "2026-W40"], // Sunday, same week
    ["2026-10-05T00:00:00Z", "2026-W41"], // next Monday
    ["2026-01-01T12:00:00Z", "2026-W01"], // Thursday, so week 1
    ["2027-01-01T12:00:00Z", "2026-W53"], // 2026 has 53 ISO weeks
    ["2024-12-30T12:00:00Z", "2025-W01"], // Monday belonging to the next ISO year
    ["2021-01-03T12:00:00Z", "2020-W53"], // Sunday belonging to the previous ISO year
  ])("%s → %s", (iso, key) => {
    expect(k(iso)).toBe(key);
  });
});
```

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t7a.json src/server/news/__tests__/iso-week.test.ts; jq '.numFailedTests, .numFailedTestSuites' /tmp/cw-t7a.json
```
Expected: it fails, because `isoWeekKeyUtc` is not exported.

- [ ] **Step 2: Implement `isoWeekKeyUtc` in `apps/web/src/server/news/enrichment.ts`, right after `digestWindow`**

```ts
/**
 * ISO-8601 week key in UTC, e.g. "2026-W40" — the cron digest's
 * once-per-week identity (`auto_source.cron_week`, V429). `digestWindow` is a
 * rolling `[now-7d, now)` so its `start` cannot serve as that key.
 */
export function isoWeekKeyUtc(nowMs: number): string {
  const DAY = 86_400_000;
  const d = new Date(nowMs);
  const mondayIndex = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayIndex);
  const isoYear = new Date(monday + 3 * DAY).getUTCFullYear(); // the week's Thursday decides the year
  const jan4 = Date.UTC(isoYear, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const week = Math.round((monday - week1Monday) / (7 * DAY)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
```

Re-run the Step 1 command. Expected: `numFailedTests` is `0` and `numPassedTests` is `7`.

- [ ] **Step 3: Write the failing DB-backed test.** Add to `apps/web/src/server/usecases/__tests__/org-posts-digest.test.ts`, inside the existing `describe.skipIf(!HAS_DB)` block, directly after the existing `sweepWeeklyDigests: creates for an active Pro org…` test (~:383). It reuses that file's `seedOrg`, `seedDivision`, `decideWithRally`, `listPosts`, `sql` and `generateWeeklyDigest`.

```ts
  it("sweepWeeklyDigests: at most ONE cron digest per org per ISO week; console presses stay unlimited", async () => {
    // single-sport: badminton via seedDivision; the guard keys on org and ISO week, never on sport.
    const org = await seedOrg("pro");
    const div = await seedDivision(org);
    await decideWithRally(org, div, div.entrantA, div.entrantB);
    const now = Date.now();
    const digests = async () => (await listPosts(org.auth, org.orgId)).filter((p) => p.kind === "weekly_digest");

    // 1. First cron firing drafts one, stamped with this ISO week. The expected
    // key comes from isoWeekKeyUtc, which is code under test (TEST-STRATEGY
    // rule 3). That is accepted here because iso-week.test.ts pins it to
    // ISO-8601 facts, and pre-flight checked it against an independent oracle
    // (7/7 cases; a 52,598-point sweep over 1999-2040 with 0 differences).
    await sweepWeeklyDigests(now);
    const first = await digests();
    expect(first).toHaveLength(1);
    expect(first[0]!.autoSource).toMatchObject({ trigger: "weekly_digest", origin: "cron", cron_week: isoWeekKeyUtc(now) });

    // 2. A double fire / retry in the same week drafts nothing more, and is a
    // quiet no-op for this org rather than a swallowed failure (m4: the
    // per-org catch would hide a throw behind the same count of 1).
    const warn = vi.spyOn(log, "warn");
    try {
      await sweepWeeklyDigests(now);
      expect(await digests()).toHaveLength(1);
      expect(warn.mock.calls.filter(([o]) => (o as { orgId?: string } | undefined)?.orgId === org.orgId)).toEqual([]);
    } finally {
      warn.mockRestore();
    }

    // 3. The console button is untouched by the guard (P3/D7): still a fresh draft.
    const pressed = await generateWeeklyDigest(org.auth, org.orgId);
    expect(pressed.autoSource).not.toHaveProperty("cron_week");
    expect(await digests()).toHaveLength(2);

    // 4. A later week is a new identity: age the cron row, sweep again, one more draft.
    await sql`
      update org_posts set auto_source = jsonb_set(auto_source, '{cron_week}', '"2000-W01"')
      where org_id = ${org.orgId} and auto_source ? 'cron_week'`;
    await sweepWeeklyDigests(now);
    expect(await digests()).toHaveLength(3);
  });
```

Add `import { isoWeekKeyUtc } from "@/server/news/enrichment";` and `import { log } from "@/server/logger";` to the file's imports, and add `vi` to its existing `vitest` import. Confirm the alias resolves the same way the file's other `@/` imports do. `org-posts.ts` imports the same `log` object (`:30`), so the spy sees the sweep's `log.warn`.

Run it against the local test DB. Use the `seazn-local-env` skill for a **fresh** DB, and remember `db:apply` then `sync:sports`. The test runs three sweeps over every org in the DB, so an accumulated test DB risks a timeout that reads as a defect:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t7b.json src/server/usecases/__tests__/org-posts-digest.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].assertionResults[] | select(.status=="failed") | .title]' /tmp/cw-t7b.json
```
Expected: exactly the new test fails, at step 1 (`origin`/`cron_week` missing) or step 2 (length 2). If `numTotalTests` is 0, the DB is not wired (`DATABASE_URL`). Fix the environment; this is not a pass.

- [ ] **Step 4: Write the migration** `db/migration/deltas/V429__weekly_digest_cron_once.sql`:

```sql
-- At most one CRON-originated weekly digest per org per ISO week (UTC).
-- The weekly schedule used to be the only guarantee (P3/D7 made
-- generateWeeklyDigest non-idempotent and V358 exempted weekly_digest from
-- org_posts_auto_once); a scheduler retry or double fire therefore drafted a
-- duplicate per org. Console presses carry no `cron_week` key, so this index
-- never sees them and they stay unlimited, as P3/D7 chose.
-- Spec: docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md §5, §12.5.
create unique index if not exists org_posts_digest_cron_once
  on org_posts (org_id, (auto_source ->> 'cron_week'))
  where (auto_source ->> 'trigger') = 'weekly_digest'
    and auto_source ? 'cron_week';
```

Apply it to the local test DB with the repo's migration command from the `seazn-local-env` skill (`db:apply` against the test DB; never the dev DB, see memory `reference_db_apply_without_env_migrates_the_dev_db`).

- [ ] **Step 5: Implement the cron path in `org-posts.ts`**

(a) `insertGeneratedPost`: add `arbiter?: "digest_cron_once"` to `params`, and branch the insert so each branch names its own arbiter. Keep the existing branch byte-for-byte:

```ts
    async (slug, q) => {
      // (existing comment on why the conflict target is spelled out — keep it)
      const rows =
        params.arbiter === "digest_cron_once"
          ? await q<{ id: string }[]>`
        insert into org_posts
          (org_id, competition_id, division_id, author_user_id, kind, status, slug,
           title, body_md, auto_source)
        values (${params.orgId}, ${params.competitionId}, ${params.divisionId}, null, ${params.kind}, 'draft',
                ${slug}, ${params.title}, ${params.bodyMd}, ${q.json(params.autoSource as never)})
        on conflict (org_id, (auto_source ->> 'cron_week'))
          where (auto_source ->> 'trigger') = 'weekly_digest' and auto_source ? 'cron_week'
        do nothing
        returning id`
          : await q<{ id: string }[]>`
        insert into org_posts
          (org_id, competition_id, division_id, author_user_id, kind, status, slug,
           title, body_md, auto_source)
        values (${params.orgId}, ${params.competitionId}, ${params.divisionId}, null, ${params.kind}, 'draft',
                ${slug}, ${params.title}, ${params.bodyMd}, ${q.json(params.autoSource as never)})
        on conflict (org_id, (auto_source ->> 'trigger'),
                     coalesce(auto_source ->> 'fixture_id', ''),
                     coalesce(auto_source ->> 'division_id', ''),
                     coalesce(auto_source ->> 'stage_id', ''),
                     coalesce(auto_source ->> 'round_no', ''))
          where auto_source is not null and (auto_source ->> 'trigger') <> 'weekly_digest'
        do nothing
        returning id`;
      return rows[0] ?? null;
    },
```

(b) `digestForOrg`: widen `opts` to `{ skipIfEmpty?: boolean; cronWeek?: string }`, then replace the `autoSource`/insert/guard block (~:1598-1613):

```ts
  const autoSource = {
    trigger: TRIGGER_DIGEST,
    window_start: window.start,
    window_end: window.end,
    // Cron path only (V429): the once-per-ISO-week identity. The console
    // button never passes cronWeek, so its drafts stay unlimited (P3/D7).
    ...(opts.cronWeek ? { origin: "cron", cron_week: opts.cronWeek } : {}),
  };
  const inserted = await insertGeneratedPost(tx, {
    orgId,
    competitionId: null,
    divisionId: null,
    kind: "weekly_digest",
    title,
    bodyMd,
    autoSource,
    ...(opts.cronWeek ? { arbiter: "digest_cron_once" as const } : {}),
  });
  if (!inserted) {
    // Cron path: this org already has this week's cron digest (a double
    // fire, or a manual /run re-run under R2): a no-op, not a failure.
    if (opts.cronWeek) return null;
    // Console path: still unreachable, since nothing constrains a console digest.
    throw new HttpError(500, "digest draft insert failed unexpectedly");
  }
```

Also update the stale comment block above the old guard ("Unreachable in practice: V358 exempts…") so it describes the console path only.

(c) `sweepWeeklyDigests`: pass the week key. Compute it once before the loop, and add `import { isoWeekKeyUtc } from "@/server/news/enrichment";`, merging with an existing import from that module if there is one:

```ts
  const cronWeek = isoWeekKeyUtc(nowMs);
  // ...inside the loop:
        digestForOrg(tx, orgId, nowMs, scope.allowed, { skipIfEmpty: true, cronWeek }),
```

- [ ] **Step 6: Run both test files**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t7c.json src/server/usecases/__tests__/org-posts-digest.test.ts src/server/news/__tests__/iso-week.test.ts src/server/usecases/__tests__/org-posts-enrichment-sources.test.ts; jq '.numPassedTests, .numTotalTests, .numFailedTestSuites, [.testResults[].name | split("/") | last]' /tmp/cw-t7c.json
```
Expected: the passed and total counts are equal, `numFailedTestSuites` is `0`, and all three files are listed.

- [ ] **Step 7: Re-run the news E2E as a whole file (A5)**

The console path's insert is now branched, and `e2e/news.spec.ts` drives the "Generate digest" button (`:139-206`). RULES owes an E2E for every task, and a `-g` slice is a filename sweep in disguise (AGENTS.md classes 2 and 21), so run the whole file. Follow the `seazn-local-env` skill: a local **prod build of this worktree**, its DB migrated through V429 plus `sync:sports`, `PLAYWRIGHT_BASE` on `localhost` (never `127.0.0.1`), and `E2E_PROD_TARGET=1` plus `DATABASE_URL` for the auth helpers. Run Playwright from `apps/web`, because the repo root resolves a config with no projects.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 E2E_PROD_TARGET=1 DATABASE_URL=<test db url> npx playwright test e2e/news.spec.ts --project=parallel --reporter=line; echo EXIT=$?
```
Expected: `EXIT=0`, with every test in the file passed (the `setup` project runs first as a dependency). Record the passed count. If a test fails, re-run once to rule out a flake before you diagnose it, and judge the environment before the code (the `seazn-local-env` skill's §5).

- [ ] **Step 8: Mutation checks, one at a time, each restored from a `cp` backup (never `git checkout`).**
  - Drop `cronWeek` from the sweep's `digestForOrg` call. Expected: the new test goes red at step 1 or 2.
  - Pass `cronWeek` from `generateWeeklyDigest` too. Expected: step 3 goes red (the console press is swallowed, AGENTS.md class 13).
  - Drop the index on the test DB (`drop index org_posts_digest_cron_once`). Expected: the new test goes red. The named `on conflict` target has no matching index, so the insert throws, the sweep's per-org catch logs and skips, and step 1 finds 0 digests. Recreate the index afterwards (re-apply V429).
  - **m4:** in `digestForOrg`, change the cron branch `if (opts.cronWeek) return null;` to `throw new Error("dup")`. Expected: step 2's `log.warn` assertion goes red. Without that assertion this mutant survives, because the sweep's per-org catch swallows the throw and the digest count still reads 1.

For the PR body: an organiser who **deletes** this week's cron draft frees the key, because `org_posts` rows are hard-deleted (`org-posts.ts:342`). A same-week redelivery or manual run (R2) would then draft it again. Publishing or archiving keeps the row, so it still blocks. This is low-probability and accepted, but say so in the PR body.

- [ ] **Step 9: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add db/migration/deltas/V429__weekly_digest_cron_once.sql apps/web/src/server/news/enrichment.ts apps/web/src/server/news/__tests__/iso-week.test.ts apps/web/src/server/usecases/org-posts.ts apps/web/src/server/usecases/__tests__/org-posts-digest.test.ts && git commit -m "fix(news): at most one cron weekly digest per org per ISO week"
```

---

### Task 8: Point the route docstrings, and the two workflow-guard tests, at the new scheduler

**Files:**
- Modify (comments only): the docstrings in `apps/web/src/app/api/cron/{ai-previews,billing-events,billing-grant,billing-quantity,news-digest,registrations,relay-sweep}/route.ts` and `apps/web/src/app/api/funnel/remind/route.ts`. That is 8 files; `relay-sweep` is new here (A6).
- Modify (comments and test titles only, A6): `apps/web/src/lib/__tests__/relay-sweep-workflow.test.ts` (header `:1-5`, and the title at `:67`), and `apps/web/src/lib/__tests__/registrations-sweep-workflow.test.ts` (the `MOVED 2026-09-09` block at `:23-34`). After cutover they would name the other repo as the scheduler, which is a test lying in its name (AGENTS.md class 4).

**The wording.** It must be true both before and after cutover, because this PR merges with `ACTIVE: "false"` (Task 11). Replace each route's scheduler sentence with:

`Schedule: apps/cron-worker/src/schedule.ts (the Cloudflare cron Worker). Until that environment's cutover (ACTIVE in apps/cron-worker/wrangler.json), the onryde/seazn.club.workflow leg fires it instead.`

`relay-sweep` is the exception. Nothing has ever scheduled it (R1), so its `:13-14` sentence ("The SCHEDULE lives in onryde/seazn.club.workflow (#757) …") becomes:

`Schedule: apps/cron-worker/src/schedule.ts, daily 04:17 UTC (owner 2026-10-01), live once that environment's ACTIVE is on. No GitHub workflow schedules it (lib/__tests__/relay-sweep-workflow.test.ts).`

Task 11 Step 7 removes the "Until … cutover" sentence once both environments have cut over.

- [ ] **Step 1: Find the stale scheduler references**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && grep -a -n -i -E "vercel cron|any scheduler|\.github/workflows|scheduled by|no scheduler exists|schedule lives|seazn\.club\.workflow|-stg\.yml" apps/web/src/app/api/cron/*/route.ts apps/web/src/app/api/funnel/remind/route.ts
```
Expected: at least one hit in each of the 8 route files. Read any file with no hit by hand, because its wording may differ. The billing-grant route also names `billing-grant-stg.yml` in a comment inside `POST` (about `:54`); fix it too.

- [ ] **Step 2: Edit each hit** with the wording above. Keep every other sentence as it is. For `news-digest/route.ts`, also state that the Worker never retries it, that a manual `/run` is allowed (R2), and that V429 caps cron digests at one per org per ISO week. Change comments only.

- [ ] **Step 3: Edit the two guard tests (A6).**
  - `relay-sweep-workflow.test.ts` `:1-5`: the claim stays the same (no workflow **here** may schedule the sweep), but the reason changes. The schedule is the cron Worker's (`apps/cron-worker/src/schedule.ts`, daily 04:17 UTC, R1), so a GitHub workflow that also scheduled it would double-run retention and the orphan pass. Drop "naming it for the owner is Task 17's".
  - The same file's title at `:67`, `"the endpoint the other repo's workflow POSTs to exists here and calls the sweep"`, becomes `"the endpoint the cron Worker POSTs to exists here and calls the sweep"`. Leave the assertions alone.
  - `registrations-sweep-workflow.test.ts` `:23-34`: keep the `MOVED 2026-09-09 (#757)` history, and add one sentence. The schedule then moved to `apps/cron-worker/src/schedule.ts` (Cloudflare cron Worker); the `onryde/seazn.club.workflow` legs fire it only until each environment's cutover. Leave every assertion and `runIf` alone.

- [ ] **Step 4: Verify only comments and titles changed**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git diff -U0 apps/web/src/app/api | grep -a '^[+-]' | grep -a -v '^[+-]\s*\(\*\|//\|/\*\*\)' | grep -a -v '^\(+++\|---\)'
```
Expected: no output.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git diff -U0 apps/web/src/lib/__tests__/relay-sweep-workflow.test.ts apps/web/src/lib/__tests__/registrations-sweep-workflow.test.ts | grep -a '^[+-]' | grep -a -v '^[+-]\s*//' | grep -a -v '^\(+++\|---\)'
```
Expected: exactly the two title lines of the `:67` `it(` (one `-`, one `+`), and nothing else.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t8.json src/lib/__tests__/relay-sweep-workflow.test.ts src/lib/__tests__/registrations-sweep-workflow.test.ts; jq '.numPassedTests, .numTotalTests, .numPendingTests, (.testResults | length)' /tmp/cw-t8.json
```
Expected: the passed and total counts are equal to what they were before your edit (run the command once before Step 3 and record them), and 2 files are listed. `registrations-sweep-workflow.test.ts` keeps its `runIf`-skipped block, so its pending count is unchanged too.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/web/src/app/api apps/web/src/lib/__tests__/relay-sweep-workflow.test.ts apps/web/src/lib/__tests__/registrations-sweep-workflow.test.ts && git commit -m "docs(cron): route docstrings and workflow guards point at the Cloudflare cron Worker"
```

---

### Task 9: Deploy wiring (stg on push to main, prod on tag) with smoke

**Files:**
- Modify: `.github/workflows/stg.yml` (add job `deploy-cron-worker-stg`)
- Modify: `.github/workflows/prod.yml` (add job `deploy-cron-worker-prod`)

**Owner prerequisites.** The implementer cannot do these; list them in the PR body. Each one that writes to Cloudflare is marked.
- **STOP: owner OK required (Cloudflare write).** Create a Cloudflare API token scoped to Account "Seazn Club" with Workers Scripts: Edit. If deploys answer 403, use the "Edit Cloudflare Workers" template scoped to the account. Store it as the repo secret `CLOUDFLARE_API_TOKEN`, and add the repo secret `CLOUDFLARE_ACCOUNT_ID` = `ecaa471818e93892078446eae972a543`.
- Repo secrets `STAGING_CRON_SECRET` / `PROD_CRON_SECRET`, used by the smoke step. They hold the same values as the Fly apps' `CRON_SECRET`. Today they exist only in the workflow repo.
- Repo variables `STAGING_CRON_WORKER_URL` / `PROD_CRON_WORKER_URL`: the Workers' `*.workers.dev` URLs, which the first `wrangler deploy` prints. The account's workers.dev subdomain is `ashokhein`, so they will be `https://seazn-cron-stg.ashokhein.workers.dev` and `https://seazn-cron-prod.ashokhein.workers.dev`.
- **STOP: owner OK required (Cloudflare write).** Set the Worker secrets, once per env and **after that env's first deploy**, because `secret put` on a missing script creates the script:
  - `pnpm --filter @seazn/cron-worker exec wrangler secret put CRON_SECRET --env stg`, and the same with `--env prod`;
  - `SENTRY_DSN` for `--env prod` (**required**; without it prod's run lines say `sentry:"off"` and failures reach only the logs), using the Fly prod app's DSN (`fly.toml`);
  - `SENTRY_DSN` for `--env stg` (recommended), using `fly.stg.toml`'s DSN. Events are tagged `environment: stg` and share the project's error quota.
- **STOP: owner OK required (Cloudflare write).** Merging this PR runs `stg.yml`, which deploys `seazn-cron-stg`. The deploy creates the script, registers trigger 1 of 5, and turns on workers.dev and Workers Logs. After that, every push to `main` redeploys stg; the owner's OK to merge covers that.
- **STOP: owner OK required (Cloudflare write).** The owner's next `v*.*.*` tag runs `prod.yml`, which deploys `seazn-cron-prod` and registers trigger 2 of 5. Tagging is the owner's call. The prod smoke then runs a real `ai-previews` deletion on the prod DB at every tag. It is idempotent, but it is a production side effect; say so in the PR body.

- [ ] **Step 1: Re-read both workflow files** (`sed -n 1,60p .github/workflows/stg.yml`, and the same for `prod.yml`). Confirm the triggers are still `push: branches: [main]` and `push: tags: v*.*.*`. They have changed before; see AGENTS.md on `e2e.yml`.

- [ ] **Step 2: Add the stg job** at the end of `jobs:` in `.github/workflows/stg.yml`:

```yaml
  deploy-cron-worker-stg:
    name: Deploy cron Worker (staging)
    runs-on: ubuntu-latest
    concurrency:
      group: deploy-cron-worker-stg
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
        with:
          version: 10.34.5
      - uses: actions/setup-node@v5
        with:
          node-version: 26
          cache: pnpm
      - run: pnpm install --frozen-lockfile --filter @seazn/cron-worker...
      - run: pnpm --filter @seazn/cron-worker test
      - name: wrangler deploy --env stg
        run: pnpm --filter @seazn/cron-worker exec wrangler deploy --env stg
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      # Smoke: one idempotent job through the Worker's manual endpoint, end to
      # end (Worker → Cloudflare → Fly → DB). Spec §8, §12.2. The app's own
      # deploy job runs beside this one (toolchain.test.ts forbids `needs:` in
      # this file), so the smoke retries across the Fly rollout (A7);
      # ai-previews is idempotent. An unset URL is a WARNING, never a silent skip.
      - name: Smoke — manual run of ai-previews
        env:
          WORKER_URL: ${{ vars.STAGING_CRON_WORKER_URL }}
          CRON_SECRET: ${{ secrets.STAGING_CRON_SECRET }}
        run: |
          if [ -z "$WORKER_URL" ]; then
            echo "::warning::STAGING_CRON_WORKER_URL is not set, so the cron Worker smoke did NOT run. Set it to the URL the first deploy printed."
            exit 0
          fi
          curl --silent --show-error --fail-with-body --max-time 90 \
            --retry 5 --retry-delay 20 --retry-all-errors \
            -X POST "$WORKER_URL/run?job=ai-previews" \
            -H "x-cron-secret: $CRON_SECRET"
```

- [ ] **Step 3: Add the prod job** to `.github/workflows/prod.yml`. It is identical except for: name `deploy-cron-worker-prod`, `cancel-in-progress: false`, `--env prod`, `vars.PROD_CRON_WORKER_URL` (and `PROD_CRON_WORKER_URL` in the warning text), and `secrets.PROD_CRON_SECRET`.

- [ ] **Step 4: Validate the YAML**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && for f in stg prod ci; do node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/$f.yml','utf8'))" && echo "$f ok"; done
```
Expected: `stg ok`, `prod ok`, `ci ok`. If the `yaml` package is not resolvable from the root, use `npx --yes yaml valid < file`.

- [ ] **Step 5: Run the wiring guards that read `stg.yml`/`prod.yml` or sweep the workflows directory**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t9-wiring.json src/__tests__/toolchain.test.ts src/lib/__tests__/relay-drivers-ci-wiring.test.ts src/lib/__tests__/relay-sweep-workflow.test.ts src/lib/__tests__/stg-base-url.test.ts; jq '.numPassedTests, .numTotalTests, .numFailedTestSuites, (.testResults | length)' /tmp/cw-t9-wiring.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/cw-t9-scripts.json scripts/matrix/__tests__/ci-wiring.test.ts; jq '.numPassedTests, .numTotalTests, .numFailedTestSuites, (.testResults | length)' /tmp/cw-t9-scripts.json
```
Expected: in each report the passed and total counts are equal, `numFailedTestSuites` is `0`, and the file counts are `4` and `1`.

- [ ] **Step 6: Dry-run the bundle (no API call, so no OK is needed)**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && pnpm --filter @seazn/cron-worker exec wrangler deploy --env stg --dry-run --outdir /tmp/cw-dry; echo EXIT=$?
```
Expected: `EXIT=0`, and the output lists the vars `ENV_NAME`, `BASE_URL` and `ACTIVE` (m7). `--dry-run` prints bindings, not triggers, so do **not** expect the cron schedule here; the trigger check is `test/drift.test.ts`.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add .github/workflows/stg.yml .github/workflows/prod.yml && git commit -m "ci: deploy the cron Worker with stg/prod and smoke it via /run"
```

- [ ] **Step 8: On the PR's own CI run** (read it; do not merge it):
  - The `container` job must be green (A2). This is what settles whether turbo inside the image trips on the lockfile importer whose directory `.dockerignore` removed. pnpm itself was probed and tolerates it.
  - The `gates` job's "Cron worker tests" step must show the package's test count.
  - Record the `gates` job's `pnpm install` duration, compared with `main`'s last run, in the PR body. Every workflow's frozen install now also pulls wrangler and workerd.

---

### Task 10: Local E2E through the real workerd runtime

**Files:**
- Create: `apps/cron-worker/test/e2e.local.test.ts` (skipped unless `CRON_E2E_BASE_URL`, `DATABASE_URL` and `CRON_SECRET` are set)

This proves the seam through its real producer and consumer (AGENTS.md class 1): real `wrangler dev`, a real scheduled firing, a real Next prod build, and a real DB side effect. It is local only: `wrangler dev` without `--remote` makes no Cloudflare API call.

- [ ] **Step 1: Write the test**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.CRON_E2E_BASE_URL; // e.g. http://localhost:3000 (a local PROD build)
const DB = process.env.DATABASE_URL;
const SECRET = process.env.CRON_SECRET ?? "";
const PORT = 8799;
// A8: pin the firing instant. A Tuesday 14:17 UTC slot runs only the three
// every-firing rows (spec §4). It never runs billing-quantity's Stripe calls
// (06), relay-sweep (04) or a Monday 08 digest, whatever the wall clock says.
const SLOT = Date.parse("2026-09-29T14:17:00Z");
const SLOT_JOBS = ["registrations", "billing-events", "funnel-remind"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!BASE || !DB || !SECRET)("cron Worker E2E (wrangler dev → local Next → DB)", () => {
  let dev: ChildProcess;
  let out = "";
  const sql = postgres(DB!, { max: 1 });
  const jobLines = () =>
    [...out.matchAll(/\{"event":"job"[^\n]*\}/g)].map((m) => JSON.parse(m[0]) as { job: string; scheduledTime: string });

  beforeAll(async () => {
    dev = spawn(
      "pnpm",
      ["exec", "wrangler", "dev", "--test-scheduled", "--port", String(PORT), "--env", "stg",
        "--var", `BASE_URL:${BASE}`, "--var", "ACTIVE:true", "--var", `CRON_SECRET:${SECRET}`],
      // A8: its own process GROUP. pnpm → wrangler → workerd, and killing pnpm
      // alone leaves workerd holding the port.
      { cwd: `${__dirname}/..`, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    dev.stdout!.on("data", (b) => void (out += String(b)));
    dev.stderr!.on("data", (b) => void (out += String(b)));
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`http://localhost:${PORT}/`);
        return;
      } catch {
        await sleep(1_000);
      }
    }
    throw new Error(`wrangler dev did not start:\n${out.slice(-2_000)}`);
  }, 90_000);

  afterAll(async () => {
    if (dev?.pid) {
      try {
        process.kill(-dev.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await sql.end();
  });

  it("a pinned hourly slot stamps reminded_at on a due funnel draft, and runs exactly that slot's jobs", async () => {
    const token = `e2e-${randomUUID()}`;
    const [draft] = await sql<{ id: string }[]>`
      insert into funnel_drafts (token, email, payload, expires_at, created_at)
      values (${token}, ${`${token}@example.test`}, ${sql.json({})}, now() + interval '6 days', now() - interval '25 hours')
      returning id`;
    const res = await fetch(
      `http://localhost:${PORT}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("17 * * * *")}&time=${SLOT}`,
    );
    expect(res.status).toBe(200);
    // The handler returns before waitUntil settles: poll for the side effect,
    // then for the Worker's own job lines.
    let reminded: Date | null = null;
    for (let i = 0; i < 60 && !reminded; i++) {
      const rows = await sql<{ reminded_at: Date | null }[]>`select reminded_at from funnel_drafts where id = ${draft!.id}`;
      reminded = rows[0]?.reminded_at ?? null;
      if (!reminded) await sleep(1_000);
    }
    expect(reminded).not.toBeNull();
    for (let i = 0; i < 30 && jobLines().length < SLOT_JOBS.length; i++) await sleep(1_000);
    // The pinned slot was honoured. A `time` the runtime ignored, or read in a
    // different unit, lands on another slot and fails here.
    expect(jobLines().map((l) => l.job)).toEqual(SLOT_JOBS);
    expect(new Set(jobLines().map((l) => l.scheduledTime))).toEqual(new Set([new Date(SLOT).toISOString()]));
  }, 120_000);
});
```

Before running:
- **Check the installed wrangler** (A8): `pnpm --filter @seazn/cron-worker exec wrangler --version`. Also read Cloudflare's "Test Cron Triggers using Wrangler" doc for the path and the `time` parameter's unit. `/cdn-cgi/handler/scheduled` is the documented path; if the installed version serves only `/__scheduled`, use that. If `time` is in seconds, pass `SLOT / 1000`. The `scheduledTime` assertion is the check, not a formality.
- **The `cron` parameter must name a known trigger** (R4). Any other value is refused as `unknown-trigger`, and nothing runs.
- Read `apps/web/src/app/api/funnel/remind/route.ts` end to end. Pre-flight confirmed that `reminded_at` is stamped unconditionally (`route.ts:41-42`), even when the email fails or the payload is invalid, so the `{}` seed works. Re-confirm that it still is. If it no longer is, assert a different every-firing job's side effect instead. Never fake the email.

- [ ] **Step 2: Run it against a local prod build.** Follow the `seazn-local-env` skill: a fresh test DB, `db:apply` + `sync:sports`, a prod build started with `CRON_SECRET` set, and `BASE` on `localhost`, never `127.0.0.1`.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && CRON_E2E_BASE_URL=http://localhost:3000 CRON_SECRET=<local value> DATABASE_URL=<test db url> npx vitest run --reporter=json --outputFile=/tmp/cw-e2e.json test/e2e.local.test.ts; jq '.numPassedTests, .numTotalTests, .numPendingTests' /tmp/cw-e2e.json; lsof -nP -iTCP:8799 -sTCP:LISTEN; echo LSOF_EXIT=$?
```
Expected: `1`, `1`, `0`, then no listener and `LSOF_EXIT=1`, which shows the process-group kill freed the port. A `numPendingTests` of 1 means the test was skipped (env not set), which is not a pass.

- [ ] **Step 3: Mutation checks, each restored from a `cp` backup.**
  - Spawn with `--var ACTIVE:false`. Expected: red, because `reminded_at` stays null and only the probe ran.
  - Fire with `cron=*/5 * * * *` (URL-encoded). Expected: red, because the Worker refuses an unknown trigger.

- [ ] **Step 4: Typecheck the package** (the Task 1 Step 9 command; this file imports `postgres` and `node:child_process`). Expected: `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/test/e2e.local.test.ts && git commit -m "test(cron-worker): local E2E through wrangler dev at a pinned slot"
```

---

### Task 11: Cutover runbook (owner-gated, after the PR merges)

**Files:**
- Modify (separate PR in `onryde/seazn.club.workflow`): the 7 curl workflows get a job-level gate on each leg.
- Modify (this repo, small PRs): the `ACTIVE` values in `apps/cron-worker/wrangler.json`, and the transitional docstring sentence from Task 8.

The implementer prepares the PRs; **the owner merges each step.** Never have two schedulers active for one environment. Every Cloudflare write below is marked; an implementer who reaches one stops and reports.

The soak is read from **Workers Logs**: the `event:"job"`, `event:"run"` and `event:"probe"` lines, plus Sentry **error events** tagged `job`. Cron monitors are deferred (see "Deferred" below), so no Sentry monitor exists to read, and a stopped scheduler shows only as **missing** `event:"run"` lines. Count them; do not wait for an alert.

- [ ] **Step 1: Workflow-repo PR: add per-environment gates.** In each of `ai-preview-sweep.yml`, `billing-events.yml`, `billing-grant.yml`, `billing-quantity.yml`, `funnel-reminders.yml`, `news-digest.yml` and `registrations-sweep.yml`, add a job-level `if:` to each leg:

```yaml
  sweep-staging:            # (the job ids differ per file; keep each file's own)
    if: vars.CRON_ON_GITHUB_STG != 'false'
  ...
  sweep-production:
    if: vars.CRON_ON_GITHUB_PROD != 'false'
```

The default (variable unset) keeps today's behaviour. On prod, `registrations-sweep.yml`'s existing step-level `PROD_SWEEP_ENABLED` gate composes with the new job-level one. `simulation-nightly.yml` is untouched. There is no relay-sweep workflow to gate (R1); it starts the day its environment's `ACTIVE` flips.

- [ ] **Step 2: Probe week, with both Workers deployed and `ACTIVE: "false"`.** After the main PR merges, `seazn-cron-stg` deploys and probes `/api/health` hourly; prod does the same from the owner's next tag. Read the `{"event":"probe","httpStatus":200}` lines in the dashboard's Workers Logs, which is read-only. **STOP: owner OK required** before using `wrangler tail` instead, because it opens a tail session through the API.
  - **If the probe shows 403 or HTML (a challenge):** **STOP: owner OK required (Cloudflare write: the PR redeploys).** Change that env's `BASE_URL` to `https://seazn-club-stg.fly.dev` (or the prod app's `fly.dev` host) in a PR. The app has no host redirect (`proxy.ts` has rewrites only, and `/api/*` POSTs without an `Origin` header pass), so no app change is needed. Re-probe.

- [ ] **Step 3: Staging switch, done in the same hour window.** **STOP: owner OK required (Cloudflare write: the merge redeploys and turns scheduling on).**
  1. `gh variable set CRON_ON_GITHUB_STG --body false -R onryde/seazn.club.workflow`
  2. Merge the PR that sets stg `ACTIVE` to `"true"` (this deploys through `stg.yml`).
  3. Record the switch time.

- [ ] **Step 4: 72 h staging soak.** Pass bar (spec §2, §7), read from Workers Logs:
  - Each hourly firing logs one `event:"run"` line with `cron:"17 * * * *"`: at least 23 per 24 h, and each lists the 3 every-firing jobs.
  - Each daily job (ai-previews 03, relay-sweep 04, billing-quantity 06, billing-grant 07) and the Monday digest start at HH:17 ±15 min.
  - Every `status:"error"` or `status:"degraded"` line, and every Sentry error event tagged `environment: stg`, is explained.
  - relay-sweep has never run on a schedule before. Read its first runs' `ms`; at or near 60 s it is a timeout risk (the error is reported and the server-side pass still finishes). Its retention pass deletes recordings for real, which is intended (R1).
  - No org on staging gains a second cron digest in one ISO week. This query returns no rows: `select org_id, auto_source->>'cron_week', count(*) from org_posts where auto_source ? 'cron_week' group by 1,2 having count(*) > 1;`
  - Record the counts in the PR or issue before moving on.

- [ ] **Step 5: Production switch.** Repeat Step 2's probe check for prod. Then **STOP: owner OK required (Cloudflare write).** Repeat Step 3 with `CRON_ON_GITHUB_PROD` and the prod `ACTIVE` flip, which `prod.yml` deploys on the next tag; tagging is the owner's call. Then run a 72 h soak with the same bar. In addition, prod's `event:"run"` lines must read `sentry:"on"`: the `SENTRY_DSN` prerequisite is set and parses.

- [ ] **Step 6: Rollback drill, written into the PR body and not executed.** **STOP: owner OK required (Cloudflare write) before any rollback.** Run `gh variable set CRON_ON_GITHUB_<ENV> --body true` and revert the `ACTIVE` PR, which redeploys. Alternatively, run an out-of-band `wrangler deploy --env <env>` with `"crons": []`; it cannot go through a PR, because the drift test pins the crons. Either takes effect within about an hour.

- [ ] **Step 7: Cleanup, after both soaks pass.** In a workflow-repo PR, delete the 7 moved workflow files. In this repo, drop the transitional "Until that environment's cutover …" sentence from the route docstrings (Task 8). Update memory `reference_scheduled_cron_workflows_live_in_a_separate_repo` and `reference_github_schedule_cron_runs_late_and_drops` to record the move.

---

## Deferred: Sentry cron monitors (owner, 2026-10-01)

These would add missed-run alerting, the one thing error events cannot give (spec §2 goal 2, §6). The natural shape is one `cron-worker-heartbeat` monitor on `17 * * * *`, checked in once per hourly invocation. Sentry's plan includes one monitor, at 6 check-ins per minute per monitor environment. On a paid plan, the alternative is one monitor per job. Until this is picked up, the Worker calls no check-in endpoint (pinned by Task 4's week sweep and Task 5), and a Worker that stops firing shows only as missing `event:"run"` lines.

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Where |
  |---|---|
  | §3 | T1, T4, T6 |
  | §4 (+ R1 row) | T1 |
  | §5 retry | T2 |
  | §5 digest guard | T7 |
  | §6 | Superseded by §13.5: error events in T3 and T4, cron monitors deferred |
  | §7 | T11 |
  | §8 unit | T1–T5 |
  | §8 drift | T6 |
  | §8 integration/E2E | T4, T10 |
  | §8 regression | T7 |
  | §8 smoke | T9 |
  | §9 R1 | T4 probe, T11 Step 2 |
  | §9 R2 | Moot: monitoring deferred (§13.5) |
  | §9 R3 | Workers metrics during the soak |
  | §9 R5 | T4 failing-job test |
  | §9 R6 | T2 timeout test |
  | §12.1–12.6 | T4, T5, T4, all, T7, T6 (+ T1 `.dockerignore`, A2) |
  | §13 | See the "Where each item landed" table in the header |
  | Route docstrings (§7.5) | T8 |
- **Open items:** none block a task. Cron monitoring is deferred by the owner. Spec §2's goal 2 ("a missed run is never silent") is met only for runs that happen and fail. A scheduler that stops firing raises nothing until the Deferred section is picked up.
- **Lint:** `apps/cron-worker` is not covered by the root `lint` script. That script covers apps/web, packages/engine, packages/reference and scripts (m9). This is accepted for this small package; its typecheck and tests are covered in CI.
- **Capture-QR v2 forward notes (v2 owns these, not this plan):**
  - Adding `stream-tick` is one `JOBS` row with `trigger: "*/5 * * * *"` and `due: { kind: "every" }`, plus that cron in both envs of `wrangler.json`. The drift test forces the second part. It brings the account to 4 of 5 triggers on Workers Free.
  - The 12-minute run deadline is longer than a 5-minute cadence, so slow ticks can overlap.
  - A `*/5` job that fails persistently sends one error event per tick (288 a day), against the Sentry project's shared error quota.
