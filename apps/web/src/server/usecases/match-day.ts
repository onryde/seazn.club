import "server-only";
// Match Day: the read model (spec docs/superpowers/specs/2026-10-31-match-day-design.md §6.2, §7, §7.1). Reads only.
//
//  - The court list (§7 "Which courts") is the union of every division's candidate courts (`resolveCandidateCourts`, the one
//    resolver the scheduler uses) and every court holding one of this competition's matches today.
//  - A court's state comes from its matches' STATUS, from ANY competition: courts are org-level. A match `in_play` on it, or a
//    call that still holds (`liveCallSql`, A1's one liveness predicate). A call row whose match has since started, or ended,
//    holds nothing as a call: the status, not the row, decides (task A2, Review Focus 4).
//  - A queue is the court's unstarted, uncalled matches planned today, in planned order. Its "~" times are estimated at read
//    time through `estimateQueue` (lib/match-day/estimate.ts), the same function the call preview uses; planned times are never
//    written (owner ruling B). Another competition's planned match on a shared court counts toward the estimates and is never
//    listed: it is not controllable from here.
//  - "Today" is decided PER MATCH, on its own division's day: the venue zone, else the organisation's, else UTC (`divisionDays`,
//    `resolveVenueTz` — the zone the desk reads the same division's match_day phase in; controller ruling I2). The call preview
//    reads its queue through the same `divisionDays`. The view's `date` label alone is the organisation's day.
//  - An archived division is gone from the competition, as on the desk (`listDivisions` lists live divisions only): it adds
//    no court, no queue row, no candidate and no count. What holds a court stays org-wide, archived divisions' matches
//    included: a match of an archived division still in play still holds its court, and is still this competition's.
//  - Candidates for a free court (§7) are ranked by `rankCandidates`; a player busy elsewhere is judged by A1's `whoIsBusy`,
//    the same judge a call refuses PLAYER_BUSY by.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DEFAULT_LOCALE, getDictionary, type Locale } from "@/lib/i18n";
import { estimateQueue, rankCandidates } from "@/lib/match-day/estimate";
import type {
  MatchDayCandidate,
  MatchDayCourt,
  MatchDayCourtState,
  MatchDayFixture,
  MatchDayQueued,
  MatchDaySummary,
  MatchDayView,
} from "@/lib/match-day/types";
import { resolveVenueTz } from "@/lib/tz";
import { venueNoun } from "@/lib/venue";
import { needsYouItems } from "@/components/v2/desk/needs-you";
import type { AuthCtx } from "@/server/api-v1/auth";
import { defaultMatchMinutes, getCompetitionDesk } from "./competition-desk";
import { resolveCandidateCourts } from "./court-candidates";
import { listDivisions } from "./divisions";
import { dayTable, divisionDays, IN_PLAY, liveCallSql, targetCourt, todayIn, whoIsBusy } from "./match-day-call";
import { courtNamesById, loadSettings, MOVABLE_STATUS } from "./schedule";
import { openStreamStates } from "./stream-sessions";
import { servingSideOf, sportReadsServe } from "@/server/engine-db/serving";

type Tx = postgres.TransactionSql;
type Serving = MatchDayFixture["serving"];

const MS_PER_MIN = 60_000;
/** A cancelled match was never played: it is no match of the day, and it never freed a court. */
const CANCELLED = "cancelled";
/** The stage status whose ready matches are "no court yet" candidates (§7: "the competition's active stages"). */
const ACTIVE_STAGE = "active";

const iso = (d: Date | null): string | null => (d === null ? null : new Date(d).toISOString());
const wholeMinutes = (ms: number): number => Math.max(0, Math.floor(ms / MS_PER_MIN));

/**
 * How many of this competition's matches are today, at `now`. Each match is on its OWN division's day: the division's venue
 * zone, else the organisation's, else UTC (`divisionDays` — the zone the desk's match_day phase reads that division in, so the
 * two agree; controller ruling I2: no zone parameter, because there is no one zone to pass). Counted: a match planned within
 * its division's day, and a match in play whatever its planned day (a match being played is a match today; ruling m5). Not
 * counted: a cancelled match, or any match of an archived division (I1). Shared with the competition desk (ruling R2): one
 * count, two surfaces.
 */
