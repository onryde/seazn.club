import "server-only";
// The external-play sweep (chess in-page board design §3.5, §3.6, §4; Task 13).
//
// The 5-minute cron's FIVE jobs, every one of which happens when no page is
// open (spec §4):
//   1. the deadline no-show     → `core.forfeit {by, reason: "walkover"}`;
//   2. the mint retry         for a create that hit Lichess's 429 wall (M3);
//   3. meeting teardown       at the result, or at the deadline when nobody played;
//   4. the reconcile sweep    every game on file, read from the BOARD STREAM by
//                             T11's reconcile — the abandoned-board sweep and
//                             the main detector of moves made at Lichess;
//   5. the camera evidence    after an ended room, every player's peer reports
//                             → a camera_lost flag (controller ruling C1);
//   6. the arbiter removal    an organiser's watch of a board (T15) ends when
//                             their role does, or after a TTL (fix round 1, I2).
// The T-10 notice is NOT here: under D12 the organiser's open-round action
// sends the invites and stamps the window (T19).
//
// D12: the deadline (DEADLINE_AFTER_MS) is relative to the round being OPENED (`stage_round_opens.opened_at`),
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
import { RealtimeKitDeferred, type RealtimeKitDeps } from "@/server/external-play/video/realtimekit";
import { anchorOfRow, boardOpenFor, lockCheckinWindow } from "@/server/external-play/round-open";
import { liveMintClaimSince, windowFor, type BoardAnchor } from "@/server/external-play/window";
import { type CreateOutcome } from "../create-game";
import { loadOnlinePlayFixture, loadSides } from "../guard";
import { isPlayableFixtureStatus } from "../preflight";
import { type ReconcileOutcome } from "../reconcile";
import { checkIns } from "../room";

/** Every job a pass runs — the vocabulary of `failures[].job` (final re-review N-1: the suite sweeps it). */
export const SWEEP_JOBS = ["close_unplayable", "no_show", "mint_retry", "teardown", "reconcile", "camera_evidence", "arbiter_revoke"] as const;
export type SweepJob = (typeof SWEEP_JOBS)[number];

/** Final review I-1: written out LITERALLY. The cron Worker reads `data.failed` and `data.skipped` as its failure
 *  counters (R3, apps/cron-worker/src/schedule.ts), and apps/cron-worker/test/drift.test.ts finds each field's numeric
 *  declaration in this module's CODE. A counter that is not a finite number reads "unreadable" there, i.e. degraded. */
export type SweepReport = {
  /** Review M8: another pass held the lock, so this one did nothing — every
   *  count below is zero because nothing was looked at, not because nothing
   *  was due. 1 or 0, never a boolean (I-1): the monitor counts a skipped
   *  pass as a failure, since a pass that overlaps the next firing is one
   *  that ran for five minutes. */
  skipped: number;
  /** Bridges closed because their fixture is no longer playable (job 0, T16
   *  fix round 1, I1): held, pending, ready or live rows under a fixture
   *  decided on the pad, settled, withdrawn, voided or cancelled. */
  bridgesClosed: number;
  noShows: number;
  mintRetries: number;
  meetingsEnded: number;
  reconciled: number;
  heldForOrganiser: number;
  /** Ended rooms whose camera evidence was settled this pass (job 5). */
  cameraSettled: number;
  /** camera_lost flags written this pass (job 5). */
  cameraFlags: number;
  /** camera_connection_problems flags written this pass (job 5): OUR
   *  safeguard's stamps past a threshold in one match — told, never an
   *  accusation (T14 fix round 5). */
  connectionFlags: number;
  /** multiple_devices flags written this pass (job 5): a player connected
   *  from more than one place at the same time in the match (T17B fix 2,
   *  D9) — evidence, never a block. */
  deviceFlags: number;
  /** Arbiter watches ended this pass (job 6): removed at RealtimeKit and
   *  stamped, or stamped for a room already torn down. */
  arbitersRemoved: number;
  /** Candidates examined across every job — a pass that looked at nothing
   *  says so (anti-vacuity), rather than reporting four zeros. */
  scanned: number;
  /** I-1: rows of network jobs NOT started because the pass's wall-clock
   *  budget (SWEEP_PASS_BUDGET_MS), or reconcile's own slice of it
   *  (SWEEP_RECONCILE_BUDGET_MS, D20), was spent; and D20: flag-due boards
   *  read without the settling read the per-pass cap
   *  (SWEEP_SETTLING_READS_PER_PASS) left to the next pass. NOT a failure:
   *  they keep their place and the next firing reaches them. */
  deferred: number;
  /** I-1: `failures.length`, as a number the cron Worker can read. Final
   *  re-review N-1: derived ONCE, as the pass returns — never counted beside
   *  each push, which the camera give-up once missed. */
  failed: number;
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
  /** T11's reconcile (`reconcile(fixtureId, "sweep")`), on the sweep's clock. `settle` is the pass's settling-read
   *  slot (D20): reconcile asks it before a settling read, and makes none on `false`. */
  reconcile?: (a: { fixtureId: string; trigger: "sweep"; settle: () => boolean }) => Promise<ReconcileOutcome | null>;
  /** The RealtimeKit transport job 5 reads the peer reports through. */
  realtimeKit?: RealtimeKitDeps;
  /** TEST SEAM — scope every job to these orgs. Production passes none and
   *  sweeps every org; the shared test database holds other suites' opened
   *  rounds, which an unscoped sweep would act on. */
  orgIds?: readonly string[];
  /** TEST SEAM — `false` runs the pass without the one-pass-at-a-time lock
   *  (M8), so a test can overlap two passes and prove a job's own row claim
   *  on its own. Production never passes it. */
  serialise?: false;
  /** TEST SEAM — the clock the pass budget (I-1) and reconcile's slice (D20)
   *  are measured on. Production passes none and reads Date.now. */
  wallClock?: () => number;
  /** TEST SEAM — job 3b's read of the parked rooms (V460). Production reads `video_rooms_to_end`; a test passes a reader that
   *  throws to prove a broken or missing table cannot starve the jobs that run before it. */
  parkedRooms?: () => Promise<readonly ParkedRoom[]>;
};

