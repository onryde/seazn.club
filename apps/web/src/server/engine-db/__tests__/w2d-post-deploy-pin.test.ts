// W2d Task 9 fix round 1, I2 — scripts/w2d/post-deploy-pin.ts, the one post-deploy step: convert every W2c `{base}`
// stage rule, pin every started stage with no pin, and `--check` the two counts read-only.
//
// What is under test is the script as it is RUN (`node --experimental-strip-types`, real exit codes, its stdout) against
// real Postgres, over stages the product's own doors made: a division STARTED through `startDivision` (so the stage's
// pin is the activation door's own), then put back by raw SQL into the shape the old code leaves in the deploy window —
// active with no pin, or a stage rule saved in the `{base}` shape. Expected values: the activation door's pin (taken
// before it was stripped) and the B1 rule as the spec states it (`base` → `win.regulation`/`draw`/`loss.regulation`,
// tie and no result 0, shoot-outs pay as the result, bonuses kept — spec §5.4 / `legacyPointsRule`'s doc), parsed by
// the engine's schema; never the script's own output. Each run is scoped `--org` to the orgs this file made, so a
// shared test DB's other stages are neither counted nor written.
//
// The URL guard is tested without a database: a non-local URL is refused before any connection (exit 2, where a
// connection attempt would exit 1) and no part of it is printed. NEVER against stg or prod: no test passes `--prod`.
// Single-sport reason: the script is sport-blind (it moves stored rows through one module-agnostic door); generic is the
// one sport whose stage cfg the test can author without a catalog.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PointsRule, resolveTableRules } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { CreateStages } from "@/server/api-v1/schemas";
import { startDivision } from "@/server/usecases/schedule";
import { GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { isLocalDatabaseUrl, parseArgs } from "../../../../../../scripts/w2d/post-deploy-pin.ts";
import { stageRules, tableScene } from "./helpers/w2d-table-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "w2d", "post-deploy-pin.ts");
// One spawn = node + strip-types + the engine and the web table-rules module; seconds on a loaded machine (class 20: the
// budget is per call, and the heaviest test makes six).
const CLI_MS = 60_000;

/** Every stage this file put into the deploy window's shape. A failed (or refused) run leaves one active with no pin or
 *  holding a `{base}` rule; `afterAll` takes each such leftover out of that shape, so no other suite sharing the database
 *  meets a stage only this file meant to make. */
const touched: string[] = [];

afterAll(async () => {
  if (!HAS_DB) return;
  if (touched.length > 0) {
    await sql`
      update stages set status = 'pending', config = config - 'points'
       where id in ${sql(touched)}
         and ((status in ('active', 'complete') and table_rules_pinned is null)
              or (jsonb_typeof(config -> 'points') = 'object' and config -> 'points' ? 'base'))`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Cli {
  code: number;
  out: string;
  err: string;
}

function cli(args: readonly string[], env: Record<string, string | undefined>): Promise<Cli> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args],
      { cwd: REPO, env: env as NodeJS.ProcessEnv, timeout: CLI_MS },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
        done({ code, out: String(stdout), err: String(stderr) });
      },
    );
  });
}

const lastJson = (r: Cli): Record<string, unknown> => {
  const line = r.out.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`no JSON summary (exit ${r.code}): ${r.out} ${r.err}`);
  }
};

const generic = builtinModules.find((m) => m.key === "generic") as AnySportModule;

/** The W2c stage rule a pre-W2d save writes, and the rule B1 says it pays (spec §5.4, `legacyPointsRule`'s doc). */
const BASE_RULE = { base: { win: 2, draw: 1, loss: 0 }, bonuses: [{ when: "win_margin_gte", param: 3, points: 1 }] };
const BASE_RULE_PAYS = PointsRule.parse({
  win: { regulation: 2 },
  loss: { regulation: 0 },
  draw: 1,
  tie: 0,
  noResult: 0,
  shootoutAs: "result",
  unit: "whole",
  bonuses: [{ when: "win_margin_gte", param: 3, points: 1 }],
});
/** Another, so the pending stage's conversion is witnessed apart from the started one's. */
const KO_RULE = { base: { win: 4, draw: 2, loss: 1 } };
const KO_RULE_PAYS = PointsRule.parse({
  win: { regulation: 4 },
  loss: { regulation: 1 },
  draw: 2,
  tie: 0,
  noResult: 0,
  shootoutAs: "result",
  unit: "whole",
  bonuses: [],
});

/** Every column the script may write, as text-comparable values: the "changes nothing" witness. */
const rowsOf = (ids: readonly string[]) =>
  sql<{ id: string; status: string; config: unknown; pin: unknown; at: string | null }[]>`
    select id, status, config, table_rules_pinned as pin, to_json(table_rules_pinned_at) #>> '{}' as at
      from stages where id in ${sql(ids as string[])} order by id`;

const pointsOf = async (id: string) => (await sql<{ p: unknown }[]>`select config -> 'points' as p from stages where id = ${id}`)[0]!.p;

