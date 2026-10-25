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
// connects, and `0.0.0.0` at a port just found closed (this machine). Fix round 2 adds the shoot-out split (V472's data
// steps 3 and 4, redone for the window): its TypeScript twin is held to V472's own SQL over a grid of every sport the
// split names and two it does not, and the CLI is run over an old-app football division and organisation variant.
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
import type { CreateStages } from "@/server/api-v1/schemas";
import { startDivision } from "@/server/usecases/schedule";
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
  unpinnedStarted: 0,
  baseStageRules: 0,
  shootoutSplitConfigs: 0,
};

type Pin = { points: unknown; tiebreakers: string[]; crossGroup: string[]; sources: { points: string; tiebreakers: string; crossGroup: string } };
/** The pre-W2d cross-group order V472 pins (hard-coded at W2D_BASE, `packages/engine/src/competition/progression.ts:573-575`). */
const PRE_W2D_CROSS_GROUP = ["points", "diff", "for", "wins"];
const divisionConfigOf = async (id: string) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${id}`)[0]!.config;
const variantConfigOf = async (key: string) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from sport_variants where key = ${key}`)[0]?.config;
const withoutPoints = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "points"));

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
    expect(lastJson(before)).toEqual({ mode: "check", unpinnedStarted: 2, baseStageRules: 2, shootoutSplitConfigs: 0 });
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
    expect(lastJson(after)).toEqual({ mode: "check", unpinnedStarted: 0, baseStageRules: 0, shootoutSplitConfigs: 0 });
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
    expect(lastJson(check)).toEqual({ mode: "check", unpinnedStarted: 1, baseStageRules: 1, shootoutSplitConfigs: 0 });
  }, 3 * CLI_MS);

  it("N4: a {base} rule the old code saved over a stage ALREADY pinned is converted and that pin's points re-pinned to it (source stage) — an app pin of an own rule and a V472-migrated pin alike; the order, the cross-group order, their sources and the pin's date kept; a second run changes nothing", async () => {
    // P: a league with its own outcome-keyed rule, started through the product — the app's pin, points source "stage"
    const p = await tableScene({});
    const [leagueP] = p.stageIds as [string];
    await sql`update stages set config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${sql.json(KO_RULE_PAYS as never)}) where id = ${leagueP}`;
    await startDivision(p.auth, p.divisionId);
    const appPin = (await stageRules(leagueP)).pin as Pin | null;
    expect(appPin?.sources.points, "premise: the app pinned the stage's own rule").toBe("stage");
    // M: a league started, its pin then put in V472's shape (spec §5.4 "Migration pin": every source "migrated", the
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
    expect(lastJson(splitOnly)).toEqual({ mode: "check", unpinnedStarted: 0, baseStageRules: 0, shootoutSplitConfigs: 1 });
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
    expect(lastJson(check)).toEqual({ mode: "check", unpinnedStarted: 1, baseStageRules: 0, shootoutSplitConfigs: 2 });
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
    expect(lastJson(after)).toEqual({ mode: "check", unpinnedStarted: 0, baseStageRules: 0, shootoutSplitConfigs: 0 });
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

describe.skipIf(!HAS_DB)("W2d T9 fix round 2: dropShootoutSplit is V472's w2d_drop_shootout_split, case for case", () => {
  it("the split's rows are organisation variants only: a system preset (org_id null) on the split is never counted — whole-database census, before and after, in one rolled-back snapshot", async () => {
    // A system preset is `sync:sports`'s, written from the code (V472 step 4 skips them alike); counted, the deploy would
    // stop on a row this script must not write. Read whole-database (no --org): REPEATABLE READ holds other suites' rows
    // still, so the difference is this test's two rows alone.
    const { auth } = await seedOrg("pro");
    const cfg = { points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 } };
    const ROLLBACK = new Error("rollback");
    let delta: number | undefined;
    await expect(
      sql.begin(async (tx) => {
        await tx`set transaction isolation level repeatable read`;
        const before = await census(tx as never, []);
        await tx`insert into sport_variants (sport_key, key, name, config, is_system, org_id) values
                 ('football', ${VARIANT_PREFIX + "org"}, 'org', ${tx.json(cfg)}, false, ${auth.orgId}),
                 ('football', ${VARIANT_PREFIX + "sys"}, 'sys', ${tx.json(cfg)}, true, null)`;
        const after = await census(tx as never, []);
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
              if (JSON.stringify(twin) !== JSON.stringify(pg)) mismatches.push(`${label}: twin ${JSON.stringify(twin)} ≠ V472 ${JSON.stringify(pg)}`);
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
    expect(mismatches.join("\n"), "the twin and V472's SQL, case for case").toBe("");
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

  it("parseDatabaseUrl reads what the driver reads (host, port, decoded user and password, a host override) and never throws", () => {
    expect(parseDatabaseUrl("postgresql://us%40er:p%3Ass@db.example.invalid:6543/x?sslmode=require")).toEqual({
      raw: "postgresql://us%40er:p%3Ass@db.example.invalid:6543/x?sslmode=require",
      host: "db.example.invalid:6543",
      hostname: "db.example.invalid",
      port: "6543",
      username: "us@er",
      password: "p:ss",
      hostOverride: false,
    });
    expect(parseDatabaseUrl("postgres://u@[::1]/db")).toMatchObject({ hostname: "[::1]", port: "", username: "u", password: "" });
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
