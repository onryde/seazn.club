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
import { EngineError, playRecorded } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { log } from "@/server/logger";
import type { CameraPolicy } from "@/lib/camera-policy";
import { fixtureCameraPolicyAt } from "@/server/external-play/camera-policy";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { assertTimeControl, estimatedSeconds, type TimeControl } from "@/server/external-play/time-controls";
import { concurrentConnections, matchCameraOff, type CompleteCoverage } from "@/server/external-play/video/match-camera-off";
import { cameraMatchWindow, matchGuardFaults } from "@/server/external-play/video/match-window";
import {
  RealtimeKitDeferred,
  RealtimeKitError,
  endMeeting,
  fetchVideoOffCoverage,
  listMeetingSessions,
  listPeerIds,
  removeParticipant,
  retireStaleMeeting,
  gameEvidenceOn,
  type RealtimeKitDeps,
} from "@/server/external-play/video/realtimekit";
import { EDITOR_ROLES } from "@/lib/types";
import { liveMintClaimSince, windowFor } from "@/server/external-play/window";
import { getFixtureState, listEvents } from "../fixtures";
import { scoreEvent } from "../scoring";
import { mintOrgOwnerAuth } from "./auth";
import { createGameIfReady, type CreateOutcome } from "./create-game";
import { ensureBridgeRow, loadOnlinePlayFixture, loadSides, onlinePlayBoardWhere, whiteSideOf, type OnlinePlayFixture } from "./guard";
import { isPlayableFixtureStatus } from "./preflight";
import { RECONCILED_WHILE_HELD, reconcile, type ReconcileOutcome } from "./reconcile";
import { closeBridgeIfUnplayable } from "./bridge-close";
import { holdForOrganiser, holdRefusedNoShow } from "./result";
import { checkIns } from "./room";
import { isSeatedOn } from "./seated";

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

