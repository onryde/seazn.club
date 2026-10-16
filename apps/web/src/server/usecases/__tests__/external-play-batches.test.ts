// Capacity tests 3 and 10 (spec §8.1; §3.2.1): a board's batch follows its POSITION among every fixture row of its round,
// and online play - hence batching - exists for one sport.
//
// Test 3 drives the rank through its two real readers: `boardRankSql` (the one SQL fragment every window question
// interpolates) and `boardOpenFor` (the reader the seat, the room, the create and the invite start from). Expected ranks are
// written from how each round was BUILT (which rows exist and what their `(seq_in_round, id)` are) and the §3.2.1 rule that
// every row counts - never read back from the code under test.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { forEachSport } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { withdrawEntrantCascade } from "../withdrawal";
import { openRound } from "../external-play/open-round";
import { boardOpenFor, boardRankSql } from "@/server/external-play/round-open";
import { assertCameraPolicyForSport, stageCameraPolicy } from "@/server/external-play/camera-policy";
import { supportsOnlinePlay } from "@/server/external-play/online-play";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  WINDOW_OPEN_LEAD_MS,
  batchOfRank,
  boardAnchor,
  windowFor,
} from "@/server/external-play/window";
import { seedOnlineChessRound, seedOnlineChessRoundWithRankedBoard } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendExternalPlayInviteEmail: vi.fn(async () => true) };
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const T = new Date("2026-10-01T12:00:30.000Z");

/** Every fixture row of the round as the rank rule sees it: `(seq, id)` ascending, the id compared as text (a lowercase uuid
 *  compares like its bytes, which is how Postgres orders it). */
