// Competition Desk (spec 2026-09-02 §"The shared model"), Task 3: the
// server-side aggregate the desk's list/card views both read — one
// division-phase resolution + attention list + count set per division, plus
// the competition-wide pill. Composes listDivisions/listDivisionCardStats
// (existing card-grid aggregates) with Task 1's pure division-phase
// resolver; nothing here duplicates their queries.
import "server-only";
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { resolveVenueTz } from "@/lib/tz";
import {
  resolveAttention,
  resolvePhase,
  type Attention,
  type DivisionPhase,
  type DivisionStatus,
  type PhaseFixture,
  type PhaseStage,
} from "@/lib/division-phase";
import { listDivisionCardStats, type NextFixture } from "./card-stats";
import { listDivisions } from "./divisions";

/** The desk's own "next" fact (`resolveDivisionNext` below) is a SEPARATE
 *  query from card-stats.ts's `NextFixture` — no `courts` join, so it can
 *  never resolve a real `court_label` (final review round 3, minor fix: the
 *  old code hardcoded `court_label: null` on the full `NextFixture` shape
 *  instead of just not carrying the field). */
export type DeskNextFixture = Omit<NextFixture, "court_label">;

export interface DeskDivision {
  phase: DivisionPhase;
  attention: Attention[];
  played: number;
  total: number;
  unscheduled: number;
  in_play: number;
  entrants: number;
  // Minor fix (final review round 3): was `NextFixture | null` — the full
  // card-stats.ts shape, `court_label` included, even though this row's OWN
  // `resolveDivisionNext` below (a separate query, no `courts` join) can
  // never populate it and always hardcoded `null`. Dropping the field from
  // the type here (rather than "populating" it with a join no desk consumer
  // needs) means a future desk consumer that tries to read it fails to
  // compile, instead of silently reading a value that is wrong the day a
  // real court label exists and this type kept claiming there wasn't one.
  next: DeskNextFixture | null;
  needs_draw_stage: { id: string; name: string } | null;
  /** For attention rows that name a fixture. */
  fixture_names: Record<string, { home: string | null; away: string | null; fixture_no: number }>;
  display_tz: string;
}

export interface CompetitionDesk {
  // `org_tz` used to sit here. Deleted in fix round F (minor 1): it had ZERO
  // production consumers, and a dormant SECOND zone authority on the very type
  // whose two-zone bug H1 had just removed is an invitation to re-derive that
  // bug. Every division already carries `display_tz` — the one zone its row is
  // both bucketed and printed in — and that is the only zone this type owes
  // anyone. Same argument round E used to delete `court_label`.
  in_play: number;
  divisions: Map<string, DeskDivision>;
  /** Same instant every division's phase was resolved against (SSR-stable).
   *  `competitionPhase` filters on it too, so the masthead's "earliest next
   *  fixture" ladder step never disagrees with the per-division rows it's
   *  summarising. */
  now: string;
}

let cachedMatchMinutes: number | undefined;
/** The schema's own default (schemas.ts's `ScheduleConfig.matchMinutes`
 *  `.default(30)`), read lazily and memoised: a division with no
 *  schedule_settings row at all falls back to this, the same way the read
 *  path parses an empty config (schedule.ts:296's `ScheduleConfig.parse`).
 *  Deferred to first call, not evaluated at module load — a future required
 *  field on ScheduleConfig must not throw at import time and take down
 *  every importer of this module (Task 5 wires it into the competition page
 *  route), so a parse failure here logs and falls back to the literal
 *  instead of propagating.
 *
 *  Exported (final review, minor): `d/[divSlug]/page.tsx` used to retype the
 *  fallback as a bare `matchMinutes ?? 60`, diverging from this desk's own
 *  30 the day that page ever needs it live. One derivation, shared. */
export function defaultMatchMinutes(): number {
  if (cachedMatchMinutes === undefined) {
    try {
      cachedMatchMinutes = ScheduleConfig.parse({}).matchMinutes;
    } catch (err) {
      log.error({ event: "desk_default_match_minutes_failed", err }, "desk_default_match_minutes_failed");
      cachedMatchMinutes = 30; // schemas.ts matchMinutes .default(30)
    }
  }
  return cachedMatchMinutes;
}

