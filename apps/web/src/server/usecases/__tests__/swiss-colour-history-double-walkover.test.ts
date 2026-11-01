// W2b Loop R M-8 (a): Swiss chess pairs colours from each player's colour history (spec 05 §2.2: alternate, keep
// |W−B| ≤ 2, never three in a row; neutral ⇒ the upper board takes White). A game that was never played holds no
// colour — the engine's own reading: boardgame's `colorOf` gives a forfeited game none (`state.forfeited`), and
// `colorHistory` skips a game with no colour. The pairing's history (stages.ts) skipped an award, but read a double
// walkover — `{kind: "double_walkover"}`, nobody played — as a game: White for home, Black for away. So the next round
// paired colours against games that never happened.
//
// The witness: four players, round 1 S1 v S3 and S2 v S4 (coloured by the stage's lot since W3 T8, BG-SW-1: board 1's
// upper player takes the lot's colour, board 2's the other), and BOTH boards recorded as double walkovers by the console. Nobody holds a colour, so every round-2 board is neutral and its upper board (the
// better seed — fold pairing ranks by seed) takes White, i.e. sits home. The positive pair plays round 1 to two draws
// instead: the real colours are exactly the history the defect invented, and at least one round-2 board then puts its
// lower board home — so the first case's assertion is not met by a pairing that ignores colours altogether.
//
// single-sport: boardgame; the colour rules are the swiss stage's `chess: true` (`pairRound`'s `chess`), read from history.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { applyRoundOneColourLot, swissColourLot, swissDrawSeed } from "@/lib/swiss-draw";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Board {
  id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

/** Four individuals S1..S4 (seeds 1..4) in a 2-round classical chess swiss with colour rules on, started, round 1 paired. */
async function pairedRoundOne(): Promise<{ auth: AuthCtx; stageId: string; seed: Map<string, number>; name: Map<string, string> }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss colours " + randomUUID().slice(0, 6),
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
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `S${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2, chess: true }, progression: null });
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, stage!.id);
  return {
    auth,
    stageId: stage!.id,
    seed: new Map(entrants.map((e, i) => [e.id, i + 1])),
    name: new Map(entrants.map((e) => [e.id, e.display_name])),
  };
}

const boardsOf = (stageId: string, round: number) =>
  sql<Board[]>`
    select id, round_no, home_entrant_id, away_entrant_id, status from fixtures
    where stage_id = ${stageId} and round_no = ${round} order by seq_in_round`;

/** Round 2's boards, each read as "is the better seed at home (White)". */
async function roundTwo(rig: Awaited<ReturnType<typeof pairedRoundOne>>) {
  await generateStageFixtures(rig.auth, rig.stageId); // Pair next
  const boards = (await boardsOf(rig.stageId, 2)).filter((b) => b.home_entrant_id !== null && b.away_entrant_id !== null);
  expect(boards, "rig: round 2 seats two boards").toHaveLength(2);
  return boards.map((b) => ({
    shape: `${rig.name.get(b.home_entrant_id!)} v ${rig.name.get(b.away_entrant_id!)}`,
    upperHome: rig.seed.get(b.home_entrant_id!)! < rig.seed.get(b.away_entrant_id!)!,
  }));
}

describe.runIf(HAS_DB)("Loop R M-8 (a): a double walkover holds no colour in the Swiss colour history", () => {
  it("both round-1 boards double walkovers: nobody holds a colour, so every round-2 board's upper board takes White", async () => {
    const rig = await pairedRoundOne();
    const r1 = await boardsOf(rig.stageId, 1);
    // The fold (S1-S3, S2-S4, upper at home), coloured by the stage's own lot (W3 T8, BG-SW-1).
    const fold = applyRoundOneColourLot(
      [{ home: "S1", away: "S3" }, { home: "S2", away: "S4" }],
      swissColourLot(swissDrawSeed(rig.stageId)),
    ).map((p) => `${p.home} v ${p.away}`);
    expect(r1.map((b) => `${rig.name.get(b.home_entrant_id!)} v ${rig.name.get(b.away_entrant_id!)}`), "rig: the fold, by lot").toEqual(fold);
    for (const b of r1) {
      const res = await scoreEvent(rig.auth, b.id, { expected_seq: 0, type: "core.forfeit", payload: { by: "both", reason: "walkover" } });
      expect([res.status, res.outcome], "rig: a recorded double walkover").toEqual(["forfeited", { kind: "double_walkover" }]);
    }
    const boards = await roundTwo(rig);
    expect(boards.filter((b) => !b.upperHome), `round 2: ${boards.map((b) => b.shape).join(", ")}`).toEqual([]);
  }, 120_000);

  it("the positive pair: both round-1 boards played to draws — the colours are real, and round 2 alternates them", async () => {
    const rig = await pairedRoundOne();
    for (const b of await boardsOf(rig.stageId, 1)) {
      await scoreEvent(rig.auth, b.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(rig.auth, b.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: null, method: "agreement" } });
    }
    const boards = await roundTwo(rig);
    expect(boards.filter((b) => !b.upperHome).length, `round 2: ${boards.map((b) => b.shape).join(", ")}`).toBeGreaterThan(0);
  }, 120_000);
});
