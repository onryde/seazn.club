import "server-only";
// B1 (court-stream device check, owner 2026-11-17: "match decided -> 30 s stops in app -> another 30 s stop in youtube"): after a COURT
// session ends, its YouTube broadcast is completed near the end rule's due time (30 s after the Stop BEGAN for a finished match, even
// while a composed session is still `ending`: device check 2, C1; see end-rule.ts), not at
// the next cron firing. The cron's end step is unchanged and stays the safety net: this deferred run only goes through the same
// `endDueBroadcasts` (same claim under `for update skip locked`, same due rule), so one that finds the broadcast already completed, or
// claimed by the cron, does nothing and calls YouTube nothing.
import { sql } from "@/lib/db";
import { deferred } from "@/lib/deferred";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { FINISHED_STATUSES, broadcastEndDueAt, readEndFacts } from "@/server/youtube/end-rule";
import { endDueBroadcasts } from "@/server/youtube/end-step";
import { youtubeOf, type SessionDeps } from "./deps";

/** The longest this tail waits in all (the session settling, then the due time), so it ends inside any request window. A due time
 *  past it is the cron's. */
export const COURT_END_WAIT_BOUND_MS = 45_000;
/** How often a session still ending (a composed one waits on its runner) is looked at again. */
const SETTLE_POLL_MS = 1_000;
/** How often a court match that was unfinished at the stop is re-read, in case its result lands inside the bound (fix 3). */
const RESULT_POLL_MS = 5_000;
/** The end step's own budget for this one broadcast. */
const COURT_END_STEP_BUDGET_MS = 15_000;

type Seams = { sleep?: (ms: number) => Promise<void>; wallClock?: () => number };
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Why the tail returned without ending (C1: a miss is visible in the logs). Words only, with ids. */
type MissReason = "not_court_broadcast" | "not_due" | "still_active" | "due_past_bound";
function missed(reason: MissReason, sid: string, bid: string | null): false {
  log.info({ reason, sid, bid }, "court stream: the deferred YouTube end returned without ending; the cron will end it");
  return false;
}

/** The broadcast of `sessionId` when it is a court session on one, else null. */
async function courtBroadcastOf(sessionId: string): Promise<string | null> {
  const [r] = await sql<{ b: string | null }[]>`
    select youtube_broadcast_id as b from fixture_stream_sessions where id = ${sessionId} and court_link_id is not null`;
  return r?.b ?? null;
}

/**
 * Wait (bounded by COURT_END_WAIT_BOUND_MS) for the court session's broadcast to be due, then run the end step on it. Resolves with
 * whether the end step was run. Never throws: a failure is reported and the cron completes the broadcast. Awaitable for tests;
 * production calls `endCourtBroadcastSoon`.
 */
export async function runCourtBroadcastEnd(sessionId: string, deps: SessionDeps, seams: Seams = {}): Promise<boolean> {
  const sleep = seams.sleep ?? realSleep;
  const wall = seams.wallClock ?? Date.now;
  const started = wall();
  const left = () => COURT_END_WAIT_BOUND_MS - (wall() - started);
  try {
    const broadcastId = await courtBroadcastOf(sessionId);
    if (broadcastId === null) return missed("not_court_broadcast", sessionId, null);
    for (;;) {
      const facts = await readEndFacts(sql, broadcastId);
      const due = broadcastEndDueAt(facts, deps.now());
      if (due === null) {
        // Null with a session still active (a restart, or this one `ending` while the match is unfinished: a finished match's ending
        // court session no longer holds the end, C1): look again. Null otherwise (no Stop yet, a reservation): not this tail's.
        if (!facts.activeSessionOnBroadcast) return missed("not_due", sessionId, broadcastId);
        if (left() <= SETTLE_POLL_MS) return missed("still_active", sessionId, broadcastId);
        await sleep(SETTLE_POLL_MS);
        continue;
      }
      const wait = due.getTime() - deps.now().getTime();
      if (wait > left()) {
        // The grace (an unfinished match, 5 min) is the cron's, but a court match stopped just before its result is read again
        // until the bound runs out: a result landing inside it makes the end due 30 s after it.
        const unfinished = !(FINISHED_STATUSES as readonly string[]).includes(facts.fixtureStatus);
        if (!(facts.lastSessionCourt === true && unfinished) || left() <= RESULT_POLL_MS) {
          return missed("due_past_bound", sessionId, broadcastId);
        }
        await sleep(RESULT_POLL_MS);
        continue;
      }
      if (wait > 0) await sleep(wait);
      await endDueBroadcasts(youtubeOf(deps), { now: deps.now, budgetMs: COURT_END_STEP_BUDGET_MS, broadcastIds: [broadcastId] });
      return true;
    }
  } catch (err) {
    log.warn({ errClass: err instanceof Error ? err.name : typeof err, sid: sessionId }, "court stream: the deferred YouTube end failed; the cron will end it");
    captureError(err, { route: "court_stream.youtube_end", extra: { sessionId } });
    return false;
  }
}

/** BEST EFFORT, not a guarantee (fix 2): on Fly `after()` work can be lost when the machine suspends or is redeployed mid-wait, and
 *  then nothing here runs. The stream-tick cron's end step (every minute in production) is the guarantee: it completes the same
 *  broadcast at the same due time, at most a firing late, and is idempotent with this tail.
 *
 *  Queue the end after the response (`deferred`), for a court session that has just been stopped. A session that is not a court
 *  session, or has no YouTube broadcast, does nothing. */
export function endCourtBroadcastSoon(sessionId: string, deps: SessionDeps): void {
  deferred(() => runCourtBroadcastEnd(sessionId, deps));
}
