// W2d Task 9 (spec §5.4 "Pin at start", OC2, anti-goal 1, Review Focus 1 and 5; rule rows X-TB-1, X-TB-2) — a stage's
// table rules are fixed in the transaction that starts it, and nothing upstream reaches them afterwards: not the
// division's points, not its default order, not the sport's default. A pending stage reads the live layers. A started
// stage with no pin is refused, typed, never read live.
//
// Real Postgres, every door a use-case (create, generate, start, score, complete). Expected values come from the inputs
// the test declares (`GENERIC_CONFIG`, the orders it writes) and the engine's own declarations (`defaultTiebreakers`,
// `tablePointsRule`), never from the loader under test. Every "does not reach it" case carries its counterfactual: the
// same edit on the same stage un-pinned DOES move the table, so a pin that pins nothing reds.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { PointsRule, defaultCrossGroup, resolveTableRules } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { CreateStages } from "@/server/api-v1/schemas";
import { ENGINE_HTTP, v1 } from "@/server/api-v1/http";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { addFixture, completeStage, generateStageFixtures, issueChallenge, rebuildStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedFootballCatalog } from "@/server/usecases/__tests__/_seed";
import { recomputeStandings } from "../competition";
import { loadTableRules, pinStageTableRules, repinStageOwnRules, tableRulesOf } from "../table-rules";
import { between, genericResult, seatedFixtures, stageRules, tableRulesRowOf, tableScene, unpin } from "./helpers/w2d-table-rig";
import { post } from "./helpers/w2b-rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};
const generic = moduleOf("generic");

/** generic's default order (an engine declaration) and the order the tests write over it: `for` before `diff`. Two
 *  entrants level on points, one with the better difference and the other with more scored, rank one way under the
 *  first and the other way under the second — the witness every order case below reads. */
const SPORT_ORDER = generic.defaultTiebreakers("league", generic.configSchema.parse(GENERIC_CONFIG));
const FOR_FIRST = ["points", "for", "diff", "lots"];

/** The pin a generic league takes from the live layers, as the ENGINE's one resolver answers them (T8's, not this
 *  task's loader): the sport's rule and order under the division's cfg. */
function sportPin(divisionConfig: unknown) {
  return resolveTableRules({
    module: generic,
    stageKind: "league",
    mergedCfg: divisionConfig,
    stageOwn: { points: null, tiebreakers: null, crossGroup: null },
    divisionTiebreakers: null,
    pinned: null,
  });
}

const ranking = (rows: readonly { entrantId: string }[]) => rows.map((r) => r.entrantId);
const pointsOf = (rows: readonly { entrantId: string; points: number }[], id: string) => rows.find((r) => r.entrantId === id)?.points;

