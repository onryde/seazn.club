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
//  - the target court is not one the match's division may play on: the scheduler's own candidate set for the match
//    (`callableCourtsByFixture`, below: court-candidates.ts's resolver, per match) (NOT_CANDIDATE_COURT; B4 fix round 1, R1);
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
import { estimateQueue } from "@/lib/match-day/estimate";
import { resolveVenueTz } from "@/lib/tz";
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
import { candidateCourtsByFixture, requiredCourtTagsByFixture, resolveCourtCalendars } from "./court-candidates";
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
/** The one status a match is playing in. A single literal: the in-play half of each busy question below (and of Match Day's
 *  read model, match-day.ts). */
export const IN_PLAY = "in_play";
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

/** The day `now` falls on in `tz`, as the instants [from, to). */
export function todayIn(tz: string, now: Date): { day: string; from: Date; to: Date } {
  const day = dayKeyInTz(now.getTime(), tz);
  return {
    day,
    from: new Date(zonedTimeToUtc(day, "00:00", tz)),
    to: new Date(zonedTimeToUtc(ymdAddDays(day, 1), "00:00", tz)),
  };
}

/** One division's "today", as the instants [from, to). */
export interface DivisionDay {
  division_id: string;
  from: Date;
  to: Date;
}

/**
 * Match Day's "today" is decided per match, in the match's own zone: its division's venue zone, else the organisation's, else
 * UTC (`resolveVenueTz` — the zone the competition desk reads the same division's match_day phase in, so the two never
 * disagree about which matches are today's; controller ruling I2, Match Day task A2). One authority for the call preview's
 * queue and the read model's (match-day.ts). `where` picks the divisions (alias `d`); `orgTz` is the organisation's zone.
 */
export async function divisionDays(tx: Tx, orgTz: string | null, now: Date, where: postgres.Fragment): Promise<DivisionDay[]> {
  const rows = await tx<{ id: string; tz: string | null }[]>`
    select d.id, ss.tz from divisions d left join schedule_settings ss on ss.division_id = d.id where ${where}`;
  return rows.map((r) => {
    const { from, to } = todayIn(resolveVenueTz(r.tz, orgTz), now);
    return { division_id: r.id, from, to };
  });
}

/** The days as a table to join a match's division on: `w(division_id, day_from, day_to)`. A match is today when its
 *  `scheduled_at` is in [w.day_from, w.day_to). */
export function dayTable(tx: Tx, days: readonly DivisionDay[]): postgres.Fragment {
  return tx`unnest(${days.map((d) => d.division_id)}::uuid[],
                   ${days.map((d) => d.from.toISOString())}::timestamptz[],
                   ${days.map((d) => d.to.toISOString())}::timestamptz[]) as w(division_id, day_from, day_to)`;
}

