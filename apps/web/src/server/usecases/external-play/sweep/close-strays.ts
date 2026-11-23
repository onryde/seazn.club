import "server-only";
import { sql } from "@/lib/db";
import { liveMintClaimSince } from "@/server/external-play/window";
import { log } from "@/server/logger";
import { cancelClosedBoardStrays } from "../create-game";
import { PLAYABLE_STATUSES, orgScope, type Pass } from "./pass";

// ─── Job 7: the strays a closed board left at Lichess (lual review m6; the recovery-clock / strays task, 2026-11-23) ───────
//
// A create that may have reached Lichess (T9's sent marker, `create_sent_at`) is recovered only by T9's next claimant - and a
// fixture no longer playable is never claimed. So when a withdrawal, a void or a result entered elsewhere closes such a board
// (job 0, reconcile, resolve: bridge-close), the challenges matching its create stay open at Lichess, for Black to accept, for
// ever: those a recovery was about to cancel when it lost its claim to the close, and those no recovery ever looked at.
//
// This job is the one place that closes them. It runs on a CLOSED bridge (`finished`) of a fixture that is no longer playable,
// still carrying the marker and no recorded game, whose cleanup is not done yet (`strays_closed_at`, V543), and whose last mint
// claim is stale - so a T9 call cut off mid-recovery has made its last Lichess call before this one makes its first (every T9
// call is preceded by a claim write, which a finished row refuses). The row's own work is create-game's
// `cancelClosedBoardStrays`: one listing, then each match cancelled one at a time, with White's token. Done is stamped once;
// a 429 (or any answer that proves nothing) leaves it for a later pass, whose fresh listing is what decides what is still
// open - so nothing is ever cancelled twice.
//
// A NETWORK job (Lichess), under the pass budget, and LAST among them: it is housekeeping on boards that are over, and must
// never take the budget from a create, a reconcile or a teardown.

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
     order by ep.create_sent_at, ep.fixture_id`;
}

export async function closeStrays(pass: Pass, c: { fixtureId: string }): Promise<void> {
  const out = await cancelClosedBoardStrays(c.fixtureId);
  if (out.kind === "skipped") return; // the row moved on since the candidate read: nothing of it is owed now
  pass.report.straysCancelled += out.cancelled;
  if (out.kind === "retry") log.info({ fixtureId: c.fixtureId, why: out.why, cancelled: out.cancelled }, "sweep: a closed board's strays wait for a later pass");
}
