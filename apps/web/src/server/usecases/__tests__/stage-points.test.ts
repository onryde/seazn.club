// W2c Task 13 (ST-G8, spec item 10, Q1, Review Focus 3) — a stage's own points, through `PUT /stages/{id}/rules`.
//
// The body is `{rules?, points?}`: `points` is the engine's PointsRule written to `config.points`, `null` removes it, an
// omitted `points` leaves it as stored (the rules arm's merge semantics, Task 11). One validation for every door that
// writes a stage's points (this PUT, and `createStages` / `replaceStages` / templates through `validatedStageConfig`):
//  - a bracket kind has no table: RULE_NOT_SETTABLE, field `points`;
//  - W2d Task 10 (W2d spec §5.4, §10): a rule that does not pay an outcome the stage can end in (`coverage` over
//    `reachableOutcomes`; cricket's tie): 422 POINTS_OUTCOME_UNCOVERED, the outcomes in `extra.uncovered` so a client can
//    say them in the reader's language. W2c's Q1 ("inexpressible" divisions) is retired: the rule is outcome-keyed now;
//  - a walkover score that does not reach this sport's table (batch-3 I3, the engine's `pointsRuleAwardReachesTable`):
//    RULE_NOT_SETTABLE, field `points.forfeit.awardScore`;
//  - a rule naming metrics the sport does not emit: CONFIG_INVALID (`validatePointsRule`);
//  - no entitlement gate: bonuses and a forfeit row are free on every plan (W2d T10 fix round 1, I4: all scoring is free);
//  - a started stage: STAGE_FORMAT_LOCKED, monotonic across a void.
// And the division save re-asks coverage for every stage whose matches its config reaches (cause, not state).
//
// Expected values come from the engine's own declarations (`coverage`, `reachableOutcomes`, `pointsRuleAwardReachesTable`,
// `metrics`, the kind sets, the variants) and the rule each test declares, never from the code under test. Real Postgres
// required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { PointsRule, coverage, pointsRuleAwardReachesTable, reachableOutcomes } from "@seazn/engine/competition";
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
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
import { POST as postStagesRoute, PUT as putStagesRoute } from "@/app/api/v1/divisions/[id]/stages/route";
import { createApiKey } from "../api-keys";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures, getStandings, replaceStages } from "../stages";
import { formatLockedStageIds } from "../stage-rules";
import { makeUser } from "./_seed";
import { RULEBOOK_SPLITS } from "@/components/v2/stage-rules/__tests__/_points-split-rulebook";
import { movingFragment } from "./_stage-probe";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const base = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const };
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

