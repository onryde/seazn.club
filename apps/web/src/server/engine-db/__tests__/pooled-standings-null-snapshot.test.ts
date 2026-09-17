// Regression — a POOLED stage must never be handed a `pool_id IS NULL`
// standings snapshot.
//
// `recomputeStandings` used to pick its target with
// `tables.pools.find(...) ?? tables.pools[0]` and then write whatever it
// landed on under `poolId ?? null` — the ARGUMENT, never the table's own key.
// So any caller that passes no pool (usecases/stages.ts `overrideStandings`,
// which does it unconditionally; `getStandings` — and therefore
// `GET /api/v1/stages/{id}/standings` with no `pool_id` query param) minted a
// phantom "overall" row on a pooled stage that was a byte copy of the FIRST
// pool's table. Same fallback, second shape: a poolId naming a real pool that
// has no fixtures of its own (a `pools` row the org division page iterates,
// e.g. an empty pool of a snake distribution) wrote Pool A's rows under THAT
// pool's id.
//
// Nothing downstream can tell the phantom from a real table: the public
// division page renders every snapshot it is handed, so Pool A shows twice,
// and usecases/stage-seeding.ts's `sourceStandingsTables` turns the null row
// into a pool keyed "" sitting alongside "A"/"B".
//
// The contract this pins is `completeStageIfReady`'s, which has always been
// right (competition.ts: `writeSnapshot(tx, stageId, pool.pool || null, ...)`
// per pool) — recomputeStandings now writes the same set.
//
// Requires a real Postgres — skipped when DATABASE_URL is absent, same
// contract as placement-snapshots.test.ts / integration.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent, recomputeStandings } from "../index";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

async function seedDivision(): Promise<{ orgId: string; divisionId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id
  `;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing
  `;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id
  `;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'generic', 'score',
            ${sql.json(DIVISION_CONFIG)}, '1.0.0')
    returning id
  `;
  return { orgId, divisionId };
}

async function seedStage(divisionId: string, kind: string): Promise<string> {
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name, config)
    values (${divisionId}, 1, ${kind}, ${kind}, ${sql.json({} as never)})
    returning id
  `;
  return stageId;
}

async function seedPool(stageId: string, key: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into pools (stage_id, key, name) values (${stageId}, ${key}, ${"Pool " + key})
    returning id
  `;
  return id;
}

async function seedEntrant(divisionId: string, name: string, seed: number): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, seed)
    values (${divisionId}, 'individual', ${name}, ${seed})
    returning id
  `;
  return id;
}

// Table-kind fixtures MUST be decided through the real fold: completeTableStage
// reads TableFixture.result, which loadStageInputs only populates when a
// fixture has BOTH `outcome` AND a folded `match_states.state`. Hand-writing
// `outcome` leaves every entrant on an identical all-zero row, and the
// tiebreaker cascade's fallback decides the "winner" — a table that is the
// same whoever actually won, which is exactly what this file has to tell
// apart. Score it for real. (Same reasoning as placement-snapshots.test.ts.)
async function seedDecidedFixture(
  orgId: string,
  stageId: string,
  divisionId: string,
  poolId: string | null,
  seqInRound: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
): Promise<string> {
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, pool_id, round_no, seq_in_round,
                          home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, ${poolId}, 1, ${seqInRound}, ${home}, ${away})
    returning id
  `;
  await appendEvent(orgId, fixtureId, 0, { type: "core.start", payload: {} });
  await appendEvent(orgId, fixtureId, 1, {
    type: "generic.result",
    payload: { p1Score: homeScore, p2Score: awayScore },
  });
  return fixtureId;
}

async function snapshotRanks(stageId: string, poolId: string | null = null): Promise<string[] | null> {
  const [snap] = await sql<{ rows: { entrantId: string; rank: number }[] }[]>`
    select rows from standings_snapshots where stage_id = ${stageId} and pool_id is not distinct from ${poolId}
  `;
  if (!snap) return null;
  return [...snap.rows].sort((a, b) => a.rank - b.rank).map((r) => r.entrantId);
}

/** Every snapshot this stage owns, as `pool_id` (null included) → ranked ids. */
async function allSnapshots(stageId: string): Promise<Map<string | null, string[]>> {
  const rows = await sql<{ pool_id: string | null; rows: { entrantId: string; rank: number }[] }[]>`
    select pool_id, rows from standings_snapshots where stage_id = ${stageId}
  `;
  return new Map(
    rows.map((r) => [
      r.pool_id,
      [...r.rows].sort((a, b) => a.rank - b.rank).map((row) => row.entrantId),
    ]),
  );
}

