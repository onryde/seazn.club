import "server-only";
import { sql } from "@/lib/db";
import { liveMintClaimSince } from "@/server/external-play/window";
import { log } from "@/server/logger";
import { cancelClosedBoardStrays } from "../create-game";
import { LichessRateLimited, PLAYABLE_STATUSES, orgScope, type Pass } from "./pass";

// ─── Job 7: what a closed board's create may have left open at Lichess (lual review m6; rcs, 2026-11-23; fix round 1) ──────
//
// A create that may have reached Lichess (T9's sent marker, `create_sent_at`) is recovered only by T9's next claimant - and a
// fixture no longer playable is never claimed. So when a withdrawal, a void or a result entered elsewhere closes such a board
// (job 0, reconcile, resolve: bridge-close), nothing else would ever cancel the challenge its create left.
//
// This job runs on a CLOSED bridge (`finished`) of a fixture that is no longer playable, still carrying the marker and no
// recorded game, whose cleanup is not done (`strays_closed_at`, V543), and whose last mint claim is stale - so a T9 call cut
// off mid-recovery has made its last Lichess call before this one makes its first (every T9 call is preceded by a claim
// write, which a finished row refuses). The row's work is create-game's `cancelClosedBoardStrays`: it cancels ONLY a match
// listed while it could still be our create (controller ruling I1: the recovery's own window after the marker); a board
// reached after that window is stamped `not_listed` without a call, and a lookalike is never cancelled.
//
// THE KNOWN RESIDUAL (I1): our own unaccepted challenge leaves Lichess's list ~36 s after the send and stays acceptable, and
// this job can first look 30 s after the marker, on a pass every few minutes - so it almost never sees it, and stamps
// `not_listed` (logged at warn with the age) over a challenge Black can still accept. The fix is to record the challenge id
// the moment the create answers, before the accept (rcs-report.md residual 1, owed its own T9 task); this job could then
// cancel that one id, listed or not.
//
// Failures: a pass that ends in `retry` (an answer that proves nothing, a same-pair create in flight) or throws counts one
// `strays_attempts`; the STRAYS_GIVE_UP_AFTER-th stamps the board `gave_up` (logged at warn), so nothing retries for ever. The
// candidates are read fewest attempts first, so a failing board never holds the head of the line. A 429 counts one too and
// stops the WHOLE job for the pass (LichessRateLimited: the rest are `deferred`, not failures).
//
// A NETWORK job (Lichess), under the pass budget, and LAST among them: it is housekeeping on boards that are over, and must
// never take the budget from a create, a reconcile or a teardown.

/** Failed passes (retry or throw) after which a board's cleanup is given up and stamped `gave_up`. Twelve sweep firings is
 *  an hour at the 5-minute cadence - far past the window in which anything listed could still be our create. */
export const STRAYS_GIVE_UP_AFTER = 12;

export async function strayCandidates(pass: Pass): Promise<{ fixtureId: string }[]> {
  return sql<{ fixtureId: string }[]>`
    select ep.fixture_id as "fixtureId"
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
     where ep.status = 'finished'
       and ep.challenge_id is null
       and ep.create_sent_at is not null
       and ep.strays_closed_at is null
       and f.status not in ${sql(PLAYABLE_STATUSES as string[])}
       and (ep.mint_claimed_at is null or ep.mint_claimed_at < ${liveMintClaimSince(pass.now)})
       ${orgScope(pass)}
     order by ep.strays_attempts, ep.create_sent_at, ep.fixture_id`;
}

/** One failed pass for the board; the STRAYS_GIVE_UP_AFTER-th stamps it `gave_up` in the same statement. */
async function noteFailedPass(fixtureId: string, why: string): Promise<void> {
  const [row] = await sql<{ attempts: number; gaveUp: boolean }[]>`
    update fixture_external_play
       set strays_attempts = strays_attempts + 1,
           strays_closed_at = case when strays_attempts + 1 >= ${STRAYS_GIVE_UP_AFTER} then now() else strays_closed_at end,
           strays_closed_reason = case when strays_attempts + 1 >= ${STRAYS_GIVE_UP_AFTER} then 'gave_up' else strays_closed_reason end,
           updated_at = now()
     where fixture_id = ${fixtureId} and strays_closed_at is null
    returning strays_attempts as attempts, strays_closed_at is not null as "gaveUp"`;
  if (row?.gaveUp) {
    log.warn({ fixtureId, attempts: row.attempts, why }, "sweep: gave up on a closed board's strays after repeated failed passes");
  } else if (row) {
    log.warn({ fixtureId, attempts: row.attempts, why }, "sweep: a closed board's strays wait for a later pass");
  }
}

export async function closeStrays(pass: Pass, c: { fixtureId: string }): Promise<void> {
  let out: Awaited<ReturnType<typeof cancelClosedBoardStrays>>;
  try {
    out = await cancelClosedBoardStrays(c.fixtureId, { clock: () => new Date(pass.clock()) });
  } catch (err) {
    await noteFailedPass(c.fixtureId, `threw: ${err instanceof Error ? err.name : "unknown"}`);
    throw err; // listed and counted by `each`
  }
  if (out.kind === "skipped") return; // the row moved on since the candidate read: nothing of it is owed now
  pass.report.straysCancelled += out.cancelled;
  if (out.kind === "done") return;
  await noteFailedPass(c.fixtureId, out.why);
  if (out.rateLimited) throw new LichessRateLimited(out.why);
}
