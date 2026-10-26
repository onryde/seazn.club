// W2d Task 10 (spec §5.4 "Two moments", "Fixture override coverage", §5.5, §10, D1, D3, D8, D9; Review Focus 4; rule rows
// X-TB-2 (lock half), X-TB-5, X-PT-3, VB-PT-3) — a stage's OWN tie-break order and points, through `PUT /stages/{id}/rules`
// (`putStageRules`), and a match's own format through the fixture override (`writeFixtureRulesOverride`).
//
//   pending                   → an own order is validated (`validateCascade`) and stored at `config.tiebreakers`;
//   active, no score yet      → the same save is validated, stored, and RE-PINS only the field it saved (PS-5d);
//   after the first score     → STAGE_FORMAT_LOCKED, and a void does not unlock it (W2c's monotonic predicate, PF-9);
//   points, either moment     → `coverage(rule, reachableOutcomes(...))`: an outcome the rule does not pay is refused.
//
// Expected values come from the engine's declarations (`validateCascade`, `defaultTiebreakers`, `reachableOutcomes`,
// `coverage`, `primaryTableKey`, the sports' own presets) and the rules each test declares, never from the code under
// test. Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PointsRule, coverage, reachableOutcomes, validateCascade } from "@seazn/engine/competition";
import type { StageKind } from "@seazn/engine/core";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { loadTableRules } from "@/server/engine-db/table-rules";
import { genericResult } from "@/server/engine-db/__tests__/helpers/w2d-table-rig";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { startDivision } from "../schedule";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures, getStandings } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

interface Scene {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  entrants: string[];
}

/** An org on `plan`, one division of `sport`/`variant` (the variant's cfg over `config`), `entrants` entrants and ONE stage
 *  of `kind`, created and not generated. */
async function scene(opts: {
  sport: string;
  variant: string;
  kind?: StageKind;
  entrants?: number;
  config?: Record<string, unknown>;
  plan?: "pro" | "community";
}): Promise<Scene> {
  const { auth } = await seedOrg(opts.plan ?? "pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T10 " + suffix, visibility: "private", branding: {} });
  const config = opts.config ?? (opts.sport === "generic" ? GENERIC_CONFIG : {});
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open-" + suffix, sport_key: opts.sport, variant_key: opts.variant, config,
  });
  const kind = mod(opts.sport).entrantModel?.defaultKind ?? "individual";
  const created = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.entrants ?? 2 }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const stageKind = opts.kind ?? "league";
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: stageKind, name: "Pool A", config: stageKind === "swiss" ? { rounds: 2 } : {}, progression: null,
  });
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    entrants: [...created].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0)).map((e) => e.id),
  };
}

const stageConfig = async (stageId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config;
const divisionCfg = async (divisionId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`)[0]!.config;
const firstFixture = async (stageId: string): Promise<string> =>
  (await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null
     order by round_no, seq_in_round limit 1`)[0]!.id;

/** A valid league order of generic's (an engine declaration: its primary first, `lots` last), and the one the tests
 *  save over it: `for` before `diff`, the sport's own order reversed in the middle. */
const generic = mod("generic");
const GENERIC_DEFAULT = generic.defaultTiebreakers("league", generic.configSchema.parse(GENERIC_CONFIG));
const OWN_ORDER: TiebreakerKey[] = ["points", "for", "diff", "lots"];
const DIV_ORDER: TiebreakerKey[] = ["points", "diff", "lots"];
const ctxOf = (m: AnySportModule, cfg: unknown, stageKind: StageKind = "league") => ({ module: m, cfg, stageKind, crossGroup: false });

/** A rule that pays every outcome generic reaches (win, loss, draw). */
const RULE: PointsRule = { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] };