/** A pooled group stage: Pool A (a beats b), Pool B (c beats d), and an empty
 *  Pool C that has a `pools` row but no fixtures — the three shapes the
 *  fallback got wrong. Pool A's and Pool B's winners differ, so a copied
 *  table is distinguishable from a computed one. */
async function seedPooledStage() {
  const { orgId, divisionId } = await seedDivision();
  const stageId = await seedStage(divisionId, "group");
  const [poolA, poolB, poolC] = [
    await seedPool(stageId, "A"),
    await seedPool(stageId, "B"),
    await seedPool(stageId, "C"),
  ];
  const [a, b, c, d] = await Promise.all([
    seedEntrant(divisionId, "A-one", 1),
    seedEntrant(divisionId, "A-two", 2),
    seedEntrant(divisionId, "B-one", 3),
    seedEntrant(divisionId, "B-two", 4),
  ]);
  await seedDecidedFixture(orgId, stageId, divisionId, poolA, 1, a, b, 2, 1);
  await seedDecidedFixture(orgId, stageId, divisionId, poolB, 2, c, d, 3, 0);
  return { orgId, divisionId, stageId, poolA, poolB, poolC, a, b, c, d };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("recomputeStandings — a pooled stage owns no null-pool snapshot", () => {
  it("recomputed with NO poolId (overrideStandings' shape): writes every real pool, and no null row", async () => {
    const s = await seedPooledStage();

    const rows = await recomputeStandings(s.orgId, s.stageId);

    // The WRITE first — it is the half that outlives the call, and asserting
    // the return value ahead of it would short-circuit this before it runs.
    const snaps = await allSnapshots(s.stageId);
    // The live defect was a THIRD row here: Pool A, Pool B, and a phantom
    // `pool_id IS NULL` copy of Pool A.
    expect([...snaps.keys()].filter((k) => k === null)).toEqual([]);
    expect(new Set(snaps.keys())).toEqual(new Set([s.poolA, s.poolB]));
    // …and each real pool carries its OWN table, not a shared one.
    expect(snaps.get(s.poolA)).toEqual([s.a, s.b]);
    expect(snaps.get(s.poolB)).toEqual([s.c, s.d]);
    // A pooled stage has no overall table to return — not the first pool's.
    expect(rows).toEqual([]);
  });

  it("recomputed for a pool that has no table of its own: writes nothing, never the first pool's rows", async () => {
    const s = await seedPooledStage();

    const rows = await recomputeStandings(s.orgId, s.stageId, s.poolC);

    // Write first, for the same reason as above.
    expect(await snapshotRanks(s.stageId, s.poolC)).toBeNull();
    expect(await snapshotRanks(s.stageId, null)).toBeNull();
    expect(await snapshotRanks(s.stageId, s.poolA)).toEqual([s.a, s.b]);
    expect(await snapshotRanks(s.stageId, s.poolB)).toEqual([s.c, s.d]);
    expect(rows).toEqual([]);
  });

  it("recomputed for a real pool: returns THAT pool's rows", async () => {
    const s = await seedPooledStage();

    expect(await recomputeStandings(s.orgId, s.stageId, s.poolB)).toMatchObject([
      { entrantId: s.c, rank: 1 },
      { entrantId: s.d, rank: 2 },
    ]);
    expect(await recomputeStandings(s.orgId, s.stageId, s.poolA)).toMatchObject([
      { entrantId: s.a, rank: 1 },
      { entrantId: s.b, rank: 2 },
    ]);
  });

  // The other half of the rule, and the over-correction guard: the function's
  // own doc comment promises `poolId` null = the single non-pool table, and
  // seedNextStage/sourceStandingsTables read that null row as the "" pool.
  it("an UNPOOLED stage still writes its single pool_id IS NULL table", async () => {
    const { orgId, divisionId } = await seedDivision();
    const stageId = await seedStage(divisionId, "league");
    const [a, b] = await Promise.all([
      seedEntrant(divisionId, "L-one", 1),
      seedEntrant(divisionId, "L-two", 2),
    ]);
    await seedDecidedFixture(orgId, stageId, divisionId, null, 1, a, b, 2, 1);

    const rows = await recomputeStandings(orgId, stageId);

    expect(rows.map((r) => r.entrantId)).toEqual([a, b]);
    expect(await snapshotRanks(stageId, null)).toEqual([a, b]);
    expect([...(await allSnapshots(stageId)).keys()]).toEqual([null]);
  });
});
