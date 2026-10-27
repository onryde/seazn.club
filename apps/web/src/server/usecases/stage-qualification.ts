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
// Returned RAW — every column the function returns, exactly as
// `public_stages_v` publishes them — so the console hands them to the same
// `divisionQualification` helper the public surfaces use, and `stageQualMeta`
// stays the one mapper. `q.*`, never a hand list: a column a later migration
// adds to the function reaches the console without an edit here (the view
// selects its columns by name, and the DB test's parity pins that the two
// agree).
//
// W2d Task 9: each row also carries the stage's TABLE rules (`table_rules`) from the one loader
// (`stageTableRulesDocs`), read in the same tenant transaction — the order the console ranks, captions and qualifies each
// table by, as the public document carries it.
import type { PointsRule } from "@seazn/engine/competition";
import { withTenant } from "@/lib/db";
import { stageTableRulesDocs } from "@/server/engine-db/table-rules";
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
  const { rows, tableRules } = await withTenant(auth.orgId, async (tx) => ({
    rows: await tx<({ stage_id: string } & StageQualMetaRow)[]>`
      select s.id as stage_id, q.*
      from stages s
      cross join lateral stage_qualification_meta(s.id) q
      where s.id = any(${[...stageIds]}::uuid[])`,
    // only the stages RLS let through above (an id of another org's stage matches no row there, so none is read here)
    tableRules: await stageTableRulesDocs(tx, stageIds),
  }));
  return new Map(rows.map(({ stage_id, ...meta }) => [stage_id, { ...meta, table_rules: tableRules[stage_id] ?? null }]));
}

/**
 * W2d final review I1 (controller ruling, 2026-10-26) - stage id → the points its PIN pays, for the given stages of the
 * caller's org that are pinned (`table_rules_pinned`, written at generate). The organiser console's stage points card reads
 * these, never the live `division.config`: a division points save after the pin lands (`rule-locks.ts`) but never reaches
 * the stage, so the live division is not what its table pays. Read through the one loader (`stageTableRulesDocs`: a pinned
 * stage's rules ARE its pin, `pinnedAt` set exactly when it is pinned, V475's pair check), under withTenant like the meta
 * above. A stage still reading the live layers (pending) is absent, and so is one the loader refused (logged there): the
 * card then reads the live division, as it did before W2d.
 */
export async function listPinnedStagePoints(auth: AuthCtx, stageIds: readonly string[]): Promise<Record<string, PointsRule>> {
  if (stageIds.length === 0) return {};
  const docs = await withTenant(auth.orgId, (tx) => stageTableRulesDocs(tx, stageIds));
  return Object.fromEntries(Object.entries(docs).flatMap(([id, doc]) => (doc.pinnedAt === null ? [] : [[id, doc.points] as const])));
}
