// Sync the DB sport catalog from the engine registry (PROMPT-10 task 2).
// The `sports` + system `sport_variants` rows are GENERATED from module
// metadata, never hand-edited: this script upserts one `sports` row per shipped
// SportModule and one system `sport_variants` row per named preset the module
// declares, then PRUNES any system variant row the engine no longer declares
// (#431 ruling 3 — dropping cricket's `pairs-6-a-side` left a stale row behind
// forever, because there used to be no prune step to remove it). Run after
// db:apply, as the superuser (bypasses RLS to write the global catalog +
// org_id=null system presets):
//   node --experimental-strip-types scripts/sync-sports.ts
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { builtinModules } from "@seazn/engine/sports";

type Sql = ReturnType<typeof postgres>;

// Human display names for the sport keys (engine modules carry only keys).
// Anything not listed falls back to a title-cased key.
const SPORT_NAMES: Record<string, string> = {
  football: "Football",
  cricket: "Cricket",
  volleyball: "Volleyball",
  badminton: "Badminton",
  tabletennis: "Table Tennis",
  tennis: "Tennis",
  icehockey: "Ice Hockey",
  hockey: "Hockey",
  boardgame: "Board game",
  generic: "Generic",
};

function titleCase(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Upserts one `sports` row per shipped SportModule and one system
 * `sport_variants` row per named preset, then deletes any SYSTEM variant row
 * this run did not touch — a preset the engine used to declare and has since
 * dropped (e.g. #431 ruling 3, cricket's `pairs-6-a-side`). Without this, a
 * removed preset's row lives in the DB forever: it still resolves for
 * `createDivision`/`patchDivision`'s variant lookup even after the engine
 * stops declaring it.
 *
 * Scoped to `is_system = true` only: an org's own authored variant
 * (`is_system = false`, a real `org_id`) is never a prune candidate, whatever
 * the engine currently ships — this script owns only the global, org_id=null
 * system presets.
 *
 * Exported so the prune step is testable directly against a real DB, not just
 * readable. The CLI tail below (only run when this file is executed directly)
 * is the one production caller.
 */
export async function syncSports(
  sql: Sql,
): Promise<{ sportCount: number; variantCount: number; prunedCount: number }> {
  let sportCount = 0;
  let variantCount = 0;
  const upserted = new Set<string>(); // `${sport_key}::${key}`

  for (const module of builtinModules) {
    const name = SPORT_NAMES[module.key] ?? titleCase(module.key);
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${module.key}, ${name}, ${module.version}, ${sql.json(module.positions)})
      on conflict (key) do update set
        name = excluded.name,
        module_version = excluded.module_version,
        position_catalog = excluded.position_catalog
    `;
    sportCount++;

    for (const [variantKey, config] of Object.entries(module.variants)) {
      await sql`
        insert into sport_variants (sport_key, key, name, config, is_system, org_id)
        values (${module.key}, ${variantKey}, ${titleCase(variantKey)},
                ${sql.json(config ?? {})}, true, null)
        on conflict on constraint sport_variants_pkey do update set
          name = excluded.name,
          config = excluded.config,
          is_system = true
      `;
      variantCount++;
      upserted.add(`${module.key}::${variantKey}`);
    }
  }

  const systemRows = await sql<{ sport_key: string; key: string }[]>`
    select sport_key, key from sport_variants where is_system = true
  `;
  let prunedCount = 0;
  for (const row of systemRows) {
    if (upserted.has(`${row.sport_key}::${row.key}`)) continue;
    await sql`
      delete from sport_variants
      where sport_key = ${row.sport_key} and key = ${row.key} and is_system = true
    `;
    prunedCount++;
  }

  return { sportCount, variantCount, prunedCount };
}

// Run only when executed directly (not when imported by a test) — same guard
// idiom as scripts/reconcile-stranded-wallets.ts and friends.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });

  try {
    const { sportCount, variantCount, prunedCount } = await syncSports(sql);
    console.log(
      `sync-sports: upserted ${sportCount} sports, ${variantCount} system variants, ` +
        `pruned ${prunedCount} orphaned system variant${prunedCount === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    console.error("sync-sports FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
