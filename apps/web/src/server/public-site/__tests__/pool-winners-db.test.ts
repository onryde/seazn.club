// W5 T14b (owner 2026-11-18) - a finished multi-pool Groups only division names each pool's winner, through the REAL
// producers: a real `group_only` division is created, Started and played to the end through `scoreEvent`, and the winners
// are read through BOTH consumers - `getPublicDivision` (what the division page folds) and `loadCompetitionHub` (the Table tab's
// document, parsed by its schema) - never through a hand-built snapshot. The pure rule is `champion.test.ts`'s; only a database
// proves the read PRODUCES its input (the configured pool list, the snapshot rows).
//
// Expected winners are derived from the rig's OWN rule, not from `poolWinnersOf`: every match is a walkover won by the
// better (lower) seed, so a pool's winner is its lowest-seeded member, read off the fixtures' pool_id.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { CreateStage } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants, patchEntrant } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { completeStage, createStages } from "@/server/usecases/stages";
import { getFixtureState } from "@/server/usecases/fixtures";
import { scoreEvent } from "@/server/usecases/scoring";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { divisionTitle, poolWinnersOf } from "../champion";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { getPublicDivision } from "../data";
import { loadCompetitionHub } from "../competition-hub";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

interface Rig {
  auth: AuthCtx;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  stageId: string;
  entrantIds: string[];
}

async function rig(sport: "badminton" | "football", poolCount: number, perPool: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T14b " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Groups",
    slug: "groups-" + randomUUID().slice(0, 6),
    sport_key: sport,
    variant_key: sport === "badminton" ? "bwf" : "11-a-side",
    config: {},
  });
  const individual = sport === "badminton";
  const created = await createEntrants(
    auth,
    division.id,
    Array.from({ length: poolCount * perPool }, (_, i) =>
      individual
        ? { kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [{ new_person: { full_name: `P${i + 1} ${randomUUID().slice(0, 6)}` }, is_captain: false, roles: [] }] }
        : { kind: "team" as const, display_name: `Team ${i + 1}`, seed: i + 1, members: [] },
    ),
  );
  const [d] = buildTemplateStages("group_only", { qualified: 4, swissRounds: 3, poolCount, legs: 1 });
  const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: 1, kind: d!.kind, name: d!.name, config: d!.config, progression: d!.progression }));
  await startDivision(auth, division.id);
  const [{ slug: compSlug }] = await sql<{ slug: string }[]>`select slug from competitions where id = ${comp.id}`;
  return { auth, orgSlug, compSlug, divSlug: division.slug, divisionId: division.id, stageId: stage!.id, entrantIds: created.map((e) => e.id) };
}

/** Walk every fixture over to the better seed - through the real scoring path, so the standings fold writes the snapshots. */
async function playAll(r: Rig, only?: (poolId: string) => boolean, pick?: (f: { pool_id: string; home_entrant_id: string; away_entrant_id: string }, seedOf: Map<string, number>) => string | undefined): Promise<number> {
  const seeds = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${r.divisionId}`).map((e) => [e.id, e.seed]));
  const rows = await sql<{ id: string; pool_id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by fixture_no`;
  let played = 0;
  for (const f of rows) {
    if (only && !only(f.pool_id)) continue;
    // `pick` names the WINNER of a line (a cycle); by default the better seed wins
    const winner = pick?.(f, seeds) ?? (seeds.get(f.home_entrant_id)! < seeds.get(f.away_entrant_id)! ? f.home_entrant_id : f.away_entrant_id);
    const loser = winner === f.home_entrant_id ? f.away_entrant_id : f.home_entrant_id;
    const { last_seq } = await getFixtureState(r.auth, f.id);
    await scoreEvent(r.auth, f.id, { expected_seq: last_seq, type: "core.start", payload: {} });
    const { last_seq: s2 } = await getFixtureState(r.auth, f.id);
    await scoreEvent(r.auth, f.id, { expected_seq: s2, type: "core.forfeit", payload: { by: loser, reason: "walkover" } });
    played++;
  }
  return played;
}

