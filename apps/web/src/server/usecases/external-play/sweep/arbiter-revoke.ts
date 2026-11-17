import "server-only";
import { sql } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/types";
import { removeParticipant, type RealtimeKitDeps } from "@/server/external-play/video/realtimekit";
import { isSeatedOn } from "../seated";
import { orgScope, type Pass } from "./pass";

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

export async function arbiterCandidates(pass: Pass): Promise<ArbiterCandidate[]> {
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

export async function arbiterRevoke(pass: Pass, c: ArbiterCandidate, rtk: RealtimeKitDeps): Promise<void> {
  if (!(await arbiterMustGo(pass, c))) return;
  if (c.meetingEndedAt === null) {
    await removeParticipant({ meetingId: c.meetingId, participantId: c.participantId }, rtk);
  }
  const stamped = await sql`
    update fixture_video_participants set removed_at = ${pass.now} where id = ${c.id} and removed_at is null`;
  pass.report.arbitersRemoved += stamped.count;
}
