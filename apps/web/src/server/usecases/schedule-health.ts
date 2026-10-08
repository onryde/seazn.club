import "server-only";
// The web-layer AUTHORITY for D3's schedule health score: loads a stage's
// applied fixtures + resolved schedule config, runs `assessHealth`, and is
// the one place that throws (404 unknown stage, 409 no schedule yet) —
// following the D2 capacity precedent exactly (capacity-guard.ts's header):
// a typed HttpError code, no widening of EngineErrorCode/ENGINE_HTTP; the
// engine lib itself throws nothing.
//
// Deliberately its OWN usecase file, not added to schedule.ts: the live
// C1 round-ordering work touches that file, and this route needs a
// STAGE-scoped fixture loader that has no equivalent there today
// (`divisionFixtures` is division-scoped only) — adding one to schedule.ts
// for this feature would be an avoidable merge collision for no shared
// benefit. `stageFixtures` below is intentionally the smallest possible
// query for this purpose (a handful of columns, not the full `FixtureLite`
// column set) rather than importing schedule.ts's private column list.
//
// `computeStageHealth` (below) is the ONE per-stage computation both the
// single-stage route and the joint competition route call — never a second
// copy. This is not incidental tidiness: P1's competition-scope capacity
// guard (`competition-schedule-ai.ts:2482-2489`) built its per-division
// config with `toSlotConfig` alone, which never sets `.tz`, where
// `toVerifyConfig` does — the compiler could not catch it (`SlotConfig` is
// structurally assignable to `VerifyConfig`), and the guard silently
// no-opped on every division until a review round caught it. That bug was
// possible only because the joint path had grown its OWN config-building
// code instead of calling the already-correct single-division path. This
// file structurally forecloses that: `getCompetitionScheduleHealth` calls
// `computeStageHealth` — the exact function `getScheduleHealth` calls —
// once per stage, so there is no second implementation left to fork from
// the first. Asserted directly, not just claimed: `scripts/smoke.ts`'s
// `scheduleHealthSuite` (the "embedded stage report EXACTLY matches the
// standalone stage route's own report" check) and
// `apps/web/e2e/schedule-health.spec.ts`'s joint test (the
// "exact-match cross-check" — `JSON.stringify` byte comparison) both
// require a stage's entry inside a joint response to equal that same
// stage's standalone report exactly.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { assessHealth, type HealthConfig, type HealthFixture, type HealthMetric } from "@seazn/engine/scheduling/health";
import { healthFixturesFor, type HealthFixtureInput } from "@/lib/health-input";
import { courtNamesById, loadSettings } from "./schedule";

type Tx = postgres.TransactionSql;

export { healthFixturesFor, type HealthFixtureInput } from "@/lib/health-input";

/**
 * The one typed code this route throws on 409 — ALL_CAPS_SNAKE, no dots,
 * matching every other typed HttpError code in this tree (grepped before
 * choosing this: the design doc's own `schedule.not_applied` citation does
 * not match ANY existing code here, the same false-premise shape D2's
 * ruling #1 already found for `capacity.impossible`).
 */
export const SCHEDULE_NOT_APPLIED_CODE = "SCHEDULE_NOT_APPLIED";

/** Table-shaped stages only — round-robin's home/away pattern is meaningful
 *  for these and structurally absent for an elimination bracket. Mirrors
 *  the SAME classification already declared locally in six other files
 *  (scoring.ts, org-posts.ts, stages.ts, competition.ts, withdrawal.ts,
 *  slideshow-data.ts) — this codebase's own convention is a local copy per
 *  file rather than one shared export, so this follows suit rather than
 *  introducing the first centralised one. */
const TABLE_KINDS = new Set(["league", "group", "swiss", "americano"]);

export interface ScheduleHealthReport {
  stageId: string;
  computedAt: string;
  metrics: HealthMetric[];
}

interface HealthFixtureRow {
  id: string;
  scheduled_at: string | Date;
  /** P9 pass 3a (venues/courts cutover): a real `courts.id` — health scoring
   *  keys on this now, never the legacy free-text `court_label`, which
   *  writers stop populating (owner ruling, FULL cutover). A fixture with
   *  `court_id` set and `court_label` NULL (the post-drop-PR world already)
   *  is healthy and scoreable — this file no longer reads that column at
   *  all, so there is nothing left in it to disagree with `court_id`. */
  court_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  pool_id: string | null;
  round_no: number;
}

/** Smallest possible stage-scoped query for this feature — `scheduled_at`
 *  and `court_id` both NOT NULL in the WHERE, so every row this returns
 *  maps to a concrete `HealthFixture` with no null-handling left for the
 *  caller. No stage-scoped equivalent of `divisionFixtures` exists yet
 *  (schedule.ts's loader is division-scoped only) — this is deliberately
 *  NOT added there; see this file's header. */