type StageRaw = {
  id: string;
  division_id: string;
  name: string;
  seq: number;
  status: string;
  timing: string | null;
  has_fixtures: boolean;
};
type FixtureRaw = {
  id: string;
  division_id: string;
  status: string;
  scheduled_at: string | null;
  fixture_no: number;
  home: string | null;
  away: string | null;
  event_count: number;
};
type SettingsRaw = { division_id: string; tz: string | null; match_minutes: number | null };
/** F4 (final review, Important) — resolved once per competition, not N+1:
 *  who is on record to score, at either scope the finding names. */
type ScorerAssignmentRaw = { scope_type: "fixture" | "division"; scope_id: string };

/** The division's own "what's next" fact, SEARCHED from the full fixtures
 *  list this function already has for the division (`rows`) — never
 *  card-stats.ts's single `next` candidate, whose lateral join picks the
 *  EARLIEST fixture overall (`scheduled_at asc nulls last`, no `>= now()`
 *  floor at all) and stops at LIMIT 1. A past, unresulted kick-off sorts
 *  ahead of a genuinely future one there, so that single candidate can BE
 *  the stale one while a real "next" sits one row over, never looked at.
 *
 *  G1 fix (fix round D, Critical): this is the root of the finding's "grep
 *  for every other consumer" note — F5's guard at division-ledger.tsx and
 *  competition-desk.ts's own `nextFutureAt` both correctly REJECTED a past
 *  candidate, but neither one SEARCHED for a replacement, so a genuinely
 *  future fixture in the same division went unnamed (the ledger's `Next:`
 *  cell blanked, and the masthead's ladder fell from "Next Sun 6 Sep" to a
 *  bare "Scheduled"). Searching here, once, at the source every downstream
 *  consumer reads from (`DeskDivision.next`), fixes all of them at once.
 *
 *  Same TBD-entrant exclusion and in_play-first tie-break as card-stats.ts's
 *  query (:145-151, left untouched — other surfaces still depend on its
 *  current shape). `round_no`/`seq_in_round` are not loaded into `rows`, so
 *  a same-instant tie breaks on `fixture_no` instead; the tie itself is not
 *  a case this row's copy depends on getting right. `court_label` is not
 *  resolved here at all (no `courts` join in this query, and no consumer
 *  within the desk reads it — card-stats.ts's own `next` stays the only
 *  source of a real court label, e.g. the card grid) — see `DeskNextFixture`
 *  above; a hardcoded `court_label: null` used to sit here instead, which
 *  reads as a real (empty) answer rather than "not resolved by this query". */
function resolveDivisionNext(rows: FixtureRaw[], nowIso: string): DeskNextFixture | null {
  const nowMs = Date.parse(nowIso);
  const candidates = rows.filter(
    (f) => (f.status === "scheduled" || f.status === "in_play") && f.home !== null && f.away !== null,
  );
  const inPlay = candidates.filter((f) => f.status === "in_play");
  const pool = inPlay.length > 0
    ? inPlay
    : candidates.filter((f) => {
        if (f.scheduled_at === null) return false;
        const ms = Date.parse(f.scheduled_at);
        return !Number.isNaN(ms) && ms >= nowMs;
      });
  if (pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => {
    const aMs = a.scheduled_at ? Date.parse(a.scheduled_at) : Infinity;
    const bMs = b.scheduled_at ? Date.parse(b.scheduled_at) : Infinity;
    return aMs !== bMs ? aMs - bMs : a.fixture_no - b.fixture_no;
  });
  const picked = sorted[0]!;
  return { home: picked.home, away: picked.away, scheduled_at: picked.scheduled_at, in_play: picked.status === "in_play" };
}

