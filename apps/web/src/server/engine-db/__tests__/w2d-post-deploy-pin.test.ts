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
// connection attempt would exit 1) and no part of it is printed. NEVER against stg or prod: `--prod` is passed only with
// URLs that reach nothing — ones the script's own parse refuses, one the driver's option parse refuses before it
// connects, and `0.0.0.0` at a port just found closed (this machine). Fix round 2 adds the shoot-out split (V474's data
// steps 3 and 4, redone for the window): its TypeScript twin is held to V474's own SQL over a grid of every sport the
// split names and two it does not, and the CLI is run over an old-app football division and organisation variant.
// Fix round 3 adds HELD rows (a write that would reach a scored stage is not made): each is scored through `scoreEvent`
// and compared by what the scored stage READS (its computed table and stored snapshots, byte for byte), and the row
// lock the script takes is raced by a first tap held open in this process (pg_locks shows the run waiting on it).
// Single-sport reason (the stage-rule cases): the convert and pin steps are sport-blind (they move stored rows through
// one module-agnostic door); generic is the one sport whose stage cfg the test can author without a catalog.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PointsRule, resolveTableRules } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { connectionOptions, sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { lockedStageIdsAmong } from "@/server/usecases/rule-locks";
import { startDivision } from "@/server/usecases/schedule";
import { addFixture } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedFootballCatalog, seedOrg } from "@/server/usecases/__tests__/_seed";
import {
  census,
  dropShootoutSplit,
  failureLine,
  isLocalDatabaseUrl,
  parseArgs,
  parseDatabaseUrl,
  redact,
  type SplitNotice,
} from "../../../../../../scripts/w2d/post-deploy-pin.ts";
import { post } from "./helpers/w2b-rig";
import { genericResult, seatedFixtures, stageRules, tableScene } from "./helpers/w2d-table-rig";

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
/** Every division config this file put on the shoot-out split, and every sport variant it inserted (key prefix). */
const touchedDivisions: string[] = [];
const VARIANT_PREFIX = `w2d-t9r2-${randomUUID().slice(0, 8)}-`;

afterAll(async () => {
  if (!HAS_DB) return;
  if (touched.length > 0) {
    await sql`
      update stages set status = 'pending', config = config - 'points'
       where id in ${sql(touched)}
         and ((status in ('active', 'complete') and table_rules_pinned is null)
              or (jsonb_typeof(config -> 'points') = 'object' and config -> 'points' ? 'base'))`;
  }
  if (touchedDivisions.length > 0) {
    await sql`
      update divisions set config = jsonb_set(config, '{points}', (config -> 'points') - 'shootoutWin' - 'shootoutLoss')
       where id in ${sql(touchedDivisions)} and jsonb_typeof(config -> 'points') = 'object'`;
  }
  await sql`delete from sport_variants where key like ${VARIANT_PREFIX + "%"}`;
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

/** An apply run's summary with nothing done and nothing left: every key the script prints, so a key added or dropped
 *  reds every summary assertion. */
const APPLY_ZERO = {
  mode: "apply",
  divisionConfigs: 0,
  variantConfigs: 0,
  converted: 0,
  repinned: 0,
  pinned: 0,
  refused: 0,
  failed: 0,
  held: 0,
  unpinnedStarted: 0,
  baseStageRules: 0,
  shootoutSplitConfigs: 0,
};
/** A `--check` summary with nothing left: every key it prints. */
const CHECK_ZERO = { mode: "check", unpinnedStarted: 0, baseStageRules: 0, shootoutSplitConfigs: 0, held: 0 };

type Pin = { points: unknown; tiebreakers: string[]; crossGroup: string[]; sources: { points: string; tiebreakers: string; crossGroup: string } };
/** The pre-W2d cross-group order V474 pins (hard-coded at W2D_BASE, `packages/engine/src/competition/progression.ts:573-575`). */
const PRE_W2D_CROSS_GROUP = ["points", "diff", "for", "wins"];
const divisionConfigOf = async (id: string) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${id}`)[0]!.config;
const variantConfigOf = async (key: string) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from sport_variants where key = ${key}`)[0]?.config;
const withoutPoints = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "points"));

/** What a stage READS, as text — fix round 3's "never changes what a scored stage reads" witness: its table as the app
 *  computes it now (`rankedStageStandings`, inside a transaction rolled back so a lots draw it makes is not kept), or the
 *  typed refusal it reads as instead; and every standings snapshot stored for it (what its public table shows). */
async function readsOf(stageId: string): Promise<{ table: string; snapshots: string }> {
  const ROLLBACK = new Error("rollback");
  let table = "";
  await expect(
    sql.begin(async (tx) => {
      try {
        table = JSON.stringify(await rankedStageStandings(tx as never, stageId));
      } catch (e) {
        const err = e as { code?: unknown; data?: { reason?: unknown } };
        table = JSON.stringify({ refused: err.code ?? String(e), reason: err.data?.reason ?? null });
      }
      throw ROLLBACK;
    }),
  ).rejects.toBe(ROLLBACK);
  const [s] = await sql<{ t: string | null }[]>`
    select json_agg(json_build_object('pool', pool_id, 'rows', rows, 'previous', previous_rows, 'through', computed_through_seq)
                    order by pool_id)::text as t
      from standings_snapshots where stage_id = ${stageId}`;
  return { table, snapshots: s?.t ?? "[]" };
}

interface TableRow {
  entrantId: string;
  won: number;
  drawn: number;
  lost: number;
  points: number;
}
/** One entrant's row of a computed table (`readsOf(...).table`). */
function rowOf(table: string, entrant: string): TableRow {
  const rows = JSON.parse(table) as TableRow[];
  if (!Array.isArray(rows)) throw new Error(`no table: ${table}`);
  const row = rows.find((r) => r.entrantId === entrant);
  if (row === undefined) throw new Error(`no row for ${entrant} in ${table}`);
  return row;
}

const footballModule = builtinModules.find((m) => m.key === "football") as AnySportModule;
/** A football division whose level league match goes straight to a shoot-out (no extra time): a result only the shoot-out
 *  rule pays, so a change to that rule moves the table. */
const SHOOTOUT_CFG = { ...(footballModule.variants["11-a-side"] as Record<string, unknown>), shootout: true, extraTime: { enabled: false, halfMinutes: 15 } };
/** The W2c split an old-app save writes into a division's points (spec §5.3). */
const WINDOW_SPLIT = { win: 3, draw: 1, loss: 0, shootoutWin: 3, shootoutLoss: 1 };

