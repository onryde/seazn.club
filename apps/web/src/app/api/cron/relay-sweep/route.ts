import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { defaultDeps } from "@/server/usecases/stream-sessions";
import { sweepStreamSessions } from "@/server/usecases/relay-sweep";

/** POST /api/cron/relay-sweep — DAILY (owner 2026-09-14; streaming R1, design §6.3): the expiry backstop, orphan
 *  Machines (and the confirmed-gone mark admission reads), the storage headroom warning, and recording retention
 *  (videos before inputs). Time-critical rules do NOT live here — they fire lazily on reads (stream-sessions.ts).
 *  Cron-shaped like /api/cron/registrations: 503 when CRON_SECRET is unset BEFORE 401 on a mismatch — in that order, so
 *  an unset secret can never read as "no auth required". The sweep runs with the production deps ALONE (no test scope).
 *  The SCHEDULE lives in onryde/seazn.club.workflow (#757); this repo holds no cron workflow for it
 *  (lib/__tests__/relay-sweep-workflow.test.ts). */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    const deps = defaultDeps(baseUrl(req));
    // R5 (Task 14b): no relay on this deployment (production, RELAY_DRIVERS unset) — every provider port refuses, and
    // there is nothing to reconcile against. Say so rather than fail at the first provider read every night.
    if (deps.drivers.disabled) return { disabled: true as const };
    return sweepStreamSessions(deps);
  });
}
