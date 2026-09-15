import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { prepareExternalPlayWindow } from "@/server/usecases/external-play";

/** POST /api/cron/external-play — every ~5 min (chess Lichess design 2026-09-15):
 *  T−15 challenge prepare + play-ready email. Wire in onryde/seazn.club.workflow
 *  (external). Cron-shaped like /api/cron/registrations: x-cron-secret header
 *  (CRON_SECRET env). Idempotent via emailed_at / status. */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return prepareExternalPlayWindow({ origin: baseUrl(req) });
  });
}
