import "server-only";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { RealtimeKitDeferred, cappedBudget, endMeeting, platformSpend, type RealtimeKitDeps } from "@/server/external-play/video/realtimekit";
import { prunePresence } from "@/server/external-play/video/presence";
import { anyCheckinWindowOpen, windowDeferralOn } from "@/server/external-play/round-open";
import { createGameIfReady } from "../create-game";
import { reconcile } from "../reconcile";
import { SWEEP_RTK_CALLS_PER_PASS, each, type Pass, type SweepDeps, type SweepReport } from "./pass";
import { closeUnplayable, noShow, noShowCandidates, unplayableCandidates } from "./no-show";
import { mintRetry, retryCandidates } from "./mint-retry";
import { endParkedRoom, parkedRoomCandidates, teardown, teardownCandidates } from "./teardown";
import { reconcileCandidates, sweepReconcile } from "./reconcile";
import { cameraCandidates, cameraEvidence } from "./camera-evidence";
import { arbiterCandidates, arbiterRevocation, arbiterRevocationCandidates, arbiterRevoke } from "./arbiter-revoke";

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
    windowsOpen: 0,
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
    windowsOpen: false,
    retired: new Set(),
  };
  // The caller's own RealtimeKit transport. Its `budget`, when it has one, stands for the PLATFORM's bucket (what `cfEnvelope` spends
  // from on every request); with none, the adapter's own default (`platformSpend`) applies.
  const rtk: RealtimeKitDeps = deps.realtimeKit ?? {};

  // FIRST, before job 0 (check-in capacity R5): an arbiter's watch that a safeguard ends - the account is gone, the club role is
  // gone, the user now plays on the board - is removed before anything else spends a vendor call. UNCAPPED (the caller's own `rtk`,
  // never the capped budget below) and never deferred by a window; still through the platform bucket, whose refusal is the
  // vendor's own rate limit and a deferral here. The price: one `removeParticipant` on a room the teardown ends later in the pass.
  await each(pass, "arbiter_revocation", await arbiterRevocationCandidates(pass), (c) => arbiterRevocation(pass, c, rtk));

  // Job 0 before everything else: a board whose fixture is decided is over for us.
  await each(pass, "close_unplayable", await unplayableCandidates(pass), (c) => closeUnplayable(pass, c));
  // FIRST: a game on file is brought to the truth before anything rules on
  // its board — a ready game aborted at ply 0 is the organiser's `aborted`,
  // never a no-show (T10 ruling), and a game it finishes is torn down below.
  const read = deps.reconcile ?? ((a) => reconcile(a.fixtureId, a.trigger, { now: pass.now, settle: a.settle }));
  await each(pass, "reconcile", await reconcileCandidates(pass), (c) => sweepReconcile(pass, c, read));
  const create = deps.createGameIfReady ?? ((id, d) => createGameIfReady(id, { now: d.now }));
  await each(pass, "mint_retry", await retryCandidates(pass), (c) => mintRetry(pass, c, create));
  await each(pass, "no_show", await noShowCandidates(pass), (c) => noShow(pass, c));
  // R3: is a check-in window open anywhere in scope? Read ONCE, here: the three jobs below that are housekeeping defer on it. The
  // games the earlier jobs create or finish are never held back (they build their own adapters and take no part in the cap either:
  // see SWEEP_RTK_CALLS_PER_PASS). A failing read is the pass's failure, loudly: guessing "no window" would spend the vendor
  // calls the deferral exists to save.
  pass.windowsOpen = await (deps.windowsOpen ?? (async () => windowDeferralOn() && (await anyCheckinWindowOpen(sql, pass.now, deps.orgIds))))();
  report.windowsOpen = pass.windowsOpen ? 1 : 0;
  // ONE capped budget for what is left (teardown, the camera evidence, `arbiter_revoke`, the parked rooms), composed over the caller's
  // budget or the platform's own, so a request the cap refuses never reaches a platform token it would not use. A refusal is a
  // RealtimeKitDeferred, which `each` counts as a deferral for the rest of its job.
  const cap = deps.rtkCallCap ?? SWEEP_RTK_CALLS_PER_PASS;
  const capped = cappedBudget(cap, rtk.budget ?? platformSpend(rtk));
  const cappedRtk: RealtimeKitDeps = { ...rtk, budget: capped.budget };
  // The camera evidence is the one capped job whose row has no fixed price (a session list, a participant list per session, a
  // report per peer: a page that re-joined forty times is forty reports). Refused part-way, a room was read again from the top
  // every pass, never reached its give-up (a deferral is not an answer), and headed the line for ever (PR-2 whole review I1). So
  // the cap gates a room's START, and a started room finishes on the platform's bucket only (`finish`): it is counted, so the
  // rooms and jobs after it find the cap spent, and the next pass reaches them.
  const finishRtk: RealtimeKitDeps = { ...rtk, budget: capped.finish };
  const startCameraRoom = (c: Parameters<typeof cameraEvidence>[1]) => {
    if (capped.spent() >= cap) throw new RealtimeKitDeferred(`the pass's RealtimeKit call cap (${cap}) is spent`);
    return cameraEvidence(pass, c, finishRtk);
  };
  // Last, so a game finished or a board forfeited earlier in THIS pass is
  // torn down in it.
  const end = deps.endMeeting ?? ((m) => endMeeting(m, cappedRtk));
  await each(pass, "teardown", await teardownCandidates(pass), (c) => teardown(pass, c, end));
  // After the teardown: a room ended in THIS pass is not readable for 2 minutes. Deferred whole while a window is open (R6: the peer
  // reads are unchanged - `listPeerIds` per session - this job only waits).
  const camera = await cameraCandidates(pass);
  if (pass.windowsOpen) {
    report.scanned += camera.length;
    report.deferred += camera.length;
  } else {
    await each(pass, "camera_evidence", camera, startCameraRoom);
  }
  // After the teardown too: a room ended in THIS pass took its watches with it. Only the TTL and the ended-room arms are left to it.
  await each(pass, "arbiter_revoke", await arbiterCandidates(pass), (c) => arbiterRevoke(pass, c, cappedRtk));
  // Task 10b retention: webhook deliveries and presence rows past their retention. Not a SWEEP_JOBS member (no vendor call, no budget,
  // no fixture), so a failure is logged and never `report.failures`; caught here so it can starve neither the jobs above nor job 3b
  // below, which must stay LAST.
  const prune = deps.prunePresence ?? ((now: Date) => prunePresence(sql, now));
  try {
    const pruned = await prune(pass.now);
    log.info({ ...pruned }, "sweep: presence pruned");
  } catch (err) {
    log.error({ err }, "sweep: presence prune failed");
  }
  // LAST (D16 fix-3): job 3b's candidate read is outside `each`, so a table that is missing or broken makes the pass throw, and
  // the cron hears it (a swallowed undefined_table would hide a deploy that ran before its migration). Anything after it would
  // never run: it must be able to starve only itself, never the camera evidence or the arbiter-watch revocation above.
  const parked = deps.parkedRooms ?? (() => parkedRoomCandidates(pass));
  await each(pass, "teardown", await parked(), (c) => endParkedRoom(pass, c, end));
  report.failed = report.failures.length;
  return report;
}
