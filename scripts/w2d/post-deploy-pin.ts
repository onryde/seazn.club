// W2d Task 9 fix round 1 (I2) — the post-deploy step for the table-rules pin. ONE file, three jobs.
//
// V472 pins every started stage and converts every W2c `{base, bonuses, forfeit}` stage rule while it migrates. Between
// that migration and the deploy of the code that pins at activation, the OLD code is still serving: a stage it starts
// (or completes) in that window is left active/complete with no pin, and a stage rule it saves is written in the old
// `{base}` shape, which the W2d reader (`parseStoredPointsRule`) reads as NO rule. This script closes that window, once,
// after the deploy:
//
//   1. convert — every stage `config.points` still in the `{base}` shape becomes the outcome-keyed rule through
//      `parseLegacyPointsRule`, the engine's B1 authority (the TypeScript twin of V472's `w2d_legacy_points`). A value
//      that reader refuses is NOT written and is counted `refused`; its stage is then not pinned either (a pin taken
//      over a rule nobody can read would pin the sport's rule silently).
//   2. pin — every `active`/`complete` stage with no pin is pinned through the app's own `pinStageTableRules` (the
//      activation door's code, run here), each in its own transaction. Conversion runs FIRST so a started stage's pin
//      carries its converted rule, not the sport's.
//   3. `--check` — read-only: prints the two counts (started stages with no pin; `{base}` stage rules) and exits 1 if
//      either is above 0, else 0. Nothing is written.
//
//   node --experimental-strip-types scripts/w2d/post-deploy-pin.ts --check   # audit, writes nothing
//   node --experimental-strip-types scripts/w2d/post-deploy-pin.ts           # convert, then pin
//
// Options: `--org <uuid>` (repeatable) limits every count and write to those orgs; `--prod` is required for any
// DATABASE_URL whose host is not localhost / 127.0.0.1 / ::1. ONLY THE OWNER passes `--prod`. The URL is read from the
// environment and never printed, never parsed into an error message (a URL parse error echoes its input) and never
// accepted on argv.
//
// Exit: 0 = nothing left to do; 1 = work remains (`--check` found some, or a run refused/failed a row — a deploy must
// stop); 2 = refused to start (no/unreadable/non-local URL without `--prod`, a bad argument). Safe to run twice: a
// converted rule is no longer `{base}`, a pinned stage is no longer unpinned, and `pinStageTableRules` itself writes only
// `where table_rules_pinned is null` — a second run reports zeros and changes no row.
//
// Why the app's code and not SQL: the pin must be exactly the one activation takes (the loader's layers, the module's
// declared order, the derived cross-group order), and the one place that is computed is `pinStageTableRules`
// (apps/web/src/server/engine-db/table-rules.ts). Node cannot load that file as-is (`server-only`, the `@/` alias,
// extensionless specifiers), so `main` registers a resolve hook for exactly those three before it imports it.
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { parseLegacyPointsRule } from "@seazn/engine/competition";
import { isMainModule } from "../lib/main-module.ts";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export interface Args {
  check: boolean;
  prod: boolean;
  orgs: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The argv this script takes, or the reason it refuses one. Never echoes a value it refuses (it could be a URL). */
export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const out: Args = { check: false, prod: false, orgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--prod") out.prod = true;
    else if (a === "--org") {
      const v = argv[++i];
      if (v === undefined || !UUID.test(v)) return { error: "--org takes an org id (a uuid)" };
      out.orgs.push(v.toLowerCase());
    } else return { error: `unknown argument #${i + 1} (takes --check, --prod, --org <uuid>)` };
  }
  return out;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Is this a database on this machine? The host must be exactly localhost / 127.0.0.1 / ::1 — an empty host (a socket or
 *  PGHOST), a host list, or a `host`/`hostaddr` query override is not proven local and reads as remote. Never throws and
 *  never returns any part of the URL. */
export function isLocalDatabaseUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return false;
  if (u.searchParams.has("host") || u.searchParams.has("hostaddr")) return false;
  return LOCAL_HOSTS.has(u.hostname.toLowerCase());
}

/** Scope fragment: every count and write below is limited to the named orgs, or to none. */
function inOrgs(sql: Sql | Tx, orgs: readonly string[]) {
  return orgs.length === 0 ? sql`true` : sql`org_id in ${sql(orgs as string[])}`;
}

export interface Census {
  /** Stages `active`/`complete` with no pin. */
  unpinnedStarted: number;
  /** Stages whose `config.points` is still the W2c `{base}` shape. */
  baseStageRules: number;
}

export async function census(sql: Sql, orgs: readonly string[]): Promise<Census> {
  const [row] = await sql<{ unpinned: number; base: number }[]>`
    select count(*) filter (where status in ('active', 'complete') and table_rules_pinned is null)::int as unpinned,
           count(*) filter (where jsonb_typeof(config -> 'points') = 'object' and config -> 'points' ? 'base')::int as base
      from stages where ${inOrgs(sql, orgs)}`;
  return { unpinnedStarted: row.unpinned, baseStageRules: row.base };
}

export interface RunReport {
  converted: number;
  pinned: number;
  /** `{base}` rules `parseLegacyPointsRule` refuses: left as they are, their stage not pinned. */
  refused: string[];
  /** Stages whose pin failed: `id: CODE message`. */
  failed: string[];
  after: Census;
}

type PinStage = (tx: Tx, stageId: string) => Promise<void>;

