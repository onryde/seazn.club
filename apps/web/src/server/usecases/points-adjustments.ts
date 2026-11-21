import "server-only";
// W5 app PR B, Task 7 (C5; X-ADJ-1..5; RB5-T5..T9, RB5-T15, RB5-E8; ruling 284; owner R24 pick 15 A): "Adjust points" on a
// league, group or Swiss table. One ledger row per adjustment (`points_adjustment {stage_id, entrant_id, delta, reason, unit,
// points_unit}`) under the division lock, then the stage's table re-folds (`refoldStageTable`), which hands every active row to
// the engine as `TableStage.adjustments` (engine-db/competition.ts `foldedAdjustments`). Undo appends a
// `points_adjustment_voided {voids_seq}` row - the ledger's append-only reversal, as a Reinstate voids a `table_withdrawal` row.
// Neither row is a division Undo step nor a barrier (the engine's `isReversible` is false for both).
//
// Preflight rulings, binding:
// - C5: only on a STARTED (the division is under way and the stage is live), NOT-COMPLETE table stage. Before Start an adjustment
//   would draw lots for a level, unplayed pool and make the table read as started; after completion the next stage is already
//   seeded from the frozen cut. Both refused by name, and the desk hides the item.
// - C8: written only for a MEMBER of the table (seated in a pool on a seated stage, else holding a seat on one of its lines); a
//   row whose entrant stops being one is HELD by the fold, never passed (the engine would refuse every fold for it).
// - Review Focus 2: the lots draws that name the adjusted entrant are cleared, so a tie the adjustment breaks is never ordered
//   by a stale draw again, and a tie that forms afterwards draws fresh.
import { EngineError } from "@seazn/engine/core";
import { validatePointsAdjustments } from "@seazn/engine/competition";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  POINTS_ADJUSTMENT_ROW,
  POINTS_ADJUSTMENT_VOIDED_ROW,
  activePointsAdjustments,
  type AdjustmentLedgerRow,
  type PointsAdjustmentRecord,
} from "@/lib/points-adjustment-note";
import { adjustDeltaInRange, adjustRefusalCode, ADJUST_DELTA_MAX } from "@/lib/points-adjustment-offer";
import type { RoundRobinRefusalCode } from "@/lib/roundrobin-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AdjustPointsInput, PointsAdjustmentList, PointsAdjustmentWire } from "@/server/api-v1/schemas";
import { adjustmentTarget } from "@/server/engine-db";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { roundRobinRefusal } from "./roundrobin-refusal";
import { refoldStageTable } from "./stages/helpers";
import type { Tx } from "./stages/types";

/** The engine's `validatePointsAdjustments` reasons (RB5-E8, X-ADJ-3), each refused by its own name. */
const ENGINE_REASON_CODES: Readonly<Record<string, RoundRobinRefusalCode>> = {
  adjustment_zero: "RR_ADJUST_ZERO",
  adjustment_reason_missing: "RR_ADJUST_REASON_MISSING",
  adjustment_not_finite: "RR_ADJUST_NOT_FINITE",
  adjustment_unknown_entrant: "RR_ADJUST_UNKNOWN_ENTRANT",
};

interface StageFacts {
  id: string;
  kind: string;
  status: string;
  division_id: string;
  division_status: string;
  competition_id: string;
}

/** The stage, read and locked: the division advisory lock first (the global order, `division:` before any row), then the gates
 *  C5 names. A missing stage is a 404 (the auth already proved it is the caller's). */
async function lockedStage(tx: Tx, stageId: string): Promise<StageFacts> {
  const [stage] = await tx<StageFacts[]>`
    select s.id, s.kind, s.status, s.division_id, d.status as division_status, d.competition_id
      from stages s join divisions d on d.id = s.division_id
     where s.id = ${stageId}`;
  if (stage === undefined) throw new HttpError(404, "stage not found");
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
  return stage;
}

/** C5, one predicate for the write, the Undo and the desk's offer (`adjustRefusalCode`, lib/points-adjustment-offer.ts). */
function assertAdjustable(stage: Pick<StageFacts, "kind" | "status" | "division_status">): void {
  const code = adjustRefusalCode(stage, stage.division_status);
  if (code !== null) throw roundRobinRefusal(code);
}

