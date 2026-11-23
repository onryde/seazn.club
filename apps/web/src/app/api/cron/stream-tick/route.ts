import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import {
  STREAM_TICK_BUDGET_MS, type SessionDeps, type StreamTickResult, defaultDeps, tickOpenSessions,
} from "@/server/usecases/stream-sessions";
import { SEAZN_PASS_BUDGET_MS, type SeaznPassResult, lockSeaznRecordings } from "@/server/usecases/seazn-recordings";
import { type SeaznReplayDeps, type SeaznReplayResult, runSeaznReplays } from "@/server/usecases/seazn-replays";
import { processPlaybackTokenCache } from "@/server/video/cf-playback";
import { replayDriver } from "@/server/video/replay-driver";
import { youtubeDriver } from "@/server/youtube/driver";
import { YOUTUBE_END_BUDGET_MS, type YoutubeEndResult, endDueBroadcasts } from "@/server/youtube/end-step";

/** The route's 200 body (inside handler's `{ ok, data }`). EXPLICIT on purpose: the cron Worker reads `data.failed`,
 *  `data.youtube.failed` AND `data.seazn.failed` as its failure counters (R3), so every answer carries all three, and
 *  drift.test.ts finds the first field's numeric declaration in the imported StreamTickResult.
 *
 *  `youtube` (YouTube Connect T15, spec §9.2) is the end step's own result: `ended` (completed at YouTube), `neverLive` (a broadcast
 *  that never carried video, deleted — and one YouTube itself removed, which may have been live: end-step.ts `broadcast_revoked`),
 *  `orphans` (a prepared broadcast nobody streamed into), `failed` (failed THIS pass and will be retried with backoff — the one
 *  counter the Worker alerts on) and `deferred` (the step's budget ran out; the next firing reaches them). */
/**
 *  `seazn` (Seazn-hosted video Task 13) is the Seazn pass's own result (usecases/seazn-recordings.ts SeaznPassResult): `locked`,
 *  `relocked`, `refused` (C6), `failed` (the counter the Worker alerts on) and `deferred`. Task 24 adds the replay move's
 *  (usecases/seazn-replays.ts SeaznReplayResult): `discovered`, `moved` and `playable`, with its refusals, failures and deferrals
 *  added to the lock's.
 *
 *  An interface whose own body declares the three SUMMED counters, `failed` above all: drift.test.ts (m6) judges
 *  `data.seazn.failed` by its full path, reading the body of the type this route names for `seazn`. An intersection alias has no
 *  body to read, and a counter only inherited from SeaznPassResult would be the lock's alone, not the answer's. */
interface SeaznAnswer extends SeaznPassResult, Pick<SeaznReplayResult, "discovered" | "moved" | "playable"> {
  /** The lock's refusals plus the move's. */
  refused: number;
  /** The lock's failures plus the move's: the counter the Worker alerts on (R3). */
  failed: number;
  /** The lock's deferrals plus the move's. */
  deferred: number;
}
type StreamTickAnswer = (StreamTickResult | (StreamTickResult & { disabled: true })) & { youtube: YoutubeEndResult; seazn: SeaznAnswer };

/** What a throw out of the WHOLE step reads as: the step could not run, which is one failure — never a reason to skip the
 *  session pass. (A throw on one broadcast is caught inside the step, by T14, and counted there.) */
const STEP_FAILED: YoutubeEndResult = { ended: 0, neverLive: 0, orphans: 0, failed: 1, deferred: 0 };
/** The Seazn pass's answer when it did not run (no relay), and when the whole pass threw. */
const SEAZN_IDLE: SeaznPassResult = { locked: 0, relocked: 0, refused: 0, failed: 0, deferred: 0 };
const SEAZN_FAILED: SeaznPassResult = { ...SEAZN_IDLE, failed: 1 };
/** The replay move's answer when the whole move threw (Task 24). */
const REPLAYS_FAILED: SeaznReplayResult = { discovered: 0, moved: 0, playable: 0, refused: 0, failed: 1, deferred: 0 };
const REPLAYS_IDLE: SeaznReplayResult = { ...REPLAYS_FAILED, failed: 0 };
/** The lock's answer and the move's, as one `seazn` answer. */
const seaznAnswer = (lock: SeaznPassResult, replays: SeaznReplayResult): SeaznAnswer => ({
  locked: lock.locked, relocked: lock.relocked, refused: lock.refused + replays.refused, failed: lock.failed + replays.failed,
  deferred: lock.deferred + replays.deferred, discovered: replays.discovered, moved: replays.moved, playable: replays.playable,
});

/** The YouTube end step, on its own slice of the tick (`YOUTUBE_END_BUDGET_MS`), over EVERY organisation (no `orgIds`: that
 *  option is the test seam). Never throws: a throw — the database down, or a YOUTUBE_DRIVER that is not `fake` or `live`, which
 *  the deps' port getter raises when READ — is reported once and answered as `failed: 1`, and the session pass goes on. */
