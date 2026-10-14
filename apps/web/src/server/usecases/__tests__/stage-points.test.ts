// W2c Task 13 (ST-G8, spec item 10, Q1, Review Focus 3) — a stage's own points, through `PUT /stages/{id}/rules`.
//
// The body is `{rules?, points?}`: `points` is the engine's PointsRule written to `config.points`, `null` removes it, an
// omitted `points` leaves it as stored (the rules arm's merge semantics, Task 11). One validation for every door that
// writes a stage's points (this PUT, and `createStages` / `replaceStages` / templates through `validatedStageConfig`):
//  - a bracket kind has no table: RULE_NOT_SETTABLE, field `points`;
//  - a division whose points a rule cannot say (Q1, the engine's `pointsRuleExpressible`): 422 POINTS_RULE_INEXPRESSIBLE,
//    its split keys in `extra.keys` so a client can say them in the reader's language;
//  - a walkover score that does not reach this sport's table (batch-3 I3, the engine's `pointsRuleAwardReachesTable`):
//    RULE_NOT_SETTABLE, field `points.forfeit.awardScore`;
//  - a rule naming metrics the sport does not emit: CONFIG_INVALID (`validatePointsRule`);
//  - bonuses or a forfeit row without `standings.custom_points`: 402 (ONE gate, `assertCustomPointsAllowed`);
//  - a started stage: STAGE_FORMAT_LOCKED, monotonic across a void.
// And the division save re-asks Q1 for every UNSTARTED stage that carries points.
//
// Expected values come from the engine's own declarations (`pointsRuleExpressible`, `pointsRuleAwardReachesTable`,
// `metrics`, the kind sets, the variants) and the rule each test declares, never from the code under test. Real Postgres
// required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { pointsRuleAwardReachesTable, pointsRuleExpressible } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { ruleErrorMessage, ruleRefusalText } from "@/lib/rule-errors";
import { msg } from "@/lib/messages";
import es from "@/dictionaries/es/ui.json";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { PUT as putRulesRoute } from "@/app/api/v1/stages/[id]/rules/route";
import { POST as postStagesRoute } from "@/app/api/v1/divisions/[id]/stages/route";
import { createApiKey } from "../api-keys";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures, getStandings } from "../stages";
import { formatLockedStageIds } from "../stage-rules";
import { makeUser } from "./_seed";
import { movingFragment } from "./_stage-probe";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const base = { base: { win: 3, draw: 1, loss: 0 } };
// Not a margin bonus: badminton emits no for/against, so `validatePointsRule` refuses a margin bonus there (its own arm
// below). `forfeit_loss` pays on any sport.
const withBonus = { ...base, bonuses: [{ when: "forfeit_loss" as const, points: 1 }] };
const withForfeit = { ...base, forfeit: { winnerPoints: 3, loserPoints: 0 } };

/** An org with a real owner (an API key needs a session's user; a `manage` key needs `api.write`, Enterprise-only since
 *  V393). */
async function seedOrg(plan: "pro" | "community" | "enterprise" = "pro"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by) values (${"Sp " + suffix}, ${"sp-" + suffix}, ${owner.id})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: owner.id, role: "owner", keyId: null };
}

/** V393 granted `standings.custom_points` to Community, so no plan withholds it: a DENY override is the one lever that
 *  takes it away (custom-points.test.ts), and it beats the plan. */
async function denyFeature(orgId: string, featureKey: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, ${featureKey}, false, 'test')
    on conflict (org_id, feature_key) do update set bool_value = false`;
  await invalidateOrgEntitlements(orgId);
}

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

async function seedDivision(
  auth: AuthCtx,
  sportKey: string,
  variantKey: string,
  entrantCount = 0,
): Promise<{ divisionId: string; entrants: string[] }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Sp Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sportKey,
    variant_key: variantKey,
    config: {},
  });
  if (entrantCount === 0) return { divisionId: division.id, entrants: [] };
  const kind = mod(sportKey).entrantModel?.defaultKind ?? "individual";
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  return { divisionId: division.id, entrants: entrants.map((e) => e.id) };
}

async function seedStage(auth: AuthCtx, divisionId: string, seq: number, kind: StageKind = "league", config: Record<string, unknown> = {}): Promise<string> {
  // A swiss stage must declare its round count (assertSwissRoundsDeclared).
  const own = kind === "swiss" ? { rounds: 2, ...config } : config;
  const [stage] = await createStages(auth, divisionId, { seq, kind, name: "S" + seq, config: own, progression: null });
  return stage!.id;
}

const stageConfig = async (stageId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config;
const stageCount = async (divisionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from stages where division_id = ${divisionId}`)[0]!.n;

