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
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { assessHealth, type HealthConfig, type HealthMetric } from "@seazn/engine/scheduling/health";
import { healthFixturesFor, type HealthFixtureInput } from "@/lib/health-input";
import { loadSettings } from "./schedule";

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
  court_label: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  pool_id: string | null;
  round_no: number;
}

/** Smallest possible stage-scoped query for this feature — `scheduled_at`
 *  and `court_label` both NOT NULL in the WHERE, so every row this returns
 *  maps to a concrete `HealthFixture` with no null-handling left for the
 *  caller. No stage-scoped equivalent of `divisionFixtures` exists yet
 *  (schedule.ts's loader is division-scoped only) — this is deliberately
 *  NOT added there; see this file's header. */
async function stageFixtures(tx: Tx, stageId: string): Promise<HealthFixtureRow[]> {
  return tx<HealthFixtureRow[]>`
    select id, scheduled_at, court_label, home_entrant_id, away_entrant_id, pool_id, round_no
    from fixtures
    where stage_id = ${stageId}
      and status in ('scheduled', 'in_play', 'decided', 'finalized', 'forfeited')
      and scheduled_at is not null
      and court_label is not null
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

/**
 * getScheduleHealth (D3) — loads the stage's applied fixtures, resolves the
 * division's schedule config for matchMinutes + the ORG governing clock
 * (never `settings.tz`, the display lane — #448's trap), and runs
 * `assessHealth`. 404 unknown stage; 409 SCHEDULE_NOT_APPLIED when no
 * fixture has been scheduled yet — report-only, this never blocks Solve.
 */
export async function getScheduleHealth(auth: AuthCtx, stageId: string): Promise<ScheduleHealthReport> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; kind: string }[]>`
      select division_id, kind from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");

    const rows = await stageFixtures(tx, stageId);
    if (rows.length === 0) {
      throw new HttpError(409, "No applied schedule for this stage yet", SCHEDULE_NOT_APPLIED_CODE);
    }

    const settings = await loadSettings(tx, stage.division_id);
    const inputs: HealthFixtureInput[] = rows.map((r) => ({
      fixtureId: r.id,
      scheduledAtMs: toMs(r.scheduled_at),
      court: r.court_label,
      ...(r.home_entrant_id !== null ? { home: r.home_entrant_id } : {}),
      ...(r.away_entrant_id !== null ? { away: r.away_entrant_id } : {}),
      roundNo: r.round_no,
      ...(r.pool_id !== null ? { poolId: r.pool_id } : {}),
      divisionId: stage.division_id,
    }));
    const fixtures = healthFixturesFor(inputs, settings.config.matchMinutes, settings.orgTz);
    const config: HealthConfig = { isRoundRobin: TABLE_KINDS.has(stage.kind) };
    const assessed = assessHealth(fixtures, config);

    const report: ScheduleHealthReport = {
      stageId,
      computedAt: new Date().toISOString(),
      metrics: assessed.metrics,
    };
    logHealthAssessed(report, { divisionId: stage.division_id });
    return report;
  });
}
