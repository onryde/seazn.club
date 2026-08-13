import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepWeeklyDigests } from "@/server/usecases/org-posts";

/** POST /api/cron/news-digest — weekly: generate a digest draft for every
 *  org with `news.auto` live. The weekly schedule IS the idempotency
 *  guarantee here (no per-org "already digested this week" check needed) —
 *  P3/D7 deliberately made `generateWeeklyDigest` non-idempotent (every
 *  console button press is a fresh draft, V358 exempts weekly_digest from
 *  `org_posts_auto_once`), so this route must fire at most once a week or
 *  every org would get one digest per cron tick. `sweepWeeklyDigests` skips
 *  an org with nothing to report rather than posting an empty digest every
 *  week — see its own docstring in org-posts.ts.
 *
 *  Cron-shaped like /api/cron/billing-grant: x-cron-secret header
 *  (CRON_SECRET env), scheduled by
 *  `.github/workflows/news-digest-stg.yml` (Mondays). */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepWeeklyDigests();
  });
}
