// W5 Task 12 (X-BD-1, RB5-E4, PO-1): C38's pool-of-one refusal names the pool count that works. Real Postgres; skipped without DATABASE_URL.
// The numbers are the rulebook's: a seeded snake deals n entrants into p pools of floor(n/p) or one more, and "each group needs at
// least 2", so 7 into 4 leaves a pool of one and 3 pools (floor(7/3)=2) is the count that works. The expectations are typed here,
// never read from `poolSizeIssue`; the pure rule has its own sweep (lib/__tests__/pool-size-gate.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface SportPick { key: string; variant: string; kind: "individual" | "pair" | "team" }
const BADMINTON: SportPick = { key: "badminton", variant: "bwf", kind: "individual" };
/** The second sport, from the engine's own declarations: its default entrant kind and first variant. */
const FOOTBALL: SportPick = (() => {
  const m = builtinModules.find((x) => x.key === "football");
  const variant = m === undefined ? undefined : Object.keys(m.variants)[0];
  if (m === undefined || variant === undefined) throw new Error("the engine declares no football module");
  return { key: m.key, variant, kind: (m.entrantModel?.defaultKind ?? "team") as SportPick["kind"] };
})();

function entrantInput(kind: SportPick["kind"], name: string, seed: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind, display_name: name, seed,
    members: Array.from({ length: seats }, (_, i) => ({ new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` }, is_captain: false, roles: [] })),
  };
}

/** One root group stage of `pools` pools over `n` seeded entrants (seed = position), not generated. */
async function rig(n: number, pools: number, sport: SportPick) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T12 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  const made = await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => entrantInput(sport.kind, `P${i + 1}`, i + 1)));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "group", name: "Groups", config: { pools: { count: pools } }, progression: null });
  return { auth, stageId: stage!.id, ids: made.map((e) => e.id) };
}

const counts = async (stageId: string) => {
  const [{ f }] = await sql<{ f: string }[]>`select count(*)::text as f from fixtures where stage_id = ${stageId}`;
  const [{ p }] = await sql<{ p: string }[]>`select count(*)::text as p from pools where stage_id = ${stageId}`;
  return { fixtures: Number(f), pools: Number(p) };
};

async function refusal(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (e) {
    if (EngineError.is(e)) return e;
    throw e;
  }
  throw new Error("expected the Generate to be refused, but it resolved");
}

describe.skipIf(!HAS_DB)("X-BD-1 C38 names a pool count that works (both sports)", () => {
  // differential: C38 on main answered { groups: 4, entrants: 7, required: 8, stranded } and no suggested count.
  it("X-BD-1 7/4 -> 422 STAGE_NOT_READY with suggested 3, and nothing written", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig(7, 4, sport);
      const err = await refusal(generateStageFixtures(r.auth, r.stageId));
      expect(err.code, sport.key).toBe("STAGE_NOT_READY");
      // RB5-E4: floor(7/3)=2, so 3 pools work.
      expect(err.data, sport.key).toMatchObject({ reason: "group_too_few_entrants", groups: 4, entrants: 7, required: 8, suggested: 3 });
      expect(err.message, sport.key).toContain("use 3 groups");
      expect(await counts(r.stageId), `${sport.key}: the pools rows rolled back with it`).toEqual({ fixtures: 0, pools: 0 });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-BD-1 3/2 names 1, and 2/4 (no pairing at all) names 1: both C38 throws carry the count", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      // The stranded throw: 3 snaked into 2 pools leave pool B holding seed 2 alone. floor(3/1)=3 >= 2, so one pool works.
      const stranded = await rig(3, 2, sport);
      const a = await refusal(generateStageFixtures(stranded.auth, stranded.stageId));
      expect(a.data, `${sport.key} stranded`).toMatchObject({ reason: "group_too_few_entrants", groups: 2, entrants: 3, required: 4, suggested: 1 });
      // The empty-gen throw: 2 snaked into 4 pools pair nobody. floor(2/1)=2, so one pool works.
      const empty = await rig(2, 4, sport);
      const b = await refusal(generateStageFixtures(empty.auth, empty.stageId));
      expect(b.data, `${sport.key} empty`).toMatchObject({ reason: "group_too_few_entrants", groups: 4, entrants: 2, required: 8, suggested: 1 });
      expect(await counts(empty.stageId)).toEqual({ fixtures: 0, pools: 0 });
      checked += 2;
    }
    expect(checked).toBe(4);
  });

  it("X-BD-1 the passing splits still draw: 4 into 2 and 5 into 2 seat everyone, with no refusal", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      for (const [n, pools] of [[4, 2], [5, 2]] as const) {
        const r = await rig(n, pools, sport);
        await generateStageFixtures(r.auth, r.stageId);
        const seated = await sql<{ e: string }[]>`
          select distinct x.e from fixtures f, lateral (values (f.home_entrant_id), (f.away_entrant_id)) as x(e) where f.stage_id = ${r.stageId} and x.e is not null`;
        expect(seated.length, `${sport.key} ${n}/${pools}`).toBe(n);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  // differential: main resolved this Generate as a bare no-op reason carrying groups/entrants/required, with no count to try.
  it("X-BD-1 every entrant of one pool withdrew pre-Start: Generate does not redraw, names the shortfall and the count that works", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      // 8 into 4 pools of 2; both members of pool A withdraw, leaving 6 live entrants for 4 pools (8 needed).
      const r = await rig(8, 4, sport);
      await generateStageFixtures(r.auth, r.stageId);
      const poolA = await sql<{ e: string }[]>`
        select distinct x.e from fixtures f join pools p on p.id = f.pool_id, lateral (values (f.home_entrant_id), (f.away_entrant_id)) as x(e)
        where f.stage_id = ${r.stageId} and p.key = 'A' and x.e is not null`;
      expect(poolA.length, `${sport.key}: premise, pool A holds two`).toBe(2);
      const before = await counts(r.stageId);
      for (const m of poolA) await withdrawEntrantCascade(r.auth, m.e);
      const out = await generateStageFixtures(r.auth, r.stageId);
      // RB5-E4: floor(6/3)=2, so three pools work.
      expect(out.reconcile, sport.key).toMatchObject({ kind: "noop", reason: "pools_below_minimum", groups: 4, entrants: 6, required: 8, suggested: 3 });
      expect(await counts(r.stageId), `${sport.key}: the draw stands`).toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
