// W2d Task 7 (review m6) — the V475 mutants that no text row can express, re-runnable by anyone.
//
// `pnpm mutate` edits the delta's TEXT, and the pin test installs the delta's functions from that text inside a
// rolled-back transaction, so a text mutant of a function is judged by the pin test. The rest of V475 is judged against
// the APPLIED migration: the pin columns' checks, `stage_lots_draws`' keys, checks, foreign key, trigger and RLS, and the
// read function `stage_qualification_meta` as the public pages call it. This driver mutates those IN the database,
// one at a time, runs the killer test file, and restores — on a seazn-env LABEL database only:
//
//   eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label <label>)"
//   node --experimental-strip-types scripts/w2d/ddl-mutants.ts all          # or: --list | --fingerprint | <ids…>
//
// Refuses unless DATABASE_URL names 127.0.0.1/localhost and a `seazn_<label>` database whose data directory is that
// label's (`$SEAZN_ENV_ROOT/<label>/pg`, default root /tmp/seazn-env) — never staging, production, or another session's
// server. A catalog fingerprint (every constraint of `stages` and `stage_lots_draws`, the lots table's indexes, trigger,
// RLS flags and policy, and the read function's definition) is taken first; each mutant must change it, and each restore
// must give it back exactly, or the run stops. Each killer file must pass in full before the first mutant (the baseline).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { isMainModule } from "../lib/main-module.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const WEB = join(REPO, "apps/web");
/** The killer files, relative to apps/web. */
export const PIN_TEST = "src/server/engine-db/__tests__/w2d-migration-pin.test.ts";
export const LINES_TEST = "src/server/public-site/__tests__/stage-format-lines-db.test.ts";

export interface LabelDb {
  host: string;
  database: string;
  label: string;
}

