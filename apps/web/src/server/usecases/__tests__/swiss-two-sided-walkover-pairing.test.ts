// "Pair next" after a real two-sided walkover (2026-09-24, case 3 of the
// Saturday swiss probe — `swiss-walkover-saturday.test.ts` S3).
//
// Every sport kernel emits `{kind: "award", winner}` for a two-sided walkover
// or retirement (see `lib/fixture-bye.ts`). swissGen's history fold used to
// treat ANY award as a bye, so after A beat H by walkover:
//   - A was recorded as having had a BYE;
//   - the pair was never added to `played`, so A and H could meet again;
//   - H appeared in no round-1 row, so the implicit-bye pass credited the
//     ABSENT player a pairing point, lifting H into the winners' score group.
// A two-sided award is a played match. Only `isOneSidedAwardBye` rows are byes.
//
// Each case drives the real producers — the Forfeit button's `core.forfeit`
// and the scorer's quick result through `scoreEvent` — into the real consumer,
// `generateStageFixtures`. Three shapes, because each kills a different wrong
// reading (see each case), and one sample is not a sweep:
//   1. rank_adjacent, seed 6 walks over to seed 3 — the production shape; the
//      old fold re-paired A v H here.
//   2. fold, same walkover — only the winner's +1 for the award puts A in the
//      winners' group and so on seed 4 (not seed 5) when A floats down.
//   3. fold + chess, seed 3 walks over to seed 6 — H is then the first
//      candidate for A, so only the `played` entry stops a rematch; and the
//      colours show that a forfeited game assigns no colour (the engine's own
//      rule: tiebreakers.ts colour history skips byes/forfeits, boardgame
//      DOMAIN.md "A forfeited game is excluded from colour history").
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
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

interface FixtureRow {
  id: string;
  ext_key: string | null;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; method?: string } | null;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select id, ext_key, round_no, home_entrant_id, away_entrant_id, status, outcome
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

interface Rig {
  auth: AuthCtx;
  stageId: string;
  /** "S1".."S6" → entrant id. */
  id: (name: string) => string;
  /** entrant id → "S1".."S6". */
  name: (id: string | null) => string;
}

/** Six individuals seeded S1..S6 in a 3-round swiss, started, round 1 paired. */
async function pairedRoundOne(config: Record<string, unknown>): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss walkover " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 6 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `S${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3, ...config },
    progression: null,
  });
  await startDivision(auth, division.id); // mints the shells
  await generateStageFixtures(auth, stage!.id); // Pair round 1
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const byId = new Map(entrants.map((e) => [e.id, e.display_name]));
  return {
    auth,
    stageId: stage!.id,
    id: (n) => byName.get(n)!,
    name: (i) => (i === null ? "-" : (byId.get(i) ?? i)),
  };
}

/** The Forfeit button: `by` is the side at fault. */
async function forfeitBy(auth: AuthCtx, fixtureId: string, by: string): Promise<void> {
  const state = await getFixtureState(auth, fixtureId);
  await scoreEvent(auth, fixtureId, {
    expected_seq: state.last_seq,
    type: "core.forfeit",
    payload: { by, reason: "walkover" },
  });
}

/** The scorer's quick result: the HOME side wins 21-10, 21-10. */
async function homeWins(auth: AuthCtx, fixtureId: string): Promise<void> {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  for (const seq of [1, 2]) {
    await scoreEvent(auth, fixtureId, {
      expected_seq: seq,
      type: "badminton.game.summary",
      payload: { home: 21, away: 10 },
    });
  }
}

const boardOf = (rows: FixtureRow[], round: number, who: string) =>
  rows.find((f) => f.round_no === round && (f.home_entrant_id === who || f.away_entrant_id === who))!;

/**
 * Round 1 is a fold (1v4, 2v5, 3v6) whatever the stored mode. `noShow`
 * forfeits its board; the other two boards go to the home side (seeds 1, 2).
 * Returns the walkover winner A and the no-show H.
 */
async function playRoundOne(rig: Rig, noShow: string): Promise<{ A: string; H: string }> {
  const r1 = (await fixturesOf(rig.stageId)).filter((f) => f.round_no === 1);
  expect(r1.map((f) => `${rig.name(f.home_entrant_id)} v ${rig.name(f.away_entrant_id)}`)).toEqual([
    "S1 v S4",
    "S2 v S5",
    "S3 v S6",
  ]);
  const H = rig.id(noShow);
  const walkover = boardOf(r1, 1, H);
  const A = walkover.home_entrant_id === H ? walkover.away_entrant_id! : walkover.home_entrant_id!;
  await forfeitBy(rig.auth, walkover.id, H);
  for (const f of r1) if (f.id !== walkover.id) await homeWins(rig.auth, f.id);

  // The premise this file exists for: a TWO-SIDED award, not a bye row and
  // not a `win`/forfeit. If a kernel ever changes that, this goes red first.
  const decided = (await fixturesOf(rig.stageId)).find((f) => f.id === walkover.id)!;
  expect(decided.status).toBe("forfeited");
  expect(decided.outcome).toMatchObject({ kind: "award", winner: A });
  expect([decided.home_entrant_id, decided.away_entrant_id].sort()).toEqual([A, H].sort());
  return { A, H };
}