export async function countFixturesToday(tx: Tx, competitionId: string, now: Date): Promise<number> {
  const [org] = await tx<{ timezone: string | null }[]>`
    select o.timezone from competitions c join organizations o on o.id = c.org_id where c.id = ${competitionId}`;
  const days = await divisionDays(tx, org?.timezone ?? null, now, tx`d.competition_id = ${competitionId} and d.archived_at is null`);
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from fixtures f join ${dayTable(tx, days)} on w.division_id = f.division_id
     where f.status <> ${CANCELLED}
       and ((f.scheduled_at >= w.day_from and f.scheduled_at < w.day_to) or f.status = ${IN_PLAY})`;
  return row?.n ?? 0;
}

interface CompRow {
  id: string;
  name: string;
  slug: string;
  org_slug: string;
  org_tz: string | null;
}

interface DivisionRow {
  id: string;
  name: string;
  sport_key: string;
  required_court_tags: string[];
  tz: string | null;
}

/** One of this competition's matches, as the board reads it. */
interface FixtureRow {
  id: string;
  division_id: string;
  division_name: string;
  division_slug: string;
  sport_key: string;
  stage_name: string;
  stage_status: string;
  status: string;
  court_id: string | null;
  scheduled_at: Date | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home: string | null;
  away: string | null;
  round_no: number | null;
  fixture_no: number;
  headline: string | null;
  /** `match_states.summary`, whole (jsonb). */
  summary: MatchDaySummary | null;
  started_at: Date | null;
  /** Its call's time while the call holds; null otherwise. */
  called_at: Date | null;
}

/** What holds a court now, from any competition: a match playing (rank 0) or a call that holds (rank 1). */
interface HolderRow {
  id: string;
  court_id: string;
  competition_id: string;
  competition_name: string;
  division_id: string;
  rank: number;
  started_at: Date | null;
}

/** An unstarted, uncalled match planned on a board court today, from any competition. */
interface PlannedRow {
  id: string;
  court_id: string;
  division_id: string;
  scheduled_at: Date;
}

interface BoardQueued {
  row: FixtureRow;
  planned_at: Date;
  estimated_at: Date;
}

interface BoardCourt {
  court_id: string;
  court_name: string;
  venue_name: string;
  state: MatchDayCourtState;
  current: FixtureRow | null;
  in_use_by: string | null;
  free_since: Date | null;
  /** This competition's queued matches, in planned order, with their estimates. */
  queue: BoardQueued[];
  /** The first division (competition order) with this court among its candidate courts. */
  candidate_sport: string | null;
}

interface Board {
  comp: CompRow;
  tz: string;
  day: string;
  courts: BoardCourt[];
  /** This competition's ready "no court yet" matches, in order; read only when asked for. */
  noCourt: FixtureRow[];
  courtNames: Map<string, string>;
}

/** The board: everything the view and the candidates read, in one tenant transaction. */
async function readBoard(tx: Tx, competitionId: string, now: Date, opts: { noCourt: boolean }): Promise<Board> {
  const [comp] = await tx<CompRow[]>`
    select c.id, c.name, c.slug, o.slug as org_slug, o.timezone as org_tz
      from competitions c join organizations o on o.id = c.org_id
     where c.id = ${competitionId}`;
  if (!comp) throw new HttpError(404, "competition not found");
  const tz = resolveVenueTz(null, comp.org_tz);
  const { day } = todayIn(tz, now); // the label: the organisation's day

  // The competition's live divisions, as `listDivisions` lists them (not archived; created_at, id), each with its candidate
  // courts, match length and day. An archived division is not in the competition any more (I1).
  const divisions = await tx<DivisionRow[]>`
    select d.id, d.name, d.sport_key, d.required_court_tags, ss.tz
      from divisions d left join schedule_settings ss on ss.division_id = d.id
     where d.competition_id = ${competitionId} and d.archived_at is null
     order by d.created_at, d.id`;
  const liveDivisions = new Set(divisions.map((d) => d.id));
  const compDays = divisions.map((d) => ({ division_id: d.id, ...todayIn(resolveVenueTz(d.tz, comp.org_tz), now) }));
  // Every division of the organisation's day, archived ones too: what holds a court, and what is planned on it, is org-wide.
  const orgDays = await divisionDays(tx, comp.org_tz, now, tx`true`);
  const minutesByDivision = new Map<string, number>();
  const candidateDivision = new Map<string, string>(); // court id -> the first division's sport
  for (const d of divisions) {
    const settings = await loadSettings(tx, d.id);
    minutesByDivision.set(d.id, settings.config.matchMinutes);
    const candidates = await resolveCandidateCourts(tx, d.id, settings.config.courts, d.required_court_tags ?? []);
    for (const courtId of candidates.ids) if (!candidateDivision.has(courtId)) candidateDivision.set(courtId, d.sport_key);
  }
  const minutesOf = async (divisionId: string): Promise<number> => {
    const known = minutesByDivision.get(divisionId);
    if (known !== undefined) return known;
    const minutes = (await loadSettings(tx, divisionId)).config.matchMinutes;
    minutesByDivision.set(divisionId, minutes);
    return minutes;
  };

  const liveCallOf = (fixture: postgres.Fragment) => tx`
    (select fc.called_at from fixture_calls fc join fixtures g on g.id = fc.fixture_id
      where fc.fixture_id = ${fixture} and ${liveCallSql(tx)})`;
  const rows = await tx<FixtureRow[]>`
    select f.id, f.division_id, d.name as division_name, d.slug as division_slug, d.sport_key, s.name as stage_name,
           s.status as stage_status,
           f.status, f.court_id, f.scheduled_at, f.home_entrant_id, f.away_entrant_id,
           h.display_name as home, a.display_name as away, f.round_no, f.fixture_no,
           ms.summary->>'headline' as headline, ms.summary,
           (select min(se.recorded_at) from score_events se where se.fixture_id = f.id and se.type = 'core.start') as started_at,
           ${liveCallOf(tx`f.id`)} as called_at
      from fixtures f
      join divisions d on d.id = f.division_id
      join stages s on s.id = f.stage_id
      left join entrants h on h.id = f.home_entrant_id
      left join entrants a on a.id = f.away_entrant_id
      left join match_states ms on ms.fixture_id = f.id
      left join ${dayTable(tx, compDays)} on w.division_id = f.division_id
     where d.competition_id = ${competitionId}
       and ((f.scheduled_at >= w.day_from and f.scheduled_at < w.day_to)
            or f.status = ${IN_PLAY}
            or ${liveCallOf(tx`f.id`)} is not null
            ${opts.noCourt
              ? tx`or (f.status = ${MOVABLE_STATUS} and f.court_id is null and w.division_id is not null
                       and (f.scheduled_at is null or f.scheduled_at < w.day_to))`
              : tx``})`;
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  // The court set: every live division's candidate courts, and every court one of their matches today is on. A match of an
  // archived division in play (read above: it may hold one of these courts) adds no court of its own.
  const onBoard = new Set([
    ...candidateDivision.keys(),
    ...rows.flatMap((r) => (r.court_id !== null && liveDivisions.has(r.division_id) ? [r.court_id] : [])),
  ]);
  const courtNames = await courtNamesById(tx);
  const orgCourts = await tx<{ id: string; venue_name: string }[]>`
    select c.id, v.name as venue_name from courts c join venues v on v.id = c.venue_id
     order by v.sort, v.name, c.sort, c.name, c.id`;
  const courtIds = orgCourts.filter((c) => onBoard.has(c.id)).map((c) => c.id);
  if (courtIds.length !== onBoard.size) throw new Error("match-day: a board court is not one of the organisation's courts");
  const venueOf = new Map(orgCourts.map((c) => [c.id, c.venue_name]));

  const holders = courtIds.length
    ? await tx<HolderRow[]>`
        select g.id, g.court_id, d.competition_id, c.name as competition_name, g.division_id, 0 as rank,
               (select min(se.recorded_at) from score_events se where se.fixture_id = g.id and se.type = 'core.start') as started_at
          from fixtures g join divisions d on d.id = g.division_id join competitions c on c.id = d.competition_id
         where g.status = ${IN_PLAY} and g.court_id in ${tx(courtIds)}
        union all
        select g.id, fc.court_id, d.competition_id, c.name as competition_name, g.division_id, 1 as rank, null as started_at
          from fixture_calls fc join fixtures g on g.id = fc.fixture_id
          join divisions d on d.id = g.division_id join competitions c on c.id = d.competition_id
         where ${liveCallSql(tx)} and fc.court_id in ${tx(courtIds)}`
    : [];
  const planned = courtIds.length
    ? await tx<PlannedRow[]>`
        select f.id, f.court_id, f.division_id, f.scheduled_at
          from fixtures f join ${dayTable(tx, orgDays)} on w.division_id = f.division_id
         where f.status = ${MOVABLE_STATUS} and f.court_id in ${tx(courtIds)}
           and f.scheduled_at >= w.day_from and f.scheduled_at < w.day_to
           and ${liveCallOf(tx`f.id`)} is null
         order by f.scheduled_at, f.id`
    : [];
  const finished = courtIds.length
    ? await tx<{ court_id: string; at: Date }[]>`
        select f.court_id, max(f.finished_at) as at
          from fixtures f join ${dayTable(tx, orgDays)} on w.division_id = f.division_id
         where f.court_id in ${tx(courtIds)} and f.finished_at is not null and f.status <> ${CANCELLED}
           and f.finished_at >= w.day_from and f.finished_at <= ${now}
         group by f.court_id`
    : [];
  const freeSince = new Map(finished.map((f) => [f.court_id, f.at]));

  const courts: BoardCourt[] = [];
  for (const courtId of courtIds) {
    // Playing before called; this competition's own before another's; then by id.
    const holder =
      holders
        .filter((h) => h.court_id === courtId)
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            Number(a.competition_id !== competitionId) - Number(b.competition_id !== competitionId) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )[0] ?? null;
    let state: MatchDayCourtState = "free";
    let current: FixtureRow | null = null;
    let inUseBy: string | null = null;
    let busyUntil = now.getTime();
    if (holder !== null) {
      const minutes = (await minutesOf(holder.division_id)) * MS_PER_MIN;
      // Playing: until its kick-off plus a match length, and not before now (an overrunning match can end any minute); a
      // kick-off nobody recorded is taken as now. Called: a match length from now, as it has not started.
      busyUntil =
        holder.rank === 0
          ? Math.max(now.getTime(), (holder.started_at === null ? now.getTime() : new Date(holder.started_at).getTime()) + minutes)
          : now.getTime() + minutes;
      if (holder.competition_id === competitionId) {
        state = holder.rank === 0 ? "playing" : "called";
        current = rowsById.get(holder.id) ?? null;
        if (current === null) throw new Error(`match-day: this competition's match ${holder.id} holds a court but was not read`);
      } else {
        state = "in_use_elsewhere";
        inUseBy = holder.competition_name;
      }
    }
    const onCourt = planned.filter((p) => p.court_id === courtId);
    const order = [];
    for (const p of onCourt) {
      order.push({ id: p.id, planned_at: new Date(p.scheduled_at), match_minutes: await minutesOf(p.division_id) });
    }
    const estimates = estimateQueue(order, new Date(busyUntil), defaultMatchMinutes());
    const queue: BoardQueued[] = [];
    for (const p of onCourt) {
      const row = rowsById.get(p.id);
      if (row === undefined) continue; // another competition's planned match: counted above, never listed
      const estimated = estimates.get(p.id);
      if (estimated === undefined) throw new Error(`match-day: no estimate for queued match ${p.id}`);
      queue.push({ row, planned_at: new Date(p.scheduled_at), estimated_at: estimated });
    }
    courts.push({
      court_id: courtId,
      court_name: courtNames.get(courtId) ?? "",
      venue_name: venueOf.get(courtId) ?? "",
      state,
      current,
      in_use_by: inUseBy,
      free_since: state === "free" ? (freeSince.get(courtId) ?? null) : null,
      queue,
      candidate_sport: candidateDivision.get(courtId) ?? null,
    });
  }

  // "No court yet": a ready, unstarted match of an active stage with no court. Planned for no later day than today: the
  // fetch's own no-court arm above is the one place that says so (a later day's match enters `rows` by no other arm).
  const noCourt = opts.noCourt
    ? rows
        .filter(
          (r) =>
            r.status === MOVABLE_STATUS &&
            r.court_id === null &&
            r.stage_status === ACTIVE_STAGE &&
            r.home_entrant_id !== null &&
            r.away_entrant_id !== null,
        )
        .sort(
          (a, b) =>
            (a.scheduled_at === null ? Infinity : new Date(a.scheduled_at).getTime()) -
              (b.scheduled_at === null ? Infinity : new Date(b.scheduled_at).getTime()) ||
            (a.round_no ?? Infinity) - (b.round_no ?? Infinity) ||
            a.fixture_no - b.fixture_no ||
            (a.id < b.id ? -1 : 1),
        )
    : [];
  return { comp, tz, day, courts, noCourt, courtNames };
}

