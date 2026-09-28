# Cloudflare Cron Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitHub Actions `schedule:` triggers for the 7 cron-shaped routes with a Cloudflare Worker that fires on time, alerts on missed runs, and never double-fires the non-idempotent news digest.

**Architecture:** A new workspace `apps/cron-worker` is deployed as two Workers (`seazn-cron-stg`, `seazn-cron-prod`), each with one hourly trigger at `:17`. A pure schedule table picks the due jobs. Each job is a `POST` with `x-cron-secret` to the unchanged Next routes, bracketed by Sentry Cron Monitor check-ins. The news digest gets a DB-enforced once-per-ISO-week guard on its cron path only.

**Tech Stack:** Cloudflare Workers (wrangler, `wrangler.json`), TypeScript, vitest ^4.1.11 (Node environment), postgres.js (E2E only), Flyway SQL migration, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md`. Read §1–§12; §12 lists the plan-time amendments.

## Global Constraints

- pnpm `10.34.5`, Node `>=26`. The workspace glob `apps/*` already exists in `pnpm-workspace.yaml`.
- TypeScript typecheck via `node ../../node_modules/typescript-native/bin/tsc --noEmit` (TS7), the same shape as `apps/web/package.json:10-14`.
- The trigger cron is exactly `17 * * * *`, one per Worker env. That is 2 triggers per account (Workers Free limit 5).
- Per-job HTTP timeout `60_000` ms. Retry at most 2 times with `2_000` ms then `8_000` ms backoff, **only** on HTTP 502/503/504 or a thrown non-timeout network error, and only for jobs with `retry: true`. Never retry a timeout, a 4xx, or `news-digest`.
- Run deadline `12 * 60_000` ms per invocation (cron wall limit 15 min).
- The request header is `x-cron-secret`. The routes are unchanged except news-digest's usecase (Task 7).
- Sentry monitor slug `cron-{ENV_NAME}-{jobId}`, `checkin_margin: 15`, `max_runtime: 15`, `timezone: "UTC"`. Check-ins are best-effort: 5 s timeout, never throw, never block a job.
- Env vars per Worker env: `ENV_NAME` (`stg`|`prod`), `BASE_URL`, `ACTIVE` (`"true"`|`"false"`, default `"false"`). Secrets: `CRON_SECRET`, `SENTRY_DSN` (optional).
- **Never two schedulers per environment.** `ACTIVE` flips to `"true"` only after that environment's GitHub legs are gated off (Task 11).
- Subagents run only the test files they changed. Do **not** run `apps/web` `tsc`/`lint` locally; CI covers it (`docs/superpowers/RULES.md`). The cron-worker's own `pnpm --filter @seazn/cron-worker typecheck` is cheap and allowed.
- Judge vitest green only from `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`), and confirm `.testResults[].name` shows the intended files (AGENTS.md "Verification traps").
- Every shell call is prefixed `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron &&`. The shell cwd resets between calls.

## Review Focus

1. **A cron firing arrives late** (invoked 09:02 for the 08:17 slot). It must still select the 08:17 slot's jobs. `dueJobs` keys on `scheduledTime`, not `Date.now()`; tested in Task 1.
2. **A secret mismatch** between the Worker and Fly (401 from the route). This must produce an `error` result and check-in, not a skip. Tested in Task 2 (4xx is an error, no retry) and Task 4 (error check-in sent).
3. **Sentry unreachable or DSN unset.** Jobs must still run and results still log. Tested in Task 3 (checkIn swallows) and Task 4 (runs with no DSN).
4. **Double fire of the Monday 08:17 slot**, from Cloudflare redelivery or an overlap during cutover. At most one cron digest per org, while a console press still creates one. Tested in Task 7.
5. **The manual `/run` endpoint called with a missing, empty or wrong secret, an unknown job, or `news-digest`.** It must return 401/404/403 and must never run the job. Tested in Task 5.

---

### Task 1: Scaffold `apps/cron-worker` with the schedule table and `dueJobs`

**Files:**
- Create: `apps/cron-worker/package.json`
- Create: `apps/cron-worker/tsconfig.json`
- Create: `apps/cron-worker/vitest.config.ts`
- Create: `apps/cron-worker/src/schedule.ts`
- Test: `apps/cron-worker/test/schedule.test.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Produces:
  - `type JobId = "registrations" | "billing-events" | "funnel-remind" | "ai-previews" | "billing-quantity" | "billing-grant" | "news-digest"`
  - `type Due = { kind: "hourly" } | { kind: "daily"; hourUtc: number } | { kind: "weekly"; weekdayUtc: number; hourUtc: number }`
  - `interface Job { id: JobId; path: string; due: Due; retry: boolean; manual: boolean }`
  - `const TRIGGER_MINUTE = 17`, `const TRIGGER_CRON = "17 * * * *"`
  - `const JOBS: readonly Job[]`
  - `function dueJobs(scheduledTime: Date): Job[]`
  - `function jobCrontab(job: Job): string`

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

Then install the dev dependencies (latest wrangler and workers-types; vitest pinned to match `apps/web`):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && pnpm --filter @seazn/cron-worker add -D wrangler @cloudflare/workers-types vitest@^4.1.11 @types/node postgres
```

Expected: `pnpm-lock.yaml` changes, and `apps/cron-worker/package.json` gains the five devDependencies. Record the resolved wrangler version in the commit message.

If `tsc` later reports duplicate global declarations between `@cloudflare/workers-types` and `@types/node`, drop `"node"` from `types`. Then add `/// <reference types="node" />` at the top of only the tests that use `node:fs`/`node:child_process` (`drift.test.ts`, `e2e.local.test.ts`).

- [ ] **Step 2: Write the failing test**

`apps/cron-worker/test/schedule.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { JOBS, TRIGGER_CRON, dueJobs, jobCrontab } from "../src/schedule";

const at = (iso: string) => new Date(iso);
const ids = (d: Date) => dueJobs(d).map((j) => j.id);
const HOURLY = ["registrations", "billing-events", "funnel-remind"];

describe("dueJobs", () => {
  it("runs only the hourly jobs at an ordinary hour", () => {
    expect(ids(at("2026-09-29T14:17:00Z"))).toEqual(HOURLY); // Tuesday
  });

  it("adds each daily job at its own hour, in table order", () => {
    expect(ids(at("2026-09-29T03:17:00Z"))).toEqual([...HOURLY, "ai-previews"]);
    expect(ids(at("2026-09-29T06:17:00Z"))).toEqual([...HOURLY, "billing-quantity"]);
    expect(ids(at("2026-09-29T07:17:00Z"))).toEqual([...HOURLY, "billing-grant"]);
  });

  it("runs news-digest on Monday 08 UTC and on no other day at 08", () => {
    expect(ids(at("2026-09-28T08:17:00Z"))).toEqual([...HOURLY, "news-digest"]); // Monday
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
      expect(ids(at(`${day}T08:17:00Z`))).toEqual(HOURLY);
    }
  });

  it("selects by the SCHEDULED time, whatever minute it carries", () => {
    // A late invocation still carries its slot's scheduledTime; the minute is irrelevant.
    expect(ids(at("2026-09-28T08:59:59Z"))).toContain("news-digest");
    expect(ids(at("2026-09-28T09:00:00Z"))).not.toContain("news-digest");
  });

  it("over one full week: each hourly job 168×, each daily 7×, the digest 1×", () => {
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
      "billing-quantity": 7,
      "billing-grant": 7,
      "news-digest": 1,
    });
  });
});

describe("JOBS table", () => {
  it("has unique ids and paths", () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    expect(new Set(JOBS.map((j) => j.path)).size).toBe(JOBS.length);
  });

  it("news-digest is the one job that never retries and cannot be run manually", () => {
    const digest = JOBS.find((j) => j.id === "news-digest")!;
    expect(digest.retry).toBe(false);
    expect(digest.manual).toBe(false);
    expect(JOBS.filter((j) => j.id !== "news-digest").every((j) => j.retry && j.manual)).toBe(true);
  });

  it("jobCrontab renders the Sentry monitor schedule for each cadence", () => {
    const byId = Object.fromEntries(JOBS.map((j) => [j.id, jobCrontab(j)]));
    expect(byId).toEqual({
      registrations: TRIGGER_CRON,
      "billing-events": TRIGGER_CRON,
      "funnel-remind": TRIGGER_CRON,
      "ai-previews": "17 3 * * *",
      "billing-quantity": "17 6 * * *",
      "billing-grant": "17 7 * * *",
      "news-digest": "17 8 * * 1",
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t1.json test/schedule.test.ts; jq '.numFailedTestSuites, .testResults[].message' /tmp/cw-t1.json
```
Expected: a suite failure, because `../src/schedule` cannot be resolved.

- [ ] **Step 4: Implement `src/schedule.ts`**

```ts
/**
 * The ONE place a scheduled job is declared. The Worker has a single hourly
 * trigger (TRIGGER_CRON, mirrored in wrangler.json and pinned by
 * test/drift.test.ts); `dueJobs` decides which jobs a firing runs. Times are UTC.
 * Spec: docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md §4.
 */
