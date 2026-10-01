import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepExpiredPreviews } from "@/server/usecases/ai-preview-sweep";

/** POST /api/cron/ai-previews — daily (#403): delete compiled-instruction
 *  previews that are past their life. The row holds the organiser's raw
 *  sentence, which can carry personal data about individuals, so it is retained
 *  to a stated policy rather than kept until the org is deleted. Cron-shaped
 *  like /api/cron/billing-events: x-cron-secret header (CRON_SECRET env).
 *  Schedule: apps/cron-worker/src/schedule.ts (the Cloudflare cron Worker,
 *  live while ACTIVE is "true" in apps/cron-worker/wrangler.json). The
 *  onryde/seazn.club.workflow leg also fires it until that schedule is
 *  switched off, so both may fire it meanwhile.
 *  Idempotent — a delete of rows that are already gone is a no-op. */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepExpiredPreviews();
  });
}
