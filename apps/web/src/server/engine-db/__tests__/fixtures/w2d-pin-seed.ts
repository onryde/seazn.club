// W2d Task 7 (PS-8a) — the SEEDING TWIN of `w2d-pin-before.json`.
//
// `w2d-pin-before.json` is the pre-W2d snapshot (W2d spec §8, B1; plan Task 7 Step 1): `scripts/w2d/pin-scenario.ts`
// seeded it over API v1 against a prod server built at W2D_BASE (e97823e4d8, main before W2d) and read back every
// stage's standings table beside the stored rows the tables came from. This module inserts THOSE rows — every user,
// organization, competition, division, stage, entrant, fixture, match state and score event, with exactly the recorded
// UUIDs and each stage's recorded `rngSeed` — so a test can rank the same stages under today's code and compare with the
// tables the pre-W2d code printed. Row order depends on ids (the seed → id fallback and `lotSeed(rngSeed, ids)`, PS-8b),
// which is why nothing here is re-minted.
//
// Use it inside a transaction that is rolled back (the rows are one org's, but a committed seed would collide with the
// next run's identical ids). Two values are NOT the recorded ones, because they are unique across the whole database and
// a shared test DB may already hold them: the user's email and the organization's slug. The organization's subscription
// is not recorded (billing rows are not the scenario), so its `subscription_id` is null. Neither reaches a table.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tx } from "@/lib/db";

/** One recorded standings row, as `GET /stages/{id}/standings` printed it at W2D_BASE. */
export interface W2dPinTableRow {
  readonly entrantId: string;
  readonly rank: number;
  readonly points: number;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly tieBreak?: unknown;
}

/** One recorded stage: what the scenario built, and the table the pre-W2d code ranked it into. */
export interface W2dPinStage {
  readonly family: string;
  readonly competitionId: string;
  readonly divisionId: string;
  readonly sport: string;
  readonly variant: string;
  readonly divisionConfig: Readonly<Record<string, unknown>>;
  readonly divisionTiebreakers: readonly string[] | null;
  readonly stageId: string;
  readonly stageSeq: number;
  readonly kind: string;
  readonly name: string;
  readonly status: "pending" | "active" | "complete";
  readonly stageConfig: Readonly<Record<string, unknown>>;
  readonly rngSeed: number | null;
  readonly entrants: readonly { readonly id: string; readonly name: string; readonly seed: number | null }[];
  readonly fixtures: readonly unknown[];
  readonly table: readonly W2dPinTableRow[];
}

/** The tables the twin inserts, parents first (the FK order). */
export const W2D_PIN_TABLES = [
  "users",
  "organizations",
  "competitions",
  "divisions",
  "stages",
  "entrants",
  "fixtures",
  "match_states",
  "score_events",
] as const;
export type W2dPinTable = (typeof W2D_PIN_TABLES)[number];

export interface W2dPinBefore {
  readonly w2dBase: string;
  readonly scenario: string;
  readonly capturedAt: string;
  readonly orgId: string;
  /** Per sport, the pre-W2d module's own declarations (`builtinModules` at W2D_BASE): its version, its default tie-break
   *  list, its variants, and what its config schema filled in for a config with no table-points object
   *  (`defaultConfig`, the first variant's config without one, parsed; null where the schema refused it) or an empty one
   *  (`emptyPoints[key]`, null where refused). */
  readonly declarations: Readonly<
    Record<
      string,
      {
        readonly version: string;
        readonly defaultTiebreakers: readonly string[];
        readonly variants: Readonly<Record<string, unknown>>;
        readonly defaultConfig: Readonly<Record<string, unknown>> | null;
        readonly emptyPoints: Readonly<Record<string, unknown>>;
      }
    >
  >;
  readonly stages: readonly W2dPinStage[];
  readonly rows: Readonly<Record<W2dPinTable, readonly Record<string, unknown>[]>>;
}

export const W2D_PIN_BEFORE: W2dPinBefore = JSON.parse(
  readFileSync(resolve(__dirname, "w2d-pin-before.json"), "utf8"),
) as W2dPinBefore;

