// W2b plan D12 / loop-F review I-4 (controller ruling, round 1): the one-off resolve that follows the W2b delta.
//
// The delta (db/migration/deltas/V*__w2b_double_walkover_and_results.sql) re-classifies every unsettled held chess
// double forfeit as a double walkover. That write seats nobody, and the cascade that turns a dead feeder into a
// walkover downstream (`resolveBracketSeats`) runs only on a score, a generate, a draw confirm or a withdrawal — so
// a re-classified semi whose sibling semi was ALREADY decided would leave the final waiting for an organiser step
// nobody is told to take. The cascade is TypeScript; SQL cannot run it. So the delta's notice names every stage it
// touched (`stages=<id,id,…>`), and this module resolves exactly those stages, one transaction each.
//
// Expected production count: 0 (ruling 104: no stored chess forfeit or double-forfeit rows on staging or production;
// Task 17 runs the pre-ship counts). The module is the answer for the case that count is not 0.
import "server-only";
import { sql, type Tx } from "@/lib/db";
import { log } from "@/server/logger";
import { invalidatePublicCache } from "@/server/usecases/scoring";
import { resolveBracketSeats } from "@/server/usecases/stages";

/** The delta's one notice starts with this; the stage list ends it. */
export const W2B_RECLASSIFY_NOTICE = "W2b double walkover reclassify";

/** The stage ids the delta's notice names. Assumptions are guards: a notice that is not the delta's, or has no stage
 *  list, throws — it is never read as "no stages". */
export function reclassifiedStagesOf(notice: string): string[] {
  if (!notice.startsWith(W2B_RECLASSIFY_NOTICE)) {
    throw new Error(`reclassifiedStagesOf: not the W2b reclassify notice: ${JSON.stringify(notice)}`);
  }
  const m = /\bstages=([0-9a-f,-]*)$/.exec(notice);
  if (!m) throw new Error(`reclassifiedStagesOf: the notice carries no stage list: ${JSON.stringify(notice)}`);
  return m[1] === "" ? [] : m[1]!.split(",");
}

export interface StageResolve {
  stageId: string;
  /** Every fixture the cascade changed (`resolveBracketSeats`' own return). */
  touched: string[];
}

/** Resolve each stage's seats inside `tx` — the cascade a score would have run. */
export async function resolveReclassifiedStagesIn(tx: Tx, stageIds: readonly string[]): Promise<StageResolve[]> {
  const out: StageResolve[] = [];
  for (const stageId of stageIds) out.push({ stageId, touched: await resolveBracketSeats(tx, stageId) });
  return out;
}

/** The one-off: each stage in its own transaction, then its public documents dropped (a cache that cannot be
 *  dropped is logged, never thrown — the seats have committed). */
export async function resolveReclassifiedStages(stageIds: readonly string[]): Promise<StageResolve[]> {
  const out: StageResolve[] = [];
  for (const stageId of stageIds) {
    const [r] = await sql.begin((tx) => resolveReclassifiedStagesIn(tx, [stageId]));
    out.push(r!);
    const [first, ...rest] = r!.touched;
    if (first === undefined) continue;
    const [stage] = await sql<{ org_id: string }[]>`select org_id from stages where id = ${stageId}`;
    if (!stage) continue;
    await invalidatePublicCache(stage.org_id, first, false, undefined, rest).catch((err: unknown) => {
      log.error({ err, stage: stageId }, "w2b resolve: public cache invalidation failed (the seats stand)");
    });
  }
  return out;
}