// Review finding #1: `abandoned` IS a status this occupies real court time
// under — it is a valid state in the canonical enum (api-v1/schemas.ts's
// `Fixture.status`) and `me-officiating.ts`'s own FINISHED_STATUSES groups
// it with decided/finalized/forfeited as "the match happened". Dropping it
// here would shrink an affected entrant's restSpread `span_e` and invent a
// phantom idle gap on its court-day for gapDispersion/primeSlotFairness —
// the board would read as healthier than it actually is. `cancelled` is
// deliberately NOT included: unlike abandoned, a cancelled fixture is not
// established to have occupied a court slot at all, and the review finding
// this comment answers was scoped to abandoned specifically.
async function stageFixtures(tx: Tx, stageId: string): Promise<HealthFixtureRow[]> {
  return tx<HealthFixtureRow[]>`
    select id, scheduled_at, court_id, home_entrant_id, away_entrant_id, pool_id, round_no
    from fixtures
    where stage_id = ${stageId}
      and status in ('scheduled', 'in_play', 'decided', 'finalized', 'abandoned', 'forfeited', 'needs_decision')
      and scheduled_at is not null
      and court_id is not null
    order by scheduled_at`;
}

function toMs(v: string | Date): number {
  return typeof v === "string" ? Date.parse(v) : v.getTime();
}

/**
 * Structured logging (design doc's "pino event schedule_health_assessed",
 * scores only): fired from the server-side consumer, never inside the pure
 * lib — same split as `logCapacityAssessed` (capacity-guard.ts).
 */
function logHealthAssessed(report: ScheduleHealthReport, context: { divisionId: string }): void {
  log.info(
    {
      event: "schedule_health_assessed",
      stageId: report.stageId,
      divisionId: context.divisionId,
      scores: Object.fromEntries(report.metrics.map((m) => [m.key, m.score])),
    },
    "schedule_health_assessed",
  );
}

function logCompetitionHealthAssessed(report: CompetitionScheduleHealthReport): void {
  log.info(
    {
      event: "schedule_health_assessed",
      competitionId: report.competitionId,
      divisions: report.divisions.length,
      readyStages: report.divisions.reduce((n, d) => n + d.stages.filter((s) => s.status === "ready").length, 0),
      combinedScores: Object.fromEntries(report.combined.metrics.map((m) => [m.key, m.score])),
    },
    "schedule_health_assessed",
  );
}

/** Either a fully-computed report (a schedule exists) or a bare "empty"
 *  marker (no fixture scheduled yet) — the shape the single-stage route
 *  turns into a 409 and the joint route turns into one entry in a
 *  division's `stages` array, never a whole-response abort. `fixtures` is
 *  carried alongside `metrics` so the joint aggregator can union them into
 *  the COMBINED block without a second DB round trip or a second
 *  `healthFixturesFor` call. */
type StageHealthResult =
  | { stageId: string; divisionId: string; status: "empty" }
  | {
      stageId: string;
      divisionId: string;
      status: "ready";
      computedAt: string;
      metrics: HealthMetric[];
      fixtures: HealthFixture[];
    };

/**
 * THE per-stage computation — called by both `getScheduleHealth` (single
 * stage) and `getCompetitionScheduleHealth` (joint), and by neither of them
 * a second time under a different name. See this file's header for why
 * that matters more than it looks like it should.
 */
async function computeStageHealth(tx: Tx, stageId: string): Promise<StageHealthResult> {
  const [stage] = await tx<{ division_id: string; kind: string }[]>`
    select division_id, kind from stages where id = ${stageId}`;
  if (!stage) throw new HttpError(404, `stage not found: ${stageId}`);

  const rows = await stageFixtures(tx, stageId);
  if (rows.length === 0) {
    return { stageId, divisionId: stage.division_id, status: "empty" };
  }

  const settings = await loadSettings(tx, stage.division_id);
  const inputs: HealthFixtureInput[] = rows.map((r) => ({
    fixtureId: r.id,
    scheduledAtMs: toMs(r.scheduled_at),
    court: r.court_id,
    ...(r.home_entrant_id !== null ? { home: r.home_entrant_id } : {}),
    ...(r.away_entrant_id !== null ? { away: r.away_entrant_id } : {}),
    roundNo: r.round_no,
    ...(r.pool_id !== null ? { poolId: r.pool_id } : {}),
    divisionId: stage.division_id,
  }));
  const fixtures = healthFixturesFor(inputs, settings.config.matchMinutes, settings.orgTz);
  const config: HealthConfig = { isRoundRobin: TABLE_KINDS.has(stage.kind) };
  const assessed = assessHealth(fixtures, config);

  return {
    stageId,
    divisionId: stage.division_id,
    status: "ready",
    computedAt: new Date().toISOString(),
    metrics: await withResolvedOffenderLabels(tx, assessed.metrics),
    fixtures,
  };
}