export type JobId =
  | "registrations"
  | "billing-events"
  | "funnel-remind"
  | "ai-previews"
  | "billing-quantity"
  | "billing-grant"
  | "news-digest";

export type Due =
  | { kind: "hourly" }
  | { kind: "daily"; hourUtc: number }
  | { kind: "weekly"; weekdayUtc: number; hourUtc: number };

export interface Job {
  id: JobId;
  /** Route on the Next app, POSTed with `x-cron-secret`. */
  path: string;
  due: Due;
  /** Safe to re-send after a 502/503/504 or a network error (the route is idempotent). */
  retry: boolean;
  /** May be run on demand through the Worker's `POST /run?job=`. */
  manual: boolean;
}

export const TRIGGER_MINUTE = 17;
export const TRIGGER_CRON = `${TRIGGER_MINUTE} * * * *`;

export const JOBS: readonly Job[] = [
  { id: "registrations", path: "/api/cron/registrations", due: { kind: "hourly" }, retry: true, manual: true },
  { id: "billing-events", path: "/api/cron/billing-events", due: { kind: "hourly" }, retry: true, manual: true },
  { id: "funnel-remind", path: "/api/funnel/remind", due: { kind: "hourly" }, retry: true, manual: true },
  { id: "ai-previews", path: "/api/cron/ai-previews", due: { kind: "daily", hourUtc: 3 }, retry: true, manual: true },
  { id: "billing-quantity", path: "/api/cron/billing-quantity", due: { kind: "daily", hourUtc: 6 }, retry: true, manual: true },
  { id: "billing-grant", path: "/api/cron/billing-grant", due: { kind: "daily", hourUtc: 7 }, retry: true, manual: true },
  // NOT idempotent by design (P3/D7): never retried, never run by hand. The
  // DB guard in org-posts.ts (`cron_week`) is the backstop, not a licence.
  {
    id: "news-digest",
    path: "/api/cron/news-digest",
    due: { kind: "weekly", weekdayUtc: 1, hourUtc: 8 },
    retry: false,
    manual: false,
  },
];

function isDue(due: Due, t: Date): boolean {
  switch (due.kind) {
    case "hourly":
      return true;
    case "daily":
      return t.getUTCHours() === due.hourUtc;
    case "weekly":
      return t.getUTCDay() === due.weekdayUtc && t.getUTCHours() === due.hourUtc;
  }
}

/** Jobs due at this firing, in table order. Keyed on the SCHEDULED time, so a
 *  late invocation still runs its own slot's jobs. */
export function dueJobs(scheduledTime: Date): Job[] {
  return JOBS.filter((j) => isDue(j.due, scheduledTime));
}