type Pass = {
  now: Date;
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

async function each<T extends { fixtureId: string }>(
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
function orgScope(pass: Pick<Pass, "orgIds">) {
  return pass.orgIds === undefined ? sql`` : sql`and f.org_id in ${sql(pass.orgIds as string[])}`;
}

// ─── Job 0: a fixture no longer playable closes its bridge (T16 fix round 1, I1)
//
// A fixture decided on the scoring pad, settled, walked over or voided by a
// withdrawal, or cancelled ends our interest in its online game, whatever its
// bridge row reads. Reconcile closed only the ready/live rows it was handed,
// and job 4 hands it no HELD row of such a fixture, so a held board under a
// decided fixture was orphaned: out of the queue (which lists playable
// fixtures only), and "needs the organiser" on the public page for ever. Every
// non-finished row of an unplayable fixture is closed here, every tick — which
// also heals a settle that wrote its result and crashed before its close
// (review M2). First, so no later job acts on a board that is over.

async function unplayableCandidates(pass: Pass): Promise<{ fixtureId: string }[]> {
  return sql<{ fixtureId: string }[]>`
    select ep.fixture_id as "fixtureId"
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
     where ep.status <> 'finished'
       and f.status not in ${sql(PLAYABLE_STATUSES as string[])}
       ${orgScope(pass)}
     order by ep.fixture_id`;
}

async function closeUnplayable(pass: Pass, c: { fixtureId: string }): Promise<void> {
  if (await closeBridgeIfUnplayable(c.fixtureId, pass.now)) pass.report.bridgesClosed++;
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

type BridgeFacts = {
  bridgeStatus: string | null;
  challengeId: string | null;
  createSentAt: Date | null;
  mintClaimedAt: Date | null;
};

function claimIsLive(pass: Pass, claimedAt: Date | null): boolean {
  return claimedAt !== null && claimedAt.getTime() >= liveMintClaimSince(pass.now).getTime();
}

function gameMayBeOnFile(pass: Pass, r: BridgeFacts): boolean {
  if (r.challengeId !== null) return true;
  return r.bridgeStatus === "pending" && claimIsLive(pass, r.mintClaimedAt);
}

// ─── Job 1: the deadline no-show ───────────────────────────────────────────────
//
// A board is a no-show candidate only when its round was OPENED (inner join),
// the fixture is still playable (T8's predicate — never needs_decision, never a
// withdrawn or settled board), and no game is — or may be — on file (above):
// no bridge row, or a `pending` one with no challenge. The window is then
// judged per board, and the guard loads it. A sent create past the deadline
// is held for the organiser (I3), never ruled a no-show: a game may exist.

/** The sweep's no-show forfeit's idempotency key, per fixture. */
const NO_SHOW_KEY_PREFIX = "extplay-noshow:";

type NoShowCandidate = BridgeFacts & { fixtureId: string; openedAt: Date };

async function noShowCandidates(pass: Pass): Promise<NoShowCandidate[]> {
  // Millisecond stamps, as a JS Date holds them, so the I3 takeover compares
  // like with like whatever precision a writer used.
  return sql<NoShowCandidate[]>`
    select f.id as "fixtureId", o.opened_at as "openedAt",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId",
           date_trunc('milliseconds', ep.create_sent_at) as "createSentAt",
           date_trunc('milliseconds', ep.mint_claimed_at) as "mintClaimedAt"
      from fixtures f
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.status in ${sql(PLAYABLE_STATUSES as string[])}
       and (ep.fixture_id is null or (ep.status = 'pending' and ep.challenge_id is null))
       -- Review M3: the sweep's own no-show is in the ledger (or was, and an
       -- organiser voided it): never asked for again.
       and not exists (select 1 from score_events se
                        where se.fixture_id = f.id and se.idempotency_key = ${NO_SHOW_KEY_PREFIX} || f.id::text)
       ${orgScope(pass)}
     order by o.opened_at, f.id`;
}

async function noShow(pass: Pass, c: NoShowCandidate): Promise<void> {
  const { deadline } = playableWindow(c.openedAt);
  if (pass.now.getTime() < deadline.getTime()) return;
  if (gameMayBeOnFile(pass, c)) return;
  // THE guard (spec §6): online play still on, a boardgame, both entrants.
  // An organiser who switched online play off after the open has taken the
  // board back to the table.
  const f = await loadOnlinePlayFixture(c.fixtureId);
  if (!f) return;
  if (c.createSentAt !== null) {
    await holdUnknownCreate(pass, c, deadline);
    return;
  }
  const { home, away } = await loadSides(f);
  const came = await checkIns(f, home, away, c.openedAt);
  if (came.home && came.away) {
    // Controller ruling C2 (spec §3.2; §9's deadlineReason): both players
    // came and no game was made — a create Lichess throttled to the end, or
    // one that never landed. Not a no-show, and not a board to leave silent:
    // a stuck board blocks the next round. The organiser's, as not_started.
    await ensureBridgeRow(f);
    const held = await holdForOrganiser({
      fixtureId: f.fixtureId,
      reason: "not_started",
      detail: `sweep: both players checked in, no game was made by the deadline (${playableWindow(c.openedAt).deadline.toISOString()})`,
    });
    if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
    return;
  }
  const by = !came.home && !came.away ? "both" : !came.home ? f.homeEntrantId : f.awayEntrantId;
  const auth = await mintOrgOwnerAuth(f.orgId);
  const state = await getFixtureState(auth, f.fixtureId);
  // RB3 (controller ruling 2026-10-13): never a walkover over a Start. W2b admits a chess walkover after the Start
  // (ruling 118: the Start is play), so the engine would take it — the sweep must not ask. The board is left open,
  // the arbiter's. Read AFTER the seq the forfeit is written at: a Start landing in between is seen here, and one
  // landing after makes the write SEQ_CONFLICT — refused, never a walkover over it.
  const ledger = await listEvents(auth, f.fixtureId, 0);
  if (playRecorded(ledger.map((e) => ({ id: e.id, type: e.type, voids: e.voids_event_id })), boardgame)) {
    // Rebase review M-1: not silent. A Start with a player absent at the deadline (an organiser who tapped Start on
    // the pad before anyone came) would otherwise read live for ever with nobody playing. Held ONCE for the
    // organiser as the no-show it is — the hold takes the board out of this job's candidates — and counted.
    await ensureBridgeRow(f);
    const held = await holdRefusedNoShow({
      fixtureId: f.fixtureId,
      absent: await absentColour(f, by),
      detail: "sweep: absent at the deadline, but play is recorded (a Start on the ledger) — never walked over",
    });
    if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
    return;
  }
  try {
    await scoreEvent(auth, f.fixtureId, {
      expected_seq: state.last_seq,
      type: "core.forfeit",
      payload: { by, reason: "walkover" },
      idempotency_key: `${NO_SHOW_KEY_PREFIX}${f.fixtureId}`,
    });
  } catch (err) {
    // T12's hold needs a row to hold; a board the open never attached has none.
    await ensureBridgeRow(f);
    // W2b D19 (append-event.ts assertW2bWriteGuards; packages/engine
    // core/errors.ts DOUBLE_WALKOVER_NO_NEXT_MATCH): a double walkover on a
    // bracket line that feeds no next match (a final, a last rung, a
    // third-place match) has nowhere for "nobody advances" to go, and is
    // refused. An expected outcome, not an error: the board stays open and
    // goes to the organiser's queue (RB2). Read by CODE, never the message.
    if (by === "both" && err instanceof EngineError && err.code === "DOUBLE_WALKOVER_NO_NEXT_MATCH") {
      const held = await holdForOrganiser({ fixtureId: f.fixtureId, reason: "double_walkover_blocked" });
      if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
      return;
    }
    await refusedNoShow(pass, f, by, err);
    return;
  }
  pass.report.noShows++;
}

/** Review M3: any other refusal of the forfeit is a failure — the board is
 *  re-examined next pass — until the SAME refusal has come back
 *  NO_SHOW_REFUSALS_BEFORE_HOLD passes running: then it is persistent, and
 *  the board goes to the organiser as the no-show it is instead of failing
 *  every 5 minutes for ever. Counted on the bridge's `last_error` (a
 *  different refusal restarts it); the hold replaces the marker. */
export const NO_SHOW_REFUSALS_BEFORE_HOLD = 3;
const NO_SHOW_REFUSED_MARKER = "noshow:refused:";

/** The colour (or both) a no-show's `by` names — the RECORDED colours (a pairing card may put Black on home). */
async function absentColour(f: OnlinePlayFixture, by: string): Promise<"white" | "black" | "both"> {
  if (by === "both") return "both";
  return (by === f.homeEntrantId ? "home" : "away") === (await whiteSideOf(f)) ? "white" : "black";
}

async function refusedNoShow(pass: Pass, f: OnlinePlayFixture, by: string, err: unknown): Promise<void> {
  const code = codeOf(err);
  const prefix = `${NO_SHOW_REFUSED_MARKER}${code} n=`;
  const [row] = await sql<{ n: number }[]>`
    update fixture_external_play
       set last_error = ${prefix} || (case when starts_with(coalesce(last_error, ''), ${prefix})
                                           then coalesce(substring(last_error from length(${prefix}) + 1)::int, 0)
                                           else 0 end + 1)::text,
           updated_at = now()
     where fixture_id = ${f.fixtureId} and status = 'pending' and challenge_id is null
    returning substring(last_error from length(${prefix}) + 1)::int as n`;
  if (!row || row.n < NO_SHOW_REFUSALS_BEFORE_HOLD) throw err;
  const held = await holdRefusedNoShow({
    fixtureId: f.fixtureId,
    absent: await absentColour(f, by),
    detail: `sweep: the no-show forfeit was refused ${row.n} passes running (${code})`,
  });
  if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
}

/** Ruling I3: a create T9 sent and never recorded, past the deadline. T9's
 *  claim is taken over FIRST, conditionally on the very row judged: a record
 *  T9 lands meanwhile (a ready game) wins and nothing is held, and so does a
 *  release that PROVED nothing exists (a 429 clears the marker — then it is
 *  a board with no game, the next pass's no-show or not_started). After the
 *  takeover no T9 write can land (each is conditional on its own claim) and
 *  no new claim can be taken (T9 refuses past the deadline before claiming). */
async function holdUnknownCreate(pass: Pass, c: NoShowCandidate, deadline: Date): Promise<void> {
  // The CAS is the claim alone, T9's own discipline: every T9 write (record,
  // hold, release) is conditional on its claim and clears it, so a claim we
  // saw still standing means nothing of T9's landed — and a claim we saw
  // null means nothing of T9's can (it holds no claim, and takes none past
  // the deadline). A status or marker condition here would be one no write
  // can reach without moving the claim first.
  const taken = await sql`
    update fixture_external_play set mint_claimed_at = null, updated_at = now()
     where fixture_id = ${c.fixtureId}
       and date_trunc('milliseconds', mint_claimed_at) is not distinct from ${c.mintClaimedAt}
    returning fixture_id`;
  if (taken.length === 0) return;
  const held = await holdForOrganiser({
    fixtureId: c.fixtureId,
    reason: "create_outcome_unknown",
    detail:
      `sweep: a create was sent at ${c.createSentAt!.toISOString()} and never recorded; ` +
      `past the deadline (${deadline.toISOString()}) nothing can recover it`,
  });
  if (held.wrote === "needs_organiser") pass.report.heldForOrganiser++;
}

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
 *  CLAIMED is excluded by its own live claim, not by this wait. What the wait covers is only the stretch before the claim,
 *  the seats' re-verify. Two creates racing past it are still safe: the claim is one statement and the loser is `lost`. */
export const STRANDED_CREATE_AFTER_MS = 10_000;

type RetryCandidate = { fixtureId: string; openedAt: Date; lastError: string | null };

async function retryCandidates(pass: Pick<Pass, "now" | "orgIds">): Promise<RetryCandidate[]> {
  const gracedBefore = new Date(pass.now.getTime() - STRANDED_CREATE_AFTER_MS);
  return sql<RetryCandidate[]>`
    select f.id as "fixtureId", o.opened_at as "openedAt", ep.last_error as "lastError"
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

async function mintRetry(pass: Pass, c: RetryCandidate, create: NonNullable<SweepDeps["createGameIfReady"]>): Promise<void> {
  // Only the deadline bounds it: a marker is written after the open, so a
  // pass can never see one before the window opened.
  if (pass.now.getTime() >= playableWindow(c.openedAt).deadline.getTime()) return;
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
    const came = await checkIns(f, home, away, c.openedAt);
    if (!(came.home && came.away)) return;
  }
  pass.report.mintRetries++;
  await create(c.fixtureId, { now: pass.now });
}

// ─── Job 3: meeting teardown ───────────────────────────────────────────────
//
// A player has one meeting for life (fixture_video_meetings, PK (fixture_id, side) -
// D16: a board has one per player, and each row is its own candidate, retried on its own);
// T7's endMeeting kicks everyone, deactivates it, and only then stamps
// `ended_at` — so a failed deactivate leaves the row for the next pass, and
// an ended row is never a candidate again. A meeting is torn down when:
//   - the game is over: the bridge is `finished` (spec §5.2, "at the result");
//   - the board is settled: the fixture is no longer playable (withdrawn,
//     decided by hand, cancelled, held for a decision);
//   - nobody played: the round's deadline has passed and no game is, or may
//     be, on file (gameMayBeOnFile — the predicate job 1 waits on). Past DEADLINE_AFTER_MS
//     no game can be made (T9 refuses), so the room has no further use.
//   - it is STALE: made for another pairing than the board's current one, with
//     no game behind it (D16 review G1). The claim that finds one ends the room
//     at the vendor first and deletes its row only after the end succeeded
//     (retireStaleMeeting), so a refused end (a failure, or the call budget)
//     leaves the row; this is the pass that asks again, whatever the round's
//     window says - an old pair's tokens must not stay live in an ACTIVE room
//     until the deadline just because no new claim came.
// A game on file that is not finished keeps its meeting, past the deadline or not:
// "nothing in our system ends a live game early" (spec §3.6).

type TeardownCandidate = BridgeFacts & {
  fixtureId: string;
  side: "home" | "away";
  meetingId: string;
  fixtureStatus: string;
  openedAt: Date | null;
  /** Made for another pairing than the fixture's CURRENT one, with no game behind it: the retire's own judgement (gameEvidenceOn).
   *  Only on a board that HAS a pairing: an unpaired board's rooms are left to the window rules below (ended at the deadline,
   *  stamped), as before - an organiser who unpairs and re-pairs the same players a minute later keeps their rooms. */
  retirable: boolean;
};

async function teardownCandidates(pass: Pass): Promise<TeardownCandidate[]> {
  return sql<TeardownCandidate[]>`
    select m.fixture_id as "fixtureId", m.side, m.meeting_id as "meetingId", f.status as "fixtureStatus",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId", ep.create_sent_at as "createSentAt",
           ep.mint_claimed_at as "mintClaimedAt", o.opened_at as "openedAt",
           (f.home_entrant_id is not null and f.away_entrant_id is not null
            and (m.home_entrant_id, m.away_entrant_id) is distinct from (f.home_entrant_id, f.away_entrant_id)
            and not coalesce(${gameEvidenceOn(pass.now)}, false)) as "retirable"
      from fixture_video_meetings m
      join fixtures f on f.id = m.fixture_id
      left join fixture_external_play ep on ep.fixture_id = m.fixture_id
      left join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
     where m.ended_at is null
       ${orgScope(pass)}
     order by m.created_at, m.fixture_id, m.side`;
}

function meetingIsDone(pass: Pass, c: TeardownCandidate): boolean {
  if (c.bridgeStatus === "finished") return true;
  if (!isPlayableFixtureStatus(c.fixtureStatus)) return true;
  if (c.openedAt === null) return false;
  const { deadline } = playableWindow(c.openedAt);
  return pass.now.getTime() >= deadline.getTime() && !gameMayBeOnFile(pass, c);
}

async function teardown(pass: Pass, c: TeardownCandidate, end: NonNullable<SweepDeps["endMeeting"]>): Promise<void> {
  if (c.retirable) {
    // The claim's own retire, with the sweep's teardown: it takes EVERY stale row of the board (both players'), so the other
    // side's candidate, reached next, has nothing left to do (and a room that just refused is not asked again in this pass).
    // Counted per room actually ended; a refusal is thrown (a deferral by `each` as one, anything else as a failure) after
    // the other row has had its turn.
    if (pass.retired.has(c.fixtureId)) return;
    pass.retired.add(c.fixtureId);
    await retireStaleMeeting(c.fixtureId, pass.now, async (id) => {
      await end(id);
      pass.report.meetingsEnded++;
    });
    return;
  }
  if (!meetingIsDone(pass, c)) return;
  await end(c.meetingId);
  pass.report.meetingsEnded++;
}

// Job 3b: a room whose meeting row went with its fixture (D16 fix-2, review residual 2; V460).
//
// A meeting row is the only thing that tracks an ACTIVE vendor room, and it cascades away with its fixture (a stage deleted,
// Rebuild fixtures, a Swiss round reshaped to a smaller field, the undo of a generation, or anything wider). V460's trigger
// parks each un-ended room in `video_rooms_to_end` in the deleting transaction; this ends it at the vendor and clears the
// parking only AFTER the end succeeded, so a refused end (a failure, or the call budget) keeps its row and the next pass asks
// again - the same "the row outlives the room" rule retireStaleMeeting keeps. Why the sweep and not the deleting call: a
// vendor call cannot sit in the transaction that deletes, and the four writes run under the tenant role, which cannot read
// the sealed meetings table to collect the rooms first. The cost is latency, up to one sweep tick (the cron fires every five minutes, apps/cron-worker/src/schedule.ts) -
// the rooms are of boards that no longer exist, so nobody is waiting on them - and calls: kick-all and the INACTIVE patch,
// two per parked room, through the same budget (D21) as every other teardown. A room RealtimeKit itself says is not there
// (its documented not-found) is already gone: its parking is cleared without a count.
// It runs LAST in the pass (D16 fix-3): its candidate read is outside `each`, so a table that is missing or broken makes the pass throw
// (loudly, on purpose), and nothing may sit after it that it could starve.

export type ParkedRoom = { fixtureId: string; side: string; meetingId: string };

async function parkedRoomCandidates(pass: Pass): Promise<ParkedRoom[]> {
  const scope = pass.orgIds === undefined ? sql`` : sql`and r.org_id in ${sql(pass.orgIds as string[])}`;
  return sql<ParkedRoom[]>`
    select r.fixture_id as "fixtureId", r.side, r.meeting_id as "meetingId"
      from video_rooms_to_end r
     where true ${scope}
     order by r.created_at, r.meeting_id`;
}

async function endParkedRoom(pass: Pass, c: ParkedRoom, end: NonNullable<SweepDeps["endMeeting"]>): Promise<void> {
  let ended = true;
  try {
    await end(c.meetingId);
  } catch (err) {
    if (!(err instanceof RealtimeKitError && err.code === "not_found")) throw err;
    ended = false;
  }
  await sql`delete from video_rooms_to_end where meeting_id = ${c.meetingId}`;
  if (ended) pass.report.meetingsEnded++;
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

// ─── Job 5: the camera evidence after the match (controller ruling C1) ─────
//
// Design §5.2: the peer report is SDK telemetry, frozen while the player is
// in the room and final ~70 s after they leave — so it is read once, at
// least 2 minutes after the room ended (T7's endMeeting kicks everyone, so
// every player has left by `ended_at`), retrying while any report is not
// final. Every session of the meeting (a rejoin opens a new one) and every
// peer of each (a reload is a new one) is unioned per player over the MATCH
// — the first move to the GAME's end — by matchCameraOff.
//
// The game's end, never the room's (ruling I1): the room stays up while the
// organiser holds a board (job 3), so after a tie-break owed, an abort or a
// mid-game hold its end can be hours after the game's, and every minute in
// between would read as both cameras off. The best evidence, in order: the
// bridge's close (`finished_at`), else the first read that saw the game over
// (`game_over_at`, held or not), else the latest the clock let the game run
// (the last move plus the side to move's remaining time). None known: not
// ready. Never past the room's own end — nobody is on camera in a closed room.
// An organiser's video override (D11) ends the window at the press (T15 fix
// round 1, M1, an owner call): video was expected until then, so what came
// before is still judged; a press before the first move leaves no match to
// evidence. The window is match-window.ts's cameraMatchWindow — the arbiter
// panel reads the same one.
//
// Under Required only — the policy in force when the match began (review M4;
// D9 lets it be relaxed later, audited): Off and Optional store nothing and
// ask RealtimeKit nothing. Evidence for the organiser, NEVER a
// sanction (D10): a fixture_play_flags row, and nothing else moves.
//
// The union can be masked (T17B fix 2, D9 — measured live, JTcfKXow): a
// player who plays from a camera-less tab while a second tab of theirs has
// its camera on shows no camera off. So the same reports are read once more
// for overlap: a player with MORE THAN ONE connection at the same time inside
// the match is a `multiple_devices` flag (V455) naming when and how many —
// flagged, never blocked. A reload is sequential, never "at once".
//
// One settle per room: `camera_evidence_at` is stamped, conditionally on
// null, in the SAME transaction as the flags — a re-run, or a pass racing
// this one, writes no second flag (V454). A room whose reports never become
// readable is settled after a day with no flag and REPORTED, never re-read
// forever.

export const CAMERA_EVIDENCE_AFTER_MS = 2 * 60_000;
export const CAMERA_EVIDENCE_GIVE_UP_MS = 24 * 60 * 60_000;

type CameraCandidate = {
  fixtureId: string;
  /** D16: the candidate is ONE player's meeting; only that player's camera is judged from it (§5.6.6). */
  side: "home" | "away";
  orgId: string;
  homeEntrantId: string;
  awayEntrantId: string;
  meetingId: string;
  endedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  gameOverAt: Date | null;
  lastMoveAt: Date | null;
  moveCount: number | null;
  whiteMs: number | null;
  blackMs: number | null;
  overrideAt: Date | null;
};

async function cameraCandidates(pass: Pass): Promise<CameraCandidate[]> {
  const readable = new Date(pass.now.getTime() - CAMERA_EVIDENCE_AFTER_MS);
  return sql<CameraCandidate[]>`
    select m.fixture_id as "fixtureId", m.side, m.org_id as "orgId", m.meeting_id as "meetingId",
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId",
           m.ended_at as "endedAt", ep.started_at as "startedAt", ep.finished_at as "finishedAt",
           ep.game_over_at as "gameOverAt", ep.last_move_at as "lastMoveAt", ep.move_count as "moveCount",
           ep.white_ms as "whiteMs", ep.black_ms as "blackMs",
           ep.video_override_at as "overrideAt"
      from fixture_video_meetings m
      join fixtures f on f.id = m.fixture_id
      left join fixture_external_play ep on ep.fixture_id = m.fixture_id
     where m.ended_at is not null
       and m.camera_evidence_at is null
       and m.ended_at <= ${readable}
       ${orgScope(pass)}
     order by m.ended_at, m.fixture_id, m.side`;
}

type CameraFlag = { kind: "camera_lost" | "camera_connection_problems" | "multiple_devices"; personId: string; note: string };

/** The camera of the player whose meeting this is (D16: one player per meeting), over the window, or `not_ready` while
 *  any session is live or any report is not final. A RealtimeKit failure THROWS. */
async function readCameraEvidence(
  c: CameraCandidate,
  window: { from: Date; to: Date },
  rtk: RealtimeKitDeps,
): Promise<CameraFlag[] | "not_ready"> {
  // The players are the guard's (review M2): each side's ONE member with a
  // user account (loadSides) — never every entrant member, so a club
  // volunteer on the roster is never "off camera all match". A side the guard
  // cannot name one player for (a roster edited after the match) is judged
  // for nobody: evidence about the wrong person is worse than none. Their
  // cameras are the player participants T8 added; a player with none had no
  // camera in the match.
  // D16 (§5.6.6): this meeting holds ONE player - its side's - so only that player is judged from it. Judging both sides'
  // players over one meeting is the shared-room reading; over a per-player room the other side's player has no
  // participant here and would read as "no camera all match".
  const sides = await loadSides(c);
  const players = new Map<string, string[]>();
  const side = c.side === "home" ? sides.home : sides.away;
  if (side.personId === null) {
    log.warn({ fixtureId: c.fixtureId, side: side.side }, "external-play sweep: no single player on a side; its camera is not judged");
  } else {
    const parts = await sql<{ participantId: string }[]>`
      select participant_id as "participantId" from fixture_video_participants
       where fixture_id = ${c.fixtureId} and side = ${c.side} and person_id = ${side.personId} and preset = 'player'
       order by participant_id`;
    players.set(side.personId, parts.map((r) => r.participantId));
  }

  const from = window.from.getTime();
  const to = window.to.getTime();
  const sessions = (await listMeetingSessions(c.meetingId, rtk)).filter(
    (s) => Date.parse(s.startedAt) < to && (s.endedAt === null || Date.parse(s.endedAt) > from),
  );
  if (sessions.some((s) => s.status === "LIVE")) return "not_ready";
  // Ruling I2: an unreadable answer is never the negative one. A match was
  // played — both players seated on a LIVE publisher (T8) — so a list with
  // no session over it is a list not ready (lag, a filter, a time range),
  // never "both cameras off all match".
  if (sessions.length === 0) return "not_ready";

  const flags: CameraFlag[] = [];
  for (const [personId, participantIds] of players) {
    const reports: CompleteCoverage[] = [];
    let peers = 0;
    for (const participantId of participantIds) {
      for (const s of sessions) {
        for (const peer of await listPeerIds(s.id, participantId, rtk)) {
          peers++;
          const coverage = await fetchVideoOffCoverage(peer, rtk);
          if (coverage.incomplete) return "not_ready";
          reports.push(coverage);
        }
      }
    }
    // …and a SEATED player (a camera participant) whom no session shows
    // contradicts our own record the same way. A player with no camera
    // participant at all, absent from sessions that WERE read, is evidence.
    if (participantIds.length > 0 && peers === 0) return "not_ready";
    // OUR safeguard's gaps are never the player's (T14 re-review 3, I-1): a
    // stamped interval counts as covered; one still open runs to the
    // window's end — the re-join never landed, and that is ours too. One
    // opened after the window (the room outlives the game) covers nothing.
    // …but a stamp is the player's browser's own claim, so it excuses and
    // never HIDES (fix round 5, ruling 1): many or long stamps in one match
    // are TOLD to the organiser — a neutral flag, never camera_lost. Its note
    // leads with the stamped total in whole seconds (T16's {duration}). The
    // arbiter panel shows the same total from the same function (I1).
    const { faults, stamped } = await matchGuardFaults(sql, { fixtureId: c.fixtureId, side: c.side, personId, window });
    if (stamped.flag) {
      flags.push({
        kind: "camera_connection_problems",
        personId,
        note:
          `${Math.round(stamped.seconds)} s stamped as our side's camera connection problems, ` +
          `${stamped.stamps} stamp${stamped.stamps === 1 ? "" : "s"} in the match: ` +
          `${stamped.intervals.map((iv) => `${iv.from} to ${iv.to}`).join("; ") || "no time inside it"}; camera required`,
      });
    }
    // D9: more than one connection at once is told, whatever the union says.
    // Its note leads with the count and the overlap's total (arbiter-view.ts
    // parseMultipleDevicesNote reads it back).
    const together = concurrentConnections(window, reports);
    if (together.intervals.length > 0) {
      flags.push({
        kind: "multiple_devices",
        personId,
        note:
          `${together.devices} camera connections at once for ${Math.round(together.seconds)} s in the match: ` +
          `${together.intervals.map((iv) => `${iv.from} to ${iv.to}`).join("; ")}; camera required`,
      });
    }
    const off = matchCameraOff(window, reports, faults);
    if (off.offIntervals.length === 0) continue;
    const intervals = off.offIntervals
      .map((iv) => `${iv.from} to ${iv.to}${iv.confirmedByEvents ? " (its own off/on events agree)" : ""}`)
      .join("; ");
    const connections = `${off.connections} camera connection${off.connections === 1 ? "" : "s"}`;
    flags.push({
      kind: "camera_lost",
      personId,
      note:
        `camera off ${Math.round(off.offSeconds)} s of ${Math.round(off.windowSeconds)} s in the match: ${intervals}; ` +
        `from ${connections} over ${sessions.length} session${sessions.length === 1 ? "" : "s"}; camera required`,
    });
  }
  return flags;
}