/** Final review I-1: the pass stops STARTING network work (NETWORK_JOBS) once this much wall-clock time has gone. The
 *  cron Worker abandons a job at 60 s (JOB_TIMEOUT_MS, apps/cron-worker/src/call.ts) and records a timeout; stopping
 *  here leaves 15 s for the row in flight, the figure stream-tick's STREAM_TICK_BUDGET_MS chose for the same Worker.
 *  external-play/route.test.ts pins it below the Worker's figure. RESIDUAL, as stream-tick's: one row's worst case is
 *  not under 15 s — every Lichess and RealtimeKit request is bounded at 10 s, and a reconcile can make three in a row
 *  plus a 3 s broadcast — so a row started just inside the budget against a stalled vendor can still outlive the
 *  Worker. That reads as a Worker timeout (an error, one Sentry event an hour under R2), never as silence. T17B fix 2,
 *  D11 widens it: a board whose side to move is at zero is read again on a stream HELD ~9 s (reconcile
 *  FLAG_SETTLE_HOLD_MS, bounded at LICHESS_TIMEOUT_MS + the hold). D20 bounds that: see the two constants below. */
export const SWEEP_PASS_BUDGET_MS = 45_000;

/** D20 (review I1; spec docs/superpowers/specs/2026-10-15-chess-per-board-timers-design.md §6.1 (b)): the settling
 *  reads (reconcile's D11 held read, FLAG_SETTLE_HOLD_MS each) one pass makes. About five of them spent the whole pass
 *  inside reconcile, so every job after it — mint_retry, teardown, camera evidence, the arbiter revokes — never ran. A
 *  flag-due board past the cap is still read (its first line), counted `deferred`, placed no unsettled-flag hold (it
 *  was never given the read that settles), and keeps its place: its claim is handed back, so the next pass reads it
 *  first. A flag with a room tab open is settled within seconds by the room's own clock-zero report, whatever the
 *  sweep does. A board ALREADY held clock_flag_unsettled takes no slot: the sweep reads it with no hold (reconcile,
 *  D20 (a)). */
export const SWEEP_SETTLING_READS_PER_PASS = 2;

/** D20 (review I1; spec §6.1 (c)): reconcile's own slice of the pass budget. Reconcile stops STARTING reads once the
 *  pass has spent this much, so the jobs after it get the rest of SWEEP_PASS_BUDGET_MS — except when a row that STARTED
 *  inside the slice overruns it: with Lichess degraded one row costs up to ~30 s (the first line on two tokens plus
 *  the export, 10 s each), which can spend the whole pass and defer those jobs to the next one (review m2). The order
 *  stays — reconcile first is load-bearing (runPass). The capped settling reads fit inside it (tested). A flag backlog
 *  of D boards uses about 18 s of the slice for ceil(D / 2) passes, so ordinary reads sorted behind it wait while it
 *  drains: bounded and graceful, not a defect (review m3). */
export const SWEEP_RECONCILE_BUDGET_MS = 20_000;

