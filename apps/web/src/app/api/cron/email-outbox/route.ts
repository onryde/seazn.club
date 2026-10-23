import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
// The answer's type, from its own module: apps/cron-worker/test/drift.test.ts reads the modules this route imports for
// the numeric `failed` the Worker counts (R3), and the barrel `@/server/email-outbox` only re-exports.
import { runOutboxTick, type OutboxTickReport } from "@/server/email-outbox/worker";

/** POST /api/cron/email-outbox - ONE TICK of the email outbox's retry worker (spec 2026-10-19-email-outbox-design.md,
 *  "The retry worker"): expires the rows past `expires_at`, ends the ones that spent every attempt, then claims due rows
 *  (`for update skip locked`, so an overlapping tick takes different rows) and attempts each one, paced for Resend's
 *  2 requests a second, a bounded batch, and a time budget under the Worker's per-job timeout. Answers the tick's report
 *  (counts only: never an address, a body or a provider message). The cron Worker counts `failed` as a failure (rows whose
 *  attempt threw in our own code, or a tick that could not run because the database role cannot write the outbox);
 *  `deferred` (rows still due when the batch or the budget ran out) is not one: the next firing reaches them.
 *  Schedule: apps/cron-worker/src/schedule.ts, the env's one fast trigger (every minute on prod, every 5 minutes on stg),
 *  never retried (the next firing is the retry).
 *  Cron-shaped like /api/cron/external-play: 503 when CRON_SECRET is unset BEFORE 401 on a mismatch, so an unset secret can
 *  never read as "no auth required". The tick runs with the production defaults ALONE: no scope, no injected clock. */
export async function POST() {
  return handler(async (): Promise<OutboxTickReport> => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return runOutboxTick();
  });
}