async function settleCamera(pass: Pass, c: CameraCandidate, flags: readonly CameraFlag[]): Promise<void> {
  const written = await sql.begin(async (tx) => {
    const claimed = await tx`
      update fixture_video_meetings set camera_evidence_at = ${pass.now}
       where fixture_id = ${c.fixtureId} and side = ${c.side} and camera_evidence_at is null
       returning fixture_id`;
    if (claimed.length === 0) return null; // another pass settled it first
    for (const f of flags) {
      await tx`
        insert into fixture_play_flags (fixture_id, org_id, kind, person_id, note)
        values (${c.fixtureId}, ${c.orgId}, ${f.kind}, ${f.personId}, ${f.note})`;
    }
    return flags;
  });
  if (written === null) return;
  pass.report.cameraSettled++;
  pass.report.cameraFlags += written.filter((f) => f.kind === "camera_lost").length;
  pass.report.connectionFlags += written.filter((f) => f.kind === "camera_connection_problems").length;
  pass.report.deviceFlags += written.filter((f) => f.kind === "multiple_devices").length;
}

async function cameraEvidence(pass: Pass, c: CameraCandidate, rtk: RealtimeKitDeps): Promise<void> {
  // No first move, or an override pressed before it: no match to evidence.
  const window = cameraMatchWindow({ ...c, meetingEndedAt: c.endedAt });
  if (c.startedAt === null || window.kind === "no_match") {
    await settleCamera(pass, c, []);
    return;
  }
  const givenUp = pass.now.getTime() - c.endedAt.getTime() > CAMERA_EVIDENCE_GIVE_UP_MS;
  // The policy IN FORCE when the match began (review M4), never the current
  // one. An audit row nobody can read (CAMERA_POLICY_AUDIT_UNREADABLE) is
  // one more answer not ready (re-review N2): a failure, read again, until
  // the same day's give-up — then settled with no flag, never failed for ever.
  let policy: CameraPolicy;
  try {
    policy = await fixtureCameraPolicyAt(c.fixtureId, c.startedAt);
  } catch (err) {
    if (!givenUp) throw err; // reported by `each`; read again next pass
    await giveUpUnread(pass, c, err);
    return;
  }
  if (policy !== "required") {
    await settleCamera(pass, c, []);
    return;
  }
  let read: CameraFlag[] | "not_ready";
  if (window.kind === "no_end") {
    // No end on file: no window to judge, so nothing is read.
    read = "not_ready";
  } else {
    try {
      read = await readCameraEvidence(c, window, rtk);
    } catch (err) {
      // A day on, an unreadable answer gives up (below) — but a read the call budget REFUSED was never made, and says
      // nothing about the match (D21): it is `each`'s deferral, whatever the day.
      if (!givenUp || err instanceof RealtimeKitDeferred) throw err; // reported by `each`; read again next pass
      read = "not_ready";
    }
  }
  if (read !== "not_ready") {
    await settleCamera(pass, c, read);
    return;
  }
  if (!givenUp) return;
  await giveUpUnread(pass, c);
}

