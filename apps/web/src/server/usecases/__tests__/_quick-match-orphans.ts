// Shared by the quick match delete suites (plan 3 Amend T2 [A5]: the expiry sweep's, quick-match-sweep.test.ts; and Task 6's
// delete by the saver): what one quick match leaves in the database, recorded BEFORE its delete, and the check that none of it is
// left AFTER (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.8, "no orphan"). Not a test file (no `.test.` in its
// name), so vitest never collects it.
//
// The closure is READ, not typed: every foreign key of this schema from `pg_constraint`, walked from the quick match's competition
// along ON DELETE CASCADE (each child's rows found by the referencing column, then walked in turn), with every SET NULL, NO ACTION
// and RESTRICT edge out of those rows recorded as well (their rows must stop pointing at the deleted ones). The plan's typed list
// (plan 3 Global Constraints, "Hard-delete closure") is then REQUIRED to be inside what was read, so a walk that silently stopped
// short reds here instead of passing on fewer tables.
//
// Rows no foreign key reaches (the "keyless" list in the same section) are probed by the id they would carry, whether or not this
// match ever wrote one: an outbox row by its free-text reference, a slug history entry, a stream session's competition, and the rest.
//
// The system org is shared by every case, run and parallel file (A16): everything here keys on the one match's own ids, never on a
// count of the org's rows.
import { expect } from "vitest";
import { sql } from "@/lib/db";

/** One quick match, by the two ids every delete path knows. */
export interface QuickMatchIds {
  /** The `quick_matches` row's id. */
  id: string;
  competitionId: string;
}

/** One check: no row of `table` may have `column` equal to (or, for an array column, containing) `id` after the delete. `before`
 *  is how many did before it. `via` says how the probe was found: a foreign key read from the catalog, or the typed keyless list. */
export interface OrphanProbe {
  table: string;
  column: string;
  /** The column's SQL type, from the catalog (`uuid`, `text`, `uuid[]`), so the comparison can use the column's own index. */
  type: string;
  id: string;
  before: number;
  via: "fk" | "keyless";
}

/** The plan's closure (plan 3 Global Constraints, "Hard-delete closure on origin/main 1b224951d4"), every table it names as reached
 *  by ON DELETE CASCADE from `competitions`, typed from that list. The catalog's walk must reach every one of them. */
export const TYPED_CASCADE_CLOSURE = [
  // competitions →
  "divisions", "competition_events", "api_keys", "competition_passes", "pass_credit_redemptions", "registration_groups", "sponsors",
  "sponsor_packages", "quick_matches",
  // divisions →
  "stages", "entrants", "schedule_settings", "division_events", "registration_settings", "registrations", "division_checkpoints",
  "player_stat_snapshots", "player_stat_folds", "discipline_rules", "suspensions", "event_imports", "import_locks", "imports",
  // stages →
  "pools", "fixtures", "standings_snapshots", "stage_seed_proposals", "stage_round_court_tags", "stage_round_opens", "stage_lots_draws",
  // entrants →
  "entrant_members", "lineups",
  // fixtures →
  "score_events", "match_states", "device_links", "fixture_officials", "fixture_availability", "official_marks", "match_reports",
  "fixture_stream_codes", "fixture_stream_settings", "capture_records", "fixture_external_play", "fixture_video_meetings",
  "fixture_play_flags", "online_chess_audit", "fixture_seat_asks", "fixture_seat_line", "youtube_broadcasts", "fixture_calls",
  // second level
  "registration_players", "fixture_stream_pairings", "fixture_stream_phone_beats", "capture_record_sessions", "fixture_video_participants",
  "fixture_video_guard_faults",
] as const;

/** Which of the match's ids a keyless column would carry. */
type IdKind = "quickMatch" | "competition" | "division" | "fixture";

/** The plan's keyless list (same section): columns that name a quick match's rows with no foreign key. Typed from the plan. */
const KEYLESS: readonly { table: string; column: string; kinds: readonly IdKind[] }[] = [
  { table: "email_outbox", column: "ref_id", kinds: ["quickMatch"] },
  { table: "slug_history", column: "entity_id", kinds: ["competition", "division"] },
  { table: "fixture_stream_sessions", column: "competition_id", kinds: ["competition"] },
  { table: "fixture_stream_sessions", column: "division_id", kinds: ["division"] },
  { table: "capture_records", column: "competition_id", kinds: ["competition"] },
  { table: "pass_mint_refusals", column: "competition_id", kinds: ["competition"] },
  { table: "video_rooms_to_end", column: "fixture_id", kinds: ["fixture"] },
  { table: "org_addons", column: "target_competition_id", kinds: ["competition"] },
  { table: "ai_parse_previews", column: "division_ids", kinds: ["division"] },
  { table: "stream_provider_calls", column: "subject_id", kinds: ["competition", "fixture"] },
  { table: "staff_audit_log", column: "target_id", kinds: ["quickMatch", "competition"] },
];

