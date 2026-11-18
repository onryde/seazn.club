import "server-only";
import { sql } from "@/lib/db";
import { RealtimeKitError, retireStaleMeeting, gameEvidenceOn } from "@/server/external-play/video/realtimekit";
import { premintBoardLeftWhere } from "../premint";
import { boardExtraSql, boardRankSql } from "@/server/external-play/round-open";
import { type BoardAnchor } from "@/server/external-play/window";
import { boardPhase } from "@/server/external-play/seat-line";
import { isPlayableFixtureStatus } from "../preflight";
import { anchorIfClosedNow, bothCameFor, candidateAnchor, gameMayBeOnFile, orgScope, playableWindow, type BridgeFacts, type ParkedRoom, type Pass, type SweepDeps } from "./pass";

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
//   - the pre-mint job's room is no longer wanted (check-in capacity G2; `premintLeft`): the room was made for a board of a round
//     that has never been opened, and the board has since left the set the pre-mint job makes rooms for (cancelled, withdrawn,
//     decided, its division completed, its camera policy off, ...). Ended, and then its ROW is deleted: a first open retires
//     nothing it did not mark, so an ended row left behind would refuse every claim VIDEO_MEETING_ENDED if the decision is undone.
//     The predicate is the TOTAL NEGATION of the pre-mint's own board rule (`premintBoardLeftWhere`: `is not true`, so a NULL reads left), so the two jobs can never disagree: a room
//     of a board the pre-mint job still wants is never ended here, and there is no make-and-unmake loop between them.
// A game on file that is not finished keeps its meeting, past the deadline or not:
// "nothing in our system ends a live game early" (spec §3.6).
//
// Check-in capacity R3 (plan 2 Task 8): while a check-in window is open anywhere in scope (`pass.windowsOpen`) a room that is not
// STALE-paired is not torn down - the pass's vendor calls belong to the players' claims - and is counted `deferred` (it keeps its
// place; the next pass without a window reaches it). A stale-paired room is retired whatever the window says: an old pair's tokens
// must not stay live, and it is the claim's own retire, which the sweep only backs up.

type TeardownCandidate = BridgeFacts & {
  fixtureId: string;
  side: "home" | "away";
  meetingId: string;
  fixtureStatus: string;
  openedAt: Date | null;
  /** The board's anchor; null when its round was never opened. */
  anchor: BoardAnchor | null;
  /** Made for another pairing than the fixture's CURRENT one, with no game behind it: the retire's own judgement (gameEvidenceOn).
   *  Only on a board that HAS a pairing: an unpaired board's rooms are left to the window rules below (ended at the deadline,
   *  stamped), as before - an organiser who unpairs and re-pairs the same players a minute later keeps their rooms.
   *  Never an UNADOPTED room (both stamps null: the pre-mint job's room for a board with no pairing yet, adopted by the first
   *  claim): it is made for whichever pairing comes first, so it is not another pairing's. `retireStaleMeeting` never selects it,
   *  so a candidate marked retirable here would reach the retire branch, retire nothing and never be judged by the window rule
   *  below - a room nobody joined would stay open past its deadline. It is judged by `meetingIsDone` like any other. */
  retirable: boolean;
  /** The room of a board whose round was NEVER opened and which has left the pre-mint job's candidate set (G2): ended and deleted,
   *  never merely ended. Always false for a board whose round is open (the pre-mint job never touches one), and for a board a game is,
   *  or may be, on file behind. */
  premintLeft: boolean;
};

export async function teardownCandidates(pass: Pass): Promise<TeardownCandidate[]> {
  const rows = await sql<(Omit<TeardownCandidate, "anchor"> & { rank: number; extraMs: number; staggered: boolean | null })[]>`
    select m.fixture_id as "fixtureId", m.side, m.meeting_id as "meetingId", f.status as "fixtureStatus",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId", ep.create_sent_at as "createSentAt",
           ep.mint_claimed_at as "mintClaimedAt", o.opened_at as "openedAt", o.staggered, ${boardRankSql(sql)} as rank, ${boardExtraSql(sql)} as "extraMs",
           (f.home_entrant_id is not null and f.away_entrant_id is not null
            and m.home_entrant_id is not null
            and (m.home_entrant_id, m.away_entrant_id) is distinct from (f.home_entrant_id, f.away_entrant_id)
            and not coalesce(${gameEvidenceOn(pass.now)}, false)) as "retirable",
           (o.opened_at is null
            and ${premintBoardLeftWhere()}
            and not coalesce(${gameEvidenceOn(pass.now)}, false)) as "premintLeft"
      from fixture_video_meetings m
      join fixtures f on f.id = m.fixture_id
      join stages s on s.id = f.stage_id
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      left join fixture_external_play ep on ep.fixture_id = m.fixture_id
      left join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
     where m.ended_at is null
       ${orgScope(pass)}
     order by m.created_at, m.fixture_id, m.side`;
  return rows.map((r) => ({ ...r, anchor: candidateAnchor(r) }));
}

