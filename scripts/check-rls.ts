// RLS guard (doc 03 §9): fail CI if any tenant table with an `org_id` column
// lacks Row-Level Security + at least one policy. Catches a new table that
// forgets isolation. Run against a bootstrapped DB:
//   node --experimental-strip-types scripts/check-rls.ts
import postgres from "postgres";
import { SUPERUSER_ONLY } from "./rls-exempt.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}


// This repo's tables live in `seazn_club`, never `public` — the same value the
// app's own client and every script set as `search_path`. The queries below
// MUST filter on it: `pg_class`/`information_schema` do not honour
// `search_path`, they need the schema named. Hardcoding 'public' made this
// guard select ZERO rows and print "RLS guard OK" while checking nothing, in CI
// as well as locally. A gate that cannot fail is worse than no gate — it is the
// reason a new table can forget isolation and still ship green.
const SCHEMA = process.env.DB_SCHEMA ?? "seazn_club";

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  connection: { search_path: SCHEMA },
  ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});

try {
  const rows = await sql<{
    table_name: string;
    rls_enabled: boolean;
    rls_forced: boolean;
    policies: number;
  }[]>`
    select
      c.relname                                   as table_name,
      c.relrowsecurity                            as rls_enabled,
      c.relforcerowsecurity                       as rls_forced,
      (select count(*)::int from pg_policies p
        where p.schemaname = ${SCHEMA} and p.tablename = c.relname) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${SCHEMA}
      and c.relkind = 'r'
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = ${SCHEMA}
          and col.table_name = c.relname
          and col.column_name = 'org_id'
      )
    order by c.relname`;

  const failures: string[] = [];
  for (const r of rows) {
    if (SUPERUSER_ONLY.has(r.table_name)) continue;
    if (!r.rls_enabled) failures.push(`${r.table_name}: RLS not enabled`);
    else if (!r.rls_forced) failures.push(`${r.table_name}: RLS not FORCEd (owner bypasses)`);
    else if (r.policies === 0) failures.push(`${r.table_name}: no policy`);
  }

  const checked = rows.filter((r) => !SUPERUSER_ONLY.has(r.table_name)).map((r) => r.table_name);
  console.log(`RLS guard: checked ${checked.length} tenant tables: ${checked.join(", ")}`);

  if (failures.length) {
    console.error("\nRLS guard FAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      "\nEvery table with an org_id column must enable+force RLS and have a" +
        " policy, or be added to SUPERUSER_ONLY in scripts/check-rls.ts with a reason.",
    );
    process.exitCode = 1;
  } else {
    console.log("RLS guard OK: all tenant tables isolated.");
  }
} catch (err) {
  console.error("RLS guard error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
