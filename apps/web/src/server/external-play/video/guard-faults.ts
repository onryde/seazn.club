import "server-only";
// A player's camera taken out of the meeting by OUR safeguard, never by the
// player (T14 re-review 3, I-1; V442 `fixture_video_guard_faults`). The
// player's browser refuses every remote stream (D7, spec §5.3); when it
// cannot, it leaves the meeting and re-joins a fresh one, stamping the gap
// here: open before it leaves, closed once it is back (or when the player is
// seated again, a reload's way back). Job 5 counts a stamped interval as
// covered, so it never becomes a camera_lost flag; while one is open the
// opponent's room shows no presence pill rather than "camera off".
//
// The writers take the SERVER's clock, never a time from the client. At most
// one fault is open per player per meeting (the partial unique index on
// `(fixture_id, side, person_id)`; D16: a meeting is one player's), so a
// repeated start is a no-op rather than a second interval.
//
// The cap (T14 fix round 6, M-2): a client that stamps and stamps — buggy or
// hostile — could otherwise write rows without end. It is a COST bound, not a
// rule of the game: the count and the insert are one statement, but two
// starts racing an end can still overrun it by a row or two (READ COMMITTED
// re-checks the conflict, not the count). An end is never capped.
import type postgres from "postgres";

type AnySql = postgres.TransactionSql | postgres.Sql;
/** D16: a seat is a person in THEIR side's meeting; the key is `(fixture_id, side, person_id)`. */
type Seat = { fixtureId: string; side: "home" | "away"; personId: string };

/** Stamps one seat may open in one fixture. Above the told-flag's stamp
 *  threshold (match-camera-off), so the organiser hears before any refusal. */
export const GUARD_FAULT_MAX_STAMPS = 20;

/** `stamps`: the seat's rows on file after the call. */
export type GuardFaultOpen = { outcome: "opened" | "open_already" | "capped"; stamps: number };

/** Opens a fault at `at`: `opened`; `open_already` ⇒ one is open (nothing
 *  written); `capped` ⇒ GUARD_FAULT_MAX_STAMPS on file (nothing written). */
export async function openGuardFault(db: AnySql, a: Seat & { at: Date }): Promise<GuardFaultOpen> {
  const [r] = await db<{ n: number; open_n: number; inserted: number }[]>`
    with prior as (
      select count(*)::int as n, (count(*) filter (where ended_at is null))::int as open_n
        from fixture_video_guard_faults
       where fixture_id = ${a.fixtureId} and side = ${a.side} and person_id = ${a.personId}
    ), ins as (
      insert into fixture_video_guard_faults (fixture_id, side, person_id, started_at)
      select ${a.fixtureId}, ${a.side}, ${a.personId}, ${a.at} from prior where prior.n < ${GUARD_FAULT_MAX_STAMPS}
      on conflict (fixture_id, side, person_id) where ended_at is null do nothing
      returning id
    )
    select prior.n, prior.open_n, (select count(*)::int from ins) as inserted from prior`;
  if (r!.inserted > 0) return { outcome: "opened", stamps: r!.n + 1 };
  if (r!.open_n > 0) return { outcome: "open_already", stamps: r!.n };
  if (r!.n >= GUARD_FAULT_MAX_STAMPS) return { outcome: "capped", stamps: r!.n };
  // Nothing open in our snapshot, room under the cap, yet the insert met a
  // conflict: a concurrent start opened one first. Open already, as asked.
  return { outcome: "open_already", stamps: r!.n + 1 };
}

/** Closes the open fault at `at`. false ⇒ none was open. */
export async function closeGuardFault(db: AnySql, a: Seat & { at: Date }): Promise<boolean> {
  const rows = await db`
    update fixture_video_guard_faults set ended_at = ${a.at}
     where fixture_id = ${a.fixtureId} and side = ${a.side} and person_id = ${a.personId} and ended_at is null
    returning id`;
  return rows.length > 0;
}

/** Whether one is open now (the opponent's pill is withheld while it is). */
export async function hasOpenGuardFault(db: AnySql, a: Seat): Promise<boolean> {
  const rows = await db`
    select 1 from fixture_video_guard_faults
     where fixture_id = ${a.fixtureId} and side = ${a.side} and person_id = ${a.personId} and ended_at is null
     limit 1`;
  return rows.length > 0;
}

/** Every fault on file, oldest first; `to` null ⇒ still open. */
export async function guardFaultSpans(db: AnySql, a: Seat): Promise<{ from: Date; to: Date | null }[]> {
  return db<{ from: Date; to: Date | null }[]>`
    select started_at as "from", ended_at as "to" from fixture_video_guard_faults
     where fixture_id = ${a.fixtureId} and side = ${a.side} and person_id = ${a.personId}
     order by started_at, id`;
}