interface FkEdge {
  child: string;
  parent: string;
  /** The first column pair of the key. A composite key (`(stage_id, org_id)` → `stages (id, org_id)`) is matched on its first pair,
   *  which finds a superset of the rows the whole key does: fine for "the rows that belong to this match". */
  childColumn: string;
  childType: string;
  parentColumn: string;
  /** pg_constraint.confdeltype: c cascade, n set null, d set default, a no action, r restrict. */
  onDelete: string;
}

/** Every foreign key in the app's schema (the connection's search path), from the catalog. */
async function foreignKeys(): Promise<FkEdge[]> {
  return sql<FkEdge[]>`
    select cc.relname as child, pc.relname as parent,
           ca.attname as "childColumn", format_type(ca.atttypid, ca.atttypmod) as "childType",
           pa.attname as "parentColumn", c.confdeltype as "onDelete"
      from pg_constraint c
      join pg_class cc on cc.oid = c.conrelid
      join pg_class pc on pc.oid = c.confrelid
      join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
     where c.contype = 'f' and c.connamespace = current_schema()::regnamespace
     order by cc.relname, ca.attname`;
}

/** The SQL type of one column, from the catalog; a column that does not exist is an error by name (a renamed keyless column must
 *  red here, never be skipped). */
async function columnType(table: string, column: string): Promise<string> {
  const [row] = await sql<{ type: string }[]>`
    select format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a join pg_class c on c.oid = a.attrelid
     where c.relnamespace = current_schema()::regnamespace and c.relname = ${table} and a.attname = ${column} and not a.attisdropped`;
  if (!row) throw new Error(`orphan check: ${table}.${column} does not exist (the plan's keyless list has drifted from the schema)`);
  return row.type;
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** How many rows of the probe's table still carry its id. */
async function countOf(p: Pick<OrphanProbe, "table" | "column" | "type" | "id">): Promise<number> {
  const isArray = p.type.endsWith("[]");
  const element = isArray ? p.type.slice(0, -2) : p.type;
  const where = isArray ? `$1::${element} = any(${ident(p.column)})` : `${ident(p.column)} = $1::${element}`;
  const [row] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${ident(p.table)} where ${where}`, [p.id]);
  return row!.n;
}

/** The rows of `table` whose `column` is one of `values`, each as JSON (every column, so a child's own key can be walked on). */
async function rowsWhere(table: string, column: string, type: string, values: readonly string[]): Promise<Record<string, unknown>[]> {
  const element = type.endsWith("[]") ? type.slice(0, -2) : type;
  const rows = await sql.unsafe<{ r: Record<string, unknown> }[]>(
    `select to_jsonb(t) as r from ${ident(table)} t where t.${ident(column)} = any($1::${element}[])`,
    [values as string[]],
  );
  return rows.map((x) => x.r);
}

/**
 * Everything one quick match has in the database right now, as probes for `expectNoOrphans`. Walks the catalog's foreign keys from
 * the match's competition (see the header), requires the walk's cascade closure to hold `TYPED_CASCADE_CLOSURE`, then adds the
 * keyless probes. A probe with `before: 0` is still checked after the delete.
 */
export async function idsOf(qm: QuickMatchIds): Promise<OrphanProbe[]> {
  const edges = await foreignKeys();
  expect(edges.length, "anti-vacuity: the catalog has foreign keys in this schema").toBeGreaterThan(0);

  // The cascade closure from `competitions`, by table, read from the catalog (the plan's list must be inside it).
  const reach = new Set<string>(["competitions"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of edges) {
      if (e.onDelete === "c" && reach.has(e.parent) && !reach.has(e.child)) {
        reach.add(e.child);
        grew = true;
      }
    }
  }
  const missing = TYPED_CASCADE_CLOSURE.filter((t) => !reach.has(t));
  expect(missing, "the plan's typed closure is inside the catalog's cascade closure from competitions").toEqual([]);

  // The match's rows, table by table: the competition, then every row a cascade reaches from rows already found.
  const rows = new Map<string, Map<string, Record<string, unknown>>>();
  const [competition] = await rowsWhere("competitions", "id", "uuid", [qm.competitionId]);
  if (!competition) throw new Error(`orphan check: competition ${qm.competitionId} does not exist before the delete`);
  rows.set("competitions", new Map([[JSON.stringify(competition), competition]]));
  const probes = new Map<string, OrphanProbe>();
  probes.set(`competitions|id|${qm.competitionId}`, {
    table: "competitions", column: "id", type: "uuid", id: qm.competitionId, before: 1, via: "fk",
  });

  const queue: string[] = ["competitions"];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const parentRows = [...(rows.get(parent)?.values() ?? [])];
    for (const e of edges.filter((x) => x.parent === parent)) {
      const values = [...new Set(parentRows.map((r) => r[e.parentColumn]).filter((v) => v !== null && v !== undefined).map(String))];
      if (values.length === 0) continue;
      const found = await rowsWhere(e.child, e.childColumn, e.childType, values);
      const perValue = new Map<string, number>();
      for (const r of found) perValue.set(String(r[e.childColumn]), (perValue.get(String(r[e.childColumn])) ?? 0) + 1);
      for (const [id, n] of perValue) {
        probes.set(`${e.child}|${e.childColumn}|${id}`, { table: e.child, column: e.childColumn, type: e.childType, id, before: n, via: "fk" });
      }
      // Only a cascade deletes the child, so only a cascade's rows are walked on; a SET NULL child survives with its column nulled.
      if (e.onDelete !== "c" || found.length === 0) continue;
      const known = rows.get(e.child) ?? new Map<string, Record<string, unknown>>();
      let added = false;
      for (const r of found) {
        const key = JSON.stringify(r);
        if (!known.has(key)) {
          known.set(key, r);
          added = true;
        }
      }
      rows.set(e.child, known);
      if (added && !queue.includes(e.child)) queue.push(e.child);
    }
  }

  // The keyless list, by the ids the walk found.
  const idsByKind: Record<IdKind, string[]> = {
    quickMatch: [qm.id],
    competition: [qm.competitionId],
    division: [...(rows.get("divisions")?.values() ?? [])].map((r) => String(r.id)),
    fixture: [...(rows.get("fixtures")?.values() ?? [])].map((r) => String(r.id)),
  };
  for (const k of KEYLESS) {
    const type = await columnType(k.table, k.column);
    for (const kind of k.kinds) {
      for (const id of idsByKind[kind]) {
        const key = `${k.table}|${k.column}|${id}`;
        if (probes.has(key)) continue;
        probes.set(key, { table: k.table, column: k.column, type, id, before: await countOf({ table: k.table, column: k.column, type, id }), via: "keyless" });
      }
    }
  }
  return [...probes.values()];
}

/** The rows `probes` recorded, summed: how many the match held before its delete. */
export const rowsRecorded = (probes: readonly OrphanProbe[]): number => probes.reduce((n, p) => n + p.before, 0);

/** The tables in which `probes` recorded at least one row. */
export const tablesRecorded = (probes: readonly OrphanProbe[]): Set<string> => new Set(probes.filter((p) => p.before > 0).map((p) => p.table));

/**
 * After the delete: every probe's table holds no row carrying its id. Fails on zero recorded rows (anti-vacuity: a match that held
 * nothing proves nothing), names every leftover, and prints what it covered.
 */
export async function expectNoOrphans(probes: readonly OrphanProbe[], label: string): Promise<void> {
  const rowsBefore = rowsRecorded(probes);
  expect(rowsBefore, `anti-vacuity (${label}): the match held rows before its delete`).toBeGreaterThan(0);
  const left: string[] = [];
  for (const p of probes) {
    const n = await countOf(p);
    if (n > 0) left.push(`${p.table}.${p.column} = ${p.id}: ${n} row(s) left (${p.before} before, ${p.via})`);
  }
  expect(left, `no row of the deleted match is left anywhere (${label})`).toEqual([]);
  const keyless = probes.filter((p) => p.via === "keyless").length;
  console.info(
    `orphan check (${label}): ${rowsBefore} rows across ${tablesRecorded(probes).size} tables gone; ${probes.length} probes, ` +
      `${keyless} of them keyless`,
  );
}

/** The opposite check, for a match that must SURVIVE a delete of another: every probe that recorded rows still has them all. */
export async function expectAllPresent(probes: readonly OrphanProbe[], label: string): Promise<void> {
  const present = probes.filter((p) => p.before > 0);
  expect(present.length, `anti-vacuity (${label}): the surviving match held rows`).toBeGreaterThan(0);
  const changed: string[] = [];
  for (const p of present) {
    const n = await countOf(p);
    if (n !== p.before) changed.push(`${p.table}.${p.column} = ${p.id}: ${p.before} before, ${n} now`);
  }
  expect(changed, `every row of the surviving match is still there (${label})`).toEqual([]);
}
