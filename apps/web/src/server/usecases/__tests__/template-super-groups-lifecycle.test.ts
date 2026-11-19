// X-BD-3 (rulebook RB5-S2): the super-groups template's OWN stages, played end to end. The creation tests prove the card builds
// the right rows; this one plays them: for every field size the card offers, the template's three stages are generated,
// decided, completed and CONFIRMED through both group tiers and the knockout, and the seats each confirm writes are the rule's.
//
// Sport: generic, individual entrants - the draw, the progression and the confirm read entrant ids and seeds, never a sport rule
// (single-sport, by this one reason; the per-sport instantiate sweep is template-instantiate-any.test.ts).
// Results are decided by SEED (the better seed wins), never "home always wins": that leaves every 3-entrant pool a
// three-way tie on points and a flagged tie at the confirm, which is a refusal, not a lifecycle.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "../scoring";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { getTemplate } from "@/server/templates/catalog";
import { createFromTemplate } from "../templates";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, generateStageFixtures, getSeedProposal } from "../stages";
import { confirmResolvingTies } from "./_confirm-with-ties";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = "super-groups";
// The rule's own numbers (brief, Task 15; the card's copy): pools of 4, the top 2 of each pool go on, two super groups, a knockout of 4.
const POOL_SIZE = 4;
const TAKE = 2;
const SUPER_GROUPS = 2;
const KNOCKOUT = 4;
const pairs = (k: number) => (k * (k - 1)) / 2;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sg " + suffix}, ${"sg-" + suffix}) returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const mod = builtinModules.find((m) => m.key === "generic")!;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${mod.key}, ${mod.key}, ${mod.version}, ${sql.json(mod.positions as never)}) on conflict (key) do nothing`;
  for (const [variantKey, config] of Object.entries(mod.variants)) {
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values (${mod.key}, ${variantKey}, ${variantKey}, ${sql.json((config ?? {}) as never)}, true) on conflict do nothing`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** The card's division for `count` generic individuals: its three stages (by seq) and the entrants seeded 1..count. */
async function rig(count: number) {
  const auth = await seedOrg();
  const out = await createFromTemplate(auth, {
    template_key: KEY, name: `Sg ${count} ${randomUUID().slice(0, 6)}`, ends_on: "2030-12-31", visibility: "private",
    sport_key: "generic", variant_key: "score", entrant_kind: "individual", entrant_count: count,
  } as never);
  const divisionId = out.divisions[0]!.id;
  const stages = await sql<{ id: string; seq: number; kind: string }[]>`select id, seq, kind from stages where division_id = ${divisionId} order by seq`;
  const entrants = await createEntrants(auth, divisionId, Array.from({ length: count }, (_, i) => ({
    kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [],
  })));
  return { auth, divisionId, stages, entrants };
}

const seedOf = async (ids: string[]) =>
  new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where id in ${sql(ids)}`).map((r) => [r.id, r.seed] as const));

/** Decide every fixture of the stage that has both sides and is not in `done`: the better seed wins 2-0. Returns how many were decided. */
async function decideBySeed(auth: AuthCtx, stageId: string, done: Set<string>): Promise<number> {
  const all = await sql<{ id: string; home: string; away: string }[]>`
    select id, home_entrant_id as home, away_entrant_id as away from fixtures
    where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null`;
  const fx = all.filter((f) => !done.has(f.id));
  if (fx.length === 0) return 0;
  for (const f of fx) done.add(f.id);
  const seeds = await seedOf([...new Set(fx.flatMap((f) => [f.home, f.away]))]);
  for (const f of fx) {
    const homeWins = seeds.get(f.home)! < seeds.get(f.away)!;
    // The console's write (scoreEvent), not a raw ledger append: it is the door that advances a bracket's winner.
    await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} } as never);
    await scoreEvent(auth, f.id, { expected_seq: 1, type: "generic.result", payload: { p1Score: homeWins ? 2 : 0, p2Score: homeWins ? 0 : 2 } } as never);
  }
  return fx.length;
}