export async function getCompetitionDesk(
  auth: AuthCtx,
  competitionId: string,
  now: Date = new Date(),
): Promise<CompetitionDesk> {
  const [divisions, stats] = await Promise.all([
    listDivisions(auth, competitionId),
    listDivisionCardStats(auth, competitionId),
  ]);
  const ids = divisions.map((d) => d.id);
  const { orgTz, stages, fixtures, settings, scorerAssignments } = await withTenant(auth.orgId, async (tx) => {
    const [org] = await tx<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
    const stages = ids.length
      ? await tx<StageRaw[]>`
          select s.id, s.division_id, s.name, s.seq, s.status,
                 s.progression ->> 'timing' as timing,
                 exists (select 1 from fixtures f where f.stage_id = s.id) as has_fixtures
            from stages s where s.division_id = any(${ids})`
      : [];
    // F2 fix (final review, Important): the old score-event subquery had NO
    // fixture filter at all — `group by fixture_id` over the WHOLE
    // score_events table, forcing a Seq Scan + full HashAggregate on every
    // render of every public competition page, editor or spectator, to
    // count events for the handful of fixtures this competition actually
    // has. Spec §"getCompetitionDesk" line 139 says it plainly: "one grouped
    // query over score_events for the in_play fixture ids — not N+1" — and
    // `event_count` is read nowhere except `resolveAttention`'s `no_scorer`
    // check, which only ever looks at `in_play` fixtures. Filtering the
    // subquery to exactly those ids lets the planner use
    // `score_events_fixture_idx` (fixture_id, seq) instead of scanning the
    // table; EXPLAIN ANALYZE before/after in fix-round-b-report.md.
    const fixtures = ids.length
      ? await tx<FixtureRaw[]>`
          select f.id, f.division_id, f.status, f.scheduled_at, f.fixture_no,
                 h.display_name as home, a.display_name as away,
                 coalesce(e.n, 0)::int as event_count
            from fixtures f
            left join entrants h on h.id = f.home_entrant_id
            left join entrants a on a.id = f.away_entrant_id
            left join (
              select fixture_id, count(*) as n
                from score_events
               where fixture_id = any(
                 select id from fixtures where division_id = any(${ids}) and status = 'in_play'
               )
               group by fixture_id
            ) e on e.fixture_id = f.id
           where f.division_id = any(${ids})`
      : [];
    const settings = ids.length
      ? await tx<SettingsRaw[]>`
          select division_id, tz, (config ->> 'matchMinutes')::int as match_minutes
            from schedule_settings where division_id = any(${ids})`
      : [];
    // F4 fix (final review, Important): who is on record to score, read
    // once per competition (no N+1) — both scopes the finding names, a
    // fixture-scoped assignment or a division-scoped one; a competition-
    // scoped assignment is deliberately not checked here (scorers.ts's own
    // `scorerCovers` checks all three for AUTHZ, a stricter question than
    // this attention row asks).
    const scorerAssignments = ids.length
      ? await tx<ScorerAssignmentRaw[]>`
          select scope_type, scope_id from scorer_assignments
           where (scope_type = 'division' and scope_id = any(${ids}))
              or (scope_type = 'fixture' and scope_id = any(
                    select id from fixtures where division_id = any(${ids})
                  ))`
      : [];
    return { orgTz: resolveVenueTz(null, org?.timezone), stages, fixtures, settings, scorerAssignments };
  });
  const divisionsWithScorer = new Set(
    scorerAssignments.filter((a) => a.scope_type === "division").map((a) => a.scope_id),
  );
  const fixturesWithScorer = new Set(
    scorerAssignments.filter((a) => a.scope_type === "fixture").map((a) => a.scope_id),
  );

  const nowIso = now.toISOString();
  const out = new Map<string, DeskDivision>();
  let inPlayTotal = 0;
  for (const d of divisions) {
    const s = stats.get(d.id);
    const st = settings.find((x) => x.division_id === d.id);
    const matchMinutes = st?.match_minutes ?? defaultMatchMinutes();
    // H1 fix (final review round 3, Critical — corrected ruling): resolved
    // ONCE per division and reused for BOTH the phase input's bucketing zone
    // and the row's own display_tz below — the same value division-status-
    // line.ts's `whenLabel` already prints in. `resolveVenueTz`'s own
    // precedence (division tz -> org tz -> UTC) IS the "venue zone, org as
    // fallback" rule H1 asks for; the bug was never in this function, it was
    // in division-phase.ts's caller passing the bare org zone instead of
    // this resolved value.
    const displayTz = resolveVenueTz(st?.tz, orgTz);
    const phaseStages: PhaseStage[] = stages
      .filter((x) => x.division_id === d.id)
      .map((x) => ({
        id: x.id,
        name: x.name,
        seq: x.seq,
        status: x.status,
        hasFixtures: x.has_fixtures,
        // A pending seeding stage with nothing generated is waiting on its draw.
        needsProposal: x.status === "pending" && x.timing === "setup" && !x.has_fixtures,
      }));
    const rows = fixtures.filter((x) => x.division_id === d.id);
    const phaseFixtures: PhaseFixture[] = rows.map((x) => ({
      id: x.id,
      status: x.status,
      scheduledAt: x.scheduled_at,
      eventCount: x.event_count,
      matchMinutes,
      hasScorer: fixturesWithScorer.has(x.id) || divisionsWithScorer.has(d.id),
    }));
    const input = {
      divisionStatus: d.status as DivisionStatus,
      stages: phaseStages,
      fixtures: phaseFixtures,
      now: nowIso,
      tz: displayTz,
      awaitingRegistrations: s?.awaiting_confirmation ?? 0,
    };
    const attention = resolveAttention(input);
    const needsDraw = attention.find((a) => a.kind === "needs_draw");
    const inPlay = rows.filter((x) => x.status === "in_play").length;
    inPlayTotal += inPlay;
    const fixture_names: DeskDivision["fixture_names"] = {};
    for (const x of rows) fixture_names[x.id] = { home: x.home, away: x.away, fixture_no: x.fixture_no };
    out.set(d.id, {
      phase: resolvePhase(input),
      attention,
      played: s?.played ?? 0,
      total: s?.total ?? rows.length,
      unscheduled: rows.filter((x) => x.status === "scheduled" && x.scheduled_at === null).length,
      in_play: inPlay,
      entrants: s?.entrants ?? 0,
      next: resolveDivisionNext(rows, nowIso),
      needs_draw_stage:
        needsDraw && needsDraw.kind === "needs_draw" ? { id: needsDraw.stageId, name: needsDraw.stageName } : null,
      fixture_names,
      display_tz: displayTz,
    });
  }
  log.info(
    {
      event: "competition_desk_built",
      competitionId,
      divisions: out.size,
      inPlay: inPlayTotal,
      attention: [...out.values()].reduce((n, x) => n + x.attention.length, 0),
    },
    "competition_desk_built",
  );
  return { in_play: inPlayTotal, divisions: out, now: nowIso };
}

