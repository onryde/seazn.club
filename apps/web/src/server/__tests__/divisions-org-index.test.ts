// FU4 — `divisions` carries an index that leads on `org_id`. Before the delta, `divisions` had only its PK, the
// `(competition_id, slug)` unique and the partial `divisions_active_idx`, so every "all divisions of this org" read
// sequential-scanned: the d/new history (`recentDivisionSports`), the online-seat probe (`openOrgSeatGate`), the /admin
// slot list (`slotConsumingDivisions`) and the player-stats reads (`player-stats.ts`). V254 did the same for
// `competitions` and `teams` ("lone-org_id dashboard roots").
//
// The index name, its column and "not partial" come from the task brief, never read back from the delta. The delta is
// located by GLOB, never by number (it is renumbered if another branch lands a V491 first).
//
// Three claims, each aimed at a different way of being wrong:
//   1. the applied schema has the index, btree, leading on `org_id`, NOT partial (a partial index would miss archived
//      divisions, which `slotConsumingDivisions` lists);
//   2. the planner can reach the table by that index for the single-table org-scoped shapes — with seq scans disabled a
//      missing, invalid or unusable index shows as a `Seq Scan`, which a tiny test table would otherwise hide;
//   3. the delta file itself creates that index and is idempotent (`if not exists`), proven on a TEMP shadow table in a
//      rolled-back transaction so no lock is taken on the shared `divisions`.
//
// single-sport: the index is on a sport-agnostic column and the shapes read `sport_key` as data, so no sport varies.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { connectionOptions } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../db/migration/deltas");
const NAME = /^V\d+__divisions_org_id_index\.sql$/;
/** From the brief: the index's name and its leading column. */
const INDEX = "divisions_org_idx";
const LEAD = "org_id";

type Tx = postgres.TransactionSql;
const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back. */
async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!;
  const { ssl, schema } = connectionOptions(url);
  const client = postgres(url, { max: 1, ssl, connection: { search_path: schema } });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return value as T;
}

type Plan = { "Node Type": string; "Index Name"?: string; Plans?: Plan[] };
/** Every node of a plan tree, flattened. */
const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];

/** The single-table, org-scoped shapes the app runs against `divisions` (columns and predicates as the usecases read them). */
const SHAPES: { name: string; text: (org: string) => string }[] = [
  {
    name: "recentDivisionSports: group by sport_key, newest first",
    text: (org) =>
      `select sport_key from divisions where org_id = '${org}' group by sport_key order by max(created_at) desc, sport_key`,
  },
  {
    name: "openOrgSeatGate probe: any division of the org playing online",
    text: (org) =>
      `select sport_key, config from divisions where org_id = '${org}' and config->>'onlinePlay' = 'lichess'`,
  },
  {
    name: "archived included: no archived_at filter (slotConsumingDivisions lists archived rows)",
    text: (org) => `select id, name from divisions where org_id = '${org}' order by archived_at desc limit 50`,
  },
];

describe.skipIf(!HAS_DB)("divisions.org_id index (FU4)", () => {
  it("the applied schema has a btree index named for the org, leading on org_id and not partial", async () => {
    const rows = await rolledBack((tx) =>
      tx<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes
        where schemaname = current_schema() and tablename = 'divisions' and indexname = ${INDEX}`,
    );
    expect(rows.length, `${INDEX} is missing from the applied schema (is the delta applied to this DB?)`).toBe(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(new RegExp(`USING btree \\(${LEAD}[,)]`));
    expect(def, "a partial index cannot answer an unfiltered org read").not.toMatch(/\bWHERE\b/);
  });

  it("the planner reaches divisions through that index for every org-scoped shape (seq scans disabled)", async () => {
    const org = randomUUID(); // an org with no rows: the plan is what is under test, not the data
    const verdict = await rolledBack(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const out: { name: string; types: string[]; indexes: string[] }[] = [];
      for (const s of SHAPES) {
        const [row] = await tx.unsafe<{ "QUERY PLAN": { Plan: Plan }[] }[]>(`explain (format json) ${s.text(org)}`);
        const all = nodes(row!["QUERY PLAN"][0]!.Plan);
        out.push({
          name: s.name,
          types: all.map((n) => n["Node Type"]),
          indexes: all.flatMap((n) => (n["Index Name"] ? [n["Index Name"]] : [])),
        });
      }
      return out;
    });
    // Anti-vacuity: every shape reported a plan.
    expect(verdict.length).toBe(SHAPES.length);
    expect(SHAPES.length).toBeGreaterThanOrEqual(3);
    for (const v of verdict) {
      expect(v.indexes, `${v.name}: plan was ${v.types.join(" > ")}`).toContain(INDEX);
      expect(v.types, `${v.name}: must not seq-scan divisions`).not.toContain("Seq Scan");
    }
  });

  it("the delta creates that index on a table with the divisions columns, and a second run adds nothing", async () => {
    const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
    expect(files.length, `exactly one delta matches ${NAME} in ${DELTAS}`).toBe(1);
    const code = readFileSync(resolve(DELTAS, files[0]!), "utf8").replace(/--.*$/gm, "").trim();
    expect(code.length, "the delta has statements, not only comments").toBeGreaterThan(0);

    const verdict = await rolledBack(async (tx) => {
      // A TEMP table named `divisions` shadows the real one for the unqualified name the delta uses (pg_temp is searched
      // first), so the delta acts on a copy with the real columns and takes no lock on the shared table.
      await tx.unsafe(`create temp table divisions (like divisions including defaults)`);
      const onShadow = () =>
        tx<{ indexname: string; indexdef: string }[]>`
          select indexname, indexdef from pg_indexes
          where schemaname = (select nspname from pg_namespace where oid = pg_my_temp_schema()) and tablename = 'divisions'`;
      const before = await onShadow();
      await tx.unsafe(code);
      const first = await onShadow();
      await tx.unsafe(code);
      const second = await onShadow();
      return { before, first, second };
    });
    expect(verdict.before, "the shadow starts with no index, so a pass below is the delta's doing").toEqual([]);
    expect(verdict.first.map((r) => r.indexname)).toEqual([INDEX]);
    expect(verdict.first[0]!.indexdef).toMatch(new RegExp(`USING btree \\(${LEAD}[,)]`));
    expect(verdict.first[0]!.indexdef).not.toMatch(/\bWHERE\b/);
    expect(verdict.second, "if not exists: the second run is a no-op, not an error and not a duplicate").toEqual(verdict.first);
  });
});
