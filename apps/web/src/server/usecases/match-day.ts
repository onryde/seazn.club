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
import { withFindCourt } from "@/lib/match-day/view";
import { routes } from "@/lib/routes";
import { closedNow, closureOf } from "@/lib/match-day/closure";
import type {
  CourtClosure,
  MatchDayCandidate,
  MatchDayCourt,
  MatchDayCourtState,
  MatchDayFindCourt,
  MatchDayFixture,
  MatchDayQueued,
  MatchDayRound,
  MatchDaySummary,
  MatchDayView,
} from "@/lib/match-day/types";
import { resolveVenueTz } from "@/lib/tz";
import { venueNoun } from "@/lib/venue";
import { needsYouAt, needsYouHome, needsYouItems, resultsOwedOf } from "@/components/v2/desk/needs-you";
import type { AuthCtx } from "@/server/api-v1/auth";
import { defaultMatchMinutes, getCompetitionDesk } from "./competition-desk";
import { resolveCandidateCourts } from "./court-candidates";
import { listDivisions } from "./divisions";
import {
  callableCourtsByFixture,
  dayTable,
  courtWindowsToday,
  divisionDays,
  IN_PLAY,
  liveCallSql,
  targetCourt,
  todayIn,
  whoIsBusy,
} from "./match-day-call";
import { courtNamesById, loadSettings, MOVABLE_STATUS } from "./schedule";
import { fixtureFormatLines } from "./fixtures";
import { readRounds, roundOf } from "./match-day-rounds";
import { openStreamStates } from "./stream-sessions";
import { kickoffsOf } from "@/server/engine-db/kickoff";
import { servingSideOf, sportReadsServe } from "@/server/engine-db/serving";
import { log } from "@/server/logger";
import { liveSessionVideos } from "@/server/youtube/parts";

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
  const read = await countTodayByCompetition(tx, org?.timezone ?? null, now, tx`d.competition_id = ${competitionId}`);
  return read.get(competitionId)?.n ?? 0;
}

/** The match a competition's day is headlined by on the org home's deck (C7 review M2): one of TODAY's matches, both sides
 *  known. `court_id` is resolved to a label by the caller. */
interface TodayHeadlineRaw {
  fixture_id: string;
  home: string;
  away: string;
  court_id: string | null;
  scheduled_at: string | null;
  in_play: boolean;
}

/** Upcoming statuses: the only matches a "what's next" answer may name (card-stats' own `next` reads the same two). */
const UPCOMING = ["scheduled", IN_PLAY] as const;

/**
 * The one "how many matches today" rule, per competition, for the divisions `where` picks (alias `d`; an archived division is
 * always left out here, I1). Two statements whatever the number of competitions: the divisions' days, then ONE read over the
 * `w(division_id, day_from, day_to)` table joined in. `countFixturesToday` (one competition: the desk, Match Day) and
 * `competitionsFixturesToday` (the org home's whole list, C7) are both this, so the two cannot disagree.
 *
 * The same read also picks each competition's headline among the matches it counts: in play first (whatever its planned
 * day — it is counted as today), then the earliest planned; only an upcoming match with both sides known qualifies, as on the
 * card (card-stats' D4a: a side still to be decided is no "what's next" answer). None qualifying: no headline.
 */
async function countTodayByCompetition(
  tx: Tx,
  orgTz: string | null,
  now: Date,
  where: postgres.Fragment,
): Promise<Map<string, { n: number; headline: TodayHeadlineRaw | null }>> {
  const days = await divisionDays(tx, orgTz, now, tx`${where} and d.archived_at is null`);
  if (days.length === 0) return new Map();
  const rows = await tx<
    {
      competition_id: string;
      n: number;
      qualifies: boolean;
      fixture_id: string;
      home: string | null;
      away: string | null;
      court_id: string | null;
      scheduled_at: Date | null;
      in_play: boolean;
    }[]
  >`
    select x.* from (
      select d.competition_id,
             count(*) over (partition by d.competition_id)::int as n,
             row_number() over (
               partition by d.competition_id
               order by (f.status in ${tx([...UPCOMING])} and he.id is not null and ae.id is not null) desc,
                        (f.status = ${IN_PLAY}) desc, f.scheduled_at asc nulls last, f.round_no, f.seq_in_round, f.id
             ) as rk,
             (f.status in ${tx([...UPCOMING])} and he.id is not null and ae.id is not null) as qualifies,
             f.id as fixture_id, he.display_name as home, ae.display_name as away, f.court_id, f.scheduled_at,
             f.status = ${IN_PLAY} as in_play
        from fixtures f
        join ${dayTable(tx, days)} on w.division_id = f.division_id
        join divisions d on d.id = f.division_id
        left join entrants he on he.id = f.home_entrant_id
        left join entrants ae on ae.id = f.away_entrant_id
       where f.status <> ${CANCELLED}
         and ((f.scheduled_at >= w.day_from and f.scheduled_at < w.day_to) or f.status = ${IN_PLAY})
    ) x
    where x.rk = 1`;
  return new Map(
    rows.map((r) => [
      r.competition_id,
      {
        n: r.n,
        // `qualifies` already demands both entrants joined, and `display_name` is NOT NULL: the null checks only narrow.
        headline:
          r.qualifies && r.home !== null && r.away !== null
            ? { fixture_id: r.fixture_id, home: r.home, away: r.away, court_id: r.court_id, scheduled_at: iso(r.scheduled_at), in_play: r.in_play }
            : null,
      },
    ]),
  );
}

