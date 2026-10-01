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
 *  Sentry outage must never stop or fail a job, so this never throws.
 *  Resolves true only when Sentry ACCEPTED the event (HTTP 2xx), and false for a
 *  throw, a timeout or any other status. A rotated DSN key or a deleted project
 *  answers 4xx, and without this the alert path would go dark while the run
 *  line still read `sentry:"on"` (review I-3). */
export async function captureJobFailure(
  fetchFn: typeof fetch,
  dsn: Dsn,
  e: { environment: string; run: "scheduled" | "manual"; failure: JobFailure; eventId: string; nowMs: number },
): Promise<boolean> {
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
    const res = await fetchFn(`${dsn.origin}/api/${dsn.projectId}/envelope/?sentry_key=${encodeURIComponent(dsn.publicKey)}&sentry_version=7`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: envelope,
      signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // swallowed by contract: reported as "not delivered", never thrown
    return false;
  }
}
