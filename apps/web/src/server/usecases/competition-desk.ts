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

export interface DeskDivision {
  division_id: string;
  phase: DivisionPhase;
  attention: Attention[];
  played: number;
  total: number;
  unscheduled: number;
  in_play: number;
  entrants: number;
  awaiting_confirmation: number;
  stage_kinds: string[];
  next: NextFixture | null;
  needs_draw_stage: { id: string; name: string } | null;
  /** For attention rows that name a fixture. */
  fixture_names: Record<string, { home: string | null; away: string | null; fixture_no: number }>;
  display_tz: string;
}

export interface CompetitionDesk {
  org_tz: string;
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
 *  instead of propagating. */
function defaultMatchMinutes(): number {
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
  const { orgTz, stages, fixtures, settings } = await withTenant(auth.orgId, async (tx) => {
    const [org] = await tx<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
    const stages = ids.length
      ? await tx<StageRaw[]>`
          select s.id, s.division_id, s.name, s.seq, s.status,
                 s.progression ->> 'timing' as timing,
                 exists (select 1 from fixtures f where f.stage_id = s.id) as has_fixtures
            from stages s where s.division_id = any(${ids})`
      : [];
    const fixtures = ids.length
      ? await tx<FixtureRaw[]>`
          select f.id, f.division_id, f.status, f.scheduled_at, f.fixture_no,
                 h.display_name as home, a.display_name as away,
                 coalesce(e.n, 0)::int as event_count
            from fixtures f
            left join entrants h on h.id = f.home_entrant_id
            left join entrants a on a.id = f.away_entrant_id
            left join (select fixture_id, count(*) as n from score_events group by fixture_id) e on e.fixture_id = f.id
           where f.division_id = any(${ids})`
      : [];
    const settings = ids.length
      ? await tx<SettingsRaw[]>`
          select division_id, tz, (config ->> 'matchMinutes')::int as match_minutes
            from schedule_settings where division_id = any(${ids})`
      : [];
    return { orgTz: resolveVenueTz(null, org?.timezone), stages, fixtures, settings };
  });

  const nowIso = now.toISOString();
  const out = new Map<string, DeskDivision>();
  let inPlayTotal = 0;
  for (const d of divisions) {
    const s = stats.get(d.id);
    const st = settings.find((x) => x.division_id === d.id);
    const matchMinutes = st?.match_minutes ?? defaultMatchMinutes();
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
    }));
    const input = {
      divisionStatus: d.status as DivisionStatus,
      stages: phaseStages,
      fixtures: phaseFixtures,
      now: nowIso,
      tz: orgTz,
      awaitingRegistrations: s?.awaiting_confirmation ?? 0,
    };
    const attention = resolveAttention(input);
    const needsDraw = attention.find((a) => a.kind === "needs_draw");
    const inPlay = rows.filter((x) => x.status === "in_play").length;
    inPlayTotal += inPlay;
    const fixture_names: DeskDivision["fixture_names"] = {};
    for (const x of rows) fixture_names[x.id] = { home: x.home, away: x.away, fixture_no: x.fixture_no };
    out.set(d.id, {
      division_id: d.id,
      phase: resolvePhase(input),
      attention,
      played: s?.played ?? 0,
      total: s?.total ?? rows.length,
      unscheduled: rows.filter((x) => x.status === "scheduled" && x.scheduled_at === null).length,
      in_play: inPlay,
      entrants: s?.entrants ?? 0,
      awaiting_confirmation: s?.awaiting_confirmation ?? 0,
      stage_kinds: s?.stage_kinds ?? [],
      next: s?.next ?? null,
      needs_draw_stage:
        needsDraw && needsDraw.kind === "needs_draw" ? { id: needsDraw.stageId, name: needsDraw.stageName } : null,
      fixture_names,
      display_tz: resolveVenueTz(st?.tz, orgTz),
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
  return { org_tz: orgTz, in_play: inPlayTotal, divisions: out, now: nowIso };
}

/** The competition-level pill's phase: either a ranked/counted state, or a
 *  dated "next fixture" fact — never a phase WORD ranked against the others
 *  (see `competitionPhase` below, "competitionPhase minor" fix). */
export type CompetitionPillPhase =
  | { kind: "in_play"; n: number }
  | { kind: "match_day" }
  | { kind: "next"; at: string }
  | { kind: "finished" }
  | { kind: "setting_up" };

/** A division's own `next` fixture, filtered to the same "actually still
 *  ahead of us" shape the ledger's F5 fix applies at its call site (division-
 *  ledger.tsx's `nextLine`): non-null, parseable, not already kicked off.
 *  Duplicated rather than imported — the ledger's guard lives beside the
 *  React it renders into; this one feeds a plain date, not JSX. */
function nextFutureAt(next: NextFixture | null, nowIso: string): string | null {
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
  const dates = divisions
    .map((d) => nextFutureAt(d.next, desk.now))
    .filter((x): x is string => x !== null)
    .sort();
  if (dates.length > 0) return { kind: "next", at: dates[0]! };
  if (divisions.every((d) => d.phase === "finished")) return { kind: "finished" };
  return { kind: "setting_up" };
}