/** The rig's own expectation: each pool's lowest-seeded member, pools in key order. */
async function expectedWinners(r: Rig): Promise<{ key: string; entrantId: string }[]> {
  const rows = await sql<{ key: string; entrant_id: string; seed: number }[]>`
    select p.key, e.id as entrant_id, e.seed
    from fixtures f join pools p on p.id = f.pool_id
    join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
    where f.stage_id = ${r.stageId}`;
  const best = new Map<string, { entrantId: string; seed: number }>();
  for (const x of rows) if (!best.has(x.key) || x.seed < best.get(x.key)!.seed) best.set(x.key, { entrantId: x.entrant_id, seed: x.seed });
  return [...best.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ key, entrantId: v.entrantId }));
}

describe.skipIf(!HAS_DB)("W5 T14b pool winners through the real read", () => {
  it("a decided Groups only division (2 and 3 pools, badminton and football) lists every pool's winner on BOTH reads, and crowns nobody", async () => {
    let checked = 0;
    for (const [sport, pools] of [["badminton", 2], ["football", 2], ["badminton", 3]] as const) {
      const r = await rig(sport, pools, 3);
      // BEFORE it is decided: nothing (the same test as the champion's)
      const before = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
      expect(poolWinnersOf(before.stages, before.fixtures, before.standings, before.pools), `${sport}/${pools}: undecided`).toBeNull();

      expect(await playAll(r), `${sport}/${pools}: every fixture played`).toBe(pools * 3);
      const want = await expectedWinners(r);
      expect(want.length, `${sport}/${pools}: one expected winner per pool`).toBe(pools);

      const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
      expect(detail.pools.filter((p) => p.stage_id === r.stageId).length, "the configured pools").toBe(pools);
      const got = poolWinnersOf(detail.stages, detail.fixtures, detail.standings, detail.pools)!;
      expect(got, `${sport}/${pools}`).not.toBeNull();
      expect(got.map((w) => ({ key: w.key, entrantId: w.entrantId })), `${sport}/${pools}`).toEqual(want);
      expect(divisionTitle(detail.stages, detail.fixtures, detail.standings, detail.pools), `${sport}/${pools}: no single champion`).toBeNull();

      const doc = (await loadCompetitionHub(r.orgSlug, r.compSlug))!;
      expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
      expect(doc.poolWinners, `${sport}/${pools}: the hub document carries them`).toHaveLength(1);
      const hub = doc.poolWinners![0]!;
      expect(hub.divisionId).toBe(r.divisionId);
      expect(hub.pools.map((p) => p.entrantId)).toEqual(want.map((w) => w.entrantId));
      expect(hub.pools.map((p) => p.label)).toEqual(want.map((w) => `Group ${w.key}`));
      expect(hub.pools.every((p) => p.name !== null && p.name.length > 0), "winners are named").toBe(true);
      // no row of any table of the division is crowned
      expect(doc.tables.flatMap((t) => t.rows).some((row) => row.champion), `${sport}/${pools}: no champion flag`).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  }, 180_000);

  it("a pool still to play: no winners yet (one pool decided, one not), and the hub carries none", async () => {
    const r = await rig("badminton", 2, 3);
    const pool = (await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${r.stageId} order by key`)[0]!;
    expect(await playAll(r, (p) => p === pool.id), "only pool A played").toBe(3);
    const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
    expect(poolWinnersOf(detail.stages, detail.fixtures, detail.standings, detail.pools)).toBeNull();
    expect(divisionTitle(detail.stages, detail.fixtures, detail.standings, detail.pools)).toBeNull();
    const doc = (await loadCompetitionHub(r.orgSlug, r.compSlug))!;
    expect(doc.poolWinners).toBeUndefined();
  }, 120_000);

  it("a ONE-pool Groups only division crowns its winner as champion and lists no pool winners", async () => {
    const r = await rig("badminton", 1, 4);
    await playAll(r);
    const [want] = await expectedWinners(r);
    const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
    expect(detail.pools.filter((p) => p.stage_id === r.stageId).length).toBe(1);
    expect(divisionTitle(detail.stages, detail.fixtures, detail.standings, detail.pools)).toEqual({ kind: "champion", champion: want!.entrantId });
    expect(poolWinnersOf(detail.stages, detail.fixtures, detail.standings, detail.pools)).toBeNull();
    expect((await loadCompetitionHub(r.orgSlug, r.compSlug))!.poolWinners).toBeUndefined();
  }, 120_000);

  // The rule is the CHAMPION's (the row ranked 1), so its expected value is taken from `divisionTitle` over that one pool's table as
  // a stage of its own - never from `poolWinnersOf`.
  const championOfPool = (detail: Awaited<ReturnType<typeof getPublicDivision>> & object, poolId: string) => {
    const pool = detail.pools.find((p) => p.id === poolId)!;
    const snap = detail.standings.filter((x) => x.pool_id === poolId);
    const t = divisionTitle(detail.stages, detail.fixtures, snap, [pool]);
    return t?.kind === "champion" ? t.champion : null;
  };

  it("a REAL tie produced by the engine (a 3-team cycle in one group): the table's sole rank 1 is that group's winner, as the champion rule names it", async () => {
    let checked = 0;
    for (const sport of ["badminton", "football"] as const) {
      const r = await rig(sport, 2, 3);
      const pools = await sql<{ id: string }[]>`select id from pools where stage_id = ${r.stageId} order by key`;
      const cyclePool = pools[0]!.id;
      const members = (
        await sql<{ id: string; seed: number }[]>`
          select distinct e.id, e.seed from fixtures f join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
          where f.stage_id = ${r.stageId} and f.pool_id = ${cyclePool} order by e.seed`
      ).map((m) => m.id);
      expect(members.length, `${sport}: three in the cycle group`).toBe(3);
      const [m1, m2, m3] = members as [string, string, string];
      // m1 beats m2, m2 beats m3, m3 beats m1: level on points, on the mini-table and on every walkover score
      const beats = new Map<string, string>([[[m1, m2].sort().join("|"), m1], [[m2, m3].sort().join("|"), m2], [[m1, m3].sort().join("|"), m3]]);
      await playAll(r, undefined, (f) => (f.pool_id === cyclePool ? beats.get([f.home_entrant_id, f.away_entrant_id].sort().join("|")) : undefined));
      const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
      const snap = detail.standings.find((x) => x.pool_id === cyclePool)!;
      const rankOnes = snap.rows.filter((x) => x.rank === 1);
      // premise (the engine's real shape): ONE rank 1, and the tie it ended is flagged unbroken - the shape a hand-built "two rank 1s" never was
      expect(rankOnes.length, `${sport}: a sole rank 1`).toBe(1);
      expect((rankOnes[0] as { tieUnbroken?: boolean }).tieUnbroken, `${sport}: ended by lots or seed, flagged unbroken`).toBe(true);
      const w = poolWinnersOf(detail.stages, detail.fixtures, detail.standings, detail.pools)!;
      const entry = w.find((x) => x.poolId === cyclePool)!;
      expect(entry.entrantId, `${sport}: the tied group still names a winner`).not.toBeNull();
      // anchored on the stored row itself, then on the champion rule beside it
      expect(entry.entrantId, `${sport}: the rank-1 row read straight from the stored snapshot`).toBe(rankOnes[0]!.entrantId);
      expect(entry.entrantId, `${sport}: the champion rule on that table`).toBe(championOfPool(detail, cyclePool));
      expect(members, `${sport}: a member of the group`).toContain(entry.entrantId);
      // and the other group is untouched: its lowest seed
      const other = w.find((x) => x.poolId !== cyclePool)!;
      const otherRankOne = detail.standings.find((x) => x.pool_id === other.poolId)!.rows.find((x) => x.rank === 1)!;
      expect(other.entrantId, `${sport}: the other group's rank-1 row, from the stored snapshot`).toBe(otherRankOne.entrantId);
      expect(other.entrantId).toBe(championOfPool(detail, other.poolId));
      checked++;
    }
    expect(checked).toBe(2);
  }, 180_000);

  it("same as the champion: a winner who has since DEPARTED is still named (the champion rule reads no status)", async () => {
    const r = await rig("badminton", 2, 3);
    await playAll(r);
    const before = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
    const first = poolWinnersOf(before.stages, before.fixtures, before.standings, before.pools)![0]!;
    await patchEntrant(r.auth, first.entrantId!, { status: "withdrawn" });
    const after = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
    expect(after.entrants.find((e) => e.id === first.entrantId)!.status, "premise: she has departed").not.toBe("registered");
    const entry = poolWinnersOf(after.stages, after.fixtures, after.standings, after.pools)!.find((x) => x.poolId === first.poolId)!;
    expect(entry.entrantId, "a pool winner is named whoever the champion rule names for that table").toBe(championOfPool(after, first.poolId));
    expect(entry.entrantId, "and it is still the departed winner").toBe(first.entrantId);
  }, 180_000);

  it("a group whose every fixture was cancelled with no result (no counted result) reads No single winner; the other group still names its winner", async () => {
    let checked = 0;
    for (const sport of ["badminton", "football"] as const) {
      const r = await rig(sport, 2, 3);
      const pools = await sql<{ id: string }[]>`select id from pools where stage_id = ${r.stageId} order by key`;
      const [voidPool, playedPool] = [pools[0]!.id, pools[1]!.id];
      expect(await playAll(r, (p) => p === playedPool), `${sport}: the other group played out`).toBe(3);
      const lines = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and pool_id = ${voidPool}`;
      expect(lines.length, `${sport}: the voided group's lines`).toBe(3);
      // voided the way the repo's own suites do (a cancelled line: settled, no outcome); the group's table stays the engine's level table
      await sql`update fixtures set status = 'cancelled' where id in ${sql(lines.map((f) => f.id))}`;
      await completeStage(r.auth, r.stageId);
      const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
      const snap = detail.standings.find((x) => x.pool_id === voidPool)!;
      // premise, from the stored table: NO counted result in the voided group. A pooled stage takes a pool's membership from its results
      // (`entrantsOfPool`), so such a group's stored table has no row that played (in practice no rows at all)
      expect(snap.rows.filter((x) => x.played > 0).length, `${sport}: nobody played in the voided group`).toBe(0);
      expect(detail.stages.find((st) => st.id === r.stageId)!.status, `${sport}: the stage was completed`).toBe("complete");
      const w = poolWinnersOf(detail.stages, detail.fixtures, detail.standings, detail.pools)!;
      expect(w, `${sport}: the stage is done, so winners are named`).not.toBeNull();
      expect(w.find((x) => x.poolId === voidPool)!.entrantId, `${sport}: nobody won in the voided group`).toBeNull();
      const playedRankOne = detail.standings.find((x) => x.pool_id === playedPool)!.rows.find((x) => x.rank === 1)!;
      expect(w.find((x) => x.poolId === playedPool)!.entrantId, `${sport}: the played group's stored rank 1`).toBe(playedRankOne.entrantId);
      // the page's own list: one named pool, one "No single winner"
      const doc = (await loadCompetitionHub(r.orgSlug, r.compSlug))!;
      expect(doc.poolWinners![0]!.pools.map((p) => p.name === null), `${sport}: the hub carries the same`).toEqual([true, false]);
      checked++;
    }
    expect(checked).toBe(2);
  }, 240_000);
});