/** 0-0 at full time, then won 4-3 on penalties by `home` (five kicks each, decided on the last). */
async function shootoutWin(auth: AuthCtx, fixtureId: string, home: string, away: string): Promise<void> {
  await post(auth, fixtureId, "core.start");
  await post(auth, fixtureId, "football.period", { phase: "HT" });
  await post(auth, fixtureId, "football.period", { phase: "FT" });
  const kicks: [string, boolean][] = [
    [home, true], [away, true], [home, true], [away, true], [home, true], [away, true], [home, false], [away, false], [home, true], [away, false],
  ];
  for (const [by, scored] of kicks) await post(auth, fixtureId, "football.shootout.kick", { by, scored });
  const [f] = await sql<{ status: string; outcome: { kind?: string; winner?: string; method?: string } | null }[]>`
    select status, outcome from fixtures where id = ${fixtureId}`;
  if (f?.status !== "decided" || f.outcome?.kind !== "win" || f.outcome.winner !== home || f.outcome.method !== "shootout") {
    throw new Error(`rig: not a shoot-out win for the home side (${f?.status} ${JSON.stringify(f?.outcome)})`);
  }
}

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
    expect(lastJson(before)).toEqual({ ...CHECK_ZERO, unpinnedStarted: 2, baseStageRules: 2 });
    expect(await rowsOf([leagueA, koA, leagueB]), "--check writes nothing").toEqual(window_);

    // A alone: B is out of scope and untouched
    const bBefore = await rowsOf([leagueB]);
    const onlyA = await cli(["--org", a.auth.orgId], env);
    expect(onlyA.code, onlyA.err).toBe(0);
    expect(lastJson(onlyA)).toEqual({ ...APPLY_ZERO, converted: 1, pinned: 1 });
    const pinnedA = await stageRules(leagueA);
    expect(pinnedA.pin, "the script's pin is the activation door's own").toEqual(activation.pin);
    expect(pinnedA.pinned_at, "and it is dated").not.toBeNull();
    expect(await pointsOf(koA), "the pending knockout's {base} rule is converted").toEqual(KO_RULE_PAYS);
    expect(await stageRules(koA), "and the pending knockout stays unpinned (it reads live)").toMatchObject({ status: "pending", pin: null });
    expect(await rowsOf([leagueB]), "an org not named is neither converted nor pinned").toEqual(bBefore);

    // both: B's rule is converted BEFORE its pin is taken, so the pin carries the converted rule, not the sport's
    const run = await cli(both, env);
    expect(run.code, run.err).toBe(0);
    expect(lastJson(run)).toEqual({ ...APPLY_ZERO, converted: 1, pinned: 1 });
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
    expect(lastJson(again)).toEqual(APPLY_ZERO);
    expect(await rowsOf([leagueA, koA, leagueB]), "a second run changes nothing").toEqual(settled);
    expect(settled.length, "anti-vacuity: rows compared").toBe(3);

    const after = await cli(["--check", ...both], env);
    expect(after.code, after.err).toBe(0);
    expect(lastJson(after)).toEqual(CHECK_ZERO);
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
    expect(lastJson(r)).toEqual({ ...APPLY_ZERO, refused: 1, unpinnedStarted: 1, baseStageRules: 1 });
    expect(r.err).toContain(league);
    expect(await rowsOf([league]), "nothing written").toEqual(before);
    const check = await cli(["--check", "--org", c.auth.orgId], { ...process.env });
    expect(check.code).toBe(1);
    expect(lastJson(check)).toEqual({ ...CHECK_ZERO, unpinnedStarted: 1, baseStageRules: 1 });
  }, 3 * CLI_MS);

  it("N4: a {base} rule the old code saved over a stage ALREADY pinned is converted and that pin's points re-pinned to it (source stage) — an app pin of an own rule and a V474-migrated pin alike; the order, the cross-group order, their sources and the pin's date kept; a second run changes nothing", async () => {
    // P: a league with its own outcome-keyed rule, started through the product — the app's pin, points source "stage"
    const p = await tableScene({});
    const [leagueP] = p.stageIds as [string];
    await sql`update stages set config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(KO_RULE_PAYS as never)}) where id = ${leagueP}`;
    await startDivision(p.auth, p.divisionId);
    const appPin = (await stageRules(leagueP)).pin as Pin | null;
    expect(appPin?.sources.points, "premise: the app pinned the stage's own rule").toBe("stage");
    // M: a league started, its pin then put in V474's shape (spec §5.4 "Migration pin": every source "migrated", the
    // cross-group order the pre-W2d hard-coded one)
    const m = await tableScene({});
    const [leagueM] = m.stageIds as [string];
    await startDivision(m.auth, m.divisionId);
    const activationM = (await stageRules(leagueM)).pin as Pin;
    const migrated: Pin = {
      ...activationM,
      crossGroup: PRE_W2D_CROSS_GROUP,
      sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" },
    };
    await sql`update stages set table_rules_pinned = ${sql.json(migrated as never)} where id = ${leagueM}`;
    touched.push(leagueP, leagueM);
    // the window: the old code saves a {base} rule over both active, pinned stages
    await sql`update stages set config = jsonb_set(config, '{points}', ${sql.json(BASE_RULE as never)}) where id in ${sql([leagueP, leagueM])}`;
    const before = new Map((await rowsOf([leagueP, leagueM])).map((r) => [r.id, r]));
    for (const [id, was] of before) {
      expect((was.pin as Pin).points, `premise (${id}): the pin does not already pay the converted rule`).not.toEqual(BASE_RULE_PAYS);
    }
    const env = { ...process.env };
    const both = ["--org", p.auth.orgId, "--org", m.auth.orgId];
    const run = await cli(both, env);
    expect(run.code, run.err).toBe(0);
    expect(lastJson(run)).toEqual({ ...APPLY_ZERO, converted: 2, repinned: 2 });
    let checked = 0;
    for (const id of [leagueP, leagueM]) {
      const was = before.get(id)!;
      const [now] = await rowsOf([id]);
      const wasPin = was.pin as Pin;
      expect((now!.config as { points: unknown }).points, "the rule is converted (B1)").toEqual(BASE_RULE_PAYS);
      expect(now!.pin, "only the points field re-pinned: the converted rule, source stage").toEqual({
        ...wasPin,
        points: BASE_RULE_PAYS,
        sources: { ...wasPin.sources, points: "stage" },
      });
      expect(now!.at, "the pin's date kept").toBe(was.at);
      expect(now!.status).toBe(was.status);
      checked++;
    }
    expect(checked).toBe(2);
    const settled = await rowsOf([leagueP, leagueM]);
    const again = await cli(both, env);
    expect(again.code, again.err).toBe(0);
    expect(lastJson(again)).toEqual(APPLY_ZERO);
    expect(await rowsOf([leagueP, leagueM]), "a second run changes nothing").toEqual(settled);
  }, 4 * CLI_MS);

  it("the shoot-out split: an old-app football division and its org's own variant saved with shootoutWin/shootoutLoss are converted FIRST (soBonus = shootoutWin − draw, the old keys gone), then the started stage is pinned paying that bonus; another org's variant untouched; --check counts them; a second run changes nothing", async () => {
    await seedFootballCatalog();
    const football = builtinModules.find((x) => x.key === "football") as AnySportModule;
    const f = await tableScene({ sport: "football", variant: "11-a-side" });
    const [league] = f.stageIds as [string];
    await startDivision(f.auth, f.divisionId);
    expect(await stageRules(league), "premise: the league started").toMatchObject({ status: "active" });
    touched.push(league);
    touchedDivisions.push(f.divisionId);
    const env = { ...process.env };
    const scope = ["--org", f.auth.orgId];
    // the window: the old code saved the division's points with the W2c split — the split alone is work left
    const SPLIT = { win: 3, draw: 1, loss: 0, shootoutWin: 3, shootoutLoss: 1 };
    await sql`update divisions set config = jsonb_set(config, '{points}', ${sql.json(SPLIT)}) where id = ${f.divisionId}`;
    const splitOnly = await cli(["--check", ...scope], env);
    expect(splitOnly.code, `a split alone keeps a deploy from passing: ${splitOnly.err}`).toBe(1);
    expect(lastJson(splitOnly)).toEqual({ ...CHECK_ZERO, shootoutSplitConfigs: 1 });
    // …and it started the league with no pin
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${league}`;
    const divisionBefore = await divisionConfigOf(f.divisionId);
    // …and an org-owned variant with a split, in this org and in another (out of scope)
    const other = await seedOrg("pro");
    const VARIANT_SPLIT = { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 };
    const variantCfg = { ...(football.variants["11-a-side"] as Record<string, unknown>), points: VARIANT_SPLIT };
    const mine = VARIANT_PREFIX + "mine";
    const theirs = VARIANT_PREFIX + "theirs";
    for (const [key, org] of [[mine, f.auth.orgId], [theirs, other.auth.orgId]] as const) {
      await sql`insert into sport_variants (sport_key, key, name, config, is_system, org_id)
                values ('football', ${key}, ${key}, ${sql.json(variantCfg as never)}, false, ${org})`;
    }

    const check = await cli(["--check", ...scope], env);
    expect(check.code, check.err).toBe(1);
    expect(lastJson(check)).toEqual({ ...CHECK_ZERO, unpinnedStarted: 1, shootoutSplitConfigs: 2 });
    const theirsBefore = await variantConfigOf(theirs);
    const run = await cli(scope, env);
    expect(run.code, run.err).toBe(0);
    expect(lastJson(run)).toEqual({ ...APPLY_ZERO, divisionConfigs: 1, variantConfigs: 1, pinned: 1 });
    // spec §5.3 / PS-1: a draw-plus-bonus shoot-out pays its winner the draw plus soBonus, so soBonus = shootoutWin − draw
    const divisionAfter = await divisionConfigOf(f.divisionId);
    expect(divisionAfter.points).toEqual({ win: 3, draw: 1, loss: 0, soBonus: SPLIT.shootoutWin - SPLIT.draw });
    expect(withoutPoints(divisionAfter), "the rest of the division cfg").toEqual(withoutPoints(divisionBefore));
    expect(await variantConfigOf(mine)).toEqual({
      ...variantCfg,
      points: { win: 3, draw: 1, loss: 0, soBonus: VARIANT_SPLIT.shootoutWin - VARIANT_SPLIT.draw },
    });
    expect(await variantConfigOf(theirs), "another org's variant: out of scope").toEqual(theirsBefore);
    // the pin was taken AFTER the conversion: it pays the converted bonus (W2d's schema strips the split keys, so a pin
    // taken over them would pay none of the organiser's split)
    const pin = (await stageRules(league)).pin as { points: { soBonus?: number } } | null;
    expect(pin?.points.soBonus).toBe(SPLIT.shootoutWin - SPLIT.draw);

    const settled = { stage: await rowsOf([league]), division: await divisionConfigOf(f.divisionId), variant: await variantConfigOf(mine) };
    const again = await cli(scope, env);
    expect(again.code, again.err).toBe(0);
    expect(lastJson(again)).toEqual(APPLY_ZERO);
    expect({ stage: await rowsOf([league]), division: await divisionConfigOf(f.divisionId), variant: await variantConfigOf(mine) }).toEqual(settled);
    const after = await cli(["--check", ...scope], env);
    expect(after.code, after.err).toBe(0);
    expect(lastJson(after)).toEqual(CHECK_ZERO);
  }, 6 * CLI_MS);

  it("a shoot-out split the B1 reader refuses (a non-number) is not written and its division's started stage is not pinned over it: exit 1, the division named", async () => {
    await seedFootballCatalog();
    const f = await tableScene({ sport: "football", variant: "11-a-side" });
    const [league] = f.stageIds as [string];
    await startDivision(f.auth, f.divisionId);
    touched.push(league);
    touchedDivisions.push(f.divisionId);
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${league}`;
    await sql`update divisions set config = jsonb_set(config, '{points}', ${sql.json({ win: 3, draw: 1, loss: 0, shootoutWin: "2" })}) where id = ${f.divisionId}`;
    const before = { stage: await rowsOf([league]), division: await divisionConfigOf(f.divisionId) };
    const r = await cli(["--org", f.auth.orgId], { ...process.env });
    expect(r.code, "a deploy stops on a refused row").toBe(1);
    expect(lastJson(r)).toEqual({ ...APPLY_ZERO, refused: 1, unpinnedStarted: 1, shootoutSplitConfigs: 1 });
    expect(r.err).toContain(f.divisionId);
    expect({ stage: await rowsOf([league]), division: await divisionConfigOf(f.divisionId) }, "nothing written").toEqual(before);
  }, 2 * CLI_MS);

  it("N4: a re-pin the app refuses (a pin that does not parse) rolls its conversion back — the row named as failed, exit 1, nothing written, the run goes on to the rest", async () => {
    const c = await tableScene({});
    const [league] = c.stageIds as [string];
    await startDivision(c.auth, c.divisionId);
    const good = (await stageRules(league)).pin;
    touched.push(league);
    await sql`update stages set table_rules_pinned = ${sql.json({ unreadable: true })},
                     config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(BASE_RULE as never)}) where id = ${league}`;
    try {
      const before = await rowsOf([league]);
      const r = await cli(["--org", c.auth.orgId], { ...process.env });
      expect(r.code, "a deploy stops on a failed row").toBe(1);
      expect(lastJson(r)).toEqual({ ...APPLY_ZERO, failed: 1, baseStageRules: 1 });
      expect(r.err).toContain(`stage ${league}: CONFIG_INVALID`);
      expect(await rowsOf([league]), "rolled back: the rule is still {base}, the pin as it was").toEqual(before);
    } finally {
      await sql`update stages set table_rules_pinned = ${sql.json(good as never)} where id = ${league}`;
    }
  }, 2 * CLI_MS);
});