/** The competition-level pill's phase: either a ranked/counted state, or a
 *  dated "next fixture" fact — never a phase WORD ranked against the others
 *  (see `competitionPhase` below, "competitionPhase minor" fix). */
export type CompetitionPillPhase =
  | { kind: "in_play"; n: number }
  | { kind: "match_day" }
  | { kind: "next"; at: string; tz: string }
  | { kind: "finished" }
  | { kind: "scheduled" }
  | { kind: "setting_up" };

/** A division's own `next` fixture, filtered to the same "actually still
 *  ahead of us" shape the ledger's F5 fix applies at its call site (division-
 *  ledger.tsx's `nextLine`): non-null, parseable, not already kicked off.
 *  Duplicated rather than imported — the ledger's guard lives beside the
 *  React it renders into; this one feeds a plain date, not JSX. */
function nextFutureAt(next: DeskNextFixture | null, nowIso: string): string | null {
  if (!next || next.in_play || !next.scheduled_at) return null;
  const ms = Date.parse(next.scheduled_at);
  return Number.isNaN(ms) || ms < Date.parse(nowIso) ? null : next.scheduled_at;
}

/** The competition's own pill. Spec §W1 line 152's ladder: any `in_play` →
 *  "N in play"; any `match_day` → "Match day"; else the EARLIEST next
 *  fixture date across divisions ("Next Sat 12 Sep"); all `finished` →
 *  "Finished".
 *
 *  competitionPhase minor fix (final review): the old implementation ranked
 *  the four DivisionPhase words and printed whichever ranked lowest ("in
 *  play" > "match_day" > "scheduled" > "setting_up" > "finished" default) —
 *  so the spec's third rung, "the earliest next fixture date", could never
 *  render at all (nothing ever produces a phase literally called "next"),
 *  and "setting_up" was reachable as a ranked word even once real fixtures
 *  existed with dates — confirmed live: a competition 43 matches deep read
 *  "Setting up" one row above a correctly-drawn "Needs draw" division.
 *
 *  Ladder step order matters: "any match_day" is checked BEFORE the dated
 *  fixture search (a live match day outranks a same-day dated fixture
 *  elsewhere), and "all finished" is checked AFTER it (a fully-finished
 *  competition has no live non-terminal fixture left to date, so the search
 *  always comes back empty for one — checking finished first would only
 *  ever short-circuit the search, never change the answer).
 *
 *  Where the ladder has no answer — no division carries a dated,
 *  not-yet-kicked-off fixture, AND not every division is finished (e.g.
 *  every division is still setting up with nothing dated yet) — this reads
 *  `setting_up`, the same "nothing informative has happened yet" state
 *  amendment 3 already gives an empty competition. Chosen over reusing
 *  "scheduled" (a DIVISION-level word this function no longer ranks at all)
 *  because the state genuinely means "no organiser action has produced a
 *  dated fixture yet", which is exactly what `setting_up` already means one
 *  level down. */
