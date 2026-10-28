import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import {
  STREAM_TICK_BUDGET_MS, type SessionDeps, type StreamTickResult, defaultDeps, tickOpenSessions,
} from "@/server/usecases/stream-sessions";
import { youtubeDriver } from "@/server/youtube/driver";
import { YOUTUBE_END_BUDGET_MS, type YoutubeEndResult, endDueBroadcasts } from "@/server/youtube/end-step";

/** The route's 200 body (inside handler's `{ ok, data }`). EXPLICIT on purpose: the cron Worker reads `data.failed` AND
 *  `data.youtube.failed` as its failure counters (R3), so every answer carries both, and drift.test.ts finds the first
 *  field's numeric declaration in the imported StreamTickResult.
 *
 *  `youtube` (YouTube Connect T15, spec §9.2) is the end step's own result: `ended` (completed at YouTube), `neverLive` (a broadcast
 *  that never carried video, deleted — and one YouTube itself removed, which may have been live: end-step.ts `broadcast_revoked`),
 *  `orphans` (a prepared broadcast nobody streamed into), `failed` (failed THIS pass and will be retried with backoff — the one
 *  counter the Worker alerts on) and `deferred` (the step's budget ran out; the next firing reaches them). */
type StreamTickAnswer = (StreamTickResult | (StreamTickResult & { disabled: true })) & { youtube: YoutubeEndResult };

/** What a throw out of the WHOLE step reads as: the step could not run, which is one failure — never a reason to skip the
 *  session pass. (A throw on one broadcast is caught inside the step, by T14, and counted there.) */
const STEP_FAILED: YoutubeEndResult = { ended: 0, neverLive: 0, orphans: 0, failed: 1, deferred: 0 };

/** The YouTube end step, on its own slice of the tick (`YOUTUBE_END_BUDGET_MS`), over EVERY organisation (no `orgIds`: that
 *  option is the test seam). Never throws: a throw — the database down, or a YOUTUBE_DRIVER that is not `fake` or `live`, which
 *  the deps' port getter raises when READ — is reported once and answered as `failed: 1`, and the session pass goes on. */
async function endYoutube(deps: SessionDeps): Promise<YoutubeEndResult> {
  try {
    return await endDueBroadcasts(deps.youtube ?? youtubeDriver(), { now: deps.now, budgetMs: YOUTUBE_END_BUDGET_MS });
  } catch (err) {
    // The step's own errors carry codes and ids only (end-step.ts SECRETS), and what can escape it whole is the database or a
    // misspelt setting: nothing here is a token or a key.
    log.error({ err: err instanceof Error ? err.message : String(err) }, "stream tick: the YouTube end step threw");
    captureError(err, { route: "cron.stream_tick.youtube" });
    return { ...STEP_FAILED };
  }
}

/** POST /api/cron/stream-tick — EVERY FAST FIRING (prod: every minute; stg: every 5 minutes, owner Q1 = b). Two passes, in this order:
 *  1. YouTube Connect T15 (spec §6.7): the end step (`endDueBroadcasts`) ends the YouTube broadcasts whose end is due. It runs FIRST
 *     and on a relay-disabled deployment too — a broadcast is YouTube's to end whether or not this deployment still has a relay.
 *  2. Capture QR v2 §6.11 (W22): `tickOpenSessions` ticks every open stream session, so a phone that dies with no panel open is
 *     still ended — ask 10, W19, m-5 — within one firing. It gets what is LEFT of its 45 s (`STREAM_TICK_BUDGET_MS`) after the
 *     step, so the whole tick still stops starting work at 45 s, below the Worker's 60 s timeout.
 *  The order matters: a session the tick expires in this firing ends its broadcast's grace NOW, so that broadcast is ended by a
 *  LATER firing — the step has already looked.
 *  Cron-shaped like /api/cron/relay-sweep, in its order: 503 when CRON_SECRET is unset BEFORE 401 on a mismatch, so an
 *  unset secret can never read as "no auth required". The passes run with the production deps ALONE (no test scope).
 *  Schedule: apps/cron-worker/src/schedule.ts, the env's fast trigger, never retried (the next firing is the retry).
 *  R5: with no relay on this deployment it ticks no session and answers zeros — WITH `failed: 0` and the step's `youtube` counters,
 *  because the Worker reads a missing counter as "unreadable", i.e. degraded, which would raise a Sentry event from every
 *  relay-disabled deployment. */
export async function POST(req: Request): Promise<Response> {
  return handler(async (): Promise<StreamTickAnswer> => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    const deps = defaultDeps(baseUrl(req));
    const started = Date.now();
    const youtube = await endYoutube(deps);
    if (deps.drivers.disabled) return { disabled: true, ticked: 0, ended: 0, failed: 0, deferred: 0, youtube };
    // What is left, never below 0: a step that overran the whole tick (one claim's calls can outlast its slice) leaves the session
    // pass a budget of 0, which defers every open session to the next firing rather than refusing the pass.
    const left = Math.max(0, STREAM_TICK_BUDGET_MS - (Date.now() - started));
    return { ...(await tickOpenSessions(deps, { budgetMs: left })), youtube };
  });
}