/** I-1: the jobs that call Lichess or RealtimeKit, so the pass budget applies to them. Job 0 (close) and job 1 (the
 *  deadline no-show) touch only our own database, and the no-show is time-critical: a slow Lichess must never push a
 *  forfeit past its tick. */
const NETWORK_JOBS: ReadonlySet<SweepJob> = new Set<SweepJob>(["reconcile", "mint_retry", "teardown", "camera_evidence", "arbiter_revoke"]);

/** The window a board is playable in, anchored on the BOARD's batch of the round being opened (D12; spec §3.2.1). Every
 *  merged reader - T9's create, T8's seat and room, T19's invite and openRound - judges it as `roomPhase(now, anchor)`,
 *  so the deadline is window.ts's own `windowFor(anchor).deadline` (the batch's start + DEADLINE_AFTER_MS). `opensAt` is
 *  the batch's start: before it nothing exists to play. */
export function playableWindow(anchor: BoardAnchor): { opensAt: Date; deadline: Date } {
  return { opensAt: anchor.at, deadline: windowFor(anchor).deadline };
}

/** Do BOTH players' check-ins count for this board (spec §5.7.8)? The question the deadline asks once it is past: a board whose
 *  two players came is owed its create, until the board's cap, whatever kept the game from being made. */
export async function bothCameFor(fixtureId: string, anchor: BoardAnchor): Promise<{ own: boolean; both: boolean }> {
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) return { own: false, both: false };
  const { home, away } = await loadSides(f);
  const came = await checkIns(f, home, away, anchor);
  return { own: false, both: came.home && came.away };
}

/** The anchor of a sweep candidate row that carries its round's stamp, the board's rank (`boardRankSql`) and the round's
 *  stored `staggered` flag; `null` for a board whose round was never opened. */
export function candidateAnchor(c: { openedAt: Date | null; rank: number; staggered: boolean | null; extraMs: number }): BoardAnchor | null {
  return c.openedAt === null ? null : anchorOfRow({ openedAt: c.openedAt, rank: c.rank, staggered: c.staggered === true, extraMs: c.extraMs });
}

/** T8's predicate, as the SQL list the candidate queries filter on — derived,
 *  so the two can never disagree. */
export const PLAYABLE_STATUSES: readonly string[] = FIXTURE_STATUSES.filter(isPlayableFixtureStatus);

export function codeOf(err: unknown): string {
  if (err instanceof HttpError) return err.code ?? `HTTP_${err.status}`;
  if (err instanceof EngineError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.name : "UNKNOWN";
}

export type Pass = {
  now: Date;
  /** TEST SEAM made visible: the pass's `now` was handed in (`SweepDeps.now`), so a test owns the decision clock of the window
   *  judgements too. Production hands none, and those judgements read the DATABASE's clock (`anchorIfClosedNow`). */
  fixedNow: boolean;
  orgIds: readonly string[] | undefined;
  report: SweepReport;
  /** I-1: the budget's clock, read at the pass's start and before each network row. */
  clock: () => number;
  startedAt: number;
  spent: boolean;
  /** D20: the settling reads this pass has made (SWEEP_SETTLING_READS_PER_PASS). */
  settlingReads: number;
  /** D16 review G1: the boards whose stale meetings this pass has already tried to retire. The retire takes EVERY stale row of
   *  a board, so the board's second candidate must not ask the vendor again, in the same pass, for a room it just failed to end. */
  retired: Set<string>;
};

/** I-1: has the pass spent its budget — for reconcile (D20), its own slice of it? Once the pass's budget is spent it
 *  stays spent, and the clock is not read again. One look per row either way. */
function budgetSpent(pass: Pass, job: SweepJob): boolean {
  if (pass.spent) return true;
  const elapsed = pass.clock() - pass.startedAt;
  if (elapsed >= SWEEP_PASS_BUDGET_MS) pass.spent = true;
  return pass.spent || (job === "reconcile" && elapsed >= SWEEP_RECONCILE_BUDGET_MS);
}

export async function each<T extends { fixtureId: string }>(
  pass: Pass,
  job: SweepJob,
  rows: readonly T[],
  act: (row: T) => Promise<void>,
): Promise<void> {
  pass.report.scanned += rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (NETWORK_JOBS.has(job) && budgetSpent(pass, job)) {
      pass.report.deferred += rows.length - i;
      break;
    }
    try {
      await act(row);
    } catch (err) {
      // D21: the platform's RealtimeKit call budget refused a request. Nothing was made and nothing is wrong: the row keeps
      // its place and the next firing reaches it — a deferral, the report's word for exactly that (never a failure, which
      // the cron Worker pages on).
      // The budget is the account's, not the row's: every later row of this job would be refused for the same reason, and
      // asking costs a database statement each. So the rest is counted deferred with this one and the job stops (the same
      // shape as the pass budget above); the next firing starts from the top.
      if (err instanceof RealtimeKitDeferred) {
        pass.report.deferred += rows.length - i;
        log.info(
          { job, fixtureId: row.fixtureId, remaining: rows.length - i },
          "external-play sweep: RealtimeKit call budget spent; the rest of the job keeps its place",
        );
        break;
      }
      const code = codeOf(err);
      pass.report.failures.push({ job, fixtureId: row.fixtureId, code });
      // Review M7: the report stays code-only (it is returned to the cron
      // caller); the server log carries what diagnoses it — the message, and
      // the stack of anything that is not a named refusal (a TypeError is a
      // bug, and its name alone says nothing). Every message our adapters
      // build is token-free by construction (realtimekit.ts, board-api.ts).
      const named = err instanceof HttpError || err instanceof EngineError;
      log.warn(
        {
          job,
          fixtureId: row.fixtureId,
          code,
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && !named ? { stack: err.stack } : {}),
        },
        "external-play sweep: a fixture's action failed",
      );
    }
  }
}