async function stageAdjustmentRows(tx: Tx, divisionId: string): Promise<AdjustmentLedgerRow[]> {
  return tx<AdjustmentLedgerRow[]>`
    select seq::int as seq, type, payload, to_json(created_at) #>> '{}' as at from division_events
     where division_id = ${divisionId} and type in (${POINTS_ADJUSTMENT_ROW}, ${POINTS_ADJUSTMENT_VOIDED_ROW})`;
}

/** One ledger row at the division's next seq, the division's watermark moved with it (the `table_withdrawal` writer's shape). */
async function appendRow(tx: Tx, divisionId: string, type: string, payload: Record<string, unknown>, actorId: string | null): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, ${type}, ${tx.json(payload as never)}, ${actorId})`;
  await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
  return last + 1;
}

/** Review Focus 2: every stored lots draw of the stage that names the entrant - her pool's and a stage-wide cross-group one alike.
 *  Each was drawn over points the adjustment (or its Undo) has just moved; a tie that forms again draws fresh (the engine's
 *  `lotSeed` over the stage's rngSeed), with today's date. Deleted, not superseded: the loader serves a superseded draw too
 *  (`loadLotsDraws`: the newest per key, superseded or not), so only a delete keeps it from ordering the tie again. */
async function clearLotsDrawsNaming(tx: Tx, stageId: string, entrantId: string): Promise<number> {
  const rows = await tx`delete from stage_lots_draws where stage_id = ${stageId} and ${entrantId}::uuid = any(members) returning id`;
  return rows.length;
}

function toWire(r: PointsAdjustmentRecord, members: ReadonlySet<string>): PointsAdjustmentWire {
  return { ...r, held: !members.has(r.entrant_id) };
}

/** POST /stages/{id}/adjustments. */
export async function adjustPoints(auth: AuthCtx, stageId: string, input: AdjustPointsInput): Promise<{ adjustment: PointsAdjustmentWire }> {
  const out = await withTenant(auth.orgId, async (tx) => {
    const stage = await lockedStage(tx, stageId);
    assertAdjustable(stage);
    const target = await adjustmentTarget(tx, stageId);
    const reason = input.reason.trim();
    // The engine's own check, over the table's MEMBERS (C8: the entrants the fold passes an adjustment for): its four reasons, each by
    // name. A member is a declared entrant, seated when the stage is: every line-holder of a seated stage is seated (C10), so the
    // engine's `adjustment_unseated` cannot arise at the write - only later, held by the fold.
    try {
      validatePointsAdjustments([{ entrantId: input.entrant_id, delta: input.delta, reason, at: new Date(0).toISOString() }], [...target.members]);
    } catch (err) {
      const reasonCode = err instanceof EngineError ? (err.data as { reason?: unknown } | undefined)?.reason : undefined;
      const code = typeof reasonCode === "string" ? ENGINE_REASON_CODES[reasonCode] : undefined;
      if (code !== undefined) throw roundRobinRefusal(code, { entrant_id: input.entrant_id });
      throw err;
    }
    // B3 ruling 4 (m-6): a whole number of the stored unit, at most ADJUST_DELTA_MAX either way - after the engine's own reasons, so
    // an Infinity is still "not a number" by its name. The route's schema says the same; this is the refusal a direct caller meets.
    if (!adjustDeltaInRange(input.delta)) throw roundRobinRefusal("RR_ADJUST_OUT_OF_RANGE", { max: ADJUST_DELTA_MAX });
    const seq = await appendRow(
      tx,
      stage.division_id,
      POINTS_ADJUSTMENT_ROW,
      { stage_id: stageId, entrant_id: input.entrant_id, delta: input.delta, reason, unit: target.unit, points_unit: target.pointsUnit },
      auth.userId,
    );
    await clearLotsDrawsNaming(tx, stageId, input.entrant_id);
    const written = activePointsAdjustments(await stageAdjustmentRows(tx, stage.division_id)).find((r) => r.seq === seq);
    // The writer's own row must read back as active: a row the reader skips would be an adjustment nobody sees.
    if (written === undefined) throw new Error(`points_adjustment ${seq} did not read back as active`);
    return { stage, adjustment: toWire(written, target.members) };
  });
  // B3 m-5: the refold after the commit is the siblings' (`refoldStageTable`: a generate's, a seed confirm's) - best effort, logged,
  // never thrown. Thrown, a refold that failed AFTER the row committed answered the request with a 500 over a written −3, and a retry
  // wrote a second one. It cannot run inside the write's transaction: it opens its own and takes the division lock. A failed refold
  // leaves the stored table one step behind the ledger until the next refold (any score write); the row is never lost or doubled.
  await refoldStageTable(auth.orgId, out.stage, "skip");
  fireDivisionRevalidate(out.stage.division_id, out.stage.competition_id);
  return { adjustment: out.adjustment };
}

/** DELETE /stages/{id}/adjustments/{seq}: the adjustment's Undo - its void row, the lots that name the entrant cleared, the
 *  table re-folded. Gated like the write (C5): a finished table is not re-ranked by an Undo either. */
export async function undoPointsAdjustment(auth: AuthCtx, stageId: string, seq: number): Promise<{ undone: number; voided_by: number }> {
  const out = await withTenant(auth.orgId, async (tx) => {
    const stage = await lockedStage(tx, stageId);
    const rows = await stageAdjustmentRows(tx, stage.division_id);
    const row = rows.find((r) => r.seq === seq && r.type === POINTS_ADJUSTMENT_ROW);
    const payload = (row?.payload ?? {}) as { stage_id?: unknown; entrant_id?: unknown };
    if (row === undefined || payload.stage_id !== stageId) throw new HttpError(404, "adjustment not found");
    assertAdjustable(stage);
    if (!activePointsAdjustments(rows).some((r) => r.seq === seq)) throw roundRobinRefusal("RR_ADJUST_ALREADY_UNDONE");
    const voidedBy = await appendRow(tx, stage.division_id, POINTS_ADJUSTMENT_VOIDED_ROW, { voids_seq: seq, stage_id: stageId }, auth.userId);
    if (typeof payload.entrant_id === "string") await clearLotsDrawsNaming(tx, stageId, payload.entrant_id);
    return { stage, voidedBy };
  });
  await refoldStageTable(auth.orgId, out.stage, "skip");
  fireDivisionRevalidate(out.stage.division_id, out.stage.competition_id);
  return { undone: seq, voided_by: out.voidedBy };
}

/** GET /stages/{id}/adjustments: what the desk's dialog opens on - the table's unit, the entrants an adjustment can be made for now
 *  (its members, C8, each with its pool's key on a pooled stage, in pool order) and the stage's active adjustments in ledger order,
 *  each marked `held` when its entrant is no member of the table now. A stage with no table (a bracket) is refused by name. */
export async function listPointsAdjustments(auth: AuthCtx, stageId: string): Promise<PointsAdjustmentList> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; kind: string; status: string }[]>`select division_id, kind, status from stages where id = ${stageId}`;
    if (stage === undefined) throw new HttpError(404, "stage not found");
    if (adjustRefusalCode({ kind: stage.kind, status: "active" }, "active") !== null) throw roundRobinRefusal("RR_ADJUST_NOT_TABLE");
    const records = activePointsAdjustments(await stageAdjustmentRows(tx, stage.division_id)).filter((r) => r.stage_id === stageId);
    const target = await adjustmentTarget(tx, stageId);
    const keyOf = new Map((await tx<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stageId}`).map((p) => [p.id, p.key]));
    const members = [...target.members]
      .map((id) => {
        const poolId = target.poolOf?.get(id);
        return { entrant_id: id, pool: poolId === undefined ? null : (keyOf.get(poolId) ?? null) };
      })
      .sort((a, b) => (a.pool ?? "").localeCompare(b.pool ?? ""));
    return { unit: target.unit, points_unit: target.pointsUnit, members, adjustments: records.map((r) => toWire(r, target.members)) };
  });
}
