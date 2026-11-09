// W4 app-A Task 16, pre-flight ruling C5: since X-SP-6 the stage writers refuse a stepladder or page playoff that names
// no progression (`lib/stage-standalone.ts`), but such stages STAND — stg held 11 on 2026-11-05 (pre-flight count 5), made
// over the API before the refusal shipped — and keep playing (X-LE-8 reaches one through late entry). The suites that
// prove how a standalone one plays (its rungs, its Q1/E/Q2/F, its withdrawals, its exports) seed it here, by direct SQL,
// as the legacy row it now only can be.
//
// The row is the one `createStages` wrote before the refusal: the same columns, and the same config — the body's config
// validated and laid over the kind's preset match rules (`validatedStageConfig`, the door `createStages` uses for a new
// slot with no carry). Only the refusal is skipped.
import { sql } from "@/lib/db";
import { standaloneStageRefusal } from "@/lib/stage-standalone";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { StageKind } from "@seazn/engine/core";
import { resolveModule } from "@/server/engine-db";
import { validatedStageConfig } from "@/server/usecases/stage-defaults";
import { createStages, type StageRow } from "@/server/usecases/stages";

interface LegacyStageInput {
  seq: number;
  kind: string;
  name: string;
  config?: Record<string, unknown>;
  progression?: unknown;
}

/** Insert ONE legacy standalone stepladder or page playoff, as `createStages` wrote it before X-SP-6. Refuses (throws)
 *  any stage the product would take: this helper is for the refused shape only, never a way round another refusal. */
export async function insertLegacyStandaloneStage(divisionId: string, stage: LegacyStageInput): Promise<StageRow> {
  if (standaloneStageRefusal({ kind: stage.kind, progression: stage.progression ?? null }) === null) {
    throw new Error(`insertLegacyStandaloneStage: ${stage.kind} (seq ${stage.seq}) is not a standalone stepladder or page playoff — use createStages`);
  }
  const [division] = await sql<{ sport_key: string; module_version: string; variant_key: string; config: Record<string, unknown> | null }[]>`
    select sport_key, module_version, variant_key, config from divisions where id = ${divisionId}`;
  if (!division) throw new Error(`insertLegacyStandaloneStage: division ${divisionId} not found`);
  const config = validatedStageConfig(
    resolveModule(division.sport_key, division.module_version),
    division.sport_key,
    stage.kind as StageKind,
    division.variant_key,
    division.config,
    stage.config ?? {},
    null,
  );
  const [row] = await sql<StageRow[]>`
    insert into stages (division_id, seq, kind, name, config, progression)
    values (${divisionId}, ${stage.seq}, ${stage.kind}, ${stage.name}, ${sql.json(config as never)}, null)
    returning id, division_id, seq, kind, name, config, progression, status`;
  if (!row) throw new Error("insertLegacyStandaloneStage: the stage was not written");
  return row;
}

/** `createStages` for a batch that may hold a legacy standalone stepladder or page playoff. A batch holding none goes to
 *  the real `createStages` whole, unchanged. Otherwise each legacy stage is inserted as the legacy row
 *  (`insertLegacyStandaloneStage`) and every other one through the real `createStages`, one at a time in seq order so a
 *  later stage's `previous` source resolves. Rows come back in input order, as `createStages` returns them. */
export async function createStagesWithLegacy(
  auth: AuthCtx,
  divisionId: string,
  input: LegacyStageInput | LegacyStageInput[],
): Promise<StageRow[]> {
  const inputs = Array.isArray(input) ? input : [input];
  const isLegacy = (s: LegacyStageInput) => standaloneStageRefusal({ kind: s.kind, progression: s.progression ?? null }) !== null;
  if (!inputs.some(isLegacy)) return createStages(auth, divisionId, input as never);
  const bySeq = [...inputs].sort((a, b) => a.seq - b.seq);
  const out = new Map<LegacyStageInput, StageRow>();
  for (const s of bySeq) {
    const row = isLegacy(s) ? await insertLegacyStandaloneStage(divisionId, s) : (await createStages(auth, divisionId, s as never))[0];
    if (!row) throw new Error(`createStagesWithLegacy: seq ${s.seq} was not written`);
    out.set(s, row);
  }
  return inputs.map((s) => out.get(s)!);
}
