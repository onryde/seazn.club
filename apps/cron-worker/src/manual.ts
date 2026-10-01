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