async function rowsOf(stageId: string, roundNo: number): Promise<{ id: string; seq: number }[]> {
  const rows = await sql<{ id: string; seq: number }[]>`
    select id, seq_in_round as seq from fixtures where stage_id = ${stageId} and round_no = ${roundNo}`;
  return [...rows].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The rank each reader answers for one fixture: the SQL fragment on its own, and the anchor reader's. */
async function readRanks(fixtureId: string): Promise<{ fragment: number; reader: number | null }> {
  const [row] = await sql<{ rank: number }[]>`select ${boardRankSql(sql)} as rank from fixtures f where f.id = ${fixtureId}`;
  const open = await boardOpenFor(sql, fixtureId);
  return { fragment: row!.rank, reader: open?.rank ?? null };
}

/** Assert every row of the round has the rank its position gives; return how many rows were checked. */
async function expectRanksByPosition(stageId: string, roundNo: number, label: string): Promise<number> {
  const rows = await rowsOf(stageId, roundNo);
  expect(rows.length, `${label}: premise - the round has rows`).toBeGreaterThan(1);
  let checked = 0;
  for (const [position, row] of rows.entries()) {
    const got = await readRanks(row.id);
    expect(got.fragment, `${label}: boardRankSql, row at position ${position} (seq ${row.seq})`).toBe(position);
    expect(got.reader, `${label}: boardOpenFor, row at position ${position} (seq ${row.seq})`).toBe(position);
    checked += 1;
  }
  expect(checked, `${label}: every row checked`).toBe(rows.length);
  return checked;
}

describe.skipIf(!HAS_DB)("rank over every row (capacity test 3)", () => {
  it("a BYE keeps its rank, and so does the board behind it: the round opens, and the ranks are the positions", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 3, bye: true, cameraPolicy: "optional" });
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T })).toMatchObject({ opened: true });
    // Built as: boards at seq 1-3, the bye at seq 4 (the seed's insertion order).
    const byeRank = await readRanks(r.bye!.fixtureId);
    expect(byeRank, "the bye is the fourth row").toEqual({ fragment: 3, reader: 3 });
    const checked = await expectRanksByPosition(r.stageId, 1, "bye round");
    expect(checked, "rows checked").toBe(4);
  });

  it("a WITHDRAWN entrant's board keeps its rank, and the board of the next batch stays in its batch (differential)", async () => {
    // Board 1 (rank 0), S - 1 abandoned shells, then a real board at rank S: batch 1, whatever happens to board 1.
    const S = CHECKIN_BATCH_SIZE;
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "optional" }, S);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T })).toMatchObject({ opened: true });
    const before = await boardOpenFor(sql, r.ranked.fixtureId);
    expect(before!.rank, "premise: the real board is at rank S").toBe(S);
    expect(before!.anchor.batch, "premise: in batch 1").toBe(batchOfRank(S));
    expect(before!.anchor.at.getTime() - T.getTime()).toBe(CHECKIN_BATCH_GAP_MS);

    await withdrawEntrantCascade(r.owner, r.boards[0]!.away.entrantId);
    const [first] = await sql<{ status: string }[]>`select status from fixtures where id = ${r.boards[0]!.fixtureId}`;
    expect(["scheduled", "live"], "premise: the withdrawal ended board 1 (the row stays)").not.toContain(first!.status);

    const after = await boardOpenFor(sql, r.ranked.fixtureId);
    expect(after!.rank, "a withdrawal behind no one moves no one").toBe(S);
    expect(after!.anchor, "batch and start unmoved").toEqual(before!.anchor);
    const checked = await expectRanksByPosition(r.stageId, 1, "withdrawn round");
    expect(checked, "rows checked: board 1, S - 1 shells, the real board").toBe(S + 1);
  });

  it("a GAP in seq_in_round does not matter: rank is the position, not the number", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 3, cameraPolicy: "optional" });
    // Renumber 1,2,3 to 3,17,90 - the order is the same, the numbers are nothing like their positions.
    for (const [i, seq] of [3, 17, 90].entries()) {
      await sql`update fixtures set seq_in_round = ${seq} where id = ${r.boards[i]!.fixtureId}`;
    }
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T })).toMatchObject({ opened: true });
    const got = await Promise.all(r.boards.map(async (b) => (await readRanks(b.fixtureId)).reader));
    expect(got, "ranks 0, 1, 2 for seq 3, 17, 90").toEqual([0, 1, 2]);
    expect(await expectRanksByPosition(r.stageId, 1, "gap round")).toBe(3);
  });

  it("a DUPLICATE seq_in_round across pools ranks by position over the whole round: a tie breaks by id, ranks stay contiguous", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 3, cameraPolicy: "optional" });
    const pools: string[] = [];
    for (const key of ["A", "B"]) {
      const [p] = await sql<{ id: string }[]>`
        insert into pools (stage_id, org_id, key, name) values (${r.stageId}, ${r.orgId}, ${key}, ${`Pool ${key}`}) returning id`;
      pools.push(p!.id);
    }
    // Board 1 in pool A, board 2 in pool B - both seq 1 - and board 3 (seq 2) in pool A. Each pool's own numbering restarts.
    await sql`update fixtures set pool_id = ${pools[0]!}, seq_in_round = 1 where id = ${r.boards[0]!.fixtureId}`;
    await sql`update fixtures set pool_id = ${pools[1]!}, seq_in_round = 1 where id = ${r.boards[1]!.fixtureId}`;
    await sql`update fixtures set pool_id = ${pools[0]!}, seq_in_round = 2 where id = ${r.boards[2]!.fixtureId}`;
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T })).toMatchObject({ opened: true });
    const rows = await rowsOf(r.stageId, 1);
    expect(rows.map((x) => x.seq), "premise: a duplicate seq").toEqual([1, 1, 2]);
    const ranks = (await Promise.all(r.boards.map(async (b) => (await readRanks(b.fixtureId)).reader))).sort();
    expect(ranks, "contiguous 0..2, no two boards share a rank").toEqual([0, 1, 2]);
    // The two seq-1 boards take ranks 0 and 1 in id order; seq 2 is rank 2.
    const [firstTie, secondTie] = rows;
    expect((await readRanks(firstTie!.id)).reader).toBe(0);
    expect((await readRanks(secondTie!.id)).reader).toBe(1);
    expect((await readRanks(r.boards[2]!.fixtureId)).reader).toBe(2);
    expect(await expectRanksByPosition(r.stageId, 1, "pools round")).toBe(3);
  });

  it("rows of OTHER rounds of the stage do not count: a later round's first board is rank 0 behind a full earlier round", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 3, cameraPolicy: "optional" });
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T })).toMatchObject({ opened: true });
    // Round 2 of the same stage: two abandoned rows, and a stamp so the reader finds the round open.
    const ids: string[] = [];
    for (const seq of [1, 2]) {
      const [row] = await sql<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
        values (${r.stageId}, ${r.divisionId}, ${r.orgId}, 2, ${seq}, ${`t19-r2-${seq}-${randomUUID().slice(0, 6)}`}, 'abandoned')
        returning id`;
      ids.push(row!.id);
    }
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by, staggered)
      values (${r.stageId}, ${r.orgId}, 2, ${T}, ${r.ownerUserId}, true)`;
    const roundTwo = (await Promise.all(ids.map((id) => readRanks(id)))).map((x) => x.reader).sort();
    expect(roundTwo, "round 2's rows are ranked among round 2's rows only").toEqual([0, 1]);
    // And round 1 is as it was: three real boards, ranks 0-2, with round 2's rows beside them.
    expect(await expectRanksByPosition(r.stageId, 1, "round 1 beside round 2")).toBe(3);
    expect(await expectRanksByPosition(r.stageId, 2, "round 2")).toBe(2);
  });

  it("a RE-PAIR after the round opened (a board's entrants replaced) and a board added behind: no board's rank or batch moves", async () => {
    const S = CHECKIN_BATCH_SIZE;
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "optional" }, S);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T })).toMatchObject({ opened: true });
    const real = [r.boards[0]!.fixtureId, r.ranked.fixtureId];
    const before = await Promise.all(real.map((id) => boardOpenFor(sql, id)));
    // Re-pair: board 1 now seats the ranked board's pair and the ranked board board 1's (a swap of entrants in place).
    await sql`update fixtures set home_entrant_id = ${r.ranked.home.entrantId}, away_entrant_id = ${r.ranked.away.entrantId}
               where id = ${r.boards[0]!.fixtureId}`;
    await sql`update fixtures set home_entrant_id = ${r.boards[0]!.home.entrantId}, away_entrant_id = ${r.boards[0]!.away.entrantId}
               where id = ${r.ranked.fixtureId}`;
    // And one more board appended behind everything.
    const [added] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
      values (${r.stageId}, ${r.divisionId}, ${r.orgId}, 1, ${S + 5}, ${`t19-added-${randomUUID().slice(0, 6)}`}, 'abandoned')
      returning id`;
    const after = await Promise.all(real.map((id) => boardOpenFor(sql, id)));
    expect(after.map((a) => a!.rank), "ranks unmoved").toEqual(before.map((b) => b!.rank));
    expect(after.map((a) => a!.anchor), "anchors unmoved").toEqual(before.map((b) => b!.anchor));
    expect((await readRanks(added!.id)).reader, "the new board is last").toBe(S + 1);
    expect(await expectRanksByPosition(r.stageId, 1, "re-paired round")).toBe(S + 2);
  });
});

describe("the sport registry (capacity test 10)", () => {
  it("exactly one sport plays online - boardgame - and every other sport's round cannot stagger", () => {
    const online: string[] = [];
    let others = 0;
    const visited = forEachSport(({ key }) => {
      if (supportsOnlinePlay(key)) {
        online.push(key);
        return;
      }
      others += 1;
      // A camera requirement - what makes a round stagger - cannot be set on a sport that does not play online...
      expect(() => assertCameraPolicyForSport(key, "required"), `${key}: required`).toThrow();
      expect(() => assertCameraPolicyForSport(key, "optional"), `${key}: optional`).toThrow();
      // ...so its round is a single, unstaggered batch: every board opens at T - the lead, none later, whatever its rank.
      for (const rank of [0, CHECKIN_BATCH_SIZE, 3 * CHECKIN_BATCH_SIZE]) {
        const w = windowFor(boardAnchor(T, rank, false));
        expect(w.opensAt.getTime(), `${key}: rank ${rank} opens with the round`).toBe(T.getTime() - WINDOW_OPEN_LEAD_MS);
      }
    });
    expect(visited, "sports in the registry").toBeGreaterThan(1);
    expect(online, "registry pin: ONE sport plays online - widen the batch rules on purpose if this changes").toEqual(["boardgame"]);
    expect(others, "every other sport was checked").toBe(visited - 1);
  });
});

describe.skipIf(!HAS_DB)("a stage with no camera requirement does not stagger (capacity test 10, DB leg)", () => {
  it("the policy that decides `staggered` reads `off` for a stage of a division that set none", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    expect(await stageCameraPolicy(sql, r.stageId)).toBe("off");
  });
});