async function pairRoundTwo(rig: Rig): Promise<FixtureRow[]> {
  await generateStageFixtures(rig.auth, rig.stageId);
  return (await fixturesOf(rig.stageId)).filter((f) => f.round_no === 2);
}

const shape = (rig: Rig, rows: FixtureRow[]) =>
  rows.map((f) => `${rig.name(f.home_entrant_id)} v ${rig.name(f.away_entrant_id)}`);

describe.runIf(HAS_DB)("swiss Pair next — a two-sided walkover is a played match, not a bye", () => {
  it("rank_adjacent (the production shape): A and H are not re-paired, and H pairs among the round-1 losers", async () => {
    const rig = await pairedRoundOne({ pairing: "rank_adjacent" });
    const { A, H } = await playRoundOne(rig, "S6");
    expect(rig.name(A)).toBe("S3");

    const r2 = await pairRoundTwo(rig);
    // No rematch. Before the fix this board was `S3 v S6` — A v H again.
    const hBoard = boardOf(r2, 2, H);
    expect([rig.name(hBoard.home_entrant_id), rig.name(hBoard.away_entrant_id)], "A meets H once only").not.toContain(
      rig.name(A),
    );
    // No phantom point for the absent H: H's opponent is a round-1 LOSER.
    const hOpponent = hBoard.home_entrant_id === H ? hBoard.away_entrant_id : hBoard.home_entrant_id;
    expect(["S4", "S5"], "H pairs in the 0-point group").toContain(rig.name(hOpponent));
    // Winners S1, S2, A on 1; S4, S5, H on 0. A, the lowest-ranked winner,
    // floats down to the top of the 0 group.
    expect(shape(rig, r2)).toEqual(["S1 v S2", "S3 v S4", "S5 v S6"]);
    expect(r2.every((f) => f.outcome === null), "an even field: no bye row in round 2").toBe(true);
  });

  it("fold: the walkover winner scores +1, so A floats down onto seed 4 — not seed 5 as a 0-point A would fold", async () => {
    const rig = await pairedRoundOne({});
    const { A, H } = await playRoundOne(rig, "S6");
    expect([rig.name(A), rig.name(H)]).toEqual(["S3", "S6"]);

    const r2 = await pairRoundTwo(rig);
    // A on 1 floats as the top of the 0 group and takes its first candidate,
    // S4. Had the award scored nothing, A would sit INSIDE the 0 group
    // [A, S4, S5, H] and fold onto S5 (then S4 v H). Had the award been a bye,
    // H's phantom point would put H into the winners' group (S2 v H).
    expect(shape(rig, r2)).toEqual(["S1 v S2", "S3 v S4", "S5 v S6"]);
  });

  it("fold + chess: H is A's first candidate, so only `played` stops the rematch; the forfeit gives neither side a colour", async () => {
    const rig = await pairedRoundOne({ chess: true });
    // Seed 3 no-shows against seed 6, so the no-show H sits at the TOP of the
    // 0 group — the first candidate for A when A floats down.
    const { A, H } = await playRoundOne(rig, "S3");
    expect([rig.name(A), rig.name(H)]).toEqual(["S6", "S3"]);

    const r2 = await pairRoundTwo(rig);
    const hBoard = boardOf(r2, 2, H);
    expect([rig.name(hBoard.home_entrant_id), rig.name(hBoard.away_entrant_id)], "A meets H once only").not.toContain(
      rig.name(A),
    );
    // Home is White. Round 1 gave S1, S2 (and the forfeited S3) White.
    //   S2 v S1 — both prefer Black after one White; the upper board S1 gets it.
    //   S4 v S6 — S4 (Black in R1) prefers White; S6 has NO colour history
    //             because its only game was a forfeit, so S4 gets White. Had
    //             the forfeit recorded S6 as Black, both would claim White and
    //             the upper board S6 would take it (S6 v S4).
    //   S5 v S3 — S5 (Black in R1) takes White; S3 has no colour either.
    expect(shape(rig, r2)).toEqual(["S2 v S1", "S4 v S6", "S5 v S3"]);
  });
});