type Scene = Awaited<ReturnType<typeof tableScene>>;

/** Runs the script (`args`) while this test holds `division-config:<division>` SHARED — what a match's first event holds
 *  from before it resolves its config until it commits (append-event.ts) — and, once the run is seen WAITING for that
 *  lock (an ungranted request on its key in pg_locks) or has exited, marks `fixtureId` played (a frozen config:
 *  `playedSql`'s first arm) in the same transaction and commits: the first tap lands. A run that takes the app's lock
 *  before its lock read waits, then reads the fixture played; one that does not has read it unplayed already. */
async function runAgainstFirstTap(divisionId: string, fixtureId: string, args: readonly string[]): Promise<{ r: Cli; waited: boolean }> {
  const key = `division-config:${divisionId}`;
  let waited = false;
  let done: Cli | undefined;
  let running: Promise<Cli> | undefined;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtext(${key}))`;
    running = cli(args, { ...process.env }).then((x) => (done = x));
    const until = Date.now() + CLI_MS;
    while (done === undefined && Date.now() < until) {
      // a one-key advisory lock shows its key's high half as classid, its low half as objid
      const [w] = await tx<{ n: number }[]>`
        select count(*)::int as n from pg_locks
         where locktype = 'advisory' and not granted
           and database = (select oid from pg_database where datname = current_database())
           and classid::bigint = ((hashtext(${key})::bigint >> 32) & 4294967295)
           and objid::bigint = (hashtext(${key})::bigint & 4294967295)`;
      if (w!.n > 0) {
        waited = true;
        break;
      }
      await new Promise((d) => setTimeout(d, 100));
    }
    await tx`update fixtures set config_snapshot = coalesce(config_snapshot, '{}'::jsonb) where id = ${fixtureId}`;
  });
  return { r: await running!, waited };
}

// Fix round 3 (N5, N6, N8; owner ruling: the script NEVER changes what a scored stage reads). Each row's transaction asks
// the lock's own predicate (`lockedStageIdsAmong`: a played fixture or an opened round) of every stage the row's write
// would reach; a hit is HELD — not written, named on stderr, counted in the summary and in `--check`, exit 1. Every case
// below is scored through `scoreEvent` (the console's write) and compares what the scored stage READS — its table as
// the app computes it, and its stored snapshots — byte for byte before and after. Two sports: generic for the stage-rule
// and pin rows (sport-blind doors, as above), football for the shoot-out split, the one rule the split moves.
describe.skipIf(!HAS_DB)("W2d T9 fix round 3: a row whose write would reach a SCORED stage is held, never written", () => {
  it("N5(a): an own {base} rule the old code saved on a V474-pinned stage that was then SCORED is held — not converted, not re-pinned; one on an unpinned scored stage is held ONCE; what each reads byte-identical; exit 1, the stages named; --check counts them", async () => {
    const s = await tableScene({ entrants: 2 });
    const [league] = s.stageIds as [string];
    const [E1, E2] = s.entrants as [string, string];
    await startDivision(s.auth, s.divisionId);
    const activation = (await stageRules(league)).pin as Pin;
    const migrated: Pin = { ...activation, crossGroup: PRE_W2D_CROSS_GROUP, sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" } };
    touched.push(league);
    // the window: the old code saves a {base} rule over the V474 pin (its stage-rules save allows it until the first
    // score) — and a match is then scored, read under the pin
    await sql`update stages set table_rules_pinned = ${sql.json(migrated as never)},
                     config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(BASE_RULE as never)}) where id = ${league}`;
    await genericResult(s.auth, league, E1, E2, 2, 1);
    // and a stage the old code started with no pin, saved a {base} rule on and scored: both its rows (the rule, the pin)
    // reach it, and it is held once
    const u = await tableScene({ entrants: 2 });
    const [loose] = u.stageIds as [string];
    await startDivision(u.auth, u.divisionId);
    await genericResult(u.auth, loose, u.entrants[0]!, u.entrants[1]!, 2, 1);
    touched.push(loose);
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null,
                     config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(BASE_RULE as never)}) where id = ${loose}`;
    const env = { ...process.env };
    const scope = ["--org", s.auth.orgId, "--org", u.auth.orgId];
    const before = { rows: await rowsOf([league, loose]), reads: await readsOf(league), loose: await readsOf(loose) };
    expect(before.reads.snapshots, "premise: the score wrote a table").not.toBe("[]");
    // premise: converting would move the table — the pin pays generic's win, the saved rule its own (B1, one goal's margin)
    expect(rowOf(before.reads.table, E1).points, "premise: the table pays the pin's win").toBe(GENERIC_CONFIG.points.w);
    expect(BASE_RULE.base.win).not.toBe(GENERIC_CONFIG.points.w);

    const check = await cli(["--check", ...scope], env);
    expect(check.code, check.err).toBe(1);
    expect(lastJson(check)).toEqual({ ...CHECK_ZERO, baseStageRules: 2, unpinnedStarted: 1, held: 2 });
    const r = await cli(scope, env);
    expect(r.code, "a held row stops a deploy").toBe(1);
    expect(lastJson(r)).toEqual({ ...APPLY_ZERO, held: 2, baseStageRules: 2, unpinnedStarted: 1 });
    expect(r.err).toContain(`held: stage ${league}`);
    expect(r.err.split("\n").filter((l) => l.startsWith(`held: stage ${loose}`)), "held once, not once per row").toHaveLength(1);
    expect(await rowsOf([league, loose]), "nothing written: the {base} rules and the pins as they were").toEqual(before.rows);
    expect(await readsOf(league), "what the scored stage reads: byte-identical").toEqual(before.reads);
    expect(await readsOf(loose), "and the unpinned one").toEqual(before.loose);
  }, 2 * CLI_MS + 90_000);

  it("N5: a stage the old code started with no pin and that was SCORED in the window is held, not pinned — still unpinned, what it reads byte-identical; exit 1; --check counts it", async () => {
    const s = await tableScene({ entrants: 2 });
    const [league] = s.stageIds as [string];
    const [E1, E2] = s.entrants as [string, string];
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, league, E1, E2, 2, 1);
    touched.push(league);
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${league}`;
    const env = { ...process.env };
    const scope = ["--org", s.auth.orgId];
    const before = { rows: await rowsOf([league]), reads: await readsOf(league) };
    expect(before.reads.snapshots, "premise: the score wrote a table").not.toBe("[]");

    const check = await cli(["--check", ...scope], env);
    expect(check.code, check.err).toBe(1);
    expect(lastJson(check)).toEqual({ ...CHECK_ZERO, unpinnedStarted: 1, held: 1 });
    const r = await cli(scope, env);
    expect(r.code, "a held row stops a deploy").toBe(1);
    expect(lastJson(r)).toEqual({ ...APPLY_ZERO, held: 1, unpinnedStarted: 1 });
    expect(r.err).toContain(`held: stage ${league}`);
    expect(await stageRules(league), "not pinned").toMatchObject({ status: "active", pin: null });
    expect(await rowsOf([league]), "nothing written").toEqual(before.rows);
    expect(await readsOf(league), "what the scored stage reads: byte-identical").toEqual(before.reads);
  }, 2 * CLI_MS + 60_000);

  it("N5(b): a division the old code saved on the shoot-out split, whose PENDING stage (no pin: it reads the live layers) then played an ad-hoc match won on penalties, is held — not converted; the winner keeps the draw plus the default bonus; exit 1, the division named", async () => {
    await seedFootballCatalog();
    const f = await tableScene({ sport: "football", variant: "11-a-side", config: SHOOTOUT_CFG, entrants: 2 });
    const [league] = f.stageIds as [string];
    const [E1, E2] = f.entrants as [string, string];
    touchedDivisions.push(f.divisionId);
    // the window: the old code saves the split (its lock allows it, nothing has played yet); the division starts with an
    // ad-hoc match already on its league, so the start generates nothing and leaves the league pending (I1's shape) — and
    // the match is played, the pending league reading the division's points live: stripped of the split, the default bonus
    await sql`update divisions set config = jsonb_set(config, '{points}', ${sql.json(WINDOW_SPLIT)}) where id = ${f.divisionId}`;
    // its own points a JSON null: "inherit", as an absent key is (`ownRulesOf` reads any falsy value so)
    await sql`update stages set config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', 'null'::jsonb) where id = ${league}`;
    const { fixture_id } = await addFixture(f.auth, league, { home_entrant_id: E1, away_entrant_id: E2 });
    await startDivision(f.auth, f.divisionId);
    await shootoutWin(f.auth, fixture_id, E1, E2);
    expect(await stageRules(league), "premise: the stage is pending and unpinned").toMatchObject({ status: "pending", pin: null });
    const env = { ...process.env };
    const scope = ["--org", f.auth.orgId];
    const before = { division: await divisionConfigOf(f.divisionId), stage: await rowsOf([league]), reads: await readsOf(league) };
    expect(before.reads.snapshots, "premise: the score wrote a table").not.toBe("[]");
    // B2 (`payout`): a draw-plus-bonus shoot-out pays its winner the draw plus `soBonus`, absent 1; PS-1's conversion
    // makes it shootoutWin − draw, so the winner would move from draw + 1 to shootoutWin
    expect(rowOf(before.reads.table, E1).points, "premise: the winner holds the draw plus the default bonus").toBe(WINDOW_SPLIT.draw + 1);
    expect(WINDOW_SPLIT.shootoutWin, "premise: the conversion would move it").not.toBe(WINDOW_SPLIT.draw + 1);

    const check = await cli(["--check", ...scope], env);
    expect(check.code, check.err).toBe(1);
    expect(lastJson(check)).toEqual({ ...CHECK_ZERO, shootoutSplitConfigs: 1, held: 1 });
    const r = await cli(scope, env);
    expect(r.code, "a held row stops a deploy").toBe(1);
    expect(lastJson(r)).toEqual({ ...APPLY_ZERO, held: 1, shootoutSplitConfigs: 1 });
    expect(r.err).toContain(`held: division ${f.divisionId}`);
    expect(r.err, "it names the scored stage").toContain(league);
    expect(await divisionConfigOf(f.divisionId), "the division is not converted").toEqual(before.division);
    expect(await rowsOf([league]), "nor its stage").toEqual(before.stage);
    expect(await readsOf(league), "what the scored stage reads: byte-identical").toEqual(before.reads);
  }, 2 * CLI_MS + 60_000);

  it("N6: a football stage the old code started with no pin, with a shoot-out WIN scored in the window (pre-W2d: a shoot-out pays as the result), is held — not pinned under W2d's draw-plus-bonus, so the win is not flipped to a draw", async () => {
    await seedFootballCatalog();
    const f = await tableScene({ sport: "football", variant: "11-a-side", config: SHOOTOUT_CFG, entrants: 2 });
    const [league] = f.stageIds as [string];
    await startDivision(f.auth, f.divisionId);
    const activation = (await stageRules(league)).pin as Pin;
    // the rule the window's table was read under: V474's `w2d_pre_points` shape for a pre-W2d football split (spec §5.4
    // "Migration pin": a shoot-out booked as the result, `win.so`/`loss.so`)
    const prePoints = PointsRule.parse({
      shootoutAs: "result",
      unit: "whole",
      bonuses: [],
      win: { regulation: 3, so: WINDOW_SPLIT.shootoutWin },
      loss: { regulation: 0, so: WINDOW_SPLIT.shootoutLoss },
      draw: 1,
      tie: 1,
      noResult: 1,
    });
    const prePin = { ...activation, points: prePoints, crossGroup: PRE_W2D_CROSS_GROUP, sources: { points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" } };
    await sql`update stages set table_rules_pinned = ${sql.json(prePin as never)} where id = ${league}`;
    const [fx] = await seatedFixtures(league);
    await shootoutWin(f.auth, fx!.id, fx!.home, fx!.away);
    touched.push(league);
    // …and the old code had left the stage with no pin
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${league}`;
    const winnerOf = (snapshots: string) => (JSON.parse(snapshots) as { rows: TableRow[] }[])[0]?.rows.find((x) => x.entrantId === fx!.home);
    const before = { rows: await rowsOf([league]), reads: await readsOf(league) };
    expect(winnerOf(before.reads.snapshots), "premise: the window's table counts the shoot-out as a win").toMatchObject({ won: 1, drawn: 0 });

    const r = await cli(["--org", f.auth.orgId], { ...process.env });
    expect(r.code, "a held row stops a deploy").toBe(1);
    expect(lastJson(r)).toEqual({ ...APPLY_ZERO, held: 1, unpinnedStarted: 1 });
    expect(r.err).toContain(`held: stage ${league}`);
    expect(await stageRules(league), "not pinned under W2d's shoot-out").toMatchObject({ status: "active", pin: null });
    const after = await readsOf(league);
    expect(winnerOf(after.snapshots), "the win is not flipped to a draw").toMatchObject({ won: 1, drawn: 0 });
    expect(after, "what the scored stage reads: byte-identical").toEqual(before.reads);
    expect(await rowsOf([league])).toEqual(before.rows);
  }, CLI_MS + 60_000);

  it("N8: a split division whose stage the NEW code pinned over the stripped config (source sport) is converted and that UNSCORED stage re-pinned from it (soBonus = shootoutWin − draw; order, cross-group order, their sources and the date kept) — a played stage with its own rule does not hold it; a SCORED pinned one's division is held with its unpinned started stage, pin and table byte-identical; a second run changes nothing", async () => {
    await seedFootballCatalog();
    const parsed = footballModule.configSchema.parse(SHOOTOUT_CFG);
    // an own rule (createStages parses it): the sport's own for a league, so the stage pays as the division does today
    const ownRule = footballModule.tablePointsRule(parsed as never, "league");
    const two = (second: Record<string, unknown>) =>
      [
        { seq: 1, kind: "league", name: "League", config: {} },
        { seq: 2, kind: "league", name: "Second", config: second },
      ] as CreateStages;
    const one = await tableScene({ sport: "football", variant: "11-a-side", config: SHOOTOUT_CFG, entrants: 2, stages: two({ points: ownRule }) });
    const other = await tableScene({ sport: "football", variant: "11-a-side", config: SHOOTOUT_CFG, entrants: 2, stages: two({}) });
    const [f1, own1] = one.stageIds as [string, string];
    const [f2, late2] = other.stageIds as [string, string];
    touchedDivisions.push(one.divisionId, other.divisionId);
    touched.push(late2);
    // the window: the old code saves both divisions on the split; after the deploy the NEW code starts both (pinning
    // over the config its schema strips); a match of the second division's league is won on penalties, and an ad-hoc
    // match on the first division's pending stage with its own rule is too
    for (const sc of [one, other]) await sql`update divisions set config = jsonb_set(config, '{points}', ${sql.json(WINDOW_SPLIT)}) where id = ${sc.divisionId}`;
    await startDivision(one.auth, one.divisionId);
    await startDivision(other.auth, other.divisionId);
    const [fx2] = await seatedFixtures(f2);
    await shootoutWin(other.auth, fx2!.id, fx2!.home, fx2!.away);
    const { fixture_id: ownFixture } = await addFixture(one.auth, own1, { home_entrant_id: one.entrants[0]!, away_entrant_id: one.entrants[1]! });
    await shootoutWin(one.auth, ownFixture, one.entrants[0]!, one.entrants[1]!);
    // …and the old code had started the second division's second league with no pin, nothing played on it
    await sql`update stages set status = 'active' where id = ${late2}`;
    const BONUS = WINDOW_SPLIT.shootoutWin - WINDOW_SPLIT.draw; // spec §5.3 / PS-1
    const [was1] = await rowsOf([f1]);
    const pin1 = was1!.pin as Pin & { points: { soBonus?: number } };
    expect(pin1.sources.points, "premise: the new code pinned the sport's rule").toBe("sport");
    expect(pin1.points.soBonus, "premise: pinned over the stripped split — not the organiser's bonus").not.toBe(BONUS);
    expect(await stageRules(own1), "premise: the stage with its own rule is pending, unpinned").toMatchObject({ status: "pending", pin: null });
    const ownBefore = await readsOf(own1);
    expect(ownBefore.snapshots, "premise: its match wrote a table").not.toBe("[]");
    const before2 = { division: await divisionConfigOf(other.divisionId), stages: await rowsOf([f2, late2]), reads: await readsOf(f2) };
    expect(before2.reads.snapshots, "premise: the score wrote a table").not.toBe("[]");
    const env = { ...process.env };
    const scope = ["--org", one.auth.orgId, "--org", other.auth.orgId];

    const check = await cli(["--check", ...scope], env);
    expect(check.code, check.err).toBe(1);
    expect(lastJson(check)).toEqual({ ...CHECK_ZERO, unpinnedStarted: 1, shootoutSplitConfigs: 2, held: 2 });
    const r = await cli(scope, env);
    expect(r.code, "a held row stops a deploy").toBe(1);
    expect(lastJson(r)).toEqual({ ...APPLY_ZERO, divisionConfigs: 1, repinned: 1, held: 2, unpinnedStarted: 1, shootoutSplitConfigs: 1 });
    expect(r.err).toContain(`held: division ${other.divisionId}`);
    expect(r.err).toContain(`held: stage ${late2}: not pinned: its division ${other.divisionId} is held`);
    // unscored: converted, and the stage re-pinned from the converted config through the engine's resolver
    const d1 = await divisionConfigOf(one.divisionId);
    expect(d1.points).toEqual({ win: 3, draw: 1, loss: 0, soBonus: BONUS });
    const [now1] = await rowsOf([f1]);
    const resolved = resolveTableRules({
      module: footballModule,
      stageKind: "league",
      mergedCfg: liveCfg(d1, { kind: "league", config: now1!.config as Record<string, unknown> | null }, footballModule as never),
      stageOwn: { points: null, tiebreakers: null, crossGroup: null },
      divisionTiebreakers: null,
      pinned: null,
    });
    expect(now1!.pin, "only the points field re-pinned, source sport").toEqual({ ...pin1, points: resolved.points, sources: { ...pin1.sources, points: "sport" } });
    expect((now1!.pin as { points: { soBonus?: number } }).points.soBonus, "the organiser's bonus").toBe(BONUS);
    expect(now1!.at, "the pin's date kept").toBe(was1!.at);
    expect(now1!.status).toBe(was1!.status);
    expect(await readsOf(own1), "a played stage with its own rule reads no division points: unmoved").toEqual(ownBefore);
    // scored: held, with its division's unpinned started stage
    expect(await divisionConfigOf(other.divisionId), "the scored stage's division is not converted").toEqual(before2.division);
    expect(await rowsOf([f2, late2]), "nor its pin, nor a pin for its unpinned stage").toEqual(before2.stages);
    expect(await readsOf(f2), "what the scored stage reads: byte-identical").toEqual(before2.reads);

    const settled = await rowsOf([f1, own1]);
    const again = await cli(scope, env);
    expect(again.code, "still held").toBe(1);
    expect(lastJson(again)).toEqual({ ...APPLY_ZERO, held: 2, unpinnedStarted: 1, shootoutSplitConfigs: 1 });
    expect(await rowsOf([f1, own1]), "a second run changes nothing").toEqual(settled);
  }, 3 * CLI_MS + 180_000);

  it("N5: each row takes the app's division-config lock before its lock read — a first tap in flight is waited for and its fixture then read as played: held (a division on the split, a {base} rule, a pin alike), nothing written", async () => {
    await seedFootballCatalog();
    // a division on the split, its pending league holding an ad-hoc match not yet played
    const d = await tableScene({ sport: "football", variant: "11-a-side", config: SHOOTOUT_CFG, entrants: 2 });
    const [dLeague] = d.stageIds as [string];
    touchedDivisions.push(d.divisionId);
    await sql`update divisions set config = jsonb_set(config, '{points}', ${sql.json(WINDOW_SPLIT)}) where id = ${d.divisionId}`;
    const { fixture_id: dFixture } = await addFixture(d.auth, dLeague, { home_entrant_id: d.entrants[0]!, away_entrant_id: d.entrants[1]! });
    await startDivision(d.auth, d.divisionId);
    // a started, pinned league whose {base} rule the old code saved, nothing played
    const b = await tableScene({ entrants: 2 });
    const [bLeague] = b.stageIds as [string];
    await startDivision(b.auth, b.divisionId);
    touched.push(bLeague);
    await sql`update stages set config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(BASE_RULE as never)}) where id = ${bLeague}`;
    // a league the old code started with no pin, nothing played
    const p = await tableScene({ entrants: 2 });
    const [pLeague] = p.stageIds as [string];
    await startDivision(p.auth, p.divisionId);
    touched.push(pLeague);
    await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${pLeague}`;
    const [bFixture] = await seatedFixtures(bLeague);
    const [pFixture] = await seatedFixtures(pLeague);
    const cases: { name: string; scene: Scene; fixture: string; line: string; left: Record<string, number>; rows: () => Promise<unknown> }[] = [
      {
        name: "a division on the split",
        scene: d,
        fixture: dFixture,
        line: `held: division ${d.divisionId}`,
        left: { shootoutSplitConfigs: 1 },
        rows: async () => ({ division: await divisionConfigOf(d.divisionId), stage: await rowsOf([dLeague]) }),
      },
      { name: "a {base} rule", scene: b, fixture: bFixture!.id, line: `held: stage ${bLeague}`, left: { baseStageRules: 1 }, rows: () => rowsOf([bLeague]) },
      { name: "a pin", scene: p, fixture: pFixture!.id, line: `held: stage ${pLeague}`, left: { unpinnedStarted: 1 }, rows: () => rowsOf([pLeague]) },
    ];
    let checked = 0;
    for (const c of cases) {
      const before = await c.rows();
      const { r, waited } = await runAgainstFirstTap(c.scene.divisionId, c.fixture, ["--org", c.scene.auth.orgId]);
      expect(waited, `${c.name}: the run waited for the first tap's lock (${r.code} ${r.err})`).toBe(true);
      expect(r.code, `${c.name}: ${r.err}`).toBe(1);
      expect(lastJson(r), c.name).toEqual({ ...APPLY_ZERO, held: 1, ...c.left });
      expect(r.err, c.name).toContain(c.line);
      expect(await c.rows(), `${c.name}: nothing written`).toEqual(before);
      checked++;
    }
    expect(checked).toBe(3);
  }, 3 * CLI_MS + 120_000);
});