async function endYoutube(deps: SessionDeps): Promise<YoutubeEndResult> {
  try {
    return await endDueBroadcasts(deps.youtube ?? youtubeDriver(), { now: deps.now, budgetMs: YOUTUBE_END_BUDGET_MS });
  } catch (err) {
    // The log names the error's class only, never its message (a database error can echo a connection string), as viaPort
    // does in end-step.ts; the whole error goes to Sentry, whose own scrubbing applies.
    log.error({ errClass: err instanceof Error ? err.name : typeof err }, "stream tick: the YouTube end step threw");
    captureError(err, { route: "cron.stream_tick.youtube" });
    return { ...STEP_FAILED };
  }
}

/** The Seazn pass (Task 13): every recording of a Seazn programme input made to need a token, over EVERY organisation (no
 *  `orgIds`: the test seam). Never throws, like `endYoutube`: a throw out of the whole pass (the database down) is logged by
 *  class, reported once and answered as `failed: 1`. A throw on one recording is counted inside the pass. */
async function lockSeazn(deps: SessionDeps, budgetMs: number): Promise<SeaznPassResult> {
  try {
    return await lockSeaznRecordings(deps, { now: deps.now(), budgetMs });
  } catch (err) {
    log.error({ errClass: err instanceof Error ? err.name : typeof err }, "stream tick: the Seazn pass threw");
    captureError(err, { route: "cron.stream_tick.seazn" });
    return { ...SEAZN_FAILED };
  }
}

/** The replay move (Task 24): discovery and the mover, on what is left of the Seazn slice, over EVERY organisation. Never throws,
 *  like `lockSeazn`. The replay host is a getter, built only when the move reads it — with SEAZN_HOSTED_REPLAY off it never does, so
 *  a deployment with no replay host configured is not a failure every firing. */
async function moveReplays(deps: SessionDeps, budgetMs: number): Promise<SeaznReplayResult> {
  try {
    const replayDeps: SeaznReplayDeps = {
      ingest: deps.drivers.ingest,
      get replay() { return replayDriver(); },
      tokenCache: processPlaybackTokenCache(),
    };
    return await runSeaznReplays(replayDeps, { now: deps.now(), budgetMs });
  } catch (err) {
    log.error({ errClass: err instanceof Error ? err.name : typeof err }, "stream tick: the Seazn replay move threw");
    captureError(err, { route: "cron.stream_tick.seazn_replays" });
    return { ...REPLAYS_FAILED };
  }
}

/** POST /api/cron/stream-tick — EVERY FAST FIRING (prod: every minute; stg: every 5 minutes, owner Q1 = b). Three passes, in this order:
 *  1. YouTube Connect T15 (spec §6.7): the end step (`endDueBroadcasts`) ends the YouTube broadcasts whose end is due. It runs FIRST
 *     and on a relay-disabled deployment too — a broadcast is YouTube's to end whether or not this deployment still has a relay.
 *  2. Capture QR v2 §6.11 (W22): `tickOpenSessions` ticks every open stream session, so a phone that dies with no panel open is
 *     still ended — ask 10, W19, m-5 — within one firing. It gets what is LEFT of its 45 s (`STREAM_TICK_BUDGET_MS`) after the
 *     step, so the whole tick still stops starting work at 45 s, below the Worker's 60 s timeout.
 *  3. Seazn-hosted video Task 13: `lockSeaznRecordings` signs every new recording of a Seazn programme input (C3: Cloudflare
 *     records a signed input's recording unsigned). It runs INSIDE the same 45 s, on min(SEAZN_PASS_BUDGET_MS, what is left), so
 *     a session pass that used the whole budget defers it to the next firing rather than running the firing past 45 s.
 *     Task 24: the same pass then moves Seazn recordings to the replay host (`runSeaznReplays`), on what the lock left of the slice.
 *  The order matters: a session the tick expires in this firing ends its broadcast's grace NOW, so that broadcast is ended by a
 *  LATER firing — the step has already looked.
 *  Cron-shaped like /api/cron/relay-sweep, in its order: 503 when CRON_SECRET is unset BEFORE 401 on a mismatch, so an
 *  unset secret can never read as "no auth required". The passes run with the production deps ALONE (no test scope).
 *  Schedule: apps/cron-worker/src/schedule.ts, the env's fast trigger, never retried (the next firing is the retry).
 *  R5: with no relay on this deployment it ticks no session, locks nothing, and answers zeros — WITH `failed: 0`, the step's
 *  `youtube` counters and zero `seazn` counters,
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
    if (deps.drivers.disabled) return { disabled: true, ticked: 0, ended: 0, failed: 0, deferred: 0, youtube, seazn: seaznAnswer(SEAZN_IDLE, REPLAYS_IDLE) };
    // What is left, never below 0: a step that overran the whole tick (one claim's calls can outlast its slice) leaves the session
    // pass a budget of 0, which defers every open session to the next firing rather than refusing the pass.
    const left = Math.max(0, STREAM_TICK_BUDGET_MS - (Date.now() - started));
    const sessions = await tickOpenSessions(deps, { budgetMs: left });
    const seaznBudget = Math.min(SEAZN_PASS_BUDGET_MS, Math.max(0, STREAM_TICK_BUDGET_MS - (Date.now() - started)));
    const seaznStarted = Date.now();
    const lock = await lockSeazn(deps, seaznBudget);
    const replays = await moveReplays(deps, Math.max(0, seaznBudget - (Date.now() - seaznStarted)));
    return { ...sessions, youtube, seazn: seaznAnswer(lock, replays) };
  });
}