const fixtureCount = async (stageId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId}`)[0]!.n;

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
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("super-groups: the template's own stages, played through both group tiers and the knockout, for every offered field (X-BD-3)", () => {
  it("every offered count: generate, decide by seed, complete and confirm tier 1 -> tier 2 -> knockout, with the seats the rule gives", async () => {
    // The field sizes are the catalogue's own declaration, never typed here.
    const options = getTemplate(KEY)!.divisions[0]!.entrantCountOptions!;
    expect(options.length, "anti-vacuity: the card offers sizes").toBeGreaterThan(0);
    let played = 0;
    for (const count of options) {
      const label = `${count} entrants`;
      const r = await rig(count);
      expect(r.stages.map((s) => s.kind), label).toEqual(["group", "group", "knockout"]);
      const [s1, s2, s3] = r.stages;
      const done = new Set<string>();
      // The setup-timing shells first (their slots are TBD until the feeding stage is confirmed), then the first tier.
      await generateStageFixtures(r.auth, s2!.id);
      await generateStageFixtures(r.auth, s3!.id);
      await generateStageFixtures(r.auth, s1!.id);
      // Scoring is closed until the division starts (scoring.ts assertEntitledToScore).
      await startDivision(r.auth, r.divisionId);

      // Tier 1: count / 4 pools of 4, a single round robin in each.
      const firstPools = await poolsOf(s1!.id);
      expect(firstPools.size, label).toBe(count / POOL_SIZE);
      for (const [k, members] of firstPools) expect(members.size, `${label} pool ${k}`).toBe(POOL_SIZE);
      expect(await fixtureCount(s1!.id), label).toBe((count / POOL_SIZE) * pairs(POOL_SIZE));
      expect(await decideBySeed(r.auth, s1!.id, done), label).toBe((count / POOL_SIZE) * pairs(POOL_SIZE));
      expect((await completeStage(r.auth, s1!.id)).completed, label).toBe(true);

      // Confirm tier 2: the top 2 of every first pool, dealt into the two super groups of count/4 each.
      const p2 = await getSeedProposal(r.auth, s2!.id);
      expect(p2, `${label}: tier 1's completion prepared tier 2's proposal`).not.toBeNull();
      await confirmResolvingTies(r.auth, s2!.id, p2!.id);
      const secondPools = await poolsOf(s2!.id);
      const seatedIn2 = [...secondPools.values()].flatMap((s) => [...s]);
      expect(seatedIn2.length, label).toBe((count / POOL_SIZE) * TAKE);
      expect(new Set(seatedIn2).size, `${label}: no entrant twice`).toBe(seatedIn2.length);
      expect(secondPools.size, label).toBe(SUPER_GROUPS);
      for (const [k, members] of secondPools) expect(members.size, `${label} super group ${k}`).toBe(count / POOL_SIZE);
      // The decider of who qualified is the seed: every entrant seated in tier 2 is among the top 2 seeds of a first pool.
      for (const e of seatedIn2) {
        const pool = [...firstPools.values()].find((m) => m.has(e))!;
        const seeds = await seedOf([...pool]);
        const rank = [...seeds.values()].sort((a, b) => a - b).indexOf(seeds.get(e)!) + 1;
        expect(rank, `${label}: entrant seed ${seeds.get(e)} went on from 1 pool`).toBeLessThanOrEqual(TAKE);
      }
      expect(await fixtureCount(s2!.id), label).toBe(SUPER_GROUPS * pairs(count / POOL_SIZE));
      expect(await decideBySeed(r.auth, s2!.id, done), label).toBe(SUPER_GROUPS * pairs(count / POOL_SIZE));
      expect((await completeStage(r.auth, s2!.id)).completed, label).toBe(true);

      // Confirm the knockout: the top 2 of each super group, four seats.
      const p3 = await getSeedProposal(r.auth, s3!.id);
      expect(p3, `${label}: tier 2's completion prepared the knockout's proposal`).not.toBeNull();
      await confirmResolvingTies(r.auth, s3!.id, p3!.id);
      const seatedInKo = new Set(
        (await sql<{ e: string }[]>`
          select x.e from fixtures f, lateral (values (f.home_entrant_id), (f.away_entrant_id)) as x(e)
          where f.stage_id = ${s3!.id} and x.e is not null`).map((x) => x.e),
      );
      expect(seatedInKo.size, label).toBe(KNOCKOUT);
      for (const e of seatedInKo) expect(seatedIn2.includes(e), `${label}: a knockout seat comes from tier 2`).toBe(true);

      // The bracket plays out: n - 1 matches for n seats (no third-place match is configured), and the stage completes.
      let decided = 0;
      for (let pass = 0; pass < KNOCKOUT; pass++) decided += await decideBySeed(r.auth, s3!.id, done);
      expect(decided, label).toBe(KNOCKOUT - 1);
      expect((await completeStage(r.auth, s3!.id)).completed, label).toBe(true);
      played++;
    }
    expect(played).toBe(options.length);
    expect(played).toBeGreaterThan(0);
  }, 300_000);
});
