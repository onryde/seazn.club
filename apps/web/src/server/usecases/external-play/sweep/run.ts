import "server-only";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { endMeeting } from "@/server/external-play/video/realtimekit";
import { createGameIfReady } from "../create-game";
import { reconcile } from "../reconcile";
import { each, type Pass, type SweepDeps, type SweepReport } from "./pass";
import { closeUnplayable, noShow, noShowCandidates, unplayableCandidates } from "./no-show";
import { mintRetry, retryCandidates } from "./mint-retry";
import { endParkedRoom, parkedRoomCandidates, teardown, teardownCandidates } from "./teardown";
import { reconcileCandidates, sweepReconcile } from "./reconcile";
import { cameraCandidates, cameraEvidence } from "./camera-evidence";
import { arbiterCandidates, arbiterRevoke } from "./arbiter-revoke";

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
    fixedNow: deps.now !== undefined,
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