describe.skipIf(!HAS_DB)("W2d T9: the pin at activation (X-TB-2, OC2)", () => {
  it("X-TB-2 generating a stage's fixtures (generateStageFixturesWrite) pins it in the same transaction", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    const before = await stageRules(stageId);
    expect(before, "premise: a created stage is pending and unpinned").toMatchObject({ status: "pending", pin: null, pinned_at: null });
    const live = await loadTableRules(sql, stageId);
    expect(live.pinnedAt, "a pending stage reads live").toBeNull();

    const out = await generateStageFixtures(s.auth, stageId);
    expect(out.created, "premise: four entrants, one round robin").toBe(6);
    const after = await stageRules(stageId);
    expect(after.status).toBe("active");
    const [division] = await sql<{ config: unknown }[]>`select config from divisions where id = ${s.divisionId}`;
    const want = sportPin(division!.config);
    expect(after.pin, "the live layers at activation, as the engine resolves them").toEqual({ ...want });
    // the human reading of the same values, from the declared inputs: generic pays `points.w` a win, ranks by its default
    expect((after.pin as { points: PointsRule }).points.win.regulation).toBe(GENERIC_CONFIG.points.w);
    expect((after.pin as { tiebreakers: string[] }).tiebreakers).toEqual(SPORT_ORDER);
    expect((after.pin as { sources: unknown }).sources).toEqual({ points: "sport", tiebreakers: "sport", crossGroup: "derived" });
    // Same transaction: Postgres' now() is the transaction's start, so the pin's date IS the generated fixtures' date.
    const created = await sql<{ at: string }[]>`select distinct to_json(created_at) #>> '{}' as at from fixtures where stage_id = ${stageId}`;
    expect(created.map((r) => r.at), "the fixtures and the pin were written by one transaction").toEqual([after.pinned_at]);
    // and the loader now serves the pin
    const pinned = await loadTableRules(sql, stageId);
    expect(pinned.pinnedAt).toBe(after.pinned_at);
    expect({ points: pinned.points, tiebreakers: pinned.tiebreakers, crossGroup: pinned.crossGroup, sources: pinned.sources }).toEqual(after.pin);
  }, 120_000);

  it("X-TB-2 the progression setup path (generateProgressionSetupFixtures) pins it too", async () => {
    // The REAL "League + Finals" template: a knockout fed by the league's top two at setup timing, generated first.
    const drafts = buildTemplateStages("league_ko", { qualified: 2, swissRounds: 5, poolCount: 2, legs: 1 }).map((d, i) => ({ ...d, seq: i + 1 }));
    const s = await tableScene({ stages: drafts as CreateStages });
    const [leagueId, koId] = s.stageIds as [string, string];
    const [ko] = await sql<{ progression: { timing?: string } | null }[]>`select progression from stages where id = ${koId}`;
    expect(ko!.progression?.timing, "premise: the knockout is a setup-timing progression").toBe("setup");
    expect((await stageRules(koId)).pin).toBeNull();

    const out = await generateStageFixtures(s.auth, koId);
    expect(out.created, "premise: the setup path generated the final").toBe(1);
    const after = await stageRules(koId);
    expect(after.status).toBe("active");
    expect(after.pin, "the setup path pins the stage it starts").not.toBeNull();
    const [division] = await sql<{ config: unknown }[]>`select config from divisions where id = ${s.divisionId}`;
    expect(after.pin).toEqual({ ...sportPin(division!.config) });
    const created = await sql<{ at: string }[]>`select distinct to_json(created_at) #>> '{}' as at from fixtures where stage_id = ${koId}`;
    expect(created.map((r) => r.at), "one transaction").toEqual([after.pinned_at]);
    // the league it draws from was not started, and is not pinned
    expect(await stageRules(leagueId)).toMatchObject({ status: "pending", pin: null });
  }, 120_000);

  it("X-TB-2 OC2 a pending stage reads live layers; after activation a division tiebreakers edit does not reach it", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    const [A, B, C, D] = s.entrants as [string, string, string, string];

    // Pending: the division's order reaches the stage (T8 m9: the web's `divisionTiebreakers` line), and leaving it
    // reaches it too.
    await sql`update divisions set tiebreakers = ${sql.json(FOR_FIRST)} where id = ${s.divisionId}`;
    const withDivision = await loadTableRules(sql, stageId);
    expect(withDivision.tiebreakers, "pending: the division's order").toEqual(FOR_FIRST);
    expect(withDivision.sources.tiebreakers).toBe("division");
    await sql`update divisions set tiebreakers = null where id = ${s.divisionId}`;
    const withSport = await loadTableRules(sql, stageId);
    expect(withSport.tiebreakers, "pending: back to the sport's order").toEqual(SPORT_ORDER);
    expect(withSport.sources.tiebreakers).toBe("sport");

    await generateStageFixtures(s.auth, stageId);
    await startDivision(s.auth, s.divisionId);
    const pinnedAt = (await stageRules(stageId)).pinned_at;
    expect(pinnedAt).not.toBeNull();

    // Active: the same division edit does not reach it.
    await sql`update divisions set tiebreakers = ${sql.json(FOR_FIRST)} where id = ${s.divisionId}`;
    const active = await loadTableRules(sql, stageId);
    expect(active.tiebreakers, "active: the pinned order").toEqual(SPORT_ORDER);
    expect(active.sources.tiebreakers).toBe("sport");
    expect(active.pinnedAt, "the pin is the first one").toBe(pinnedAt);

    // The table: A and B level on points; A has the better difference (+5 against +2), B scored more (6 against 5).
    await genericResult(s.auth, stageId, A, C, 5, 0);
    await genericResult(s.auth, stageId, B, D, 6, 4);
    const rows = await recomputeStandings(s.auth.orgId, stageId);
    expect(ranking(rows).slice(0, 2), "pinned: difference before scored (the sport's order)").toEqual([A, B]);
    // Counterfactual: the same stage, un-pinned, reads the division's order and ranks the other way.
    await unpin(stageId);
    const live = await recomputeStandings(s.auth.orgId, stageId);
    expect(ranking(live).slice(0, 2), "un-pinned: the division's order reaches it").toEqual([B, A]);
  }, 180_000);

  it("anti-goal 1: after activation, editing the division cfg points, the division default order, or the sport default (simulated by a module stub) changes none of the stage's rows", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    const [A, B, C, D] = s.entrants as [string, string, string, string];
    await generateStageFixtures(s.auth, stageId);
    await startDivision(s.auth, s.divisionId);
    const pin = await loadTableRules(sql, stageId);
    const WIN_EDITED = GENERIC_CONFIG.points.w + 2;

    // 1. the division's points, edited after activation and BEFORE the first score (V347 freezes the cfg each fixture is
    //    first scored under, so an edit after scoring would be held by the snapshot, not the pin)
    await sql`update divisions set config = jsonb_set(config, '{points,w}', ${sql.json(WIN_EDITED)}) where id = ${s.divisionId}`;
    await genericResult(s.auth, stageId, A, C, 5, 0);
    await genericResult(s.auth, stageId, B, D, 6, 4);
    const rows0 = await recomputeStandings(s.auth.orgId, stageId);
    expect(pointsOf(rows0, A), "a win pays the pinned points").toBe(GENERIC_CONFIG.points.w);
    expect(ranking(rows0).slice(0, 2)).toEqual([A, B]);

    // 2. the division's default order
    await sql`update divisions set tiebreakers = ${sql.json(FOR_FIRST)} where id = ${s.divisionId}`;
    const rows1 = await recomputeStandings(s.auth.orgId, stageId);
    expect(rows1, "the division's order changes none of the rows").toEqual(rows0);

    // 3. the sport's default, simulated by a module whose layers answer otherwise (the loader's one function; the
    //    standings read resolves its module from the registry, which a test does not swap)
    const STUB_RULE = PointsRule.parse({ win: { regulation: 7 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole" });
    const stub = { ...generic, defaultTiebreakers: () => [...FOR_FIRST], tablePointsRule: () => STUB_RULE } as unknown as AnySportModule;
    const row = await tableRulesRowOf(stageId);
    const underStub = tableRulesOf(row, stub);
    expect(
      { points: underStub.points, tiebreakers: underStub.tiebreakers, crossGroup: underStub.crossGroup, sources: underStub.sources },
      "a changed sport default changes nothing pinned",
    ).toEqual({ points: pin.points, tiebreakers: pin.tiebreakers, crossGroup: pin.crossGroup, sources: pin.sources });
    expect((await loadTableRules(sql, stageId)).pinnedAt).toBe(pin.pinnedAt);

    // Counterfactuals, each layer: un-pinned, the same stage takes every edit.
    const asPending = tableRulesOf({ ...row, status: "pending", pin: null, pinnedAt: null }, stub);
    expect(asPending.points, "un-pinned, the stub's own order and rule would reach the stage").toEqual(STUB_RULE);
    await sql`update divisions set tiebreakers = null where id = ${s.divisionId}`;
    expect(tableRulesOf({ ...row, divisionTiebreakers: null, status: "pending", pin: null, pinnedAt: null }, stub).tiebreakers).toEqual(FOR_FIRST);
    await sql`update divisions set tiebreakers = ${sql.json(FOR_FIRST)} where id = ${s.divisionId}`;
    await unpin(stageId);
    const live = await recomputeStandings(s.auth.orgId, stageId);
    expect(pointsOf(live, A), "un-pinned, a win pays the edited cfg the fixture was scored under").toBe(WIN_EDITED);
    expect(ranking(live).slice(0, 2), "un-pinned, the division's order").toEqual([B, A]);
  }, 180_000);

  it("Review Focus 1: regenerating an active stage keeps its first pin (not re-taken from a changed division default)", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const first = await stageRules(stageId);
    expect(first.pin).not.toBeNull();
    await sql`update divisions set tiebreakers = ${sql.json(FOR_FIRST)} where id = ${s.divisionId}`;

    // the product's two regenerates: generate again, and Rebuild (deletes the unplayed fixtures and generates afresh)
    await generateStageFixtures(s.auth, stageId);
    expect(await stageRules(stageId), "a second generate keeps the first pin").toEqual(first);
    await rebuildStageFixtures(s.auth, stageId);
    expect((await seatedFixtures(stageId)).length, "premise: the rebuild generated the round robin again").toBe(6);
    expect(await stageRules(stageId), "a rebuild keeps the first pin").toEqual(first);

    // The writer's own guard, reached directly: an activation writer that pins an already-pinned stage writes nothing.
    // (The product's regenerates above never reach the pin call — the stage is active — so this is the guard's witness.)
    await sql.begin((tx) => pinStageTableRules(tx, stageId));
    const again = await stageRules(stageId);
    expect(again, "the pin is never re-taken").toEqual(first);
    expect((again.pin as { tiebreakers: string[] }).tiebreakers).toEqual(SPORT_ORDER);
  }, 180_000);

  it("an active stage with no pin makes loadTableRules throw CONFIG_INVALID (the guard, reached by nulling the column); the standings read answers a typed 422, never a crash", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const n = await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${stageId}`;
    expect(n.count).toBe(1);
    const err = await loadTableRules(sql, stageId).catch((e: unknown) => e);
    expect(EngineError.is(err), String(err)).toBe(true);
    expect(err).toMatchObject({ code: "CONFIG_INVALID", data: { reason: "unpinned", status: "active" } });
    // through the real standings read and the real API envelope
    await expect(recomputeStandings(s.auth.orgId, stageId)).rejects.toMatchObject({ code: "CONFIG_INVALID", data: { reason: "unpinned" } });
    const res = await v1(() => recomputeStandings(s.auth.orgId, stageId));
    expect(res.status).toBe(ENGINE_HTTP.CONFIG_INVALID);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
  }, 120_000);

  it("T8 refusal through the real standings read: a stage with zero decided matches on a cfg its sport cannot read is a typed 422, and generating it writes nothing", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    // generic's `{}`: no result mode, no points — the sport cannot read it even as given (T8's typed refusal).
    await sql`update divisions set config = '{}'::jsonb where id = ${s.divisionId}`;
    expect(generic.configSchema.safeParse({}).success, "premise: the schema refuses {}").toBe(false);
    await expect(recomputeStandings(s.auth.orgId, stageId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const res = await v1(() => recomputeStandings(s.auth.orgId, stageId));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
    // the activation's pin is refused with it, and the transaction that would have started the stage writes nothing
    const gen = await v1(() => generateStageFixtures(s.auth, stageId));
    expect(gen.status).toBe(422);
    expect(await stageRules(stageId)).toMatchObject({ status: "pending", pin: null });
    expect((await seatedFixtures(stageId)).length, "no fixture was written").toBe(0);
  }, 120_000);

  it("started-status census (fix I1): every `update stages set status = 'active' | 'complete'` in non-test W/server pins in its block — after an activation's write, before a completion's (source scan; counts writers found, expects 2 active + 1 complete; 0 fails)", () => {
    const SERVER = resolve(import.meta.dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(full);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(SERVER);
    expect(files.length, "anti-vacuity: server files scanned").toBeGreaterThan(200);
    const WRITE = /update\s+stages\s+set\s+status\s*=\s*'(active|complete)'/gi;
    const PIN = /\bpinStageTableRules\(\s*tx\s*,\s*stageId\s*\)/;
    const writers: { at: string; status: string; pinned: boolean }[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(WRITE)) {
        // the block the write sits in: back to its opening brace, forward to the brace that closes it
        let depth = 0;
        let open = m.index;
        for (; open >= 0; open--) {
          if (text[open] === "}") depth++;
          else if (text[open] === "{" && depth-- === 0) break;
        }
        depth = 0;
        let close = m.index;
        for (; close < text.length; close++) {
          if (text[close] === "{") depth++;
          else if (text[close] === "}" && depth-- === 0) break;
        }
        const status = m[1]!.toLowerCase();
        // an activation pins after its write (the stage's rules as they stand when it starts); a completion pins
        // before it (a stage completed straight from pending, fix I1) — either way inside the write's own block
        const span = status === "active" ? text.slice(m.index, close) : text.slice(open + 1, m.index);
        const line = text.slice(0, m.index).split("\n").length;
        writers.push({ at: `${relative(SERVER, file)}:${line}`, status, pinned: open >= 0 && PIN.test(span) });
      }
    }
    const found = writers.map((w) => `${w.status}@${w.at}`).join(", ");
    expect(writers.filter((w) => w.status === "active").length, `activation writers found: ${found}`).toBe(2);
    expect(writers.filter((w) => w.status === "complete").length, `completion writers found: ${found}`).toBe(1);
    expect(writers.filter((w) => !w.pinned).map((w) => w.at), "every writer into a started status pins in its block").toEqual([]);
  });

  it("active ⇒ pinned, swept over THIS test's org only (the shared DB holds older active, unpinned stages): every stage the product started here is pinned (counted)", async () => {
    const drafts = buildTemplateStages("league_ko", { qualified: 2, swissRounds: 5, poolCount: 2, legs: 1 }).map((d, i) => ({ ...d, seq: i + 1 }));
    const s = await tableScene({ stages: drafts as CreateStages });
    for (const id of s.stageIds) await generateStageFixtures(s.auth, id);
    const [sweep] = await sql<{ started: number; unpinned: number }[]>`
      select count(*)::int as started, count(*) filter (where s.table_rules_pinned is null or s.table_rules_pinned_at is null)::int as unpinned
        from stages s join divisions d on d.id = s.division_id join competitions c on c.id = d.competition_id
       where c.org_id = ${s.auth.orgId} and s.status in ('active', 'complete')`;
    expect(sweep!.started, "anti-vacuity: started stages in this org").toBe(s.stageIds.length);
    expect(sweep!.unpinned).toBe(0);
  }, 120_000);

  it("Review Focus 5: carried openings are not re-paid by the stage rule — a points-carry stage's carried row keeps its carried points after the stage's own fixtures are paid by payout (carryDeltas stages.ts:4494; payout sites competition.ts:116,432)", async () => {
    // Phase 2 pays a win ONE point (its own rule); Phase 1 paid generic's three. A carried row re-priced by the stage's
    // rule would lose the difference.
    const OWN = PointsRule.parse({ win: { regulation: 1 }, loss: { regulation: 0 }, draw: 0, shootoutAs: "result", unit: "whole" });
    const s = await tableScene({
      stages: [
        { seq: 1, kind: "league", name: "Phase 1", config: {} },
        {
          seq: 2,
          kind: "league",
          name: "Super pool",
          config: { points: OWN },
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }],
            placement: "rank_order",
            timing: "on_complete",
            carry: "points",
          },
        },
      ] as CreateStages,
    });
    const [p1, p2] = s.stageIds as [string, string];
    const [A, B, C, D] = s.entrants as [string, string, string, string];
    await generateStageFixtures(s.auth, p1);
    await startDivision(s.auth, s.divisionId);
    // the lower seed wins every match 1-0: A three wins, B two, C one, D none
    const order = [A, B, C, D];
    for (const f of await seatedFixtures(p1)) {
      const [w, l] = order.indexOf(f.home) < order.indexOf(f.away) ? [f.home, f.away] : [f.away, f.home];
      await genericResult(s.auth, p1, w, l, 1, 0);
    }
    await completeStage(s.auth, p1);
    const [next] = await sql<{ config: { carry_deltas?: { entrantId: string; points: number }[] } }[]>`select config from stages where id = ${p2}`;
    const carried = new Map((next!.config.carry_deltas ?? []).map((d) => [d.entrantId, d.points]));
    expect(carried.get(A), "premise: A carries three wins at generic's points").toBe(3 * GENERIC_CONFIG.points.w);
    expect(carried.size, "premise: the top three carry").toBe(3);
    if ((await seatedFixtures(p2)).length === 0) await generateStageFixtures(s.auth, p2);
    expect((await stageRules(p2)).pin, "premise: Phase 2 started and is pinned to its own rule").toMatchObject({ points: OWN, sources: { points: "stage" } });

    await genericResult(s.auth, p2, A, B, 1, 0);
    const rows = await recomputeStandings(s.auth.orgId, p2);
    let checked = 0;
    for (const [id, opening] of carried) {
      const own = id === A ? OWN.win.regulation : id === B ? OWN.loss.regulation : 0;
      expect(pointsOf(rows, id), `entrant ${id}: carried + paid by the stage's own rule`).toBe(opening + own);
      checked++;
    }
    expect(checked).toBe(3);
  }, 240_000);

  it("rebase ruling (T1 concern 2, supersedes PF-10/PS-5c): an organiser No-result board (core.abandon{noResult}) credits no row and leaves the table as it was — online chess, and generic beside it (counted)", async () => {
    const SPORTS = [
      { sport: "boardgame", variant: "classical", decide: (auth: Parameters<typeof post>[0], id: string, winner: string) => post(auth, id, "boardgame.result", { winner, method: "resign" }) },
      { sport: "generic", variant: "score", decide: null },
    ] as const;
    let checked = 0;
    for (const sp of SPORTS) {
      const s = await tableScene({ sport: sp.sport, variant: sp.variant });
      const stageId = s.stageIds[0]!;
      const [A, B, C, D] = s.entrants as [string, string, string, string];
      await generateStageFixtures(s.auth, stageId);
      await startDivision(s.auth, s.divisionId);
      if (sp.decide === null) await genericResult(s.auth, stageId, A, B, 2, 1);
      else {
        const ab = await between(stageId, A, B);
        await post(s.auth, ab.id, "core.start");
        await sp.decide(s.auth, ab.id, A);
      }
      const before = await recomputeStandings(s.auth.orgId, stageId);
      expect(before.find((r) => r.entrantId === A)?.played, `${sp.sport}: premise, A played one`).toBe(1);
      const cd = await between(stageId, C, D);
      await scoreEvent(s.auth, cd.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(s.auth, cd.id, { expected_seq: 1, type: "core.abandon", payload: { reason: "No result", noResult: true } }, { writer: "organiser_no_result" });
      const [stored] = await sql<{ status: string; outcome: unknown }[]>`select status, outcome from fixtures where id = ${cd.id}`;
      expect(stored, `${sp.sport}: premise, the board is closed with no outcome`).toMatchObject({ status: "abandoned", outcome: null });
      const after = await recomputeStandings(s.auth.orgId, stageId);
      expect(after, `${sp.sport}: the No-result board changes no row`).toEqual(before);
      for (const id of [C, D]) expect(after.find((r) => r.entrantId === id), `${sp.sport}: no credit`).toMatchObject({ played: 0, points: 0 });
      checked++;
    }
    expect(checked).toBe(SPORTS.length);
  }, 240_000);

  it("PS-7b loadTableRules returns sportDefault = the module's default for the stage kind and merged cfg, also when an own order wins (football with fairPlay on and off — the two differ from Task 11 on)", async () => {
    await seedFootballCatalog();
    const football = moduleOf("football");
    const OWN_ORDER = ["points", "lots"];
    let checked = 0;
    for (const fairPlay of [true, false]) {
      const base = football.variants["11-a-side"] as Record<string, unknown>;
      const s = await tableScene({ sport: "football", variant: "11-a-side", config: { ...base, fairPlay } });
      const stageId = s.stageIds[0]!;
      await sql`update stages set config = config || ${sql.json({ tiebreakers: OWN_ORDER })} where id = ${stageId}`;
      const rules = await loadTableRules(sql, stageId);
      expect(rules.tiebreakers, "the stage's own order wins").toEqual(OWN_ORDER);
      expect(rules.sources.tiebreakers).toBe("stage");
      const [division] = await sql<{ config: unknown }[]>`select config from divisions where id = ${s.divisionId}`;
      const cfg = football.configSchema.parse(division!.config) as { fairPlay: boolean };
      expect(cfg.fairPlay, "premise: the division plays the fair-play setting asked").toBe(fairPlay);
      expect(rules.sportDefault, `fairPlay ${fairPlay}: the sport's own default`).toEqual(football.defaultTiebreakers("league", cfg));
      expect(rules.sportDefault.length).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(2);
  }, 180_000);

  it("PS-5d repinStageOwnRules replaces only the saved field of the pin (source stage), keeps the rest and the pin's date — its cross-group order is the engine resolver's, derived from the NEW order (fix I4a); a pending stage is left to read live", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    // pending: no pin, nothing written
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: ["points", "lots"] }));
    expect(await stageRules(stageId)).toMatchObject({ status: "pending", pin: null, pinned_at: null });

    await generateStageFixtures(s.auth, stageId);
    const first = await stageRules(stageId);
    const pin0 = first.pin as { points: PointsRule; tiebreakers: string[]; crossGroup: string[]; sources: Record<string, string> };
    // An order with a head-to-head step: the cross-group order the engine derives from it drops that step, and differs
    // from the one the pin derived from the sport's order — so a cross-group order kept from the OLD order is seen.
    const NEW_ORDER = ["points", "direct", "diff", "lots"] as TiebreakerKey[];
    const derived = defaultCrossGroup(NEW_ORDER);
    expect(derived, "premise: the engine drops the head-to-head step").toEqual(["points", "diff", "lots"]);
    expect(derived, "premise: the new order's cross-group order is not the pin's").not.toEqual(pin0.crossGroup);
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: NEW_ORDER }));
    const order = await stageRules(stageId);
    expect(order.pin).toEqual({ ...pin0, tiebreakers: NEW_ORDER, crossGroup: derived, sources: { points: "sport", tiebreakers: "stage", crossGroup: "derived" } });
    expect(order.pinned_at, "the pin's date is kept").toBe(first.pinned_at);

    const OWN = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole" });
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { points: OWN }));
    const points = await stageRules(stageId);
    expect(points.pin, "a points save keeps the order and its cross-group order").toEqual({
      ...pin0,
      points: OWN,
      tiebreakers: NEW_ORDER,
      crossGroup: derived,
      sources: { points: "stage", tiebreakers: "stage", crossGroup: "derived" },
    });
    expect((await loadTableRules(sql, stageId)).points, "the loader serves the re-pinned rule").toEqual(OWN);
    expect(points.pinned_at).toBe(first.pinned_at);
  }, 120_000);

  it("PS-5d a cross-group order of the stage's own survives a later order save; cleared (null) it is the resolver's again (fix I4a, both directions)", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const OWN_CROSS = ["points", "for", "lots"] as TiebreakerKey[];
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { crossGroup: OWN_CROSS }));
    expect((await stageRules(stageId)).pin, "the own cross-group order is pinned").toMatchObject({ crossGroup: OWN_CROSS, sources: { crossGroup: "stage" } });
    const NEW_ORDER = ["points", "direct", "diff", "lots"] as TiebreakerKey[];
    expect(defaultCrossGroup(NEW_ORDER), "premise: the derived order is not the own one").not.toEqual(OWN_CROSS);
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: NEW_ORDER }));
    expect((await stageRules(stageId)).pin, "an order save keeps the stage's own cross-group order").toMatchObject({
      tiebreakers: NEW_ORDER,
      crossGroup: OWN_CROSS,
      sources: { crossGroup: "stage" },
    });
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { crossGroup: null }));
    expect((await stageRules(stageId)).pin, "cleared: derived from the pinned order").toMatchObject({
      tiebreakers: NEW_ORDER,
      crossGroup: defaultCrossGroup(NEW_ORDER),
      sources: { crossGroup: "derived" },
    });
  }, 120_000);

  it("PS-5d re-review N2: a stage's own cross-group order EQUAL to the derived one is still its own — it survives an order save (the source is read, never the values)", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const pin0 = (await stageRules(stageId)).pin as { tiebreakers: TiebreakerKey[]; crossGroup: TiebreakerKey[]; sources: Record<string, string> };
    expect(pin0.sources.crossGroup, "premise: the activation pin's cross-group order is derived").toBe("derived");
    // the organiser saves, as its own, exactly the order the engine derived
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { crossGroup: pin0.crossGroup }));
    expect((await stageRules(stageId)).pin, "saved as its own").toMatchObject({ crossGroup: pin0.crossGroup, sources: { crossGroup: "stage" } });
    const NEW_ORDER = ["points", "direct", "diff", "lots"] as TiebreakerKey[];
    expect(defaultCrossGroup(NEW_ORDER), "premise: the new order derives another cross-group order").not.toEqual(pin0.crossGroup);
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: NEW_ORDER }));
    expect((await stageRules(stageId)).pin, "the own order stays, though it equalled the derived one").toMatchObject({
      tiebreakers: NEW_ORDER,
      crossGroup: pin0.crossGroup,
      sources: { tiebreakers: "stage", crossGroup: "stage" },
    });
  }, 120_000);

  it("PS-5d re-review N2: a V472-migrated pin's cross-group order is the migration's, never the stage's own — a points save keeps it, an order save re-derives it from the new order", async () => {
    // The migrated pin exactly as V472 writes it: its cross-group literal and its sources, read from the delta's text.
    const deltas = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");
    const v472 = readFileSync(join(deltas, readdirSync(deltas).find((f) => /^V\d+__w2d_table_rules\.sql$/.test(f))!), "utf8");
    const literal = (key: string) => JSON.parse(new RegExp(`'${key}',\\s*'([^']+)'::jsonb`).exec(v472)![1]!) as unknown;
    const MIGRATED_CROSS = literal("crossGroup") as TiebreakerKey[];
    const MIGRATED_SOURCES = literal("sources") as Record<string, string>;
    expect(MIGRATED_SOURCES, "premise: V472 names every source the migration").toEqual({ points: "migrated", tiebreakers: "migrated", crossGroup: "migrated" });
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const pin0 = (await stageRules(stageId)).pin as { points: PointsRule; tiebreakers: TiebreakerKey[] };
    expect(MIGRATED_CROSS, "premise: the migrated cross-group order is not the one derived from the pin's order").not.toEqual(defaultCrossGroup(pin0.tiebreakers));
    const migrated = { points: pin0.points, tiebreakers: pin0.tiebreakers, crossGroup: MIGRATED_CROSS, sources: MIGRATED_SOURCES };
    await sql`update stages set table_rules_pinned = ${sql.json(migrated as never)} where id = ${stageId}`;

    const OWN = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole" });
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { points: OWN }));
    expect((await stageRules(stageId)).pin, "a points save keeps the migrated order and its cross-group order").toEqual({
      ...migrated,
      points: OWN,
      sources: { ...MIGRATED_SOURCES, points: "stage" },
    });
    const NEW_ORDER = ["points", "direct", "diff", "lots"] as TiebreakerKey[];
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: NEW_ORDER }));
    expect((await stageRules(stageId)).pin, "an order save: derived from the NEW order, not kept as if it were the stage's own").toEqual({
      points: OWN,
      tiebreakers: NEW_ORDER,
      crossGroup: defaultCrossGroup(NEW_ORDER),
      sources: { points: "stage", tiebreakers: "stage", crossGroup: "derived" },
    });
  }, 120_000);

  it("PS-5d a saved null CLEARS the own layer: points revert to the sport's rule under the division's cfg as it is NOW, the order to the division's order as it is now, else the sport's — sources updated (fix I4b, both directions)", async () => {
    const s = await tableScene({});
    const stageId = s.stageIds[0]!;
    await generateStageFixtures(s.auth, stageId);
    const pin0 = (await stageRules(stageId)).pin as { points: PointsRule; sources: Record<string, string> };
    const OWN = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole" });
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { points: OWN, tiebreakers: FOR_FIRST as TiebreakerKey[] }));
    expect((await stageRules(stageId)).pin, "premise: both are the stage's own").toMatchObject({
      points: OWN,
      tiebreakers: FOR_FIRST,
      sources: { points: "stage", tiebreakers: "stage" },
    });
    // The division moves after activation: a win now pays 5, and it ranks by its own order.
    const NOW_CFG = { ...GENERIC_CONFIG, points: { w: 5, d: 2, l: 0 } };
    const DIVISION_ORDER = ["points", "diff", "for", "lots"];
    await sql`update divisions set config = ${sql.json(NOW_CFG)}, tiebreakers = ${DIVISION_ORDER} where id = ${s.divisionId}`;
    const nowRule = generic.tablePointsRule(generic.configSchema.parse(NOW_CFG), "league");
    expect(nowRule, "premise: the sport's rule NOW is not the one the stage was pinned with").not.toEqual(pin0.points);
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { points: null }));
    const cleared = (await stageRules(stageId)).pin;
    expect(cleared, "points cleared: the sport's rule under the live cfg; the order untouched").toMatchObject({
      points: nowRule,
      tiebreakers: FOR_FIRST,
      sources: { points: "sport", tiebreakers: "stage" },
    });
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: null }));
    expect((await stageRules(stageId)).pin, "order cleared: the division's order as it is now").toMatchObject({
      points: nowRule,
      tiebreakers: DIVISION_ORDER,
      crossGroup: defaultCrossGroup(DIVISION_ORDER as TiebreakerKey[]),
      sources: { points: "sport", tiebreakers: "division" },
    });
    // …and with no division order, the sport's
    await sql`update divisions set tiebreakers = null where id = ${s.divisionId}`;
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: FOR_FIRST as TiebreakerKey[] }));
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { tiebreakers: null }));
    const sportOrder = generic.defaultTiebreakers("league", generic.configSchema.parse(NOW_CFG));
    expect((await stageRules(stageId)).pin, "order cleared, no division order: the sport's").toMatchObject({
      tiebreakers: sportOrder,
      sources: { tiebreakers: "sport" },
    });
    // the other direction: a value saved again is the stage's own
    await sql.begin((tx) => repinStageOwnRules(tx, stageId, { points: OWN }));
    expect((await stageRules(stageId)).pin, "saved again: the stage's own").toMatchObject({ points: OWN, sources: { points: "stage" } });
  }, 120_000);
});

