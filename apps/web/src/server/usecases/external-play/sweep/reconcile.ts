import "server-only";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { assertTimeControl, estimatedSeconds, type TimeControl } from "@/server/external-play/time-controls";
import { boardExtraSql, boardRankSql } from "@/server/external-play/round-open";
import { type BoardAnchor } from "@/server/external-play/window";
import { RECONCILED_WHILE_HELD, type ReconcileOutcome } from "../reconcile";
import { holdForOrganiser } from "../result";
import { PLAYABLE_STATUSES, SWEEP_SETTLING_READS_PER_PASS, candidateAnchor, orgScope, playableWindow, type Pass, type SweepDeps } from "./pass";

// ─── Job 4: the reconcile sweep (spec §3.5, §4; T11 review M3, M4) ─────────
//
// Every game on file is read through T11's reconcile, which opens the BOARD
// STREAM's first line with a player's token (the export only for a terminal
// status). Nothing pushes a game's end to us (T11, ruling M2), so this is the
// trigger that needs no page open: it settles an abandoned board, closes the
// bridge of a fixture settled elsewhere, and — reconcile flags every ply it
// adopts — it is the main detector of moves made at Lichess, not through
// Seazn. So a game is read at EVERY tick while Lichess answers, mid-game
// included; nothing waits for an expected end.
//
// Candidates: a game on file (a challenge) whose bridge is `ready` (created,
// no move yet — an abort at ply 0 lives here until read) or `live`, on any
// fixture (reconcile closes the bridge of one no longer playable); or held
// for one of reconcile's mid-game diagnoses on a fixture still playable —
// EXCEPT T9's create-time holds (M3): those name a challenge that never
// became a game, and would be re-read every tick for ever.
//
// Back-off and the M4 hold. A read that tells nothing (no stream line, no
// terminal export — reconcile's `null` — or a throw) PAST the game's expected
// end is counted in `sweep_no_truth_reads`; each such read doubles the wait
// before the next, up to SWEEP_BACKOFF_CAP_MS, and at SWEEP_NO_TRUTH_HOLD_AFTER
// a ready/live board goes to the organiser as provider_error — a board read
// for ever with no signal blocks the next round. Any read that brings the
// truth resets the count. `last_polled_at` is when the sweep last read; it is
// also the claim, so overlapping passes read a board once.
//
// A HELD board (controller ruling C3): every read of a row already in the
// organiser's queue — T11's mid-game diagnoses and the sweep's own M4 hold —
// counts the same way, whatever it brings and whatever the expected end, so
// a held board is never re-read every tick: the read that matters is the one
// that finds the game over, and the back-off still reaches it within the
// hour. A held row is never held again, and reconcile re-placing the hold it
// already has is not a new hold in the report.

/** Spec §4: the 5-minute cron. */
export const SWEEP_CADENCE_MS = 5 * 60_000;
/** A tick lands up to half a period early or late. A re-read due one tick on
 *  must not slip to the second because the cron fired a second early, and a
 *  pass overlapping the last one must not read the board again. */
const SWEEP_TICK_TOLERANCE_MS = SWEEP_CADENCE_MS / 2;
/** The back-off's ceiling: a board nobody can read is still tried hourly. */
export const SWEEP_BACKOFF_CAP_MS = 12 * SWEEP_CADENCE_MS;
/** M4: empty reads in a row, past the expected end, before a ready/live
 *  board is held provider_error. */
export const SWEEP_NO_TRUTH_HOLD_AFTER = 3;

/** Lichess's own per-player duration multiplier (M13: `limit + 40 ×
 *  increment`) — the moves' worth of increment time-controls.ts's estimate
 *  budgets, taken from it rather than typed here. */
export const SWEEP_MOVE_BUDGET = estimatedSeconds({ key: "sweep-move-budget", limitSeconds: 0, incrementSeconds: 1 });

/** The latest a game started at `startedAt` can still be running: BOTH clocks
 *  spent, each with SWEEP_MOVE_BUDGET moves of increment. */
export function expectedEndAt(startedAt: Date, tc: TimeControl): Date {
  return new Date(startedAt.getTime() + 2 * (tc.limitSeconds + SWEEP_MOVE_BUDGET * tc.incrementSeconds) * 1000);
}

/** After its last read, how long before a board is read again: one tick
 *  while reads bring the truth, then doubling per empty read, capped. */
function reReadAfterMs(noTruthReads: number): number {
  return Math.min(SWEEP_CADENCE_MS * 2 ** Math.max(0, noTruthReads - 1), SWEEP_BACKOFF_CAP_MS);
}

