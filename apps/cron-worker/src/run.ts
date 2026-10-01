import { callJob, userAgent, type CallDeps, type CallOutcome } from "./call";
import { JOBS, TRIGGER_CRON, dueJobs, triggersOf, type Job } from "./schedule";
import { captureJobFailure, parseDsn } from "./sentry";

export interface Env {
  ENV_NAME: string;
  BASE_URL: string;
  /** Kill switch (owner 2026-10-01: "true" by default in wrangler.json). Anything but "true" runs no job; the hourly firing only probes /api/health. */
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
  /** Present only when a Sentry event was attempted for this job: did Sentry accept it (I-3)? */
  sentryDelivered?: boolean;
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
 * error event when a DSN is set, and its job line says whether Sentry accepted
 * it (`sentryDelivered`, I-3): a failed delivery is logged, never thrown, and
 * never stops the next job. One closing `event:"run"` line names the Sentry
 * state and lists any undelivered events, so a missing DSN or a rejected one
 * shows in the log rather than as silence.
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
      result.sentryDelivered = await captureJobFailure(deps.fetch, dsn, {
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
    sentryUndelivered: results.filter((r) => r.sentryDelivered === false).map((r) => r.job),
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
    // Inactive (the kill switch is off): prove reachability from real
    // Cloudflare infra (spec §9 R1) without running a job. Once an hour,
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
