// Match Day online, Task 7 (owner ruling MD-R15): the round panel offers "Pair next round" once a round is over, so each row of
// `readOnlineRounds` says which round its STAGE would pair next - `pair_next_round`, from the same rule the stage rail reads
// (`nextUnseatedSwissRound`, lib/swiss-shell.ts: the lowest round that still has an unseated board).
//
// Chess-only by construction (online play is `boardgame`), so no sport registry to sweep. What IS enumerated: every kind of stage the
// online block can sit on that the seeds reach (a Swiss, a league), and the rows of one stage (the stamp is the STAGE's, not the row's).
//
// Expected values are the rulebook's: a Swiss with `rounds: 3` mints three rounds of shells at the first generate and seats round 1 at the
// second, so the lowest round with an unseated board is 2; once round 2's boards are seated it is 3; once every round is seated there
// is none. A league has no round to pair. The setup that stands for the generator's SEATING of round 2 is named where it is used.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { MatchDayView } from "@/server/api-v1/schemas";
import { readOnlineRounds } from "../match-day-online";
import { seedOnlineChessRound, seedOnlineSwiss } from "./_external-play-seed";
import { NOW, at, openStamp } from "./_match-day-online-seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** What the generator's second "Pair next round" leaves on round `roundNo`'s shells: both seats filled (entrants of the seeded field, in board order). The real generator is driven end to end by the e2e (pair next, then open next). */
async function seatRound(stageId: string, roundNo: number, home: string[], away: string[]): Promise<void> {
  const boards = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and round_no = ${roundNo} order by seq_in_round`;
  expect(boards.length, `premise: round ${roundNo} has shells`).toBeGreaterThan(0);
  for (const [i, b] of boards.entries()) {
    await sql`update fixtures set home_entrant_id = ${home[i]!}, away_entrant_id = ${away[i]!} where id = ${b.id}`;
  }
}

describe.runIf(HAS_DB)("readOnlineRounds - pair_next_round: the round the row's stage would pair next", () => {
  it("EMPTY CASE FIRST: a league has no round to pair - null on its row", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    await openStamp(r, 1, at(-5));
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(rows.length, "premise: the round is listed").toBe(1);
    expect(rows[0]!.pair_next_round).toBeNull();
  });

  it("a Swiss whose round 1 is seated and round 2 is not: the opened round 1's row says 2", async () => {
    const r = await seedOnlineSwiss({ players: 4, rounds: 3 });
    await openStamp(r, 1, at(-5));
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(rows.map((x) => x.round_no), "premise: one row, round 1").toEqual([1]);
    expect(rows[0]!.round, "premise: the round is opened").not.toBeNull();
    expect(rows[0]!.pair_next_round).toBe(2);
  });

  it("the SEQUENCE: round 2 seated moves it to 3 (and round 2 is then listed paired, 'ready to open'); every round seated, none", async () => {
    const r = await seedOnlineSwiss({ players: 4, rounds: 3 });
    await openStamp(r, 1, at(-5));
    const [e1, e2, e3, e4] = r.players.map((p) => p.entrantId) as [string, string, string, string];
    await seatRound(r.stageId, 2, [e1, e3], [e4, e2]);
    const afterTwo = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(afterTwo.find((x) => x.round_no === 1)!.pair_next_round, "round 2 is seated, so round 3 is next").toBe(3);
    expect(afterTwo.find((x) => x.round_no === 2)?.phase, "and round 2 is now a paired, not opened row: the panel's 'ready to open'").toBe("before");
    await seatRound(r.stageId, 3, [e1, e2], [e3, e4]);
    const afterThree = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(afterThree.find((x) => x.round_no === 1)!.pair_next_round, "every round is seated: nothing left to pair").toBeNull();
  });

  it("the stamp is the stage's: a paired-not-opened row (round null) of the same stage carries the same number", async () => {
    const r = await seedOnlineSwiss({ players: 4, rounds: 3 });
    // Round 1 seated and NOT opened: the only row is the paired one (phase before), round null.
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(rows.length, "premise: one paired row").toBe(1);
    expect(rows[0]!.round, "premise: not opened").toBeNull();
    expect(rows[0]!.phase).toBe("before");
    expect(rows[0]!.pair_next_round).toBe(2);
  });

  it("a division that has not started: the not_started row carries the field too (null or a number, never absent)", async () => {
    const r = await seedOnlineSwiss({ players: 4, rounds: 3, divisionStarted: false });
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(rows.length).toBe(1);
    expect(rows[0]!.phase).toBe("not_started");
    expect("pair_next_round" in rows[0]!, "present on the row").toBe(true);
  });

  it("the wire: the field crosses the zod schema (a plain z.object strips an undeclared key) with its number intact", async () => {
    const r = await seedOnlineSwiss({ players: 4, rounds: 3 });
    await openStamp(r, 1, at(-5));
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    const parsed = MatchDayView.shape.online_rounds.parse(rows);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.pair_next_round).toBe(2);
  });
});