/**
 * Replace entrant-kind offender labels with the entrant's display name, and
 * (P9 pass 3a) a courtDay-kind offender's embedded court id with the
 * court's own name.
 *
 * The engine is pure and knows nothing about the `entrants`/`courts` tables,
 * so `HealthOffender.label` arrives as a raw id (entrant) or built from one
 * (courtDay: `${court} ${dayKey}`, `court` being `HealthFixture.court` —
 * health.ts documents this verbatim, "Raw id (entrant id, court label, or
 * `${court}::${dayKey}`) … the module and the route stay at raw labels for
 * now"). Nothing then did the resolving for entrants, so the panel rendered
 * `Entrant · e3a37cef-54f3-47cc-…`: a seam left for a later pass that
 * shipped user-visible. `court`/`courtDay` were genuinely fine to pass
 * through untouched when that comment was written — `HealthFixture.court`
 * was still the free-text `court_label` then, already a display string.
 * P9 pass 3a's cutover (`computeStageHealth`/`stageFixtures` above feed it
 * `court_id` now) means a courtDay offender's label would start rendering a
 * bare uuid too unless resolved here — the same bug, one field later.
 * Resolving both is the APP layer's job — teaching the engine about a table
 * would be the wrong fix, and it stays a pure function this way.
 *
 * Applied INSIDE `computeStageHealth`, deliberately, so the single-stage
 * route and the joint route cannot diverge: this file's whole premise is
 * that there is exactly one per-stage computation (see the header), and
 * both the smoke suite and the joint e2e byte-compare a stage's embedded
 * report against its standalone one. Resolving names in either caller
 * instead would break that equality on the first run.
 *
 * An id with no matching row keeps the id (entrant) or the raw court id
 * inside the courtDay label rather than rendering blank — a withdrawn
 * entrant or a since-deleted court still deserves an identifiable row.
 */
