import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { sweepRegistrations } from "@/server/usecases/registrations";

/** POST /api/cron/registrations — hourly (spec §6): T-24h payment reminders
 *  with a fresh checkout link, then expire overdue card pendings and promote
 *  the waitlist. Cron-shaped like /api/funnel/remind: x-cron-secret header
 *  (CRON_SECRET env).
 *  Schedule: apps/cron-worker/src/schedule.ts (the Cloudflare cron Worker,
 *  live while ACTIVE is "true" in apps/cron-worker/wrangler.json). The
 *  onryde/seazn.club.workflow leg also fires it until that schedule is
 *  switched off, so both may fire it meanwhile.
 *  Idempotent — reminded_at marks reminders, expiry re-checks under a row lock. */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepRegistrations(baseUrl(req));
  });
}
