// Swiss Playoff — the repairing seam, driven end to end through real
// Postgres: create the stage, generate round 1, score it with REAL badminton
// game scores through the real append path, generate round 2, and read the
// pairings back off the fixtures table.
//
// This file exists because the thing it proves cannot be seen from a builder
// test (AGENTS.md failure class 1). `swissGen` used to rank entrants with its
// own ad-hoc score loop (win 1 / draw ½) and pass the ENTRANT SEED as
// `SwissStanding.rank`, so a rank-adjacent pairing would have paired winners
// in SEED order. Swiss Playoff pairs them in the order the division's OWN
// tiebreaker cascade produces — for badminton
// points → wins → set_ratio → point_ratio → h2h_points, the same cascade the
// standings tab renders.
//
// The round-1 scores below are chosen so the two orders DISAGREE COMPLETELY:
// every winner ends on the same points, the same wins and the same 2:1 game
// ratio, so the whole table is decided on point_ratio, and point_ratio ranks
// them in the exact reverse-ish order of their seeds. A test where both
// orders agree cannot witness the regression it exists for.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { swissRoundsForFieldSize } from "@/lib/swiss-rounds";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Organiser-set round budget — required before Generate (Task 2). */
function swissRoundsFor(count: number): number {
  return swissRoundsForFieldSize(count);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** A badminton division with N seeded individual entrants, E1..EN. */
async function seedBadmintonDivision(
  auth: AuthCtx,
  count: number,
): Promise<{ divisionId: string; idOf: Map<string, string>; nameOf: Map<string, string> }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss Playoff " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open singles",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const names = Array.from({ length: count }, (_, i) => `E${i + 1}`);
  const entrants = await createEntrants(
    auth,
    division.id,
    names.map((display_name, i) => ({
      kind: "individual" as const,
      display_name,
      seed: i + 1,
      members: [],
    })),
  );
  const idOf = new Map(entrants.map((e) => [e.display_name, e.id]));
  const nameOf = new Map(entrants.map((e) => [e.id, e.display_name]));
  return { divisionId: division.id, idOf, nameOf };
}