/** The variant's config as the division stores it (`createDivision` stores the PARSED preset). */
const variantCfg = (m: AnySportModule, variant: string): unknown => m.configSchema.parse(m.variants[variant]);

describe.skipIf(!HAS_DB)("ST-G8 stage points (server)", () => {
  it("empty: {points: null} on a stage with none is a no-op, and leaves the stage's rules as stored", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const s = await seedStage(auth, divisionId, 1, "league");
    const moving = movingFragment(mod("badminton"), "short", "league");
    expect(moving, "premise: a badminton league stage has a rule it can move").not.toBeNull();
    await putStageRules(auth, s, { rules: moving!.frag });
    const before = await stageConfig(s);
    await putStageRules(auth, s, { points: null });
    const after = await stageConfig(s);
    expect(Object.hasOwn(after, "points")).toBe(false);
    expect(after.rules, "the points arm left the rules as stored").toEqual(before.rules);
    expect(after.rules).toEqual(moving!.frag);
  });

  it("a table stage stores its points; a second save replaces; null clears — and each arm leaves the other's key as stored", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const s = await seedStage(auth, divisionId, 1, "league");
    const out = await putStageRules(auth, s, { points: base });
    expect(out.points, "the save answers with the stored rule").toMatchObject(base);
    expect((await stageConfig(s)).points).toMatchObject(base);
    await putStageRules(auth, s, { points: { base: { win: 2, draw: 1, loss: 0 } } });
    expect((await stageConfig(s)).points).toMatchObject({ base: { win: 2 } });
    // A rules-only save keeps the points; a points-only save keeps the rules.
    const moving = movingFragment(mod("badminton"), "short", "league")!;
    await putStageRules(auth, s, { rules: moving.frag });
    expect((await stageConfig(s)).points, "a rules save left the points").toMatchObject({ base: { win: 2 } });
    await putStageRules(auth, s, { points: base });
    expect((await stageConfig(s)).rules, "a points save left the rules").toEqual(moving.frag);
    // `{rules: null}` clears the rules ONLY.
    await putStageRules(auth, s, { rules: null });
    const cleared = await stageConfig(s);
    expect(Object.hasOwn(cleared, "rules")).toBe(false);
    expect(cleared.points).toMatchObject(base);
    await putStageRules(auth, s, { points: null });
    expect(Object.hasOwn(await stageConfig(s), "points")).toBe(false);
  });

  it("a bracket stage refuses points (RULE_NOT_SETTABLE, field points); every table kind takes them; null is never refused (counted)", async () => {
    const auth = await seedOrg("pro");
    let bracket = 0;
    let table = 0;
    for (const kind of StageKind.options) {
      // One division per kind: the Pro stage cap is below the kind count.
      const { divisionId } = await seedDivision(auth, "badminton", "short");
      const s = await seedStage(auth, divisionId, 1, kind);
      if (BRACKET_KINDS.has(kind)) {
        await expect(putStageRules(auth, s, { points: base }), kind).rejects.toMatchObject({
          status: 400,
          code: "RULE_NOT_SETTABLE",
          extra: { field: "points" },
        });
        expect(Object.hasOwn(await stageConfig(s), "points"), `${kind}: nothing written`).toBe(false);
        bracket++;
      } else {
        expect(DRAW_KINDS.has(kind), kind).toBe(true);
        await putStageRules(auth, s, { points: base });
        expect((await stageConfig(s)).points, kind).toMatchObject(base);
        table++;
      }
      // Removing is always allowed: it can only take an inert key away.
      await expect(putStageRules(auth, s, { points: null }), `${kind}: null`).resolves.toBeTruthy();
    }
    expect(bracket).toBe(BRACKET_KINDS.size);
    expect(table).toBe(DRAW_KINDS.size);
    expect(bracket + table).toBe(StageKind.options.length);
  }, 60_000);

  it("Q1 an inexpressible division refuses by name (ice hockey OT/SO points), naming its split keys; a variant that splits nothing accepts", async () => {
    const auth = await seedOrg("pro");
    const ih = mod("icehockey");
    const want = pointsRuleExpressible(variantCfg(ih, "iihf"));
    expect(want.ok, "premise: the engine declares iihf's points inexpressible").toBe(false);
    const { divisionId } = await seedDivision(auth, "icehockey", "iihf");
    const s = await seedStage(auth, divisionId, 1, "league");
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({
      status: 422,
      code: "POINTS_RULE_INEXPRESSIBLE",
      extra: { keys: want.ok ? [] : want.keys },
    });
    expect(Object.hasOwn(await stageConfig(s), "points")).toBe(false);
    // The positive pair, same sport: recreational splits nothing.
    expect(pointsRuleExpressible(variantCfg(ih, "recreational")).ok, "premise").toBe(true);
    const rec = await seedDivision(auth, "icehockey", "recreational");
    const s2 = await seedStage(auth, rec.divisionId, 1, "league");
    await putStageRules(auth, s2, { points: base });
    expect((await stageConfig(s2)).points).toMatchObject(base);
  });

  it("Q1 every sport x every variant: refused exactly where the engine says a rule cannot express the division's points (counted)", async () => {
    const auth = await seedOrg("pro");
    let refused = 0;
    let accepted = 0;
    let variants = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        variants++;
        const want = pointsRuleExpressible(variantCfg(m, variant));
        const { divisionId } = await seedDivision(auth, m.key, variant);
        const s = await seedStage(auth, divisionId, 1, "league");
        if (want.ok) {
          await putStageRules(auth, s, { points: base });
          expect((await stageConfig(s)).points, `${m.key}/${variant}`).toMatchObject(base);
          accepted++;
        } else {
          await expect(putStageRules(auth, s, { points: base }), `${m.key}/${variant}`).rejects.toMatchObject({
            code: "POINTS_RULE_INEXPRESSIBLE",
            extra: { keys: want.keys },
          });
          refused++;
        }
      }
    }
    expect(refused + accepted).toBe(variants);
    expect(refused, "anti-vacuity: some variant refuses").toBeGreaterThan(0);
    expect(accepted, "anti-vacuity: some variant accepts").toBeGreaterThan(0);
  }, 120_000);

  it("Review Focus 3: bonuses and forfeit points need standings.custom_points; the base sentence is free", async () => {
    const denied = await seedOrg("community");
    await denyFeature(denied.orgId, "standings.custom_points");
    const { divisionId } = await seedDivision(denied, "badminton", "short");
    const s = await seedStage(denied, divisionId, 1, "league");
    await putStageRules(denied, s, { points: base }); // the base sentence is free
    expect((await stageConfig(s)).points).toMatchObject(base);
    await expect(putStageRules(denied, s, { points: withBonus })).rejects.toMatchObject({ status: 402, featureKey: "standings.custom_points" });
    await expect(putStageRules(denied, s, { points: withForfeit })).rejects.toMatchObject({ status: 402, featureKey: "standings.custom_points" });
    const kept = (await stageConfig(s)).points as { bonuses?: unknown[]; forfeit?: unknown };
    expect(kept.bonuses ?? [], "a refused save wrote nothing: no bonus").toEqual([]);
    expect(kept.forfeit, "a refused save wrote nothing: no forfeit row").toBeUndefined();
    const pro = await seedOrg("pro");
    const d2 = await seedDivision(pro, "badminton", "short");
    const s2 = await seedStage(pro, d2.divisionId, 1, "league");
    await putStageRules(pro, s2, { points: withBonus }); // the granted state
    expect((await stageConfig(s2)).points).toMatchObject({ bonuses: [{ when: "forfeit_loss" }] });
    await putStageRules(pro, s2, { points: withForfeit });
    expect((await stageConfig(s2)).points).toMatchObject({ forfeit: withForfeit.forfeit });
  });

  it("after the stage starts, points lock (STAGE_FORMAT_LOCKED), and stay locked after a void", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short", 2);
    const s = await seedStage(auth, divisionId, 1, "league");
    await generateStageFixtures(auth, s);
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s} limit 1`;
    const started = await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
    await expect(putStageRules(auth, s, { points: null }), "a removal is a change too").rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
    const v = await appendEvent(auth.orgId, f!.id, 1, { type: "core.void", payload: {}, voids: started.event.id });
    expect(v.event.voids).toBe(started.event.id); // the void landed
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
    expect(Object.hasOwn(await stageConfig(s), "points")).toBe(false);
  });

  it("another sport: a generic league takes points, margin bonuses included where the sport emits a score (validatePointsRule); badminton refuses them", async () => {
    const margin = { ...base, bonuses: [{ when: "loss_margin_lte" as const, param: 7, points: 1 }] };
    const scoreKeys = (m: AnySportModule) => {
      const keys = new Set(m.metrics.map((x) => x.key));
      return (keys.has("for") && keys.has("against")) || keys.has("diff");
    };
    expect(scoreKeys(mod("generic")), "premise: generic emits a score").toBe(true);
    expect(scoreKeys(mod("badminton")), "premise: badminton emits no generic score").toBe(false);
    const auth = await seedOrg("pro");
    const g = await seedDivision(auth, "generic", "score");
    const s = await seedStage(auth, g.divisionId, 1, "league");
    await putStageRules(auth, s, { points: base });
    expect((await stageConfig(s)).points).toMatchObject(base);
    await putStageRules(auth, s, { points: margin });
    expect((await stageConfig(s)).points).toMatchObject({ bonuses: [{ when: "loss_margin_lte", param: 7 }] });
    const b = await seedDivision(auth, "badminton", "short");
    const s2 = await seedStage(auth, b.divisionId, 1, "league");
    await expect(putStageRules(auth, s2, { points: margin })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(Object.hasOwn(await stageConfig(s2), "points")).toBe(false);
  });

  it("batch-3 I3: a walkover score is refused where it does not reach the sport's table, stored where it does — every sport (counted)", async () => {
    const auth = await seedOrg("pro");
    const scored = { ...base, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] as [number, number] } };
    let reached = 0;
    let unreached = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      // The first variant a rule can express at all (cricket's never can: its every preset refuses first, Q1).
      const variant = Object.keys(m.variants).find((v) => pointsRuleExpressible(variantCfg(m, v)).ok);
      if (variant === undefined) continue;
      const { divisionId } = await seedDivision(auth, m.key, variant);
      const s = await seedStage(auth, divisionId, 1, "league");
      if (pointsRuleAwardReachesTable(m)) {
        await putStageRules(auth, s, { points: scored });
        expect((await stageConfig(s)).points, m.key).toMatchObject({ forfeit: { awardScore: [3, 0] } });
        reached++;
      } else {
        await expect(putStageRules(auth, s, { points: scored }), m.key).rejects.toMatchObject({
          status: 400,
          code: "RULE_NOT_SETTABLE",
          extra: { field: "points.forfeit.awardScore" },
        });
        // The same forfeit row without a score is that sport's to take.
        await putStageRules(auth, s, { points: withForfeit });
        expect((await stageConfig(s)).points, `${m.key}: the forfeit row alone`).toMatchObject({ forfeit: withForfeit.forfeit });
        unreached++;
      }
    }
    expect(reached, "a goal sport takes it").toBeGreaterThan(0);
    expect(unreached, "a set sport refuses it").toBeGreaterThan(0);
  }, 60_000);

  it("the table moves with the save: a Swiss bye already on the table is re-paid under the new points, and again when they are cleared", async () => {
    // single-sport: the standings fold is sport-blind under a rule; a Swiss bye is the one result an unstarted stage holds.
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short", 3);
    const s = await seedStage(auth, divisionId, 1, "swiss");
    await generateStageFixtures(auth, s); // mint the shells
    await generateStageFixtures(auth, s); // seat round 1 (its bye award is written here, with no event)
    expect(await formatLockedStageIds(auth, divisionId), "premise: a bye is no play, the stage is unstarted").not.toContain(s);
    // The bye row: `home = winner, away = null`, an award outcome (swiss-delete-entrant.test.ts).
    const [bye] = await sql<{ home_entrant_id: string | null; outcome: unknown }[]>`
      select home_entrant_id, outcome from fixtures where stage_id = ${s} and round_no = 1 and ext_key like '%-bye'`;
    expect(bye?.outcome, "premise: an odd field seats a bye").toMatchObject({ kind: "award" });
    const byeWinner = bye!.home_entrant_id!;
    const pointsOf = async () =>
      ((await getStandings(auth, s)).rows as { entrantId: string; points: number }[]).find((r) => r.entrantId === byeWinner)?.points;
    const own = await pointsOf();
    expect(typeof own, "premise: the bye is on the table").toBe("number");
    const rule = { base: { win: 1, draw: 0, loss: 0 }, forfeit: { winnerPoints: 5, loserPoints: 0 } };
    expect(own, "premise: the rule's row differs from the sport's own").not.toBe(rule.forfeit.winnerPoints);
    await putStageRules(auth, s, { points: rule });
    expect(await pointsOf(), "a bye pays the rule's forfeit row").toBe(rule.forfeit.winnerPoints);
    await putStageRules(auth, s, { points: null });
    expect(await pointsOf(), "cleared: the sport's own bye credit again").toBe(own);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("ST-G8 the create door asks the same questions, writing nothing", () => {
  it("createStages refuses an inexpressible division, a bracket kind and an unreached award score; the batch writes no stage", async () => {
    const auth = await seedOrg("pro");
    const ih = await seedDivision(auth, "icehockey", "iihf");
    await expect(
      createStages(auth, ih.divisionId, [
        { seq: 1, kind: "league", name: "A", config: {}, progression: null },
        { seq: 2, kind: "league", name: "B", config: { points: base }, progression: null },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "POINTS_RULE_INEXPRESSIBLE" });
    expect(await stageCount(ih.divisionId)).toBe(0);
    const bd = await seedDivision(auth, "badminton", "short");
    await expect(
      createStages(auth, bd.divisionId, { seq: 1, kind: "knockout", name: "KO", config: { points: base }, progression: null }),
    ).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE", extra: { field: "points" } });
    await expect(
      createStages(auth, bd.divisionId, {
        seq: 1, kind: "league", name: "L", progression: null,
        config: { points: { ...base, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } } },
      }),
    ).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE", extra: { field: "points.forfeit.awardScore" } });
    expect(await stageCount(bd.divisionId)).toBe(0);
    // The positive pair: the same door stores a rule this division can take.
    const [ok] = await createStages(auth, bd.divisionId, { seq: 1, kind: "league", name: "L", config: { points: base }, progression: null });
    expect((await stageConfig(ok!.id)).points).toMatchObject(base);
  });
});

describe.skipIf(!HAS_DB)("ST-G8 the division save re-asks Q1 for every unstarted stage with its own points", () => {
  const SPLIT = "fih-shootout";
  const PLAIN = "fih-outdoor";

  it("premise: hockey's fih-shootout splits its points and fih-outdoor does not (the engine's declaration)", () => {
    const hk = mod("hockey");
    expect(pointsRuleExpressible(variantCfg(hk, SPLIT)).ok).toBe(false);
    expect(pointsRuleExpressible(variantCfg(hk, PLAIN)).ok).toBe(true);
  });

  it("a variant change to a split the stage's points cannot express is refused naming the stage; cleared, it lands; with no stage points it lands", async () => {
    const auth = await seedOrg("pro");
    const want = pointsRuleExpressible(variantCfg(mod("hockey"), SPLIT));
    const { divisionId } = await seedDivision(auth, "hockey", PLAIN);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: base });
    await expect(patchDivision(auth, divisionId, { variant_key: SPLIT })).rejects.toMatchObject({
      status: 422,
      code: "POINTS_RULE_INEXPRESSIBLE",
      extra: { stage_id: s, stage_name: "S1", keys: want.ok ? [] : want.keys },
    });
    const [still] = await sql<{ variant_key: string }[]>`select variant_key from divisions where id = ${divisionId}`;
    expect(still!.variant_key, "the refusal rolled the save back").toBe(PLAIN);
    // Sequence: the organiser clears the stage's points, and the same save lands.
    await putStageRules(auth, s, { points: null });
    const out = await patchDivision(auth, divisionId, { variant_key: SPLIT });
    expect(out.variant_key).toBe(SPLIT);
    // And the PUT now refuses on the new variant.
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ code: "POINTS_RULE_INEXPRESSIBLE" });
    // The positive pair: a division whose stages carry no points changes variant freely.
    const other = await seedDivision(auth, "hockey", PLAIN);
    await seedStage(auth, other.divisionId, 1, "league");
    await expect(patchDivision(auth, other.divisionId, { variant_key: SPLIT })).resolves.toMatchObject({ variant_key: SPLIT });
  });

  it("a config save adding a split is refused the same way; a started stage (its points locked, the division's never reaching it) is not asked", async () => {
    const auth = await seedOrg("pro");
    const hk = mod("hockey");
    const plain = variantCfg(hk, PLAIN) as { points: Record<string, number> };
    const split = { ...plain, points: { ...plain.points, shootoutWin: 2, shootoutLoss: 1 } };
    expect(pointsRuleExpressible(split).ok, "premise: the edit splits the points").toBe(false);
    const { divisionId } = await seedDivision(auth, "hockey", PLAIN);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: base });
    await expect(patchDivision(auth, divisionId, { config: split })).rejects.toMatchObject({ code: "POINTS_RULE_INEXPRESSIBLE", extra: { stage_id: s } });
    // Started: the stage's own rule replaces the division's points (STAGE_POINTS_REPLACES) and can no longer be cleared.
    const started = await seedDivision(auth, "hockey", PLAIN, 2);
    const s2 = await seedStage(auth, started.divisionId, 1, "league");
    await putStageRules(auth, s2, { points: base });
    await generateStageFixtures(auth, s2);
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s2} limit 1`;
    await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    expect(await formatLockedStageIds(auth, started.divisionId), "premise: started").toContain(s2);
    const out = await patchDivision(auth, started.divisionId, { config: split });
    expect((out.config as { points: Record<string, number> }).points.shootoutWin).toBe(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Over the real routes (the refusals' producer is the endpoint, not the helper).
// ---------------------------------------------------------------------------------------------------------------------

async function keyFor(auth: AuthCtx): Promise<string> {
  return (await createApiKey(auth, { name: `k-${randomUUID().slice(0, 6)}`, scopes: ["manage"] })).secret;
}
const keyed = (secret: string, method: string, path: string, body: unknown): Request =>
  new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
type Body = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } & Record<string, unknown> };
const ES = es as unknown as Record<string, string>;
const msgEs = (key: string, vars: Record<string, string | number> = {}) =>
  ES[key]!.replace(/\{(\w+)\}/g, (h, name: string) => (name in vars ? String(vars[name]) : h));

