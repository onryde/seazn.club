import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepWeeklyDigests } from "@/server/usecases/org-posts";

/** POST /api/cron/news-digest — weekly: generate a digest draft for every
 *  org with `news.auto` live. P3/D7 deliberately made `generateWeeklyDigest`
 *  non-idempotent (every console button press is a fresh draft, V358 exempts
 *  weekly_digest from `org_posts_auto_once`), so this sweep carries its own
 *  once-a-week guard: V429 caps CRON digests at one per org per ISO week
 *  (`auto_source.cron_week`), and a repeat is a quiet no-op for that org.
 *  Console presses carry no `cron_week` and stay unlimited. `sweepWeeklyDigests`
 *  skips an org with nothing to report rather than posting an empty digest
 *  every week — see its own docstring in org-posts.ts.
 *
 *  Cron-shaped like /api/cron/billing-grant: x-cron-secret header
 *  (CRON_SECRET env), weekly (Mondays 08:17 UTC).
 *  Schedule: apps/cron-worker/src/schedule.ts (the Cloudflare cron Worker,
 *  live while ACTIVE is "true" in apps/cron-worker/wrangler.json). The
 *  onryde/seazn.club.workflow leg also fires it until that schedule is
 *  switched off, so both may fire it meanwhile.
 *  The Worker never retries this job, and a manual `POST /run?job=news-digest`
 *  is allowed (R2): V429 lets it fill only the orgs still missing this ISO
 *  week's cron digest. */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepWeeklyDigests();
  });
}
