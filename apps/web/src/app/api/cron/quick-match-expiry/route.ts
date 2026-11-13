import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
// The usecase and its answer's type, from their own module: apps/cron-worker/test/drift.test.ts reads the modules this route
// imports for the numeric `failed` the Worker counts (R3).
import { sweepQuickMatches, type QuickMatchSweepReport } from "@/server/usecases/quick-match-sweep";

/** POST /api/cron/quick-match-expiry: one pass of the quick match sweep (quick match spec C1, C2, §7.8; plan 3 Task 2). It
 *  deletes the orphan competitions a failed create left, re-arms the matches whose saver's account is gone, deletes the
 *  unsaved matches past their expiry with everything under them, and queues the one "save it before it expires" reminder
 *  for the ones within a day of it (the outbox worker sends it). Answers the sweep's report (counts only: never an id, an
 *  address or a token). The cron Worker counts `failed` as a failure; `deferred` (rows past a step's limit, or kept by a
 *  delete's re-check) is not one: the next firing reaches them.
 *  Schedule: apps/cron-worker/src/schedule.ts, the hourly trigger (plan 3 Task 3).
 *  Cron-shaped like /api/cron/email-outbox: 503 when CRON_SECRET is unset BEFORE 401 on a mismatch, so an unset secret can
 *  never read as "no auth required". The reminder carries links, so the base URL is the request's, built as
 *  /api/funnel/remind builds it (`baseUrl(req)`). The sweep runs with the production defaults ALONE: no scope, no clock. */
export async function POST(req: Request) {
  return handler(async (): Promise<QuickMatchSweepReport> => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepQuickMatches({ baseUrl: baseUrl(req) });
  });
}
