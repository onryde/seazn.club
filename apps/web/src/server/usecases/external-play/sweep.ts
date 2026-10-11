import "server-only";
// The external-play sweep (chess in-page board design §3.5, §3.6, §4; Task 13).
//
// The 5-minute cron's FOUR jobs, every one of which happens when no page is
// open (spec §4):
//   1. the T+20 no-show      → `core.forfeit {by, reason: "walkover"}`;
//   2. the mint retry         for a create that hit Lichess's 429 wall (M3);
//   3. meeting teardown       at the result, or at T+20 when nobody played;
//   4. the reconcile sweep    every game on file, read from the BOARD STREAM by
//                             T11's reconcile — the abandoned-board sweep and
//                             the main detector of moves made at Lichess.
// The T-10 notice is NOT here: under D12 the organiser's open-round action
// sends the invites and stamps the window (T19).
//
// D12: T+20 is relative to the round being OPENED (`stage_round_opens.opened_at`),
// never to `fixtures.scheduled_at`. A fixture whose round was never opened is
// unreachable here — every job that rules on the window INNER-joins the open.
//
// Every per-fixture action runs in its own try/catch: one fixture's refusal
// is reported in `failures` and never aborts the pass.
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { log } from "@/server/logger";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { assertTimeControl, estimatedSeconds, type TimeControl } from "@/server/external-play/time-controls";
import { endMeeting } from "@/server/external-play/video/realtimekit";
import { MINT_CLAIM_STALE_MS, windowFor } from "@/server/external-play/window";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { mintOrgOwnerAuth } from "./auth";
import { createGameIfReady, type CreateOutcome } from "./create-game";
import { ensureBridgeRow, loadOnlinePlayFixture, loadSides } from "./guard";
import { isPlayableFixtureStatus } from "./preflight";
import { RECONCILED_WHILE_HELD, reconcile, type ReconcileOutcome } from "./reconcile";
import { holdForOrganiser } from "./result";
import { checkIns } from "./room";

export type SweepJob = "no_show" | "mint_retry" | "teardown" | "reconcile";

export type SweepReport = {
  noShows: number;
  mintRetries: number;
  meetingsEnded: number;
  reconciled: number;
  heldForOrganiser: number;
  /** Candidates examined across every job — a pass that looked at nothing
   *  says so (anti-vacuity), rather than reporting four zeros. */
  scanned: number;
  /** One per fixture whose action threw. A code, never a message: a
   *  message can carry a Lichess body, and the report is returned to the
   *  cron caller. */
  failures: { job: SweepJob; fixtureId: string; code: string }[];
};

export type SweepDeps = {
  now?: Date;
  /** T7's teardown (kick-all, deactivate, stamp `ended_at`). */
  endMeeting?: (meetingId: string) => Promise<void>;
  /** T9's create, judged on the sweep's clock. */
  createGameIfReady?: (fixtureId: string, deps: { now: Date }) => Promise<CreateOutcome>;
  /** T11's reconcile (`reconcile(fixtureId, "sweep")`), on the sweep's clock. */
  reconcile?: (a: { fixtureId: string; trigger: "sweep" }) => Promise<ReconcileOutcome | null>;
  /** TEST SEAM — scope every job to these orgs. Production passes none and
   *  sweeps every org; the shared test database holds other suites' opened
   *  rounds, which an unscoped sweep would act on. */
  orgIds?: readonly string[];
};

/** The window a board is playable in, anchored on the ROUND being opened
 *  (D12). Gate B (2026-10-11): every merged reader — T9's create, T8's seat
 *  and room, T19's invite and openRound — judges it as
 *  `roomPhase(now, roundOpenedAt)`, so the deadline is window.ts's own
 *  `windowFor(opened).deadline` (opened + DEADLINE_AFTER_MS). `opensAt` is
 *  the open itself: before it nothing exists to play. */
export function playableWindow(roundOpenedAt: Date): { opensAt: Date; deadline: Date } {
  return { opensAt: roundOpenedAt, deadline: windowFor(roundOpenedAt).deadline };
}

/** T8's predicate, as the SQL list the candidate queries filter on — derived,
 *  so the two can never disagree. */
const PLAYABLE_STATUSES: readonly string[] = FIXTURE_STATUSES.filter(isPlayableFixtureStatus);

