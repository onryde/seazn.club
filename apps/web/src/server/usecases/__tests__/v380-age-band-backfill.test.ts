// RS007 safeguarding fix — V380's `age_rule` CTE fed an `UPDATE ... FROM`
// with MORE THAN ONE row per division id whenever a division carried more
// than one `{kind:"age"}` rule object (one object per configured bound is
// exactly how the wizard round-trips a single band split into a min-only
// and a max-only entry). Postgres's own documentation on this shape: a
// target row matched by more than one FROM row is updated from "not readily
// predictable which one" of them — confirmed in psql by the reviewer,
// `[{"kind":"age","minAgeAt":8},{"kind":"age","maxAgeAt":15}]` landed
// `age_min=8, age_max=NULL`. Losing `age_max` is not cosmetic: `youth`,
// recomputed further down in the SAME migration from `age_max` alone
// (`youth = age_max is not null and age_max < 18`), then reads FALSE for a
// genuine U16 division, and `resolveNameDisplay`
// (apps/web/src/server/og/model.ts) stops suppressing minors' full names on
// that division's public share images. This suite asserts on `youth`
// itself, not just on the two columns — see the first test below.
//
// No harness in this repo runs a full Flyway migration end-to-end from a
// test (grepped for one). The closest local precedent —
// court-entities-migration.test.ts / sponsor-crm-migration.test.ts —
// extracts a NAMED block from the real delta file via `-- marker:begin` /
// `:end` comments and executes it with `sql.unsafe`, so the test exercises
// the actual file on disk, never a restatement of it. This suite uses the
// same technique, against a disposable SCRATCH SCHEMA rather than the
// shared test DB's real `divisions` table: V380 (pre-fix) already applied
// to this repo's `seazn_rs007` database in an earlier session, and its last
// statement drops `divisions.eligibility` — confirmed directly in psql,
// 2026-08-28 (column absent there; `flyway_schema_history` shows version
// 380 already `success=t`). `flyway repair` (run after this fix, per the
// migration's own amend note) only realigns the recorded checksum with the
// edited file — it does not re-run V380 and cannot bring the real
// `eligibility` column back on that already-migrated database. A scratch
// schema sidesteps this: it runs the literal backfill SQL from the file
// against a fresh replica table that starts with every column the block
// needs already in place (the block is extracted from AFTER V380's own
// `alter table ... add column` statements, so those columns are pre-created
// here rather than re-run).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

const DELTA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "db",
  "migration",
  "deltas",
  "V380__division_eligibility_consolidation.sql",
);

/** Extracts the `-- eligibility-backfill:begin` … `:end` block verbatim
 *  from the real migration file, so this suite runs the actual SQL on disk
 *  rather than a paraphrase of it — the same technique
 *  court-entities-migration.test.ts uses for V374. */
function backfillBlock(): string {
  const delta = readFileSync(DELTA_PATH, "utf8");
  const m = delta.match(/-- eligibility-backfill:begin([\s\S]*?)-- eligibility-backfill:end/);
  if (!m) {
    throw new Error("eligibility-backfill block missing from V380__division_eligibility_consolidation.sql");
  }
  return m[1]!;
}

type EligibilityRule = Record<string, unknown>;

interface SeedDivision {
  eligibility: EligibilityRule[];
  age_min?: number;
  age_max?: number;
}

interface BackfillResult {
  age_min: number | null;
  age_max: number | null;
  youth: boolean;
}

/**
 * Creates a disposable schema holding a minimal `divisions` replica with
 * exactly the columns the extracted backfill block reads or writes, inserts
 * ONE division row shaped by `seed`, runs the block, reads back the derived
 * columns, and drops the schema — all inside one transaction, so nothing
 * outlives the call whether the assertions that follow pass or fail.
 */
async function runBackfill(seed: SeedDivision): Promise<BackfillResult> {
  const schema = `v380_test_${randomUUID().replace(/-/g, "")}`;
  const divisionId = randomUUID();
  const [row] = await sql.begin(async (tx) => {
    await tx.unsafe(`create schema "${schema}"`);
    await tx.unsafe(`set local search_path to "${schema}"`);
    await tx.unsafe(`
      create table divisions (
        id uuid primary key,
        eligibility jsonb,
        age_min integer,
        age_max integer,
        age_cutoff_month integer,
        age_cutoff_day integer,
        category text,
        eligibility_note text,
        youth boolean not null default false
      )`);
    await tx`
      insert into divisions (id, eligibility, age_min, age_max)
      values (
        ${divisionId},
        ${tx.json(seed.eligibility as never)},
        ${seed.age_min ?? null},
        ${seed.age_max ?? null}
      )`;

    await tx.unsafe(backfillBlock());

    const result = await tx<BackfillResult[]>`
      select age_min, age_max, youth from divisions where id = ${divisionId}`;
    await tx.unsafe(`drop schema "${schema}" cascade`);
    return result;
  });
  if (!row) throw new Error("backfill scratch row vanished");
  return row;
}

describe.skipIf(!HAS_DB)("V380 age-band backfill (safeguarding: youth derivation)", () => {
  afterAll(async () => {
    if (!HAS_DB) return;
    await sql.end();
  });

  it("a division split across a min-only and a max-only age rule keeps BOTH bounds, and youth flips true", async () => {
    const row = await runBackfill({
      eligibility: [
        { kind: "age", minAgeAt: 8 },
        { kind: "age", maxAgeAt: 15 },
      ],
    });

    expect(row.age_min).toBe(8);
    expect(row.age_max).toBe(15);
    // The safeguarding assertion: a genuine U15 division must be flagged
    // youth so `resolveNameDisplay` suppresses full player names on public
    // share images. Pre-fix this read false because `age_max` landed NULL.
    expect(row.youth).toBe(true);
  });

  it("an organiser-set age_max column still wins over the jsonb copy (coalesce precedence preserved)", async () => {
    // The hub panel already set age_max=99 directly; the wizard's older
    // jsonb copy separately says maxAgeAt=12. The column must win — this
    // pins the migration's own stated precedence, unchanged by the fix.
    const row = await runBackfill({
      eligibility: [{ kind: "age", maxAgeAt: 12 }],
      age_max: 99,
    });

    expect(row.age_max).toBe(99);
  });
});