describe.skipIf(!HAS_DB)("W2d T9 fix round 2: dropShootoutSplit is V474's w2d_drop_shootout_split, case for case", () => {
  it("the split's rows are organisation variants only: a system preset (org_id null) on the split is never counted — whole-database census, before and after, in one rolled-back snapshot", async () => {
    // A system preset is `sync:sports`'s, written from the code (V474 step 4 skips them alike); counted, the deploy would
    // stop on a row this script must not write. Read whole-database (no --org): REPEATABLE READ holds other suites' rows
    // still, so the difference is this test's two rows alone.
    const { auth } = await seedOrg("pro");
    const cfg = { points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 } };
    const ROLLBACK = new Error("rollback");
    let delta: number | undefined;
    await expect(
      sql.begin(async (tx) => {
        await tx`set transaction isolation level repeatable read`;
        const before = await census(tx as never, [], lockedStageIdsAmong as never);
        await tx`insert into sport_variants (sport_key, key, name, config, is_system, org_id) values
                 ('football', ${VARIANT_PREFIX + "org"}, 'org', ${tx.json(cfg)}, false, ${auth.orgId}),
                 ('football', ${VARIANT_PREFIX + "sys"}, 'sys', ${tx.json(cfg)}, true, null)`;
        const after = await census(tx as never, [], lockedStageIdsAmong as never);
        delta = after.shootoutSplitConfigs - before.shootoutSplitConfigs;
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    expect(delta, "the organisation's variant counts; the system preset does not").toBe(1);
  }, 60_000);

  it("over a grid of points shapes × the three sports the split names and two it does not: the same config (jsonb-equal), the same refusals and the same notices (counted, every arm reached)", async () => {
    const deltas = join(REPO, "db", "migration", "deltas");
    const files = readdirSync(deltas).filter((x) => /^V\d+__w2d_table_rules\.sql$/.test(x));
    expect(files, "the W2d delta, by glob").toHaveLength(1);
    const code = readFileSync(join(deltas, files[0]!), "utf8").replace(/--.*$/gm, "");
    const fn = (name: string): string => {
      const hit = new RegExp(`create or replace function ${name}\\s*\\([\\s\\S]*?\\$\\$;`).exec(code);
      if (hit === null) throw new Error(`the W2d delta defines no ${name}`);
      return hit[0];
    };
    const url = process.env.DATABASE_URL!;
    const schema = connectionOptions(url).schema;
    const POINTS: unknown[] = [
      { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
      { win: 3, draw: 1, loss: 0, shootoutWin: 3, shootoutLoss: 0 },
      { win: 3, draw: 2, loss: 0, shootoutWin: 1, shootoutLoss: 2 },
      { win: 3, loss: 0, shootoutWin: 2 },
      { win: 3, draw: 1, loss: 0, shootoutWin: 2, soBonus: 5 },
      { win: 3, draw: 1, loss: 0, shootoutLoss: 1 },
      { win: 3, draw: "1", loss: 0, shootoutWin: 2 },
      { win: 3, draw: 1, loss: 0, shootoutWin: null },
      { win: 3, draw: 0.1, loss: 0, shootoutWin: 0.3 },
      { win: 3, draw: 1, loss: 0, shootoutWin: 2.5 },
      { win: 3, otWin: 2, otLoss: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
      { win: 3, otWin: 2, otLoss: 1, loss: 0, shootoutWin: 3, shootoutLoss: 1 },
      { win: 3, otWin: 2, otLoss: 1, loss: 0, shootoutWin: 2, shootoutLoss: 0 },
      { win: 3, loss: 0, shootoutWin: 3, shootoutLoss: 0 },
      { win: 3, otWin: null, loss: 0, shootoutWin: 3 },
      { win: 3, draw: 1, loss: 0 },
      [],
    ];
    const CFGS: unknown[] = [...POINTS.map((points) => ({ shootout: true, points })), { shootout: true }, null, { points: null }];
    const SPORTS = ["football", "hockey", "icehockey", "cricket", "generic"];
    const KINDS: [RegExp, SplitNotice][] = [
      [/a shoot-out now pays the overtime values/, "overtime-differs"],
      [/shootoutLoss differs from the draw/, "loss-differs-from-draw"],
      [/the bonus is clamped to 0/, "bonus-clamped"],
    ];
    const notices: string[] = [];
    const client = postgres(url, {
      max: 1,
      ssl: connectionOptions(url).ssl,
      connection: { search_path: schema },
      onnotice: (n) => notices.push(String(n.message)),
    });
    const ROLLBACK = new Error("rollback");
    const tally = { checked: 0, refused: 0, changed: 0, unchanged: 0, said: new Set<string>() };
    const mismatches: string[] = [];
    try {
      await expect(
        client.begin(async (tx) => {
          for (const name of ["w2d_points_num", "w2d_drop_shootout_split"]) await tx.unsafe(fn(name).replace(/\$\{flyway:defaultSchema\}/g, schema));
          for (const sport of SPORTS) {
            for (const cfg of CFGS) {
              const ts = dropShootoutSplit(sport, cfg);
              const at = notices.length;
              let sqlSide: { refused: true } | { refused: false; eq: boolean; same: boolean };
              try {
                sqlSide = await tx.savepoint(async (sp) => {
                  const [row] = await sp<{ eq: boolean | null; same: boolean }[]>`
                    with x as materialized (select w2d_drop_shootout_split(${sport}, ${sp.json(cfg as never)}) as r)
                    select r is not distinct from ${sp.json(("refused" in ts ? null : ts.cfg) as never)} as eq,
                           r is not distinct from ${sp.json(cfg as never)} as same
                      from x`;
                  return { refused: false as const, eq: row!.eq === true, same: row!.same };
                });
              } catch (e) {
                if ((e as { code?: string }).code !== "22023") throw e;
                sqlSide = { refused: true };
              }
              const said = notices.slice(at).map((n) => KINDS.find(([re]) => re.test(n))?.[1] ?? `unknown: ${n}`);
              const label = `${sport} ${JSON.stringify(cfg)}`;
              const twin = "refused" in ts ? { refused: true } : { refused: false, eq: true, same: !ts.changed, said: ts.notices };
              const pg = sqlSide.refused ? { refused: true } : { refused: false, eq: sqlSide.eq, same: sqlSide.same, said };
              if (JSON.stringify(twin) !== JSON.stringify(pg)) mismatches.push(`${label}: twin ${JSON.stringify(twin)} ≠ V474 ${JSON.stringify(pg)}`);
              if (sqlSide.refused) tally.refused++;
              else if (sqlSide.same) tally.unchanged++;
              else tally.changed++;
              for (const n of said) tally.said.add(n);
              tally.checked++;
            }
          }
          throw ROLLBACK;
        }),
      ).rejects.toBe(ROLLBACK);
    } finally {
      await client.end();
    }
    expect(mismatches.join("\n"), "the twin and V474's SQL, case for case").toBe("");
    expect(tally.checked).toBe(SPORTS.length * CFGS.length);
    expect(tally.refused, "anti-vacuity: refusals compared").toBeGreaterThan(0);
    expect(tally.changed, "anti-vacuity: conversions compared").toBeGreaterThan(0);
    expect(tally.unchanged, "anti-vacuity: untouched configs compared").toBeGreaterThan(0);
    expect([...tally.said].sort(), "every notice the SQL says was said by the twin too").toEqual(KINDS.map(([, k]) => k).sort());
  }, 60_000);
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

  // Re-review N1: under --prod the URL reaches the driver, whose `new URL` error carries its input. The script parses it
  // first and refuses what it cannot read with a fixed message; the password below must appear nowhere.
  const SENTINEL = "SENTINELPW";
  const NOT_PRINTED = [SENTINEL, "probeuser", "other.invalid", "bad host"];
  const UNREADABLE = [
    { name: "a space in the host", url: `postgres://probeuser:${SENTINEL}@bad host.invalid:5432/x` },
    { name: "an unclosed IPv6 host", url: `postgresql://probeuser:${SENTINEL}@[::1/db` },
    { name: "a password that does not decode", url: `postgresql://probeuser:${SENTINEL}%ZZ@localhost/db` },
    { name: "a host list", url: `postgresql://probeuser:${SENTINEL}@localhost,other.invalid/db` },
    { name: "a second @ in the authority", url: `postgresql://probeuser:${SENTINEL}@localhost@other.invalid/db` },
    { name: "no scheme", url: `probeuser:${SENTINEL}@other.invalid/db` },
    { name: "another scheme", url: `mysql://probeuser:${SENTINEL}@other.invalid/db` },
  ];
  for (const c of UNREADABLE) {
    it(`N1 --prod with ${c.name}: the script's own parse refuses it — exit 2, the fixed message, no part of the URL printed`, async () => {
      expect(parseDatabaseUrl(c.url), "premise: our parse refuses it").toBeNull();
      const r = await cli(["--check", "--prod"], { ...process.env, DATABASE_URL: c.url });
      expect(r.code, `${r.out} ${r.err}`).toBe(2);
      expect(r.err).toContain("DATABASE_URL is not a valid postgres URL");
      for (const s of NOT_PRINTED) expect(r.out + r.err, `printed ${s}`).not.toContain(s);
    }, CLI_MS);
  }

  it("N1 --prod with options the DRIVER refuses (an unknown target_session_attrs, which its error echoes): exit 2, a fixed message, nothing of the URL printed — no connection made", async () => {
    const url = `postgresql://probeuser:${SENTINEL}@0.0.0.0:1/db?target_session_attrs=SENTINELTSA`;
    expect(parseDatabaseUrl(url), "premise: our parse reads it").not.toBeNull();
    const r = await cli(["--check", "--prod"], { ...process.env, DATABASE_URL: url });
    expect(r.code, `${r.out} ${r.err}`).toBe(2);
    expect(r.err).toContain("the database driver refused DATABASE_URL");
    for (const s of [...NOT_PRINTED, "SENTINEL", "0.0.0.0"]) expect(r.out + r.err, `printed ${s}`).not.toContain(s);
  }, CLI_MS);

  it("N3 --prod against this machine's closed port (0.0.0.0, reaches nothing): the driver's failure is printed with its code, and its host, port and user taken out", async () => {
    const port = await closedPort();
    const url = `postgresql://sentinel_user:${SENTINEL}@0.0.0.0:${port}/sentinel_db`;
    const r = await cli(["--check", "--prod"], { ...process.env, DATABASE_URL: url });
    expect(r.code, `${r.out} ${r.err}`).toBe(1);
    expect(r.err, "the code is printed (the owner can act on it)").toContain("ECONNREFUSED");
    for (const s of ["sentinel", SENTINEL, "0.0.0.0", String(port)]) expect(r.out + r.err, `printed ${s}`).not.toContain(s);
  }, CLI_MS);

  it.skipIf(!HAS_DB)("N7: a database that does not exist on this machine's own server (3D000): the code printed, the database's name not", async () => {
    const u = new URL(process.env.DATABASE_URL!);
    expect(isLocalDatabaseUrl(u.toString()), "premise: the test database is on this machine").toBe(true);
    const name = `sentinel_nodb_${randomUUID().slice(0, 8)}`;
    u.pathname = `/${name}`;
    const r = await cli(["--check"], { ...process.env, DATABASE_URL: u.toString() });
    expect(r.code, `${r.out} ${r.err}`).toBe(1);
    expect(r.err, "the code is printed (the owner can act on it)").toContain("3D000");
    expect(r.err).toContain('database "<database>" does not exist');
    for (const s of ["sentinel", name]) expect(r.out + r.err, `printed ${s}`).not.toContain(s);
  }, CLI_MS);

  it("parseDatabaseUrl reads what the driver reads (host, port, decoded user and password, a host override) and never throws", () => {
    expect(parseDatabaseUrl("postgresql://us%40er:p%3Ass@db.example.invalid:6543/x?sslmode=require")).toEqual({
      raw: "postgresql://us%40er:p%3Ass@db.example.invalid:6543/x?sslmode=require",
      host: "db.example.invalid:6543",
      hostname: "db.example.invalid",
      port: "6543",
      username: "us@er",
      password: "p:ss",
      database: "x",
      hostOverride: false,
    });
    expect(parseDatabaseUrl("postgres://u@[::1]/db")).toMatchObject({ hostname: "[::1]", port: "", username: "u", password: "", database: "db" });
    // N7: the database as the driver sends it (postgres.js 3.4.9 `url.pathname.slice(1)`, NOT decoded) — `redact` takes
    // that and its decoded form both; none named reads "" (the driver then sends the user's name)
    expect(parseDatabaseUrl("postgresql://u@h.invalid/my%5Fdb?sslmode=require")?.database).toBe("my%5Fdb");
    expect(parseDatabaseUrl("postgresql://u@h.invalid")?.database).toBe("");
    expect(parseDatabaseUrl("postgresql://u@localhost/db?hostaddr=10.0.0.1")?.hostOverride).toBe(true);
    let checked = 0;
    for (const bad of ["", "postgresql:///db", "postgresql://u@a,b/db", "postgresql://u:p@a@b/db", "http://u@h/db", "postgresql://u:%E0%A4%A@h/db", "nope"]) {
      expect(parseDatabaseUrl(bad), JSON.stringify(bad)).toBeNull();
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("N3 redact: a driver's messages lose the URL's host, port, user and password and any IP address, and keep their code words (counted)", () => {
    const db = parseDatabaseUrl(`postgresql://sentinel_user:${SENTINEL}@sentinel-host.invalid:5999/sentinel_db`)!;
    const cases: [string, string][] = [
      ["getaddrinfo ENOTFOUND sentinel-host.invalid", "ENOTFOUND"],
      ["write CONNECTION_CLOSED sentinel-host.invalid:5999", "CONNECTION_CLOSED"],
      ["connect ECONNREFUSED 10.9.8.7:5999", "ECONNREFUSED"],
      ["connect ECONNREFUSED ::1:5999", "ECONNREFUSED"],
      ['password authentication failed for user "sentinel_user"', "password authentication failed"],
      [`could not use postgresql://sentinel_user:${SENTINEL}@sentinel-host.invalid:5999/sentinel_db`, "could not use"],
      [`password ${SENTINEL} rejected at SENTINEL-HOST.INVALID`, "rejected at"],
      ["the server at port 5999 closed the connection", "closed the connection"],
      // N7: the server's own 3D000 line names the database the URL asked for
      ['database "sentinel_db" does not exist', "does not exist"],
    ];
    let checked = 0;
    for (const [message, kept] of cases) {
      const out = redact(message, db);
      for (const s of ["sentinel", "SENTINEL", "5999", "10.9.8.7", "::1"]) expect(out, `${message} → ${out}`).not.toContain(s);
      expect(out, "the code words stay").toContain(kept);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // a URL that names no port: the driver's default is what it reached, so 5432 goes; an id's digits stay
    const noPort = parseDatabaseUrl("postgresql://u:pw@host.invalid/db")!;
    expect(redact("connect ETIMEDOUT host.invalid:5432 for stage 0b5432aa-5432-4c1d-8e2f-000000005432", noPort)).toBe(
      "connect ETIMEDOUT <host>:<port> for stage 0b5432aa-5432-4c1d-8e2f-000000005432",
    );
    // with no parsed URL, addresses still go
    expect(redact("connect ECONNREFUSED 192.0.2.4:6543", null)).toBe("connect ECONNREFUSED <address>");
    // N7: a database named with an escape goes as the driver sent it (raw) and as decoded
    const encoded = parseDatabaseUrl("postgresql://u@h.invalid/sentinel%5Fenc")!;
    for (const name of ["sentinel%5Fenc", "sentinel_enc"]) {
      expect(redact(`database "${name}" does not exist`, encoded)).toBe('database "<database>" does not exist');
    }
  });

  it("N3 failureLine: the row, the error's code, and its message redacted; an EngineError's message kept", () => {
    const db = parseDatabaseUrl(`postgresql://sentinel_user:${SENTINEL}@sentinel-host.invalid:5999/x`)!;
    const dropped = Object.assign(new Error("write CONNECTION_CLOSED sentinel-host.invalid:5999"), { code: "CONNECTION_CLOSED" });
    expect(failureLine("stage s1", dropped, db)).toBe("stage s1: CONNECTION_CLOSED write CONNECTION_CLOSED <host>:<port>");
    const engine = Object.assign(new Error("stage s1 is active with no pin (unpinned)"), { code: "CONFIG_INVALID" });
    expect(failureLine("stage s1", engine, db)).toBe("stage s1: CONFIG_INVALID stage s1 is active with no pin (unpinned)");
    expect(failureLine("stage s1", "sentinel-host.invalid down", db)).toBe("stage s1: ERROR <host> down");
  });
});

/** A TCP port on this machine nothing listens on (bound, read, released). */
function closedPort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "0.0.0.0", () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => done(port));
    });
  });
}
