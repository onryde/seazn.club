import "server-only";
// A player's camera taken out of the meeting by OUR safeguard, never by the
// player (T14 re-review 3, I-1; V436 `fixture_video_guard_faults`). The
// player's browser refuses every remote stream (D7, spec §5.3); when it
// cannot, it leaves the meeting and re-joins a fresh one, stamping the gap
// here: open before it leaves, closed once it is back (or when the player is
// seated again, a reload's way back). Job 5 counts a stamped interval as
// covered, so it never becomes a camera_lost flag; while one is open the
// opponent's room shows no presence pill rather than "camera off".
//
// The writers take the SERVER's clock, never a time from the client. At most
// one fault is open per player per fixture (the partial unique index), so a
// repeated start is a no-op rather than a second interval.
import type postgres from "postgres";

type AnySql = postgres.TransactionSql | postgres.Sql;
type Seat = { fixtureId: string; personId: string };

/** Opens a fault at `at`. false ⇒ one was already open (nothing written). */
export async function openGuardFault(db: AnySql, a: Seat & { at: Date }): Promise<boolean> {
  const rows = await db`
    insert into fixture_video_guard_faults (fixture_id, person_id, started_at)
    values (${a.fixtureId}, ${a.personId}, ${a.at})
    on conflict (fixture_id, person_id) where ended_at is null do nothing
    returning id`;
  return rows.length > 0;
}

/** Closes the open fault at `at`. false ⇒ none was open. */
export async function closeGuardFault(db: AnySql, a: Seat & { at: Date }): Promise<boolean> {
  const rows = await db`
    update fixture_video_guard_faults set ended_at = ${a.at}
     where fixture_id = ${a.fixtureId} and person_id = ${a.personId} and ended_at is null
    returning id`;
  return rows.length > 0;
}

/** Whether one is open now (the opponent's pill is withheld while it is). */
export async function hasOpenGuardFault(db: AnySql, a: Seat): Promise<boolean> {
  const rows = await db`
    select 1 from fixture_video_guard_faults
     where fixture_id = ${a.fixtureId} and person_id = ${a.personId} and ended_at is null
     limit 1`;
  return rows.length > 0;
}

/** Every fault on file, oldest first; `to` null ⇒ still open. */
export async function guardFaultSpans(db: AnySql, a: Seat): Promise<{ from: Date; to: Date | null }[]> {
  return db<{ from: Date; to: Date | null }[]>`
    select started_at as "from", ended_at as "to" from fixture_video_guard_faults
     where fixture_id = ${a.fixtureId} and person_id = ${a.personId}
     order by started_at, id`;
}