/** A day on and still nothing readable: settled with NO flag, and said so —
 *  the report's code, the log's cause when one is known. */
async function giveUpUnread(pass: Pass, c: CameraCandidate, cause?: unknown): Promise<void> {
  await settleCamera(pass, c, []);
  const code = "CAMERA_EVIDENCE_UNREAD";
  pass.report.failures.push({ job: "camera_evidence", fixtureId: c.fixtureId, code });
  log.error(
    {
      fixtureId: c.fixtureId,
      code,
      ...(cause === undefined
        ? {}
        : { cause: codeOf(cause), message: cause instanceof Error ? cause.message : String(cause) }),
    },
    "external-play sweep: camera evidence never became readable; settled with no flag",
  );
}

// ─── The pass ──────────────────────────────────────────────────────────────

// Review M8 (controller ruling): one pass at a time. Under a Lichess outage a
// pass can outlast the 5-minute cadence (job 4 reads serially), and an
// overlapping pass would repeat every claimless job's RealtimeKit and Lichess
// calls. A NON-BLOCKING, TRANSACTION-scoped advisory lock: the pass runs
// inside the transaction that holds it, so it is released however the pass
// ends — commit, a throw, a dropped connection — and a transaction-mode
// pooler cannot strand it on a backend the way a session lock can (the
// reason event-import retired its session lock). The transaction only holds
// the lock: every job's own statements run on their own connections, so it
// sits idle, holding no snapshot. A pass that finds the lock taken returns
// at once, `skipped`. The jobs' row claims stay: they are what makes an
// overlap harmless, the lock is what makes it rare.
const SWEEP_LOCK = "external-play-sweep";

