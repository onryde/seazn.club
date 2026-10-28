import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { type SessionDeps, defaultDeps } from "@/server/usecases/stream-sessions";
import { sweepStreamSessions } from "@/server/usecases/relay-sweep";
import { type YoutubeDailyResult, youtubeDaily } from "@/server/youtube/daily";
import { youtubeDriver } from "@/server/youtube/driver";

/** What a throw out of the WHOLE YouTube pass reads as: the pass could not run, which is one failure, and never a reason to skip the
 *  relay sweep. (A fault on one connection or one leg is caught inside the pass, by `youtubeDaily`, and counted there.) */
const PASS_FAILED: YoutubeDailyResult = { checked: 0, reconnectNeeded: 0, refreshed: 0, removed: 0, purged: 0, failed: 1 };

/** The daily YouTube pass (YouTube Connect T17, spec §6.6), over EVERY organisation (no `orgIds`: that option is the test seam). Never
 *  throws: a throw out of it - the database down, or a YOUTUBE_DRIVER that is not `fake` or `live`, which the deps' port getter raises
 *  when READ - is reported once and answered as `failed: 1`, and the relay sweep goes on. */
async function dailyYoutube(deps: SessionDeps): Promise<YoutubeDailyResult> {
  try {
    return await youtubeDaily(deps.youtube ?? youtubeDriver(), deps.now());
  } catch (err) {
    // The log names the error's class only, never its message (a database error can echo a connection string); the whole error goes
    // to Sentry, whose own scrubbing applies.
    log.error({ errClass: err instanceof Error ? err.name : typeof err }, "relay sweep: the YouTube daily pass threw");
    captureError(err, { route: "cron.relay_sweep.youtube" });
    return { ...PASS_FAILED };
  }
}

/** POST /api/cron/relay-sweep — DAILY (owner 2026-09-14; streaming R1, design §6.3): the expiry backstop, orphan
 *  Machines (and the confirmed-gone mark admission reads), the storage headroom warning, and recording retention
 *  (videos before inputs). Time-critical rules do NOT live here — they fire lazily on reads (stream-sessions.ts).
 *  YouTube Connect T17 (spec §6.6): the daily YouTube pass (channel health, the 25-day video refresh, the 30-day dead-grant purge,
 *  stuck broadcasts, expired grants) runs FIRST and on a relay-disabled deployment too - what Seazn stores from YouTube is
 *  refreshed or deleted within 30 days (DP III.E.4) whether or not this deployment still has a relay. Its counters ride the answer
 *  at `data.youtube` (`youtube.failed` is the one the Worker alerts on, apps/cron-worker/src/schedule.ts), the disabled answer
 *  included: the Worker reads a missing counter as "unreadable", i.e. degraded, which would raise a Sentry event from every
 *  relay-disabled deployment.
 *  Cron-shaped like /api/cron/registrations: 503 when CRON_SECRET is unset BEFORE 401 on a mismatch — in that order, so
 *  an unset secret can never read as "no auth required". The sweep runs with the production deps ALONE (no test scope).
 *  Schedule: apps/cron-worker/src/schedule.ts, daily 04:17 UTC (owner 2026-10-01), live while ACTIVE is "true" in
 *  apps/cron-worker/wrangler.json. No GitHub workflow schedules it (lib/__tests__/relay-sweep-workflow.test.ts). */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    const deps = defaultDeps(baseUrl(req));
    const youtube = await dailyYoutube(deps);
    // R5 (Task 14b): no relay on this deployment (production, RELAY_DRIVERS unset) — every provider port refuses, and
    // there is nothing to reconcile against. Say so rather than fail at the first provider read every night.
    if (deps.drivers.disabled) return { disabled: true as const, youtube };
    return { ...(await sweepStreamSessions(deps)), youtube };
  });
}
