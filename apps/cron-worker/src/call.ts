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
    // M-2: check the deadline BEFORE the backoff sleep too, so a run already past it never waits
    // up to 8 s for an attempt it will refuse. The sleep itself can cross it, hence the second check.
    if (deps.now() >= deadlineMs) return { ...last, ms: deps.now() - started, reason: "deadline" };
    if (attempt > 1) {
      await deps.sleep(BACKOFF_MS[attempt - 2]!);
      if (deps.now() >= deadlineMs) return { ...last, ms: deps.now() - started, reason: "deadline" };
    }
    let res: Response;
    try {
      res = await deps.fetch(`${target.baseUrl}${job.path}`, {
        method: "POST",
        headers: { "x-cron-secret": target.secret, "user-agent": target.userAgent },
        // M-3: never follow a redirect. fetch would replay the POST as a GET (a 200 HTML page then
        // reads as ok without the job having run) and forward x-cron-secret to the new origin.
        // A 3xx is a non-ok response: an error, not retried.
        redirect: "manual",
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