// ─── Job 6: the arbiter watches the server removes (T15 fix round 1, I2) ───
//
// An organiser's watch of a board is a RealtimeKit participant whose token
// lasts 100 days. The panel removes it when it closes (leaveAsArbiter), but
// a browser that crashes or loses the network never says so — and a role can
// be taken away mid-watch. So every pass looks at every watch not yet
// removed, and ends one when:
//   - its user is gone (the account deleted: ON DELETE SET NULL, M5);
//   - its user is no longer an owner or admin of the club (mayWatchBoards's
//     roles — the route's `write`);
//   - its user now PLAYS on the board (C1's predicate: a sub seated after the
//     watch began never keeps watching their opponent);
//   - it is ARBITER_PARTICIPANT_TTL_MS old: a panel left open runs longer
//     than any game on the ship-1 clocks, and re-opening mints a fresh one.
// A watch whose room has ended needs no vendor call (the teardown kicked
// everyone and INACTIVE keeps every token out): it is stamped. Otherwise it
// is kicked and deleted at RealtimeKit (removeParticipant), THEN stamped; a
// vendor failure leaves it open, reported, for the next pass.

/** How long one arbiter participant may live (I2). Three hours: longer than
 *  any ship-1 game's clock, short enough that a forgotten panel stops. */
export const ARBITER_PARTICIPANT_TTL_MS = 3 * 60 * 60_000;

