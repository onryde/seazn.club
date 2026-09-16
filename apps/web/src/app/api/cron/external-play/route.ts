import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import {
  prepareExternalPlayWindow,
  pollLiveExternalPlay,
  escalateStaleExternalPlay,
} from "@/server/usecases/external-play";

/** POST /api/cron/external-play — every ~5 min (chess Lichess design 2026-09-15):
 *  T−15 challenge prepare + play-ready email, poll ready/live games, then
 *  escalate T+20 no-shows. Wire in onryde/seazn.club.workflow.
 *  Cron-shaped like /api/cron/registrations: x-cron-secret header (CRON_SECRET).
 *  Game callbacks are not this route — they POST /api/webhooks/lichess with
 *  HMAC `x-lichess-signature` (see webhook-signature.ts). */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    const prepared = await prepareExternalPlayWindow({ origin: baseUrl(req) });
    const polled = await pollLiveExternalPlay();
    const escalated = await escalateStaleExternalPlay();
    return { prepare: prepared, poll: polled, escalate: escalated };
  });
}