// W2d T9 fix round 1, I1: a stage leaves pending by more doors than its two activation writers. A ladder challenge issued
// before the division starts, and an ad-hoc match added to a league nobody generated, are both played on a PENDING
// stage; completing it then goes straight from pending to complete. Both are organiser behaviour the help pages document
// (`content/help/divisions/add-a-match.md`), so neither is refused: the completion pins instead. Each case walks the
// whole sequence — pending → score → complete → void — and every read after the completion must answer: without the pin
// the stage is `complete` and unpinned, and every later read (the void's recompute first) is refused `unpinned`.
describe.skipIf(!HAS_DB)("W2d T9 fix I1: a stage that leaves pending by any door is pinned", () => {
  async function playCompleteVoid(s: Awaited<ReturnType<typeof tableScene>>, fixtureId: string) {
    const stageId = s.stageIds[0]!;
    // the division starts; its first stage already holds a fixture, so the start generates nothing and leaves it pending
    await startDivision(s.auth, s.divisionId);
    expect(await stageRules(stageId), "premise: the match is on a stage nobody started").toMatchObject({ status: "pending", pin: null });
    await post(s.auth, fixtureId, "core.start");
    await post(s.auth, fixtureId, "generic.result", { p1Score: 3, p2Score: 1 });
    expect(await stageRules(stageId), "premise: scoring alone does not start the stage").toMatchObject({ status: "pending", pin: null });
    await completeStage(s.auth, stageId);
    const done = await stageRules(stageId);
    expect(done.status, "the stage completed").toBe("complete");
    expect(done.pin, "completing a pending stage pins it").not.toBeNull();
    expect(done.pinned_at).not.toBeNull();
    expect(done.pin, "pinned with the layers it was ranked by").toEqual(sportPin(GENERIC_CONFIG));
    // void the result: its recompute reads the completed stage's rules — the pin, never a refusal
    const [result] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fixtureId} and type = 'generic.result' order by seq desc limit 1`;
    await post(s.auth, fixtureId, "core.void", { event_id: result!.id });
    const after = await recomputeStandings(s.auth.orgId, stageId);
    expect(after.length, "the table still reads after the void").toBeGreaterThan(0);
    expect((await loadTableRules(sql, stageId)).pinnedAt, "the loader serves the pin").toBe(done.pinned_at);
  }

  it("(a) ladder: a challenge issued before the division starts, played, the stage completed and the result voided", async () => {
    const s = await tableScene({ stages: { seq: 1, kind: "ladder" as never, name: "Ladder", config: {} } });
    const [E1, E2] = s.entrants as [string, string];
    const { fixture_id } = await issueChallenge(s.auth, s.stageIds[0]!, { challenger_id: E2, opponent_id: E1 });
    await playCompleteVoid(s, fixture_id);
  }, 180_000);

  it("(b) addFixture: an ad-hoc match on a league nobody generated, played, the stage completed and the result voided", async () => {
    const s = await tableScene({});
    const [E1, E2] = s.entrants as [string, string];
    const { fixture_id } = await addFixture(s.auth, s.stageIds[0]!, { home_entrant_id: E1, away_entrant_id: E2 });
    await playCompleteVoid(s, fixture_id);
  }, 180_000);
});
