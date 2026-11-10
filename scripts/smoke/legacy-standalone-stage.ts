// W4 app-A Task 16, pre-flight ruling C5: since X-SP-6 the API refuses a stepladder or page playoff that names no
// progression (422 STEPLADDER_NEEDS_TABLE_SOURCE / PAGE_PLAYOFF_NEEDS_TABLE_SOURCE), but such stages STAND — stg held 11
// on 2026-11-05 — and keep playing. The smoke checks that prove how a standalone one plays seed it here, by direct SQL,
// as the legacy row it now only can be. Twins: `apps/web/e2e/legacy-standalone-stage.ts` and the vitest
// `apps/web/src/server/usecases/__tests__/_legacy-standalone-stage.ts`.
//
// GENERIC SPORT ONLY, as a guard: the row's config is a random lots seed (`rngSeed`, as every new stage gets) and nothing
// else, exactly what the stage create wrote for a generic division's stepladder or page playoff (no preset match rules) —
// pinned by standalone-stage-refusal.test.ts ("C5 the legacy seed …").
import { smokeDb } from "./harness.ts";
import { standaloneStageRefusal } from "../../apps/web/src/lib/stage-standalone.ts";

/** Insert ONE legacy standalone stepladder or page playoff into a GENERIC division and return its id. Throws for any
 *  stage the API would take and for any other sport. */
export async function insertLegacyStandaloneStage(
  divisionId: string,
  stage: { seq: number; kind: string; name: string },
): Promise<string> {
  if (standaloneStageRefusal({ kind: stage.kind, progression: null }) === null) {
    throw new Error(`insertLegacyStandaloneStage: ${stage.kind} is not a standalone stepladder or page playoff — create it over the API`);
  }
  const sql = smokeDb();
  try {
    const [division] = await sql<{ sport_key: string }[]>`select sport_key from divisions where id = ${divisionId}`;
    if (!division) throw new Error(`insertLegacyStandaloneStage: division ${divisionId} not found`);
    if (division.sport_key !== "generic") {
      throw new Error(`insertLegacyStandaloneStage: generic divisions only (got ${division.sport_key})`);
    }
    const [row] = await sql<{ id: string }[]>`
      insert into stages (division_id, seq, kind, name, config, progression)
      values (${divisionId}, ${stage.seq}, ${stage.kind}, ${stage.name}, ${sql.json({ rngSeed: Math.floor(Math.random() * 2 ** 31) })}, null)
      returning id`;
    if (!row) throw new Error("insertLegacyStandaloneStage: the stage was not written");
    return row.id;
  } finally {
    await sql.end();
  }
}