function fixtureView(r: FixtureRow, streams: Record<string, "live" | "waiting">, serving: Serving = null): MatchDayFixture {
  return {
    id: r.id,
    division_id: r.division_id,
    division_name: r.division_name,
    division_slug: r.division_slug,
    fixture_no: r.fixture_no,
    sport_key: r.sport_key,
    stage_label: r.stage_name,
    home: r.home,
    away: r.away,
    home_entrant_id: r.home_entrant_id,
    away_entrant_id: r.away_entrant_id,
    headline: r.headline,
    summary: r.summary ?? null,
    serving,
    started_at: r.status === IN_PLAY ? iso(r.started_at) : null,
    called_at: iso(r.called_at),
    stream: streams[r.id] ?? null,
  };
}

function courtView(c: BoardCourt, streams: Record<string, "live" | "waiting">, serving: ReadonlyMap<string, Serving>): MatchDayCourt {
  const queue: MatchDayQueued[] = c.queue.map((q) => ({
    ...fixtureView(q.row, streams),
    planned_at: q.planned_at.toISOString(),
    estimated_at: q.estimated_at.toISOString(),
  }));
  return {
    court_id: c.court_id,
    court_name: c.court_name,
    venue_name: c.venue_name,
    sport_noun: venueNoun(c.current?.sport_key ?? c.queue[0]?.row.sport_key ?? c.candidate_sport),
    state: c.state,
    current: c.current === null ? null : fixtureView(c.current, streams, serving.get(c.current.id) ?? null),
    in_use_by: c.in_use_by,
    free_since: iso(c.free_since),
    queue,
  };
}

