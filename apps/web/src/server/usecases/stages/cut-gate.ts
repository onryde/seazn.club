import "server-only";
// W5 Task 12b (X-BD-8, RB5-E6): the server's doors for "a cut larger than the field, or a best-Nth cut no pool can supply, is
// refused by name". Two questions, one rule (lib/field-cut-gate.ts, which the builder's Next asks too):
//   - BEFORE the draw (`refuseCutBeyondField`): the stored stage graph against the division's active roster, at the doors that draw
//     the root before Start (`refuseFormatTooSmall`) and at a `timing: "setup"` stage's own Generate. Nothing has been written.
//   - AT resolve (`refuseCutBeyondTables`): the take rules against the real tables a source finished with, before the engine
//     resolves them - so the `on_complete` path says it by name instead of the engine's STAGE_NOT_READY, which completion reads
//     as "another source is not ready yet" and swallows (stages/completion.ts).
import type { ProgressionSource, SourceShape, SourceTables } from "@seazn/engine/competition";
import { isCutTableKind, stageGraphCutIssue, takeCutIssue, type CutGraphStage } from "@/lib/field-cut-gate";
import { roundRobinRefusal } from "../roundrobin-refusal";
import type { Tx } from "./types";

/** The division's stored stage graph judged against its active roster (the field the generators read: registered and confirmed).
 *  BEFORE START ONLY - the one guard of that rule, so every door that asks (Start, Generate, Rebuild, the late-entry rebuild, a setup
 *  stage's Generate) holds it alike: after Start a withdrawal is the table's to settle (departed rows stay and rank last), so a cut
 *  equal to the original field is not refused for the one who left. */
export async function refuseCutBeyondField(tx: Tx, divisionId: string): Promise<void> {
  const [division] = await tx<{ status: string }[]>`select status from divisions where id = ${divisionId}`;
  if (division?.status === "active") return;
  const stages = await tx<{ id: string; kind: string; config: Record<string, unknown>; progression: unknown }[]>`
    select id, kind, config, progression from stages where division_id = ${divisionId} order by seq`;
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')`;
  const issue = stageGraphCutIssue(stages as CutGraphStage[], n);
  if (issue !== null) {
    throw roundRobinRefusal("RR_CUT_EXCEEDS_FIELD", { qualified: issue.qualified, max: issue.max, reason: issue.reason, stageId: stages[issue.at]!.id });
  }
}

/** Each source's take against the table it finished with. The pool sizes are the table's own rows (a departed entrant keeps her
 *  row, so a withdrawal never shrinks a cut's supply), laid out over the source's pool keys: a pool the snapshot lacks holds none.
 *  Only a league, group or Swiss table is judged; a knockout's cut is its whole-round rule's (`KO_CUT_NOT_WHOLE_ROUND`). */
export function refuseCutBeyondTables(
  sources: readonly ProgressionSource[],
  shapes: readonly SourceShape[],
  tables: readonly SourceTables[],
  resolved: readonly { id: string; kind: string }[],
): void {
  sources.forEach((source, i) => {
    const from = resolved[i]!;
    if (!isCutTableKind(from.kind)) return;
    const table = tables[i]!;
    const keys = shapes[i]!.poolKeys;
    const sizes = keys.length === 0 ? [table.pools.reduce((n, p) => n + p.rows.length, 0)] : keys.map((k) => table.pools.find((p) => p.pool === k)?.rows.length ?? 0);
    const issue = takeCutIssue(source.take, sizes);
    if (issue !== null) throw roundRobinRefusal("RR_CUT_EXCEEDS_FIELD", { qualified: issue.qualified, max: issue.max, reason: issue.reason, stageId: from.id });
  });
}
