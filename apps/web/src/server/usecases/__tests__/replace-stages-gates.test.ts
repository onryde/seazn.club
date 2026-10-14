// W2c Task 13 fix round 1, ruling R-T13-2. `replaceStages` (the Format tab's Apply) deletes the division's stage graph
// in its own committed transaction and then calls `createStages`. Every refusal `createStages` raised from its INPUT
// after that point (the entitlement gates, the stage cap, the feed-graph check, a duplicate seq in the body) landed
// after the delete: a 402 or a 409 on Apply emptied the division. `assertStageBatchGates` now asks them all BEFORE
// the delete. The witness for "untouched" is the division's stage ids, in board order: the same count AND the same
// rows (a refused Apply that recreated identical stages would still be a loss of every row's id).
//
// Expected values come from the entitlement table itself (`getLimit`) and the feature keys the gates name, never from a
// typed plan table. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createStages, replaceStages } from "../stages";
import { makeUser } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

async function seedOrg(plan: "pro" | "community"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by) values (${"Rg " + suffix}, ${"rg-" + suffix}, ${owner.id})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: owner.id, role: "owner", keyId: null };
}

/** A DENY override beats the plan: the one lever that withholds a feature a plan grants (custom-points.test.ts). */
async function denyFeature(orgId: string, featureKey: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, ${featureKey}, false, 'test')
    on conflict (org_id, feature_key) do update set bool_value = false`;
  await invalidateOrgEntitlements(orgId);
}

async function seedDivision(auth: AuthCtx): Promise<{ divisionId: string; competitionId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Rg Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "short",
    config: {},
  });
  return { divisionId: division.id, competitionId: comp.id };
}

const league = (seq: number, config: Record<string, unknown> = {}) =>
  ({ seq, kind: "league" as const, name: `L${seq}`, config, progression: null });

const stageIds = async (divisionId: string): Promise<string[]> =>
  (await sql<{ id: string }[]>`select id from stages where division_id = ${divisionId} order by seq`).map((r) => r.id);

/** Two stages to lose: the premise every "untouched" assertion below rests on. */
async function seededGraph(auth: AuthCtx): Promise<{ divisionId: string; competitionId: string; before: string[] }> {
  const d = await seedDivision(auth);
  await createStages(auth, d.divisionId, [league(1)]);
  const before = await stageIds(d.divisionId);
  expect(before.length, "premise: a stage graph to lose").toBe(1);
  return { ...d, before };
}

const withForfeit = { base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3, loserPoints: 0 } };

describe.skipIf(!HAS_DB)("R-T13-2 replaceStages asks every batch gate BEFORE its delete", () => {
  it("the positive pair first: a clean Apply replaces the graph (new rows)", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    await replaceStages(auth, divisionId, [league(1), league(2)]);
    const after = await stageIds(divisionId);
    expect(after.length).toBe(2);
    expect(after).not.toContain(before[0]);
  });

  it("a custom_points 402 leaves the original stages untouched (count and ids)", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "standings.custom_points");
    const { divisionId, before } = await seededGraph(auth);
    await expect(replaceStages(auth, divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({
      status: 402,
      featureKey: "standings.custom_points",
    });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("a formats.double_elim 402 leaves the original stages untouched (count and ids)", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "formats.double_elim");
    const { divisionId, before } = await seededGraph(auth);
    await expect(
      replaceStages(auth, divisionId, [{ seq: 1, kind: "double_elim", name: "DE", config: {}, progression: null }]),
    ).rejects.toMatchObject({ status: 402, featureKey: "formats.double_elim" });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("the stage cap's 402, counted against the batch, leaves the original stages untouched", async () => {
    const auth = await seedOrg("community");
    const { divisionId, competitionId, before } = await seededGraph(auth);
    const cap = await getLimit(auth.orgId, "stages.per_division.max", competitionId);
    expect(cap, "premise: Community caps the stages per division").not.toBeNull();
    const body = Array.from({ length: cap! + 1 }, (_, i) => league(i + 1));
    await expect(replaceStages(auth, divisionId, body)).rejects.toMatchObject({
      status: 402,
      featureKey: "stages.per_division.max",
    });
    expect(await stageIds(divisionId)).toEqual(before);
    // The positive pair at the cap itself: exactly `cap` stages lands.
    await replaceStages(auth, divisionId, body.slice(0, cap!));
    expect((await stageIds(divisionId)).length).toBe(cap);
  });

  it("a duplicate seq inside the body is 409 and leaves the original stages untouched", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    await expect(replaceStages(auth, divisionId, [league(1), { ...league(1), name: "Twin" }])).rejects.toMatchObject({
      status: 409,
    });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("a nonexistent division is 404 before any gate's 402", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "standings.custom_points");
    await expect(replaceStages(auth, randomUUID(), [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 404 });
  });
});
