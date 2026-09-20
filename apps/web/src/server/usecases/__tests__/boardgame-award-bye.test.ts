// C2 (2026-09-20 PR #803 review) — a competition-layer bye on a BOARDGAME
// division (chess / draughts / go).
//
// `boardgame` was the one shipped module with no `case "award"` in
// `standingsDelta`, because its own kernel never emits one: a boardgame
// `core.forfeit` folds to `{kind:"win", method:"forfeit"}`. An award reaches
// it only from the competition layer, which synthesises one for a fixture
// nobody played — `engine-db/competition.ts` sees a row with exactly one seat
// filled and calls `awardByeDelta`.
//
// Two symptoms, and the SECOND is a regression on an existing feature rather
// than a bug in new code:
//   - Swiss, odd field: "Pair next" COMMITS the bye write, then the unguarded
//     `recomputeStandings` throws and the caller gets a 500 while the round is
//     in fact paired.
//   - Knockout with a seeded bye: `tableFixtures` is built for EVERY stage
//     kind, so `loadStageInputs` throws and `recomputeStandings`,
//     `rankedStageStandings` and `completeStageIfReady` all break for that
//     division. No such data exists in prod (owner, 2026-09-20), so this was
//     latent — and nothing covered it, which is why it shipped.
//
// The engine unit test lives beside the module
// (packages/engine/src/sports/boardgame/boardgame.test.ts). This file drives
// the REAL producer — the stage generator's own bye write — through the REAL
// consumer, because a hand-built delta on both ends would only prove the
// fixture.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { recomputeStandings } from "@/server/engine-db";
import { boardgame } from "@seazn/engine/sports/boardgame";
import type { StandingsRow } from "@seazn/engine/competition";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures, getStandings } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// Derived from the module's own declaration, never typed in: if the default
// scheme changes, this test moves with it instead of asserting yesterday's
// numbers.
const WIN_POINTS = boardgame.configSchema.parse({}).scoring.win;

async function seedBoardgameStage(
  auth: AuthCtx,
  kind: "swiss" | "knockout",
  config: Record<string, unknown>,
  entrantCount: number,
): Promise<{ divisionId: string; stageId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Chess " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "boardgame",
    variant_key: "classical",
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind,
    name: kind === "swiss" ? "Swiss" : "KO",
    config,
    progression: null,
  });
  return { divisionId: division.id, stageId: stage!.id };
}

/** The rows `competition.ts` routes to `awardByeDelta`: award outcome,
 *  exactly one seat filled. Read back from the DB so the test is pinned to
 *  what the generator ACTUALLY wrote, not to what it is assumed to write. */
async function oneSidedAwardRows(stageId: string): Promise<{ seated: string }[]> {
  return sql<{ seated: string }[]>`
    select coalesce(home_entrant_id, away_entrant_id)::text as seated from fixtures
    where stage_id = ${stageId}
      and outcome->>'kind' = 'award'
      and (home_entrant_id is null) <> (away_entrant_id is null)`;
}

function rowFor(standings: { rows: unknown }, entrantId: string): StandingsRow | undefined {
  return (standings.rows as StandingsRow[]).find((r) => r.entrantId === entrantId);
}

describe.runIf(HAS_DB)("boardgame — a knockout seeded bye (existing feature, was broken)", () => {
  it("recomputeStandings folds the bye instead of throwing INVALID_EVENT", async () => {
    const { auth } = await seedOrg();
    // 5 entrants into a knockout ⇒ the generator seeds byes in round 1, each
    // with one seat null and an award outcome. Before this fix loadStageInputs
    // threw 'board-game module cannot rank outcome "award"' right here — and
    // rankedStageStandings / completeStageIfReady went with it.
    const { divisionId, stageId } = await seedBoardgameStage(auth, "knockout", {}, 5);
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stageId);

    const byes = await oneSidedAwardRows(stageId);
    expect(byes.length).toBeGreaterThan(0); // the premise, asserted rather than assumed

    await expect(recomputeStandings(auth.orgId, stageId)).resolves.not.toThrow();

    const standings = await getStandings(auth, stageId);
    for (const { seated } of byes) {
      const row = rowFor(standings, seated);
      expect(row, `bye recipient ${seated} is missing from the table`).toBeDefined();
      expect(row!.points).toBe(WIN_POINTS);
      expect(row!.won).toBe(1);
      // Nobody sat at a board, so the colour ledger must not move.
      expect(row!.metrics).toMatchObject({ white: 0, black: 0 });
    }
  });
});

describe.runIf(HAS_DB)("boardgame — a Swiss odd-field sit-out", () => {
  it("Pair next seats the round AND the standings fold, with no 500", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedBoardgameStage(auth, "swiss", { rounds: 2 }, 5);
    await startDivision(auth, divisionId);
    // The second Generate is the Pair. Before this fix it committed the bye
    // write and then threw out of the unguarded recomputeStandings, so the
    // caller saw a 500 on a round that was in fact paired.
    await expect(generateStageFixtures(auth, stageId)).resolves.toBeDefined();

    const byes = await oneSidedAwardRows(stageId);
    expect(byes).toHaveLength(1);

    const standings = await getStandings(auth, stageId);
    const row = rowFor(standings, byes[0]!.seated);
    expect(row, "the sit-out is missing from the Swiss table").toBeDefined();
    expect(row!.points).toBe(WIN_POINTS);
    expect(row!.won).toBe(1);
  });
});