function codeOf(err: unknown): string {
  if (err instanceof HttpError) return err.code ?? `HTTP_${err.status}`;
  if (err instanceof EngineError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.name : "UNKNOWN";
}

type Pass = { now: Date; orgIds: readonly string[] | undefined; report: SweepReport };

async function each<T extends { fixtureId: string }>(
  pass: Pass,
  job: SweepJob,
  rows: readonly T[],
  act: (row: T) => Promise<void>,
): Promise<void> {
  pass.report.scanned += rows.length;
  for (const row of rows) {
    try {
      await act(row);
    } catch (err) {
      const code = codeOf(err);
      pass.report.failures.push({ job, fixtureId: row.fixtureId, code });
      log.warn({ job, fixtureId: row.fixtureId, code }, "external-play sweep: a fixture's action failed");
    }
  }
}

/** An EMPTY scope matches nothing — postgres.js renders `in ()` of an empty
 *  list as `in (null)` — and is never read as "every org" (tested). */
function orgScope(pass: Pass) {
  return pass.orgIds === undefined ? sql`` : sql`and f.org_id in ${sql(pass.orgIds as string[])}`;
}

// ─── Job 1: the T+20 no-show ───────────────────────────────────────────────
//
// A board is a no-show candidate only when its round was OPENED (inner join),
// the fixture is still playable (T8's predicate — never needs_decision, never a
// withdrawn or settled board), and no game is — or may be — on file: no bridge
// row, or a `pending` one with no challenge, no possibly-sent create
// (`create_sent_at`, T9 I2) and no live mint claim (a create in flight past the
// deadline is T9's to finish) — invite.ts's `bridgeTakesInvites`, plus the
// claim. The window is then judged per board, and the guard loads it.

/** W2b's refusal code (packages/engine core/errors.ts on W2b). Not yet in
 *  this engine's EngineErrorCode union, hence compared as a string. */
const DOUBLE_WALKOVER_NO_NEXT_MATCH = "DOUBLE_WALKOVER_NO_NEXT_MATCH";

type NoShowCandidate = { fixtureId: string; openedAt: Date };

async function noShowCandidates(pass: Pass): Promise<NoShowCandidate[]> {
  return sql<NoShowCandidate[]>`
    select f.id as "fixtureId", o.opened_at as "openedAt"
      from fixtures f
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.status in ${sql(PLAYABLE_STATUSES as string[])}
       and (ep.fixture_id is null
            or (ep.status = 'pending' and ep.challenge_id is null and ep.create_sent_at is null
                and (ep.mint_claimed_at is null
                     or ep.mint_claimed_at < ${new Date(pass.now.getTime() - MINT_CLAIM_STALE_MS)})))
       ${orgScope(pass)}
     order by o.opened_at, f.id`;
}

async function noShow(pass: Pass, c: NoShowCandidate): Promise<void> {
  if (pass.now.getTime() < playableWindow(c.openedAt).deadline.getTime()) return;
  // THE guard (spec §6): online play still on, a boardgame, both entrants.
  // An organiser who switched online play off after the open has taken the
  // board back to the table.
  const f = await loadOnlinePlayFixture(c.fixtureId);
  if (!f) return;
  const { home, away } = await loadSides(f);
  const came = await checkIns(f, home, away, c.openedAt);
  if (came.home && came.away) return;
  const by = !came.home && !came.away ? "both" : !came.home ? f.homeEntrantId : f.awayEntrantId;
  const auth = await mintOrgOwnerAuth(f.orgId);
  const state = await getFixtureState(auth, f.fixtureId);
  try {
    await scoreEvent(auth, f.fixtureId, {
      expected_seq: state.last_seq,
      type: "core.forfeit",
      payload: { by, reason: "walkover" },
      idempotency_key: `extplay-noshow:${f.fixtureId}`,
    });
  } catch (err) {
    // W2b D19: a double walkover on a bracket line that feeds no next match
    // (a final, a last rung, a third-place match) has nowhere for "nobody
    // advances" to go, and is refused. An expected outcome, not an error: the
    // board stays open and goes to the organiser's queue. Read by CODE.
    if (by !== "both" || !(err instanceof EngineError) || (err.code as string) !== DOUBLE_WALKOVER_NO_NEXT_MATCH) throw err;
    // T12's hold needs a row to hold; a board the open never attached has none.
    await ensureBridgeRow(f);
    const held = await holdForOrganiser({ fixtureId: f.fixtureId, reason: "double_walkover_blocked" });
    if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
    return;
  }
  pass.report.noShows++;
}

// ─── Job 2: the mint retry (M3) ────────────────────────────────────────────
//
// A create that met Lichess's 429 wall leaves the board `pending` with no
// claim and T9's marker in `last_error`:
//   create:rate_limited (<reason>) retry_at=<ISO | unknown>
// (create-game.ts noteThrottled — "recorded for the cron's mint retry, which
// is what honours retryAt"). The queue never waits a hold out; this job does:
// a board is retried only once `retry_at` has passed, and only inside its
// round's window — past T+20 no game can be made (T9's createAtDequeue
// refuses), and the board belongs to job 1 or the organiser.

const THROTTLED_MARKER = "create:rate_limited";

type RetryCandidate = { fixtureId: string; openedAt: Date; lastError: string };

async function retryCandidates(pass: Pass): Promise<RetryCandidate[]> {
  return sql<RetryCandidate[]>`
    select f.id as "fixtureId", o.opened_at as "openedAt", ep.last_error as "lastError"
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
     where ep.status = 'pending' and ep.challenge_id is null and ep.create_sent_at is null
       and ep.mint_claimed_at is null
       and ep.last_error like ${THROTTLED_MARKER + "%"}
       and f.status in ${sql(PLAYABLE_STATUSES as string[])}
       ${orgScope(pass)}
     order by o.opened_at, f.id`;
}

/** When T9's marker says the hold ends. `null` — retry now — for `unknown`
 *  (T9's spelling of a hold with no time) and for anything unreadable: a
 *  retry the queue would still refuse costs one refusal, while a marker read
 *  as "never" would strand the board. */
function throttledRetryAt(lastError: string): Date | null {
  const at = /retry_at=(\S+)$/.exec(lastError)?.[1];
  if (at === undefined || at === "unknown") return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : new Date(t);
}

async function mintRetry(pass: Pass, c: RetryCandidate, create: NonNullable<SweepDeps["createGameIfReady"]>): Promise<void> {
  // Only the deadline bounds it: a marker is written after the open, so a
  // pass can never see one before the window opened.
  if (pass.now.getTime() >= playableWindow(c.openedAt).deadline.getTime()) return;
  const retryAt = throttledRetryAt(c.lastError);
  if (retryAt !== null && pass.now.getTime() < retryAt.getTime()) return;
  pass.report.mintRetries++;
  await create(c.fixtureId, { now: pass.now });
}

// ─── Job 3: meeting teardown ───────────────────────────────────────────────
//
// A fixture has one meeting for life (fixture_video_meetings, PK fixture_id);
// T7's endMeeting kicks everyone, deactivates it, and only then stamps
// `ended_at` — so a failed deactivate leaves the row for the next pass, and
// an ended row is never a candidate again. A meeting is torn down when:
//   - the game is over: the bridge is `finished` (spec §5.2, "at the result");
//   - the board is settled: the fixture is no longer playable (withdrawn,
//     decided by hand, cancelled, held for a decision);
//   - nobody played: the round's deadline has passed and no game is, or may
//     be, on file (no challenge, no possibly-sent create). Past T+20 no game
//     can be made (T9 refuses), so the room has no further use.
// A game on file that is not finished keeps its meeting, past T+20 or not:
// "nothing in our system ends a live game early" (spec §3.6).

type TeardownCandidate = {
  fixtureId: string;
  meetingId: string;
  fixtureStatus: string;
  bridgeStatus: string | null;
  challengeId: string | null;
  createSentAt: Date | null;
  openedAt: Date | null;
};

async function teardownCandidates(pass: Pass): Promise<TeardownCandidate[]> {
  return sql<TeardownCandidate[]>`
    select m.fixture_id as "fixtureId", m.meeting_id as "meetingId", f.status as "fixtureStatus",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId", ep.create_sent_at as "createSentAt",
           o.opened_at as "openedAt"
      from fixture_video_meetings m
      join fixtures f on f.id = m.fixture_id
      left join fixture_external_play ep on ep.fixture_id = m.fixture_id
      left join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
     where m.ended_at is null
       ${orgScope(pass)}
     order by m.created_at, m.fixture_id`;
}

function meetingIsDone(pass: Pass, c: TeardownCandidate): boolean {
  if (c.bridgeStatus === "finished") return true;
  if (!isPlayableFixtureStatus(c.fixtureStatus)) return true;
  const gameOnFile = c.challengeId !== null || c.createSentAt !== null;
  return !gameOnFile && c.openedAt !== null && pass.now.getTime() >= playableWindow(c.openedAt).deadline.getTime();
}

async function teardown(pass: Pass, c: TeardownCandidate, end: NonNullable<SweepDeps["endMeeting"]>): Promise<void> {
  if (!meetingIsDone(pass, c)) return;
  await end(c.meetingId);
  pass.report.meetingsEnded++;
}

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
  clock: BoardgameClockInput | null;
};