export function competitionPhase(desk: CompetitionDesk): CompetitionPillPhase {
  // A competition with no divisions has not begun, so it cannot be finished.
  // Amendment 3 (2026-09-02): a fresh competition rendered "Finished · 0
  // divisions" above its own "No divisions yet" empty state before this —
  // same vacuous-truth shape as the division rule the wave already amended,
  // one level up. Binding: this stays the FIRST check.
  if (desk.divisions.size === 0) return { kind: "setting_up" };
  if (desk.in_play > 0) return { kind: "in_play", n: desk.in_play };
  const divisions = [...desk.divisions.values()];
  if (divisions.some((d) => d.phase === "match_day")) return { kind: "match_day" };
  // The date travels WITH the zone it must be read in. The masthead names one
  // specific division's fixture, and that division may sit in a different zone
  // from the org: with a London org and a New York division, a 23:00Z kick-off
  // is Mon 7 Sep in the org zone and Sun 6 Sep at the venue. Formatting this in
  // `org_tz` put "Next Mon 7 Sep" directly above a row reading "Next Sun 6 Sep
  // 19:00" — the same fixture, two days, one screen. A printed instant is
  // formatted entirely in the DISPLAY zone of whoever owns it. (This comment
  // used to end "the org zone governs day-bucketing, never a label" — a ruling
  // RETIRED by H1 and corrected here in fix round F, minor 2. The rule now is
  // ONE zone per fixture: a fixture's day is its VENUE's day, the display
  // zone, for BOTH bucketing and printing. The org zone is the FALLBACK
  // `resolveVenueTz` reaches for when a division has no venue zone of its own
  // — never a second authority.)
  const dated = divisions
    .map((d) => {
      const at = nextFutureAt(d.next, desk.now);
      return at === null ? null : { at, tz: d.display_tz };
    })
    .filter((x): x is { at: string; tz: string } => x !== null)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (dated.length > 0) return { kind: "next", at: dated[0]!.at, tz: dated[0]!.tz };
  if (divisions.every((d) => d.phase === "finished")) return { kind: "finished" };
  // No usable date anywhere — the ladder's undefined case. It must still agree
  // with the rows beneath it: a competition whose divisions are in progress is
  // not "setting up". Reproduced live before this guard existed — the masthead
  // read "Setting up" directly above a row reading "Scheduled", on a knockout
  // whose only dated fixture was a TBD-entrant final (excluded from `next` by
  // card-stats) and again on a mid-season league with one match played. Same
  // masthead-contradicts-row shape the wave exists to remove.
  if (divisions.some((d) => d.phase === "scheduled" || d.phase === "match_day")) return { kind: "scheduled" };
  return { kind: "setting_up" };
}