/** The target court, which must be this org's (RLS) and not archived: a court a match can be called onto. */
export async function targetCourt(tx: Tx, courtId: string): Promise<{ id: string; venue_id: string }> {
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

/**
 * The courts each match may be called onto (B4 fix round 1, R1; spec §7 "Which courts"): the SCHEDULER's own candidate set for
 * it — the division's configured courts (an empty list is every court of the organisation), narrowed by the tags its division,
 * stage and round require, archived courts out — through `requiredCourtTagsByFixture` + `candidateCourtsByFixture`, the pair the
 * build, the validate and the AI pack resolve through (court-candidates.ts), so a call and the board never disagree about where
 * a match may play. Match Day's candidate lists and its "Find a court" ask the same question here. A match the resolver gives
 * no set reads as no court at all: it fails closed.
 */
export async function callableCourtsByFixture(
  tx: Tx,
  rows: readonly { id: string; division_id: string }[],
): Promise<Map<string, ReadonlySet<string>>> {
  const byDivision = new Map<string, string[]>();
  for (const r of rows) {
    const ids = byDivision.get(r.division_id);
    if (ids === undefined) byDivision.set(r.division_id, [r.id]);
    else ids.push(r.id);
  }
  const out = new Map<string, ReadonlySet<string>>();
  for (const [divisionId, ids] of byDivision) {
    const [division] = await tx<{ required_court_tags: string[] | null }[]>`
      select required_court_tags from divisions where id = ${divisionId}`;
    const settings = await loadSettings(tx, divisionId);
    const tags = await requiredCourtTagsByFixture(tx, divisionId, division?.required_court_tags ?? []);
    const allowed = await candidateCourtsByFixture(tx, divisionId, settings.config.courts, tags);
    for (const id of ids) out.set(id, new Set(allowed.get(id) ?? []));
  }
  return out;
}

/** §7.2's hard stops, in the order a person reads them: the match itself, the court, then its players. */
async function assertCallable(tx: Tx, f: CallTarget, courtId: string, courtNames: ReadonlyMap<string, string>): Promise<void> {
  assertUnstarted(f);
  if (f.home_entrant_id === null || f.away_entrant_id === null) {
    refuse(CALL_REFUSAL.NOT_CALLABLE, "a side of this match is still to be decided", { status: TBD_ENTRANT });
  }

  // The court, first: may this match's division play on it at all (R1)? One tap must not put a match on another sport's venue.
  if (!(await callableCourtsByFixture(tx, [f])).get(f.id)?.has(courtId)) {
    const courtName = courtNames.get(courtId) ?? null;
    refuse(CALL_REFUSAL.NOT_CANDIDATE_COURT, `${courtName ?? "this court"} is not one of this division's courts`, {
      court_name: courtName,
    });
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

  const holder = (await whoIsBusy(tx, [f])).get(f.id);
  if (holder !== undefined) {
    const busyCourtName = holder.court_id !== null ? (courtNames.get(holder.court_id) ?? null) : null;
    refuse(CALL_REFUSAL.PLAYER_BUSY, `${holder.name} is on ${busyCourtName ?? "another court"}`, {
      person_name: holder.name,
      court_name: busyCourtName,
    });
  }
}

/** A match that holds its people, and its sides, right now: playing (`in_play`), or called with the call still holding
 *  (`liveCallSql`), anywhere in the org (RLS). rank 0 = playing, 1 = called; a called match holds its call's court. In the
 *  order the busy questions name them: playing before called, then by id. */
interface HeldMatch {
  id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  court_id: string | null;
  rank: number;
}

async function heldMatches(tx: Tx): Promise<HeldMatch[]> {
  return tx<HeldMatch[]>`
    select g.id, g.home_entrant_id, g.away_entrant_id, g.court_id, 0 as rank
      from fixtures g
     where g.status = ${IN_PLAY}
    union all
    select g.id, g.home_entrant_id, g.away_entrant_id, fc.court_id, 1 as rank
      from fixture_calls fc join fixtures g on g.id = fc.fixture_id
     where ${liveCallSql(tx)}
     order by rank, id`;
}

/** Who keeps a match off a court: the name PLAYER_BUSY gives, and the court the busy match holds (null when it has none). */
export interface BusyHolder {
  name: string;
  court_id: string | null;
}

const sidesOf = (f: { home_entrant_id: string | null; away_entrant_id: string | null }): string[] =>
  [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null);

/**
 * PLAYER_BUSY's ONE judge (§7.2), for one match (a call, its preview) or many (Match Day's candidates): for each match, who
 * is in a match playing, or called, elsewhere — never the match itself. Two arms, the person arm first:
 *  - by PERSON, through the scheduler's own `peopleByEntrant` + `peopleOf`: a doubles partner on another court is a person of
 *    this match even when the two matches share no entrant. Several busy: the first by `full_name` (in the database's own
 *    order, so the answer never depends on the order roster rows come back in), on the first of their matches in held order;
 *  - by ENTRANT, for the side the person arm cannot see: a roster is optional (a name-only team or player has no members), and
 *    such a side is still one set of people who cannot be on two courts. Named by the entrant's own name; playing before
 *    called, then by name.
 * Matches nothing holds are absent from the answer.
 */
export async function whoIsBusy(
  tx: Tx,
  fixtures: readonly { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[],
): Promise<Map<string, BusyHolder>> {
  const out = new Map<string, BusyHolder>();
  if (fixtures.length === 0) return out;
  const held = await heldMatches(tx);
  if (held.length === 0) return out;
  const people = await peopleByEntrant(tx, [...new Set([...fixtures.flatMap(sidesOf), ...held.flatMap(sidesOf)])]);
  const heldPeople = held.map((g) => new Set(peopleOf(g, people)));

  // The person arm: per match, each busy person and the court of the first held match they are in.
  const busyPeople = new Map<string, Map<string, string | null>>();
  for (const f of fixtures) {
    const where = new Map<string, string | null>();
    for (const personId of peopleOf(f, people)) {
      const i = held.findIndex((g, k) => g.id !== f.id && heldPeople[k]!.has(personId));
      if (i >= 0) where.set(personId, held[i]!.court_id);
    }
    if (where.size > 0) busyPeople.set(f.id, where);
  }
  if (busyPeople.size > 0) {
    const ids = [...new Set([...busyPeople.values()].flatMap((m) => [...m.keys()]))];
    const named = await tx<{ id: string; full_name: string }[]>`
      select id, full_name from persons where id in ${tx(ids)} order by full_name, id`;
    for (const [fixtureId, where] of busyPeople) {
      const p = named.find((r) => where.has(r.id));
      if (!p) throw new Error("match-day: a busy person has no persons row");
      out.set(fixtureId, { name: p.full_name, court_id: where.get(p.id) ?? null });
    }
  }

  // The entrant arm, for every match the person arm left free.
  const rest = fixtures.filter((f) => !out.has(f.id));
  const restSides = [...new Set(rest.flatMap(sidesOf))];
  if (restSides.length === 0) return out;
  const entrants = await tx<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where id in ${tx(restSides)} order by display_name, id`;
  const nameOrder = new Map(entrants.map((e, i) => [e.id, i]));
  for (const f of rest) {
    let best: { rank: number; order: number; name: string; court_id: string | null } | null = null;
    for (const g of held) {
      if (g.id === f.id) continue;
      for (const e of sidesOf(f)) {
        if (e !== g.home_entrant_id && e !== g.away_entrant_id) continue;
        const order = nameOrder.get(e);
        if (order === undefined) throw new Error("match-day: a busy side has no entrants row");
        if (best === null || g.rank < best.rank || (g.rank === best.rank && order < best.order)) {
          best = { rank: g.rank, order, name: entrants[order]!.display_name, court_id: g.court_id };
        }
      }
    }
    if (best !== null) out.set(f.id, { name: best.name, court_id: best.court_id });
  }
  return out;
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
 *  - shifts: the target court's unstarted matches today (each on its own division's day, `divisionDays`; any competition:
 *    another competition's planned match on a shared court is part of the queue), in planned order, whose estimate moves past their planned time. Estimate =
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
    const { day } = todayIn(tz, now); // the court's hours are read on the organisation's day
    // Every division's day (any competition's match on the court is part of the queue), archived ones too: a court's occupancy
    // is org-wide.
    const days = await divisionDays(tx, tz, now, tx`true`);
    const calledEnd = start + settings.config.matchMinutes * MS_PER_MIN;

    const queue = await tx<
      { id: string; division_id: string; scheduled_at: Date; home_name: string | null; away_name: string | null }[]
    >`
      select f.id, f.division_id, f.scheduled_at, h.display_name as home_name, a.display_name as away_name
        from fixtures f
        join ${dayTable(tx, days)} on w.division_id = f.division_id
        left join entrants h on h.id = f.home_entrant_id
        left join entrants a on a.id = f.away_entrant_id
       where f.court_id = ${court.id} and f.status = ${MOVABLE_STATUS} and f.id <> ${f.id}
         and f.scheduled_at >= w.day_from and f.scheduled_at < w.day_to
       order by f.scheduled_at, f.id`;
    // The called match runs first, from now; the queue then runs through Match Day's one estimate (lib/match-day/estimate.ts).
    const planned: { id: string; planned_at: Date; match_minutes: number }[] = [];
    for (const q of queue) {
      planned.push({ id: q.id, planned_at: new Date(q.scheduled_at), match_minutes: await matchMinutesOf(q.division_id) });
    }
    const estimates = estimateQueue(planned, new Date(calledEnd), settings.config.matchMinutes);
    const estimateOf = (id: string): number => {
      const e = estimates.get(id);
      if (e === undefined) throw new Error(`previewCall: no estimate for queued match ${id}`);
      return e.getTime();
    };
    const shifts: CallShift[] = [];
    for (const q of queue) {
      const plannedAt = new Date(q.scheduled_at).getTime();
      const estimated = estimateOf(q.id);
      if (estimated > plannedAt) {
        shifts.push({
          fixture_id: q.id,
          // A side still to be decided has no name yet: the em dash, never an English placeholder.
          label: `${q.home_name ?? "—"} v ${q.away_name ?? "—"}`,
          planned_at: iso(plannedAt),
          estimated_at: iso(estimated),
        });
      }
    }
    // Where the court's queue ends: the latest estimated end, the called match's own when the queue is empty.
    const cursor = Math.max(calledEnd, ...planned.map((p) => estimateOf(p.id) + p.match_minutes * MS_PER_MIN));

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
