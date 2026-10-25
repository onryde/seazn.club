// W2d Task 7 (spec §5.4 "Migration pin (B1)", §8; plan PF-1, PF-3, PS-1d, PS-8) — the W2d delta's B1 half: the pin
// columns, `stage_lots_draws`, and the pin of every stage that has started, to the rules it is paid and ranked by BEFORE
// W2d. Expected values never come from W2d's code: they come from `fixtures/w2d-pin-before.json`, the tables and
// declarations a server built at W2D_BASE (e97823e4d8, main before W2d) printed for the scenario that
// `fixtures/w2d-pin-seed.ts` (the seeding twin, PS-8a) re-inserts here with the same ids.
//
// The delta is read by GLOB, never by number (it is renumbered at merge), and its OWN text runs here: every function
// it defines and its data-step block are installed and run inside a transaction on a dedicated client that is always
// rolled back — the pin and the conversions act on the whole database, and the shared test DB holds sibling suites'
// stages. Scoped to the scenario's organization as the app's tenant role (`app_user` + `app.current_org`), RLS shows
// them that org's rows alone, so each count is the scenario's and the empty case is deterministic. The DDL (the pin
// columns, their check, `stage_lots_draws`) is the applied migration's.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PointsRule, parseLegacyPointsRule, parseStoredPointsRule } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { connectionOptions, type Tx } from "@/lib/db";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { boundsInForce, divisionPointsBounds, stageQualMeta } from "@/server/public-site/qualification-view";
import {
  W2D_PIN_BEFORE,
  W2D_PIN_ORG_ID,
  asW2dPinTenant,
  seedW2dPinScenario,
  type W2dPinStage,
} from "./fixtures/w2d-pin-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../../db/migration/deltas");
const NAME = /^V\d+__w2d_table_rules\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const text = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
/** The statements, comments removed: a `--` line naming a literal must not satisfy a regex meant for the SQL. */
const code = text.replace(/--.*$/gm, "");
const FUNCTIONS = [...code.matchAll(/create or replace function ([a-z_0-9]+)\s*\([\s\S]*?\$\$;/g)].map((m) => ({
  name: m[1]!,
  sql: m[0],
}));
/** The data steps: the delta's one `do` block (pin, then the stage-rule and division-config conversions). */
const STEPS = /do \$\$[\s\S]*?end \$\$;/.exec(code)?.[0];
const PLACEHOLDER = /\$\{flyway:defaultSchema\}/g;
const SCHEMA = HAS_DB ? connectionOptions(process.env.DATABASE_URL!).schema : "seazn_club";
/** The interface the brief names (plan Task 7 "Produces"). */
const BRIEF_FUNCTIONS = ["w2d_legacy_points", "w2d_pre_points", "w2d_pre_cascade", "w2d_pin_started_stages"];

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const ROLLBACK = new Error("rollback");

/** `body` on its own one-connection client inside a transaction that is always rolled back; the notices it raised. */
async function rolledBack<T>(body: (tx: Tx, notices: string[]) => Promise<T>): Promise<{ value: T; notices: string[] }> {
  const url = process.env.DATABASE_URL!;
  const notices: string[] = [];
  const client = postgres(url, {
    max: 1,
    ssl: connectionOptions(url).ssl,
    connection: { search_path: connectionOptions(url).schema },
    onnotice: (n) => notices.push(String(n.message)),
  });
  let value: T | undefined;
  try {
    await expect(
      client.begin(async (tx) => {
        value = await body(tx, notices);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  } finally {
    await client.end();
  }
  return { value: value as T, notices };
}

/** The delta's own functions, installed from its TEXT (so a change to the file is what runs), callable by the tenant
 *  role inside this rolled-back transaction only. A delta that does not define the brief's interface fails here. */
async function install(tx: Tx): Promise<void> {
  const missing = BRIEF_FUNCTIONS.filter((n) => !FUNCTIONS.some((f) => f.name === n));
  if (files.length !== 1 || missing.length > 0 || STEPS === undefined) {
    throw new Error(
      `the W2d delta (${files.join(", ") || "none found"}) does not define ${[...missing, ...(STEPS === undefined ? ["its data-step block"] : [])].join(", ")}`,
    );
  }
  for (const f of FUNCTIONS) await tx.unsafe(f.sql.replace(PLACEHOLDER, SCHEMA));
  for (const f of FUNCTIONS.filter((f) => f.name.startsWith("w2d_"))) {
    await tx.unsafe(`grant execute on function ${f.name} to app_user`);
  }
}

/** Installed, seeded with the twin, and scoped to the scenario's organization. */
async function seeded(tx: Tx): Promise<void> {
  await install(tx);
  await seedW2dPinScenario(tx);
  await asW2dPinTenant(tx);
}

async function runSteps(tx: Tx): Promise<void> {
  await tx.unsafe(STEPS!.replace(PLACEHOLDER, SCHEMA));
}

const STAGES = W2D_PIN_BEFORE.stages;
const stageOf = (family: string, status?: W2dPinStage["status"]): W2dPinStage => {
  const hits = STAGES.filter((s) => s.family === family && (status === undefined || s.status === status));
  if (hits.length !== 1) throw new Error(`premise: one recorded ${family} stage${status ? ` (${status})` : ""}, found ${hits.length}`);
  return hits[0]!;
};
const STARTED = STAGES.filter((s) => s.status === "active" || s.status === "complete");
const PENDING = STAGES.filter((s) => s.status === "pending");
/** A stage's own rule, as the loader reads it: any truthy `config.points` (`competition.ts` `stage.config?.points ?`). */
const ownPoints = (s: W2dPinStage): unknown => (s.stageConfig as { points?: unknown }).points || undefined;
/** The pre-W2d cross-group order, hard-coded at W2D_BASE (`packages/engine/src/competition/progression.ts:573-575`). */
const PRE_W2D_CROSS_GROUP = ["points", "diff", "for", "wins"];
const recordedPoints = (s: W2dPinStage): Record<string, number> =>
  Object.fromEntries(s.table.map((r) => [r.entrantId, r.points]));
const recordedDivision = (family: string): { config: Record<string, unknown>; sport: string; id: string } => {
  const s = STAGES.find((x) => x.family === family)!;
  return { config: s.divisionConfig as Record<string, unknown>, sport: s.sport, id: s.divisionId };
};
const withoutKeys = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const head = (sport: string) => {
  const m = builtinModules.find((x) => x.key === sport);
  if (!m) throw new Error(`premise: today's registry has ${sport}`);
  return m;
};

/** `stage`'s table under `rule`, ranked by TODAY's fold (`rankedStageStandings`) with the rule as the stage's own — and,
 *  for a started stage, as its pin: since W2d Task 9 a started stage is paid by its pin alone (and one with none is
 *  refused, CONFIG_INVALID), so the rule is written where today's read takes it. Only the points are compared. */
async function pointsUnder(tx: Tx, stageId: string, rule: unknown): Promise<Record<string, number>> {
  const pin = { points: rule, tiebreakers: ["points"], crossGroup: ["points"], sources: { points: "stage", tiebreakers: "stage" } };
  await tx`
    update stages set config = jsonb_set(coalesce(config, '{}'::jsonb), '{points}', ${tx.json(rule as never)}),
           table_rules_pinned = case when status in ('active', 'complete') then ${tx.json(pin as never)} else table_rules_pinned end,
           table_rules_pinned_at = case when status in ('active', 'complete') then now() else table_rules_pinned_at end
    where id = ${stageId}`;
  const rows = await rankedStageStandings(tx, stageId);
  return Object.fromEntries(rows.map((r) => [r.entrantId, r.points]));
}
/** The rule a stored `config.points` is after the migration: the outcome-keyed shape as it stands, the W2c shape as B1
 *  converts it (`parseLegacyPointsRule`, the W2c reader — today's stored-rule read no longer takes that shape). */
const afterMigration = (raw: unknown) => parseStoredPointsRule(raw) ?? parseLegacyPointsRule(raw);

interface StageRow {
  id: string;
  status: string;
  config: Record<string, unknown>;
  pin: Record<string, unknown> | null;
  pinned_at: string | null;
}
const stageRows = (tx: Tx) => tx<StageRow[]>`
  select s.id, s.status, s.config, s.table_rules_pinned as pin, s.table_rules_pinned_at::text as pinned_at
  from stages s join divisions d on d.id = s.division_id
  where d.org_id = ${W2D_PIN_ORG_ID} order by s.id`;
const divisionConfigs = async (tx: Tx): Promise<Map<string, Record<string, unknown>>> =>
  new Map(
    (await tx<{ id: string; config: Record<string, unknown> }[]>`select id, config from divisions where org_id = ${W2D_PIN_ORG_ID}`).map(
      (r) => [r.id, r.config],
    ),
  );

/** `fn` rejects with a Postgres error carrying `code` (inside a savepoint, so the transaction lives on). */
async function refusal(tx: Tx, code: string, fn: (sp: Tx) => Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp as unknown as Tx);
    });
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected a ${code} refusal`).toBeDefined();
  expect(caught).toMatchObject({ code });
  return (caught as Error).message;
}

describe.skipIf(!HAS_DB)("W2d migration — B1 pin, stored lots table (V472)", () => {
  it("premise: the recording holds started stages of both statuses, pending ones, every sport, and its tables", () => {
    expect(files, "one W2d delta").toHaveLength(1);
    expect(STARTED.filter((s) => s.status === "complete").length).toBeGreaterThan(0);
    expect(STARTED.filter((s) => s.status === "active").length).toBeGreaterThan(0);
    expect(PENDING.length).toBeGreaterThan(0);
    expect(new Set(STARTED.map((s) => s.sport))).toEqual(new Set(Object.keys(W2D_PIN_BEFORE.declarations)));
    for (const s of STARTED) expect(s.table.length, `${s.family} has a table`).toBeGreaterThan(1);
    expect(W2D_PIN_BEFORE.w2dBase).toBe("e97823e4d8");
  });

  it("the delta drops every w2d_* helper it defines, after its data steps, and the applied schema holds none", async () => {
    // After this release the start path is the only pin writer: a helper left behind would let a manual call pin a stage
    // with PRE-W2d payers. The read helper the view calls stays (the positive pair).
    const defined = FUNCTIONS.map((f) => f.name).filter((n) => n.startsWith("w2d_")).sort();
    const drops = [...code.matchAll(/drop function (w2d_[a-z_0-9]+)\s*\(/g)];
    expect(defined, "the helpers the delta defines").toHaveLength(6);
    expect(drops.map((m) => m[1]!).sort()).toEqual(defined);
    const stepsEnd = code.indexOf(STEPS!) + STEPS!.length;
    let checked = 0;
    for (const m of drops) {
      expect(m.index!, `${m[1]} is dropped after the data steps that call it`).toBeGreaterThan(stepsEnd);
      checked++;
    }
    expect(checked).toBe(defined.length);
    const { value } = await rolledBack(
      (tx) => tx<{ proname: string }[]>`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = ${SCHEMA} and (p.proname like 'w2d\_%' or p.proname in ('stage_points_rule_published', 'stage_qualification_meta'))
        order by 1`,
    );
    expect(value.map((r) => r.proname)).toEqual(["stage_points_rule_published", "stage_qualification_meta"]);
  });

  it("B1 w2d_legacy_points equals legacyPointsRule for every old-shape sample (one authority, two languages; counted)", async () => {
    const recorded = STAGES.map(ownPoints).filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && "base" in p);
    expect(recorded.length, "premise: the recording holds old-shape stage rules").toBe(2);
    const samples: unknown[] = [
      ...recorded,
      { base: { win: 3, draw: 1, loss: 0 } },
      { base: { win: 2.5, draw: -1, loss: 0 }, bonuses: [] },
      {
        base: { win: 3, draw: 1, loss: 0, note: "junk" },
        bonuses: [
          { when: "win_margin_gte", param: 3, points: 1, note: "junk" },
          { when: "draw", points: 0.5 },
          { when: "no_result", points: 1 },
        ],
        forfeit: { winnerPoints: 3, loserPoints: -1, note: "junk" },
        junk: { owner: "top level" },
      },
      { base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [3, 0] } },
    ];
    // Shapes the W2c reader refused (parseLegacyPointsRule ⇒ null), so the SQL twin refuses them too.
    const refused: unknown[] = [
      { base: { win: "3", draw: 1, loss: 0 } },
      { base: { win: 3, draw: 1 } },
      { base: null },
      { base: { win: 3, draw: 1, loss: 0 }, bonuses: null },
      { base: { win: 3, draw: 1, loss: 0 }, bonuses: [{ when: "nope", points: 1 }] },
      { base: { win: 3, draw: 1, loss: 0 }, bonuses: [{ when: "draw", param: null, points: 1 }] },
      { base: { win: 3, draw: 1, loss: 0 }, bonuses: [{ when: "draw" }] },
      { base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3 } },
      { base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3] } },
      { base: { win: 3, draw: 1, loss: 0 }, forfeit: null },
      [{ base: { win: 3, draw: 1, loss: 0 } }],
    ];
    const legacy = stageOf("generic-legacy", "active");
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      const converted: unknown[] = [];
      for (const s of samples) converted.push((await tx`select w2d_legacy_points(${tx.json(s as never)}) as r`)[0]!.r);
      const messages: string[] = [];
      for (const s of refused) {
        messages.push(await refusal(tx, "22023", (sp) => sp`select w2d_legacy_points(${sp.json(s as never)})`));
      }
      // …and through today's fold: the converted rule pays the recorded pre-W2d table (bonuses and the walkover row too).
      const [{ rule }] = await tx<{ rule: unknown }[]>`
        select w2d_legacy_points(config -> 'points') as rule from stages where id = ${legacy.stageId}`;
      const folded = await pointsUnder(tx, legacy.stageId, rule);
      return { converted, messages, folded };
    });
    let checked = 0;
    for (const [i, s] of samples.entries()) {
      const authority = parseLegacyPointsRule(s);
      expect(authority, `premise: sample ${i} is a shape the W2c reader reads`).not.toBeNull();
      expect(value.converted[i], `sample ${i}`).toEqual(authority);
      checked++;
    }
    for (const [i, s] of refused.entries()) {
      expect(parseLegacyPointsRule(s), `premise: refused sample ${i} is one the W2c reader refused`).toBeNull();
      expect(value.messages[i]).toMatch(/W2d/);
      checked++;
    }
    expect(checked).toBe(samples.length + refused.length);
    expect(checked).toBeGreaterThan(10);
    expect(value.folded).toEqual(recordedPoints(legacy));
  });

  it("B1 w2d_pre_points(sport, cfg) equals the pre-W2d payer for every SEEDED variant in w2d-pin-before.json (counted; PS-8c)", async () => {
    // The scenario seeds one variant per family (a few families twice, with a different cfg); the title says so rather
    // than claiming every preset. Expected: the points each recorded table printed BEFORE W2d, per entrant.
    //
    // WHAT A TABLE CAN WITNESS. A table prints each entrant's SUM of payouts, so a payout key is witnessed on its own only
    // where the stage's results separate it from the others; a symmetric cycle (each member wins one and loses one by the
    // same method, pin-scenario.ts) shows only the sum of its win and loss payouts, so a (w, l) pair with the same sum
    // prints the same table. Measured over this capture (each stage's results solved as a linear system in its keys):
    //   football  win/loss regulation: football-so, -so0, -onekey · win.so: football-so0 (2 ≠ the win), football-onekey
    //             (no split: a shoot-out pays the regulation pair) · football-so's shoot-outs: their sum only
    //   hockey    win.regulation: hockey-outdoor · hockey-pro: regulation, and its shoot-outs as a sum only
    //   icehockey win/loss .ot and .so: icehockey-split · icehockey-iihf: sums only
    //   cricket   win, loss, draw (= tie): cricket-test · tie and noResult: in sums only (cricket-t20, cricket-nr)
    //   set maps  badminton 2-0 and 2-1, both sides: badminton-swiss-a · tabletennis 3-0.w, 3-1.w, 3-1.l: tabletennis-a/-c
    //             · volleyball 3-0.w, 3-1.w: volleyball-a; volleyball-c's 3-2 cycle: sums only (one arm reads every sport's
    //             map: `bySetScore` is the map's set-score keys verbatim)
    //   tennis, boardgame, carrom win/loss: tennis-a/-c, chess-a/-c, carrom-c (chess-a: the draw too)
    //   generic   win.regulation: generic-a · generic-c and football-draw: sums only
    // NO recorded table witnesses these, and a direct assert covers each instead:
    //   football loss.so (football-so0's 0 equals the loss it would fall back to; football-so shows a sum)
    //     → "B1 football/hockey division cfg…" asserts the football-so pin's [win.so, loss.so]; PS-8d asserts the split's
    //       {regulation, so} on both sides
    //   the field-hockey split, win.so and loss.so (hockey-pro shows a sum; hockey-outdoor plays no shoot-out)
    //     → "B1 football/hockey division cfg…" asserts the hockey-pro pin's [win.so, loss.so]; PS-1d asserts the
    //       icehockey-split pin, which `w2d_pre_points`' shared `when 'hockey', 'icehockey'` arm builds
    //   cricket tie and noResult → "w2d_pre_points pays a tie and a no-result…" asserts both per key, every cricket division
    const subjects = STARTED.filter((s) => !ownPoints(s));
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      const out: { family: string; rule: unknown; points: Record<string, number> }[] = [];
      for (const s of subjects) {
        const [{ rule }] = await tx<{ rule: unknown }[]>`
          select w2d_pre_points(d.sport_key, d.config) as rule
          from stages st join divisions d on d.id = st.division_id where st.id = ${s.stageId}`;
        out.push({ family: s.family, rule, points: await pointsUnder(tx, s.stageId, rule) });
      }
      return out;
    });
    let stages = 0;
    let rows = 0;
    for (const [i, s] of subjects.entries()) {
      const got = value[i]!;
      expect(PointsRule.safeParse(got.rule).success, `${s.family}: today's PointsRule takes the pinned shape`).toBe(true);
      // the board games kept HALF-points before W2d (W2D_BASE boardgame.ts:59 "Points are HALF-POINTS (×2)"), so their
      // pin says so (spec §5.3 D10(b), `unit:"half"`); every other sport's points are whole
      expect((got.rule as { unit?: unknown }).unit, `${s.family}: unit`).toBe(s.sport === "boardgame" ? "half" : "whole");
      expect(got.points,`${s.family} (${s.sport}/${s.variant}, ${s.status})`).toEqual(recordedPoints(s));
      stages++;
      rows += s.table.length;
    }
    expect(stages).toBe(subjects.length);
    expect(stages).toBe(STARTED.length - 1);
    expect(new Set(subjects.map((s) => s.sport)).size, "every sport").toBe(Object.keys(W2D_PIN_BEFORE.declarations).length);
    expect(rows).toBeGreaterThan(100);
  });

  it("B1 PS-8d the equality above includes a one-key football sample: w2d_pre_points maps a cfg with only shootoutWin set to a plain win/loss shoot-out (as football.ts:2781-2784 paid), and both keys set to the split", async () => {
    const onekey = stageOf("football-onekey");
    const split = stageOf("football-so");
    const shootouts = (s: W2dPinStage) =>
      s.fixtures.filter((f) => (f as { outcome?: { method?: string } | null }).outcome?.method === "shootout").length;
    expect(shootouts(onekey), "premise: the one-key stage played shoot-outs").toBeGreaterThan(0);
    expect(shootouts(split), "premise: the split stage played shoot-outs").toBeGreaterThan(0);
    const pts = (s: W2dPinStage) => (s.divisionConfig as { points: Record<string, number> }).points;
    expect(Object.keys(pts(onekey))).toContain("shootoutWin");
    expect(Object.keys(pts(onekey))).not.toContain("shootoutLoss");
    const lossOnly = { ...withoutKeys(pts(split), ["shootoutWin"]) };
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      const ruleOf = async (cfg: unknown) =>
        (await tx<{ r: Record<string, Record<string, number>> }[]>`select w2d_pre_points('football', ${tx.json(cfg as never)}) as r`)[0]!.r;
      const one = await ruleOf(onekey.divisionConfig);
      const both = await ruleOf(split.divisionConfig);
      const loss = await ruleOf({ ...split.divisionConfig, points: lossOnly });
      return {
        one,
        both,
        loss,
        onePoints: await pointsUnder(tx, onekey.stageId, one),
        bothPoints: await pointsUnder(tx, split.stageId, both),
      };
    });
    // one key: no split at all — a shoot-out pays the regulation win and loss, as the pre-W2d module did
    expect(value.one.win).toEqual({ regulation: pts(onekey).win });
    expect(value.one.loss).toEqual({ regulation: pts(onekey).loss });
    expect(value.onePoints).toEqual(recordedPoints(onekey));
    // only shootoutLoss: no split either
    expect(value.loss.win).toEqual({ regulation: pts(split).win });
    expect(value.loss.loss).toEqual({ regulation: pts(split).loss });
    // both keys: the split, on the shoot-out only
    expect(value.both.win).toEqual({ regulation: pts(split).win, so: pts(split).shootoutWin });
    expect(value.both.loss).toEqual({ regulation: pts(split).loss, so: pts(split).shootoutLoss });
    expect(value.both.shootoutAs).toBe("result");
    expect(value.bothPoints).toEqual(recordedPoints(split));
  });

  it("B1 w2d_pin_started_stages pins active and complete stages only, returns the count, sources 'migrated'", async () => {
    const { value } = await rolledBack(async (tx) => {
      await install(tx);
      await asW2dPinTenant(tx);
      const [{ n: empty }] = await tx<{ n: number }[]>`select w2d_pin_started_stages() as n`;
      await tx`reset role`;
      await seedW2dPinScenario(tx);
      await asW2dPinTenant(tx);
      const [{ now }] = await tx<{ now: string }[]>`select now()::text as now`;
      const [{ n }] = await tx<{ n: number }[]>`select w2d_pin_started_stages() as n`;
      const rows = await stageRows(tx);
      const pre = new Map<string, unknown>();
      for (const s of STARTED.filter((x) => !ownPoints(x))) {
        pre.set(s.stageId, (await tx`select w2d_pre_points(${s.sport}, ${tx.json(s.divisionConfig as never)}) as r`)[0]!.r);
      }
      return { empty, n, now, rows, pre };
    });
    expect(value.empty, "empty case: an organization with no stage pins nothing").toBe(0);
    expect(value.n).toBe(STARTED.length);
    expect(value.rows).toHaveLength(STAGES.length);
    let pinned = 0;
    let unpinned = 0;
    for (const s of STAGES) {
      const row = value.rows.find((r) => r.id === s.stageId)!;
      if (s.status === "pending") {
        expect(row.pin, `${s.family} (pending) is not pinned`).toBeNull();
        expect(row.pinned_at).toBeNull();
        unpinned++;
        continue;
      }
      const own = ownPoints(s);
      expect(row.pin, `${s.family} (${s.status})`).toEqual({
        points: own ? afterMigration(own) : value.pre.get(s.stageId),
        tiebreakers: s.divisionTiebreakers ?? W2D_PIN_BEFORE.declarations[s.sport]!.defaultTiebreakers,
        crossGroup: PRE_W2D_CROSS_GROUP,
        sources: { points: "migrated", tiebreakers: "migrated" },
      });
      expect(row.pinned_at, `${s.family} pinned at the migration's moment`).toBe(value.now);
      pinned++;
    }
    expect(pinned).toBe(STARTED.length);
    expect(unpinned).toBe(PENDING.length);
    // the division's own list where it set one (PF-1: the resolver read it for every kind, Swiss too)
    expect(STARTED.some((s) => s.divisionTiebreakers !== null)).toBe(true);
    expect(STARTED.some((s) => s.kind === "swiss")).toBe(true);
  });

  it("B1 a second call pins nothing and changes nothing (idempotent)", async () => {
    const marked = stageOf("hockey-pro");
    const marker = { points: { marker: true }, tiebreakers: ["lots"], crossGroup: [], sources: { points: "stage", tiebreakers: "stage" } };
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      const [{ n: first }] = await tx<{ n: number }[]>`select w2d_pin_started_stages() as n`;
      // a pin written by someone else between the calls (a later W2d writer) — the second call must not touch it
      await tx`update stages set table_rules_pinned = ${tx.json(marker as never)}, table_rules_pinned_at = '2026-01-02T03:04:05Z'
               where id = ${marked.stageId}`;
      const before = await stageRows(tx);
      const [{ n: second }] = await tx<{ n: number }[]>`select w2d_pin_started_stages() as n`;
      const after = await stageRows(tx);
      return { first, second, before, after };
    });
    expect(value.first).toBe(STARTED.length);
    expect(value.second).toBe(0);
    expect(value.after).toEqual(value.before);
    expect(value.after.filter((r) => r.pin !== null)).toHaveLength(STARTED.length);
    expect(value.after.find((r) => r.id === marked.stageId)!.pin).toEqual(marker);
  });

  it("B1 a pending stage is NOT pinned, and its old-shape config.points is converted in place", async () => {
    const pendingLegacy = stageOf("generic-legacy", "pending");
    const activeLegacy = stageOf("generic-legacy", "active");
    const pendingPlain = stageOf("football-pending");
    const { value } = await rolledBack(async (tx, notices) => {
      await seeded(tx);
      await runSteps(tx);
      return { rows: await stageRows(tx), notices: [...notices] };
    });
    const row = (s: W2dPinStage) => value.rows.find((r) => r.id === s.stageId)!;
    let checked = 0;
    // the pending legacy stage: converted, its own rule still, and not pinned
    expect(row(pendingLegacy).pin).toBeNull();
    expect(row(pendingLegacy).config.points).toEqual(parseLegacyPointsRule(ownPoints(pendingLegacy)));
    expect(withoutKeys(row(pendingLegacy).config, ["points"])).toEqual(withoutKeys(pendingLegacy.stageConfig as Record<string, unknown>, ["points"]));
    checked++;
    // a pending stage without a rule: untouched
    expect(row(pendingPlain).pin).toBeNull();
    expect(row(pendingPlain).config).toEqual(pendingPlain.stageConfig);
    checked++;
    // an active legacy stage: converted in place too, and pinned to the same converted rule
    expect(row(activeLegacy).config.points).toEqual(parseLegacyPointsRule(ownPoints(activeLegacy)));
    expect(row(activeLegacy).pin?.points).toEqual(row(activeLegacy).config.points);
    checked++;
    // no stage anywhere is left in the old shape
    const old = value.rows.filter((r) => typeof r.config.points === "object" && r.config.points !== null && "base" in r.config.points);
    expect(old).toEqual([]);
    expect(checked).toBe(PENDING.length + 1);
    const summary = new RegExp(`W2d B1: pinned ${STARTED.length} started stage\\(s\\); converted 2 old-shape stage rule\\(s\\)`);
    expect(value.notices.some((n) => summary.test(n))).toBe(true);
  });

  it("B1 football/hockey division cfg: shootoutWin 2 with draw 1 becomes soBonus 1 and the old keys are gone", async () => {
    const OLD = ["shootoutWin", "shootoutLoss"];
    const families = [...new Set(STAGES.map((s) => s.family))];
    const converts = families.filter((f) => {
      const d = recordedDivision(f);
      return (d.sport === "football" || d.sport === "hockey") && "shootoutWin" in (d.config.points as object);
    });
    expect(converts.sort(), "premise: the recorded football/hockey divisions with a split").toEqual(
      ["football-onekey", "football-pending", "football-so", "football-so0", "hockey-pro"],
    );
    const { value } = await rolledBack(async (tx, notices) => {
      await seeded(tx);
      await runSteps(tx);
      const configs = await divisionConfigs(tx);
      const rows = await stageRows(tx);
      await tx`reset role`;
      const clamp = await tx<{ r: Record<string, unknown> }[]>`
        select w2d_drop_shootout_split('football', ${tx.json({ points: { win: 3, draw: 2, loss: 0, shootoutWin: 1, shootoutLoss: 2 } } as never)}) as r`;
      return { configs, rows, clamp: clamp[0]!.r, notices: [...notices] };
    });
    let checked = 0;
    for (const f of families) {
      const d = recordedDivision(f);
      const got = value.configs.get(d.id)!;
      if (!converts.includes(f)) {
        if (d.sport !== "icehockey") expect(got, `${f}: untouched`).toEqual(d.config);
        continue;
      }
      const p = d.config.points as Record<string, number>;
      expect(got.points, f).toEqual({ ...withoutKeys(p, OLD), soBonus: p.shootoutWin! - p.draw! });
      expect(withoutKeys(got, ["points"]), `${f}: the rest of the cfg`).toEqual(withoutKeys(d.config, ["points"]));
      // today's schema keeps the converted bonus (it would strip the old keys silently)
      expect((head(d.sport).configSchema.parse(got) as { points: { soBonus?: number } }).points.soBonus).toBe(p.shootoutWin! - p.draw!);
      checked++;
    }
    expect(checked).toBe(converts.length);
    // the pin ran FIRST: the started football stage keeps its pre-W2d shoot-out split
    const so = stageOf("football-so");
    const p = (so.divisionConfig as { points: Record<string, number> }).points;
    const pin = value.rows.find((r) => r.id === so.stageId)!.pin as { points: { win: { so?: number }; loss: { so?: number } } };
    expect([pin.points.win.so, pin.points.loss.so]).toEqual([p.shootoutWin, p.shootoutLoss]);
    // …and the started field-hockey stage keeps ITS split (its recorded table shows only the split's sum — see PS-8c)
    const pro = stageOf("hockey-pro");
    const hp = (pro.divisionConfig as { points: Record<string, number> }).points;
    expect(hp.shootoutWin !== hp.shootoutLoss, "premise: the field-hockey split pays the two sides differently").toBe(true);
    const proPin = value.rows.find((r) => r.id === pro.stageId)!.pin as { points: { win: Record<string, number>; loss: Record<string, number> } };
    expect(proPin.points.win).toEqual({ regulation: hp.win, so: hp.shootoutWin });
    expect(proPin.points.loss).toEqual({ regulation: hp.loss, so: hp.shootoutLoss });
    // shootoutLoss ≠ draw cannot be paid by draw-plus-bonus: converted, and said out loud (spec §5.4: the started stage
    // of that division is pinned with its old payout; only an unstarted stage takes B2)
    const so0 = recordedDivision("football-so0");
    expect(value.notices.filter((n) => n.includes("W2d shoot-out split (football)") && n.includes(`"shootoutLoss": 0`))).toHaveLength(1);
    expect(value.configs.get(so0.id)!.points).toMatchObject({ soBonus: 1 });
    // a shoot-out win below the draw clamps to a 0 bonus, also said out loud
    expect(value.clamp).toEqual({ points: { win: 3, draw: 2, loss: 0, soBonus: 0 } });
    expect(value.notices.some((n) => n.includes("W2d shoot-out split (football)") && n.includes("below the draw"))).toBe(true);
    expect(value.notices.some((n) => /converted 2 old-shape stage rule\(s\), 6 division config\(s\) and 0 organisation sport variant\(s\)/.test(n))).toBe(true);
  });

  it("T7 m10: an organisation's own football/hockey sport variant loses the shoot-out split as its divisions do (soBonus = shootoutWin − draw); ice hockey drops the keys; a system preset and another sport are untouched (counted)", async () => {
    // Expected from the B1 conversion's own rule (spec §5.3, PS-1): a draw-plus-bonus shoot-out pays its winner the draw
    // plus `soBonus`, so the bonus is the split's win minus the draw; ice hockey books a shoot-out as a result (PS-1d).
    const OLD = ["shootoutWin", "shootoutLoss"];
    const football = { points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 }, shootout: true };
    const hockey = { points: { win: 3, draw: 1, loss: 0, shootoutWin: 3, shootoutLoss: 1 } };
    const icehockey = { points: { win: 3, otWin: 2, otLoss: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 } };
    const cricket = { points: { win: 2, tie: 1, noResult: 1, loss: 0, shootoutWin: 9 } };
    const variants = [
      { sport: "football", key: "w2d-t9-fb", org: true, config: football, want: { ...football, points: { ...withoutKeys(football.points, OLD), soBonus: 1 } } },
      { sport: "hockey", key: "w2d-t9-hk", org: true, config: hockey, want: { ...hockey, points: { ...withoutKeys(hockey.points, OLD), soBonus: 2 } } },
      { sport: "icehockey", key: "w2d-t9-ih", org: true, config: icehockey, want: { points: withoutKeys(icehockey.points, OLD) } },
      // another sport keeps whatever it holds; a system preset is the code's (`sync:sports`), never this step's
      { sport: "cricket", key: "w2d-t9-ck", org: true, config: cricket, want: cricket },
      { sport: "football", key: "w2d-t9-sys", org: false, config: football, want: football },
    ];
    const { value } = await rolledBack(async (tx, notices) => {
      await install(tx);
      await seedW2dPinScenario(tx);
      for (const v of variants) {
        await tx`insert into sport_variants (sport_key, key, name, config, is_system, org_id)
                 values (${v.sport}, ${v.key}, ${v.key}, ${tx.json(v.config as never)}, ${!v.org}, ${v.org ? W2D_PIN_ORG_ID : null})`;
      }
      await asW2dPinTenant(tx);
      await runSteps(tx);
      await tx`reset role`;
      const rows = await tx<{ key: string; config: Record<string, unknown> }[]>`
        select key, config from sport_variants where key like 'w2d-t9-%'`;
      return { rows: new Map(rows.map((r) => [r.key, r.config])), notices: [...notices] };
    });
    let checked = 0;
    for (const v of variants) {
      expect(value.rows.get(v.key), `${v.sport} ${v.org ? "org" : "system"} variant`).toEqual(v.want);
      checked++;
    }
    expect(checked).toBe(variants.length);
    expect(value.notices.some((n) => /and 3 organisation sport variant\(s\) off the shoot-out split/.test(n))).toBe(true);
  });

  it("PS-1d an ice hockey division cfg loses shootoutWin/shootoutLoss and keeps otWin/otLoss", async () => {
    const split = recordedDivision("icehockey-split");
    const plain = recordedDivision("icehockey-iihf");
    const sp = split.config.points as Record<string, number>;
    expect(sp.shootoutWin !== undefined && sp.otWin !== undefined, "premise: the split division carries both").toBe(true);
    expect("shootoutWin" in (plain.config.points as object)).toBe(false);
    // Three direct calls beside the recorded division, one per arm of the "said out loud" check: today an ice hockey
    // shoot-out pays `otWin ?? win` / `otLoss ?? loss` (period/kernel.ts:1550), so a split that differs on the WIN side
    // only is said; one equal to the overtime values is not; and one with no overtime values compares with win/loss.
    const direct = {
      winSide: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1, shootoutWin: 3, shootoutLoss: 1 },
      equal: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1, shootoutWin: 2, shootoutLoss: 1 },
      noOvertime: { win: 3, draw: 1, loss: 0, shootoutWin: 3, shootoutLoss: 0 },
    } as const;
    const { value } = await rolledBack(async (tx, notices) => {
      await seeded(tx);
      await runSteps(tx);
      const configs = await divisionConfigs(tx);
      const rows = await stageRows(tx);
      const stepNotices = [...notices];
      await tx`reset role`;
      const calls: Record<string, { cfg: unknown; said: number }> = {};
      for (const [name, points] of Object.entries(direct)) {
        const before = notices.length;
        const [{ r }] = await tx<{ r: unknown }[]>`select w2d_drop_shootout_split('icehockey', ${tx.json({ points } as never)}) as r`;
        calls[name] = { cfg: r, said: notices.slice(before).filter((n) => n.includes("W2d shoot-out split (icehockey)")).length };
      }
      return { configs, rows, notices: stepNotices, calls };
    });
    for (const [name, points] of Object.entries(direct)) {
      expect(value.calls[name]!.cfg, `${name}: the split keys go`).toEqual({ points: withoutKeys(points, ["shootoutWin", "shootoutLoss"]) });
    }
    expect(Object.fromEntries(Object.entries(value.calls).map(([k, v]) => [k, v.said]))).toEqual({ winSide: 1, equal: 0, noOvertime: 0 });
    const got = value.configs.get(split.id)!;
    expect(got.points).toEqual(withoutKeys(sp, ["shootoutWin", "shootoutLoss"]));
    expect(withoutKeys(got, ["points"])).toEqual(withoutKeys(split.config, ["points"]));
    expect(head("icehockey").configSchema.safeParse(got).success).toBe(true);
    expect(value.configs.get(plain.id)).toEqual(plain.config);
    // the GWS split differed from the OT values (2/0 vs 2/1): converted, said, and the started stage keeps the split
    expect(value.notices.filter((n) => n.includes("W2d shoot-out split (icehockey)") && n.includes(`"otLoss": 1`))).toHaveLength(1);
    const stage = stageOf("icehockey-split");
    const pin = value.rows.find((r) => r.id === stage.stageId)!.pin as { points: { win: Record<string, number>; loss: Record<string, number> } };
    expect(pin.points.win).toEqual({ regulation: sp.win, ot: sp.otWin, so: sp.shootoutWin });
    expect(pin.points.loss).toEqual({ regulation: sp.loss, ot: sp.otLoss, so: sp.shootoutLoss });
  });

  it("PF-3 public_stages_v: table_points_rule is the pin's points for a pinned stage, points_rule stays the stage's OWN rule (V414)", async () => {
    // Two columns, two readers: `points_rule` is what the format line prints as the stage's own points (so a pinned stage
    // with no rule of its own prints none, as before W2d), `table_points_rule` is what the table is paid by (qualification
    // reads its bounds). The function and the view must agree on both: the console reads the function, the pages the view.
    const pinnedSport = stageOf("football-so");
    const pinnedOwn = stageOf("generic-legacy", "active");
    const pendingOwn = stageOf("generic-legacy", "pending");
    const pendingNone = stageOf("football-pending");
    const later = { win: { regulation: 9 }, loss: { regulation: 9 }, draw: 9, shootoutAs: "result", unit: "whole", bonuses: [] };
    type Rules = { points_rule: unknown; table_points_rule: unknown };
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      await runSteps(tx);
      // after the pin, the stage's own rule moves — the table keeps the pin's, the format line reads the new own rule
      await tx`update stages set config = jsonb_set(config, '{points}', ${tx.json(later as never)}) where id = ${pinnedOwn.stageId}`;
      const rows = await stageRows(tx);
      await tx`reset role`;
      const ids = [pinnedSport, pinnedOwn, pendingOwn, pendingNone].map((s) => s.stageId);
      const meta = new Map<string, Rules>();
      for (const id of ids) {
        meta.set(id, (await tx<Rules[]>`select points_rule, table_points_rule from stage_qualification_meta(${id})`)[0]!);
      }
      const view = new Map(
        (await tx<({ id: string } & Rules)[]>`select id, points_rule, table_points_rule from public_stages_v where id in ${tx(ids)}`).map(
          ({ id, ...r }) => [id, r],
        ),
      );
      return { rows, meta, view };
    });
    const pinOf = (s: W2dPinStage) => (value.rows.find((r) => r.id === s.stageId)!.pin as { points: unknown }).points;
    expect(value.view.size, "every stage is on the public view (a public competition)").toBe(4);
    expect(PointsRule.safeParse(later).success, "premise: the later own rule is one today's reader takes").toBe(true);
    let checked = 0;
    for (const [s, own, table] of [
      [pinnedSport, null, pinOf(pinnedSport)],
      [pinnedOwn, later, pinOf(pinnedOwn)],
      [pendingOwn, afterMigration(ownPoints(pendingOwn)), afterMigration(ownPoints(pendingOwn))],
      [pendingNone, null, null],
    ] as const) {
      const want = { points_rule: own, table_points_rule: table };
      expect(value.view.get(s.stageId), `${s.family} (${s.status}): the view`).toEqual(want);
      expect(value.meta.get(s.stageId), `${s.family} (${s.status}): the function`).toEqual(want);
      checked++;
    }
    expect(checked).toBe(4);
    expect(pinOf(pinnedOwn), "premise: the pin is not the stage's later rule").not.toEqual(later);
    expect(pinOf(pinnedSport), "premise: a pinned stage with no rule of its own has a pin").not.toBeNull();
  });

  it("PF-3 qualification reads the pin: a started Swiss badminton stage's bounds in force are the badminton module's for the cfg it was paid under, not a later edit", async () => {
    // Expected from the engine's own declaration (`matchPointsBounds` of the recorded division cfg), never a typed number.
    // The stage has no rule of its own, so only the pin can produce bounds here (the sport's bounds are passed as null),
    // and the division's points are edited after the pin, so a read of the live division would differ.
    const swiss = stageOf("badminton-swiss-a");
    expect(swiss.kind, "premise: a Swiss stage").toBe("swiss");
    expect(ownPoints(swiss), "premise: no rule of its own").toBeUndefined();
    const recorded = recordedDivision("badminton-swiss-a");
    const edited = { ...recorded.config, pointsMap: { "*": [5, 1] } };
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      await runSteps(tx);
      await tx`update divisions set config = ${tx.json(edited as never)} where id = ${recorded.id}`;
      await tx`reset role`;
      const [row] = await tx<Parameters<typeof stageQualMeta>[0][]>`select * from public_stages_v where id = ${swiss.stageId}`;
      return row;
    });
    expect(value, "the stage is on the public view").toBeDefined();
    const meta = stageQualMeta(value!);
    const declared = divisionPointsBounds(head("badminton"), recorded.config);
    expect(declared, "premise: the module declares bounds for the recorded cfg").not.toBeNull();
    expect(divisionPointsBounds(head("badminton"), edited), "premise: the edit moves the declared bounds").not.toEqual(declared);
    expect(meta.pointsRule, "the format line still prints no points for it").toBeNull();
    expect(boundsInForce(meta, null)).toEqual(declared);
  });

  it("a pin and its timestamp are both null or both set (check constraint)", async () => {
    const s = stageOf("football-pending");
    const { value } = await rolledBack(async (tx) => {
      await install(tx);
      await seedW2dPinScenario(tx);
      const out: string[] = [];
      out.push(await refusal(tx, "23514", (sp) => sp`update stages set table_rules_pinned = '{}'::jsonb where id = ${s.stageId}`));
      out.push(await refusal(tx, "23514", (sp) => sp`update stages set table_rules_pinned_at = now() where id = ${s.stageId}`));
      out.push(
        await refusal(tx, "23514", (sp) => sp`update stages set table_rules_pinned = 'null'::jsonb, table_rules_pinned_at = now() where id = ${s.stageId}`),
      );
      await tx`update stages set table_rules_pinned = '{}'::jsonb, table_rules_pinned_at = now() where id = ${s.stageId}`;
      await tx`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${s.stageId}`;
      return out;
    });
    expect(value).toHaveLength(3);
    expect(value[0]).toMatch(/stages_table_rules_pinned_pair/);
    expect(value[1]).toMatch(/stages_table_rules_pinned_pair/);
    expect(value[2]).toMatch(/stages_table_rules_pinned_object/);
  });

  it("w2d_pre_cascade is each sport's pre-W2d default list as a literal (the recorded declarations), and refuses a sport it does not know", async () => {
    const sports = Object.keys(W2D_PIN_BEFORE.declarations);
    const { value } = await rolledBack(async (tx) => {
      await install(tx);
      const lists = new Map<string, unknown>();
      for (const sport of sports) lists.set(sport, (await tx`select w2d_pre_cascade(${sport}) as r`)[0]!.r);
      const message = await refusal(tx, "22023", (sp) => sp`select w2d_pre_cascade('curling')`);
      return { lists, message };
    });
    let checked = 0;
    for (const sport of sports) {
      expect(value.lists.get(sport), sport).toEqual(W2D_PIN_BEFORE.declarations[sport]!.defaultTiebreakers);
      checked++;
    }
    expect(checked).toBe(11);
    expect(value.message).toMatch(/curling/);
  });

  it("w2d_pre_points fills an absent or empty table-points object exactly where the pre-W2d schema did, and refuses where it refused (recorded parses; counted)", async () => {
    const POINTS_KEYS = ["points", "pointsMap", "scoring"];
    const cases: { sport: string; absent: Record<string, unknown>; full: Record<string, unknown> }[] = [];
    const empties: { sport: string; key: string; cfg: Record<string, unknown>; parsed: unknown }[] = [];
    for (const [sport, decl] of Object.entries(W2D_PIN_BEFORE.declarations)) {
      expect(decl.defaultConfig, `premise: the pre-W2d ${sport} schema parsed its first variant`).not.toBeNull();
      cases.push({ sport, absent: withoutKeys(decl.defaultConfig!, POINTS_KEYS), full: decl.defaultConfig! });
      for (const [key, parsed] of Object.entries(decl.emptyPoints)) {
        empties.push({ sport, key, cfg: { ...withoutKeys(decl.defaultConfig!, POINTS_KEYS), [key]: {} }, parsed });
      }
    }
    const { value } = await rolledBack(async (tx) => {
      await install(tx);
      const one = async (sport: string, cfg: unknown) => (await tx`select w2d_pre_points(${sport}, ${tx.json(cfg as never)}) as r`)[0]!.r;
      const absent = [];
      for (const c of cases) absent.push({ got: await one(c.sport, c.absent), want: await one(c.sport, c.full) });
      const empty = [];
      for (const e of empties) {
        if (e.parsed === null) empty.push({ refused: await refusal(tx, "22023", (sp) => sp`select w2d_pre_points(${e.sport}, ${sp.json(e.cfg as never)})`) });
        else empty.push({ got: await one(e.sport, e.cfg), want: await one(e.sport, { ...e.cfg, [e.key]: e.parsed }) });
      }
      return { absent, empty };
    });
    let checked = 0;
    for (const [i, c] of cases.entries()) {
      expect(value.absent[i]!.got, `${c.sport}: absent ⇒ the schema's default`).toEqual(value.absent[i]!.want);
      checked++;
    }
    let refused = 0;
    for (const [i, e] of empties.entries()) {
      const got = value.empty[i]!;
      if (e.parsed === null) {
        expect("refused" in got && got.refused, `${e.sport}.${e.key}: {} refused`).toMatch(/W2d/);
        refused++;
      } else {
        expect("got" in got && got.got, `${e.sport}.${e.key}: {} ⇒ the per-key defaults`).toEqual("want" in got && got.want);
      }
      checked++;
    }
    expect(checked).toBe(cases.length + empties.length);
    expect(cases.length).toBe(11);
    expect(refused, "the period, generic, tennis and set sports refused an empty object").toBeGreaterThan(0);
    expect(empties.length - refused, "football, cricket, boardgame and carrom filled one per key").toBeGreaterThan(0);
  });

  it("w2d_pre_points pays a tie and a no-result what the pre-W2d module paid them (every recorded division; counted)", async () => {
    // No recorded table holds an abandoned match, so the tables above cannot see these two payouts; the pre-W2d
    // standingsDelta arms at W2D_BASE can. Football (football.ts:2791-2803), hockey and ice hockey (period/kernel.ts:
    // 2800-2810) and generic (generic.ts:767-777) pay a tie and a no-result the draw — an abandon under the `award`
    // policy is a reachable no-result there. Carrom pays a no-result the draw and has no tie arm (carrom.ts:1075-1100).
    // The board games pay a no-result 0 and have no tie arm (boardgame.ts:1046-1065). Tennis and the set sports rank
    // neither (an abandon leaves the outcome null, setbased/kernel.ts:2597). Cricket pays its OWN keys, `points.tie` and
    // `points.noResult` (cricket/cricket.ts:4005-4020) — its recorded tables pay them only in sums with win and loss (see
    // the witness map above), so they are asserted here per key, against the recorded division's values.
    const LEVEL: Record<string, "both-draw" | "no-result-draw" | "own-keys" | "none"> = {
      football: "both-draw", hockey: "both-draw", icehockey: "both-draw", generic: "both-draw",
      carrom: "no-result-draw", cricket: "own-keys",
      boardgame: "none", tennis: "none", volleyball: "none", badminton: "none", tabletennis: "none",
    };
    const sports = Object.keys(W2D_PIN_BEFORE.declarations);
    expect(sports.filter((s) => !(s in LEVEL)), "every recorded sport has a pre-W2d level-payout row").toEqual([]);
    const subjects = STARTED;
    const { value } = await rolledBack(async (tx) => {
      await install(tx);
      const out = [];
      for (const s of subjects) {
        out.push((await tx<{ r: Record<string, unknown> }[]>`select w2d_pre_points(${s.sport}, ${tx.json(s.divisionConfig as never)}) as r`)[0]!.r);
      }
      return out;
    });
    let checked = 0;
    for (const [i, s] of subjects.entries()) {
      const rule = value[i]!;
      const draw = rule.draw;
      if (LEVEL[s.sport] !== "none") expect(typeof draw, `${s.family}: the draw it pays is a number`).toBe("number");
      const own = (s.divisionConfig as { points?: { tie?: number; noResult?: number } }).points;
      const want =
        LEVEL[s.sport] === "both-draw" ? { tie: draw, noResult: draw }
        : LEVEL[s.sport] === "no-result-draw" ? { tie: 0, noResult: draw }
        : LEVEL[s.sport] === "own-keys" ? { tie: own?.tie, noResult: own?.noResult }
        : { tie: 0, noResult: 0 };
      if (LEVEL[s.sport] === "own-keys") expect([typeof own?.tie, typeof own?.noResult], `premise: ${s.family} sets both`).toEqual(["number", "number"]);
      expect({ tie: rule.tie, noResult: rule.noResult }, `${s.family} (${s.sport})`).toEqual(want);
      checked++;
    }
    expect(checked).toBe(subjects.length);
    expect(new Set(subjects.map((s) => s.sport)).size, "every sport").toBe(sports.length);
    expect(subjects.filter((s) => s.sport === "cricket").length, "the cricket divisions, whose tie and no-result differ").toBe(3);
  });

  it("w2d_pre_points takes a set map's clean-sweep pair from \"*\" even when jsonb sorts a key ahead of it (\"\" and \"!\"), else from the first entry", async () => {
    // W2D_BASE setbased/kernel.ts:2295-2296: `cfg.pointsMap["*"] ?? Object.values(cfg.pointsMap)[0]`. jsonb stores keys by
    // length then bytes, so "*" is the first entry unless an empty key or a one-character key below "*" exists: a junk
    // key that is no set score, left out of `bySetScore`, but still a pair the loop takes as the first entry.
    const maps = [
      { map: { "": [9, 9], "*": [3, 0], "2-0": [2, 1] }, sweep: [3, 0] },
      { map: { "!": [8, 8], "*": [3, 1] }, sweep: [3, 1] },
      { map: { "2-1": [2, 1], "2-0": [3, 0] }, sweep: null },
    ];
    const { value } = await rolledBack(async (tx) => {
      await install(tx);
      const out = [];
      for (const { map } of maps) {
        const cfg = { pointsMap: map };
        out.push({
          rule: (await tx<{ r: Record<string, unknown> }[]>`select w2d_pre_points('badminton', ${tx.json(cfg as never)}) as r`)[0]!.r,
          // the first entry as the stored map reads back (what the base kernel's Object.values saw from the DB)
          first: (await tx<{ v: [number, number] }[]>`select value as v from jsonb_each(${tx.json(map as never)}::jsonb) limit 1`)[0]!.v,
        });
      }
      return out;
    });
    let checked = 0;
    for (const [i, { map, sweep }] of maps.entries()) {
      const pair = sweep ?? value[i]!.first;
      expect(value[i]!.rule.win, JSON.stringify(map)).toEqual({ regulation: pair[0] });
      expect(value[i]!.rule.loss, JSON.stringify(map)).toEqual({ regulation: pair[1] });
      expect(value[i]!.rule.bySetScore).toEqual(withoutKeys(map, ["", "!"]));
      checked++;
    }
    expect(checked).toBe(maps.length);
    expect(value[0]!.first, "premise: jsonb sorts the empty key ahead of \"*\"").toEqual([9, 9]);
    expect(value[1]!.first, "premise: jsonb sorts \"!\" ahead of \"*\"").toEqual([8, 8]);
    expect(value[2]!.first, "premise: with no \"*\", the shorter-equal byte order decides").toEqual([3, 0]);
  });

  it("w2d_pre_points refuses what the pre-W2d code could not pay: a non-number, a JSON null, a config that is no object, an unknown sport, a set map that pays no set score", async () => {
    const bad: [string, unknown, RegExp][] = [
      ["football", { points: { win: "3", draw: 1, loss: 0 } }, /points\.win/],
      ["football", { points: { win: null, draw: 1, loss: 0 } }, /points\.win/],
      ["hockey", { points: { win: 3, draw: 1, loss: 0, shootoutWin: "2" } }, /shootoutWin/],
      ["generic", { points: [3, 1, 0] }, /points/],
      ["cricket", [], /config/],
      ["curling", { points: { win: 3 } }, /curling/],
      ["badminton", { pointsMap: { x: [2, 0] } }, /set score/],
      ["volleyball", { pointsMap: { "*": [3] } }, /pointsMap/],
      ["boardgame", { scoring: { win: 2, draw: 1, loss: true } }, /scoring\.loss/],
    ];
    const { value } = await rolledBack(async (tx) => {
      await install(tx);
      const out: string[] = [];
      for (const [sport, cfg] of bad) out.push(await refusal(tx, "22023", (sp) => sp`select w2d_pre_points(${sport}, ${sp.json(cfg as never)})`));
      return out;
    });
    let checked = 0;
    for (const [i, [sport, , msg]] of bad.entries()) {
      expect(value[i], sport).toMatch(msg);
      checked++;
    }
    expect(checked).toBe(bad.length);
  });

  it("the pin refuses a division tie-break list that is no list and a stage rule that is neither an object nor falsy; a falsy rule reads as none", async () => {
    const target = stageOf("generic-c");
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      const list = await refusal(tx, "22023", async (sp) => {
        await sp`update divisions set tiebreakers = '"points"'::jsonb where id = ${target.divisionId}`;
        await sp`select w2d_pin_started_stages()`;
      });
      const rule = await refusal(tx, "22023", async (sp) => {
        await sp`update stages set config = jsonb_set(config, '{points}', '[1]'::jsonb) where id = ${target.stageId}`;
        await sp`select w2d_pin_started_stages()`;
      });
      await tx`update stages set config = jsonb_set(config, '{points}', 'false'::jsonb) where id = ${target.stageId}`;
      await tx`select w2d_pin_started_stages()`;
      const [{ pin }] = await tx<{ pin: { points: unknown } }[]>`select table_rules_pinned as pin from stages where id = ${target.stageId}`;
      const [{ pre }] = await tx<{ pre: unknown }[]>`select w2d_pre_points('generic', config) as pre from divisions where id = ${target.divisionId}`;
      return { list, rule, pin, pre };
    });
    expect(value.list).toMatch(new RegExp(target.divisionId));
    expect(value.rule).toMatch(new RegExp(target.stageId));
    expect(value.pin.points).toEqual(value.pre);
  });

  it("the pin takes an own rule in the outcome-keyed shape as it stands, and refuses an object in neither shape (no base, no win/loss regulation)", async () => {
    // Unreachable in production data (W2c's parse required `base`), so a direct case per arm: the engine's reader is the
    // authority on which objects are a rule, and the pin agrees with it on every sample (counted).
    const target = stageOf("generic-c");
    const taken = { win: { regulation: 4, so: 2 }, loss: { regulation: 1 }, draw: 2, tie: 2, noResult: 2, shootoutAs: "result", unit: "whole", bonuses: [] };
    const refusedRules: unknown[] = [
      {},
      { junk: 1 },
      { win: { regulation: "3" }, loss: { regulation: 0 } },
      { win: { regulation: 3 } },
      { win: 3, loss: 0 },
      { win: { regulation: 3 }, loss: { so: 0 } },
    ];
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      const setOwn = (sp: Tx, rule: unknown) =>
        sp`update stages set config = jsonb_set(config, '{points}', ${sp.json(rule as never)}) where id = ${target.stageId}`;
      const messages: string[] = [];
      for (const rule of refusedRules) {
        messages.push(
          await refusal(tx, "22023", async (sp) => {
            await setOwn(sp, rule);
            await sp`select w2d_pin_started_stages()`;
          }),
        );
      }
      await setOwn(tx, taken);
      await tx`select w2d_pin_started_stages()`;
      const [{ pin }] = await tx<{ pin: { points: unknown } }[]>`select table_rules_pinned as pin from stages where id = ${target.stageId}`;
      return { messages, pin };
    });
    expect(parseStoredPointsRule(taken), "premise: today's reader takes the outcome-keyed sample").not.toBeNull();
    expect(value.pin.points).toEqual(taken);
    let checked = 0;
    for (const [i, rule] of refusedRules.entries()) {
      expect(parseStoredPointsRule(rule), `premise: today's reader refuses sample ${i}`).toBeNull();
      expect(value.messages[i], `sample ${i}`).toMatch(new RegExp(`stage ${target.stageId} has a points rule in neither shape`));
      checked++;
    }
    expect(checked).toBe(refusedRules.length);
  });

  it("the pin says so when a stage's scored fixtures were paid under another points config than the live division's (V347 snapshots), and a snapshot it cannot read is said, never fatal", async () => {
    const s = stageOf("generic-c");
    const { value } = await rolledBack(async (tx, notices) => {
      await seeded(tx);
      const [{ n: snapshotted }] = await tx<{ n: number }[]>`
        select count(*)::int as n from fixtures where stage_id = ${s.stageId} and jsonb_typeof(config_snapshot) = 'object'`;
      await tx`select w2d_pin_started_stages()`;
      const clean = notices.filter((n) => n.includes("W2d pin")).length;
      const unpin = () => tx`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${s.stageId}`;
      const oneSnapshot = (to: string) => tx`
        update fixtures set config_snapshot = jsonb_set(config_snapshot, '{points,w}', ${to}::jsonb)
        where id = (select id from fixtures where stage_id = ${s.stageId} and jsonb_typeof(config_snapshot) = 'object' order by id limit 1)`;
      await unpin();
      await oneSnapshot("5");
      const [{ n }] = await tx<{ n: number }[]>`select w2d_pin_started_stages() as n`;
      const drifted = notices.filter((x) => x.includes("W2d pin"));
      // a snapshot the pre-W2d payer refuses (22023): a diagnostic must not abort the deploy, so the stage is pinned and named
      await unpin();
      await oneSnapshot('"x"');
      const refused = await refusal(tx, "22023", (sp) => sp`
        select w2d_pre_points('generic', config_snapshot) from fixtures
        where stage_id = ${s.stageId} and jsonb_typeof(config_snapshot) = 'object'`);
      const before = notices.length;
      const [{ n: unreadable }] = await tx<{ n: number }[]>`select w2d_pin_started_stages() as n`;
      const [{ pinned }] = await tx<{ pinned: boolean }[]>`
        select table_rules_pinned is not null as pinned from stages where id = ${s.stageId}`;
      return { snapshotted, clean, n, drifted, refused, unreadable, pinned, said: notices.slice(before).filter((x) => x.includes("W2d pin")) };
    });
    expect(value.snapshotted, "premise: the stage's scored fixtures carry snapshots").toBeGreaterThan(0);
    expect(value.clean, "every recorded snapshot pays what the live division pays").toBe(0);
    expect(value.n).toBe(1);
    expect(value.drifted).toHaveLength(1);
    expect(value.drifted[0]).toContain(s.stageId);
    expect(value.refused, "premise: the pre-W2d payer refuses the snapshot").toMatch(/generic points\.w/);
    expect(value.unreadable, "the unreadable snapshot did not stop the pin").toBe(1);
    expect(value.pinned).toBe(true);
    expect(value.said).toHaveLength(1);
    expect(value.said[0]).toContain(s.stageId);
  });

  it("the data steps refuse to finish with a started stage left unpinned", async () => {
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      await tx`reset role`;
      await tx.unsafe(`create or replace function w2d_pin_started_stages() returns integer language sql as 'select 0'`);
      await asW2dPinTenant(tx);
      return refusal(tx, "P0001", (sp) => sp.unsafe(STEPS!.replace(PLACEHOLDER, SCHEMA)));
    });
    expect(value).toMatch(new RegExp(`W2d B1: ${STARTED.length} started stage\\(s\\) left unpinned`));
  });

  it("stage_lots_draws: one live draw per stage, pool and member set; a superseded one is history; the org comes from the stage; tenant-scoped; gone with its stage; the order is the members'", async () => {
    const s = stageOf("generic-c");
    const [a, b, c] = s.entrants.map((e) => e.id);
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      const insert = (sp: Tx, pool: string | null, members: string[], order: string[]) =>
        sp`insert into stage_lots_draws (stage_id, pool_id, members_key, members, drawn_order, seed)
           values (${s.stageId}, ${pool}, ${[...members].sort().join(",")}, ${members}::uuid[], ${order}::uuid[], 7001)
           returning org_id`;
      const [{ org_id }] = await insert(tx, null, [a!, b!], [b!, a!]);
      const dup = await refusal(tx, "23505", (sp) => insert(sp, null, [a!, b!], [a!, b!]));
      await tx`update stage_lots_draws set superseded_at = now() where stage_id = ${s.stageId}`;
      await insert(tx, null, [a!, b!], [a!, b!]);
      const pool = randomUUID();
      await insert(tx, pool, [a!, b!], [a!, b!]);
      const poolDup = await refusal(tx, "23505", (sp) => insert(sp, pool, [a!, b!], [b!, a!]));
      const notPerm = await refusal(tx, "23514", (sp) => insert(sp, null, [a!, c!], [a!, b!]));
      const single = await refusal(tx, "23514", (sp) => insert(sp, null, [c!], [c!]));
      // one case per clause of the order check: an order longer than its class, one missing a member, one naming an
      // entrant the class does not hold (each passes the other two clauses)
      const longer = await refusal(tx, "23514", (sp) => insert(sp, null, [a!, c!], [a!, c!, a!]));
      const missing = await refusal(tx, "23514", (sp) => insert(sp, null, [a!, c!], [a!, a!]));
      const stranger = await refusal(tx, "23514", (sp) => insert(sp, null, [a!, a!], [a!, c!]));
      const [{ n: mine }] = await tx<{ n: number }[]>`select count(*)::int as n from stage_lots_draws`;
      await tx`select set_config('app.current_org', ${randomUUID()}, true)`;
      const [{ n: theirs }] = await tx<{ n: number }[]>`select count(*)::int as n from stage_lots_draws`;
      // another tenant naming the scenario's org outright: the policy's check refuses it (its own org reads no stage, so the
      // trigger could not fill one in)
      const foreign = await refusal(
        tx,
        "42501",
        (sp) => sp`insert into stage_lots_draws (org_id, stage_id, members_key, members, drawn_order, seed)
                   values (${W2D_PIN_ORG_ID}, ${s.stageId}, 'x', ${[b!, c!]}::uuid[], ${[c!, b!]}::uuid[], 1)`,
      );
      await tx`reset role`;
      await tx`delete from stages where id = ${s.stageId}`;
      const [{ n: left }] = await tx<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${s.stageId}`;
      return { org_id, dup, poolDup, notPerm, single, longer, missing, stranger, mine, theirs, foreign, left };
    });
    expect(value.org_id).toBe(W2D_PIN_ORG_ID);
    expect(value.dup).toMatch(/stage_lots_draws_live_key/);
    expect(value.poolDup).toMatch(/stage_lots_draws_live_key/);
    expect(value.notPerm).toMatch(/stage_lots_draws_order_is_members/);
    expect(value.single).toMatch(/stage_lots_draws_order_is_members/);
    for (const k of ["longer", "missing", "stranger"] as const) expect(value[k], k).toMatch(/stage_lots_draws_order_is_members/);
    expect(value.mine, "the superseded draw, the live one, the pool's").toBe(3);
    expect(value.theirs).toBe(0);
    expect(value.foreign).toMatch(/row-level security/);
    expect(value.left).toBe(0);
  });

  // ═══ §13.8 (W2d Task 9): the B1 pin is what today's table reads ═══
  // Expected values are the recording's (`w2d-pin-before.json`: the tables a server built at W2D_BASE printed), never
  // today's code: every started stage, pinned by the delta's own steps, ranks under TODAY's fold (`rankedStageStandings`,
  // which reads the pin through `loadTableRules` and pays every fixture by it) into the very rows it held before W2d.
  const tableOf = (rows: readonly { entrantId: string; points: number; played: number; won: number; drawn: number; lost: number }[]) =>
    rows.map((r) => ({ entrantId: r.entrantId, points: r.points, played: r.played, won: r.won, drawn: r.drawn, lost: r.lost }));

  it("B1 a started stage's table is IDENTICAL before and after the migration, row by row (order, points, W/D/L), for every stage in w2d-pin-before.json (counted)", async () => {
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      await runSteps(tx);
      const out: { s: W2dPinStage; rows: Awaited<ReturnType<typeof rankedStageStandings>> }[] = [];
      for (const s of STARTED) out.push({ s, rows: await rankedStageStandings(tx, s.stageId) });
      return out;
    });
    let checked = 0;
    let rowsChecked = 0;
    for (const { s, rows } of value) {
      expect(s.table.length, `premise: ${s.family} (${s.status}) recorded a table`).toBeGreaterThan(0);
      // the recorded rows in the recorded order (rank 1 first)
      const recorded = [...s.table].sort((a, b) => a.rank - b.rank);
      expect(tableOf(rows), `${s.family} (${s.status}, ${s.sport} ${s.kind})`).toEqual(tableOf(recorded));
      checked++;
      rowsChecked += rows.length;
    }
    expect(checked).toBe(STARTED.length);
    expect(checked, "every started stage of the recording").toBeGreaterThan(20);
    expect(rowsChecked).toBeGreaterThan(100);
  });

  it("B1 positive pair: the scenario's football shoot-out stage, were it NOT pinned, DOES take W2d's new rule — each shoot-out-decided fixture is booked as a draw for both plus the SO bonus to its winner (Task 3, B2), so its rows differ from the recording's (PS-2b)", async () => {
    // The brief names the scenario's PENDING football stage; it holds no fixture (`football-pending`, 0 recorded), so the
    // pair is drawn on the started shoot-out stage itself: pinned it reads the recording (above); un-pinned and pending it
    // reads the live layers, which are W2d's. Expected from the recording plus B2's booking (spec §5.3: a draw-plus-bonus
    // shoot-out books a draw for both and pays the winner `draw + soBonus`; the converted division pays `soBonus =
    // shootoutWin − draw`), never from today's payout.
    const so = stageOf("football-so");
    const p = (so.divisionConfig as { points: Record<string, number> }).points;
    const soBonus = p.shootoutWin! - p.draw!;
    const shootouts = (so.fixtures as { status: string; outcome: { kind: string; method?: string; winner: string; loser: string } }[]).filter(
      (f) => f.status === "decided" && f.outcome?.kind === "win" && f.outcome.method === "shootout",
    );
    expect(shootouts.length, "premise: the stage holds shoot-out-decided fixtures").toBeGreaterThan(1);
    const { value } = await rolledBack(async (tx) => {
      await seeded(tx);
      await runSteps(tx);
      const pinned = await rankedStageStandings(tx, so.stageId);
      await tx`update stages set status = 'pending', table_rules_pinned = null, table_rules_pinned_at = null where id = ${so.stageId}`;
      const live = await rankedStageStandings(tx, so.stageId);
      return { pinned, live };
    });
    const want = new Map(so.table.map((r) => [r.entrantId, { ...r }]));
    for (const f of shootouts) {
      const w = want.get(f.outcome.winner)!;
      const l = want.get(f.outcome.loser)!;
      want.set(w.entrantId, { ...w, won: w.won - 1, drawn: w.drawn + 1, points: w.points - p.shootoutWin! + p.draw! + soBonus });
      want.set(l.entrantId, { ...l, lost: l.lost - 1, drawn: l.drawn + 1, points: l.points - p.shootoutLoss! + p.draw! });
    }
    const byId = <R extends { entrantId: string }>(rows: readonly R[]): R[] => [...rows].sort((a, b) => a.entrantId.localeCompare(b.entrantId));
    expect(tableOf(byId(value.pinned)), "pinned: the recording").toEqual(tableOf(byId(so.table)));
    expect(tableOf(byId(value.live)), "un-pinned: W2d's booking").toEqual(tableOf(byId([...want.values()])));
    expect(tableOf(byId(value.live)), "the pair differs").not.toEqual(tableOf(byId(so.table)));
  });
});