/** The two writes, in order (convert, then pin), each row in its own transaction. */
export async function run(sql: Sql, orgs: readonly string[], pinStageTableRules: PinStage): Promise<RunReport> {
  const report: RunReport = { converted: 0, pinned: 0, refused: [], failed: [], after: { unpinnedStarted: 0, baseStageRules: 0 } };
  const based = await sql<{ id: string }[]>`
    select id from stages
     where jsonb_typeof(config -> 'points') = 'object' and config -> 'points' ? 'base' and ${inOrgs(sql, orgs)}
     order by id`;
  for (const { id } of based) {
    const outcome = await sql.begin(async (tx) => {
      const [row] = await tx<{ points: unknown }[]>`
        select config -> 'points' as points from stages
         where id = ${id} and jsonb_typeof(config -> 'points') = 'object' and config -> 'points' ? 'base' for update`;
      if (row === undefined) return "gone" as const; // converted by someone else since the list was read
      const rule = parseLegacyPointsRule(row.points);
      if (rule === null) return "refused" as const;
      await tx`update stages set config = jsonb_set(config, '{points}', ${tx.json(rule)}) where id = ${id}`;
      return "converted" as const;
    });
    if (outcome === "converted") report.converted++;
    else if (outcome === "refused") report.refused.push(id);
  }

  const unpinned = await sql<{ id: string }[]>`
    select id from stages
     where status in ('active', 'complete') and table_rules_pinned is null and ${inOrgs(sql, orgs)}
     order by id`;
  for (const { id } of unpinned) {
    if (report.refused.includes(id)) continue;
    try {
      const pinned = await sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          select id from stages where id = ${id} and status in ('active', 'complete') and table_rules_pinned is null for update`;
        if (row === undefined) return false;
        await pinStageTableRules(tx, id);
        const [after] = await tx<{ pinned: boolean }[]>`select table_rules_pinned is not null as pinned from stages where id = ${id}`;
        if (after?.pinned !== true) throw Object.assign(new Error("the pin wrote nothing"), { code: "NOT_PINNED" });
        return true;
      });
      if (pinned) report.pinned++;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const message = e instanceof Error ? e.message : String(e);
      report.failed.push(`${id}: ${typeof code === "string" ? code : "ERROR"} ${message}`);
    }
  }
  report.after = await census(sql, orgs);
  return report;
}

/** Exit code of an apply run: 0 only when nothing was refused or failed and nothing is left in scope. */
export function exitCodeOfRun(r: RunReport): number {
  return r.refused.length > 0 || r.failed.length > 0 || r.after.unpinnedStarted > 0 || r.after.baseStageRules > 0 ? 1 : 0;
}

/** Exit code of `--check`: 1 while either count is above 0. */
export function exitCodeOfCheck(c: Census): number {
  return c.unpinnedStarted > 0 || c.baseStageRules > 0 ? 1 : 0;
}

/** Lets node load apps/web server modules: `server-only` is a no-op, `@/` is apps/web/src, and an extensionless
 *  relative specifier is the `.ts`/`.tsx`/`/index.ts` file on disk. Process-wide, so only `main` calls it. */
function registerWebResolve(webSrc: string): void {
  const file = (p: string): string | null => {
    for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`]) if (existsSync(c) && statSync(c).isFile()) return c;
    return null;
  };
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
      if (specifier.startsWith("@/")) {
        const f = file(resolvePath(webSrc, specifier.slice(2)));
        if (f !== null) return { url: pathToFileURL(f).href, shortCircuit: true };
      }
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
        const f = file(resolvePath(dirname(fileURLToPath(context.parentURL)), specifier));
        if (f !== null) return { url: pathToFileURL(f).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    console.error(`post-deploy-pin: ${args.error}`);
    return 2;
  }
  const url = env.DATABASE_URL;
  if (url === undefined || url === "") {
    console.error("post-deploy-pin: DATABASE_URL is not set.");
    return 2;
  }
  if (!isLocalDatabaseUrl(url) && !args.prod) {
    console.error("post-deploy-pin: refused — DATABASE_URL is not a local database (localhost / 127.0.0.1 / ::1). Only the owner runs this against a deployed database, with --prod.");
    return 2;
  }
  const webSrc = fileURLToPath(new URL("../../apps/web/src/", import.meta.url));
  registerWebResolve(webSrc);
  const db = (await import(pathToFileURL(resolvePath(webSrc, "lib/db.ts")).href)) as {
    connectionOptions(url: string, env: NodeJS.ProcessEnv): { ssl: false | "require"; prepare: boolean; schema: string };
  };
  const tableRules = (await import(pathToFileURL(resolvePath(webSrc, "server/engine-db/table-rules.ts")).href)) as {
    pinStageTableRules: PinStage;
  };
  const { ssl, prepare, schema } = db.connectionOptions(url, env);
  const sql = postgres(url, { ssl, prepare, max: 1, connection: { search_path: schema }, onnotice: () => undefined });
  try {
    if (args.check) {
      const c = await census(sql, args.orgs);
      console.log(JSON.stringify({ mode: "check", ...c }));
      return exitCodeOfCheck(c);
    }
    const r = await run(sql, args.orgs, tableRules.pinStageTableRules);
    console.log(JSON.stringify({ mode: "apply", converted: r.converted, pinned: r.pinned, refused: r.refused.length, failed: r.failed.length, ...r.after }));
    for (const id of r.refused) console.error(`refused {base} rule (not converted, not pinned): stage ${id}`);
    for (const f of r.failed) console.error(`pin failed: stage ${f}`);
    return exitCodeOfRun(r);
  } catch (e) {
    // A connection or SQL failure: its code only — a driver message can carry the host it tried.
    const code = (e as { code?: unknown }).code;
    console.error(`post-deploy-pin: failed (${typeof code === "string" ? code : e instanceof Error ? e.name : "error"})`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
