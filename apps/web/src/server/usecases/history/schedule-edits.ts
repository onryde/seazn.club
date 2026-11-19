import "server-only";
import { z } from "zod";
import {
  ClearScope,
  clearSchedule as engineClearSchedule,
  removeEntrantsFromPool as engineRemovePool,
  type ClearableFixture,
} from "@seazn/engine/history";
import { snapshotFixtures } from "../fixture-snapshot";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { playedFixtureIds } from "../fixture-results-sql";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CourtId, VenueId } from "@/server/api-v1/schemas";
import { divisionLockState } from "../schedule";
import { appendEvent, divisionMeta, toEngineError, type Tx } from "./ledger";
import { execute } from "./execute";
import { publishHistoryWrite } from "./undo-redo";

export const ClearScheduleInput = z.object({
  division_id: z.string().uuid(),
  scope: ClearScope.default({ excludeLocked: true }),
  confirm: z.literal(true), // double-submit guard (Jul3/03 §6)
});
export type ClearScheduleInput = z.infer<typeof ClearScheduleInput>;

// P9 pass 3a: `court` on `ClearableFixture`/its `FixtureSnapshot` is a
// courts.id now, not a free-text label — `@seazn/engine/history`'s own
// `court: string | null` field has always been opaque (no engine logic
// inspects its content, only equality — the same "pure representation
// swap" the scheduling engine's `Assignment.court` already was), so this is
// a value-only change: `clearableFixtures`/`clearPoolEntrants` below both
// read `court_id`, and every downstream `schedule_cleared`/
// `schedule_restored`/`pool_entrants_restored` replay in `execute()` above
// already expects an id.
async function clearableFixtures(tx: Tx, divisionId: string): Promise<ClearableFixture[]> {
  const rows = await tx<{
    id: string; stage_id: string; pool_id: string | null; round_no: number | null;
    court_id: string | null; scheduled_at: string | null; schedule_locked: boolean;
  }[]>`
    select id, stage_id, pool_id, round_no, court_id, scheduled_at::text as scheduled_at,
           schedule_locked
    from fixtures where division_id = ${divisionId}`;
  const played = await playedFixtureIds(tx, divisionId);
  return rows.map((f) => ({
    id: f.id,
    stageId: f.stage_id,
    poolId: f.pool_id,
    roundNo: f.round_no,
    court: f.court_id,
    at: f.scheduled_at,
    locked: f.schedule_locked,
    decided: played.has(f.id),
  }));
}

export async function clearScheduleScoped(
  auth: AuthCtx,
  input: ClearScheduleInput,
): Promise<{ cleared: number; skipped: { locked: number; decided: number }; seq: number }> {
  const divisionId = input.division_id;
  const write = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // Clear is the control whose whole point is that it is destructive, so a
    // frozen board refusing it is the least surprising guard in the file.
    //
    // Same 422, code and sentence as every other board-write refusal — see
    // `step` above for why the list of sibling sites is NOT restated here (it
    // was restated three times in this file, and every copy was wrong). One
    // note that IS worth keeping because it is a trap rather than a list:
    // `moveFixture` (schedule/move.ts) refuses unconditionally, ahead of its own
    // `movesTimetable` test, so a freeze refuses every patch and not just a
    // reslot — while `patchFixture` (fixtures.ts) is a DIFFERENT function that
    // carries no freeze guard at all.
    //
    // The AI-plan refusals are the same code at a different status: 409, not
    // 422, and `schedule-ai/` reads `divisions.schedule_locked` directly
    // rather than through `divisionLockState` (its `divisionLockState` call
    // destructures `scopes` only and never consults `frozen`).
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    const fixtures = await clearableFixtures(tx, divisionId);
    const { event, cleared, skipped } = engineClearSchedule(fixtures, input.scope);
    if (cleared.length === 0) {
      const meta = await divisionMeta(tx, divisionId);
      return {
        out: { cleared: 0, skipped, seq: meta.seq },
        competitionId: division.competition_id,
        fixtureIds: [],
        scoredFixtureRemoved: false,
      };
    }
    const effects = { scoredFixtureRemoved: false };
    const fixtureIds = await execute(tx, divisionId, event, effects);
    const seq = await appendEvent(tx, divisionId, event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return {
      out: { cleared: cleared.length, skipped, seq },
      competitionId: division.competition_id,
      fixtureIds,
      scoredFixtureRemoved: effects.scoredFixtureRemoved,
    };
  });
  publishHistoryWrite(auth, divisionId, write.competitionId, write.fixtureIds, write.scoredFixtureRemoved);
  return write.out;
}