/** T9's create-time holds (create-game.ts: `create:<code>`, `accept:<code>`,
 *  `recover:<why>` in last_error). */
const CREATE_TIME_HOLD = "^(create|accept|recover):";

type ReconcileCandidate = {
  fixtureId: string;
  bridgeStatus: string;
  gameId: string;
  startedAt: Date | null;
  /** Truncated to the millisecond a JS Date holds, so the claim compares
   *  like with like whatever precision a writer used. */
  lastPolledAt: Date | null;
  noTruthReads: number;
  openedAt: Date | null;
  /** The board's anchor; null when its round was never opened. */
  anchor: BoardAnchor | null;
  clock: BoardgameClockInput | null;
  /** When the game was created (the bridge row's `updated_at`, stamped by the ready write): the base of a never-started board's
   *  expected end when that is later than the deadline (spec §5.7.8, m8). */
  gameCreatedAt: Date | null;
};

export async function reconcileCandidates(pass: Pass): Promise<ReconcileCandidate[]> {
  const rows = await sql<(Omit<ReconcileCandidate, "anchor"> & { rank: number; extraMs: number; staggered: boolean | null })[]>`
    select ep.fixture_id as "fixtureId", ep.status as "bridgeStatus", ep.challenge_id as "gameId",
           ep.started_at as "startedAt", date_trunc('milliseconds', ep.last_polled_at) as "lastPolledAt",
           ep.sweep_no_truth_reads as "noTruthReads", o.opened_at as "openedAt", o.staggered,
           ${boardRankSql(sql)} as rank, ${boardExtraSql(sql)} as "extraMs", d.config->'clock' as clock, ep.updated_at as "gameCreatedAt"
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
      join divisions d on d.id = f.division_id
      left join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
     where ep.challenge_id is not null
       and (ep.status in ('ready', 'live')
            or (ep.status = 'needs_organiser'
                and ep.needs_reason in ${sql(RECONCILED_WHILE_HELD as unknown as string[])}
                and coalesce(ep.last_error, '') !~ ${CREATE_TIME_HOLD}
                and f.status in ${sql(PLAYABLE_STATUSES as string[])}))
       ${orgScope(pass)}
     order by ep.last_polled_at nulls first, ep.fixture_id`;
  return rows.map((r) => ({ ...r, anchor: candidateAnchor(r) }));
}

/** addendum 1: the sweep calls assertTimeControl itself. A clock outside the
 *  catalogue has no expected end: its board is still read, never counted. */
function timeControlOf(clock: BoardgameClockInput | null): TimeControl | null {
  try {
    return assertTimeControl(clock ?? undefined);
  } catch (err) {
    if (err instanceof HttpError && err.code === "INVALID_TIME_CONTROL") return null;
    throw err;
  }
}

function expectedEnd(c: ReconcileCandidate): Date | null {
  const tc = timeControlOf(c.clock);
  if (tc === null) return null;
  if (c.startedAt !== null) return expectedEndAt(c.startedAt, tc);
  if (c.bridgeStatus === "live") {
    // T10 stamps started_at with the first move it accepts, T11 with the
    // first it adopts: a live row without one is broken. Read it; never
    // guess its end.
    log.error({ fixtureId: c.fixtureId }, "external-play sweep: a live game on file has no started_at");
    return null;
  }
  // Never started on our side. T9 creates no game after the board's cap (spec §5.7.8: the deadline, or - both players having come
  // while the check-in line held the create back - up to LINE_DEADLINE_GRACE_MS past it) and Lichess aborts one whose first move
  // does not come, so the base is the LATER of the board's deadline and the game's creation, or a game created late would be
  // judged overdue the moment it exists. The creation is the bridge row's `updated_at`, which the ready write stamps on the dequeue's clock;
  // a later rewrite of the row only moves it later (a longer wait, never a false overdue). Any read that brings the truth resets the count regardless.
  if (c.anchor === null) return null;
  const deadline = playableWindow(c.anchor).deadline;
  const base = c.gameCreatedAt !== null && c.gameCreatedAt.getTime() > deadline.getTime() ? c.gameCreatedAt : deadline;
  return expectedEndAt(base, tc);
}

