import "server-only";
import { sql } from "@/lib/db";
import { anchorOfRow, boardExtraSql, boardRankSql } from "@/server/external-play/round-open";
import { liveMintClaimSince, type BoardAnchor } from "@/server/external-play/window";
import { boardPhase } from "@/server/external-play/seat-line";
import { loadOnlinePlayFixture, loadSides, onlinePlayBoardWhere } from "../guard";
import { checkIns } from "../room";
import { PLAYABLE_STATUSES, bothCameFor, orgScope, type Pass, type SweepDeps } from "./pass";

// ─── Job 2: the mint retry (M3; D21-fix-3 F2b) ─────────────────────────────
//
// TWO kinds of board come back here, both `pending` with no game, no sent create and no create in flight.
//
// 1. A create that met Lichess's 429 wall: it leaves the board with no claim and T9's marker in `last_error`:
//      create:rate_limited (<reason>) retry_at=<ISO | unknown>
//    (create-game.ts noteThrottled - "recorded for the cron's mint retry, which is what honours retryAt"). The queue
//    never waits a hold out; this job does: a board is retried only once `retry_at` has passed, and only inside its
//    round's window - past DEADLINE_AFTER_MS no game can be made (T9's createAtDequeue refuses), and the board belongs to job 1 or
//    the organiser.
//
// 2. A board STRANDED with both players in (D21-fix-3, F2b; found by the D22 load test). Both are seated, both check-ins
//    count, and the game was never created: T9 re-verifies both seats immediately before creating, the platform's
//    RealtimeKit call budget deferred that re-verify, and a deferral writes NOTHING (it is not a failure of the board:
//    no `last_error`, no claim, no marker). The client ignores the `create` field of its claim answer and a seated
//    player never claims again, so without this nothing would ever ask T9 again before the deadline. The shape is
//    exactly "pending, no error on file, no create in flight, both check-ins counted" - and the second check-in must be
//    STRANDED_CREATE_AFTER_MS old, so a board whose own create is still running (it has not claimed yet: its seats are
//    being re-verified) is not created a second time by the sweep.
//
// The cron fires every SWEEP_CADENCE_MS (5 minutes, spec §4), so a stranded board is created by the NEXT pass: the
// recovery is bounded by the cadence, not instant.

const THROTTLED_MARKER = "create:rate_limited";

/** D21-fix-3 (F2b): how old the later of the two check-ins must be before the sweep creates a stranded board's game.
 *  The room's own create runs inside the second player's claim; its slowest honest run (two seat re-verifies, a Lichess
 *  create and an accept, each bounded at LICHESS_TIMEOUT_MS / the vendor's 10 s) is shorter than the claim-staleness
 *  bound a takeover waits for (MINT_CLAIM_STALE_MS), and this grace is shorter again, because a create that has already
 *  CLAIMED is excluded by its own live claim, not by this wait. Since 17dcfc352 the check-in is stamped at the instant the
 *  window was JUDGED, which precedes the seat, so by the time a claim's seat has finished its stamp can already be older than this wait:
 *  the wait no longer covers the claim's own seat, and a pass may try a create beside the claim's (see the comment above
 *  `stampFixtureCheckIn` in room.ts, and spec §5.7.8). Two creates racing past it are still safe: the claim is one statement and the
 *  loser is `lost`. */
export const STRANDED_CREATE_AFTER_MS = 10_000;

type RetryCandidate = { fixtureId: string; openedAt: Date; anchor: BoardAnchor; lastError: string | null };

