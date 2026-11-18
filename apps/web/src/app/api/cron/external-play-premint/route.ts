import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { premintExternalPlay } from "@/server/usecases/external-play";
// The answer's type, from its own module: apps/cron-worker/test/drift.test.ts reads the modules this route imports for
// the numeric `failed` and `skipped` the Worker counts (R3), and the barrel above only re-exports.
import type { PremintReport } from "@/server/usecases/external-play/premint";

/** POST /api/cron/external-play-premint - ONE PASS of the pre-mint job (check-in capacity spec 2026-11-05 §11, plan 2
 *  Task 5): makes the video rooms of every board of an UNOPENED round in an online, camera-on division before the round's
 *  check-in window opens, nearest round first, a vendor call a second, so a player's first claim finds its room waiting.
 *  It makes rooms and only rooms (never a participant, never an adoption: the claim's) and is OFF unless
 *  EXTERNAL_PLAY_PREMINT is exactly "1" (premint.ts): with the flag off the pass answers `disabled: 1` and makes no vendor
 *  call. Answers the pass's report (counts, and failures by code - never a message). The cron Worker counts `failed` (a
 *  board's room that could not be made; a vendor that is down is at most PREMINT_FAILURES_BEFORE_BREAK of them a pass,
 *  then the rest is deferred) and `skipped` (1 when another pass held the lock: a pass that overlaps the next firing ran
 *  for a minute) as failures; `disabled`, `windowsOpen` and `deferred` (a budget or the platform's bucket ran out) are
 *  not. The report is returned as it is: a failed pass is a 200 whose body the Worker reads, never swallowed here.
 *  Schedule: apps/cron-worker/src/schedule.ts, EVERY firing of the env's fast trigger (every minute on prod, every 5
 *  minutes on stg), never retried (the next firing is the retry; the pass's lock answers an overlap with `skipped`).
 *  Cron-shaped like /api/cron/external-play: x-cron-secret header (CRON_SECRET), 503 when it is unset BEFORE 401 on a
 *  mismatch, so an unset secret can never read as "no auth required". The pass runs with the production defaults ALONE:
 *  every org, the real clock, the real RealtimeKit - never a test seam. */
export async function POST() {
  return handler(async (): Promise<PremintReport> => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return premintExternalPlay();
  });
}