/**
 * Match Day for one competition, now: its courts with what each is doing and its queue, the desk's Needs-you list in the
 * reader's language (`locale`, default English), the results owed, and today's match count. Reads only.
 */
export async function getMatchDay(
  auth: AuthCtx,
  competitionId: string,
  now: Date = new Date(),
  opts: { locale?: Locale } = {},
): Promise<MatchDayView> {
  const { board, fixturesToday, serving } = await withTenant(auth.orgId, async (tx) => {
    const board = await readBoard(tx, competitionId, now, { noCourt: false });
    // Who serves, on this competition's playing courts only, for a sport whose engine reads a serve (S1).
    const serving = new Map<string, Serving>();
    for (const c of board.courts) {
      if (c.state === "playing" && c.current !== null && sportReadsServe(c.current.sport_key)) {
        serving.set(c.current.id, await servingSideOf(tx, c.current.id));
      }
    }
    return { board, fixturesToday: await countFixturesToday(tx, competitionId, now), serving };
  });
  const locale = opts.locale ?? DEFAULT_LOCALE;
  // Each reads through its own connection: none may run inside the tenant transaction above (pool nesting).
  const ids = board.courts.flatMap((c) => [...(c.current ? [c.current.id] : []), ...c.queue.map((q) => q.row.id)]);
  const [streams, desk, divisions, dict] = await Promise.all([
    openStreamStates(auth, ids),
    getCompetitionDesk(auth, competitionId, now),
    listDivisions(auth, competitionId),
    getDictionary(locale, "ui"),
  ]);
  const needs = needsYouItems(
    dict,
    desk,
    divisions.map((d) => ({ id: d.id, name: d.name, slug: d.slug })),
    board.comp.org_slug,
    board.comp.slug,
    locale,
  );
  let resultsOwed = 0;
  for (const d of desk.divisions.values()) {
    for (const a of d.attention) if (a.kind === "result_missing") resultsOwed += a.count;
  }
  return {
    competition_id: competitionId,
    date: board.day,
    tz: board.tz,
    now: now.toISOString(),
    courts: board.courts.map((c) => courtView(c, streams, serving)),
    needs_you: needs,
    results_owed: resultsOwed,
    fixtures_today: fixturesToday,
  };
}