interface FixtureRow {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

async function fixturesOfRound(stageId: string, roundNo: number): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status
    from fixtures where stage_id = ${stageId} and round_no = ${roundNo}
    order by seq_in_round`;
}

/** The stage's config as the DATABASE holds it — the row `toTableStage` reads,
 *  not the draft the builder emitted. */
async function configOf(stageId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<{ config: Record<string, unknown> }[]>`
    select config from stages where id = ${stageId}`;
  return row!.config;
}

/** The highest round the stage has any fixture in. */
async function lastRoundOf(stageId: string): Promise<number> {
  const [row] = await sql<{ n: number | null }[]>`
    select max(round_no)::int as n from fixtures where stage_id = ${stageId}`;
  return row!.n ?? 0;
}

/** Play a real best-of-3 badminton match through the append path. `games` is
 *  [home, away] per game from the HOME entrant's point of view. */
async function playMatch(orgId: string, fixtureId: string, games: [number, number][]): Promise<void> {
  await appendEvent(orgId, fixtureId, 0, { type: "core.start", payload: {}, recordedBy: null });
  for (const [i, [home, away]] of games.entries()) {
    await appendEvent(orgId, fixtureId, i + 1, {
      type: "badminton.game.summary",
      payload: { home, away },
      recordedBy: null,
    });
  }
}

/** The unordered pair of display names on a fixture, "A|B" with A < B. */
function pairOf(f: FixtureRow, nameOf: Map<string, string>): string {
  const a = nameOf.get(f.home_entrant_id ?? "") ?? "?";
  const b = nameOf.get(f.away_entrant_id ?? "") ?? "?";
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Decide every real pairing of a round with the upper board (home) winning
 *  2-0. Board-agnostic, so it can score a fold round and an adjacent round
 *  alike; the bye row is already awarded and is skipped. */
async function playRoundHomeWins(orgId: string, stageId: string, roundNo: number): Promise<void> {
  for (const f of await fixturesOfRound(stageId, roundNo)) {
    if (f.away_entrant_id === null) continue;
    await playMatch(orgId, f.id, [
      [21, 10],
      [21, 12],
    ]);
  }
}

describe.runIf(HAS_DB)("swiss playoff — rank-adjacent repairing off the real cascade", () => {
  /** Round 1 is seeded, so rank-adjacent pairs 1v2, 3v4, 5v6, 7v8 and the
   *  winners below are E1, E3, E5, E7 — i.e. SEED order among winners is
   *  E1 < E3 < E5 < E7.
   *
   *  Every winner takes it 2-1, so points (2), wins (1) and set_ratio (2:1)
   *  are identical across all four and the cascade falls through to
   *  point_ratio:
   *    E3  61:33 = 1.848   ← best
   *    E5  60:43 = 1.395
   *    E7  58:47 = 1.234
   *    E1  61:59 = 1.034   ← worst
   *  Cascade order E3 > E5 > E7 > E1 ⇒ rank-adjacent pairs E3vE5 and E7vE1.
   *  Seed order would have paired E1vE3 and E5vE7 — two DISJOINT answers, so
   *  the assertion below cannot pass on the old behaviour by luck.
   *
   *  Losers fall through the same way (all 0 points, 1:2 games):
   *    E2 59:61 = 0.967, E8 47:58 = 0.810, E6 43:60 = 0.717, E4 33:61 = 0.541
   *  ⇒ E2vE8 and E6vE4, where seed order would have paired E2vE4, E6vE8. */
  const ROUND_1_SCORES: Record<string, [number, number][]> = {
    "E1|E2": [[21, 19], [19, 21], [21, 19]], // E1 wins 61:59
    "E3|E4": [[21, 5], [19, 21], [21, 7]], //   E3 wins 61:33
    "E5|E6": [[21, 10], [18, 21], [21, 12]], // E5 wins 60:43
    "E7|E8": [[21, 12], [16, 21], [21, 14]], // E7 wins 58:47
  };

  async function playScriptedRoundOne(
    auth: AuthCtx,
    stageId: string,
    nameOf: Map<string, string>,
  ): Promise<void> {
    const round1 = await fixturesOfRound(stageId, 1);
    for (const f of round1) {
      if (f.away_entrant_id === null) continue; // bye row — already awarded
      const games = ROUND_1_SCORES[pairOf(f, nameOf)];
      expect(games, `no scoreline scripted for ${pairOf(f, nameOf)}`).toBeDefined();
      // The script is written home-first for the seeded board; if the
      // generator put the pair the other way round, mirror it.
      const homeIsLowerSeed = (nameOf.get(f.home_entrant_id!) ?? "") < (nameOf.get(f.away_entrant_id!) ?? "");
      await playMatch(
        auth.orgId,
        f.id,
        homeIsLowerSeed ? games! : games!.map(([h, a]) => [a, h] as [number, number]),
      );
    }
  }

  it("pairs round 2 in CASCADE order, not seed order", async () => {
    const { auth } = await seedOrg();
    const { divisionId, nameOf } = await seedBadmintonDivision(auth, 8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { pairing: "rank_adjacent", rounds: swissRoundsFor(8) },
      progression: null,
    });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stage!.id);

    const round1 = await fixturesOfRound(stage!.id, 1);
    expect(round1.map((f) => pairOf(f, nameOf)).sort()).toEqual([
      "E1|E2",
      "E3|E4",
      "E5|E6",
      "E7|E8",
    ]);

    await playScriptedRoundOne(auth, stage!.id, nameOf);
    await generateStageFixtures(auth, stage!.id);

    const round2 = await fixturesOfRound(stage!.id, 2);
    expect(round2.map((f) => pairOf(f, nameOf)).sort()).toEqual([
      "E1|E7", // cascade ranks 3 and 4 among the winners
      "E2|E8", // cascade ranks 1 and 2 among the losers
      "E3|E5", // cascade ranks 1 and 2 among the winners
      "E4|E6", // cascade ranks 3 and 4 among the losers
    ]);

    // The differential, stated as a refusal: this is what SEED order would
    // have produced. If it ever passes, the cascade is not being read.
    expect(round2.map((f) => pairOf(f, nameOf)).sort()).not.toEqual([
      "E1|E3",
      "E2|E4",
      "E5|E7",
      "E6|E8",
    ]);
  });

  it("leaves a default (fold) swiss stage pairing exactly as it did before", async () => {
    // The regression guard for the live stages that predate this key: no
    // `pairing`, so round 1 must still be the top-vs-bottom FOLD (1v5, 2v6,
    // 3v7, 4v8) and round 2 must fold each score group by SEED, which is a
    // different answer from both of the rank-adjacent sets above.
    const { auth } = await seedOrg();
    const { divisionId, nameOf } = await seedBadmintonDivision(auth, 8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: swissRoundsFor(8) },
      progression: null,
    });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stage!.id);

    const round1 = await fixturesOfRound(stage!.id, 1);
    expect(round1.map((f) => pairOf(f, nameOf)).sort()).toEqual([
      "E1|E5",
      "E2|E6",
      "E3|E7",
      "E4|E8",
    ]);

    await playRoundHomeWins(auth.orgId, stage!.id, 1); // winners E1..E4
    await generateStageFixtures(auth, stage!.id);

    const round2 = await fixturesOfRound(stage!.id, 2);
    // Fold over seed-ordered winners [E1,E2,E3,E4] ⇒ E1vE3, E2vE4;
    // over seed-ordered losers [E5,E6,E7,E8] ⇒ E5vE7, E6vE8.
    expect(round2.map((f) => pairOf(f, nameOf)).sort()).toEqual([
      "E1|E3",
      "E2|E4",
      "E5|E7",
      "E6|E8",
    ]);
  });

  it("caps a rank-adjacent swiss at the field's own round budget (8 entrants ⇒ 3)", async () => {
    // The rounds formula is not decoration: a stage that declares no `rounds`
    // stops generating once the field's band is spent. Proven by generating
    // past the cap, not by reading the config back.
    const { auth } = await seedOrg();
    const { divisionId, nameOf } = await seedBadmintonDivision(auth, 8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { pairing: "rank_adjacent", rounds: swissRoundsFor(8) },
      progression: null,
    });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stage!.id);
    await playRoundHomeWins(auth.orgId, stage!.id, 1);

    // Rounds 2 and 3 are seated one at a time; a fifth Pair is a no-op.
    for (const round of [2, 3]) {
      const made = await generateStageFixtures(auth, stage!.id);
      expect(made.created, `round ${round} created`).toBe(4);
      await playRoundHomeWins(auth.orgId, stage!.id, round);
    }
    const fifth = await generateStageFixtures(auth, stage!.id);
    expect(fifth.created).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select max(round_no)::int as n from fixtures where stage_id = ${stage!.id}`;
    expect(n).toBe(3);
    expect(nameOf.size).toBe(8);
  });

  it("still sits exactly one entrant out per round on an ODD rank-adjacent field", async () => {
    // Byes are pairRound's own, and the fold-mode tests in the engine cannot
    // speak for rank-adjacent mode (owner: verify, do not assume).
    const { auth } = await seedOrg();
    const { divisionId, nameOf } = await seedBadmintonDivision(auth, 7);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { pairing: "rank_adjacent", rounds: swissRoundsFor(7) },
      progression: null,
    });
    await startDivision(auth, divisionId);
    await generateStageFixtures(auth, stage!.id);

    // Round 1 is adjacent over the six pairable seeds with the bottom seed
    // sitting out — NOT the fold (which would have been E1vE4, E2vE5, E3vE6).
    // This is what makes the case discriminating rather than a shape check
    // that passes in both pairing models.
    const opener = await fixturesOfRound(stage!.id, 1);
    expect(
      opener.filter((f) => f.away_entrant_id !== null).map((f) => pairOf(f, nameOf)).sort(),
    ).toEqual(["E1|E2", "E3|E4", "E5|E6"]);
    expect(nameOf.get(opener.find((f) => f.away_entrant_id === null)!.home_entrant_id!)).toBe("E7");

    const byeNames: string[] = [];
    for (let round = 1; round <= 3; round++) {
      const rows = await fixturesOfRound(stage!.id, round);
      const byes = rows.filter((f) => f.away_entrant_id === null);
      expect(byes.length, `round ${round} bye count`).toBe(1);
      expect(rows.length - byes.length, `round ${round} pairing count`).toBe(3);
      byeNames.push(nameOf.get(byes[0]!.home_entrant_id!)!);
      await playRoundHomeWins(auth.orgId, stage!.id, round);
      if (round < 3) await generateStageFixtures(auth, stage!.id);
    }
    // A different entrant sits out each round — the "lowest-ranked not yet
    // byed" rule, unchanged by rank-adjacent pairing.
    expect(new Set(byeNames).size).toBe(3);

    // And nobody is ever paired against themselves or double-booked.
    for (let round = 1; round <= 3; round++) {
      const seen = new Set<string>();
      for (const f of await fixturesOfRound(stage!.id, round)) {
        for (const id of [f.home_entrant_id, f.away_entrant_id]) {
          if (!id) continue;
          expect(seen.has(id), `entrant twice in round ${round}`).toBe(false);
          seen.add(id);
        }
      }
      expect(seen.size).toBe(7);
    }
  });

  it("never writes over a rounds value that is already there — the organiser's edit wins", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedBadmintonDivision(auth, 8);
    const derived = swissRoundsForFieldSize(8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { pairing: "rank_adjacent", rounds: derived },
      progression: null,
    });
    expect(await configOf(stage!.id)).toMatchObject({ rounds: derived });

    // The organiser lengthens the swiss from the Settings tab — the same
    // `rounds` key that input writes. Deliberately NOT the derived number, so
    // a re-derivation on the next generation is visible twice over: as a
    // changed value AND as a round that never gets generated. A test that
    // edited it TO the derived number could not witness the regression.
    const declared = derived + 1;
    await sql`update stages set config = config || jsonb_build_object('rounds', ${declared}::int)
              where id = ${stage!.id}`;
    await startDivision(auth, divisionId);

    for (let round = 1; round <= declared; round++) {
      const made = await generateStageFixtures(auth, stage!.id);
      expect(made.created, `pair round ${round}`).toBe(4);
      await playRoundHomeWins(auth.orgId, stage!.id, round);
      expect(await configOf(stage!.id), `config after round ${round}`).toMatchObject({
        rounds: declared,
      });
    }
    const done = await generateStageFixtures(auth, stage!.id);
    expect(done.created).toBe(0);
    expect(await lastRoundOf(stage!.id)).toBe(declared);
  });
});