type ArbiterCandidate = {
  id: string;
  fixtureId: string;
  participantId: string;
  userId: string | null;
  createdAt: Date;
  meetingId: string;
  meetingEndedAt: Date | null;
  organiser: boolean;
};

async function arbiterCandidates(pass: Pass): Promise<ArbiterCandidate[]> {
  return sql<ArbiterCandidate[]>`
    select vp.id, vp.fixture_id as "fixtureId", vp.participant_id as "participantId", vp.user_id as "userId",
           vp.created_at as "createdAt", m.meeting_id as "meetingId", m.ended_at as "meetingEndedAt",
           exists (select 1 from org_members om
                    where om.org_id = f.org_id and om.user_id = vp.user_id
                      and om.role in ${sql(EDITOR_ROLES as unknown as string[])}) as organiser
      from fixture_video_participants vp
      join fixtures f on f.id = vp.fixture_id
      join fixture_video_meetings m on m.fixture_id = vp.fixture_id and m.side = vp.side
     where vp.preset = 'arbiter' and vp.removed_at is null
       ${orgScope(pass)}
     order by vp.created_at, vp.id`;
}

async function arbiterMustGo(pass: Pass, c: ArbiterCandidate): Promise<boolean> {
  if (c.meetingEndedAt !== null) return true;
  if (c.userId === null || !c.organiser) return true;
  if (pass.now.getTime() - c.createdAt.getTime() >= ARBITER_PARTICIPANT_TTL_MS) return true;
  return isSeatedOn(c.userId, c.fixtureId);
}