/** The deck's headline match for a competition: today's, both sides known, its court resolved to the venue-qualified label. */
export interface TodayHeadline {
  fixture_id: string;
  home: string;
  away: string;
  court_label: string | null;
  scheduled_at: string | null;
  in_play: boolean;
}

/** The org Competitions home's today deck (Match Day C7): the organisation's day, how many of each listed competition's
 *  matches are today, and the one each is headlined by. */
export interface CompetitionsToday {
  /** The organisation's day `now` falls on, 'YYYY-MM-DD': the deck's date label, as the Match Day view's `date` is. */
  day: string;
  /** The organisation's zone (else UTC): the deck shows its match times in it. */
  tz: string;
  /** Competition id -> its matches today. A competition with none is absent. */
  counts: Map<string, number>;
  /** Competition id -> today's headline match. Absent when none of today's matches is upcoming with both sides known. */
  next: Map<string, TodayHeadline>;
}

/**
 * `countFixturesToday` for a whole list of competitions: ONE tenant transaction and at most four statements however long the
 * list (the organisation's zone, the divisions' days, one read of today's counts and headlines, and — only when a headline has
 * a court — the court labels) - never a query per card. Every read is under the tenant's RLS, so a competition of another
 * organisation is never counted even when its id is asked for.
 */
export async function competitionsFixturesToday(
  auth: AuthCtx,
  competitionIds: readonly string[],
  now: Date = new Date(),
): Promise<CompetitionsToday> {
  return withTenant(auth.orgId, async (tx) => {
    const [org] = await tx<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
    const orgTz = org?.timezone ?? null;
    const tz = resolveVenueTz(null, orgTz);
    const { day } = todayIn(tz, now);
    const read =
      competitionIds.length === 0
        ? new Map<string, { n: number; headline: TodayHeadlineRaw | null }>()
        : await countTodayByCompetition(tx, orgTz, now, tx`d.competition_id = any(${[...competitionIds]}::uuid[])`);
    const courtNames = [...read.values()].some((r) => r.headline?.court_id) ? await courtNamesById(tx) : new Map<string, string>();
    const counts = new Map<string, number>();
    const next = new Map<string, TodayHeadline>();
    for (const [id, { n, headline }] of read) {
      counts.set(id, n);
      if (headline === null) continue;
      const { court_id, ...rest } = headline;
      next.set(id, { ...rest, court_label: court_id === null ? null : (courtNames.get(court_id) ?? court_id) });
    }
    return { day, tz, counts, next };
  });
}

/**
 * `countFixturesToday`, read in a tenant transaction of its own: for a caller that needs only the count (the division page's
 * "is it a match day" question) and not the whole board or the competition desk. The same count, the same rule - the caller
 * asks `needsYouHome` of it, exactly as the competition page asks it of the desk's `fixtures_today`.
 */
