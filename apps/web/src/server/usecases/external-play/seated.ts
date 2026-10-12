import "server-only";
// T15 fix round 1, C1 (D7 safeguarding): ONE predicate for "does this user
// play on this board?". An organiser may watch a board's cameras through the
// arbiter panel; a PLAYER may never watch their opponent's, and an organiser
// who also plays is a player on their own board. The arbiter's join refuses
// on it, the panel's loader hides the viewer's own boards with it, and the
// sweep removes an arbiter participant whose user it answers yes for. None
// of them copies it.
//
// Every way a user maps to a seat is a yes — broad on purpose, because a
// wrong "no" shows a child's camera to their opponent and a wrong "yes" only
// sends the organiser to a colleague:
//   - a member of either entrant (entrant_members), through a person linked
//     to the user (persons.user_id);
//   - a PLAYER camera participant on the fixture (fixture_video_participants,
//     T8's seat claim): it outlives a roster edit, so a re-seat does not
//     free the person who sat there;
//   - any fixture_availability row on the fixture (a check-in or an RSVP):
//     the person was on this board's roster when it was written.
// Each follows the person-merge tombstone (persons.merged_into, V349) both
// ways: the user's own tombstone absorbed into a member, and a member
// tombstone absorbed into the user's person. Merges flatten (person-merge.ts:
// `merged_into` always names a LIVE person), so one hop is the whole chain.
//
// Read with the privileged `sql`: fixture_video_participants is SEALED
// (FORCE RLS, no app_user policy), as for every arbiter read.
import { sql } from "@/lib/db";

/** The subset of `fixtureIds` the user plays on. */
export async function fixturesSeating(userId: string, fixtureIds: readonly string[]): Promise<Set<string>> {
  const rows = await sql<{ id: string }[]>`
    with mine as (
      select p.id from persons p where p.user_id = ${userId}
      union
      select p.merged_into from persons p where p.user_id = ${userId} and p.merged_into is not null
      union
      select q.id from persons q join persons p on q.merged_into = p.id where p.user_id = ${userId}
    )
    select f.id from fixtures f
     where f.id in ${sql([...fixtureIds])}
       and (
         exists (select 1 from entrant_members em
                  where em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
                    and em.person_id in (select id from mine))
         or exists (select 1 from fixture_video_participants vp
                     where vp.fixture_id = f.id and vp.preset = 'player'
                       and vp.person_id in (select id from mine))
         or exists (select 1 from fixture_availability fa
                     where fa.fixture_id = f.id and fa.person_id in (select id from mine))
       )`;
  return new Set(rows.map((r) => r.id));
}

export async function isSeatedOn(userId: string, fixtureId: string): Promise<boolean> {
  return (await fixturesSeating(userId, [fixtureId])).has(fixtureId);
}
