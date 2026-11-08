// W4 app-A Task 16, pre-flight ruling C5: since X-SP-6 the API refuses a stepladder or page playoff that names no
// progression (422 STEPLADDER_NEEDS_TABLE_SOURCE / PAGE_PLAYOFF_NEEDS_TABLE_SOURCE, `src/lib/stage-standalone.ts`), but
// such stages STAND — stg held 11 on 2026-11-05, made over the API before the refusal shipped — and keep drawing their
// rungs, their Q1/E/Q2/F and their board codes. The specs that prove how a standalone one renders seed it here, by
// direct SQL, as the legacy row it now only can be. The vitest twin is
// `src/server/usecases/__tests__/_legacy-standalone-stage.ts`.
//
// GENERIC SPORT ONLY, as a guard: the row's config is a random lots seed (`rngSeed`, as every new stage gets) and nothing
// else, which is exactly what the stage create wrote for a generic division's stepladder or page playoff (no preset match
// rules) — pinned by standalone-stage-refusal.test.ts ("C5 the legacy seed …"). Another sport has a preset to lay over,
// so it would need the vitest helper's `validatedStageConfig`, which a spec cannot load.
import { withDb } from "./helpers";
import { standaloneStageRefusal } from "../src/lib/stage-standalone";

/** Insert ONE legacy standalone stepladder or page playoff into a GENERIC division and return its id. Throws for any
 *  stage the API would take (use the API) and for any other sport (see the header). */
export async function insertLegacyStandaloneStage(
  divisionId: string,
  stage: { seq: number; kind: string; name: string },
): Promise<string> {
  if (standaloneStageRefusal({ kind: stage.kind, progression: null }) === null) {
    throw new Error(`insertLegacyStandaloneStage: ${stage.kind} is not a standalone stepladder or page playoff — create it over the API`);
  }
  return withDb(async (sql) => {
    const [division] = await sql<{ sport_key: string }[]>`select sport_key from divisions where id = ${divisionId}`;
    if (!division) throw new Error(`insertLegacyStandaloneStage: division ${divisionId} not found`);
    if (division.sport_key !== "generic") {
      throw new Error(`insertLegacyStandaloneStage: generic divisions only (got ${division.sport_key}) — its config would need the sport's preset`);
    }
    const [row] = await sql<{ id: string }[]>`
      insert into stages (division_id, seq, kind, name, config, progression)
      values (${divisionId}, ${stage.seq}, ${stage.kind}, ${stage.name}, ${sql.json({ rngSeed: Math.floor(Math.random() * 2 ** 31) })}, null)
      returning id`;
    if (!row) throw new Error("insertLegacyStandaloneStage: the stage was not written");
    return row.id;
  });
}