const ready = (r: FixtureRow): boolean => r.home_entrant_id !== null && r.away_entrant_id !== null;

/**
 * The matches that could start on `courtId` now (§7), ranked by `rankCandidates`:
 *  - this_court: the court's own next ready match;
 *  - other_court: every other court's next ready match, and a match called onto another court and not yet started ("it can
 *    also be called to a different free court");
 *  - no_court: ready matches of active stages with no court, planned for no later day than today.
 * A side still to be decided is never a candidate. Each carries how long it would wait where it is and how far behind its plan
 * that is, and a hard stop when a player — a doubles partner counts; for a side with no roster, the side — is in a match playing
 * or called elsewhere (A1's `whoIsBusy`, the judge a call refuses by). 404 for a court that is not the org's, or is archived.
 */
export async function matchDayCandidates(
  auth: AuthCtx,
  competitionId: string,
  courtId: string,
  now: Date = new Date(),
): Promise<MatchDayCandidate[]> {
  const nowMs = now.getTime();
  const { picked, busy, courtNames } = await withTenant(auth.orgId, async (tx) => {
    const board = await readBoard(tx, competitionId, now, { noCourt: true });
    await targetCourt(tx, courtId);
    const picked: {
      row: FixtureRow;
      source: MatchDayCandidate["source"];
      from: string | null;
      waiting: number;
      behind: number;
    }[] = [];
    for (const c of board.courts) {
      const mine = c.court_id === courtId;
      if (!mine && c.state === "called" && c.current !== null && ready(c.current)) {
        picked.push({ row: c.current, source: "other_court", from: c.court_name, waiting: 0, behind: 0 });
      }
      const next = c.queue.find((q) => ready(q.row));
      if (next === undefined) continue;
      picked.push({
        row: next.row,
        source: mine ? "this_court" : "other_court",
        from: mine ? null : c.court_name,
        waiting: wholeMinutes(next.estimated_at.getTime() - nowMs),
        behind: wholeMinutes(next.estimated_at.getTime() - next.planned_at.getTime()),
      });
    }
    for (const r of board.noCourt) {
      picked.push({
        row: r,
        source: "no_court",
        from: null,
        waiting: 0,
        behind: r.scheduled_at === null ? 0 : wholeMinutes(nowMs - new Date(r.scheduled_at).getTime()),
      });
    }
    const busy = await whoIsBusy(tx, picked.map((p) => p.row));
    return { picked, busy, courtNames: board.courtNames };
  });
  const streams = await openStreamStates(auth, picked.map((p) => p.row.id));
  return rankCandidates(
    picked.map((p) => {
      const holder = busy.get(p.row.id);
      return {
        fixture: fixtureView(p.row, streams),
        source: p.source,
        from_court_name: p.from,
        waiting_minutes: p.waiting,
        behind_minutes: p.behind,
        blocked:
          holder === undefined
            ? null
            : {
                kind: "player_busy" as const,
                person_name: holder.name,
                court_name: holder.court_id === null ? null : (courtNames.get(holder.court_id) ?? null),
              },
      };
    }),
  );
}