export async function clearPoolEntrants(
  auth: AuthCtx,
  poolId: string,
  confirm: boolean,
): Promise<{ removed: number; seq: number }> {
  if (!confirm) throw new HttpError(422, "clear-entrants requires confirm: true");
  const write = await withTenant(auth.orgId, async (tx) => {
    const [pool] = await tx<{ stage_id: string; division_id: string; competition_id: string }[]>`
      select p.stage_id, s.division_id, d.competition_id
      from pools p join stages s on s.id = p.stage_id join divisions d on d.id = s.division_id
      where p.id = ${poolId}`;
    if (!pool) throw new HttpError(404, "pool not found");
    const divisionId = pool.division_id;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    // Removing a pool's entrants deletes that pool's fixtures — a board edit
    // as destructive as `clearScheduleScoped` a few lines up, which a freeze
    // has always refused. This one never did: it was the widest hole in the
    // freeze, reachable live from POST /api/v1/pools/{id}/clear-entrants.
    //
    // AFTER the pool lookup, so a pool that does not exist (or belongs to
    // another org) still answers 404 rather than 422 — the ordering every
    // sibling in this file uses. BEFORE the fixture read and the engine call,
    // so a frozen division refuses without doing the work.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    // The snapshot IS the read: the same row `pool_entrants_restored` puts
    // back on Undo (`snapshotFixtures` / `restoreFixtures` above).
    const rows = await snapshotFixtures(tx, { poolId });
    const played = await playedFixtureIds(tx, divisionId);
    let result;
    try {
      result = engineRemovePool(
        rows.map((f) => ({
          id: f.id,
          stageId: f.stage_id,
          poolId: f.pool_id,
          roundNo: f.round_no,
          court: f.court,
          at: f.at,
          locked: f.locked,
          decided: played.has(f.id),
          snapshot: f,
        })),
        poolId,
      );
    } catch (err) {
      toEngineError(err);
    }
    const effects = { scoredFixtureRemoved: false };
    const fixtureIds = await execute(tx, divisionId, result.event, effects);
    const seq = await appendEvent(tx, divisionId, result.event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = null
             where id = ${divisionId}`;
    return {
      out: { removed: result.removed.length, seq },
      divisionId,
      competitionId: pool.competition_id,
      fixtureIds,
      scoredFixtureRemoved: effects.scoredFixtureRemoved,
    };
  });
  // R10e (found beside m1): removing a pool's entrants DELETES its fixtures, so
  // the hub and their match centres drop them the same way.
  publishHistoryWrite(auth, write.divisionId, write.competitionId, write.fixtureIds, write.scoredFixtureRemoved);
  return write.out;
}

// ---------------------------------------------------------------------------
// Division schedule lock + scope locks (Jul3/03 §4)
// ---------------------------------------------------------------------------

export const LockInput = z.object({
  schedule_locked: z.boolean().optional(),
  // P9 pass-3a-FIX: courts/venues are real ids (V374's locked_scopes
  // migration) — `scopeLocked` (schedule/board.ts) matches on court_id/venue_id,
  // not organiser-typed names. Kept identical by hand to api-v1/schemas/officiating.ts's
  // `DivisionLocks` (the OpenAPI doc schema for this same route) — that file
  // is not the runtime validator here, this one is (see the route handler),
  // but the two must not drift.
  locked_scopes: z
    .array(
      z.object({
        courts: z.array(CourtId).optional(),
        venues: z.array(VenueId).optional(),
        pool_ids: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type LockInput = z.infer<typeof LockInput>;

export async function setDivisionLocks(
  auth: AuthCtx,
  divisionId: string,
  input: LockInput,
): Promise<{ schedule_locked: boolean; locked_scopes: unknown }> {
  if (input.locked_scopes !== undefined && input.locked_scopes.length > 0) {
    // multi-site scope locking is the Pro layer (Jul3/03 §7)
    await requireFeature(auth.orgId, "schedule.versioning");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ schedule_locked: boolean; locked_scopes: unknown }[]>`
      update divisions set
        schedule_locked = coalesce(${input.schedule_locked ?? null}, schedule_locked),
        locked_scopes = coalesce(${input.locked_scopes ? tx.json(input.locked_scopes as never) : null}, locked_scopes)
      where id = ${divisionId}
      returning schedule_locked, locked_scopes`;
    if (!row) throw new HttpError(404, "division not found");
    return row;
  });
}