describe.runIf(HAS_DB)("swiss playoff — shell mint (Task 2)", () => {
  it("does not auto-persist config.rounds at generate — organiser must set it", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedBadmintonDivision(auth, 8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { pairing: "rank_adjacent", rounds: swissRoundsFor(8) },
      progression: null,
    });
    expect(await configOf(stage!.id)).toMatchObject({
      pairing: "rank_adjacent",
      rounds: swissRoundsFor(8),
    });

    await startDivision(auth, divisionId);

    expect(await configOf(stage!.id)).toMatchObject({
      pairing: "rank_adjacent",
      rounds: swissRoundsFor(8),
    });
  });

  it("first Generate mints every round's shells without seating anyone", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedBadmintonDivision(auth, 8);
    const rounds = swissRoundsFor(8);
    const [stage] = await createStages(auth, divisionId, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { pairing: "rank_adjacent", rounds },
      progression: null,
    });
    await startDivision(auth, divisionId);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stage!.id}`;
    expect(n).toBe(rounds * 4); // 4 boards × N rounds (8 entrants)
    expect(await lastRoundOf(stage!.id)).toBe(rounds);

    const unseated = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where stage_id = ${stage!.id}
        and home_entrant_id is null and away_entrant_id is null`;
    expect(unseated[0]!.n).toBe(rounds * 4);
  });
});
