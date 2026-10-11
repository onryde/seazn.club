import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepExternalPlay } from "@/server/usecases/external-play";

/** POST /api/cron/external-play — the 5-minute cron (chess in-page board
 *  design §4): one pass of the external-play sweep (T13) — the T+20 no-show,
 *  the mint retry for a create Lichess throttled, meeting teardown, and the
 *  reconcile sweep that reads every game on file. Answers the sweep's report
 *  (counts, and failures by code — never a message; `skipped` when another
 *  pass was still running, T13 M8). Wired in the separate
 *  cron repo (onryde/seazn.club.workflow).
 *  Cron-shaped like /api/cron/registrations: x-cron-secret header (CRON_SECRET).
 *  Lichess pushes nothing to us (spec §3.5; the old webhook route is deleted):
 *  game state is READ by reconcile, and this is the one trigger for it that
 *  needs no page open. */
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepExternalPlay();
  });
}