export async function retryCandidates(pass: Pick<Pass, "now" | "orgIds">): Promise<RetryCandidate[]> {
  const gracedBefore = new Date(pass.now.getTime() - STRANDED_CREATE_AFTER_MS);
  const rows = await sql<(Omit<RetryCandidate, "anchor"> & { rank: number; extraMs: number; staggered: boolean })[]>`
    select f.id as "fixtureId", o.opened_at as "openedAt", o.staggered, ${boardRankSql(sql)} as rank, ${boardExtraSql(sql)} as "extraMs",
           ep.last_error as "lastError"
      from fixtures f
      join divisions d on d.id = f.division_id
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.status in ${sql(PLAYABLE_STATUSES as string[])}
       and (ep.fixture_id is null or (ep.status = 'pending' and ep.challenge_id is null and ep.create_sent_at is null))
       and (
         -- 1. Lichess's 429 wall: the marker T9 wrote, no claim.
         (ep.last_error like ${THROTTLED_MARKER + "%"} and ep.mint_claimed_at is null)
         or (
           -- 2. Stranded: no error on file, no LIVE claim (a stale one is T9's own takeover), the board still an online
           --    one, and two check-ins on file whose later one is old enough. Loose here (the exact window judgement is
           --    checkIns', in mintRetry): a superset is safe, a miss is a stranded board.
           ep.last_error is null
           and (ep.mint_claimed_at is null or ep.mint_claimed_at < ${liveMintClaimSince(pass.now)})
           and f.home_entrant_id is not null and f.away_entrant_id is not null
           and ${onlinePlayBoardWhere()}
           and (select count(*) filter (where fa.checked_in_at is not null) >= 2 and max(fa.checked_in_at) <= ${gracedBefore}
                  from fixture_availability fa where fa.fixture_id = f.id)
         )
       )
       ${orgScope(pass)}
     order by o.opened_at, f.id`;
  return rows.map((r) => ({ ...r, anchor: anchorOfRow(r) }));
}

/** Test seam (D21-fix-3): the candidate set the SQL above judges, on its own. The arm-2 predicates (two check-ins, both
 *  sides, an online board, the grace) are a LOOSE pre-filter in front of mintRetry's exact judgement, so a mutant that
 *  loosens one changes no outcome - only which boards a pass looks at. That is a property of the SET, and only the set can
 *  show it (external-play-stranded-create.test.ts). */
export const __retryCandidates = (now: Date, orgIds?: readonly string[]) => retryCandidates({ now, orgIds });

/** When T9's marker says the hold ends. `null` — retry now — for `unknown`
 *  (T9's spelling of a hold with no time) and for anything unreadable: a
 *  retry the queue would still refuse costs one refusal, while a marker read
 *  as "never" would strand the board. */
/** Exported for the match room (T14), which shows the same retry instant the
 *  sweep honours — one reading of T9's marker, not two. */
export function throttledRetryAt(lastError: string): Date | null {
  const at = /retry_at=(\S+)$/.exec(lastError)?.[1];
  if (at === undefined || at === "unknown") return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : new Date(t);
}

export async function mintRetry(pass: Pass, c: RetryCandidate, create: NonNullable<SweepDeps["createGameIfReady"]>): Promise<void> {
  // Only the deadline bounds it: a marker is written after the open, so a pass can never see one before the window opened.
  // Past the deadline the create is still owed until the board's cap iff BOTH players' check-ins count (spec §5.7.8).
  const phase = await boardPhase(pass.now, { fixtureId: c.fixtureId, anchor: c.anchor }, {
    personId: null,
    bothOnly: true,
    facts: () => bothCameFor(c.fixtureId, c.anchor),
  });
  if (phase !== "open") return;
  if (c.lastError !== null) {
    // 1. A throttle's marker: Lichess's hold is honoured.
    const retryAt = throttledRetryAt(c.lastError);
    if (retryAt !== null && pass.now.getTime() < retryAt.getTime()) return;
  } else {
    // 2. A stranded board: the candidate query's check-in test was loose; THIS is the window's exact judgement, the one
    //    the room and job 1 use - a check-in stamped before this open does not count.
    const f = await loadOnlinePlayFixture(c.fixtureId);
    if (!f) return;
    const { home, away } = await loadSides(f);
    const came = await checkIns(f, home, away, c.anchor);
    if (!(came.home && came.away)) return;
  }
  pass.report.mintRetries++;
  await create(c.fixtureId, { now: pass.now });
}