/** W2d T10 — the engine's own answer: what a league stage on `cfg` can end in that `rule` does not pay. */
const unpaid = (m: AnySportModule, cfg: unknown, rule: unknown) => coverage(PointsRule.parse(rule), reachableOutcomes(m, m.configSchema.parse(cfg), "league"));
/** Volleyball (W2d spec §5.4's live case): a stage's own set-score table for the FIVB best-of-5, every score named. */
const FIVB_OWN: PointsRule = { win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], bySetScore: { "3-0": [3, 0], "3-1": [3, 0], "3-2": [2, 1] } };

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
    await putStageRules(auth, s, { points: { win: { regulation: 2 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const } });
    expect((await stageConfig(s)).points).toMatchObject({ win: { regulation: 2 } });
    // A rules-only save keeps the points; a points-only save keeps the rules.
    const moving = movingFragment(mod("badminton"), "short", "league")!;
    await putStageRules(auth, s, { rules: moving.frag });
    expect((await stageConfig(s)).points, "a rules save left the points").toMatchObject({ win: { regulation: 2 } });
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

  it("W2d T10: a stage that can end in an outcome its points do not pay is refused by name (cricket's tie, 422 POINTS_OUTCOME_UNCOVERED); the rule that pays it is stored", async () => {
    // W2c's Q1 cases (ice hockey OT / SO "inexpressible", the parsed-cfg read, the every-variant sweep) are retired with
    // the engine's expressibility check: an outcome-keyed rule says them all. Their successor is coverage, swept below.
    const auth = await seedOrg("pro");
    const cr = mod("cricket");
    const want = unpaid(cr, variantCfg(cr, "t20"), base);
    expect(want.ok === false && want.uncovered, "premise: the engine says a T20 league can end tied, which `base` does not pay").toEqual(["tie"]);
    const { divisionId } = await seedDivision(auth, "cricket", "t20");
    const s = await seedStage(auth, divisionId, 1, "league");
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ status: 422, code: "POINTS_OUTCOME_UNCOVERED", extra: { uncovered: ["tie"] } });
    expect(Object.hasOwn(await stageConfig(s), "points")).toBe(false);
    // The positive pair, same stage: the rule that pays a tie.
    const pays = { ...base, tie: 1 };
    expect(unpaid(cr, variantCfg(cr, "t20"), pays).ok, "premise").toBe(true);
    await putStageRules(auth, s, { points: pays });
    expect((await stageConfig(s)).points).toMatchObject(pays);
    // And ice hockey's iihf (W2c's inexpressible case) takes a rule that states its overtime; the plain one would pay an
    // overtime win as regulation's and is refused (fix round 1 I2, its own describe below).
    const ih = await seedDivision(auth, "icehockey", "iihf");
    const s2 = await seedStage(auth, ih.divisionId, 1, "league");
    await expect(putStageRules(auth, s2, { points: base })).rejects.toMatchObject({ status: 422, code: "POINTS_SPLIT_FLATTENED" });
    const stated = { ...base, win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1 } };
    await putStageRules(auth, s2, { points: stated });
    expect((await stageConfig(s2)).points).toMatchObject(stated);
  });

  it("W2d T10 every sport x every variant: refused exactly where the engine's coverage says the stage can end unpaid, else (fix round 1 I2) where the rulebooks split an outcome the flat `base` would flatten (counted)", async () => {
    const auth = await seedOrg("pro");
    let refused = 0;
    let flattened = 0;
    let accepted = 0;
    let variants = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        variants++;
        const want = unpaid(m, variantCfg(m, variant), base);
        // The rulebooks' per-outcome splits (a flat rule carries a tie and a no result itself, so those two are not).
        const splits = (RULEBOOK_SPLITS[`${m.key}/${variant}`] ?? []).filter((r) => r !== "tie" && r !== "noResult");
        const { divisionId } = await seedDivision(auth, m.key, variant);
        const s = await seedStage(auth, divisionId, 1, "league");
        if (want.ok && splits.length > 0) {
          await expect(putStageRules(auth, s, { points: base }), `${m.key}/${variant}`).rejects.toMatchObject({
            code: "POINTS_SPLIT_FLATTENED",
            extra: { splits },
          });
          expect(Object.hasOwn(await stageConfig(s), "points"), `${m.key}/${variant}: nothing stored`).toBe(false);
          flattened++;
        } else if (want.ok) {
          await putStageRules(auth, s, { points: base });
          expect((await stageConfig(s)).points, `${m.key}/${variant}`).toMatchObject(base);
          accepted++;
        } else {
          expect(want.inapplicable, `${m.key}/${variant}: \`base\` keeps no set-score table`).toEqual([]);
          await expect(putStageRules(auth, s, { points: base }), `${m.key}/${variant}`).rejects.toMatchObject({
            code: "POINTS_OUTCOME_UNCOVERED",
            extra: { uncovered: [...want.uncovered] },
          });
          refused++;
        }
      }
    }
    expect(refused + flattened + accepted).toBe(variants);
    expect(refused, "anti-vacuity: some variant refuses (cricket)").toBeGreaterThan(0);
    expect(flattened, "every rulebook split the flat rule covers is refused (iihf, indoor, table tennis, fih-shootout)").toBe(
      Object.entries(RULEBOOK_SPLITS).filter(([, r]) => r.some((x) => x !== "tie" && x !== "noResult")).length,
    );
    expect(accepted, "anti-vacuity: some variant accepts").toBeGreaterThan(0);
  }, 120_000);

  it("all scoring is free: a Community org saves the base sentence, then a bonus, then a forfeit row, each stored whole (W2d T10 fix round 1, I4; X-PT-1)", async () => {
    const free = await seedOrg("community");
    const { divisionId } = await seedDivision(free, "badminton", "short");
    const s = await seedStage(free, divisionId, 1, "league");
    await putStageRules(free, s, { points: base });
    expect((await stageConfig(s)).points).toMatchObject(base);
    await putStageRules(free, s, { points: withBonus });
    expect((await stageConfig(s)).points).toMatchObject({ bonuses: [{ when: "forfeit_loss" }] });
    await putStageRules(free, s, { points: withForfeit });
    expect((await stageConfig(s)).points, "a second save replaces the rule whole").toMatchObject({ forfeit: withForfeit.forfeit });
  });

  it("a stage that is not there answers 404 — another org's stage too (fix round 1)", async () => {
    const denied = await seedOrg("community");
    await expect(putStageRules(denied, randomUUID(), { points: withForfeit })).rejects.toMatchObject({ status: 404 });
    const other = await seedOrg("pro");
    const { divisionId } = await seedDivision(other, "badminton", "short");
    const theirs = await seedStage(other, divisionId, 1, "league");
    await expect(putStageRules(denied, theirs, { points: withForfeit })).rejects.toMatchObject({ status: 404 });
    expect(Object.hasOwn(await stageConfig(theirs), "points"), "nothing written on the other org's stage").toBe(false);
    // The positive pair: the org's OWN stage takes the same body.
    const own = await seedDivision(denied, "badminton", "short");
    const mine = await seedStage(denied, own.divisionId, 1, "league");
    await putStageRules(denied, mine, { points: withForfeit });
    expect((await stageConfig(mine)).points).toMatchObject({ forfeit: withForfeit.forfeit });
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
    // Fix round 1 I2: a rule that STATES its loss not played is not flat, so the walkover-score question is asked of it on
    // every sport — a flat one is refused where the sport pays an outcome apart (IIHF, table tennis: its own describe).
    const stated = { regulation: 0, unplayed: 0 };
    const scored = { ...base, loss: stated, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] as [number, number] } };
    const forfeitOnly = { ...withForfeit, loss: stated };
    let reached = 0;
    let unreached = 0;
    const skipped: string[] = [];
    for (const m of builtinModules as readonly AnySportModule[]) {
      // The first variant whose stage `base` pays in full (W2d T10: cricket's every preset can end tied, unpaid by `base`).
      const variant = Object.keys(m.variants).find((v) => unpaid(m, variantCfg(m, v), base).ok);
      if (variant === undefined) {
        skipped.push(m.key);
        continue;
      }
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
        await putStageRules(auth, s, { points: forfeitOnly });
        expect((await stageConfig(s)).points, `${m.key}: the forfeit row alone`).toMatchObject({ forfeit: withForfeit.forfeit });
        unreached++;
      }
    }
    expect(reached, "a goal sport takes it").toBeGreaterThan(0);
    expect(unreached, "a set sport refuses it").toBeGreaterThan(0);
    expect(skipped, "skipped only where every variant can end tied (cricket)").toEqual(["cricket"]);
  }, 60_000);

  it("the table moves with the save: a Swiss bye already on the table is re-paid under the new points, and again when they are cleared (X-PT-1)", async () => {
    // single-sport: the standings fold is sport-blind under a rule; a Swiss bye is the one result an unstarted stage holds.
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short", 3);
    const s = await seedStage(auth, divisionId, 1, "swiss");
    await generateStageFixtures(auth, s); // mint the shells
    await generateStageFixtures(auth, s); // seat round 1 (its bye award is written here, with no event)
    expect(await formatLockedStageIds(auth, divisionId), "premise: a bye is no play, the stage is unstarted").not.toContain(s);
    // Fix round 1 m6: generating pinned the stage (W2d §5.1), so this save is the PINNED stage's own-points arm, the re-pin.
    const pinOf = async () => (await sql<{ pin: unknown }[]>`select table_rules_pinned as pin from stages where id = ${s}`)[0]?.pin;
    expect(await pinOf(), "premise: the generated stage is pinned").not.toBeNull();
    // The bye row: `home = winner, away = null`, an award outcome (swiss-delete-entrant.test.ts).
    const [bye] = await sql<{ home_entrant_id: string | null; outcome: unknown }[]>`
      select home_entrant_id, outcome from fixtures where stage_id = ${s} and round_no = 1 and ext_key like '%-bye'`;
    expect(bye?.outcome, "premise: an odd field seats a bye").toMatchObject({ kind: "award" });
    const byeWinner = bye!.home_entrant_id!;
    const pointsOf = async () =>
      ((await getStandings(auth, s)).rows as { entrantId: string; points: number }[]).find((r) => r.entrantId === byeWinner)?.points;
    const own = await pointsOf();
    expect(typeof own, "premise: the bye is on the table").toBe("number");
    const rule = { win: { regulation: 1 }, draw: 0, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const, forfeit: { winnerPoints: 5, loserPoints: 0 } };
    expect(own, "premise: the rule's row differs from the sport's own").not.toBe(rule.forfeit.winnerPoints);
    await putStageRules(auth, s, { points: rule });
    expect(await pointsOf(), "a bye pays the rule's forfeit row").toBe(rule.forfeit.winnerPoints);
    expect(await pinOf(), "the save re-pinned the stage with its own points").toMatchObject({ points: { forfeit: rule.forfeit }, sources: { points: "stage" } });
    await putStageRules(auth, s, { points: null });
    expect(await pointsOf(), "cleared: the sport's own bye credit again").toBe(own);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("ST-G8 the create door asks the same questions, writing nothing", () => {
  it("createStages refuses a rule that leaves an outcome unpaid (W2d T10), a bracket kind and an unreached award score; the batch writes no stage", async () => {
    const auth = await seedOrg("pro");
    const cr = await seedDivision(auth, "cricket", "t20");
    const want = unpaid(mod("cricket"), variantCfg(mod("cricket"), "t20"), base);
    await expect(
      createStages(auth, cr.divisionId, [
        { seq: 1, kind: "league", name: "A", config: {}, progression: null },
        { seq: 2, kind: "league", name: "B", config: { points: base }, progression: null },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "POINTS_OUTCOME_UNCOVERED", extra: { stage_name: "B", uncovered: want.ok ? [] : [...want.uncovered] } });
    expect(await stageCount(cr.divisionId)).toBe(0);
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

  it("replaceStages asks the same questions of a body's points: refused, the delete rolls back, the original stages untouched", async () => {
    const auth = await seedOrg("pro");
    const bd = await seedDivision(auth, "badminton", "short");
    await seedStage(auth, bd.divisionId, 1, "league");
    const before = await stageIds(bd.divisionId);
    expect(before.length, "premise: a stage to lose").toBe(1);
    await expect(
      replaceStages(auth, bd.divisionId, { seq: 1, kind: "knockout", name: "KO", config: { points: base }, progression: null }),
    ).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE", extra: { field: "points" } });
    await expect(
      replaceStages(auth, bd.divisionId, {
        seq: 1, kind: "league", name: "L", progression: null,
        config: { points: { ...base, forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: [3, 0] } } },
      }),
    ).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE", extra: { field: "points.forfeit.awardScore" } });
    expect(await stageIds(bd.divisionId), "both refusals left the original stage, same id").toEqual(before);
    const cr = await seedDivision(auth, "cricket", "t20");
    await seedStage(auth, cr.divisionId, 1, "league");
    const crBefore = await stageIds(cr.divisionId);
    await expect(
      replaceStages(auth, cr.divisionId, { seq: 1, kind: "league", name: "L", config: { points: base }, progression: null }),
    ).rejects.toMatchObject({ status: 422, code: "POINTS_OUTCOME_UNCOVERED", extra: { uncovered: ["tie"] } });
    expect(await stageIds(cr.divisionId)).toEqual(crBefore);
  });
});

/** The division's stage ids in board order (the "untouched" witness: same count AND the same rows). */
const stageIds = async (divisionId: string): Promise<string[]> =>
  (await sql<{ id: string }[]>`select id from stages where division_id = ${divisionId} order by seq`).map((r) => r.id);
const pointsBySeq = async (divisionId: string): Promise<Map<number, unknown>> =>
  new Map(
    (await sql<{ seq: number; points: unknown }[]>`select seq, config -> 'points' as points from stages where division_id = ${divisionId}`)
      .map((r) => [r.seq, r.points]),
  );

describe.skipIf(!HAS_DB)("R-T13-1 replaceStages carries a matched slot's own points, as it carries its rules", () => {
  const league = (seq: number, name: string, config: Record<string, unknown> = {}) =>
    ({ seq, kind: "league" as const, name, config, progression: null });

  it("Apply keeps a matched slot's points; a new slot has none; a second Apply keeps them; a kind change drops them", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: withForfeit });
    // The empty case first: a slot that never had points comes back with none.
    await replaceStages(auth, divisionId, [league(1, "Pool"), league(2, "New")]);
    let pts = await pointsBySeq(divisionId);
    expect(pts.get(1), "the matched slot kept its own points").toMatchObject(withForfeit);
    // Row-count first: `?? null` alone would also pass on a slot that was never written at all.
    expect(pts.size, "both slots exist").toBe(2);
    expect(pts.has(2), "the new slot's row is there").toBe(true);
    expect(pts.get(2) ?? null, "a new slot starts with none").toBeNull();
    // A second Apply (the carried rule is carried again, not lost on the second delete).
    await replaceStages(auth, divisionId, [league(1, "Pool"), league(2, "New")]);
    pts = await pointsBySeq(divisionId);
    expect(pts.size).toBe(2);
    expect(pts.get(1)).toMatchObject(withForfeit);
    expect(pts.get(2) ?? null).toBeNull();
    // A body's own points win over the carry (the rule is one sentence: replaced whole).
    const other = { win: { regulation: 2 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const };
    await replaceStages(auth, divisionId, [league(1, "Pool", { points: other }), league(2, "New")]);
    const replaced = (await pointsBySeq(divisionId)).get(1) as { base?: unknown; forfeit?: unknown } | null;
    expect(replaced).toMatchObject(other);
    expect(replaced?.forfeit, "replaced whole: the carried forfeit row is gone").toBeUndefined();
    // A kind change is a different slot: seq 1 as a swiss table stage starts with no points.
    await replaceStages(auth, divisionId, [{ seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null }]);
    expect((await pointsBySeq(divisionId)).get(1) ?? null, "a kind change dropped them").toBeNull();
  });

  it("W2d T10: a carried rule that no longer pays what the division now reaches (a legacy row) is refused and the delete rolls back; cleared, Apply lands", async () => {
    const auth = await seedOrg("pro");
    const vb = mod("volleyball");
    const indoor = variantCfg(vb, "indoor") as Record<string, unknown>;
    const bo3 = { ...indoor, bestOf: 3 };
    expect(unpaid(vb, indoor, FIVB_OWN).ok, "premise: the FIVB table pays a best-of-5").toBe(true);
    const want = unpaid(vb, bo3, FIVB_OWN);
    expect(want.ok === false && want.uncovered, "premise: a best-of-3 ends 2-0 or 2-1, which it does not pay").toEqual(["set:2-0", "set:2-1"]);
    const { divisionId } = await seedDivision(auth, "volleyball", "indoor");
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: FIVB_OWN });
    // A row the division save would now refuse (below), as a legacy row holds it: the division plays best of 3.
    const moved = await sql`update divisions set config = ${sql.json(bo3 as never)} where id = ${divisionId}`;
    expect(moved.count).toBe(1);
    const before = await stageIds(divisionId);
    await expect(replaceStages(auth, divisionId, league(1, "Pool"))).rejects.toMatchObject({
      status: 422,
      code: "POINTS_OUTCOME_UNCOVERED",
      extra: { stage_name: "Pool", uncovered: ["set:2-0", "set:2-1"] },
    });
    expect(await stageIds(divisionId), "refused, the delete rolled back: the same stage row").toEqual(before);
    expect((await stageConfig(s)).points).toMatchObject(FIVB_OWN);
    // Sequence: the organiser clears the stage's points, and the same Apply lands.
    await putStageRules(auth, s, { points: null });
    await replaceStages(auth, divisionId, league(1, "Pool"));
    expect((await stageIds(divisionId)).length).toBe(1);
    expect((await pointsBySeq(divisionId)).get(1) ?? null).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("W2d T10 the division save re-asks coverage for every stage its config reaches (cause, not state)", () => {
  const vb = mod("volleyball");
  const indoor = (): Record<string, unknown> => variantCfg(vb, "indoor") as Record<string, unknown>;

  it("a config save that makes a set score reachable the stage's own table does not pay is refused naming the stage; cleared, it lands; with no stage points it lands", async () => {
    const auth = await seedOrg("pro");
    const cfg = indoor();
    const bo3 = { ...cfg, bestOf: 3 };
    const want = unpaid(vb, bo3, FIVB_OWN);
    expect(want.ok === false && want.uncovered, "premise").toEqual(["set:2-0", "set:2-1"]);
    expect(unpaid(vb, bo3, PointsRule.parse(vb.tablePointsRule(vb.configSchema.parse(bo3), "league"))).ok, "premise: the division's own map pays a best-of-3 (its \"*\")").toBe(true);
    const { divisionId } = await seedDivision(auth, "volleyball", "indoor");
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: FIVB_OWN });
    await expect(patchDivision(auth, divisionId, { config: bo3 })).rejects.toMatchObject({
      status: 422,
      code: "POINTS_OUTCOME_UNCOVERED",
      extra: { stage_id: s, stage_name: "S1", uncovered: ["set:2-0", "set:2-1"] },
    });
    const [still] = await sql<{ config: { bestOf: number } }[]>`select config from divisions where id = ${divisionId}`;
    expect(still!.config.bestOf, "the refusal rolled the save back").toBe(5);
    // Sequence: the organiser clears the stage's points, and the same save lands.
    await putStageRules(auth, s, { points: null });
    const out = await patchDivision(auth, divisionId, { config: bo3 });
    expect((out.config as { bestOf: number }).bestOf).toBe(3);
    // And the PUT now refuses the best-of-5 table on the new format.
    await expect(putStageRules(auth, s, { points: FIVB_OWN })).rejects.toMatchObject({ code: "POINTS_OUTCOME_UNCOVERED" });
    // The positive pair: a division whose stages carry no points changes format freely.
    const other = await seedDivision(auth, "volleyball", "indoor");
    await seedStage(auth, other.divisionId, 1, "league");
    expect(((await patchDivision(auth, other.divisionId, { config: bo3 })).config as { bestOf: number }).bestOf).toBe(3);
  });

  it("a PINNED stage is asked too (the format reaches its matches, the pin does not move); a STARTED one is the format lock's", async () => {
    const auth = await seedOrg("pro");
    const bo3 = { ...indoor(), bestOf: 3 };
    const pinned = await seedDivision(auth, "volleyball", "indoor", 2);
    const s = await seedStage(auth, pinned.divisionId, 1, "league");
    await putStageRules(auth, s, { points: FIVB_OWN });
    await generateStageFixtures(auth, s);
    await expect(patchDivision(auth, pinned.divisionId, { config: bo3 })).rejects.toMatchObject({ code: "POINTS_OUTCOME_UNCOVERED", extra: { stage_id: s } });
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s} limit 1`;
    await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    expect(await formatLockedStageIds(auth, pinned.divisionId), "premise: started").toContain(s);
    await expect(patchDivision(auth, pinned.divisionId, { config: bo3 })).rejects.toMatchObject({ code: "DIVISION_FORMAT_LOCKED" });
  }, 60_000);

  it("a save that did not cause the gap is not blamed for it: an unrelated edit passes over a legacy stage already missing 3-2; an edit ADDING unpaid scores still refuses", async () => {
    const auth = await seedOrg("pro");
    const cfg = indoor() as Record<string, unknown> & { setTo: number };
    const short: PointsRule = { ...FIVB_OWN, bySetScore: { "3-0": [3, 0], "3-1": [3, 0] } };
    const already = unpaid(vb, cfg, short);
    expect(already.ok === false && already.uncovered, "premise: the legacy table misses 3-2").toEqual(["set:3-2"]);
    const { divisionId } = await seedDivision(auth, "volleyball", "indoor");
    const s = await seedStage(auth, divisionId, 1, "league");
    // A legacy stage: a table no door writes now (the PUT refuses it); a row from before can hold it.
    const legacy = await sql`update stages set config = config || ${sql.json({ points: short } as never)} where id = ${s}`;
    expect(legacy.count).toBe(1);
    // The unrelated edit: the set target. The unpaid scores are exactly the ones already there.
    const longer = { ...cfg, setTo: cfg.setTo - 4 };
    expect(unpaid(vb, longer, short), "premise: the same gap").toEqual(already);
    const out = await patchDivision(auth, divisionId, { config: longer });
    expect((out.config as typeof cfg).setTo).toBe(cfg.setTo - 4);
    // The positive pair, same stage: a save that makes NEW scores reachable is refused, naming only those.
    await expect(patchDivision(auth, divisionId, { config: { ...longer, bestOf: 3 } })).rejects.toMatchObject({
      status: 422, code: "POINTS_OUTCOME_UNCOVERED", extra: { stage_id: s, uncovered: ["set:2-0", "set:2-1"] },
    });
  });
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

describe.skipIf(!HAS_DB)("W2d T10 fix round 1 I2: a FLAT rule over a sport that pays an outcome its own way is refused, typed (defence in depth)", () => {
  // The editor never sends one there (it shows "can't be set per stage yet"); this is the server holding the same line for
  // any other caller. Expected splits are the rulebooks' (`_points-split-rulebook.ts`), never the guard's own answer: IIHF
  // pays an overtime/shoot-out win 2 and its loss 1, FIVB a 3-2 result 2/1, ITTF a loss not played 0 against a played one's 1.
  const IIHF_SPLITS = ["otWin", "otLoss"];

  it("ice hockey (IIHF): the editor's flat 3/0 is refused 422 POINTS_SPLIT_FLATTENED naming the splits, nothing stored; asked twice, the same; a rule that states its overtime lands; clearing lands; plain 3/1/0 on generic lands", async () => {
    const auth = await seedOrg("community");
    const { divisionId } = await seedDivision(auth, "icehockey", "iihf");
    const s = await seedStage(auth, divisionId, 1, "league");
    const flat = { ...base, tie: 0, noResult: 0, bonuses: [] };
    for (const attempt of [1, 2]) {
      await expect(putStageRules(auth, s, { points: flat }), `attempt ${attempt}`).rejects.toMatchObject({
        status: 422,
        code: "POINTS_SPLIT_FLATTENED",
        extra: { splits: IIHF_SPLITS },
      });
      expect((await stageConfig(s)).points ?? null, `attempt ${attempt}: nothing stored`).toBeNull();
    }
    // An API caller who means one amount says so per outcome: it is not flat, so it is the caller's choice and lands.
    const stated = { ...flat, win: { regulation: 3, ot: 3 }, loss: { regulation: 0, ot: 0 } };
    await putStageRules(auth, s, { points: stated });
    expect((await stageConfig(s)).points, "the stated rule is stored").toMatchObject({ win: { regulation: 3, ot: 3 } });
    await putStageRules(auth, s, { points: null });
    expect((await stageConfig(s)).points ?? null, "clearing flattens nothing").toBeNull();
    // The positive pair: a sport the flat rule says whole.
    const g = await seedDivision(auth, "generic", "score");
    const gs = await seedStage(auth, g.divisionId, 1, "league");
    await putStageRules(auth, gs, { points: flat });
    expect((await stageConfig(gs)).points, "generic 3/1/0 lands").toMatchObject({ win: { regulation: 3 } });
  });

  it("another sport and another door: table tennis's loss not played on the stage PUT; indoor volleyball's 3-2 on createStages, the batch writing no stage", async () => {
    const auth = await seedOrg("community");
    const tt = await seedDivision(auth, "tabletennis", "bo5");
    const ts = await seedStage(auth, tt.divisionId, 1, "league");
    const flatTt = { win: { regulation: 2 }, loss: { regulation: 1 }, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [] };
    await expect(putStageRules(auth, ts, { points: flatTt })).rejects.toMatchObject({ status: 422, code: "POINTS_SPLIT_FLATTENED", extra: { splits: ["unplayed"] } });
    const vb = await seedDivision(auth, "volleyball", "indoor");
    const flatVb = { win: { regulation: 3 }, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [] };
    await expect(
      createStages(auth, vb.divisionId, [
        { seq: 1, kind: "league", name: "A", config: {}, progression: null },
        { seq: 2, kind: "league", name: "B", config: { points: flatVb }, progression: null },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "POINTS_SPLIT_FLATTENED", extra: { stage_name: "B", splits: ["pointsMap"] } });
    expect(await stageCount(vb.divisionId), "the batch wrote nothing").toBe(0);
    // The same door takes the stage's own set-score table (it is not flat).
    const [own] = await createStages(auth, vb.divisionId, { seq: 1, kind: "league", name: "A", config: { points: FIVB_OWN }, progression: null });
    expect((await stageConfig(own!.id)).points, "FIVB's own table lands").toMatchObject({ bySetScore: FIVB_OWN.bySetScore });
  });

  it("cricket's tie and no result are not splits a flat rule loses (it carries both): a flat rule naming them lands; the editor's state is what keeps its 0s off cricket", async () => {
    const auth = await seedOrg("community");
    const { divisionId } = await seedDivision(auth, "cricket", "t20");
    const s = await seedStage(auth, divisionId, 1, "league");
    const icc = { win: { regulation: 2 }, loss: { regulation: 0 }, tie: 1, noResult: 1, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [] };
    await putStageRules(auth, s, { points: icc });
    expect((await stageConfig(s)).points, "a flat cricket rule lands").toMatchObject({ tie: 1, noResult: 1 });
  });
});

describe.skipIf(!HAS_DB)("ST-G8 over the real HTTP route", () => {
  it("W2d T10: 422 POINTS_OUTCOME_UNCOVERED carries the outcomes, and a client says it in the reader's language", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    const { divisionId } = await seedDivision(auth, "cricket", "t20");
    const s = await seedStage(auth, divisionId, 1, "league");
    const res = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { points: base }), ctx(s));
    const body = (await res.json()) as Body;
    expect(res.status).toBe(422);
    expect(body.error).toMatchObject({ code: "POINTS_OUTCOME_UNCOVERED", uncovered: ["tie"] });
    expect(body.error!.message).toBe(ruleErrorMessage("POINTS_OUTCOME_UNCOVERED", { uncovered: ["tie"] }));
    expect(body.error!.message, "the English says the outcome in words, not its key").toContain(msg("rules.err.outcome.tie" as never));
    const text = ruleRefusalText(body.error!.code, body.error, msgEs as never);
    expect(text, "the client can say it").not.toBeNull();
    expect(text).toBe(msgEs("rules.err.pointsOutcomeUncovered", { outcome: msgEs("rules.err.outcome.tie") }));
    expect(text).not.toBe(body.error!.message);
    expect(ruleRefusalText(body.error!.code, body.error, msg), "the en client sentence IS the server's").toBe(body.error!.message);
  });

  it("fix round 1 I2: over HTTP a flat rule on IIHF ice hockey is 422 POINTS_SPLIT_FLATTENED with its splits, and a client says it in the reader's language", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    const { divisionId } = await seedDivision(auth, "icehockey", "iihf");
    const s = await seedStage(auth, divisionId, 1, "league");
    const res = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { points: base }), ctx(s));
    const body = (await res.json()) as Body;
    expect(res.status).toBe(422);
    expect(body.error).toMatchObject({ code: "POINTS_SPLIT_FLATTENED", splits: ["otWin", "otLoss"] });
    expect(body.error!.message).toBe(ruleErrorMessage("POINTS_SPLIT_FLATTENED", { splits: ["otWin", "otLoss"] }));
    const text = ruleRefusalText(body.error!.code, body.error, msgEs as never);
    expect(text, "the client can say it").toBe(
      msgEs("rules.err.pointsRuleInexpressible", {
        reason: msgEs("rules.err.pointsSplit", { fields: [msgEs("rules.err.pointsSplit.otWin"), msgEs("rules.err.pointsSplit.otLoss")].join(", ") }),
      }),
    );
    expect(ruleRefusalText(body.error!.code, body.error, msg), "the en client sentence IS the server's").toBe(body.error!.message);
  });

  it("over HTTP the base rule lands 200 with the stored rule in the answer, and so does a bonus rule (X-PT-1; all scoring is free)", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const s = await seedStage(auth, divisionId, 1, "league");
    const ok = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { points: base }), ctx(s));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Body).data).toMatchObject({ points: base, rules: null });
    const bonus = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { points: withBonus }), ctx(s));
    expect(bonus.status).toBe(200);
    expect(((await bonus.json()) as Body).data).toMatchObject({ points: { bonuses: [{ when: "forfeit_loss" }] } });
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

  // W2c Task 13b finish-up (R-13b-1 at the HTTP layer): the zod refusal's set is the ENGINE's deciders, the one the
  // create door uses, so a decider that is neither `shootout` nor `extraTime` gets the same named 400 over the real
  // routes, never zod's "Invalid input" (which would leave the door's named refusal unreachable: M-6 pt4).
  it("R-13b-1 a top-level decider only the engine declares (superOver, tiebreakRungs, tieBoard, overtime) is refused NAMING the key on all three routes; nothing written", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    const { divisionId } = await seedDivision(auth, "cricket", "t20");
    const s = await seedStage(auth, divisionId, 1, "knockout");
    const before = await stageConfig(s);
    const engineOnly = [...new Set((builtinModules as readonly AnySportModule[]).flatMap((m) => deciderKeysFor(m, null, null)))].filter(
      (k) => k !== "shootout" && k !== "extraTime",
    );
    expect(engineOnly, "the premise: deciders the API never named before").toEqual(expect.arrayContaining(["superOver", "tiebreakRungs", "tieBoard", "overtime"]));
    let checked = 0;
    for (const key of engineOnly) {
      const put = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { [key]: false }), ctx(s));
      const putBody = (await put.json()) as Body;
      expect(put.status, `PUT rules ${key}`).toBe(400);
      expect(putBody.error, `PUT rules ${key}`).toMatchObject({ code: "VALIDATION", field: key });
      expect(putBody.error!.message, `PUT rules ${key}: says where it goes`).toContain(`rules.${key}`);

      const post = await postStagesRoute(
        keyed(secret, "POST", `/divisions/${divisionId}/stages`, { seq: 2, kind: "knockout", name: "Two", config: { [key]: false } }),
        ctx(divisionId),
      );
      const postBody = (await post.json()) as Body;
      expect(post.status, `POST ${key}`).toBe(400);
      expect(postBody.error, `POST ${key}`).toMatchObject({ code: "VALIDATION", field: `config.${key}` });
      expect(postBody.error!.message, `POST ${key}`).toContain(`config.rules.${key}`);

      const replace = await putStagesRoute(
        keyed(secret, "PUT", `/divisions/${divisionId}/stages`, [{ seq: 1, kind: "knockout", name: "One", config: { [key]: false } }]),
        ctx(divisionId),
      );
      const replaceBody = (await replace.json()) as Body;
      expect(replace.status, `PUT stages ${key}`).toBe(400);
      expect(replaceBody.error, `PUT stages ${key}`).toMatchObject({ code: "VALIDATION", field: `[0].config.${key}` });
      expect(replaceBody.error!.message, `PUT stages ${key}`).toContain(`[0].config.rules.${key}`);
      checked++;
    }
    expect(checked, "anti-vacuity: every engine-only decider over the three routes").toBe(engineOnly.length);
    expect(await stageConfig(s), "nothing written").toEqual(before);
    expect(await stageCount(divisionId)).toBe(1);
    // The positive pair: the same key under `rules` is a match rule the cricket knockout takes.
    const ok = await putRulesRoute(keyed(secret, "PUT", `/stages/${s}/rules`, { rules: { superOver: false } }), ctx(s));
    expect(ok.status, "superOver under rules saves").toBe(200);
  });
});

// Batch 4 review M6 (ruling M6). `config.points: null` in a stage input at create or replace is the same word the stage PUT
// uses (`{points: null}` removes the rule): NO points for this slot. Before, the schema let the null through
// (`points: z.unknown()`), then `PointsRule.parse(null)` threw a raw ZodError at the batch gates, so with R-T13-1's carry an
// Apply could never clear a carried rule. A null drops the carry, asks the points checks nothing, and is not stored.
describe.skipIf(!HAS_DB)("M6 config.points: null at create and replace means no points for this slot", () => {
  const league = (seq: number, name: string, config: Record<string, unknown> = {}) =>
    ({ seq, kind: "league" as const, name, config, progression: null });
  const storedKeys = async (stageId: string): Promise<string[]> => Object.keys(await stageConfig(stageId));

  it("createStages: null stores no points key at all, on a table stage and on a bracket stage; the base rule still stores", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const [table, bracket] = await createStages(auth, divisionId, [
      league(1, "Pool", { points: null }),
      { seq: 2, kind: "knockout", name: "KO", config: { points: null }, progression: null },
    ]);
    expect(await storedKeys(table!.id), "no points key (not a stored null)").not.toContain("points");
    expect(await storedKeys(bracket!.id), "a bracket stage takes the null too: there is nothing to refuse").not.toContain("points");
    // The positive pair: the same door stores a rule that is sent.
    const other = await seedDivision(auth, "badminton", "short");
    const [kept] = await createStages(auth, other.divisionId, league(1, "Pool", { points: base }));
    expect((await stageConfig(kept!.id)).points).toMatchObject(base);
  });

  it("the null: createStages and replaceStages take `points: null` (no points for this slot) and store none", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    await createStages(auth, divisionId, league(1, "Pool", { points: null }));
    await replaceStages(auth, divisionId, league(1, "Pool", { points: null }));
    const ids = await stageIds(divisionId);
    expect(ids.length).toBe(1);
    expect(await storedKeys(ids[0]!), "no null stored").not.toContain("points");
  });

  it("Apply: a body's null clears the carried points; a body that says nothing still carries them (the pair)", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: withForfeit });
    // Absent: carried (R-T13-1).
    await replaceStages(auth, divisionId, [league(1, "Pool")]);
    expect((await pointsBySeq(divisionId)).get(1), "absent points still carry").toMatchObject(withForfeit);
    // Null: cleared, and the stage is a new row (the Apply happened).
    const before = await stageIds(divisionId);
    await replaceStages(auth, divisionId, [league(1, "Pool", { points: null })]);
    const after = await stageIds(divisionId);
    expect(after.length).toBe(1);
    expect(after, "the Apply replaced the row").not.toEqual(before);
    expect((await pointsBySeq(divisionId)).get(1) ?? null, "null cleared the carried points").toBeNull();
    expect(await storedKeys(after[0]!), "and stored no null in their place").not.toContain("points");
    // Sequence: with nothing left to carry, the next Apply has none to carry.
    await replaceStages(auth, divisionId, [league(1, "Pool")]);
    expect((await pointsBySeq(divisionId)).get(1) ?? null, "a second Apply: still none").toBeNull();
  });

  it("a points value that is not a rule is still refused, so the null is not 'ignore whatever is sent'", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    await expect(createStages(auth, divisionId, league(1, "Pool", { points: "three" }))).rejects.toMatchObject({ name: "ZodError" });
    expect(await stageCount(divisionId)).toBe(0);
  });

  it("over the real routes: POST and PUT /divisions/{id}/stages accept `config.points: null` (201 / 200), never a 400", async () => {
    const auth = await seedOrg("enterprise");
    const secret = await keyFor(auth);
    const { divisionId } = await seedDivision(auth, "badminton", "short");
    const post = await postStagesRoute(
      keyed(secret, "POST", `/divisions/${divisionId}/stages`, { seq: 1, kind: "league", name: "Pool", config: { points: null } }),
      ctx(divisionId),
    );
    const posted = (await post.json()) as Body;
    expect(posted.error, "no refusal over the wire").toBeUndefined();
    expect(post.status).toBe(201);
    const put = await putStagesRoute(
      keyed(secret, "PUT", `/divisions/${divisionId}/stages`, [{ seq: 1, kind: "league", name: "Pool", config: { points: null } }]),
      ctx(divisionId),
    );
    const replaced = (await put.json()) as Body;
    expect(replaced.error, "no refusal over the wire").toBeUndefined();
    expect(put.status).toBe(200);
    expect(await stageCount(divisionId)).toBe(1);
  });
});
