// C38 (matrix row group_group_ko, ST-G5 "pool of one"): groups -> groups -> knockout (the t20-super8 shape: 4 pools,
// then 2, then a bracket) with 7 entrants. Seven snaked into four pools leave pool A holding seed 1 ALONE: a pool's
// membership is its fixtures, so seed 1 stood in no pool, its table was empty, and stage 1's /complete answered 409
// STAGE_COMPLETED_SEEDING_FAILED ("no pool A in the source stage"). The product's own rule, already enforced on the
// setup path (setup-fixtures.ts F2a) and worded by the plain path's all-or-nothing guard, is "each group needs at
// least 2": the plain path now refuses a FIRST generate that strands an entrant, by name, before anything is written.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { EngineError } from "@seazn/engine/core";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal, rebuildStageFixtures } from "../stages";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const FIRST_POOLS = 4; // t20-super8.json: the product's one group -> group -> knockout shape
const SECOND_POOLS = 2;
const TAKE = 2;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Gg " + suffix}, ${"gg-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })}) on conflict (key) do nothing`;
  await sql`insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(CFG)}, true) on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function rig(n: number, sport?: { key: string; variant: string; config: Record<string, unknown> }, kind: "individual" | "team" = "individual") {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "G " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: sport?.key ?? "generic", variant_key: sport?.variant ?? "score", config: sport?.config ?? CFG,
  } as never);
  const entrants = await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => ({
    kind, display_name: "E" + (i + 1), seed: i + 1, members: [],
  })));
  const feed = (placement: string) => ({ sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: TAKE }] }], placement, timing: "setup" });
  const stages = await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "First groups", config: { pools: { count: FIRST_POOLS } } },
    { seq: 2, kind: "group", name: "Second groups", config: { pools: { count: SECOND_POOLS } }, progression: feed("snake") },
    { seq: 3, kind: "knockout", name: "Knockout", config: {}, progression: feed("rank_order") },
  ] as never);
  return { auth, division, entrants, stages: stages as { id: string }[] };
}

const TOO_FEW = (err: unknown) => EngineError.is(err, "STAGE_NOT_READY") && (err.data as { reason?: string }).reason === "group_too_few_entrants";
const fixtureIds = async (stageId: string) => (await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} order by id`).map((r) => r.id);

const stageCounts = async (stageId: string) => {
  const [{ f }] = await sql<{ f: string }[]>`select count(*)::text as f from fixtures where stage_id = ${stageId}`;
  const [{ p }] = await sql<{ p: string }[]>`select count(*)::text as p from pools where stage_id = ${stageId}`;
  return { fixtures: Number(f), pools: Number(p) };
};

/** Every fixture of the stage decided, home wins 2-0 (the generic result event). */
async function decideAll(auth: AuthCtx, stageId: string) {
  const fx = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null`;
  for (const f of fx) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }
  return fx.length;
}

/** The pools of a stage as its fixtures name them: pool key -> the entrants that play in it. */
async function poolsOf(stageId: string) {
  const rows = await sql<{ key: string | null; e: string }[]>`
    select p.key, x.e from fixtures f left join pools p on p.id = f.pool_id,
    lateral (values (f.home_entrant_id), (f.away_entrant_id)) as x(e)
    where f.stage_id = ${stageId} and x.e is not null`;
  const m = new Map<string, Set<string>>();
  for (const r of rows) m.set(r.key ?? "", (m.get(r.key ?? "") ?? new Set()).add(r.e));
  return m;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql; g._sql = undefined; await c?.end();
});