describe.skipIf(!HAS_DB)("W2d T10 a stage's own order and points: validated, re-pinned before the first score, locked after", () => {
  it("premise: the orders the tests save are valid generic league orders, and differ from the sport's own", () => {
    const cfg = generic.configSchema.parse(GENERIC_CONFIG);
    expect(validateCascade(OWN_ORDER, ctxOf(generic, cfg))).toEqual([]);
    expect(validateCascade(DIV_ORDER, ctxOf(generic, cfg))).toEqual([]);
    expect(OWN_ORDER).not.toEqual(GENERIC_DEFAULT);
    expect(DIV_ORDER).not.toEqual(GENERIC_DEFAULT);
  });

  it("X-TB-5 an own order with nrr on a football stage is refused 422 TIEBREAK_KEY_INVALID with refusals [{index, key:'nrr', reason:'sport'}]", async () => {
    const s = await scene({ sport: "football", variant: "11-a-side" });
    const football = mod("football");
    const order: TiebreakerKey[] = [football.primaryTableKey, "nrr", "lots"];
    // The expected refusal is the engine's own answer for this order on this sport.
    const want = validateCascade(order, ctxOf(football, football.configSchema.parse(await divisionCfg(s.divisionId))));
    expect(want, "premise: the engine refuses exactly nrr, for the sport").toEqual([expect.objectContaining({ index: 1, key: "nrr", reason: "sport" })]);
    await expect(putStageRules(s.auth, s.stageId, { tiebreakers: order })).rejects.toMatchObject({
      status: 422,
      code: "TIEBREAK_KEY_INVALID",
      extra: { refusals: want },
    });
    expect(Object.hasOwn(await stageConfig(s.stageId), "tiebreakers"), "nothing stored").toBe(false);
    // The positive pair, same sport and stage: its own default order (Task 11: every default passes) is stored.
    const fine = football.defaultTiebreakers("league", football.configSchema.parse(await divisionCfg(s.divisionId)));
    await putStageRules(s.auth, s.stageId, { tiebreakers: [...fine] });
    expect((await stageConfig(s.stageId)).tiebreakers).toEqual(fine);
  });

  it("Review Focus 4: tiebreakers [] is refused (reason 'empty'); null inherits (sources.tiebreakers 'division' or 'sport')", async () => {
    const s = await scene({ sport: "generic", variant: "score" });
    await expect(putStageRules(s.auth, s.stageId, { tiebreakers: [] })).rejects.toMatchObject({
      status: 422,
      code: "TIEBREAK_KEY_INVALID",
      extra: { refusals: [{ index: -1, key: null, reason: "empty" }] },
    });
    expect(Object.hasOwn(await stageConfig(s.stageId), "tiebreakers"), "the empty order stored nothing").toBe(false);
    // An own order, then null: the key goes, and the stage reads the layer below — the sport's (no division order) ...
    await putStageRules(s.auth, s.stageId, { tiebreakers: OWN_ORDER });
    expect((await loadTableRules(sql, s.stageId)).sources.tiebreakers).toBe("stage");
    await putStageRules(s.auth, s.stageId, { tiebreakers: null });
    expect(Object.hasOwn(await stageConfig(s.stageId), "tiebreakers"), "null removes the key").toBe(false);
    const sport = await loadTableRules(sql, s.stageId);
    expect(sport.sources.tiebreakers).toBe("sport");
    expect(sport.tiebreakers).toEqual(GENERIC_DEFAULT);
    // ... and the division's, once it has one.
    await patchDivision(s.auth, s.divisionId, { tiebreakers: DIV_ORDER });
    const division = await loadTableRules(sql, s.stageId);
    expect(division.sources.tiebreakers).toBe("division");
    expect(division.tiebreakers).toEqual(DIV_ORDER);
    // A second null on a stage with none is a no-op, never a refusal.
    await expect(putStageRules(s.auth, s.stageId, { tiebreakers: null })).resolves.toBeDefined();
    expect(Object.hasOwn(await stageConfig(s.stageId), "tiebreakers"), "still none").toBe(false);
  });

  it("X-TB-2 between activation and the first score an own save is accepted and re-pins (sources 'stage')", async () => {
    const s = await scene({ sport: "generic", variant: "score" });
    await generateStageFixtures(s.auth, s.stageId);
    const pinned = await loadTableRules(sql, s.stageId);
    expect(pinned.pinnedAt, "premise: generating pinned the stage").not.toBeNull();
    expect(pinned.tiebreakers, "premise: pinned to the sport's order").toEqual(GENERIC_DEFAULT);
    await putStageRules(s.auth, s.stageId, { tiebreakers: OWN_ORDER });
    const repinned = await loadTableRules(sql, s.stageId);
    expect(repinned.tiebreakers).toEqual(OWN_ORDER);
    expect(repinned.sources.tiebreakers).toBe("stage");
    expect(repinned.pinnedAt, "the pin's date is kept").toBe(pinned.pinnedAt);
    expect(repinned.points, "the points it did not save are the pin's").toEqual(pinned.points);
    // A second save (points this time) re-pins again; the saved order stays.
    await putStageRules(s.auth, s.stageId, { points: RULE });
    const twice = await loadTableRules(sql, s.stageId);
    expect(twice.points).toEqual(RULE);
    expect(twice.sources.points).toBe("stage");
    expect(twice.tiebreakers).toEqual(OWN_ORDER);
  });

  it("PS-5d an own points save after activation re-pins ONLY points: a division default order edited after activation does not ride in — the pinned tiebreakers and their source are unchanged", async () => {
    const s = await scene({ sport: "generic", variant: "score" });
    await generateStageFixtures(s.auth, s.stageId);
    const pinned = await loadTableRules(sql, s.stageId);
    const div = await patchDivision(s.auth, s.divisionId, { tiebreakers: DIV_ORDER });
    expect(div.tiebreakers, "premise: the division order landed").toEqual(DIV_ORDER);
    await putStageRules(s.auth, s.stageId, { points: RULE });
    const after = await loadTableRules(sql, s.stageId);
    expect(after.points).toEqual(RULE);
    expect(after.sources.points).toBe("stage");
    expect(after.tiebreakers, "the division's new order did not ride in").toEqual(pinned.tiebreakers);
    expect(after.tiebreakers).not.toEqual(DIV_ORDER);
    expect(after.sources.tiebreakers).toBe(pinned.sources.tiebreakers);
  });

  it("X-TB-2 after the first score an own tiebreakers or points save is 409 STAGE_FORMAT_LOCKED; a void of that score does not unlock (monotonic)", async () => {
    const s = await scene({ sport: "generic", variant: "score" });
    await generateStageFixtures(s.auth, s.stageId);
    const f = await firstFixture(s.stageId);
    const started = await appendEvent(s.auth.orgId, f, 0, { type: "core.start", payload: {} });
    const locked = { status: 409, code: "STAGE_FORMAT_LOCKED", extra: { stage_name: "Pool A" } };
    await expect(putStageRules(s.auth, s.stageId, { tiebreakers: OWN_ORDER })).rejects.toMatchObject(locked);
    await expect(putStageRules(s.auth, s.stageId, { points: RULE })).rejects.toMatchObject(locked);
    await expect(putStageRules(s.auth, s.stageId, { tiebreakers: null }), "a clear is a change too").rejects.toMatchObject(locked);
    const v = await appendEvent(s.auth.orgId, f, 1, { type: "core.void", payload: {}, voids: started.event.id });
    expect(v.event.voids, "premise: the void landed").toBe(started.event.id);
    const [{ status }] = await sql<{ status: string }[]>`select status from fixtures where id = ${f}`;
    expect(status, "premise: the void moved the match back off in-play").not.toBe("in_play");
    await expect(putStageRules(s.auth, s.stageId, { tiebreakers: OWN_ORDER })).rejects.toMatchObject(locked);
    await expect(putStageRules(s.auth, s.stageId, { points: RULE })).rejects.toMatchObject(locked);
    const pin = await loadTableRules(sql, s.stageId);
    expect(pin.tiebreakers, "nothing re-pinned").toEqual(GENERIC_DEFAULT);
    expect(Object.hasOwn(await stageConfig(s.stageId), "tiebreakers")).toBe(false);
  });

  it("PF-9 / PS-6 an online (Lichess) division stage with an opened round and NO score refuses own tiebreakers and points 409 STAGE_FORMAT_LOCKED (W2c's lockedStageIdsAmong); the same stage before the round opens accepts them", async () => {
    const s = await scene({ sport: "boardgame", variant: "classical", entrants: 2 });
    // Online play is the division's (its clock and family): set on the row, as the Lichess door stores it.
    await sql`update divisions set config = config || ${sql.json({ onlinePlay: "lichess" } as never)} where id = ${s.divisionId}`;
    await generateStageFixtures(s.auth, s.stageId);
    const chess = mod("boardgame");
    const order = [...chess.defaultTiebreakers("league", chess.configSchema.parse(await divisionCfg(s.divisionId)))];
    const rule: PointsRule = { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [] };
    // Before the round opens: accepted, both.
    await putStageRules(s.auth, s.stageId, { tiebreakers: order, points: rule });
    expect((await loadTableRules(sql, s.stageId)).sources).toMatchObject({ tiebreakers: "stage", points: "stage" });
    // The round opens; nothing is played or scored.
    const [{ user_id }] = await sql<{ user_id: string }[]>`select user_id from org_members where org_id = ${s.auth.orgId} limit 1`;
    await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_by) values (${s.stageId}, ${s.auth.orgId}, 1, ${user_id})`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events e join fixtures f on f.id = e.fixture_id where f.stage_id = ${s.stageId}`;
    expect(n, "premise: no score").toBe(0);
    const locked = { status: 409, code: "STAGE_FORMAT_LOCKED" };
    await expect(putStageRules(s.auth, s.stageId, { tiebreakers: null })).rejects.toMatchObject(locked);
    await expect(putStageRules(s.auth, s.stageId, { points: null })).rejects.toMatchObject(locked);
  });

  it("X-PT-3 a football group stage with shootout on and an own rule with no draw is refused POINTS_OUTCOME_UNCOVERED ['draw']", async () => {
    const s = await scene({ sport: "football", variant: "11-a-side", kind: "group", entrants: 4, config: { shootout: true } });
    const football = mod("football");
    const noDraw: PointsRule = { win: { regulation: 3 }, loss: { regulation: 0 }, soBonus: 1, shootoutAs: "draw_plus_bonus", unit: "whole", bonuses: [] };
    const reach = reachableOutcomes(football, await divisionCfg(s.divisionId), "group");
    expect(reach.has("win.so"), "premise: a group shoot-out is reachable").toBe(true);
    const want = coverage(noDraw, reach);
    expect(want, "premise: the engine names draw, once").toEqual({ ok: false, uncovered: ["draw"], inapplicable: [] });
    await expect(putStageRules(s.auth, s.stageId, { points: noDraw })).rejects.toMatchObject({
      status: 422,
      code: "POINTS_OUTCOME_UNCOVERED",
      extra: { uncovered: ["draw"] },
    });
    expect(Object.hasOwn(await stageConfig(s.stageId), "points"), "nothing stored").toBe(false);
    // The positive pair: the same rule paying a draw is covered and stored.
    const withDraw = { ...noDraw, draw: 1 };
    expect(coverage(withDraw, reach)).toEqual({ ok: true });
    await putStageRules(s.auth, s.stageId, { points: withDraw });
    expect((await stageConfig(s.stageId)).points).toMatchObject({ draw: 1, soBonus: 1 });
  });

  it("X-PT-3 VB-PT-3 a best-of-3 fixture override on a FIVB best-of-5 stage is refused naming set:2-0 and set:2-1", async () => {
    const s = await scene({ sport: "volleyball", variant: "indoor", entrants: 2 });
    const vb = mod("volleyball");
    await generateStageFixtures(s.auth, s.stageId);
    const pin = await loadTableRules(sql, s.stageId);
    expect(pin.pinnedAt, "premise: the stage is pinned").not.toBeNull();
    const bo3 = { ...vb.configSchema.parse(await divisionCfg(s.divisionId)), bestOf: 3 };
    const want = coverage(pin.points, reachableOutcomes(vb, bo3, "league"));
    expect(want, "premise: the pinned FIVB best-of-5 rule does not pay a best-of-3 score").toEqual({
      ok: false, uncovered: ["set:2-0", "set:2-1"], inapplicable: [],
    });
    const f = await firstFixture(s.stageId);
    await expect(writeFixtureRulesOverride(s.auth, [f], { bestOf: 3 })).rejects.toMatchObject({
      status: 422,
      code: "POINTS_OUTCOME_UNCOVERED",
      extra: { uncovered: ["set:2-0", "set:2-1"] },
    });
    const [{ rules_override }] = await sql<{ rules_override: unknown }[]>`select rules_override from fixtures where id = ${f}`;
    expect(rules_override, "nothing stored").toBeNull();
  });

  it("VB-PT-3 order: a best-of-3 correction the recorded play cannot take (2-0 up in a best-of-5 would END the match) keeps its own 409 FORMAT_DOES_NOT_FIT_PLAY — coverage is asked after the fit", async () => {
    const s = await scene({ sport: "volleyball", variant: "indoor", entrants: 2 });
    const vb = mod("volleyball");
    await generateStageFixtures(s.auth, s.stageId);
    const f = await firstFixture(s.stageId);
    const [{ home }] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${f}`;
    const cfg = vb.configSchema.parse(await divisionCfg(s.divisionId)) as { setTo: number; bestOf: number };
    expect(cfg.bestOf, "premise: indoor is a best-of-5").toBe(5);
    let seq = 0;
    await appendEvent(s.auth.orgId, f, seq++, { type: "core.start", payload: {} });
    for (let set = 0; set < 2; set++) {
      for (let i = 0; i < cfg.setTo; i++) await appendEvent(s.auth.orgId, f, seq++, { type: "volleyball.rally", payload: { wonBy: home } });
    }
    const pin = await loadTableRules(sql, s.stageId);
    expect(coverage(pin.points, reachableOutcomes(vb, { ...cfg, bestOf: 3 }, "league")).ok, "premise: the correction is uncovered as well").toBe(false);
    const before = (await sql<{ v: number }[]>`select rules_version as v from fixtures where id = ${f}`)[0]!.v;
    await expect(writeFixtureRulesOverride(s.auth, [f], { bestOf: 3 })).rejects.toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY" });
    expect((await sql<{ v: number }[]>`select rules_version as v from fixtures where id = ${f}`)[0]!.v, "nothing moved").toBe(before);
  });

  it("a bracket stage is never asked coverage (it has no table to pay): the same best-of-3 override and a best-of-3 stage rules save on a FIVB knockout land", async () => {
    const s = await scene({ sport: "volleyball", variant: "indoor", kind: "knockout", entrants: 2 });
    const vb = mod("volleyball");
    const bo3 = { ...vb.configSchema.parse(await divisionCfg(s.divisionId)), bestOf: 3 };
    // The counterfactual the league case above refuses: asked on a table, the division's FIVB map leaves these unpaid.
    const fivb = PointsRule.parse(vb.tablePointsRule(vb.configSchema.parse(await divisionCfg(s.divisionId)), "league"));
    const asLeague = coverage(fivb, reachableOutcomes(vb, bo3, "league"));
    expect(asLeague.ok, "premise: on a table stage the FIVB rule does not pay a best-of-3 score").toBe(false);
    await putStageRules(s.auth, s.stageId, { rules: { bestOf: 3 } });
    expect(((await stageConfig(s.stageId)).rules as { bestOf?: number }).bestOf, "the stage rules save landed").toBe(3);
    await putStageRules(s.auth, s.stageId, { rules: null });
    await generateStageFixtures(s.auth, s.stageId);
    const f = await firstFixture(s.stageId);
    const out = await writeFixtureRulesOverride(s.auth, [f], { bestOf: 3 });
    expect(out.fixtures.map((x) => x.id), "the override landed").toEqual([f]);
  });

  it("an override that only removes outcomes (football extra time off) is accepted", async () => {
    const s = await scene({ sport: "football", variant: "11-a-side", kind: "knockout", entrants: 2 });
    const football = mod("football");
    await generateStageFixtures(s.auth, s.stageId);
    const f = await firstFixture(s.stageId);
    const [{ config }] = await sql<{ config: Record<string, unknown> }[]>`select config -> 'rules' as config from stages where id = ${s.stageId}`;
    const stageCfg = { ...football.configSchema.parse(await divisionCfg(s.divisionId)), ...(config ?? {}) };
    const before = reachableOutcomes(football, stageCfg, "knockout");
    const after = reachableOutcomes(football, { ...stageCfg, extraTime: { enabled: false, halfMinutes: 15 } }, "knockout");
    expect(before.has("win.ot"), "premise: the knockout preset plays extra time").toBe(true);
    expect(after.has("win.ot"), "premise: the override removes the overtime outcomes").toBe(false);
    expect([...after].every((o) => before.has(o)), "premise: it adds none").toBe(true);
    const out = await writeFixtureRulesOverride(s.auth, [f], { extraTime: { enabled: false, halfMinutes: 15 } });
    expect(out.fixtures.map((x) => x.id)).toEqual([f]);
    const [{ rules_override }] = await sql<{ rules_override: unknown }[]>`select rules_override from fixtures where id = ${f}`;
    expect(rules_override).toMatchObject({ extraTime: { enabled: false } });
  });

  it("a Community org saves an own order, a split points rule, bonuses and a forfeit row, and its table pays them (D1; behaviour only)", async () => {
    const s = await scene({ sport: "generic", variant: "score", plan: "community", entrants: 2 });
    await generateStageFixtures(s.auth, s.stageId);
    const rule: PointsRule = {
      win: { regulation: 3, ot: 2 },
      loss: { regulation: 0, ot: 1 },
      draw: 1,
      shootoutAs: "result",
      unit: "whole",
      bonuses: [{ when: "win_margin_gte", param: 3, points: 1 }],
      forfeit: { winnerPoints: 3, loserPoints: 0 },
    };
    const out = await putStageRules(s.auth, s.stageId, { tiebreakers: OWN_ORDER, points: rule });
    expect((await stageConfig(s.stageId)).tiebreakers, "stored").toEqual(OWN_ORDER);
    expect(out.points).toMatchObject({ win: { ot: 2 }, bonuses: [{ when: "win_margin_gte" }], forfeit: { winnerPoints: 3 } });
    const pinned = await loadTableRules(sql, s.stageId);
    expect(pinned.points).toEqual(rule);
    expect(pinned.tiebreakers).toEqual(OWN_ORDER);
    // The table pays the rule: a 5-1 win is the base 3 plus the margin bonus 1; the loss pays 0.
    const [e1, e2] = s.entrants as [string, string];
    await startDivision(s.auth, s.divisionId);
    await genericResult(s.auth, s.stageId, e1, e2, 5, 1);
    const rows = (await getStandings(s.auth, s.stageId)).rows as { entrantId: string; points: number }[];
    expect(rows.find((r) => r.entrantId === e1)?.points).toBe(rule.win.regulation + rule.bonuses[0]!.points);
    expect(rows.find((r) => r.entrantId === e2)?.points).toBe(rule.loss.regulation);
  });
});
