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
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages } from "@/server/usecases/stages";
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
async function playAll(r: Rig, only?: (poolId: string) => boolean): Promise<number> {
  const seeds = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${r.divisionId}`).map((e) => [e.id, e.seed]));
  const rows = await sql<{ id: string; pool_id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by fixture_no`;
  let played = 0;
  for (const f of rows) {
    if (only && !only(f.pool_id)) continue;
    const loser = seeds.get(f.home_entrant_id)! < seeds.get(f.away_entrant_id)! ? f.away_entrant_id : f.home_entrant_id;
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
});