/** The job's effective schedule as a crontab, for its Sentry monitor. */
export function jobCrontab(job: Job): string {
  switch (job.due.kind) {
    case "hourly":
      return TRIGGER_CRON;
    case "daily":
      return `${TRIGGER_MINUTE} ${job.due.hourUtc} * * *`;
    case "weekly":
      return `${TRIGGER_MINUTE} ${job.due.hourUtc} * * ${job.due.weekdayUtc}`;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t1.json test/schedule.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t1.json
```
Expected: `8`, `8`, and the path ending `apps/cron-worker/test/schedule.test.ts`.

- [ ] **Step 6: Mutation check.** Change `weekdayUtc: 1` to `weekdayUtc: 2` and re-run. Expected: the Monday test and the week-count test go red. Revert.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker pnpm-lock.yaml && git commit -m "feat(cron-worker): scaffold workspace with schedule table and dueJobs"
```

---

### Task 2: `callJob`, the HTTP call with the retry policy

**Files:**
- Create: `apps/cron-worker/src/call.ts`
- Test: `apps/cron-worker/test/call.test.ts`

**Interfaces:**
- Consumes: `Job` from `src/schedule.ts`.
- Produces:
  - `interface CallDeps { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number }`
  - `interface CallOutcome { status: "ok" | "error"; httpStatus: number | null; attempts: number; ms: number; reason?: "http" | "timeout" | "network" | "deadline"; body?: string }`
  - `const JOB_TIMEOUT_MS = 60_000`, `const BACKOFF_MS = [2_000, 8_000] as const`
  - `function callJob(job: Job, baseUrl: string, secret: string, deps: CallDeps, deadlineMs: number): Promise<CallOutcome>`

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/call.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { BACKOFF_MS, callJob, type CallDeps } from "../src/call";
import { JOBS, type Job } from "../src/schedule";

const job = (id: string): Job => JOBS.find((j) => j.id === id)!;
const res = (status: number, body = "{}") => new Response(body, { status });
const timeoutErr = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

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
  it("POSTs the route with the cron secret and reports ok", async () => {
    const d = deps([res(200, '{"swept":3}')]);
    const out = await callJob(job("registrations"), "https://stg.seazn.club", "s3cret", d, Infinity);
    expect(out).toMatchObject({ status: "ok", httpStatus: 200, attempts: 1, body: '{"swept":3}' });
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("https://stg.seazn.club/api/cron/registrations");
    expect(init.method).toBe("POST");
    expect(init.headers["x-cron-secret"]).toBe("s3cret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([502, 503, 504])("retries a %i twice with 2s then 8s backoff", async (code) => {
    const d = deps([res(code), res(code), res(200)]);
    const out = await callJob(job("billing-events"), "https://x", "s", d, Infinity);
    expect(out).toMatchObject({ status: "ok", attempts: 3 });
    expect(d.sleeps).toEqual([...BACKOFF_MS]);
  });

  it("gives up after 3 attempts and reports the last status", async () => {
    const d = deps([res(503), res(503), res(503)]);
    expect(await callJob(job("billing-events"), "https://x", "s", d, Infinity)).toMatchObject({
      status: "error", httpStatus: 503, attempts: 3, reason: "http",
    });
  });

  it.each([400, 401, 403, 404, 500])("never retries a %i", async (code) => {
    const d = deps([res(code)]);
    expect(await callJob(job("registrations"), "https://x", "s", d, Infinity)).toMatchObject({
      status: "error", httpStatus: code, attempts: 1, reason: "http",
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("never retries a timeout: the server may already be running the job", async () => {
    const d = deps([timeoutErr()]);
    expect(await callJob(job("registrations"), "https://x", "s", d, Infinity)).toMatchObject({
      status: "error", httpStatus: null, attempts: 1, reason: "timeout",
    });
  });

  it("retries a network error for an idempotent job", async () => {
    const d = deps([new TypeError("connection reset"), res(200)]);
    expect(await callJob(job("funnel-remind"), "https://x", "s", d, Infinity)).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("never retries news-digest, not even on a 503 or a network error", async () => {
    for (const first of [res(503), new TypeError("reset")]) {
      const d = deps([first]);
      expect(await callJob(job("news-digest"), "https://x", "s", d, Infinity)).toMatchObject({ status: "error", attempts: 1 });
      expect(d.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not start an attempt past the deadline", async () => {
    const d = { ...deps([res(503)]), now: () => 1_000 };
    expect(await callJob(job("registrations"), "https://x", "s", d, 1_000)).toMatchObject({
      status: "error", attempts: 0, reason: "deadline",
    });
    expect(d.fetch).not.toHaveBeenCalled();
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

export interface CallOutcome {
  status: "ok" | "error";
  httpStatus: number | null;
  attempts: number;
  ms: number;
  reason?: "http" | "timeout" | "network" | "deadline";
  /** First 500 chars of the route's response, for the log line. */
  body?: string;
}

export const JOB_TIMEOUT_MS = 60_000;
export const BACKOFF_MS = [2_000, 8_000] as const;

const RETRYABLE = new Set([502, 503, 504]);

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * POST one job's route. Retries ONLY a 502/503/504 or a pre-response network
 * error, and only when `job.retry` — never a timeout (the server may already
 * be running the job), never a 4xx, never news-digest. Spec §5.
 */
export async function callJob(
  job: Job,
  baseUrl: string,
  secret: string,
  deps: CallDeps,
  deadlineMs: number,
): Promise<CallOutcome> {
  const started = deps.now();
  const maxAttempts = job.retry ? 1 + BACKOFF_MS.length : 1;
  let last: CallOutcome = { status: "error", httpStatus: null, attempts: 0, ms: 0, reason: "deadline" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.now() >= deadlineMs) return { ...last, ms: deps.now() - started, reason: "deadline" };
    try {
      const res = await deps.fetch(`${baseUrl}${job.path}`, {
        method: "POST",
        headers: { "x-cron-secret": secret },
        signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
      });
      const body = (await res.text()).slice(0, 500);
      if (res.ok) return { status: "ok", httpStatus: res.status, attempts: attempt, ms: deps.now() - started, body };
      last = { status: "error", httpStatus: res.status, attempts: attempt, ms: 0, reason: "http", body };
      if (!RETRYABLE.has(res.status)) break;
    } catch (err) {
      if (isTimeout(err)) {
        return { status: "error", httpStatus: null, attempts: attempt, ms: deps.now() - started, reason: "timeout" };
      }
      last = { status: "error", httpStatus: null, attempts: attempt, ms: 0, reason: "network", body: String(err).slice(0, 500) };
    }
    if (attempt < maxAttempts) await deps.sleep(BACKOFF_MS[attempt - 1]!);
  }
  return { ...last, ms: deps.now() - started };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t2.json test/call.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t2.json
```
Expected: the two counts are equal (14), and only `call.test.ts` is listed.

- [ ] **Step 5: Mutation checks, one at a time, each reverted.**
  - Change `maxAttempts` to always `3`. Expected: the news-digest test goes red.
  - Delete the `isTimeout` early return. Expected: the timeout test goes red.
  - Add `500` to `RETRYABLE`. Expected: the `never retries a 500` case goes red.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/call.ts apps/cron-worker/test/call.test.ts && git commit -m "feat(cron-worker): callJob with 5xx-only retry, no retry on timeout or news-digest"
```

---

### Task 3: Sentry Cron Monitor check-ins, best-effort

**Files:**
- Create: `apps/cron-worker/src/sentry.ts`
- Test: `apps/cron-worker/test/sentry.test.ts`

**Interfaces:**
- Consumes: `Job`, `jobCrontab` from `src/schedule.ts`.
- Produces:
  - `interface Dsn { origin: string; projectId: string; publicKey: string }`
  - `function parseDsn(dsn: string | undefined): Dsn | null`
  - `function monitorSlug(envName: string, job: Job): string` returns `cron-${envName}-${job.id}`
  - `function checkIn(fetchFn: typeof fetch, dsn: Dsn | null, slug: string, checkInId: string, status: "in_progress" | "ok" | "error", job: Job): Promise<void>` (never rejects)

Sentry HTTP check-in API (docs read 2026-09-28): `POST https://{ingest-host}/api/{project_id}/cron/{monitor_slug}/{public_key}/?check_in_id={uuid}&status={status}`, with an optional JSON body `{ "monitor_config": {...} }` that upserts the monitor. The body is sent on `in_progress` only.

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/sentry.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { checkIn, monitorSlug, parseDsn } from "../src/sentry";
import { JOBS } from "../src/schedule";

const digest = JOBS.find((j) => j.id === "news-digest")!;
const DSN = "https://abc123@o42.ingest.de.sentry.io/4507";

describe("parseDsn", () => {
  it("splits a DSN into ingest origin, project and public key", () => {
    expect(parseDsn(DSN)).toEqual({ origin: "https://o42.ingest.de.sentry.io", projectId: "4507", publicKey: "abc123" });
  });
  it.each([undefined, "", "not a url", "https://o42.ingest.sentry.io/4507"])("returns null for %j", (v) => {
    expect(parseDsn(v)).toBeNull();
  });
});

describe("checkIn", () => {
  it("posts in_progress with the monitor config upsert", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 202 }));
    await checkIn(fetchFn as never, parseDsn(DSN), monitorSlug("prod", digest), "id-1", "in_progress", digest);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://o42.ingest.de.sentry.io/api/4507/cron/cron-prod-news-digest/abc123/?check_in_id=id-1&status=in_progress",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      monitor_config: {
        schedule: { type: "crontab", value: "17 8 * * 1" },
        checkin_margin: 15,
        max_runtime: 15,
        timezone: "UTC",
        failure_issue_threshold: 1,
      },
    });
  });

  it("posts ok/error without a body", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await checkIn(fetchFn as never, parseDsn(DSN), "s", "id-2", "error", digest);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("check_in_id=id-2&status=error");
    expect(init.body).toBeUndefined();
  });

  it("does nothing without a DSN", async () => {
    const fetchFn = vi.fn();
    await checkIn(fetchFn as never, null, "s", "id", "ok", digest);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never rejects when Sentry is down", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("sentry unreachable");
    });
    await expect(checkIn(fetchFn as never, parseDsn(DSN), "s", "id", "ok", digest)).resolves.toBeUndefined();
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
import { jobCrontab, type Job } from "./schedule";

export interface Dsn {
  origin: string;
  projectId: string;
  publicKey: string;
}

const CHECKIN_TIMEOUT_MS = 5_000;

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

export function monitorSlug(envName: string, job: Job): string {
  return `cron-${envName}-${job.id}`;
}

/**
 * One Sentry Cron Monitor check-in. Best-effort by contract: a Sentry outage
 * must never stop or fail a job, so this swallows every error. Missed-run
 * alerting is Sentry's side (checkin_margin), which is the point — spec §6.
 */
export async function checkIn(
  fetchFn: typeof fetch,
  dsn: Dsn | null,
  slug: string,
  checkInId: string,
  status: "in_progress" | "ok" | "error",
  job: Job,
): Promise<void> {
  if (!dsn) return;
  const url =
    `${dsn.origin}/api/${dsn.projectId}/cron/${slug}/${dsn.publicKey}/` +
    `?check_in_id=${encodeURIComponent(checkInId)}&status=${status}`;
  const init: RequestInit = { method: "POST", signal: AbortSignal.timeout(CHECKIN_TIMEOUT_MS) };
  if (status === "in_progress") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify({
      monitor_config: {
        schedule: { type: "crontab", value: jobCrontab(job) },
        checkin_margin: 15,
        max_runtime: 15,
        timezone: "UTC",
        failure_issue_threshold: 1,
      },
    });
  }
  try {
    await fetchFn(url, init);
  } catch {
    // swallowed by contract
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t3.json test/sentry.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t3.json
```
Expected: the two counts are equal (9), and only `sentry.test.ts` is listed.

- [ ] **Step 5: Mutation check.** Remove the `try/catch` around `fetchFn`. Expected: "never rejects" goes red. Revert.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/sentry.ts apps/cron-worker/test/sentry.test.ts && git commit -m "feat(cron-worker): best-effort Sentry cron check-ins with monitor upsert"
```

---

### Task 4: `runJobs`/`runDue` orchestration, the `ACTIVE` gate and the `scheduled` handler

**Files:**
- Create: `apps/cron-worker/src/run.ts`
- Create: `apps/cron-worker/src/index.ts`
- Test: `apps/cron-worker/test/run.test.ts`

**Interfaces:**
- Consumes: `dueJobs`, `Job` (Task 1); `callJob`, `CallDeps`, `CallOutcome` (Task 2); `parseDsn`, `monitorSlug`, `checkIn` (Task 3).
- Produces:
  - `interface Env { ENV_NAME: string; BASE_URL: string; ACTIVE: string; CRON_SECRET: string; SENTRY_DSN?: string }`
  - `interface RunDeps extends CallDeps { log: (line: Record<string, unknown>) => void; uuid: () => string }`
  - `interface JobResult extends CallOutcome { job: Job["id"] }`
  - `const RUN_DEADLINE_MS = 12 * 60_000`
  - `function runJobs(jobs: Job[], scheduledTime: Date, env: Env, deps: RunDeps): Promise<JobResult[]>`
  - `function runDue(scheduledTime: Date, env: Env, deps: RunDeps): Promise<JobResult[]>`
  - `function liveDeps(): RunDeps`
  - `index.ts` default export `{ scheduled, fetch }` (`fetch` is wired in Task 5)

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/run.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { RUN_DEADLINE_MS, runDue, type Env, type RunDeps } from "../src/run";

const MONDAY_0817 = new Date("2026-09-28T08:17:00Z");
const TUESDAY_1417 = new Date("2026-09-29T14:17:00Z");
const env = (over: Partial<Env> = {}): Env => ({
  ENV_NAME: "stg",
  BASE_URL: "https://stg.seazn.club",
  ACTIVE: "true",
  CRON_SECRET: "s",
  SENTRY_DSN: "https://k@o1.ingest.sentry.io/9",
  ...over,
});

function harness(route: (url: string) => Response | Error = () => new Response("{}")) {
  const lines: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let clock = 0;
  let n = 0;
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("sentry.io")) return new Response("{}", { status: 202 });
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
  return { deps, lines, calls, advance: (ms: number) => void (clock += ms) };
}

describe("runDue", () => {
  it("runs the due jobs in table order, each bracketed by check-ins", async () => {
    const h = harness();
    const results = await runDue(TUESDAY_1417, env(), h.deps);
    expect(results.map((r) => [r.job, r.status])).toEqual([
      ["registrations", "ok"],
      ["billing-events", "ok"],
      ["funnel-remind", "ok"],
    ]);
    expect(h.calls.map((u) => u.replace(/\?.*$/, "").replace(/.*\/cron\/([^/]+)\/.*/, "sentry:$1"))).toEqual([
      "sentry:cron-stg-registrations",
      "https://stg.seazn.club/api/cron/registrations",
      "sentry:cron-stg-registrations",
      "sentry:cron-stg-billing-events",
      "https://stg.seazn.club/api/cron/billing-events",
      "sentry:cron-stg-billing-events",
      "sentry:cron-stg-funnel-remind",
      "https://stg.seazn.club/api/funnel/remind",
      "sentry:cron-stg-funnel-remind",
    ]);
    expect(h.calls[0]).toContain("status=in_progress");
    expect(h.calls[2]).toContain("check_in_id=uuid-1&status=ok");
  });

  it("one failing job does not stop the rest, and reports an error check-in", async () => {
    const h = harness((u) => (u.endsWith("/api/cron/registrations") ? new Response("no", { status: 401 }) : new Response("{}")));
    const results = await runDue(TUESDAY_1417, env(), h.deps);
    expect(results.map((r) => r.status)).toEqual(["error", "ok", "ok"]);
    expect(h.calls[2]).toContain("status=error");
    expect(h.lines.find((l) => l.job === "registrations")).toMatchObject({ event: "job", status: "error", httpStatus: 401, env: "stg" });
  });

  it("runs jobs and logs results with no Sentry DSN", async () => {
    const h = harness();
    const results = await runDue(TUESDAY_1417, env({ SENTRY_DSN: undefined }), h.deps);
    expect(results).toHaveLength(3);
    expect(h.calls.some((u) => u.includes("sentry"))).toBe(false);
    expect(h.lines.filter((l) => l.event === "job")).toHaveLength(3);
  });

  it("while inactive: probes /api/health only, runs no job", async () => {
    const h = harness();
    const results = await runDue(MONDAY_0817, env({ ACTIVE: "false" }), h.deps);
    expect(results).toEqual([]);
    expect(h.calls).toEqual(["https://stg.seazn.club/api/health"]);
    expect(h.lines).toEqual([expect.objectContaining({ event: "probe", env: "stg", httpStatus: 200 })]);
  });

  it("past the run deadline: remaining jobs report error/deadline, never silence", async () => {
    const h = harness((u) => {
      if (u.endsWith("/api/cron/registrations")) h.advance(RUN_DEADLINE_MS);
      return new Response("{}");
    });
    const results = await runDue(TUESDAY_1417, env(), h.deps);
    expect(results.map((r) => [r.job, r.status, r.reason])).toEqual([
      ["registrations", "ok", undefined],
      ["billing-events", "error", "deadline"],
      ["funnel-remind", "error", "deadline"],
    ]);
    expect(h.calls.filter((u) => u.includes("status=error"))).toHaveLength(2);
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
import { callJob, type CallDeps, type CallOutcome } from "./call";
import { dueJobs, type Job } from "./schedule";
import { checkIn, monitorSlug, parseDsn } from "./sentry";

export interface Env {
  ENV_NAME: string;
  BASE_URL: string;
  /** "true" only after this env's GitHub legs are gated off — spec §7, §12.1. */
  ACTIVE: string;
  CRON_SECRET: string;
  SENTRY_DSN?: string;
}

export interface RunDeps extends CallDeps {
  log: (line: Record<string, unknown>) => void;
  uuid: () => string;
}

export interface JobResult extends CallOutcome {
  job: Job["id"];
}

export const RUN_DEADLINE_MS = 12 * 60_000;

/** Run the given jobs sequentially; every job yields a result and a terminal
 *  check-in, including ones skipped by the deadline. */
export async function runJobs(jobs: Job[], scheduledTime: Date, env: Env, deps: RunDeps): Promise<JobResult[]> {
  const dsn = parseDsn(env.SENTRY_DSN);
  const deadline = deps.now() + RUN_DEADLINE_MS;
  const results: JobResult[] = [];
  for (const job of jobs) {
    const slug = monitorSlug(env.ENV_NAME, job);
    const id = deps.uuid();
    await checkIn(deps.fetch, dsn, slug, id, "in_progress", job);
    const out = await callJob(job, env.BASE_URL, env.CRON_SECRET, deps, deadline);
    await checkIn(deps.fetch, dsn, slug, id, out.status, job);
    deps.log({ event: "job", env: env.ENV_NAME, job: job.id, scheduledTime: scheduledTime.toISOString(), ...out });
    results.push({ job: job.id, ...out });
  }
  return results;
}

export async function runDue(scheduledTime: Date, env: Env, deps: RunDeps): Promise<JobResult[]> {
  if (env.ACTIVE !== "true") {
    // Inactive: prove reachability from real Cloudflare infra (spec §9 R1)
    // without running a job, so two schedulers never overlap.
    let httpStatus: number | null = null;
    let error: string | undefined;
    try {
      const res = await deps.fetch(`${env.BASE_URL}/api/health`, { signal: AbortSignal.timeout(10_000) });
      httpStatus = res.status;
      await res.text();
    } catch (err) {
      error = String(err);
    }
    deps.log({ event: "probe", env: env.ENV_NAME, scheduledTime: scheduledTime.toISOString(), httpStatus, error });
    return [];
  }
  return runJobs(dueJobs(scheduledTime), scheduledTime, env, deps);
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
    ctx.waitUntil(runDue(new Date(controller.scheduledTime), env, liveDeps()).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t4.json test/run.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t4.json
```
Expected: `5`, `5`, and `run.test.ts`.

- [ ] **Step 5: Mutation checks, each reverted.**
  - Replace `env.ACTIVE !== "true"` with `false`. Expected: the inactive test goes red.
  - Delete the terminal `checkIn(...)` line. Expected: the ordering and error-check-in tests go red.

- [ ] **Step 6: Typecheck the package**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && pnpm --filter @seazn/cron-worker typecheck; echo EXIT=$?
```
Expected: `EXIT=0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/run.ts apps/cron-worker/src/index.ts apps/cron-worker/test/run.test.ts && git commit -m "feat(cron-worker): sequential runner with ACTIVE gate, health probe and run deadline"
```

---

### Task 5: The manual `POST /run?job=` endpoint

**Files:**
- Create: `apps/cron-worker/src/manual.ts`
- Modify: `apps/cron-worker/src/index.ts`
- Test: `apps/cron-worker/test/manual.test.ts`

**Interfaces:**
- Consumes: `JOBS` (Task 1); `runJobs`, `Env`, `RunDeps` (Task 4).
- Produces: `function handleManual(req: Request, env: Env, deps: RunDeps): Promise<Response>`, and `function secretMatches(given: string | null, expected: string): boolean` (constant-time; empty `expected` never matches).

- [ ] **Step 1: Write the failing test**

`apps/cron-worker/test/manual.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { handleManual, secretMatches } from "../src/manual";
import type { Env, RunDeps } from "../src/run";

const env: Env = { ENV_NAME: "stg", BASE_URL: "https://stg.seazn.club", ACTIVE: "false", CRON_SECRET: "s3cret" };
function deps() {
  const fetch = vi.fn(async () => new Response('{"deleted":0}'));
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

  it("403 for news-digest: a manual digest is the console's job", async () => {
    const { d, fetch } = deps();
    expect((await handleManual(req("/run?job=news-digest", "s3cret"), env, d)).status).toBe(403);
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
import { JOBS } from "./schedule";

/** Constant-time compare; an unset/empty expected secret never matches. */
export function secretMatches(given: string | null, expected: string): boolean {
  if (!expected || given === null || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `POST /run?job=<id>` — the manual rerun GitHub's workflow_dispatch gave
 *  us, and the post-deploy smoke (spec §12.2). Runs regardless of ACTIVE. */
export async function handleManual(req: Request, env: Env, deps: RunDeps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/run") return json({ error: "not found" }, 404);
  if (!secretMatches(req.headers.get("x-cron-secret"), env.CRON_SECRET)) return json({ error: "unauthorized" }, 401);
  const job = JOBS.find((j) => j.id === url.searchParams.get("job"));
  if (!job) return json({ error: "unknown job" }, 404);
  if (!job.manual) return json({ error: `${job.id} cannot be run manually` }, 403);
  const results = await runJobs([job], new Date(deps.now()), env, deps);
  return json(results, results.every((r) => r.status === "ok") ? 200 : 502);
}
```

`apps/cron-worker/src/index.ts` (full file):
```ts
import { handleManual } from "./manual";
import { liveDeps, runDue, type Env } from "./run";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDue(new Date(controller.scheduledTime), env, liveDeps()).then(() => undefined));
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
Expected: the two counts are equal (9), and only `manual.test.ts` is listed.

- [ ] **Step 5: Mutation checks, each reverted.**
  - Make `secretMatches` return `true`. Expected: the 401 cases go red.
  - Delete the `!job.manual` line. Expected: the 403 test goes red.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/src/manual.ts apps/cron-worker/src/index.ts apps/cron-worker/test/manual.test.ts && git commit -m "feat(cron-worker): secret-gated manual run endpoint; news-digest refused"
```

---

### Task 6: `wrangler.json`, the drift guard and CI wiring

**Files:**
- Create: `apps/cron-worker/wrangler.json`
- Test: `apps/cron-worker/test/drift.test.ts`
- Modify: `.github/workflows/ci.yml` (the `gates` job, after `pnpm install --frozen-lockfile` at ~:76)

**Interfaces:**
- Consumes: `JOBS`, `TRIGGER_CRON` (Task 1).
- Produces: `wrangler.json`, with envs `stg` and `prod` that Tasks 9–11 depend on.

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
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOBS, TRIGGER_CRON } from "../src/schedule";

const WEB_API = join(__dirname, "../../web/src/app/api");
// Cron-shaped routes outside /api/cron. Adding one here is a deliberate act.
const EXTRA_CRON_ROUTES = ["/api/funnel/remind"];

function cronRoutes(): string[] {
  const dir = join(WEB_API, "cron");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "route.ts")))
    .map((d) => `/api/cron/${d.name}`);
}

describe("schedule ↔ routes drift guard", () => {
  it("finds the cron routes at all (guards against a vacuous empty scan)", () => {
    expect(cronRoutes().length).toBeGreaterThanOrEqual(6);
  });

  it("every cron-shaped route has exactly one schedule entry, and vice versa", () => {
    const routes = [...cronRoutes(), ...EXTRA_CRON_ROUTES].sort();
    expect(JOBS.map((j) => j.path).sort()).toEqual(routes);
  });

  it("every scheduled path resolves to a real route file", () => {
    for (const j of JOBS) expect(existsSync(join(WEB_API, j.path.replace(/^\/api\//, ""), "route.ts")), j.path).toBe(true);
  });
});

describe("wrangler.json ↔ schedule drift guard", () => {
  const cfg = JSON.parse(readFileSync(join(__dirname, "../wrangler.json"), "utf8"));

  it.each(["stg", "prod"])("%s has exactly the one trigger the table assumes", (env) => {
    expect(cfg.env[env].triggers.crons).toEqual([TRIGGER_CRON]);
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
```

- [ ] **Step 3: Run the test to verify it passes, then prove it can fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-t6.json test/drift.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].name]' /tmp/cw-t6.json
```
Expected: the two counts are equal (8).

Mutation checks, each reverted:
- Delete the `billing-grant` row from `JOBS`. Expected: the "exactly one schedule entry" test goes red.
- Change the stg cron to `"23 * * * *"`. Expected: the trigger test goes red.

- [ ] **Step 4: Wire the tests into CI.** Add these steps to `.github/workflows/ci.yml`'s `gates` job, directly after the `- run: pnpm install --frozen-lockfile` line (~:76):

```yaml
      # apps/cron-worker is a workspace no other test step collects
      # (ci.yml runs apps/web and packages/engine by name). Typecheck is
      # already covered by `npx turbo run typecheck` below.
      - name: Cron worker tests
        run: pnpm --filter @seazn/cron-worker test
```

Re-read the lines around the insertion point first. Anchor on `pnpm install --frozen-lockfile` in the `gates:` job, not on a line number.

- [ ] **Step 5: Run the whole package suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && npx vitest run --reporter=json --outputFile=/tmp/cw-all.json; jq '.numPassedTests, .numTotalTests, .numFailedTestSuites, [.testResults[].name | split("/") | last]' /tmp/cw-all.json
```
Expected: the passed and total counts are equal, `numFailedTestSuites` is `0`, and 6 files are listed (schedule, call, sentry, run, manual, drift).

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/wrangler.json apps/cron-worker/test/drift.test.ts .github/workflows/ci.yml && git commit -m "feat(cron-worker): wrangler envs, route/trigger drift guard, CI step"
```

---

### Task 7: The news-digest weekly guard (cron path only)

**Files:**
- Create: `db/migration/deltas/V419__weekly_digest_cron_once.sql`. **Re-check the highest `V` number first** (`ls db/migration/deltas | sort -V | tail -1`, which was V418 on 2026-09-28). If another branch has taken 419, use the next free number.
- Modify: `apps/web/src/server/news/enrichment.ts` (add `isoWeekKeyUtc` below `digestWindow`, ~:52)
- Modify: `apps/web/src/server/usecases/org-posts.ts`: `insertGeneratedPost` (~:659-704), `digestForOrg` (~:1530, :1598-1613), `sweepWeeklyDigests` (~:1712-1714)
- Test: `apps/web/src/server/news/__tests__/iso-week.test.ts` (new)
- Test: `apps/web/src/server/usecases/__tests__/org-posts-digest.test.ts` (add one `it`)

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
 * once-per-week identity (`auto_source.cron_week`, V419). `digestWindow` is a
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
    const org = await seedOrg("pro");
    const div = await seedDivision(org);
    await decideWithRally(org, div, div.entrantA, div.entrantB);
    const now = Date.now();
    const digests = async () => (await listPosts(org.auth, org.orgId)).filter((p) => p.kind === "weekly_digest");

    // 1. First cron firing drafts one, stamped with this ISO week.
    await sweepWeeklyDigests(now);
    const first = await digests();
    expect(first).toHaveLength(1);
    expect(first[0]!.autoSource).toMatchObject({ trigger: "weekly_digest", origin: "cron", cron_week: isoWeekKeyUtc(now) });

    // 2. A double fire / retry in the same week drafts nothing more.
    await sweepWeeklyDigests(now);
    expect(await digests()).toHaveLength(1);

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

Add `import { isoWeekKeyUtc } from "@/server/news/enrichment";` to the file's imports. Confirm the alias resolves the same way the file's other `@/` imports do.

Run it against the local test DB. Use the `seazn-local-env` skill for a fresh DB, and remember `db:apply` then `sync:sports`:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/web && npx vitest run --reporter=json --outputFile=/tmp/cw-t7b.json src/server/usecases/__tests__/org-posts-digest.test.ts; jq '.numPassedTests, .numTotalTests, [.testResults[].assertionResults[] | select(.status=="failed") | .title]' /tmp/cw-t7b.json
```
Expected: exactly the new test fails, at step 1 (`origin`/`cron_week` missing) or step 2 (length 2). If `numTotalTests` is 0, the DB is not wired (`DATABASE_URL`). Fix the environment; this is not a pass.

- [ ] **Step 4: Write the migration** `db/migration/deltas/V419__weekly_digest_cron_once.sql`:

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
    // Cron path only (V419): the once-per-ISO-week identity. The console
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
    // Cron path: this org already has this week's cron digest (a retry or a
    // double fire) — a no-op, not a failure.
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

- [ ] **Step 7: Mutation checks, one at a time, each reverted.**
  - Drop `cronWeek` from the sweep's `digestForOrg` call. Expected: the new test goes red at step 1 or 2.
  - Pass `cronWeek` from `generateWeeklyDigest` too. Expected: step 3 goes red (the console press is swallowed, AGENTS.md class 13).
  - Drop the index on the test DB (`drop index org_posts_digest_cron_once`). Expected: the new test goes red. The named `on conflict` target has no matching index, so the insert throws, the sweep's per-org catch logs and skips, and step 1 finds 0 digests. Recreate the index afterwards (re-apply V419).

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add db/migration/deltas/V419__weekly_digest_cron_once.sql apps/web/src/server/news/enrichment.ts apps/web/src/server/news/__tests__/iso-week.test.ts apps/web/src/server/usecases/org-posts.ts apps/web/src/server/usecases/__tests__/org-posts-digest.test.ts && git commit -m "fix(news): at most one cron weekly digest per org per ISO week"
```

---

### Task 8: Point the route docstrings at the new scheduler

**Files:**
- Modify: the docstrings (comments only) in `apps/web/src/app/api/cron/{ai-previews,billing-events,billing-grant,billing-quantity,news-digest,registrations}/route.ts` and `apps/web/src/app/api/funnel/remind/route.ts`

- [ ] **Step 1: Find the stale scheduler references**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && grep -a -n -i "vercel cron\|any scheduler\|\.github/workflows\|scheduled by\|No scheduler exists" apps/web/src/app/api/cron/*/route.ts apps/web/src/app/api/funnel/remind/route.ts
```

- [ ] **Step 2: Edit each hit.** Replace the scheduler sentence with: `Fired by the Cloudflare cron Worker — schedule in apps/cron-worker/src/schedule.ts.` Keep every other sentence as it is. For `news-digest/route.ts`, also state that the Worker never retries it and that V419 caps cron digests at one per org per ISO week. Change comments only; `git diff` must show no code lines.

- [ ] **Step 3: Verify only comments changed**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git diff -U0 apps/web/src/app/api | grep -a '^[+-]' | grep -a -v '^[+-]\s*\(\*\|//\|/\*\*\)' | grep -a -v '^\(+++\|---\)'
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/web/src/app/api && git commit -m "docs(cron): route docstrings point at the Cloudflare cron Worker"
```

---

### Task 9: Deploy wiring (stg on push to main, prod on tag) with smoke

**Files:**
- Modify: `.github/workflows/stg.yml` (add job `deploy-cron-worker-stg`)
- Modify: `.github/workflows/prod.yml` (add job `deploy-cron-worker-prod`)

**Owner prerequisites** (the implementer cannot do these; list them in the PR body):
- A Cloudflare API token scoped to Account "Seazn Club" → Workers Scripts: Edit. Store it as the repo secret `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID` = `ecaa471818e93892078446eae972a543`.
- Repo secrets `STAGE_CRON_SECRET` / `PROD_CRON_SECRET` (the same values as the Fly apps' `CRON_SECRET`), used by the smoke step.
- Repo variables `CRON_WORKER_URL_STG` / `CRON_WORKER_URL_PROD`: the Workers' `*.workers.dev` URLs, printed by the first `wrangler deploy`.
- The Worker secrets, once per env: `pnpm --filter @seazn/cron-worker exec wrangler secret put CRON_SECRET --env stg` (and `SENTRY_DSN`, and the same for `--env prod`).

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
      # Smoke: one idempotent job through the Worker's manual endpoint,
      # end to end (Worker → Cloudflare → Fly → DB). Spec §8, §12.2.
      - name: Smoke — manual run of ai-previews
        if: vars.CRON_WORKER_URL_STG != ''
        run: |
          curl --silent --show-error --fail-with-body --max-time 90 \
            -X POST "${{ vars.CRON_WORKER_URL_STG }}/run?job=ai-previews" \
            -H "x-cron-secret: $CRON_SECRET"
        env:
          CRON_SECRET: ${{ secrets.STAGE_CRON_SECRET }}
```

- [ ] **Step 3: Add the prod job** to `.github/workflows/prod.yml`. It is identical except for: name `deploy-cron-worker-prod`, `cancel-in-progress: false`, `--env prod`, `vars.CRON_WORKER_URL_PROD`, and `secrets.PROD_CRON_SECRET`.

- [ ] **Step 4: Validate the YAML**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && for f in stg prod ci; do node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/$f.yml','utf8'))" && echo "$f ok"; done
```
Expected: `stg ok`, `prod ok`, `ci ok`. If the `yaml` package is not resolvable from the root, use `npx --yes yaml valid < file`.

- [ ] **Step 5: Dry-run the bundle**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && pnpm --filter @seazn/cron-worker exec wrangler deploy --env stg --dry-run --outdir /tmp/cw-dry; echo EXIT=$?
```
Expected: `EXIT=0`, and the output lists the `17 * * * *` schedule and the vars `ENV_NAME`/`BASE_URL`/`ACTIVE`.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add .github/workflows/stg.yml .github/workflows/prod.yml && git commit -m "ci: deploy the cron Worker with stg/prod and smoke it via /run"
```

---

### Task 10: Local E2E through the real workerd runtime

**Files:**
- Create: `apps/cron-worker/test/e2e.local.test.ts` (skipped unless `CRON_E2E_BASE_URL` and `DATABASE_URL` are set)

This proves the seam through its real producer and consumer (AGENTS.md class 1): real `wrangler dev`, a real `/__scheduled` firing, a real Next prod build, and a real DB side effect.

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

describe.skipIf(!BASE || !DB || !SECRET)("cron Worker E2E (wrangler dev → local Next → DB)", () => {
  let dev: ChildProcess;
  const sql = postgres(DB!, { max: 1 });

  beforeAll(async () => {
    dev = spawn(
      "pnpm",
      ["exec", "wrangler", "dev", "--test-scheduled", "--port", String(PORT), "--env", "stg",
        "--var", `BASE_URL:${BASE}`, "--var", "ACTIVE:true", "--var", `CRON_SECRET:${SECRET}`],
      { cwd: `${__dirname}/..`, stdio: "inherit" },
    );
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`http://localhost:${PORT}/`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    throw new Error("wrangler dev did not start");
  }, 90_000);

  afterAll(async () => {
    dev?.kill();
    await sql.end();
  });

  it("an hourly firing stamps reminded_at on a due funnel draft", async () => {
    const token = `e2e-${randomUUID()}`;
    const [draft] = await sql<{ id: string }[]>`
      insert into funnel_drafts (token, email, payload, expires_at, created_at)
      values (${token}, ${`${token}@example.test`}, ${sql.json({})}, now() + interval '6 days', now() - interval '25 hours')
      returning id`;
    const res = await fetch(`http://localhost:${PORT}/__scheduled?cron=${encodeURIComponent("17 * * * *")}`);
    expect(res.status).toBe(200);
    // __scheduled returns before waitUntil settles; poll for the side effect.
    let reminded: Date | null = null;
    for (let i = 0; i < 60 && !reminded; i++) {
      const rows = await sql<{ reminded_at: Date | null }[]>`
        select reminded_at from funnel_drafts where id = ${draft!.id}`;
      reminded = rows[0]?.reminded_at ?? null;
      if (!reminded) await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(reminded).not.toBeNull();
  }, 120_000);
});
```

Before running, read `apps/web/src/app/api/funnel/remind/route.ts` end to end. (a) If it skips payloads failing `funnelPayloadSchema` (`apps/web/src/lib/funnel.ts`), seed the smallest valid payload instead of `{}`. (b) Check whether `reminded_at` is stamped when `sendFunnelReminderEmail` fails or no-ops locally (no Resend key). If it is stamped only after a successful send, assert a different hourly job's side effect instead, for example `/api/cron/registrations` stamping `reminded_at` on a seeded pay-pending entry. Never fake the email.

- [ ] **Step 2: Run it against a local prod build.** Follow the `seazn-local-env` skill: a fresh test DB, `db:apply` + `sync:sports`, a prod build started with `CRON_SECRET` set, and `BASE` on `localhost`, never `127.0.0.1`.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron/apps/cron-worker && CRON_E2E_BASE_URL=http://localhost:3000 CRON_SECRET=<local value> DATABASE_URL=<test db url> npx vitest run --reporter=json --outputFile=/tmp/cw-e2e.json test/e2e.local.test.ts; jq '.numPassedTests, .numTotalTests, .numPendingTests' /tmp/cw-e2e.json
```
Expected: `1`, `1`, `0`. A `numPendingTests` of 1 means it was skipped (env not set), which is not a pass.

- [ ] **Step 3: Mutation check.** Re-run with `--var ACTIVE:false`, by temporarily editing the spawn args. Expected: red, because `reminded_at` stays null and only the probe ran. Revert.

- [ ] **Step 4: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/cloudflare-cron && git add apps/cron-worker/test/e2e.local.test.ts && git commit -m "test(cron-worker): local E2E through wrangler dev --test-scheduled"
```

---

### Task 11: Cutover runbook (owner-gated, after the PR merges)

**Files:**
- Modify (separate PR in `onryde/seazn.club.workflow`): the 7 curl workflows get a job-level gate on each leg.
- Modify (this repo, small PRs): the `ACTIVE` values in `apps/cron-worker/wrangler.json`.

The implementer prepares both PRs; **the owner merges each step.** Never have two schedulers active for one environment.

- [ ] **Step 1: Workflow-repo PR: add per-environment gates.** In each of `ai-preview-sweep.yml`, `billing-events.yml`, `billing-grant.yml`, `billing-quantity.yml`, `funnel-reminders.yml`, `news-digest.yml` and `registrations-sweep.yml`, add a job-level `if:` to each leg:

```yaml
  sweep-staging:            # (the job ids differ per file — keep each file's own)
    if: vars.CRON_ON_GITHUB_STG != 'false'
  ...
  sweep-production:
    if: vars.CRON_ON_GITHUB_PROD != 'false'
```

The default (variable unset) keeps today's behaviour. `simulation-nightly.yml` is untouched.

- [ ] **Step 2: Probe week, with both Workers deployed and `ACTIVE: "false"`.** After the main PR merges, `seazn-cron-stg` deploys and fires `/api/health` hourly. Owner or implementer checks the Workers Logs (`wrangler tail seazn-cron-stg --format json`, or the dashboard) for `{"event":"probe","httpStatus":200}` lines.
  - **If they show 403 or HTML (a challenge):** change stg `BASE_URL` to `https://seazn-club-stg.fly.dev` in a PR. The app has no host redirect (proxy.ts has rewrites only, and `/api/*` POSTs without an `Origin` header pass), so no app change is needed. Re-probe.

- [ ] **Step 3: Staging switch, done in the same hour window.**
  1. `gh variable set CRON_ON_GITHUB_STG --body false -R onryde/seazn.club.workflow`
  2. Merge the PR that sets stg `ACTIVE` to `"true"` (this deploys through `stg.yml`).
  3. Record the switch time.

- [ ] **Step 4: 72 h staging soak.** Pass bar (spec §2, §7):

```bash
wrangler tail seazn-cron-stg --format json   # or query Workers Logs in the dashboard
```
  - Each hourly job logs ≥ 23 `event:"job"` lines per 24 h.
  - Each daily job starts at HH:17 ±15 min.
  - No `status:"error"` that isn't explained.
  - Sentry shows the `cron-stg-*` monitors created, and none missed.
  - No org on staging gains a second cron digest in one ISO week (`select org_id, auto_source->>'cron_week', count(*) from org_posts where auto_source ? 'cron_week' group by 1,2 having count(*) > 1;` returns no rows).
  - Record the counts in the PR/issue before moving on.

- [ ] **Step 5: Production switch.** Repeat Step 2's probe check for prod, then Step 3 with `CRON_ON_GITHUB_PROD` and the prod `ACTIVE` (deployed by `prod.yml` on the next tag; **tagging is the owner's call**). Then run a 72 h soak with the same bar.

- [ ] **Step 6: Rollback drill, written into the PR body and not executed:** `gh variable set CRON_ON_GITHUB_<ENV> --body true` and revert the `ACTIVE` PR (or run `wrangler deploy --env <env>` with `"crons": []`). Both take effect within about an hour.

- [ ] **Step 7: Cleanup, after both soaks pass.** In a workflow-repo PR, delete the 7 moved workflow files. Update memory `reference_scheduled_cron_workflows_live_in_a_separate_repo` and `reference_github_schedule_cron_runs_late_and_drops` to record the move.

---

## Self-review notes

- **Spec coverage:** §3 → T1, T4, T6; §4 → T1; §5 retry → T2, digest guard → T7; §6 → T3, T4; §7 → T11; §8 unit → T1–T5, drift → T6, integration/E2E → T4, T10, regression → T7, smoke → T9; §9 R1 → T4 probe + T11 step 2, R2 → Open item (Sentry plan), R3 → Workers metrics during the soak, R5 → T4 test 2, R6 → T2 timeout test; §12.1–12.6 → T4, T5, T4, all, T7, T6. Route docstrings (§7.5) → T8.
- **Open item (owner):** does the Sentry plan include Crons? Tasks do not depend on it: check-ins are harmless without Crons, and T4 tests the no-DSN path. If Crons is unavailable, add the §6 `/api/health` `cron` block as a follow-up plan.
- **Lint:** `apps/cron-worker` is not covered by the root `lint` script (web + engine + scripts only). Accepted for this small package; typecheck and tests are covered in CI.