async function withResolvedOffenderLabels(tx: Tx, metrics: HealthMetric[]): Promise<HealthMetric[]> {
  const entrantIds = [
    ...new Set(
      metrics.flatMap((m) => m.offenders.filter((o) => o.kind === "entrant").map((o) => o.id)),
    ),
  ];
  // `kind: "court"` is declared on the engine's HealthOffender union but no
  // metric currently emits it (grep-verified, health.ts) — checked here
  // anyway, defensively, so a future emitter is covered for free rather than
  // silently rendering a uuid the day one is added.
  const needsCourtNames = metrics.some((m) =>
    m.offenders.some((o) => o.kind === "courtDay" || o.kind === "court"),
  );
  if (entrantIds.length === 0 && !needsCourtNames) return metrics;

  const [entrantRows, courtNames] = await Promise.all([
    entrantIds.length > 0
      ? tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where id = any(${entrantIds}::uuid[])`
      : Promise.resolve([]),
    needsCourtNames ? courtNamesById(tx) : Promise.resolve(new Map<string, string>()),
  ]);
  const nameById = new Map(entrantRows.map((r) => [r.id, r.display_name]));

  return metrics.map((m) => ({
    ...m,
    offenders: m.offenders.map((o) => {
      if (o.kind === "entrant") return { ...o, label: nameById.get(o.id) ?? o.label };
      if (o.kind === "courtDay") {
        // `courtDayKey` (health.ts) builds `o.id` as `${court}::${dayKey}` —
        // the SAME split `gapDispersionMetric` itself uses to build the
        // UNRESOLVED label this replaces.
        const [courtId, dayKey] = o.id.split("::");
        const name = courtId !== undefined ? courtNames.get(courtId) : undefined;
        return name !== undefined ? { ...o, label: `${name} ${dayKey}` } : o;
      }
      if (o.kind === "court") {
        const name = courtNames.get(o.id);
        return name !== undefined ? { ...o, label: name } : o;
      }
      return o;
    }),
  }));
}

/**
 * getScheduleHealth (D3) — loads the stage's applied fixtures, resolves the
 * division's schedule config for matchMinutes + the ORG governing clock
 * (never `settings.tz`, the display lane — #448's trap), and runs
 * `assessHealth`. 404 unknown stage; 409 SCHEDULE_NOT_APPLIED when no
 * fixture has been scheduled yet — report-only, this never blocks Solve.
 */
export async function getScheduleHealth(auth: AuthCtx, stageId: string): Promise<ScheduleHealthReport> {
  const result = await withTenant(auth.orgId, (tx) => computeStageHealth(tx, stageId));
  if (result.status === "empty") {
    throw new HttpError(409, "No applied schedule for this stage yet", SCHEDULE_NOT_APPLIED_CODE);
  }
  const report: ScheduleHealthReport = {
    stageId: result.stageId,
    computedAt: result.computedAt,
    metrics: result.metrics,
  };
  logHealthAssessed(report, { divisionId: result.divisionId });
  return report;
}

export type StageHealthEntry =
  | { stageId: string; status: "empty" }
  | { stageId: string; status: "ready"; computedAt: string; metrics: HealthMetric[] };

export interface DivisionHealthEntry {
  divisionId: string;
  name: string;
  stages: StageHealthEntry[];
}

export interface CompetitionScheduleHealthReport {
  competitionId: string;
  computedAt: string;
  divisions: DivisionHealthEntry[];
  /** gapDispersion + primeSlotFairness ONLY, computed over the UNION of
   *  every ready stage's fixtures across every division (design doc,
   *  verbatim: "computed over the union where meaningful" — these two key
   *  off shared court-day resources; the other three are per-entrant, and
   *  entrants never cross divisions, so combining them would not mean
   *  anything). Always exactly 2 entries. */
  combined: { metrics: HealthMetric[] };
}

const COMBINED_METRIC_KEYS = new Set(["gapDispersion", "primeSlotFairness"]);

/**
 * getCompetitionScheduleHealth (D3 joint variant) — every division under
 * the competition, every one of ITS stages assessed via `computeStageHealth`
 * (never a second implementation — see this file's header), reported in
 * full even when some stages have no applied schedule yet: a joint report
 * names every division's state rather than aborting the whole call because
 * ONE division is not ready, the same "aggregate, don't short-circuit"
 * shape `aiPlanForCompetition` (P1) uses for its per-division capacity
 * check. 404 only for an unknown competition — an empty or all-unscheduled
 * competition is still a valid 200 (there is something real to report:
 * which divisions/stages are and are not ready), never a synthetic 409.
 */
export async function getCompetitionScheduleHealth(
  auth: AuthCtx,
  competitionId: string,
): Promise<CompetitionScheduleHealthReport> {
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ id: string }[]>`select id from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");

    const divisionRows = await tx<{ id: string; name: string }[]>`
      select id, name from divisions where competition_id = ${competitionId} order by name, id`;
    const stageRows = await tx<{ id: string; division_id: string }[]>`
      select s.id, s.division_id from stages s
      join divisions d on d.id = s.division_id
      where d.competition_id = ${competitionId}
      order by d.name, d.id, s.seq, s.id`;

    const byDivision = new Map<string, StageHealthEntry[]>();
    const combinedFixtures: HealthFixture[] = [];
    for (const s of stageRows) {
      const result = await computeStageHealth(tx, s.id);
      const entry: StageHealthEntry =
        result.status === "ready"
          ? { stageId: result.stageId, status: "ready", computedAt: result.computedAt, metrics: result.metrics }
          : { stageId: result.stageId, status: "empty" };
      const list = byDivision.get(result.divisionId);
      if (list !== undefined) list.push(entry);
      else byDivision.set(result.divisionId, [entry]);
      if (result.status === "ready") combinedFixtures.push(...result.fixtures);
    }

    const divisions: DivisionHealthEntry[] = divisionRows.map((d) => ({
      divisionId: d.id,
      name: d.name,
      stages: byDivision.get(d.id) ?? [],
    }));

    // isRoundRobin is irrelevant to the two metrics COMBINED keeps
    // (neither reads it — only homeAwayAlternation does, and that is
    // filtered out below) — `false` is a deterministic placeholder, not a
    // real classification of a fixture set that may span several stage
    // kinds at once.
    const combinedAssessed = assessHealth(combinedFixtures, { isRoundRobin: false });
    // The combined block calls `assessHealth` DIRECTLY rather than going
    // through `computeStageHealth`, because it scores the union of every
    // stage's fixtures and there is no single stage to compute. That means
    // it does not inherit the offender-label resolution either, and it must
    // ask for it explicitly: `primeSlotFairness` emits `kind: "entrant"`
    // offenders and `gapDispersion` emits `kind: "courtDay"` ones — BOTH of
    // COMBINED's two kept metrics — so without this the joint report still
    // rendered `Entrant · <uuid>` (and, since P9 pass 3a, a bare court uuid
    // in every courtDay label too) — the same bug the per-stage path fixed,
    // left open one caller away because the first fix stopped at the
    // emitter the report named.
    const combined = {
      metrics: await withResolvedOffenderLabels(
        tx,
        combinedAssessed.metrics.filter((m) => COMBINED_METRIC_KEYS.has(m.key)),
      ),
    };

    const report: CompetitionScheduleHealthReport = {
      competitionId,
      computedAt: new Date().toISOString(),
      divisions,
      combined,
    };
    logCompetitionHealthAssessed(report);
    return report;
  });
}