export async function competitionFixturesToday(auth: AuthCtx, competitionId: string, now: Date = new Date()): Promise<number> {
  return withTenant(auth.orgId, (tx) => countFixturesToday(tx, competitionId, now));
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

/** One of this competition's matches, as the board reads it. Exported for the Match Day code's day read
 *  (match-day-code-view.ts, MD-1 Task 3), which lists the same rows. */
export interface FixtureRow {
  id: string;
  division_id: string;
  division_name: string;
  division_slug: string;
  sport_key: string;
  /** Its stage, for the round code: the board ranks a round against the whole stage (`readRounds`). */
  stage_id: string;
  stage_kind: string;
  stage_name: string;
  stage_status: string;
  status: string;
  court_id: string | null;
  scheduled_at: Date | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home: string | null;
  away: string | null;
  /** `fixtures.round_no` is NOT NULL (V214). */
  round_no: number;
  fixture_no: number;
  headline: string | null;
  /** `match_states.summary`, whole (jsonb). */
  summary: MatchDaySummary | null;
  started_at: Date | null;
  /** Its call's time while the call holds; null otherwise. */
  called_at: Date | null;
  /** `fixtures.finished_at` (V430/V432: stamped when the match enters the finished set, cleared when it leaves it). */
  finished_at: Date | null;
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

export interface BoardCourt {
  court_id: string;
  court_name: string;
  venue_id: string;
  venue_name: string;
  state: MatchDayCourtState;
  current: FixtureRow | null;
  in_use_by: string | null;
  free_since: Date | null;
  /** This competition's queued matches, in planned order, with their estimates. */
  queue: BoardQueued[];
  /** The first division (competition order) with this court among its candidate courts. */
  candidate_sport: string | null;
  /** The court's closure today, from the scheduler's usable windows (`closureOf`). */
  closure: CourtClosure | null;
}

export interface Board {
  comp: CompRow;
  tz: string;
  day: string;
  courts: BoardCourt[];
  /** The venues this competition has a match today on a court of (`MatchDayView.venues_today`). */
  venuesToday: string[];
  /** This competition's ready "no court yet" matches, in order; read only when asked for. */
  noCourt: FixtureRow[];
  /** This competition's matches in play on no court, in its live divisions, in kick-off order (`playingNoCourtOf`). */
  playingNoCourt: FixtureRow[];
  /** This competition's matches on a court that finished within their division's day, newest first; read only when asked
   *  for (the Match Day code's day read lists them under their court, capture S4 design §5). */
  finished: FixtureRow[];
  courtNames: Map<string, string>;
  /** The competition's live (not archived) divisions: the ones the desk's no-court lists draw from (MD-1 fix I1). */
  liveDivisions: ReadonlySet<string>;
}

/** Test-only (task F2): runs inside `readBoard`'s transaction right after the named read, so a test can put a concurrent write
 *  in the READ COMMITTED gap between two of its statements. Null in production. */
type BoardReadHook = (after: "rows" | "holders") => Promise<void>;
let boardReadHook: BoardReadHook | null = null;
export function __setBoardReadHookForTests(fn: BoardReadHook | null): void {
  boardReadHook = fn;
}

/** A kick-off as a sort key: a match with no recorded kick-off sorts after every one that has one. */
const kickoffKey = (r: Pick<FixtureRow, "started_at">): number =>
  r.started_at === null ? Infinity : new Date(r.started_at).getTime();

/**
 * "Playing, no court" (owner ruling Q1, task B4): of the board's rows, every match IN PLAY with no court in a LIVE division —
 * an untimed bracket match, an online chess board — in kick-off order (no kick-off last), then by number and id. The retired
 * competition-page strip was the one place these showed; no court row can carry one, so this is their only place now.
 * `rows` holds every in-play match of the competition whatever its day (the fetch's `IN_PLAY` arm), archived divisions'
 * included — so the live-division test is this function's, not the fetch's.
 */
function playingNoCourtOf(rows: readonly FixtureRow[], liveDivisions: ReadonlySet<string>): FixtureRow[] {
  return rows
    .filter((r) => r.status === IN_PLAY && r.court_id === null && liveDivisions.has(r.division_id))
    .sort((a, b) => kickoffKey(a) - kickoffKey(b) || a.fixture_no - b.fixture_no || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The board: everything the view and the candidates read, in one tenant transaction. Exported for the Match Day code's
 *  day read (match-day-code-view.ts), the one other surface that lists a competition's day by court. */
export async function readBoard(
  tx: Tx,
  competitionId: string,
  now: Date,
  opts: { noCourt: boolean; finished?: boolean },
): Promise<Board> {
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
  // This competition's matches, as the board reads them, picked by `which`.
  const readRows = (which: postgres.Fragment) => tx<FixtureRow[]>`
    select f.id, f.division_id, d.name as division_name, d.slug as division_slug, d.sport_key,
           s.id as stage_id, s.kind as stage_kind, s.name as stage_name, s.status as stage_status,
           f.status, f.court_id, f.scheduled_at, f.home_entrant_id, f.away_entrant_id,
           h.display_name as home, a.display_name as away, f.round_no, f.fixture_no,
           ms.summary->>'headline' as headline, ms.summary,
           null::timestamptz as started_at,
           ${liveCallOf(tx`f.id`)} as called_at,
           f.finished_at
      from fixtures f
      join divisions d on d.id = f.division_id
      join stages s on s.id = f.stage_id
      left join entrants h on h.id = f.home_entrant_id
      left join entrants a on a.id = f.away_entrant_id
      left join match_states ms on ms.fixture_id = f.id
      left join ${dayTable(tx, compDays)} on w.division_id = f.division_id
     where d.competition_id = ${competitionId} and (${which})`;
  const rows = await readRows(tx`
    (f.scheduled_at >= w.day_from and f.scheduled_at < w.day_to)
      or f.status = ${IN_PLAY}
      or ${liveCallOf(tx`f.id`)} is not null
      ${opts.noCourt
        ? tx`or (f.status = ${MOVABLE_STATUS} and f.court_id is null and w.division_id is not null
                 and (f.scheduled_at is null or f.scheduled_at < w.day_to))`
        : tx``}`);
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  await boardReadHook?.("rows");

  // The court set: every live division's candidate courts, and every court one of their matches today is on. A match of an
  // archived division in play (read above: it may hold one of these courts) adds no court of its own.
  const onBoard = new Set([
    ...candidateDivision.keys(),
    ...rows.flatMap((r) => (r.court_id !== null && liveDivisions.has(r.division_id) ? [r.court_id] : [])),
  ]);
  const courtNames = await courtNamesById(tx);
  const orgCourts = await tx<{ id: string; venue_id: string; venue_name: string }[]>`
    select c.id, v.id as venue_id, v.name as venue_name from courts c join venues v on v.id = c.venue_id
     order by v.sort, v.name, c.sort, c.name, c.id`;
  const courtIds = orgCourts.filter((c) => onBoard.has(c.id)).map((c) => c.id);
  if (courtIds.length !== onBoard.size) throw new Error("match-day: a board court is not one of the organisation's courts");
  const venueOf = new Map(orgCourts.map((c) => [c.id, c.venue_name]));
  const venueIdOf = new Map(orgCourts.map((c) => [c.id, c.venue_id]));

  const holders = courtIds.length
    ? await tx<HolderRow[]>`
        select g.id, g.court_id, d.competition_id, c.name as competition_name, g.division_id, 0 as rank,
               null::timestamptz as started_at
          from fixtures g join divisions d on d.id = g.division_id join competitions c on c.id = d.competition_id
         where g.status = ${IN_PLAY} and g.court_id in ${tx(courtIds)}
        union all
        select g.id, fc.court_id, d.competition_id, c.name as competition_name, g.division_id, 1 as rank, null as started_at
          from fixture_calls fc join fixtures g on g.id = fc.fixture_id
          join divisions d on d.id = g.division_id join competitions c on c.id = d.competition_id
         where ${liveCallSql(tx)} and fc.court_id in ${tx(courtIds)}`
    : [];
  await boardReadHook?.("holders");
  // READ COMMITTED (task F2, A2 review m1): `rows` and `holders` are two statements, each on a snapshot of its own. One of this
  // competition's matches that started, or was called, BETWEEN them holds a court here that `rows` never saw — the poll used to
  // throw on it and answer 500. Such a match is read now, by id; one gone by then (deleted in the gap) holds nothing.
  const unread = [...new Set(holders.filter((h) => h.competition_id === competitionId && !rowsById.has(h.id)).map((h) => h.id))];
  if (unread.length > 0) {
    for (const r of await readRows(tx`f.id in ${tx(unread)}`)) {
      rows.push(r);
      rowsById.set(r.id, r);
    }
  }
  const held = holders.filter((h) => h.competition_id !== competitionId || rowsById.has(h.id));
  // Kick-offs (task F3, owner ruling 10-31 (3)): the LAST active `core.start` of each match in play, voids applied by the
  // engine's own `resolveVoids` — one reader (`kickoffsOf`), shared with the competition desk. Read once, after the matches.
  const kickoffs = await kickoffsOf(tx, [
    ...rows.filter((r) => r.status === IN_PLAY).map((r) => r.id),
    ...held.filter((h) => Number(h.rank) === 0).map((h) => h.id),
  ]);
  for (const r of rows) r.started_at = r.status === IN_PLAY ? (kickoffs.get(r.id)?.at ?? null) : null;
  for (const h of held) h.started_at = Number(h.rank) === 0 ? (kickoffs.get(h.id)?.at ?? null) : null;
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
  // When each court is open today: the scheduler's own reader (court_hours + court_exceptions, the organisation's zone).
  const windowsOf = await courtWindowsToday(tx, courtIds, tz, now);

  const courts: BoardCourt[] = [];
  for (const courtId of courtIds) {
    // Playing before called; this competition's own before another's; then by id.
    const holder =
      held
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
        // `held` keeps only this competition's holders whose row was read (above), so this is the invariant, not a branch.
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
      venue_id: venueIdOf.get(courtId) ?? "",
      venue_name: venueOf.get(courtId) ?? "",
      state,
      current,
      in_use_by: inUseBy,
      free_since: state === "free" ? (freeSince.get(courtId) ?? null) : null,
      queue,
      candidate_sport: candidateDivision.get(courtId) ?? null,
      closure: closureOf(windowsOf.get(courtId) ?? [], now.getTime()),
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
            a.round_no - b.round_no ||
            a.fixture_no - b.fixture_no ||
            (a.id < b.id ? -1 : 1),
        )
    : [];
  // The venues this competition has a match today on a court of: `rows` is every match of its live divisions that is today's, in
  // play or called, whatever its state now (a finished one too), so a venue whose matches are all played still counts.
  // Listed in the organisation's venue order (the courts' own), so the answer does not depend on how the rows came back.
  const withMatchToday = new Set(
    rows.flatMap((r) => {
      const venue = r.court_id !== null && liveDivisions.has(r.division_id) ? venueIdOf.get(r.court_id) : undefined;
      return venue === undefined ? [] : [venue];
    }),
  );
  const venuesToday = [...new Set(orgCourts.map((c) => c.venue_id))].filter((id) => withMatchToday.has(id));
  // Finished today (asked for by the Match Day code's read only): a match of a live division (the day table holds live
  // divisions only, so an archived one's `w` is null and the range is false) that finished on a court within its own
  // division's day. A cancelled match was never played (`CANCELLED`). Newest first, then by id.
  const finishedToday = opts.finished
    ? (await readRows(tx`
        f.court_id is not null and f.finished_at is not null and f.status <> ${CANCELLED}
          and f.finished_at >= w.day_from and f.finished_at < w.day_to`)).sort(
        (a, b) =>
          new Date(b.finished_at!).getTime() - new Date(a.finished_at!).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
    : [];
  return {
    comp,
    tz,
    day,
    courts,
    venuesToday,
    noCourt,
    playingNoCourt: playingNoCourtOf(rows, liveDivisions),
    finished: finishedToday,
    courtNames,
    liveDivisions,
  };
}

/**
 * "Find a court", per division (B4 fix round 1, R2; spec §9): for each division with at least one ready match with NO court yet
 * (`board.noCourt`, Match Day's own rule: unstarted, both sides seated, an active stage, planned no later than today), the FIRST
 * free court on the board's list that one of those matches may be called onto — the scheduler's own candidate set,
 * `callableCourtsByFixture`, the set its call would be judged by — or null when no such court is free. A division with no such
 * match is absent: a TBD-only knockout has nothing a court could take, and the link would promise a list it is not on. Shared by
 * Match Day's Needs you and the division run sheet's link (`findCourtForDivision`).
 */
async function findCourtsOf(tx: Tx, board: Pick<Board, "courts" | "noCourt">): Promise<Map<string, MatchDayFindCourt>> {
  const out = new Map<string, MatchDayFindCourt>();
  if (board.noCourt.length === 0) return out;
  const allowed = await callableCourtsByFixture(tx, board.noCourt);
  const usable = new Map<string, { courts: Set<string>; noun: MatchDayFindCourt["noun"] }>();
  for (const r of board.noCourt) {
    let entry = usable.get(r.division_id);
    if (entry === undefined) {
      entry = { courts: new Set(), noun: venueNoun(r.sport_key) };
      usable.set(r.division_id, entry);
    }
    for (const courtId of allowed.get(r.id) ?? []) entry.courts.add(courtId);
  }
  for (const [divisionId, { courts, noun }] of usable) {
    // Free courts the division may use, in the board's list order. One that its hours have shut right now is the LAST choice
    // (fix round 1, I2): "Find a court" should land where a match can be called without a "Call anyway", and falls back to a
    // shut court only when no other free court can take the match - the call is warn-only, so it is still a court to open.
    const free = board.courts.filter((c) => c.state === "free" && courts.has(c.court_id));
    const pick = free.find((c) => !closedNow(c)) ?? free[0];
    out.set(divisionId, { court_id: pick?.court_id ?? null, noun });
  }
  return out;
}

/**
 * One division's "Find a court" (`findCourtsOf`), read in a tenant transaction of its own: for the division page's run sheet
 * (B2), whose link on an unscheduled match leads where Match Day's Needs you does. Null when the division has no ready match
 * with no court.
 */
export async function findCourtForDivision(
  auth: AuthCtx,
  competitionId: string,
  divisionId: string,
  now: Date = new Date(),
): Promise<MatchDayFindCourt | null> {
  return withTenant(auth.orgId, async (tx) => {
    const board = await readBoard(tx, competitionId, now, { noCourt: true });
    return (await findCourtsOf(tx, board)).get(divisionId) ?? null;
  });
}

/** What only a playing court's match carries: who serves (S1), the desk's scorer attention, and its live stream's video (A4). */
interface PlayingExtras {
  serving: Serving;
  scorer_attention: MatchDayFixture["scorer_attention"];
  live_video: MatchDayFixture["live_video"];
  format_line: MatchDayFixture["format_line"];
}
const NO_EXTRAS: PlayingExtras = { serving: null, scorer_attention: null, live_video: null, format_line: null };

function fixtureView(
  r: FixtureRow,
  rounds: ReadonlyMap<string, MatchDayRound>,
  streams: Record<string, "live" | "waiting">,
  extras: PlayingExtras = NO_EXTRAS,
): MatchDayFixture {
  return {
    id: r.id,
    division_id: r.division_id,
    division_name: r.division_name,
    division_slug: r.division_slug,
    fixture_no: r.fixture_no,
    sport_key: r.sport_key,
    stage_label: r.stage_name,
    round: roundOf(rounds, r.id),
    home: r.home,
    away: r.away,
    home_entrant_id: r.home_entrant_id,
    away_entrant_id: r.away_entrant_id,
    headline: r.headline,
    summary: r.summary ?? null,
    serving: extras.serving,
    started_at: r.status === IN_PLAY ? iso(r.started_at) : null,
    called_at: iso(r.called_at),
    stream: streams[r.id] ?? null,
    scorer_attention: extras.scorer_attention,
    live_video: extras.live_video,
    format_line: extras.format_line,
  };
}

function courtView(
  c: BoardCourt,
  rounds: ReadonlyMap<string, MatchDayRound>,
  streams: Record<string, "live" | "waiting">,
  extras: (fixtureId: string) => PlayingExtras,
): MatchDayCourt {
  const queue: MatchDayQueued[] = c.queue.map((q) => ({
    ...fixtureView(q.row, rounds, streams),
    planned_at: q.planned_at.toISOString(),
    estimated_at: q.estimated_at.toISOString(),
  }));
  return {
    court_id: c.court_id,
    court_name: c.court_name,
    venue_id: c.venue_id,
    venue_name: c.venue_name,
    sport_noun: venueNoun(c.current?.sport_key ?? c.queue[0]?.row.sport_key ?? c.candidate_sport),
    state: c.state,
    current: c.current === null ? null : fixtureView(c.current, rounds, streams, extras(c.current.id)),
    in_use_by: c.in_use_by,
    free_since: iso(c.free_since),
    queue,
    closure: c.closure,
  };
}

/**
 * Match Day for one competition, now: its courts with what each is doing and its queue, its matches playing on no court, the
 * desk's Needs-you list in the reader's language (`locale`, default English), the results owed, and today's match count. Reads
 * only.
 */
export async function getMatchDay(
  auth: AuthCtx,
  competitionId: string,
  now: Date = new Date(),
  opts: { locale?: Locale } = {},
): Promise<MatchDayView> {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  // Read before the tenant transaction (a file, not a connection): the round codes named inside it are in the reader's language.
  const dict = await getDictionary(locale, "ui");
  const { board, serving, findCourts, rounds } = await withTenant(auth.orgId, async (tx) => {
    // The "no court yet" arm too: Needs you's "Find a court" is offered only for a division with such a match (R2).
    const board = await readBoard(tx, competitionId, now, { noCourt: true });
    const findCourts = await findCourtsOf(tx, board);
    // Who serves, on this competition's playing matches only — on a court, or on none (B4: the same scoreboard either way) —
    // for a sport whose engine reads a serve (S1). One match whose fold throws (a side whose entrant went: `loadFoldInputs`'
    // WRONG_PHASE) says nothing about who serves — `null`, logged — and never takes the rest of the board down with it (A3
    // carry-in). A savepoint, so a statement it failed cannot abort the tenant transaction the next court's fold and the reads
    // below still need — a JS throw never aborts a transaction, a failed STATEMENT does; witnessed by match-day.test.ts "S1
    // guard (SQL)" (fix round 1, m3), which a direct call reds.
    const playing = [
      ...board.courts.flatMap((c) => (c.state === "playing" && c.current !== null ? [c.current] : [])),
      ...board.playingNoCourt,
    ];
    const serving = new Map<string, Serving>();
    for (const r of playing) {
      if (!sportReadsServe(r.sport_key)) continue;
      const fixtureId = r.id;
      try {
        serving.set(fixtureId, await tx.savepoint((sp) => servingSideOf(sp, fixtureId)));
      } catch (err) {
        log.warn({ err, fixtureId, competitionId }, "match-day: serve fold failed; serving left unknown");
        serving.set(fixtureId, null);
      }
    }
    // Every match the view shows, named by the board's own round codes (E2 item 7).
    const shown = [
      ...board.courts.flatMap((c) => [...(c.current ? [c.current] : []), ...c.queue.map((q) => q.row)]),
      ...board.playingNoCourt,
    ];
    const rounds = await readRounds(tx, shown, dict);
    return { board, serving, findCourts, rounds };
  });
  // Each reads through its own connection: none may run inside the tenant transaction above (pool nesting).
  const ids = [
    ...board.courts.flatMap((c) => [...(c.current ? [c.current.id] : []), ...c.queue.map((q) => q.row.id)]),
    ...board.playingNoCourt.map((r) => r.id),
  ];
  const [streams, desk, divisions] = await Promise.all([
    openStreamStates(auth, ids),
    getCompetitionDesk(auth, competitionId, now),
    listDivisions(auth, competitionId),
  ]);
  const needs = needsYouItems(
    dict,
    desk,
    divisions.map((d) => ({ id: d.id, name: d.name, slug: d.slug })),
    board.comp.org_slug,
    board.comp.slug,
    locale,
  );
  // The desk's scorer attentions, by match (A4): the same `Attention` rows `needsYouItems` turns into Needs-you rows, so a court's
  // mark and the list's row are one fact. A match never raises both kinds (division-phase.ts).
  const scorerAttention = new Map<string, MatchDayFixture["scorer_attention"]>();
  for (const d of desk.divisions.values()) {
    for (const a of d.attention) {
      if (a.kind === "no_scorer" || a.kind === "not_recording") for (const id of a.fixtureIds) scorerAttention.set(id, a.kind);
    }
  }
  // Today's match count is the desk's own (`countFixturesToday`, read in the desk's transaction at this same `now`): one count
  // per poll, not two (B1 review minor), and the competition page's gate and this page's are the same number by construction.
  const fixturesToday = desk.fixtures_today;
  // B1 (spec §9, "Needs you lives in one place at a time"): the list is Match Day's on a match day only — before the day it is the
  // competition page's (`needsYouHome`, the one rule both surfaces ask), and Match Day carries none of it, its owed count included.
  const atHome = needsYouAt("match_day", fixturesToday, needs);
  // The preview's video (A4, §6.2): asked for the playing matches whose stream is live — on a court or on none — and only those.
  const liveIds = [
    ...board.courts.flatMap((c) => (c.state === "playing" && c.current !== null ? [c.current.id] : [])),
    ...board.playingNoCourt.map((r) => r.id),
  ].filter((id) => streams[id] === "live");
  const playingIds = [
    ...board.courts.flatMap((c) => (c.state === "playing" && c.current !== null ? [c.current.id] : [])),
    ...board.playingNoCourt.map((r) => r.id),
  ];
  // The playing matches' formats (C2), in the public line's words: the fixture page's own reader, in the reader's language.
  // Decorative on a polled read (fix round 1, M5): a line that cannot be read is logged and left out, never a 500 for the board.
  const [videos, formatLines] = await Promise.all([
    liveSessionVideos(auth.orgId, liveIds),
    getDictionary(locale, "public")
      .then((publicDict) => fixtureFormatLines(auth, playingIds, publicDict))
      .catch((err: unknown) => {
        log.warn({ err, competitionId, fixtureIds: playingIds }, "match-day: format lines failed; format_line left null");
        return new Map<string, string>();
      }),
  ]);
  const extras = (fixtureId: string): PlayingExtras => {
    const video = videos[fixtureId];
    return {
      serving: serving.get(fixtureId) ?? null,
      scorer_attention: scorerAttention.get(fixtureId) ?? null,
      // Fails closed, as `mayEmbedReplay` does: only a broadcast positively NOT made for kids reads false.
      live_video: video === undefined ? null : { url: video.url, made_for_kids: video.madeForKids !== false },
      format_line: formatLines.get(fixtureId) ?? null,
    };
  };
  return {
    competition_id: competitionId,
    date: board.day,
    tz: board.tz,
    now: now.toISOString(),
    courts: board.courts.map((c) => courtView(c, rounds, streams, extras)),
    playing_no_court: board.playingNoCourt.map((r) => fixtureView(r, rounds, streams, extras(r.id))),
    needs_you: withFindCourt(dict, atHome, findCourts, routes.competitionMatchDay(board.comp.org_slug, board.comp.slug)),
    results_owed: needsYouHome(fixturesToday) === "match_day" ? resultsOwedOf(desk) : 0,
    fixtures_today: fixturesToday,
    venues_today: board.venuesToday,
  };
}

const ready = (r: FixtureRow): boolean => r.home_entrant_id !== null && r.away_entrant_id !== null;

/**
 * The matches that could start on `courtId` now (§7), ranked by `rankCandidates`:
 *  - this_court: the court's own next ready match;
 *  - other_court: every other court's next ready match, and a match called onto another court and not yet started ("it can
 *    also be called to a different free court");
 *  - no_court: ready matches of active stages with no court, planned for no later day than today.
 * A side still to be decided is never a candidate, and neither is a match whose division may not play on `courtId` (B4 fix round
 * 1, R1: the scheduler's own candidate set, `callableCourtsByFixture` — the set a call refuses NOT_CANDIDATE_COURT by), whichever
 * arm it came by. Each carries how long it would wait where it is and how far behind its plan
 * that is, and a hard stop when a player — a doubles partner counts; for a side with no roster, the side — is in a match playing
 * or called elsewhere (A1's `whoIsBusy`, the judge a call refuses by). 404 for a court that is not the org's, or is archived.
 */
export async function matchDayCandidates(
  auth: AuthCtx,
  competitionId: string,
  courtId: string,
  now: Date = new Date(),
  opts: { locale?: Locale } = {},
): Promise<MatchDayCandidate[]> {
  const nowMs = now.getTime();
  const dict = await getDictionary(opts.locale ?? DEFAULT_LOCALE, "ui");
  const { picked, busy, courtNames, rounds } = await withTenant(auth.orgId, async (tx) => {
    const board = await readBoard(tx, competitionId, now, { noCourt: true });
    await targetCourt(tx, courtId);
    const picked: {
      row: FixtureRow;
      source: MatchDayCandidate["source"];
      from: string | null;
      waiting: number;
      behind: number;
      /** The planned time the row prints (E2 item 1); null for a call, which replaced the plan. */
      planned: Date | null;
    }[] = [];
    for (const c of board.courts) {
      const mine = c.court_id === courtId;
      if (!mine && c.state === "called" && c.current !== null && ready(c.current)) {
        picked.push({ row: c.current, source: "other_court", from: c.court_name, waiting: 0, behind: 0, planned: null });
      }
      // The court's first ready queued match PER DIVISION (F-T8-6): the desk's panel filters by division, and a court whose first
      // match is another division's would otherwise show "Nothing is waiting" beside a match of the filtered one in its queue.
      const seenDivisions = new Set<string>();
      for (const next of c.queue) {
        if (!ready(next.row) || seenDivisions.has(next.row.division_id)) continue;
        seenDivisions.add(next.row.division_id);
        picked.push({
          row: next.row,
          source: mine ? "this_court" : "other_court",
          from: mine ? null : c.court_name,
          waiting: wholeMinutes(next.estimated_at.getTime() - nowMs),
          behind: wholeMinutes(next.estimated_at.getTime() - next.planned_at.getTime()),
          planned: next.planned_at,
        });
      }
    }
    for (const r of board.noCourt) {
      picked.push({
        row: r,
        source: "no_court",
        from: null,
        waiting: 0,
        behind: r.scheduled_at === null ? 0 : wholeMinutes(nowMs - new Date(r.scheduled_at).getTime()),
        planned: r.scheduled_at === null ? null : new Date(r.scheduled_at),
      });
    }
    const allowed = await callableCourtsByFixture(tx, picked.map((p) => p.row));
    // A candidate for this court is one its division may play on, or one already planned on it (task F7: the call's own
    // exemption, `assertCallable` — this court's queue never hides a match the call would take).
    const usable = picked.filter((p) => p.row.court_id === courtId || allowed.get(p.row.id)?.has(courtId) === true);
    const busy = await whoIsBusy(tx, usable.map((p) => p.row));
    // Their round codes, as the board names them (E2 item 7), in the reader's language.
    const rounds = await readRounds(tx, usable.map((p) => p.row), dict);
    return { picked: usable, busy, courtNames: board.courtNames, rounds };
  });
  const streams = await openStreamStates(auth, picked.map((p) => p.row.id));
  return rankCandidates(
    picked.map((p) => {
      const holder = busy.get(p.row.id);
      return {
        fixture: fixtureView(p.row, rounds, streams),
        source: p.source,
        from_court_name: p.from,
        waiting_minutes: p.waiting,
        behind_minutes: p.behind,
        planned_at: iso(p.planned),
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
