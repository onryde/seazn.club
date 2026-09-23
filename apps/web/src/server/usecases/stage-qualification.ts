import "server-only";
// R1a (spec 2026-09-22 §4.2, plan Task 9): the organiser console's standings
// show the same qualification status as the public pages. The console is
// force-dynamic and reads `stages` directly rather than `public_stages_v`
// (which also hides private competitions), so it calls the SAME SQL function
// the view calls — V414's `stage_qualification_meta` — and never derives a cut
// of its own.
//
// Tenant scope: the function is SECURITY DEFINER (V414 says why), so it would
// answer for ANY stage id. It is therefore only ever reached through `stages`
// under withTenant, where RLS limits the outer read to this org — an id from
// another org matches no `stages` row and the function is never called for it.
//
// Its own module, not `usecases/stages.ts`: the console page's tests mock that
// module wholesale.
//
// Returned RAW — the six columns exactly as `public_stages_v` publishes them —
// so the console hands them to the same `divisionQualification` helper the
// public surfaces use, and `stageQualMeta` stays the one mapper.
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { QualStage } from "@/server/public-site/division-qualification";

/** One stage's V414 columns — a `public_stages_v` row minus its identity. */
export type StageQualMetaRow = Omit<QualStage, "id" | "kind">;

/** stage id → its V414 meta, for the given stages of the caller's org. Ids of
 *  another org's stages are absent from the map. */
export async function listStageQualificationMeta(
  auth: AuthCtx,
  stageIds: readonly string[],
): Promise<Map<string, StageQualMetaRow>> {
  if (stageIds.length === 0) return new Map();
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<({ stage_id: string } & StageQualMetaRow)[]>`
      select s.id as stage_id,
             q.qualify_count, q.qualify_per_group, q.next_stage_name, q.swiss_rounds, q.points_rule,
             q.has_rank_overrides
      from stages s
      cross join lateral stage_qualification_meta(s.id) q
      where s.id = any(${[...stageIds]}::uuid[])`,
  );
  return new Map(rows.map(({ stage_id, ...meta }) => [stage_id, meta]));
}
