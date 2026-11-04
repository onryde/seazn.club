// W3 app-B final review m4: what a Swiss FED with carry-over (`progression.carry: "points"`) pairs on, pinned end to end —
// a real league played by real scoring writes, completed by the real `completeStage`, seeding the Swiss through the real
// carry writer (`config.carry_deltas`), and each round paired by the real Generate.
//
// The review's premise was that T5 (X-SW-19: the pairing score IS the stage's table points, `stageTablePoints`) made round 1
// pair by the CARRIED points. Driven through the producer, it does not: the table's entrants are the entrants holding a
// SEAT in the stage (`loadStageInputs`), and before round 1 is paired nobody holds one, so the table is empty, every score
// is 0 and round 1 pairs as a fresh field. The carried points enter the pairing from round 2, once the field holds seats
// and the table opens on them (`openingDeltas`). Whether round 1 SHOULD pair by carried score groups is an owner question
// (final-fix-report.md, m4); this file pins what ships, both rounds, so a change to either is a visible decision.
//
// Expected pairs come from the rulebook (FIDE C.04.3 Dutch: equal scores form a score bracket, a bracket of one floats down
// onto the next; within a bracket the top half meets the bottom half by pairing number), over scores stated here from the
// carried points as the carry writer stored them — never from the pairing code. Each round has a negative pair, the same
// graph with no carry, and the carried answer differs from it where the carry is meant to count, so the test witnesses it.
//
// Pairing numbers: the division seeds are the league's finishing order here (the higher seed wins every league game), so
// seed order = qualification order = carried order. This file does not separate those three orders.
//
// Single sport (boardgame, chess — the house Swiss sport) on purpose: the pairing score is the table's points through the one
// fold every sport shares (T5's suite sweeps the per-sport points); what is under test is the carry reaching the pairing.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}
const rowsOf = (stageId: string) =>
  sql<Row[]>`select id, ext_key, round_no, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const seated = (f: Row) => f.home_entrant_id !== null && f.away_entrant_id !== null;
const boardsOf = (rows: readonly Row[], round: number) => rows.filter((f) => f.round_no === round && seated(f));
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const pairsOf = (boards: readonly Row[]) => new Set(boards.map((f) => pairKey(f.home_entrant_id!, f.away_entrant_id!)));

async function win(auth: AuthCtx, f: Row, winner: string): Promise<void> {
  await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, f.id, { expected_seq: 1, type: "boardgame.result", payload: { winner, method: "resign" } });
}

/** A league of four (all qualify) feeding a 3-round Swiss, with or without `carry: "points"`. The higher seed wins every
 *  league game. Round 1 is paired by the real Generate. */
async function fedSwiss(carry: "points" | "none") {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Carry " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
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
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
  );
  const seedOf = new Map(entrants.map((e, i) => [e.id, i + 1]));
  const [league] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
  const [swiss] = await createStages(auth, division.id, {
    seq: 2,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3 },
    progression: {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
      ...(carry === "none" ? {} : { carry }),
    },
  } as never);
  await startDivision(auth, division.id);
  if ((await rowsOf(league!.id)).length === 0) await generateStageFixtures(auth, league!.id);
  const games = (await rowsOf(league!.id)).filter(seated);
  expect(games, "premise: a round robin of four").toHaveLength(6);
  for (const f of games) {
    const homeHigher = seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)!;
    await win(auth, f, homeHigher ? f.home_entrant_id! : f.away_entrant_id!);
  }
  expect(await completeStage(auth, league!.id, { publish: false })).toMatchObject({ completed: true });
  const [s] = await sql<{ config: { qualified?: string[]; carry_deltas?: { entrantId: string; points: number }[] } }[]>`
    select config from stages where id = ${swiss!.id}`;
  expect(s!.config.qualified, "premise: the Swiss is fed — its field is the league's four").toHaveLength(4);
  expect(boardsOf(await rowsOf(swiss!.id), 1), "premise: completing the league seats nobody; round 1 is the Generate's").toHaveLength(0);
  await generateStageFixtures(auth, swiss!.id);
  const r1 = boardsOf(await rowsOf(swiss!.id), 1);
  expect(r1, "premise: round 1 seats four on two boards").toHaveLength(2);
  return { auth, swissId: swiss!.id, qualified: s!.config.qualified!, carried: s!.config.carry_deltas ?? [], r1 };
}

/** Round 1 played — the 1st beats the 3rd, the 4th beats the 2nd — then round 2 paired by the real Generate. */
async function playRoundOneAndPairTwo(fed: Awaited<ReturnType<typeof fedSwiss>>): Promise<Set<string>> {
  const [q1, q2, q3, q4] = fed.qualified;
  for (const f of fed.r1) {
    const ids = new Set([f.home_entrant_id, f.away_entrant_id]);
    if (ids.has(q1!) && ids.has(q3!)) await win(fed.auth, f, q1!);
    else if (ids.has(q2!) && ids.has(q4!)) await win(fed.auth, f, q4!);
    else throw new Error("premise: round 1 is {1st, 3rd} and {2nd, 4th}");
  }
  await generateStageFixtures(fed.auth, fed.swissId);
  const r2 = boardsOf(await rowsOf(fed.swissId), 2);
  expect(r2, "premise: round 2 seats four on two boards").toHaveLength(2);
  return pairsOf(r2);
}

describe.runIf(HAS_DB)("final review m4: what a carry-fed Swiss pairs on", () => {
  it("round 1 pairs as a fresh field even with points carried: {1st, 3rd} and {2nd, 4th} — the carried score groups would pair {1st, 2nd}, {3rd, 4th}", async () => {
    const fed = await fedSwiss("points");
    expect(fed.carried, "premise: the carry writer stored one opening delta per qualifier").toHaveLength(4);
    const byPoints = [...fed.carried].sort((a, b) => b.points - a.points);
    expect(new Set(byPoints.map((d) => d.points)).size, "premise: four distinct carried scores — four one-player brackets").toBe(4);
    expect(byPoints.map((d) => d.entrantId), "premise: the carried order is the qualification order").toEqual(fed.qualified);
    const [q1, q2, q3, q4] = fed.qualified;
    // A fresh field: one bracket on 0, top half v bottom half by pairing number.
    expect(pairsOf(fed.r1)).toEqual(new Set([pairKey(q1!, q3!), pairKey(q2!, q4!)]));
  }, 300_000);

  it("round 2 pairs on carried + round-1 points: {1st, 2nd} and {3rd, 4th} — without the carry it is {1st, 4th}, {2nd, 3rd}", async () => {
    // After round 1 (1st beats 3rd, 4th beats 2nd), with carried c1 > c2 > c3 > c4 (6 / 4 / 2 / 0 half-points here) and a
    // win worth w = 2 half-points: 1st = c1 + w, 2nd = c2, 3rd = c3, 4th = c4 + w → 8 / 4 / 2 / 2. Brackets {1st}, {2nd},
    // {3rd, 4th}: the 1st floats onto the 2nd (no rematch), and the 3rd meets the 4th (no rematch).
    const fed = await fedSwiss("points");
    const [c1, c2, c3, c4] = fed.carried
      .slice()
      .sort((a, b) => b.points - a.points)
      .map((d) => d.points);
    expect([c1! - c2!, c2! - c3!, c3! - c4!].every((gap) => gap >= 2), "premise: the carried gaps are at least one win (2 half-points)").toBe(true);
    const [q1, q2, q3, q4] = fed.qualified;
    expect(await playRoundOneAndPairTwo(fed)).toEqual(new Set([pairKey(q1!, q2!), pairKey(q3!, q4!)]));
  }, 300_000);

  it("negative pair — no carry: round 1 is the same fresh fold, and round 2 pairs the two winners and the two losers", async () => {
    // No carry: after round 1 the 1st and 4th have w, the 2nd and 3rd have 0 → brackets {1st, 4th}, {2nd, 3rd}, no rematch.
    const fed = await fedSwiss("none");
    expect(fed.carried, "premise: nothing carried").toHaveLength(0);
    const [q1, q2, q3, q4] = fed.qualified;
    expect(pairsOf(fed.r1)).toEqual(new Set([pairKey(q1!, q3!), pairKey(q2!, q4!)]));
    expect(await playRoundOneAndPairTwo(fed)).toEqual(new Set([pairKey(q1!, q4!), pairKey(q2!, q3!)]));
  }, 300_000);
});