async function reconcileCandidates(pass: Pass): Promise<ReconcileCandidate[]> {
  return sql<ReconcileCandidate[]>`
    select ep.fixture_id as "fixtureId", ep.status as "bridgeStatus", ep.challenge_id as "gameId",
           ep.started_at as "startedAt", date_trunc('milliseconds', ep.last_polled_at) as "lastPolledAt",
           ep.sweep_no_truth_reads as "noTruthReads", o.opened_at as "openedAt", d.config->'clock' as clock
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
  // Never started on our side. T9 creates no game after the round's deadline
  // and Lichess aborts one whose first move does not come, so the deadline is
  // its base; any read that brings the truth resets the count regardless.
  return c.openedAt === null ? null : expectedEndAt(playableWindow(c.openedAt).deadline, tc);
}

async function sweepReconcile(pass: Pass, c: ReconcileCandidate, read: NonNullable<SweepDeps["reconcile"]>): Promise<void> {
  if (c.lastPolledAt !== null && pass.now.getTime() - c.lastPolledAt.getTime() < reReadAfterMs(c.noTruthReads) - SWEEP_TICK_TOLERANCE_MS) {
    return;
  }
  // The claim: a compare-and-set on the read we acted on, so of two passes
  // that both saw the board due, one reads it.
  const claimed = await sql`
    update fixture_external_play set last_polled_at = ${pass.now}
     where fixture_id = ${c.fixtureId}
       and date_trunc('milliseconds', last_polled_at) is not distinct from ${c.lastPolledAt}
    returning fixture_id`;
  if (claimed.length === 0) return;
  pass.report.reconciled++;
  const end = expectedEnd(c);
  if (c.bridgeStatus === "needs_organiser") {
    try {
      await read({ fixtureId: c.fixtureId, trigger: "sweep" });
    } finally {
      await countRead(c.fixtureId);
    }
    return;
  }
  let outcome: ReconcileOutcome | null;
  try {
    outcome = await read({ fixtureId: c.fixtureId, trigger: "sweep" });
  } catch (err) {
    await noTruth(pass, c, end);
    throw err;
  }
  if (outcome === null) {
    await noTruth(pass, c, end);
    return;
  }
  // A hold reconcile placed (T12: aborted, a tie-break owed, fair play).
  if (outcome.result?.wrote === "needs_organiser" || outcome.result?.wrote === "aborted") pass.report.heldForOrganiser++;
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
  const held = await holdForOrganiser({
    fixtureId: c.fixtureId,
    reason: "provider_error",
    detail: `sweep: ${row.reads} reads of game ${c.gameId} past its expected end (${end.toISOString()}) told us nothing`,
  });
  if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
}

// ─── The pass ──────────────────────────────────────────────────────────────

export async function sweepExternalPlay(deps: SweepDeps = {}): Promise<SweepReport> {
  const report: SweepReport = {
    noShows: 0,
    mintRetries: 0,
    meetingsEnded: 0,
    reconciled: 0,
    heldForOrganiser: 0,
    scanned: 0,
    failures: [],
  };
  const pass: Pass = { now: deps.now ?? new Date(), orgIds: deps.orgIds, report };

  // FIRST: a game on file is brought to the truth before anything rules on
  // its board — a ready game aborted at ply 0 is the organiser's `aborted`,
  // never a no-show (T10 ruling), and a game it finishes is torn down below.
  const read = deps.reconcile ?? ((a) => reconcile(a.fixtureId, a.trigger, { now: pass.now }));
  await each(pass, "reconcile", await reconcileCandidates(pass), (c) => sweepReconcile(pass, c, read));
  const create = deps.createGameIfReady ?? ((id, d) => createGameIfReady(id, { now: d.now }));
  await each(pass, "mint_retry", await retryCandidates(pass), (c) => mintRetry(pass, c, create));
  await each(pass, "no_show", await noShowCandidates(pass), (c) => noShow(pass, c));
  // Last, so a game finished or a board forfeited earlier in THIS pass is
  // torn down in it.
  const end = deps.endMeeting ?? ((m) => endMeeting(m));
  await each(pass, "teardown", await teardownCandidates(pass), (c) => teardown(pass, c, end));
  return report;
}