/** The label database DATABASE_URL names, or a refusal. Never echoes the URL: it may carry a password. */
export function labelDbOf(url: string | undefined): LabelDb {
  if (url === undefined || url === "") throw new Error("DATABASE_URL is required (a seazn-env label database)");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("DATABASE_URL does not parse as a URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("DATABASE_URL is not a postgres URL");
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Error(`refusing host ${u.hostname}: a LOCAL label database only (never staging or production)`);
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const m = /^seazn_([a-z0-9][a-z0-9-]*)$/.exec(database);
  if (!m) throw new Error(`refusing database "${database}": a seazn-env label database is named seazn_<label>`);
  return { host: u.hostname, database, label: m[1] };
}

/** The data directory a label's server runs from (seazn-env's layout). */
export function labelDataDirectory(label: string, root = process.env.SEAZN_ENV_ROOT ?? "/tmp/seazn-env"): string {
  return `${root.replace(/\/+$/, "")}/${label}/pg`;
}

export interface DdlMutant {
  id: string;
  /** The killer test file (relative to apps/web). */
  killer: string;
  apply: string;
  restore: string;
}

/** `create or replace function <name>(…) … $$;` out of the W2d delta's own text, placeholder filled. */
export function deltaFunction(text: string, name: string, schema: string): string {
  const code = text.replace(/--.*$/gm, "");
  const hit = [...code.matchAll(/create or replace function ([a-z_0-9]+)\s*\([\s\S]*?\$\$;/g)].filter((m) => m[1] === name);
  if (hit.length !== 1) throw new Error(`the W2d delta defines ${name} ${hit.length} time(s), not once`);
  return hit[0][0].replace(/\$\{flyway:defaultSchema\}/g, schema);
}

function replaceOnce(sql: string, find: string, replace: string, id: string): string {
  const n = sql.split(find).length - 1;
  if (n !== 1) throw new Error(`${id}: the mutant's text occurs ${n} time(s) in the function, not once`);
  return sql.replace(find, replace);
}

/** Every mutant, built against `schema` and the delta text `delta`. */
export function ddlMutants(schema: string, delta: string): DdlMutant[] {
  const S = schema;
  const T = `${S}.stage_lots_draws`;
  const ORDER_FULL =
    "cardinality(members) >= 2 and cardinality(drawn_order) = cardinality(members) and drawn_order @> members and members @> drawn_order";
  const LIVE = `create unique index stage_lots_draws_live_key on ${T} (stage_id, coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid), members_key) where superseded_at is null`;
  const POLICY = `create policy stage_lots_draws_tenant on ${T} for all to app_user using (org_id = ${S}.current_org_id()) with check (org_id = ${S}.current_org_id())`;
  const orderCheck = (expr: string) =>
    `alter table ${T} drop constraint stage_lots_draws_order_is_members; alter table ${T} add constraint stage_lots_draws_order_is_members check (${expr})`;
  const fk = (cascade: boolean) =>
    `alter table ${T} drop constraint stage_lots_draws_stage_org_fkey; alter table ${T} add constraint stage_lots_draws_stage_org_fkey foreign key (stage_id, org_id) references ${S}.stages (id, org_id)${cascade ? " on delete cascade" : ""}`;
  const meta = deltaFunction(delta, "stage_qualification_meta", S);
  const pin = (id: string, apply: string, restore: string): DdlMutant => ({ id, killer: PIN_TEST, apply, restore });
  return [
    pin(
      "D1-drop-pin-pair-check",
      `alter table ${S}.stages drop constraint stages_table_rules_pinned_pair`,
      `alter table ${S}.stages add constraint stages_table_rules_pinned_pair check ((table_rules_pinned is null) = (table_rules_pinned_at is null))`,
    ),
    pin(
      "D2-drop-pin-object-check",
      `alter table ${S}.stages drop constraint stages_table_rules_pinned_object`,
      `alter table ${S}.stages add constraint stages_table_rules_pinned_object check (table_rules_pinned is null or jsonb_typeof(table_rules_pinned) = 'object')`,
    ),
    pin(
      "D3-live-key-without-coalesce",
      `drop index ${S}.stage_lots_draws_live_key; create unique index stage_lots_draws_live_key on ${T} (stage_id, pool_id, members_key) where superseded_at is null`,
      `drop index ${S}.stage_lots_draws_live_key; ${LIVE}`,
    ),
    pin(
      "D4-live-key-not-partial",
      `drop index ${S}.stage_lots_draws_live_key; create unique index stage_lots_draws_live_key on ${T} (stage_id, coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid), members_key)`,
      `drop index ${S}.stage_lots_draws_live_key; ${LIVE}`,
    ),
    pin(
      "D5-rls-off",
      `alter table ${T} no force row level security; alter table ${T} disable row level security`,
      `alter table ${T} enable row level security; alter table ${T} force row level security`,
    ),
    pin(
      "D6-drop-order-check",
      `alter table ${T} drop constraint stage_lots_draws_order_is_members`,
      `alter table ${T} add constraint stage_lots_draws_order_is_members check (${ORDER_FULL})`,
    ),
    pin(
      "D6a-order-check-no-min-two",
      orderCheck("cardinality(drawn_order) = cardinality(members) and drawn_order @> members and members @> drawn_order"),
      orderCheck(ORDER_FULL),
    ),
    pin(
      "D6b-order-check-no-length",
      orderCheck("cardinality(members) >= 2 and drawn_order @> members and members @> drawn_order"),
      orderCheck(ORDER_FULL),
    ),
    pin(
      "D6c-order-check-no-order-holds-members",
      orderCheck("cardinality(members) >= 2 and cardinality(drawn_order) = cardinality(members) and members @> drawn_order"),
      orderCheck(ORDER_FULL),
    ),
    pin(
      "D6d-order-check-no-members-hold-order",
      orderCheck("cardinality(members) >= 2 and cardinality(drawn_order) = cardinality(members) and drawn_order @> members"),
      orderCheck(ORDER_FULL),
    ),
    pin("D7-fk-restrict", fk(false), fk(true)),
    pin(
      "D8-drop-org-trigger",
      `drop trigger trg_set_org on ${T}`,
      `create trigger trg_set_org before insert on ${T} for each row execute function ${S}.set_org_from_parent('stages', 'stage_id')`,
    ),
    pin("D9-drop-policy", `drop policy stage_lots_draws_tenant on ${T}`, POLICY),
    pin(
      "D10-policy-using-true",
      `drop policy stage_lots_draws_tenant on ${T}; create policy stage_lots_draws_tenant on ${T} for all to app_user using (true) with check (org_id = ${S}.current_org_id())`,
      `drop policy stage_lots_draws_tenant on ${T}; ${POLICY}`,
    ),
    pin(
      "D11-policy-check-true",
      `drop policy stage_lots_draws_tenant on ${T}; create policy stage_lots_draws_tenant on ${T} for all to app_user using (org_id = ${S}.current_org_id()) with check (true)`,
      `drop policy stage_lots_draws_tenant on ${T}; ${POLICY}`,
    ),
    // The read function as the pages call it (review I-1): the format line must never print a pin as a stage's own
    // points. The pin test installs the function from the delta's text, so only the applied function can be mutated
    // here; restored from that same text. The function reads no pin since T9 review fix round 1 (m-items: the
    // `table_points` column and the trailing `table_points_rule` were dropped; the table's rule is the loader's), so the
    // one mutant left is the I-1 defect itself — the stage's own points read through the pin — and the former
    // "F2-table-points-rule-ignores-the-pin" is retired with the column it mutated.
    {
      id: "F1-points-rule-reads-the-pin",
      killer: LINES_TEST,
      apply: replaceOnce(
        meta,
        "s.config -> 'points' as points,",
        "coalesce(s.table_rules_pinned -> 'points', s.config -> 'points') as points,",
        "F1",
      ),
      restore: meta,
    },
  ];
}

/** The catalog the mutants touch, one line per object, sorted. */
export function fingerprintSql(schema: string): string {
  const T = `${schema}.stage_lots_draws`;
  return `
    select string_agg(x, E'\\n' order by x) as fp from (
      select 'con ' || conname || ' ' || pg_get_constraintdef(oid) as x from pg_constraint
       where conrelid in ('${schema}.stages'::regclass, '${T}'::regclass)
      union all select 'idx ' || pg_get_indexdef(indexrelid) from pg_index where indrelid = '${T}'::regclass
      union all select 'trg ' || pg_get_triggerdef(oid) from pg_trigger where tgrelid = '${T}'::regclass and not tgisinternal
      union all select 'rls ' || relrowsecurity || ' ' || relforcerowsecurity from pg_class where oid = '${T}'::regclass
      union all select 'pol ' || polname || ' ' || polcmd::text || ' ' || pg_get_expr(polqual, polrelid) || ' '
                       || coalesce(pg_get_expr(polwithcheck, polrelid), '')
        from pg_policy where polrelid = '${T}'::regclass
      union all select 'fn ' || pg_get_functiondef('${schema}.stage_qualification_meta(uuid)'::regprocedure)
    ) s`;
}

interface RunResult {
  total: number;
  passed: number;
  failed: number;
  failures: string[];
}

function runKiller(file: string): RunResult | null {
  const dir = mkdtempSync(join(tmpdir(), "w2d-ddl-"));
  const out = join(dir, "r.json");
  try {
    spawnSync("pnpm", ["exec", "vitest", "run", file, "--reporter=json", `--outputFile=${out}`], {
      cwd: WEB,
      env: process.env,
      stdio: "ignore",
      timeout: 900_000,
    });
    if (!existsSync(out)) return null;
    const r = JSON.parse(readFileSync(out, "utf8")) as {
      numTotalTests: number;
      numPassedTests: number;
      numFailedTests: number;
      testResults: { assertionResults: { title: string; status: string }[] }[];
    };
    return {
      total: r.numTotalTests,
      passed: r.numPassedTests,
      failed: r.numFailedTests,
      failures: r.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === "failed").map((a) => a.title)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const db = labelDbOf(process.env.DATABASE_URL);
  const schema = process.env.DB_SCHEMA ?? "seazn_club";
  const files = readdirSync(join(REPO, "db/migration/deltas")).filter((f) => /^V\d+__w2d_table_rules\.sql$/.test(f));
  if (files.length !== 1) throw new Error(`expected one W2d delta, found ${files.length}`);
  const mutants = ddlMutants(schema, readFileSync(join(REPO, "db/migration/deltas", files[0]), "utf8"));
  if (argv[0] === "--list") {
    for (const m of mutants) console.log(`${m.id}\t${m.killer}`);
    return 0;
  }
  // search_path = the schema, as Flyway runs the delta: the read-function mutants are the delta's own unqualified
  // `create or replace function`, which would otherwise land in `public` and leave the real one untouched.
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, ssl: false, connection: { search_path: schema }, onnotice: () => {} });
  try {
    const [{ data_directory: dataDir }] = await sql<{ data_directory: string }[]>`show data_directory`;
    if (dataDir !== labelDataDirectory(db.label)) {
      throw new Error(`refusing: ${db.database} runs from ${dataDir}, not label ${db.label}'s ${labelDataDirectory(db.label)}`);
    }
    // a copy of the read function outside the schema means a mutant missed it: stop before judging anything
    const strays = async () =>
      (await sql<{ n: number }[]>`
        select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname = 'stage_qualification_meta' and n.nspname <> ${schema}`)[0].n;
    const fp = async () => {
      if ((await strays()) > 0) throw new Error(`a stage_qualification_meta exists outside ${schema}: a mutant missed the schema`);
      return (await sql.unsafe<{ fp: string }[]>(fingerprintSql(schema)))[0].fp;
    };
    const fp0 = await fp();
    if (argv[0] === "--fingerprint") {
      console.log(fp0);
      return 0;
    }
    const picked = argv[0] === "all" ? mutants : mutants.filter((m) => argv.includes(m.id));
    const unknown = argv[0] === "all" ? [] : argv.filter((a) => !mutants.some((m) => m.id === a));
    if (picked.length === 0 || unknown.length > 0) throw new Error(`usage: ddl-mutants.ts --list | --fingerprint | all | <ids…>${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}`);
    const baseline = new Map<string, number>();
    for (const killer of new Set(picked.map((m) => m.killer))) {
      const r = runKiller(killer);
      if (r === null || r.failed > 0 || r.passed !== r.total || r.total === 0) {
        throw new Error(`baseline: ${killer} is not green on the unmutated database (${r === null ? "no report" : `${r.passed}/${r.total}`})`);
      }
      baseline.set(killer, r.total);
      console.log(`baseline ${killer}: ${r.passed}/${r.total}`);
    }
    let killed = 0;
    for (const m of picked) {
      let r: RunResult | null = null;
      let failed: Error | null = null;
      try {
        // simple protocol: a mutant is several statements (multi-statement needs it; it takes no parameters anyway)
        await sql.begin((tx) => tx.unsafe(m.apply).simple());
        if ((await fp()) === fp0) throw new Error(`${m.id}: the mutant changed nothing in the catalog`);
        r = runKiller(m.killer);
      } catch (e) {
        failed = e instanceof Error ? e : new Error(String(e));
      }
      // restored whatever happened above, and proved restored before anything else runs
      await sql.begin((tx) => tx.unsafe(m.restore).simple());
      if ((await fp()) !== fp0) throw new Error(`${m.id}: RESTORE FAILED — the catalog differs from the fingerprint taken first`);
      if (failed !== null) throw failed;
      const status =
        r === null ? "NO-REPORT"
        : r.total !== baseline.get(m.killer) ? `TOTAL-CHANGED(${r.total})`
        : r.failed > 0 ? "KILLED"
        : "SURVIVED";
      if (status === "KILLED") killed++;
      console.log(`${m.id}\t${status}\t${r === null ? "" : `${r.failed}/${r.total} red: ${r.failures.join(" | ")}`}`);
    }
    console.log(`${killed}/${picked.length} KILLED; catalog restored (${fp0.split("\n").length} fingerprint lines)`);
    return killed === picked.length ? 0 : 1;
  } finally {
    await sql.end();
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error("ERROR:", e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