export async function sweepReconcile(pass: Pass, c: ReconcileCandidate, read: NonNullable<SweepDeps["reconcile"]>): Promise<void> {
  if (c.lastPolledAt !== null && pass.now.getTime() - c.lastPolledAt.getTime() < reReadAfterMs(c.noTruthReads) - SWEEP_TICK_TOLERANCE_MS) {
    return;
  }
  // The claim: a compare-and-set on the read we acted on, so of two passes
  // that both saw the board due, one reads it.
  const [claimed] = await sql<HoldFacts[]>`
    update fixture_external_play set last_polled_at = ${pass.now}
     where fixture_id = ${c.fixtureId}
       and date_trunc('milliseconds', last_polled_at) is not distinct from ${c.lastPolledAt}
    returning status, needs_reason as "needsReason"`;
  if (!claimed) return;
  pass.report.reconciled++;
  // D20 (b): the pass's settling-read slots. A flag-due board past the cap is read, never settled here, and deferred.
  let settleDeferred = false;
  const settle = (): boolean => {
    if (pass.settlingReads >= SWEEP_SETTLING_READS_PER_PASS) {
      settleDeferred = true;
      return false;
    }
    pass.settlingReads++;
    return true;
  };
  try {
    await readAndRule(pass, c, read, settle);
  } finally {
    await countHoldPlaced(pass, c.fixtureId, claimed);
    if (settleDeferred) {
      pass.report.deferred++;
      // It keeps its place: the claim is handed back, so the board is due at once and read first next pass. Only
      // this pass's own claim — a later one stands.
      await sql`
        update fixture_external_play set last_polled_at = ${c.lastPolledAt}
         where fixture_id = ${c.fixtureId} and last_polled_at = ${pass.now}`;
    }
  }
}

type HoldFacts = { status: string; needsReason: string | null };

/** Review M6: a hold this read placed — reconcile's own (token_revoked, the
 *  game's end replacing a mid-game diagnosis, T12's snapshot holds) or the
 *  no-truth back-off's — is counted ONCE, by what the row says before the
 *  read (at the claim) and after it, whoever inside the read wrote it. A
 *  hold another actor lands during the read is counted too: the report is
 *  the pass's telling, never a ledger. */
async function countHoldPlaced(pass: Pass, fixtureId: string, before: HoldFacts): Promise<void> {
  const [after] = await sql<HoldFacts[]>`
    select status, needs_reason as "needsReason" from fixture_external_play where fixture_id = ${fixtureId}`;
  if (!after || after.status !== "needs_organiser") return;
  if (before.status === "needs_organiser" && before.needsReason === after.needsReason) return;
  pass.report.heldForOrganiser++;
}

async function readAndRule(
  pass: Pass,
  c: ReconcileCandidate,
  read: NonNullable<SweepDeps["reconcile"]>,
  settle: () => boolean,
): Promise<void> {
  const end = expectedEnd(c);
  if (c.bridgeStatus === "needs_organiser") {
    try {
      await read({ fixtureId: c.fixtureId, trigger: "sweep", settle });
    } finally {
      await countRead(c.fixtureId);
    }
    return;
  }
  let outcome: ReconcileOutcome | null;
  try {
    outcome = await read({ fixtureId: c.fixtureId, trigger: "sweep", settle });
  } catch (err) {
    await noTruth(pass, c, end);
    throw err;
  }
  if (outcome === null) {
    await noTruth(pass, c, end);
    return;
  }
  await sql`
    update fixture_external_play set sweep_no_truth_reads = 0
     where fixture_id = ${c.fixtureId} and sweep_no_truth_reads <> 0`;
}

/** One more read that left the board where it was — the back-off's count. */
async function countRead(fixtureId: string): Promise<{ reads: number; status: string } | undefined> {
  const [row] = await sql<{ reads: number; status: string }[]>`
    update fixture_external_play set sweep_no_truth_reads = sweep_no_truth_reads + 1
     where fixture_id = ${fixtureId} and status in ('ready', 'live', 'needs_organiser')
    returning sweep_no_truth_reads as reads, status`;
  return row;
}

async function noTruth(pass: Pass, c: ReconcileCandidate, end: Date | null): Promise<void> {
  if (end === null || pass.now.getTime() <= end.getTime()) return;
  const row = await countRead(c.fixtureId);
  if (!row || row.reads < SWEEP_NO_TRUTH_HOLD_AFTER) return;
  if (row.status !== "ready" && row.status !== "live") return; // already the organiser's
  // Counted by the read's before/after (review M6), never here too.
  await holdForOrganiser({
    fixtureId: c.fixtureId,
    reason: "provider_error",
    detail: `sweep: ${row.reads} reads of game ${c.gameId} past its expected end (${end.toISOString()}) told us nothing`,
  });
}
