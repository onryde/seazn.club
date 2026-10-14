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
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, replaceStages } from "../stages";
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

/** One stage to lose (its id is the witness): the premise every "untouched" assertion below rests on. */
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

  it("a nonexistent division, or another org's, is 404 before any gate's 402; the other org's stages untouched", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "standings.custom_points");
    await expect(replaceStages(auth, randomUUID(), [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 404 });
    const other = await seedOrg("pro");
    const theirs = await seededGraph(other);
    await expect(replaceStages(auth, theirs.divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 404 });
    expect(await stageIds(theirs.divisionId)).toEqual(theirs.before);
    // The positive pair: the same body on the denied org's OWN division answers the gate's 402.
    const own = await seededGraph(auth);
    await expect(replaceStages(auth, own.divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 402 });
  });
});

describe.skipIf(!HAS_DB)("R-T13-3 replaceStages deletes and inserts in ONE transaction: any later refusal rolls the delete back", () => {
  // A stage at seq 1 that names "previous" as its source: nothing in the batch gates reads progression sources, so
  // the refusal comes from `validateStageProgression`, AFTER the inserts (stage-seeding.ts, SEEDING_RULES_MISSING).
  const fromPrevious = {
    sources: [{ stage: "previous" as const, take: [{ kind: "rankRange" as const, from: 1, to: 2 }] }],
    placement: "rank_order" as const,
    timing: "on_complete" as const,
  };

  it("a progression refused after the inserts (SEEDING_RULES_MISSING) leaves the original stages untouched", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    await expect(
      replaceStages(auth, divisionId, [{ seq: 1, kind: "league", name: "First", config: {}, progression: fromPrevious }]),
    ).rejects.toMatchObject({ status: 422, code: "SEEDING_RULES_MISSING" });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("a refusal from inside the insert loop (the database's progression shape check) leaves the original stages untouched", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    // No schema stands in front of the usecase: a placement the column's CHECK refuses reaches the INSERT itself.
    const badShape = { ...fromPrevious, placement: "not-a-placement" } as unknown as typeof fromPrevious;
    await expect(
      replaceStages(auth, divisionId, [league(1), { seq: 2, kind: "league", name: "Bad", config: {}, progression: badShape }]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("the positive pair: a valid graph with a progression from the previous stage commits", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    const out = await replaceStages(auth, divisionId, [league(1), { seq: 2, kind: "knockout", name: "Cup", config: {}, progression: fromPrevious }]);
    expect(out.map((r) => r.seq)).toEqual([1, 2]);
    const after = await stageIds(divisionId);
    expect(after.length).toBe(2);
    expect(after).not.toContain(before[0]);
  });
});

describe.skipIf(!HAS_DB)("fix round 2 (c): Apply on a LOCKED division answers FORMAT_LOCKED before any gate", () => {
  it("fixtures exist + a gated body = 409 FORMAT_LOCKED, never the 402; nothing changes", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "standings.custom_points");
    const { divisionId } = await seedDivision(auth);
    await createEntrants(
      auth,
      divisionId,
      ["A", "B"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, divisionId, [league(1)]);
    await generateStageFixtures(auth, stage!.id);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stage!.id}`;
    expect(n, "premise: fixtures exist, so the format is locked").toBeGreaterThan(0);
    const before = await stageIds(divisionId);
    await expect(replaceStages(auth, divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({
      status: 409,
      code: "FORMAT_LOCKED",
    });
    expect(await stageIds(divisionId)).toEqual(before);
    // The positive pair: the same gated body on an UNLOCKED division of the same org still answers the gate's 402.
    const open = await seededGraph(auth);
    await expect(replaceStages(auth, open.divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 402 });
  });
});

/** Backends waiting on a lock `pid` holds (the departed-seat-stage-lock.test.ts witness). */
async function waitersOn(pid: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`select pid from pg_locks where not granted and ${pid} = any(pg_blocking_pids(pid))`;
  return [...new Set(rows.map((r) => r.pid))];
}

/** A bounded poll on database state — it proves a wait, it never stands in for one. */
async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!HAS_DB)("fix round 3 N1: the FORMAT_LOCKED check UNDER the division lock is the guard, not the pre-read", () => {
  it("a fixture committed while Apply waits on the division lock is read under it: 409 FORMAT_LOCKED, the stages and the fixture intact", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    let apply!: Promise<unknown>;
    let settled = false;
    let fixtureId = "";
    await sql.begin(async (holder) => {
      // The exact key replaceStages takes (and patchDivision, and the generators): hashtext('division:' || id).
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      apply = replaceStages(auth, divisionId, [league(1)]);
      apply.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Its pre-read finds no fixture (none exists yet) and lets it through to the gates; it then parks on this lock.
      await until("Apply parks behind the held division lock", async () => (await waitersOn(held!.pid)).length === 1);
      expect(settled, "Apply is blocked on the lock, not finished").toBe(false);
      // A fixture lands while Apply waits, as a generator holding the same lock writes one.
      const [f] = await holder<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
        values (${before[0]!}, ${divisionId}, ${auth.orgId}, 1, 0, 'race', 'scheduled') returning id`;
      fixtureId = f!.id;
    }); // commits: Apply takes the lock and must read the fixture that exists now
    await expect(apply).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });
    expect(await stageIds(divisionId), "the stage graph stands").toEqual(before);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where id = ${fixtureId}`;
    expect(n, "the fixture the delete would have cascaded away is still there").toBe(1);
  });
});