describe.skipIf(!HAS_DB)("group -> group -> knockout: a pool of one is refused by name, never stranded (C38)", () => {
  it("7 entrants into 4 pools: the first Generate is refused group_too_few_entrants (need 8), and writes nothing", async () => {
    const r = await rig(7);
    await expect(generateStageFixtures(r.auth, r.stages[0]!.id)).rejects.toSatisfy((err: unknown) => {
      if (!EngineError.is(err, "STAGE_NOT_READY")) return false;
      const d = err.data as { reason?: string; groups?: number; entrants?: number; required?: number };
      return d.reason === "group_too_few_entrants" && d.groups === 4 && d.entrants === 7 && d.required === 8;
    });
    // The refusal rolled the pools rows back with it: nothing half-built to strand seed 1.
    expect(await stageCounts(r.stages[0]!.id)).toEqual({ fixtures: 0, pools: 0 });
  });

  it("sweep: 2..12 entrants - every field the rule leaves with a pool under 2 is refused, every other is drawn with all seated", async () => {
    let checked = 0, refused = 0, drawn = 0;
    for (let n = 2; n <= 12; n++) {
      const r = await rig(n);
      // The rule, from the product's stated words ("each group needs at least 2"), not from the code under test:
      // a seeded snake deals n into 4 pools of floor(n/4) or ceil(n/4); the smallest is floor(n/4).
      const smallest = Math.floor(n / FIRST_POOLS);
      checked++;
      if (smallest < 2) {
        refused++;
        await expect(generateStageFixtures(r.auth, r.stages[0]!.id), `n=${n}`).rejects.toSatisfy((err: unknown) => EngineError.is(err, "STAGE_NOT_READY"));
        expect(await stageCounts(r.stages[0]!.id), `n=${n}`).toEqual({ fixtures: 0, pools: 0 });
      } else {
        drawn++;
        await generateStageFixtures(r.auth, r.stages[0]!.id);
        const pools = await poolsOf(r.stages[0]!.id);
        expect(pools.size, `n=${n}`).toBe(FIRST_POOLS);
        for (const [k, members] of pools) expect(members.size, `n=${n} pool ${k}`).toBeGreaterThanOrEqual(2);
        const seated = new Set([...pools.values()].flatMap((s) => [...s]));
        expect(seated.size, `n=${n}: every entrant is in a pool`).toBe(n);
      }
    }
    expect(checked, "anti-vacuity").toBe(11);
    expect(refused, "anti-vacuity: refused side reached").toBe(6); // n = 2..7
    expect(drawn, "anti-vacuity: drawn side reached").toBe(5); // n = 8..12
  });

  it("neighbour 8: stage 1 completes, seed 1 is in a pool, and every one of the eight qualifiers is seated in the second stage", async () => {
    const r = await rig(8);
    const [s1, s2] = r.stages;
    await generateStageFixtures(r.auth, s2!.id); // the setup-timing TBD shells, as the division builds them
    await generateStageFixtures(r.auth, r.stages[2]!.id);
    await generateStageFixtures(r.auth, s1!.id);
    const seed1 = r.entrants[0]!.id;
    expect([...(await poolsOf(s1!.id)).values()].some((m) => m.has(seed1)), "seed 1 stands in a pool").toBe(true);
    expect(await decideAll(r.auth, s1!.id)).toBeGreaterThan(0);
    const done = await completeStage(r.auth, s1!.id);
    expect(done.completed).toBe(true);
    const proposal = await getSeedProposal(r.auth, s2!.id);
    expect(proposal, "stage 1's completion prepared stage 2's proposal").not.toBeNull();
    await confirmSeedProposal(r.auth, s2!.id, { proposalId: proposal!.id });
    const seatedIn2 = new Set([...(await poolsOf(s2!.id)).values()].flatMap((s) => [...s]));
    expect(seatedIn2.size).toBe(FIRST_POOLS * TAKE);
    expect(seatedIn2.has(seed1)).toBe(true);
  });

  it("a withdrawal AFTER the draw leaves a pool of one entrant on the board and stage 1 still completes (existing fixtures are not re-judged)", async () => {
    const r = await rig(8);
    const [s1, s2] = r.stages;
    await generateStageFixtures(r.auth, s2!.id);
    await generateStageFixtures(r.auth, r.stages[2]!.id);
    await generateStageFixtures(r.auth, s1!.id);
    await patchEntrant(r.auth, r.entrants[7]!.id, { status: "withdrawn" });
    await decideAll(r.auth, s1!.id);
    const done = await completeStage(r.auth, s1!.id);
    expect(done.completed).toBe(true);
    expect(await getSeedProposal(r.auth, s2!.id)).not.toBeNull();
  });

  it("I2a: a SECOND Generate after a withdrawal on an already-drawn stage is not refused and changes nothing (the draw stands)", async () => {
    const r = await rig(8);
    await generateStageFixtures(r.auth, r.stages[0]!.id);
    const before = await fixtureIds(r.stages[0]!.id);
    expect(before.length, "premise: drawn").toBeGreaterThan(0);
    await patchEntrant(r.auth, r.entrants[7]!.id, { status: "withdrawn" }); // 7 active in 4 pools - the refused field, but already drawn
    await expect(generateStageFixtures(r.auth, r.stages[0]!.id)).resolves.toBeDefined();
    expect(await fixtureIds(r.stages[0]!.id)).toEqual(before);
  });

  it("I2b: a withdrawal BEFORE the draw is judged on the live field - 8 with one out is refused, 9 with one out is drawn", async () => {
    const out = await rig(8);
    await patchEntrant(out.auth, out.entrants[7]!.id, { status: "withdrawn" });
    await expect(generateStageFixtures(out.auth, out.stages[0]!.id)).rejects.toSatisfy(TOO_FEW);
    expect(await stageCounts(out.stages[0]!.id)).toEqual({ fixtures: 0, pools: 0 });
    const ok = await rig(9);
    await patchEntrant(ok.auth, ok.entrants[8]!.id, { status: "withdrawn" });
    await generateStageFixtures(ok.auth, ok.stages[0]!.id);
    expect((await poolsOf(ok.stages[0]!.id)).size).toBe(FIRST_POOLS);
  });

  it("I2c: Rebuild of a drawn, unstarted stage after a withdrawal into the refused field is refused whole - the draw is kept", async () => {
    const r = await rig(8);
    await generateStageFixtures(r.auth, r.stages[0]!.id);
    const before = await fixtureIds(r.stages[0]!.id);
    await patchEntrant(r.auth, r.entrants[7]!.id, { status: "withdrawn" });
    await expect(rebuildStageFixtures(r.auth, r.stages[0]!.id)).rejects.toSatisfy(TOO_FEW);
    expect(await fixtureIds(r.stages[0]!.id)).toEqual(before);
  });

  it("control: a knockout-only division of 7 is not a group stage - drawn, nobody refused", async () => {
    const auth = await seedOrg();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "K " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: CFG } as never);
    await createEntrants(auth, division.id, Array.from({ length: 7 }, (_, i) => ({ kind: "individual" as const, display_name: "K" + (i + 1), seed: i + 1, members: [] })));
    const [ko] = (await createStages(auth, division.id, [{ seq: 1, kind: "knockout", name: "KO", config: {} }] as never)) as { id: string }[];
    await generateStageFixtures(auth, ko!.id);
    expect((await stageCounts(ko!.id)).fixtures).toBeGreaterThan(0);
  });

  it("control: a ladder names no fixture at generate (challenges come later) yet is never refused - the guard is the group stage's alone", async () => {
    const auth = await seedOrg();
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "L " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: CFG } as never);
    await createEntrants(auth, division.id, Array.from({ length: 7 }, (_, i) => ({ kind: "individual" as const, display_name: "L" + (i + 1), seed: i + 1, members: [] })));
    const [lad] = (await createStages(auth, division.id, [{ seq: 1, kind: "ladder", name: "Ladder", config: {} }] as never)) as { id: string }[];
    await expect(generateStageFixtures(auth, lad!.id)).resolves.toBeDefined();
  });

  it("another sport: a football division refuses the same 7-into-4 field by the same name", async () => {
    const [v] = await sql<{ sport_key: string; key: string; config: Record<string, unknown> }[]>`
      select sport_key, key, config from sport_variants where sport_key = 'football' and is_system order by key limit 1`;
    expect(v, "premise: football has a system variant (sync:sports ran)").toBeDefined();
    const r = await rig(7, { key: v!.sport_key, variant: v!.key, config: v!.config }, "team");
    await expect(generateStageFixtures(r.auth, r.stages[0]!.id)).rejects.toMatchObject({ code: "STAGE_NOT_READY", data: { reason: "group_too_few_entrants" } });
  });
});
