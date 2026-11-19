import "server-only";
import { sql } from "@/lib/db";
import { EDITOR_ROLES } from "@/lib/types";
import { removeParticipant, type RealtimeKitDeps } from "@/server/external-play/video/realtimekit";
import { isSeatedOn } from "../seated";
import { orgScope, type Pass } from "./pass";

// ─── Job 6: the arbiter watches the server removes (T15 fix round 1, I2) ───
//
// An organiser's watch of a board is a RealtimeKit participant whose token
// lasts 100 days. The panel sends no DELETE any more (the server owns cleanup), and a
// browser that crashes or loses the network never says so — and a role can
// be taken away mid-watch. So every pass looks at every watch not yet
// removed, and ends one when:
//   - its user is gone (the account deleted: ON DELETE SET NULL, M5);
//   - its user is no longer an owner or admin of the club (mayWatchBoards's
//     roles — the route's `write`);
//   - its user now PLAYS on the board (C1's predicate: a sub seated after the
//     watch began never keeps watching their opponent);
//   - it is ARBITER_PARTICIPANT_TTL_MS old, counted from created_at: a reload REUSES the row
//     (no reset), so a kept room re-opened within the TTL is kicked once and the panel's
//     evict + one re-POST mints a fresh participant;
//   - its room has ended.
// A watch whose room has ended needs no vendor call (the teardown kicked
// everyone and INACTIVE keeps every token out): it is stamped. Otherwise it
// is kicked and deleted at RealtimeKit (removeParticipant), THEN stamped; a
// vendor failure leaves it open, reported, for the next pass.
//
// Check-in capacity plan 2 Task 8 (owner ruling R5) splits the job in two, because the first three arms are SAFEGUARDING and the
// last two are housekeeping, and a pass that is capping or deferring its housekeeping must not hold a safeguard back:
//   - `arbiter_revocation` runs FIRST in the pass: the account-gone, role-gone and now-plays arms. Its calls are not under the
//     pass's call cap and an open check-in window never defers it. They still go through the platform bucket (`cfEnvelope` spends
//     it on every request: the vendor's own rate limit, not the pass's policy), so a refusal there is a deferral retried next pass.
//     Running first costs one `removeParticipant` on a room the teardown ends later in the same pass: the accepted price.
//   - `arbiter_revoke` keeps its name for the rest - the TTL and the ended-room arms - under the pass's cap, not deferred by a window.

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

/** The safeguarding arms (R5): the account is gone, the user is no longer an owner or admin of the club, or the user now plays on
 *  the board. Cheap ones first; the seat read is the only one that asks the database. */
async function revocationDue(c: ArbiterCandidate): Promise<boolean> {
  if (c.userId === null || !c.organiser) return true;
  return isSeatedOn(c.userId, c.fixtureId);
}

/** The first job's candidates: the watches a safeguarding arm selects. A watch whose seat read FAILS is kept in the list, so the
 *  act asks again and reports the failure under this job, row by row, as `each` does for every other (a throw here would fail the
 *  whole pass). */
export async function arbiterRevocationCandidates(pass: Pass): Promise<ArbiterCandidate[]> {
  const due: ArbiterCandidate[] = [];
  for (const c of await arbiterCandidates(pass)) {
    try {
      if (await revocationDue(c)) due.push(c);
    } catch {
      due.push(c);
    }
  }
  return due;
}

/** Take the watch off: kicked and deleted at the vendor unless its room already ended, then stamped. A vendor failure leaves it open. */
async function removeWatch(pass: Pass, c: ArbiterCandidate, rtk: RealtimeKitDeps): Promise<void> {
  if (c.meetingEndedAt === null) {
    await removeParticipant({ meetingId: c.meetingId, participantId: c.participantId }, rtk);
  }
  const stamped = await sql`
    update fixture_video_participants set removed_at = ${pass.now} where id = ${c.id} and removed_at is null`;
  pass.report.arbitersRemoved += stamped.count;
}

/** `arbiter_revocation`, the first job of the pass. `rtk` is the caller's own transport, NOT the pass's capped one. */
export async function arbiterRevocation(pass: Pass, c: ArbiterCandidate, rtk: RealtimeKitDeps): Promise<void> {
  if (!(await revocationDue(c))) return;
  await removeWatch(pass, c, rtk);
}

/** `arbiter_revoke`, what is left of job 6: a watch whose room ended, or that is ARBITER_PARTICIPANT_TTL_MS old. `rtk` carries the
 *  pass's capped budget. The safeguarding arms are the first job's: a role-removed watch the first job could not remove (the
 *  platform bucket refused it) is still on file here, and is NOT removed by this job - it waits for the next pass's first job. */
export async function arbiterRevoke(pass: Pass, c: ArbiterCandidate, rtk: RealtimeKitDeps): Promise<void> {
  const ended = c.meetingEndedAt !== null;
  const expired = pass.now.getTime() - c.createdAt.getTime() >= ARBITER_PARTICIPANT_TTL_MS;
  if (!ended && !expired) return;
  await removeWatch(pass, c, rtk);
}