async function arbiterRevoke(pass: Pass, c: ArbiterCandidate, rtk: RealtimeKitDeps): Promise<void> {
  if (!(await arbiterMustGo(pass, c))) return;
  if (c.meetingEndedAt === null) {
    await removeParticipant({ meetingId: c.meetingId, participantId: c.participantId }, rtk);
  }
  const stamped = await sql`
    update fixture_video_participants set removed_at = ${pass.now} where id = ${c.id} and removed_at is null`;
  pass.report.arbitersRemoved += stamped.count;
}

function emptyReport(skipped: 0 | 1): SweepReport {
  return {
    skipped,
    bridgesClosed: 0,
    noShows: 0,
    mintRetries: 0,
    meetingsEnded: 0,
    reconciled: 0,
    heldForOrganiser: 0,
    cameraSettled: 0,
    cameraFlags: 0,
    connectionFlags: 0,
    deviceFlags: 0,
    arbitersRemoved: 0,
    scanned: 0,
    deferred: 0,
    failed: 0,
    failures: [],
  };
}

export async function sweepExternalPlay(deps: SweepDeps = {}): Promise<SweepReport> {
  if (deps.serialise === false) return runPass(deps);
  let report: SweepReport | null = null;
  try {
    await sql.begin(async (tx) => {
      const [lock] = await tx<{ got: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${SWEEP_LOCK})) as got`;
      if (!lock?.got) return;
      report = await runPass(deps);
    });
  } catch (err) {
    // The pass itself threw: the caller hears it. A pass that FINISHED and
    // whose lock transaction then failed to end cleanly still ran — its
    // report stands; the lock went with the transaction either way.
    if (report === null) throw err;
    log.warn({ message: err instanceof Error ? err.message : String(err) }, "external-play sweep: the pass lock's transaction ended badly");
  }
  return report ?? emptyReport(1);
}

async function runPass(deps: SweepDeps): Promise<SweepReport> {
  const report = emptyReport(0);
  const clock = deps.wallClock ?? Date.now;
  const pass: Pass = {
    now: deps.now ?? new Date(),
    orgIds: deps.orgIds,
    report,
    clock,
    startedAt: clock(),
    spent: false,
    settlingReads: 0,
    retired: new Set(),
  };

  // Job 0 before everything: a board whose fixture is decided is over for us.
  await each(pass, "close_unplayable", await unplayableCandidates(pass), (c) => closeUnplayable(pass, c));
  // FIRST: a game on file is brought to the truth before anything rules on
  // its board — a ready game aborted at ply 0 is the organiser's `aborted`,
  // never a no-show (T10 ruling), and a game it finishes is torn down below.
  const read = deps.reconcile ?? ((a) => reconcile(a.fixtureId, a.trigger, { now: pass.now, settle: a.settle }));
  await each(pass, "reconcile", await reconcileCandidates(pass), (c) => sweepReconcile(pass, c, read));
  const create = deps.createGameIfReady ?? ((id, d) => createGameIfReady(id, { now: d.now }));
  await each(pass, "mint_retry", await retryCandidates(pass), (c) => mintRetry(pass, c, create));
  await each(pass, "no_show", await noShowCandidates(pass), (c) => noShow(pass, c));
  // Last, so a game finished or a board forfeited earlier in THIS pass is
  // torn down in it.
  const end = deps.endMeeting ?? ((m) => endMeeting(m));
  await each(pass, "teardown", await teardownCandidates(pass), (c) => teardown(pass, c, end));
  // After the teardown: a room ended in THIS pass is not readable for 2 minutes.
  const rtk = deps.realtimeKit ?? {};
  await each(pass, "camera_evidence", await cameraCandidates(pass), (c) => cameraEvidence(pass, c, rtk));
  // After the teardown too: a room ended in THIS pass took its watches with it.
  await each(pass, "arbiter_revoke", await arbiterCandidates(pass), (c) => arbiterRevoke(pass, c, rtk));
  // LAST (D16 fix-3): job 3b's candidate read is outside `each`, so a table that is missing or broken makes the pass throw, and
  // the cron hears it (a swallowed undefined_table would hide a deploy that ran before its migration). Anything after it would
  // never run: it must be able to starve only itself, never the camera evidence or the arbiter-watch revocation above.
  const parked = deps.parkedRooms ?? (() => parkedRoomCandidates(pass));
  await each(pass, "teardown", await parked(), (c) => endParkedRoom(pass, c, end));
  report.failed = report.failures.length;
  return report;
}
