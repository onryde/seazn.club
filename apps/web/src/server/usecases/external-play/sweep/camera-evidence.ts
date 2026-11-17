import "server-only";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import type { CameraPolicy } from "@/lib/camera-policy";
import { fixtureCameraPolicyAt } from "@/server/external-play/camera-policy";
import { concurrentConnections, matchCameraOff, type CompleteCoverage } from "@/server/external-play/video/match-camera-off";
import { cameraMatchWindow, matchGuardFaults } from "@/server/external-play/video/match-window";
import {
  RealtimeKitDeferred,
  fetchVideoOffCoverage,
  listMeetingSessions,
  listPeerIds,
  type RealtimeKitDeps,
} from "@/server/external-play/video/realtimekit";
import { loadSides } from "../guard";
import { codeOf, orgScope, type Pass } from "./pass";

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

export async function cameraCandidates(pass: Pass): Promise<CameraCandidate[]> {
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

export async function cameraEvidence(pass: Pass, c: CameraCandidate, rtk: RealtimeKitDeps): Promise<void> {
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