/** The cheap, lock-free half of `meetingIsDone`, from the candidate's own facts: could this room be done at all - a result or a settled
 *  bridge, or a deadline that has passed with no game on file? A room that is not is KEPT whatever else is true (a live game, a board
 *  still inside its own window), so an open window defers nothing of it. No read, no lock: it is asked of every candidate while a window
 *  is open, the busiest minutes of the round. `meetingIsDone` takes the board's lock and re-reads only past it. */
function meetingMayBeDone(pass: Pass, c: TeardownCandidate): boolean {
  if (c.bridgeStatus === "finished") return true;
  if (!isPlayableFixtureStatus(c.fixtureStatus)) return true;
  if (c.anchor === null) return false;
  const { deadline } = playableWindow(c.anchor);
  return !(pass.now.getTime() < deadline.getTime() || gameMayBeOnFile(pass, c));
}

async function meetingIsDone(pass: Pass, c: TeardownCandidate): Promise<boolean> {
  if (!meetingMayBeDone(pass, c)) return false;
  if (c.bridgeStatus === "finished" || !isPlayableFixtureStatus(c.fixtureStatus)) return true;
  // Spec §3.2.2: the candidate's deadline may be stale (an arbiter's +5 minutes since the query): ending the players' rooms on
  // "nobody played" is judged on the board's anchor as it stands now, read under the board's check-in-window lock.
  const fresh = await anchorIfClosedNow(pass, c.fixtureId);
  if (fresh === null) return false;
  // Spec §5.7.8: "nobody played" is not true of a board the check-in line (or a create still owed) is holding open past its
  // deadline: those players' rooms stay up until the board's cap.
  const held = await boardPhase(fresh.now, { fixtureId: c.fixtureId, anchor: fresh.anchor }, { personId: null, facts: () => bothCameFor(c.fixtureId, fresh.anchor) });
  return held !== "open";
}

export async function teardown(pass: Pass, c: TeardownCandidate, end: NonNullable<SweepDeps["endMeeting"]>): Promise<void> {
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
  // R3: a window is open somewhere in scope - this room waits and keeps its place. It is counted `deferred` only when the window is what
  // held it back: a room the pass would have ended (a board that left the pre-mint set, or one that is done), never a live game's or a
  // board still inside its own window, which nothing would end now - those stay up UNCOUNTED, so `deferred` says how much the window
  // postponed, not how many rooms exist. (`meetingMayBeDone` is the cheap half only: no lock is taken while a window is open.)
  if (pass.windowsOpen) {
    if (c.premintLeft || meetingMayBeDone(pass, c)) pass.report.deferred++;
    return;
  }
  if (c.premintLeft) {
    // G2: the pre-mint job's room for a board that left its set. The end is the vendor's; the delete is ours and follows ONLY an end that
    // took (the row is the one thing that tracks an active room): `endMeeting` stamps `ended_at`, and a room the vendor itself says is not
    // there is already gone, so its row goes too (an un-ended row's delete is parked by V460 and cleared by job 3b, a harmless no-op).
    let gone = false;
    try {
      await end(c.meetingId);
    } catch (err) {
      if (!(err instanceof RealtimeKitError && err.code === "not_found")) throw err;
      gone = true;
    }
    await sql`delete from fixture_video_meetings where meeting_id = ${c.meetingId} and (${gone} or ended_at is not null)`;
    if (!gone) pass.report.meetingsEnded++;
    return;
  }
  if (!(await meetingIsDone(pass, c))) return;
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

export async function parkedRoomCandidates(pass: Pass): Promise<ParkedRoom[]> {
  const scope = pass.orgIds === undefined ? sql`` : sql`and r.org_id in ${sql(pass.orgIds as string[])}`;
  return sql<ParkedRoom[]>`
    select r.fixture_id as "fixtureId", r.side, r.meeting_id as "meetingId"
      from video_rooms_to_end r
     where true ${scope}
     order by r.created_at, r.meeting_id`;
}

export async function endParkedRoom(pass: Pass, c: ParkedRoom, end: NonNullable<SweepDeps["endMeeting"]>): Promise<void> {
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
