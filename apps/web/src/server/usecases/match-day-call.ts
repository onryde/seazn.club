import "server-only";
// Match Day: call a match onto a free court, Undo the call, and preview its knock-on
// (spec docs/superpowers/specs/2026-10-31-match-day-design.md §7, §7.1, §7.2).
//
// A call is NOT a board move. Owner ruling B (2026-10-31): planned times never change on a call. Only the called match's court,
// venue and time are written; every other match keeps its planned `scheduled_at`, and Match Day estimates the knock-on when it
// reads. So `moveFixture` (schedule.ts), which refuses an overlap with a planned match on the target court, is not the write path,
// and its guard stays exactly as it is for every other caller. The overlap a call leaves behind is pre-existing to the board's
// delta gate, so a later board edit of the bumped match is not refused for it (match-day-call.test.ts, Review Focus 5).
//
// What a call DOES refuse (§7.2 hard stops), each a 409 named in lib/match-day/call.ts:
//  - the match is not unstarted, or a side is still to be decided (NOT_CALLABLE);
//  - the target court has a match playing, or a live call, from ANY competition: courts are org-level (COURT_BUSY);
//  - a PERSON of the match is in a match playing, or called, on another court. Person-level, so a doubles partner counts,
//    and resolved through the scheduler's own `peopleByEntrant` + `peopleOf` (PLAYER_BUSY). And, for a side with no roster
//    (a name-only team or player: members are optional), the ENTRANT itself in such a match (PLAYER_BUSY, the entrant's name).
//
// "A live call" is a `fixture_calls` row whose fixture is still unstarted AND still exactly where the call put it: on the court
// it was called to, at the time it was called (`liveCallSql`). The status, not the row, says whether a call still holds: a called
// match the scorer started, or one that ended, keeps its row and holds nothing as a call (a playing match holds its court as
// playing). A call that a board edit has since moved — to another court, or to a later time on the same one — holds nothing.
//
// A call and its Undo are schedule edits like any other on the division's ledger: under the division lock, each appends one
// `schedule_edited` (the shape moveFixture writes, so history can undo it) and bumps `divisions.seq`, so a board or an AI plan
// loaded before the call is refused as stale instead of writing over it. They do NOT honour the division's schedule freeze
// (`schedule_locked`): the freeze guards planning edits, and the day must still run.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { appendDivisionEvent } from "@/server/engine-db";
import {
  CALL_REFUSAL,
  TBD_ENTRANT,
  type CallPreview,
  type CallRefusalCode,
  type CallShift,
  type CallWarning,
} from "@/lib/match-day/call";
import type { AuthCtx } from "@/server/api-v1/auth";
import { dayKeyInTz, usableWindows, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling";
import { resolveCourtCalendars } from "./court-candidates";
import {
  afterScheduleWrite,
  courtNamesById,
  loadSettings,
  MOVABLE_STATUS,
  peopleByEntrant,
  peopleOf,
} from "./schedule";

type Tx = postgres.TransactionSql;

const MS_PER_MIN = 60_000;
/** The one status a match is playing in. A single literal: the in-play half of each busy question below. */
const IN_PLAY = "in_play";
const iso = (t: number): string => new Date(t).toISOString();

interface CallTarget {
  id: string;
  division_id: string;
  competition_id: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  court_id: string | null;
  venue_id: string | null;
  scheduled_at: Date | null;
  schedule_locked: boolean;
}

function refuse(code: CallRefusalCode, message: string, details?: Record<string, unknown>): never {
  throw new HttpError(409, message, code, details);
}

/**
 * The ONE test of whether a call still holds, over `fixture_calls fc` joined to its fixture as `g`: the match is unstarted and
 * still exactly where the call put it, on the called court at the called time (a call writes `fixtures.scheduled_at` and
 * `called_at` from the same instant). A board edit that moves it anywhere else, a later time on the same court included, ends
 * the call. Match Day's read model asks this same question (spec §7, task A2).
 */
export function liveCallSql(tx: Tx) {
  return tx`(g.status = ${MOVABLE_STATUS} and g.court_id = fc.court_id and g.scheduled_at = fc.called_at)`;
}

/** The fixture, with its competition. `lock` takes the locks a call or an Undo writes under, in the board's own order: the
 *  DIVISION lock first (moveFixture and applySchedule take it before they write a fixture row, so the reverse order here would
 *  deadlock against them), then one lock per org that serialises every call and Undo across divisions (the busy reads below
 *  decide a write, and two calls racing onto one court, or one player onto two courts, would each read the other as absent),
 *  then the row. A fixture's division never changes, so reading it before the lock is safe. The preview writes nothing and
 *  takes no lock. */
async function readFixture(tx: Tx, orgId: string, fixtureId: string, lock: boolean): Promise<CallTarget> {
  if (lock) {
    const [d] = await tx<{ division_id: string }[]>`select division_id from fixtures where id = ${fixtureId}`;
    if (!d) throw new HttpError(404, "fixture not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + d.division_id}))`;
    await tx`select pg_advisory_xact_lock(hashtext(${"match_day_call:" + orgId}))`;
  }
  const rows = lock
    ? await tx<CallTarget[]>`
        select f.id, f.division_id, d.competition_id, f.status, f.home_entrant_id, f.away_entrant_id,
               f.court_id, f.venue_id, f.scheduled_at, f.schedule_locked
          from fixtures f join divisions d on d.id = f.division_id
         where f.id = ${fixtureId}
           for update of f`
    : await tx<CallTarget[]>`
        select f.id, f.division_id, d.competition_id, f.status, f.home_entrant_id, f.away_entrant_id,
               f.court_id, f.venue_id, f.scheduled_at, f.schedule_locked
          from fixtures f join divisions d on d.id = f.division_id
         where f.id = ${fixtureId}`;
  const [f] = rows;
  if (!f) throw new HttpError(404, "fixture not found");
  return f;
}

/** The fixture's call row, if any, and whether it still holds (`liveCallSql`). */
async function readCall(
  tx: Tx,
  fixtureId: string,
): Promise<
  | { live: boolean; prev_court_id: string | null; prev_venue_id: string | null; prev_scheduled_at: Date | null }
  | undefined
> {
  const [row] = await tx<
    { live: boolean; prev_court_id: string | null; prev_venue_id: string | null; prev_scheduled_at: Date | null }[]
  >`
    select ${liveCallSql(tx)} as live, fc.prev_court_id, fc.prev_venue_id, fc.prev_scheduled_at
      from fixture_calls fc join fixtures g on g.id = fc.fixture_id
     where fc.fixture_id = ${fixtureId}`;
  return row;
}

/** A call or its Undo on the division's ledger, as moveFixture records a board move: one `schedule_edited` (from/to with the
 *  venue, which history's Undo needs for a venue-only slot, and the pin unchanged) and `divisions.seq` bumped to it, so a writer
 *  holding the pre-call seq fails `assertFreshSeq`. Under the division lock (`readFixture`). */
async function recordScheduleEdit(
  tx: Tx,
  f: CallTarget,
  to: { at: Date | null; court: string | null; venue: string | null },
): Promise<void> {
  const at = (d: Date | null) => (d === null ? null : iso(new Date(d).getTime()));
  const seq = await appendDivisionEvent(tx, f.division_id, "schedule_edited", {
    fixture: f.id,
    from: { at: at(f.scheduled_at), court: f.court_id, venue: f.venue_id, locked: f.schedule_locked },
    to: { at: at(to.at), court: to.court, venue: to.venue, locked: f.schedule_locked },
  });
  await tx`update divisions set seq = ${seq} where id = ${f.division_id}`;
}

/** The target court, which must be this org's (RLS) and not archived. */
async function targetCourt(tx: Tx, courtId: string): Promise<{ id: string; venue_id: string }> {
  const [court] = await tx<{ id: string; venue_id: string }[]>`
    select id, venue_id from courts where id = ${courtId} and archived_at is null`;
  if (!court) throw new HttpError(404, "court not found");
  return court;
}

function assertUnstarted(f: CallTarget): void {
  if (f.status !== MOVABLE_STATUS) {
    refuse(CALL_REFUSAL.NOT_CALLABLE, `this match is ${f.status}, so it cannot be called`, { status: f.status });
  }
}

/** §7.2's hard stops, in the order a person reads them: the match itself, the court, then its players. */
async function assertCallable(tx: Tx, f: CallTarget, courtId: string, courtNames: ReadonlyMap<string, string>): Promise<void> {
  assertUnstarted(f);
  if (f.home_entrant_id === null || f.away_entrant_id === null) {
    refuse(CALL_REFUSAL.NOT_CALLABLE, "a side of this match is still to be decided", { status: TBD_ENTRANT });
  }

  // The court: a match playing on it, or a live call onto it, from any competition of the org (RLS scopes to the org).
  const [busy] = await tx<{ competition_name: string }[]>`
    select c.name as competition_name
      from (
        select f.id, f.division_id, 0 as rank
          from fixtures f
         where f.court_id = ${courtId} and f.status = ${IN_PLAY} and f.id <> ${f.id}
        union all
        select g.id, g.division_id, 1 as rank
          from fixture_calls fc join fixtures g on g.id = fc.fixture_id
         where fc.court_id = ${courtId} and ${liveCallSql(tx)} and g.id <> ${f.id}
      ) b
      join divisions d on d.id = b.division_id
      join competitions c on c.id = d.competition_id
     order by b.rank, b.id
     limit 1`;
  if (busy) {
    const courtName = courtNames.get(courtId) ?? null;
    refuse(CALL_REFUSAL.COURT_BUSY, `${courtName ?? "this court"} is in use by ${busy.competition_name}`, {
      court_name: courtName,
      competition_name: busy.competition_name,
    });
  }

  await assertPeopleFree(tx, f, courtNames);
  await assertEntrantsFree(tx, f, courtNames);
}

/** PLAYER_BUSY, person by person: a doubles partner on another court is a person of THIS match even when the match they are in
 *  shares no entrant with it. Sees only rostered sides (`entrant_members`); `assertEntrantsFree` covers the rest. */
async function assertPeopleFree(tx: Tx, f: CallTarget, courtNames: ReadonlyMap<string, string>): Promise<void> {
  const people = await peopleByEntrant(
    tx,
    [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
  );
  const mine = peopleOf(f, people);
  if (mine.length === 0) return;
  const theirs = await tx<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null; court_id: string | null }[]>`
    with entrants_of_mine as (
      select distinct entrant_id from entrant_members where person_id in ${tx(mine)}
    )
    select g.id, g.home_entrant_id, g.away_entrant_id, g.court_id, 0 as rank
      from fixtures g
     where g.status = ${IN_PLAY} and g.id <> ${f.id}
       and (g.home_entrant_id in (select entrant_id from entrants_of_mine)
            or g.away_entrant_id in (select entrant_id from entrants_of_mine))
    union all
    select g.id, g.home_entrant_id, g.away_entrant_id, fc.court_id, 1 as rank
      from fixture_calls fc join fixtures g on g.id = fc.fixture_id
     where ${liveCallSql(tx)} and g.id <> ${f.id}
       and (g.home_entrant_id in (select entrant_id from entrants_of_mine)
            or g.away_entrant_id in (select entrant_id from entrants_of_mine))
     order by rank, id`;
  if (theirs.length === 0) return;
  const theirPeople = await peopleByEntrant(tx, [
    ...new Set(theirs.flatMap((g) => [g.home_entrant_id, g.away_entrant_id]).filter((e): e is string => e !== null)),
  ]);
  // Where each busy person is: the first of their matches in the order above (playing before called).
  const courtOf = new Map<string, string | null>();
  for (const personId of mine) {
    const busyIn = theirs.find((g) => peopleOf(g, theirPeople).includes(personId));
    if (busyIn !== undefined) courtOf.set(personId, busyIn.court_id);
  }
  if (courtOf.size === 0) return;
  // One person is named; by name, so the answer never depends on the order the roster rows come back in.
  const [p] = await tx<{ id: string; full_name: string }[]>`
    select id, full_name from persons where id in ${tx([...courtOf.keys()])} order by full_name, id limit 1`;
  if (!p) throw new Error("match-day call: a busy person has no persons row");
  const busyCourt = courtOf.get(p.id) ?? null;
  const busyCourtName = busyCourt !== null ? (courtNames.get(busyCourt) ?? null) : null;
  refuse(CALL_REFUSAL.PLAYER_BUSY, `${p.full_name} is on ${busyCourtName ?? "another court"}`, {
    person_name: p.full_name,
    court_name: busyCourtName,
  });
}

/** PLAYER_BUSY, entrant by entrant: a side of this match that is itself in a match playing, or called, elsewhere. In ADDITION to
 *  the person check, for the side that check cannot see: a roster is optional (a name-only team or player has no members), and
 *  such a side is still one set of people who cannot be on two courts. Named by the entrant's own name. */
async function assertEntrantsFree(tx: Tx, f: CallTarget, courtNames: ReadonlyMap<string, string>): Promise<void> {
  const sides = [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null);
  if (sides.length === 0) return;
  const [busy] = await tx<{ entrant_name: string; court_id: string | null }[]>`
    select e.display_name as entrant_name, b.court_id
      from (
        select g.home_entrant_id, g.away_entrant_id, g.court_id, 0 as rank
          from fixtures g
         where g.status = ${IN_PLAY} and g.id <> ${f.id}
           and (g.home_entrant_id in ${tx(sides)} or g.away_entrant_id in ${tx(sides)})
        union all
        select g.home_entrant_id, g.away_entrant_id, fc.court_id, 1 as rank
          from fixture_calls fc join fixtures g on g.id = fc.fixture_id
         where ${liveCallSql(tx)} and g.id <> ${f.id}
           and (g.home_entrant_id in ${tx(sides)} or g.away_entrant_id in ${tx(sides)})
      ) b
      join entrants e on e.id in (b.home_entrant_id, b.away_entrant_id) and e.id in ${tx(sides)}
     order by b.rank, e.display_name, e.id
     limit 1`;
  if (!busy) return;
  const busyCourtName = busy.court_id !== null ? (courtNames.get(busy.court_id) ?? null) : null;
  refuse(CALL_REFUSAL.PLAYER_BUSY, `${busy.entrant_name} is on ${busyCourtName ?? "another court"}`, {
    person_name: busy.entrant_name,
    court_name: busyCourtName,
  });
}

/**
 * Call a match onto a court, now. Writes the fixture's court, its venue (the court's, never the caller's) and `scheduled_at`
 * directly, and records the slot it held before, for Undo call. Calling a match whose call still holds moves it to the new
 * court and keeps the FIRST previous slot, so one Undo always takes it back to where it was before Match Day touched it. A call
 * that no longer holds (the board has moved the match since) is history: the slot recorded is the one the board left.
 *
 * Deliberately NOT refused on a frozen division (`schedule_locked`, moveFixture's 422 SCHEDULE_LOCKED): the freeze guards
 * planning edits, and the day must still run (controller ruling R-m3, 2026-10-31).
 */
export async function callFixtureToCourt(
  auth: AuthCtx,
  fixtureId: string,
  courtId: string,
  now: Date = new Date(),
): Promise<{ fixture_id: string; court_id: string; called_at: string }> {
  const out = await withTenant(auth.orgId, async (tx) => {
    const f = await readFixture(tx, auth.orgId, fixtureId, true);
    const court = await targetCourt(tx, courtId);
    const courtNames = await courtNamesById(tx);
    await assertCallable(tx, f, court.id, courtNames);

    const held = await readCall(tx, f.id);
    const prev = held?.live
      ? { court: held.prev_court_id, venue: held.prev_venue_id, at: held.prev_scheduled_at }
      : { court: f.court_id, venue: f.venue_id, at: f.scheduled_at };
    await tx`
      update fixtures set court_id = ${court.id}, venue_id = ${court.venue_id}, scheduled_at = ${now}
       where id = ${f.id}`;
    await tx`
      insert into fixture_calls
        (fixture_id, org_id, court_id, called_at, called_by, prev_court_id, prev_venue_id, prev_scheduled_at)
      values
        (${f.id}, ${auth.orgId}, ${court.id}, ${now}, ${auth.userId}, ${prev.court}, ${prev.venue}, ${prev.at})
      on conflict (fixture_id) do update
        set court_id = excluded.court_id, called_at = excluded.called_at, called_by = excluded.called_by,
            prev_court_id = excluded.prev_court_id, prev_venue_id = excluded.prev_venue_id,
            prev_scheduled_at = excluded.prev_scheduled_at`;
    await recordScheduleEdit(tx, f, { at: now, court: court.id, venue: court.venue_id });
    return { divisionId: f.division_id, competitionId: f.competition_id };
  });
  // The called match's court and time changed: drop its public cache keys and refresh open boards, as every schedule write does.
  afterScheduleWrite(out.divisionId, out.competitionId, "schedule", [fixtureId]);
  return { fixture_id: fixtureId, court_id: courtId, called_at: now.toISOString() };
}

/**
 * Undo call: the match goes back to the court, venue and time it had before it was called, nulls included (a match that had no
 * court has none again), and the call is gone. Refused once the match has started: a playing match stays where it is playing.
 * Refused NOT_CALLED when the call no longer holds (the board has moved the match since): the board's edit is the match's place
 * now, and Undo call must not write over it. Like the call, not refused on a frozen division.
 */
export async function undoCall(
  auth: AuthCtx,
  fixtureId: string,
): Promise<{ fixture_id: string; court_id: string | null; scheduled_at: string | null }> {
  const out = await withTenant(auth.orgId, async (tx) => {
    const f = await readFixture(tx, auth.orgId, fixtureId, true);
    const call = await readCall(tx, f.id);
    if (!call) refuse(CALL_REFUSAL.NOT_CALLED, "this match is not called");
    assertUnstarted(f);
    if (!call.live) refuse(CALL_REFUSAL.NOT_CALLED, "this match has been moved since it was called");
    await tx`
      update fixtures
         set court_id = ${call.prev_court_id}, venue_id = ${call.prev_venue_id}, scheduled_at = ${call.prev_scheduled_at}
       where id = ${f.id}`;
    await tx`delete from fixture_calls where fixture_id = ${f.id}`;
    await recordScheduleEdit(tx, f, { at: call.prev_scheduled_at, court: call.prev_court_id, venue: call.prev_venue_id });
    return {
      divisionId: f.division_id,
      competitionId: f.competition_id,
      court: call.prev_court_id,
      at: call.prev_scheduled_at === null ? null : new Date(call.prev_scheduled_at).toISOString(),
    };
  });
  afterScheduleWrite(out.divisionId, out.competitionId, "schedule", [fixtureId]);
  return { fixture_id: fixtureId, court_id: out.court, scheduled_at: out.at };
}

/**
 * The knock-on of calling `fixtureId` onto `courtId` now, before the organiser confirms (§7.1). Writes nothing. Refuses with
 * the same hard stops as the call itself, so a preview never offers a call that would be refused.
 *
 *  - shifts: the target court's unstarted matches today (the org's day, any competition: another competition's planned match
 *    on a shared court is part of the queue), in planned order, whose estimate moves past their planned time. Estimate =
 *    max(planned, estimated end of the match before it), the called match first; each match runs its own division's
 *    `matchMinutes`, the length the scheduler places it with.
 *  - pushes_later: how many shifted.
 *  - rest_gap: per player of the called match, when the gap to their previous match's finish or to their next match's planned
 *    start is under the division's `perEntrantMinRest`. Only when the division declares one.
 *  - past_day_end: the queue's estimated end is after the court's last closing time today (court_hours/court_exceptions in the
 *    org's zone; a court with no hours is open to midnight).
 */
export async function previewCall(
  auth: AuthCtx,
  fixtureId: string,
  courtId: string,
  now: Date = new Date(),
): Promise<CallPreview> {
  return withTenant(auth.orgId, async (tx) => {
    const f = await readFixture(tx, auth.orgId, fixtureId, false);
    const court = await targetCourt(tx, courtId);
    const courtNames = await courtNamesById(tx);
    await assertCallable(tx, f, court.id, courtNames);

    const settings = await loadSettings(tx, f.division_id);
    const minutesByDivision = new Map<string, number>([[f.division_id, settings.config.matchMinutes]]);
    const matchMinutesOf = async (divisionId: string): Promise<number> => {
      const known = minutesByDivision.get(divisionId);
      if (known !== undefined) return known;
      const minutes = (await loadSettings(tx, divisionId)).config.matchMinutes;
      minutesByDivision.set(divisionId, minutes);
      return minutes;
    };
    const tz = settings.orgTz;
    const start = now.getTime();
    const day = dayKeyInTz(start, tz);
    const dayFrom = zonedTimeToUtc(day, "00:00", tz);
    const dayTo = zonedTimeToUtc(ymdAddDays(day, 1), "00:00", tz);
    const calledEnd = start + settings.config.matchMinutes * MS_PER_MIN;

    const queue = await tx<
      { id: string; division_id: string; scheduled_at: Date; home_name: string | null; away_name: string | null }[]
    >`
      select f.id, f.division_id, f.scheduled_at, h.display_name as home_name, a.display_name as away_name
        from fixtures f
        left join entrants h on h.id = f.home_entrant_id
        left join entrants a on a.id = f.away_entrant_id
       where f.court_id = ${court.id} and f.status = ${MOVABLE_STATUS} and f.id <> ${f.id}
         and f.scheduled_at >= ${new Date(dayFrom)} and f.scheduled_at < ${new Date(dayTo)}
       order by f.scheduled_at, f.id`;
    const shifts: CallShift[] = [];
    let cursor = calledEnd;
    for (const q of queue) {
      const planned = new Date(q.scheduled_at).getTime();
      const estimated = Math.max(planned, cursor);
      if (estimated > planned) {
        shifts.push({
          fixture_id: q.id,
          // A side still to be decided has no name yet: the em dash, never an English placeholder.
          label: `${q.home_name ?? "—"} v ${q.away_name ?? "—"}`,
          planned_at: iso(planned),
          estimated_at: iso(estimated),
        });
      }
      cursor = estimated + (await matchMinutesOf(q.division_id)) * MS_PER_MIN;
    }

    const warnings: CallWarning[] = [];
    if (shifts.length > 0) warnings.push({ kind: "pushes_later", count: shifts.length });
    warnings.push(...(await restGaps(tx, f, start, calledEnd, settings.config.perEntrantMinRest)));

    const [calendar] = await resolveCourtCalendars(tx, [court.id]);
    const windows = usableWindows(calendar ?? { courtId: court.id, hours: [], exceptions: [] }, { from: day, to: day }, { tz });
    if (windows.length > 0) {
      const closes = Math.max(...windows.map((w) => w.to));
      if (cursor > closes) {
        warnings.push({ kind: "past_day_end", court_name: courtNames.get(court.id) ?? "", until: iso(closes) });
      }
    }
    return { shifts, warnings };
  });
}

/** §7.2's rest warning, per player of the called match (person-level, every competition of the org). The gap before is from
 *  the player's last finished match (`finished_at`; a cancelled match was not played, so it gives no rest to count from); the
 *  gap after is to their next unstarted match's PLANNED start (ruling B: planned times are what players are told). */
async function restGaps(
  tx: Tx,
  f: CallTarget,
  start: number,
  end: number,
  minRest: number,
): Promise<CallWarning[]> {
  if (minRest <= 0) return [];
  const people = await peopleByEntrant(
    tx,
    [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
  );
  const mine = peopleOf(f, people);
  if (mine.length === 0) return [];
  const rows = await tx<{ person_id: string; full_name: string; last_finish: Date | null; next_start: Date | null }[]>`
    select p.id as person_id, p.full_name,
           max(g.finished_at) filter (where g.finished_at is not null and g.finished_at <= ${new Date(start)}
                                        and g.status <> 'cancelled') as last_finish,
           min(g.scheduled_at) filter (where g.status = ${MOVABLE_STATUS} and g.scheduled_at >= ${new Date(start)}) as next_start
      from persons p
      left join entrant_members em on em.person_id = p.id
      left join fixtures g on (g.home_entrant_id = em.entrant_id or g.away_entrant_id = em.entrant_id) and g.id <> ${f.id}
     where p.id in ${tx(mine)}
     group by p.id, p.full_name`;
  const byId = new Map(rows.map((r) => [r.person_id, r]));
  const out: CallWarning[] = [];
  for (const personId of mine) {
    const r = byId.get(personId);
    if (!r) continue;
    const gaps = [
      ...(r.last_finish !== null ? [start - new Date(r.last_finish).getTime()] : []),
      ...(r.next_start !== null ? [new Date(r.next_start).getTime() - end] : []),
    ];
    if (gaps.length === 0) continue;
    const gap = Math.max(0, Math.min(...gaps));
    if (gap < minRest * MS_PER_MIN) {
      out.push({ kind: "rest_gap", person_name: r.full_name, minutes: Math.floor(gap / MS_PER_MIN), min_rest: minRest });
    }
  }
  return out;
}
