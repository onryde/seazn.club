import "server-only";
// Constraints-v2 extras (Jul3/04 §4, §6): bulk shift (undoable) and the
// pre-publish wait-time report. Deterministic solver work only.
import { z } from "zod";
import {
  scheduleReport,
  shiftSchedule,
  type Assignment,
} from "@seazn/engine/scheduling";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendDivisionEvent } from "@/server/engine-db";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { playedFixtureIds } from "./fixture-results-sql";
import { afterScheduleWrite, divisionLockState } from "./schedule";

const MS_PER_MIN = 60_000;

export const ShiftInput = z.object({
  division_id: z.string().uuid(),
  scope: z
    .object({
      stageId: z.string().optional(),
      poolIds: z.array(z.string()).optional(),
      courts: z.array(z.string()).optional(),
      excludeLocked: z.boolean().default(true),
    })
    .default({ excludeLocked: true }),
  delta_minutes: z.number().int().min(-24 * 60).max(24 * 60).refine((n) => n !== 0, "zero shift"),
});
export type ShiftInput = z.infer<typeof ShiftInput>;

/** POST /api/v1/schedule/shift — push everything in scope by ±N minutes
 *  (10 Jun / 5 Sep / 26 Jun). One schedule_shifted ledger event; undoable
 *  via Jul3/03. All plans. */
export async function shiftDivisionSchedule(
  auth: AuthCtx,
  input: ShiftInput,
): Promise<{ shifted: number; skipped: { locked: number; decided: number }; seq: number }> {
  const divisionId = input.division_id;
  const write = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ seq: number; competition_id: string }[]>`
      select seq, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // A bulk shift moves EVERY unlocked fixture on the board and then nulls
    // `edit_watermark` — which is worse on a frozen division than the writes
    // its siblings already refuse, because nulling the watermark damages the
    // rewind the freeze exists to protect. It nonetheless had no freeze check
    // of any kind, live on POST /api/v1/schedule/shift and behind the
    // Constraints panel's "Shift whole timetable" button.
    //
    // AFTER the existence check, so a division that does not exist still
    // answers 404 rather than 422 — the ordering every sibling uses. BEFORE
    // the fixture read, so a frozen board refuses without doing the work.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    // P9 cutover: court_id, not the frozen court_label — `Assignment`/
    // `ShiftableFixture.court` is a `courts.id` identity throughout this
    // engine (toAssignment, schedule.ts), not a display value: history.ts's
    // undo replay for this very event type writes `court_id = m.to.court`
    // straight back to the row (see its own P9 comment), so feeding it a
    // resolved NAME here would 500 the very next undo with a
    // uuid-syntax error, and feeding it the frozen label would silently
    // drop every post-cutover fixture from `scope.courts` matching (that
    // scope filter requires non-null `f.court` — see report.ts).
    const rows = await tx<{
      id: string; stage_id: string; pool_id: string | null; court_id: string | null;
      scheduled_at: string | null; schedule_locked: boolean;
    }[]>`
      select id, stage_id, pool_id, court_id, scheduled_at::text as scheduled_at,
             schedule_locked
      from fixtures where division_id = ${divisionId}`;
    // History's played set (`fixtureHasResultSql`), not `decided` alone: a
    // shift that moved an in-play kick-off, or a walkover's, could then be
    // neither undone nor redone — the results-guard refuses any history step
    // that touches a played row.
    const played = await playedFixtureIds(tx, divisionId);
    const { moves, skipped } = shiftSchedule(
      rows.map((f) => ({
        id: f.id,
        at: f.scheduled_at,
        court: f.court_id,
        stageId: f.stage_id,
        poolId: f.pool_id ?? undefined,
        locked: f.schedule_locked,
        decided: played.has(f.id),
      })),
      input.scope,
      input.delta_minutes,
    );
    // R10e: the ids this write CHANGED, from its own UPDATEs.
    const fixtureIds: string[] = [];
    for (const m of moves) {
      const [row] = await tx<{ id: string }[]>`
        update fixtures set scheduled_at = ${m.to.at} where id = ${m.fixture} returning id`;
      if (row) fixtureIds.push(row.id);
    }
    if (moves.length === 0) {
      return { out: { shifted: 0, skipped, seq: division.seq }, competitionId: division.competition_id, fixtureIds };
    }
    const seq = await appendDivisionEvent(tx, divisionId, "schedule_shifted", {
      delta_minutes: input.delta_minutes,
      scope: input.scope,
      moves,
    });
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return { out: { shifted: moves.length, skipped, seq }, competitionId: division.competition_id, fixtureIds };
  });
  // R10e (review-r10d m1): a rain-delay shift moves every unlocked kick-off, so
  // the hub key and each moved fixture's `pub:v1:fixture:{id}` drop in one DEL
  // AFTER the commit, and the division and fixture pushes follow that DEL
  // (`afterScheduleWrite`, with its 50-fixture push cap). A shift that moved
  // nothing sends nothing.
  if (write.fixtureIds.length > 0) {
    afterScheduleWrite(divisionId, write.competitionId, "schedule", write.fixtureIds);
  }
  return write.out;
}

/** GET /api/v1/divisions/{id}/schedule/report — min/max wait per entrant
 *  before publish (16 Sep). Derived read model; all plans. */
export async function divisionScheduleReport(auth: AuthCtx, divisionId: string) {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [settings] = await tx<{ config: { matchMinutes?: number } }[]>`
      select config from schedule_settings where division_id = ${divisionId}`;
    const matchMinutes = settings?.config?.matchMinutes ?? 30;
    // P9 cutover: court_id, not the frozen court_label — see
    // shiftDivisionSchedule above, same `Assignment.court`-is-an-id reasoning.
    // scheduleReport() (engine, below) never reads Assignment.court, so this
    // is presently unobservable from this function's own return shape; fixed
    // for consistency with every other Assignment producer in this file/repo
    // rather than leaving a stale-column read live in a shared engine type.
    const rows = await tx<{
      id: string; court_id: string | null; scheduled_at: string;
      home_entrant_id: string | null; away_entrant_id: string | null;
    }[]>`
      select id, court_id, scheduled_at::text as scheduled_at,
             home_entrant_id, away_entrant_id
      from fixtures
      where division_id = ${divisionId} and scheduled_at is not null`;
    const assignments: Assignment[] = rows.map((f) => {
      const start = new Date(f.scheduled_at).getTime();
      return {
        fixtureId: f.id,
        court: f.court_id ?? "",
        startAt: start,
        endAt: start + matchMinutes * MS_PER_MIN,
        entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
        people: [],
      };
    });
    const names = await tx<{ id: string; display_name: string }[]>`
      select id, display_name from entrants where division_id = ${divisionId}`;
    const nameById = new Map(names.map((n) => [n.id, n.display_name]));
    const report = scheduleReport(assignments);
    const label = (r: (typeof report.perEntrant)[number]) => ({
      ...r,
      display_name: nameById.get(r.entrantId) ?? r.entrantId,
    });
    return { perEntrant: report.perEntrant.map(label), worst: report.worst.map(label) };
  });
}
