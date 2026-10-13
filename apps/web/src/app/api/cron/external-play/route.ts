import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sweepExternalPlay } from "@/server/usecases/external-play";
// The answer's type, from its own module: apps/cron-worker/test/drift.test.ts reads the modules this route imports for
// the numeric `failed` and `skipped` the Worker counts (R3), and the barrel above only re-exports.
import type { SweepReport } from "@/server/usecases/external-play/sweep";

/** POST /api/cron/external-play — the 5-minute cron (chess in-page board
 *  design §4): one pass of the external-play sweep (T13) — the T+20 no-show,
 *  the mint retry for a create Lichess throttled, meeting teardown, the
 *  reconcile sweep that reads every game on file, the camera evidence after
 *  a match and the removal of arbiter watches that must end (T15 fix round
 *  1, I2). Answers the sweep's report
 *  (counts, and failures by code — never a message; `skipped` 1 when another
 *  pass was still running, T13 M8). The cron Worker counts `failed` and
 *  `skipped` as failures (final review I-1); `deferred` (the pass budget ran
 *  out) is not one. Schedule:
 *  apps/cron-worker/src/schedule.ts, the every-5-minutes trigger, never
 *  retried (the next firing is the retry).
 *  Cron-shaped like /api/cron/registrations: x-cron-secret header (CRON_SECRET).
 *  Lichess pushes nothing to us (spec §3.5; the old webhook route is deleted):
 *  game state is READ by reconcile, and this is the one trigger for it that
 *  needs no page open. */
export async function POST() {
  return handler(async (): Promise<SweepReport> => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepExternalPlay();
  });
}