describe.skipIf(!HAS_DB)("ST-G8 over the real HTTP route", () => {
  it("Q1: 422 POINTS_RULE_INEXPRESSIBLE carries the split keys, and a client says it in the reader's language with the fields named", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    const want = pointsRuleExpressible(variantCfg(mod("icehockey"), "iihf"));
    const keys = want.ok ? [] : [...want.keys];
    expect(keys.length, "premise").toBeGreaterThan(0);
    const { divisionId } = await seedDivision(auth, "icehockey", "iihf");
    const s = await seedStage(auth, divisionId, 1, "league");
    const res = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { points: base }), ctx(s));
    const body = (await res.json()) as Body;
    expect(res.status).toBe(422);
    expect(body.error).toMatchObject({ code: "POINTS_RULE_INEXPRESSIBLE", keys });
    expect(body.error!.message).toBe(ruleErrorMessage("POINTS_RULE_INEXPRESSIBLE", { keys }));
    for (const k of keys) expect(body.error!.message, `the English names ${k} by its label, not its key`).not.toContain(k);
    const text = ruleRefusalText(body.error!.code, body.error, msgEs as never);
    expect(text, "the client can say it").not.toBeNull();
    expect(text).not.toBe(body.error!.message);
    expect(text).toBe(ruleRefusalText(body.error!.code, body.error, msgEs as never));
    expect(ruleRefusalText(body.error!.code, body.error, msg), "the en client sentence IS the server's").toBe(body.error!.message);
  });

  it("Review Focus 3: 402 PAYMENT_REQUIRED names standings.custom_points; the base rule lands 200 with the stored rule in the answer", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    await denyFeature(auth.orgId, "standings.custom_points");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const s = await seedStage(auth, divisionId, 1, "league");
    const refused = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { points: withBonus }), ctx(s));
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as Body).error).toMatchObject({ code: "PAYMENT_REQUIRED", feature_key: "standings.custom_points" });
    const ok = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { points: base }), ctx(s));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Body).data).toMatchObject({ points: base, rules: null });
  });

  it("the body: {} is refused; an unknown key is refused; a top-level decider is refused NAMING the key and where to set it (M-6), on the PUT and on POST /stages", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    const { divisionId } = await seedDivision(auth, "football", "11-a-side");
    const s = await seedStage(auth, divisionId, 1, "knockout");
    const put = async (body: unknown) => {
      const res = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, body), ctx(s));
      return { status: res.status, body: (await res.json()) as Body };
    };
    expect((await put({})).status, "nothing to save").toBe(400);
    expect((await put({ rules: {}, pointz: base })).status, "a misspelled arm is not silently dropped").toBe(400);
    const top = await put({ shootout: false });
    expect(top.status).toBe(400);
    expect(top.body.error!.message, "names the key").toContain("shootout");
    expect(top.body.error!.message, "says where it goes").toContain("rules.shootout");
    expect(top.body.error).toMatchObject({ code: "VALIDATION", field: "shootout" });
    const before = await stageConfig(s);
    const post = await postStagesRoute(
      keyed(secret, "POST", `/divisions/${divisionId}/stages`, { seq: 2, kind: "knockout", name: "Old", config: { extraTime: true } }),
      ctx(divisionId),
    );
    const posted = (await post.json()) as Body;
    expect(post.status).toBe(400);
    expect(posted.error!.message).toContain("config.extraTime");
    expect(posted.error!.message).toContain("config.rules.extraTime");
    expect(posted.error).toMatchObject({ code: "VALIDATION", field: "config.extraTime" });
    // The array form names its index.
    const many = await postStagesRoute(
      keyed(secret, "POST", `/divisions/${divisionId}/stages`, [{ seq: 2, kind: "knockout", name: "Old", config: { shootout: true } }]),
      ctx(divisionId),
    );
    const manyBody = (await many.json()) as Body;
    expect(many.status).toBe(400);
    expect(manyBody.error).toMatchObject({ field: "[0].config.shootout" });
    expect(manyBody.error!.message).toContain("[0].config.rules.shootout");
    // A malformed body that is no decider keeps zod's generic message.
    const generic = await postStagesRoute(keyed(secret, "POST", `/divisions/${divisionId}/stages`, { seq: 2, kind: "knockout" }), ctx(divisionId));
    expect(((await generic.json()) as Body).error!.message).toBe("Invalid input");
    expect(await stageConfig(s), "nothing written").toEqual(before);
    expect(await stageCount(divisionId)).toBe(1);
  });
});