/** An EMPTY scope matches nothing — postgres.js renders `in ()` of an empty
 *  list as `in (null)` — and is never read as "every org" (tested). */
export function orgScope(pass: Pick<Pass, "orgIds">) {
  return pass.orgIds === undefined ? sql`` : sql`and f.org_id in ${sql(pass.orgIds as string[])}`;
}
// ─── A game that is, or may be, on file (review M1, ruling I3) ─────────────
//
// ONE predicate for job 1 (never a no-show) and job 3 (keep the room), asked
// only PAST the deadline — before it neither job rules on anything, so a sent
// marker T9's next caller can still recover (findSentGame) is never judged:
//   - a challenge is recorded: a game is on file;
//   - a `pending` row under a LIVE mint claim: T9 is in flight, and its create
//     may land past the deadline (it judged the window at its claim).
// Past the deadline a sent marker (`create_sent_at`, T9 I2) under a stale (or
// no) claim is nobody's — T9 refuses on the window BEFORE it would claim and
// recover — so job 1 holds it `create_outcome_unknown` (T9's own reason for
// that state), and job 3 takes its room down. A held row with no challenge
// is no game.

export type BridgeFacts = {
  bridgeStatus: string | null;
  challengeId: string | null;
  createSentAt: Date | null;
  mintClaimedAt: Date | null;
};

function claimIsLive(pass: Pass, claimedAt: Date | null): boolean {
  return claimedAt !== null && claimedAt.getTime() >= liveMintClaimSince(pass.now).getTime();
}

export function gameMayBeOnFile(pass: Pass, r: BridgeFacts): boolean {
  if (r.challengeId !== null) return true;
  return r.bridgeStatus === "pending" && claimIsLive(pass, r.mintClaimedAt);
}

/** Spec §3.2.2: the board's anchor as it stands NOW, with the clock the judgement was made on, read under the board's check-in-window
 *  lock - or `null` when the board's deadline has NOT passed on that clock. The candidate query read the board's extension some time
 *  ago; an arbiter's +5 minutes committed since (or in flight at this moment - the lock waits for it) moves the deadline, and a
 *  destructive judgement - a walkover, ending the players' rooms - on the candidate's stale anchor would undo it. Holds the lock
 *  only for the read: an extension arriving after it reads its own clock after taking the lock, and that clock is not before
 *  this one, so it finds the deadline passed and is refused (checkin-extend.ts) - it cannot move the deadline back under a
 *  judgement already made. THE CLOCK is the database's (`clock_timestamp()`, read after the lock - the extension reads the same
 *  one the same way): a machine clock that runs ahead of it would otherwise find the deadline passed while the extension, on the
 *  database's clock, still found it open and extended it - a walkover over a board that had just been given more time. A pass
 *  that was handed its clock (a test's) judges on that. */
export async function anchorIfClosedNow(pass: Pass, fixtureId: string): Promise<{ anchor: BoardAnchor; now: Date } | null> {
  return sql.begin(async (tx) => {
    await lockCheckinWindow(tx, fixtureId);
    const open = await boardOpenFor(tx, fixtureId);
    if (open === null) return null;
    const now = pass.fixedNow ? pass.now : (await tx<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now;
    return now.getTime() < playableWindow(open.anchor).deadline.getTime() ? null : { anchor: open.anchor, now };
  });
}

export type ParkedRoom = { fixtureId: string; side: string; meetingId: string };
