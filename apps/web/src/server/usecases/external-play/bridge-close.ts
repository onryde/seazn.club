import "server-only";
// One authority for "this online game is over for us" (T16 fix round 1, I1).
//
// A fixture that is no longer playable — decided on the scoring pad, settled
// from the arbiter panel or the queue, walked over or voided by a withdrawal,
// cancelled — ends our interest in its online game, whatever the bridge row
// still reads: pending, ready, live, or held for the organiser. Before this, a
// HELD row under a decided fixture was left alone (reconcile closed only
// ready/live), and the queue hides rows whose fixture is not playable, so it
// was orphaned: the organiser could not see it, and the public watch panel
// said "needs the organiser" under the printed result and polled for ever.
//
// Callers: reconcile (a read of a fixture no longer playable), the sweep's
// first job (every such bridge, every tick — so a pad result or a withdrawal
// is caught within one tick, and a settle that crashed between its score
// write and its close is healed, review M2), and resolve (a board already
// settled elsewhere).
import { sql } from "@/lib/db";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { isPlayableFixtureStatus } from "./preflight";

type Db = typeof sql;

/** T8's predicate as the SQL list, derived so the two can never disagree. */
export const PLAYABLE_FIXTURE_STATUSES: readonly string[] = FIXTURE_STATUSES.filter(isPlayableFixtureStatus);

/** Close `fixtureId`'s bridge when its fixture is no longer playable: finished,
 *  with no hold reason, no revoked seat, no standing draw offer and no pending
 *  move (none of them means anything once the game is over for us).
 *
 *  `finished_at` is the camera judgment's best evidence of the GAME's end
 *  (sweep job 5, ruling I1), so it is stamped only where this close IS that
 *  end — a ready or live game cut off by the fixture (as reconcile always
 *  did). A held row's game ended earlier (`game_over_at`) or at a time only
 *  the clock bounds; stamping the close there would stretch the judged match
 *  to the sweep's tick and read every minute after the game as cameras off. The
 *  fixture's status is checked in the SAME statement, so a fixture voided back
 *  to playable between a caller's read and this write is left alone. True when
 *  a row was closed. */
export async function closeBridgeIfUnplayable(fixtureId: string, at: Date, db: Db = sql): Promise<boolean> {
  const closed = await db`
    update fixture_external_play ep
       set status = 'finished', needs_reason = null, revoked_seat = null, draw_offer_by = null,
           pending_move_ply = null, pending_move_uci = null, pending_move_at = null,
           finished_at = case when ep.status in ('ready', 'live') then coalesce(ep.finished_at, ${at}) else ep.finished_at end,
           updated_at = now()
      from fixtures f
     where ep.fixture_id = ${fixtureId}
       and f.id = ep.fixture_id
       and ep.status <> 'finished'
       and f.status not in ${db(PLAYABLE_FIXTURE_STATUSES as string[])}
    returning ep.fixture_id`;
  return closed.length > 0;
}