describe.skipIf(!HAS_DB)("W2d T9 I2: scripts/w2d/post-deploy-pin.ts, run against the stages the deploy window leaves", () => {
  it("converts {base}, then pins every started stage with no pin — the activation door's pin; scoped by --org; a second run changes nothing; --check reads 2/2 before and 0/0 after", async () => {
    // A: a league STARTED through the product (pinned at activation), its knockout still pending
    const drafts = buildTemplateStages("league_ko", { qualified: 2, swissRounds: 5, poolCount: 2, legs: 1 }).map((d, i) => ({ ...d, seq: i + 1 }));
    const a = await tableScene({ stages: drafts as CreateStages });
    const [leagueA, koA] = a.stageIds as [string, string];
    await startDivision(a.auth, a.divisionId);
    const activation = await stageRules(leagueA);
    expect(activation, "premise: the start pinned the league").toMatchObject({ status: "active" });
    expect(activation.pin, "premise: the activation door's pin").not.toBeNull();
    expect(await stageRules(koA), "premise: the knockout is pending").toMatchObject({ status: "pending", pin: null });
    // B: a second league started the same way
    const b = await tableScene({});
    const [leagueB] = b.stageIds as [string];
    await startDivision(b.auth, b.divisionId);
    expect(await stageRules(leagueB), "premise").toMatchObject({ status: "active" });

    touched.push(leagueA, koA, leagueB);
    // the deploy window: the old code starts A's league without a pin; it saves a {base} rule on A's pending knockout
    // and on B's started league, which it also leaves unpinned
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id in ${sql([leagueA, leagueB])}`;
    await sql`update stages set config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(KO_RULE)}) where id = ${koA}`;
    await sql`update stages set config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(BASE_RULE as never)}) where id = ${leagueB}`;
    const env = { ...process.env };
    const both = ["--org", a.auth.orgId, "--org", b.auth.orgId];

    const window_ = await rowsOf([leagueA, koA, leagueB]);
    const before = await cli(["--check", ...both], env);
    expect(before.code, `--check finds the window's leftovers: ${before.err}`).toBe(1);
    expect(lastJson(before)).toEqual({ mode: "check", unpinnedStarted: 2, baseStageRules: 2 });
    expect(await rowsOf([leagueA, koA, leagueB]), "--check writes nothing").toEqual(window_);

    // A alone: B is out of scope and untouched
    const bBefore = await rowsOf([leagueB]);
    const onlyA = await cli(["--org", a.auth.orgId], env);
    expect(onlyA.code, onlyA.err).toBe(0);
    expect(lastJson(onlyA)).toEqual({ mode: "apply", converted: 1, pinned: 1, refused: 0, failed: 0, unpinnedStarted: 0, baseStageRules: 0 });
    const pinnedA = await stageRules(leagueA);
    expect(pinnedA.pin, "the script's pin is the activation door's own").toEqual(activation.pin);
    expect(pinnedA.pinned_at, "and it is dated").not.toBeNull();
    expect(await pointsOf(koA), "the pending knockout's {base} rule is converted").toEqual(KO_RULE_PAYS);
    expect(await stageRules(koA), "and the pending knockout stays unpinned (it reads live)").toMatchObject({ status: "pending", pin: null });
    expect(await rowsOf([leagueB]), "an org not named is neither converted nor pinned").toEqual(bBefore);

    // both: B's rule is converted BEFORE its pin is taken, so the pin carries the converted rule, not the sport's
    const run = await cli(both, env);
    expect(run.code, run.err).toBe(0);
    expect(lastJson(run)).toEqual({ mode: "apply", converted: 1, pinned: 1, refused: 0, failed: 0, unpinnedStarted: 0, baseStageRules: 0 });
    expect(await pointsOf(leagueB)).toEqual(BASE_RULE_PAYS);
    const expectedB = resolveTableRules({
      module: generic,
      stageKind: "league",
      mergedCfg: GENERIC_CONFIG,
      stageOwn: { points: BASE_RULE_PAYS, tiebreakers: null, crossGroup: null },
      divisionTiebreakers: null,
      pinned: null,
    });
    const pinnedB = await stageRules(leagueB);
    expect(pinnedB.pin, "B's pin is the stage's converted rule (source stage), as the engine's resolver reads it").toEqual(expectedB);
    expect((pinnedB.pin as { sources: { points: string } }).sources.points).toBe("stage");

    // a second run: zero counts, and not one column moves (the pin's date included)
    const settled = await rowsOf([leagueA, koA, leagueB]);
    const again = await cli(both, env);
    expect(again.code, again.err).toBe(0);
    expect(lastJson(again)).toEqual({ mode: "apply", converted: 0, pinned: 0, refused: 0, failed: 0, unpinnedStarted: 0, baseStageRules: 0 });
    expect(await rowsOf([leagueA, koA, leagueB]), "a second run changes nothing").toEqual(settled);
    expect(settled.length, "anti-vacuity: rows compared").toBe(3);

    const after = await cli(["--check", ...both], env);
    expect(after.code, after.err).toBe(0);
    expect(lastJson(after)).toEqual({ mode: "check", unpinnedStarted: 0, baseStageRules: 0 });
  }, 6 * CLI_MS);

  it("a {base} rule the B1 reader refuses is neither written nor pinned over (the sport's rule would be pinned silently): exit 1, the stage named", async () => {
    const c = await tableScene({});
    const [league] = c.stageIds as [string];
    await startDivision(c.auth, c.divisionId);
    const junk = { base: { win: "3", draw: 1, loss: 0 } };
    touched.push(league);
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null,
                     config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(junk)}) where id = ${league}`;
    const before = await rowsOf([league]);
    const r = await cli(["--org", c.auth.orgId], { ...process.env });
    expect(r.code, "a deploy stops on a refused row").toBe(1);
    expect(lastJson(r)).toEqual({ mode: "apply", converted: 0, pinned: 0, refused: 1, failed: 0, unpinnedStarted: 1, baseStageRules: 1 });
    expect(r.err).toContain(league);
    expect(await rowsOf([league]), "nothing written").toEqual(before);
    const check = await cli(["--check", "--org", c.auth.orgId], { ...process.env });
    expect(check.code).toBe(1);
    expect(lastJson(check)).toEqual({ mode: "check", unpinnedStarted: 1, baseStageRules: 1 });
  }, 3 * CLI_MS);
});

describe("W2d T9 I2: the script refuses any database not on this machine, and never prints its URL", () => {
  const SECRETS = ["s3cr3t-pw", "dbuser", "db.example.invalid", "prod_db"];
  const cases: { name: string; url: string | undefined; args?: string[] }[] = [
    { name: "a remote host", url: "postgresql://dbuser:s3cr3t-pw@db.example.invalid:5432/prod_db" },
    { name: "a remote host, --check", url: "postgresql://dbuser:s3cr3t-pw@db.example.invalid:5432/prod_db", args: ["--check"] },
    { name: "a local hostname overridden by ?host=", url: "postgresql://dbuser:s3cr3t-pw@localhost:5432/prod_db?host=db.example.invalid" },
    { name: "an unparseable URL", url: "not a url dbuser s3cr3t-pw db.example.invalid prod_db" },
    { name: "no URL", url: undefined },
    { name: "a URL on argv (refused as an argument, not echoed)", url: undefined, args: ["postgresql://dbuser:s3cr3t-pw@db.example.invalid/prod_db"] },
    { name: "a bad --org", url: "postgresql://dbuser:s3cr3t-pw@localhost:5432/prod_db", args: ["--org", "db.example.invalid"] },
  ];
  for (const c of cases) {
    it(`${c.name}: exit 2 before any connection, nothing of the URL printed`, async () => {
      const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: c.url };
      if (c.url === undefined) delete env.DATABASE_URL;
      const r = await cli(c.args ?? [], env);
      expect(r.code, `${r.out} ${r.err}`).toBe(2);
      expect(r.err.length, "it says why").toBeGreaterThan(0);
      for (const s of SECRETS) expect(r.out + r.err, `printed ${s}`).not.toContain(s);
    }, CLI_MS);
  }

  it("isLocalDatabaseUrl: exactly localhost / 127.0.0.1 / ::1, anything else (and anything unreadable) is remote (counted)", () => {
    const local = ["postgresql://postgres@127.0.0.1:54647/seazn_x", "postgres://u:p@localhost/db", "postgresql://u@[::1]:5432/db", "postgresql://u@LOCALHOST/db"];
    const remote = [
      "postgresql://u:p@db.example.invalid:5432/db",
      "postgresql://u:p@127.0.0.1.example.invalid/db",
      "postgresql://u:p@127.0.0.1@db.example.invalid/db",
      "postgresql://u@127.0.0.1,db.example.invalid/db",
      "postgresql:///db",
      "postgresql://u@localhost/db?host=db.example.invalid",
      "postgresql://u@localhost/db?hostaddr=10.0.0.1",
      "http://localhost/db",
      "not a url",
      "",
    ];
    let checked = 0;
    for (const u of local) {
      expect(isLocalDatabaseUrl(u), u).toBe(true);
      checked++;
    }
    for (const u of remote) {
      expect(isLocalDatabaseUrl(u), u).toBe(false);
      checked++;
    }
    expect(checked).toBe(local.length + remote.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("parseArgs: --check, --prod, repeatable --org <uuid>; anything else refused without echoing it", () => {
    const org = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(parseArgs([])).toEqual({ check: false, prod: false, orgs: [] });
    expect(parseArgs(["--check", "--org", org, "--org", org.toUpperCase()])).toEqual({ check: true, prod: false, orgs: [org, org] });
    expect(parseArgs(["--prod"])).toEqual({ check: false, prod: true, orgs: [] });
    for (const bad of [["--org"], ["--org", "x"], ["--dry-run"], ["postgresql://dbuser:s3cr3t-pw@h/db"]]) {
      const r = parseArgs(bad);
      expect("error" in r, bad.join(" ")).toBe(true);
      expect(JSON.stringify(r)).not.toContain("s3cr3t");
    }
  });
});
