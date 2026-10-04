import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { type StreamTickResult, defaultDeps, tickOpenSessions } from "@/server/usecases/stream-sessions";

/** The route's 200 body (inside handler's `{ ok, data }`). EXPLICIT on purpose: the cron Worker reads `data.failed` as
 *  its failure counter (R3), so both answers carry it, and drift.test.ts finds its `failed: number` declaration. */
type StreamTickAnswer = StreamTickResult | (StreamTickResult & { disabled: true });

/** POST /api/cron/stream-tick — EVERY 5 MINUTES (capture QR v2 §6.11, W22): ticks every open stream session
 *  (`tickOpenSessions`), so a phone that dies with no panel open is still ended — ask 10, W19, m-5 — within one firing.
 *  Cron-shaped like /api/cron/relay-sweep, in its order: 503 when CRON_SECRET is unset BEFORE 401 on a mismatch, so an
 *  unset secret can never read as "no auth required". The pass runs with the production deps ALONE (no test scope).
 *  Schedule: apps/cron-worker/src/schedule.ts, the `*\/5 * * * *` trigger, never retried (the next firing is the retry).
 *  R5: with no relay on this deployment it ticks nothing and answers zeros — WITH `failed: 0`, because the Worker reads a
 *  missing counter as "unreadable", i.e. degraded, which would raise a Sentry event from every relay-disabled deployment. */
export async function POST(req: Request): Promise<Response> {
  return handler(async (): Promise<StreamTickAnswer> => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    const deps = defaultDeps(baseUrl(req));
    if (deps.drivers.disabled) return { disabled: true, ticked: 0, ended: 0, failed: 0, deferred: 0 };
    return tickOpenSessions(deps);
  });
}