/** The scenario's one organization: every recorded row belongs to it. */
export const W2D_PIN_ORG_ID = W2D_PIN_BEFORE.orgId;

/** The two values that are unique across the database, replaced (see the header). Deterministic, from the ids. */
function adjusted(table: W2dPinTable, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "users") return { ...row, email: `w2d-pin-twin+${String(row.id).slice(0, 8)}@example.test` };
  if (table === "organizations") return { ...row, slug: `w2d-pin-twin-${String(row.id).slice(0, 8)}`, subscription_id: null };
  return row;
}

/** The columns a recorded row and today's table share: a column added after W2D_BASE takes its default, and a recorded
 *  key the table no longer has would be a schema drift the twin must not paper over (it throws). */
async function insertableColumns(tx: Tx, table: W2dPinTable, recorded: readonly string[]): Promise<string[]> {
  const rows = await tx<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = ${table} and is_generated = 'NEVER'`;
  const live = new Set(rows.map((r) => r.column_name));
  if (live.size === 0) throw new Error(`w2d-pin twin: table ${table} is not in the current schema`);
  const gone = recorded.filter((c) => !live.has(c));
  if (gone.length > 0) throw new Error(`w2d-pin twin: ${table} no longer has the recorded column(s) ${gone.join(", ")}`);
  return [...recorded].sort();
}

/**
 * Inserts the recorded scenario into `tx` and returns the org id and the row count per table (each equals the
 * recording's: a short insert throws). Refuses when the scenario's organization already exists — the ids are fixed, so a
 * second seed in the same database is a collision, never a merge.
 *
 * Score events go in per fixture in `seq` order, so the hash-chain trigger (`score_events_hash_chain`) links each row to
 * the one before it, exactly as the recorded appends did.
 */
export async function seedW2dPinScenario(tx: Tx): Promise<{ orgId: string; counts: Record<W2dPinTable, number> }> {
  const [present] = await tx<{ n: number }[]>`select count(*)::int as n from organizations where id = ${W2D_PIN_ORG_ID}`;
  if (present!.n !== 0) throw new Error(`w2d-pin twin: organization ${W2D_PIN_ORG_ID} already exists; seed into a rolled-back transaction`);
  const counts = {} as Record<W2dPinTable, number>;
  for (const table of W2D_PIN_TABLES) {
    const recorded = W2D_PIN_BEFORE.rows[table];
    if (!Array.isArray(recorded) || recorded.length === 0) throw new Error(`w2d-pin twin: the recording holds no ${table} rows`);
    const rows = recorded.map((r) => adjusted(table, r));
    if (table === "score_events") {
      rows.sort((a, b) => String(a.fixture_id).localeCompare(String(b.fixture_id)) || Number(a.seq) - Number(b.seq));
    }
    const columns = await insertableColumns(tx, table, Object.keys(rows[0]!));
    const list = columns.map((c) => `"${c}"`).join(", ");
    const inserted = await tx.unsafe<{ n: number }[]>(
      `with ins as (
         insert into ${table} (${list})
         select ${list} from jsonb_populate_recordset(null::${table}, ($1::text)::jsonb) with ordinality as r
         order by r.ordinality
         returning 1)
       select count(*)::int as n from ins`,
      [JSON.stringify(rows)],
    );
    if (inserted[0]!.n !== recorded.length) {
      throw new Error(`w2d-pin twin: inserted ${inserted[0]!.n} of ${recorded.length} ${table} rows`);
    }
    counts[table] = inserted[0]!.n;
  }
  return { orgId: W2D_PIN_ORG_ID, counts };
}

/** Scopes the rest of `tx` to the scenario's organization, as `withTenant` does (`app_user` + `app.current_org`), so a
 *  whole-database statement (the migration's pin) sees this org's rows alone. */
export async function asW2dPinTenant(tx: Tx, orgId: string = W2D_PIN_ORG_ID): Promise<void> {
  await tx`select set_config('app.current_org', ${orgId}, true)`;
  await tx`set local role app_user`;
}
