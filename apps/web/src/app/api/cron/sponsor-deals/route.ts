import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepSponsorDeals } from "@/server/usecases/sponsor-deals";

/** POST /api/cron/sponsor-deals — hourly (sponsor deals plan D20, Task 9; spec §5.2, §8a): ends a sponsor deal whose end date
 *  has passed (live, or still waiting to go live), ends a live deal whose competition has finished, and puts the sponsor's next
 *  scheduled deal live. Answers the sweep's counts: `{ checked, expired, finished, promoted, failed }`; `failed` is what the
 *  cron Worker alerts on (apps/cron-worker/src/schedule.ts).
 *  Cron-shaped like /api/cron/registrations: x-cron-secret header (CRON_SECRET env), 503 when it is unset BEFORE a 401 on a
 *  mismatch. Idempotent: each deal is re-checked under its sponsor's lock, so a second run (or an overlapping one) moves nothing
 *  twice. */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepSponsorDeals();
  });
}
