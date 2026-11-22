// T16 fix round 1, I2 + M8 — `loadSideNames`, the ONE read the organiser queue and the Open-round confirmation now
// make for every board's names, must name each seat exactly as `loadSides` (the per-board reader the room, the
// invite and the Flagged list use) names it — so no board ever carries two names on one screen.
//
// The rulebook anchor (lib/entrant-name.ts): a singles entrant reads as its PERSON, never the registration snapshot
// ("Entry 3"); with no live member left it falls back to the snapshot, never to an id. Single-sport by
// construction: only a boardgame division can play online.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementTexts } from "@/lib/db";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { loadSideNames, loadSides, loadSidesOfBoards } from "../guard";

const HAS_DB = !!process.env.DATABASE_URL;
const LONG = "Maximiliana Wolfeschlegel-Featherstonehaugh";

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("loadSideNames — every seat's name in one read, as loadSides names it", () => {
  it("the empty case: no ids is an empty answer", async () => {
    expect(await loadSideNames([])).toEqual(new Map());
  });

  it("a person behind 'Entry 3', a tombstoned entrant, a merged-away person, an unknown id — each as loadSides says", async () => {
    const a = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: new Date(), linked: false });
    const b = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: new Date(), linked: false });
    // a.home: the person behind a snapshot (the F5 defect's shape), at the canvas's 43 characters.
    await sql`update entrants set display_name = 'Entry 3' where id = ${a.home.entrantId}`;
    await sql`update persons set full_name = ${LONG} where id = ${a.home.personId}`;
    // a.away: no member left — the snapshot is all there is.
    await sql`update entrants set display_name = 'Entry 4' where id = ${a.away.entrantId}`;
    await sql`delete from entrant_members where entrant_id = ${a.away.entrantId}`;
    // b.home: its only person merged into another — a tombstone is not an identity.
    await sql`update entrants set display_name = 'Entry 5' where id = ${b.home.entrantId}`;
    await sql`update persons set merged_into = ${b.away.personId} where id = ${b.home.personId}`;
    const unknown = randomUUID();

    const seats = [a.home, a.away, b.home, b.away];
    const names = await loadSideNames([...seats.map((s) => s.entrantId), unknown, a.home.entrantId]);

    // The rulebook's answers, typed from the rule, not read off the code.
    expect(names.get(a.home.entrantId)).toBe(LONG);
    expect(names.get(a.away.entrantId)).toBe("Entry 4");
    expect(names.get(b.home.entrantId)).toBe("Entry 5");
    expect(names.has(unknown), "an id that is not an entrant is absent").toBe(false);
    expect(names.size, "one answer per entrant, a repeated id once").toBe(seats.length);

    // And the per-board reader agrees on every seat.
    let checked = 0;
    for (const [s, fixture] of [[a.home, a], [a.away, a], [b.home, b], [b.away, b]] as const) {
      const sides = await loadSides({ homeEntrantId: fixture.home.entrantId, awayEntrantId: fixture.away.entrantId });
      const want = s === fixture.home ? sides.home.displayName : sides.away.displayName;
      expect(names.get(s.entrantId), s.entrantId).toBe(want);
      expect(names.get(s.entrantId), "never the id").not.toBe(s.entrantId);
      checked += 1;
    }
    expect(checked, "anti-vacuity: seats compared").toBe(4);
  });
});

// Gaps wave A fix round 1 (A10): `loadSidesOfBoards` is `loadSides` for MANY boards in ONE read (the round composition and the flagged lister
// read two statements per board, 80 of the 180 statements of a 32-board poll). The per-board reader is the rulebook here and is unchanged: each
// board's answer must be exactly what `loadSides` gives for it - on every shape the seats take - and the whole list costs one statement.
describe.skipIf(!HAS_DB)("loadSidesOfBoards - every board's two sides in one read, as loadSides reads them", () => {
  const board = (home: string | null, away: string | null) => ({ homeEntrantId: home as string, awayEntrantId: away as string });

  it("the empty case first: no boards is no answers and no statement", async () => {
    const before = statementTexts().length;
    expect(await loadSidesOfBoards([])).toEqual([]);
    expect(statementTexts().length - before, "nothing was asked of the database").toBe(0);
  });

  it("each board reads exactly as loadSides reads it - a linked pair, a team of two, a tombstoned seat, a merged-away person, a deleted account, one entrant on both seats, a placeholder seat, an unknown id, a board listed twice - in ONE statement", async () => {
    const a = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: new Date(), linked: true });
    const b = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: new Date(), linked: false });
    const c = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: new Date(), linked: true });
    // A team: a.home gains two more members, inserted in DESCENDING person-id order, so only the readers' `order by person_id` makes the
    // members come back in the same order (the natural order of the rows is the reverse).
    const [orgRow] = await sql<{ org_id: string }[]>`select org_id from entrants where id = ${a.home.entrantId}`;
    const mates = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${orgRow!.org_id}, 'Mate One'), (${orgRow!.org_id}, 'Mate Two') returning id`;
    const [low, high] = mates.map((m) => m.id).sort() as [string, string];
    for (const person of [high, low]) await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${a.home.entrantId}, ${person}, ${orgRow!.org_id})`;
    await sql`update entrants set kind = 'team', display_name = 'The Team' where id = ${a.home.entrantId}`;
    // b.away: no member left. c.home: its only person merged away. c.away: a deleted account (not mailed).
    await sql`delete from entrant_members where entrant_id = ${b.away.entrantId}`;
    await sql`update persons set merged_into = ${c.away.personId} where id = ${c.home.personId}`;
    await sql`update users set deleted_at = now() where id = ${c.away.userId}`;

    const boards = [
      board(a.home.entrantId, a.away.entrantId),
      board(b.home.entrantId, b.away.entrantId),
      board(c.home.entrantId, c.away.entrantId),
      board(a.away.entrantId, a.away.entrantId), // one entrant on both seats
      board(null, b.home.entrantId), // a placeholder seat (V529): no entrant yet
      board(randomUUID(), c.away.entrantId), // an id that is not an entrant
      board(a.home.entrantId, a.away.entrantId), // the same board listed twice
    ];
    await loadSidesOfBoards(boards); // warm
    const before = statementTexts().length;
    const batch = await loadSidesOfBoards(boards);
    const issued = statementTexts().length - before;

    expect(issued, "seven boards, one read").toBe(1);
    expect(batch, "one answer per board, in the order asked").toHaveLength(boards.length);
    let checked = 0;
    for (const [i, one] of boards.entries()) {
      const want = await loadSides(one);
      expect(batch[i], `board ${i}`).toEqual(want);
      checked += 2;
    }
    expect(checked, "anti-vacuity: every seat of every board compared").toBe(boards.length * 2);
    // The premises the comparison leans on: the set really holds each shape (a parity over seats that are all alike proves nothing).
    expect(batch[0]!.home.members.map((m) => m.person_id), "the team's members, in person-id order").toEqual([low, high, a.home.personId!].sort());
    expect(batch[0]!.away.lichess, "a linked seat").not.toBeNull();
    expect(batch[1]!.home.lichess, "an unlinked seat").toBeNull();
    expect(batch[1]!.away.members, "a tombstoned seat has no member").toEqual([]);
    expect(batch[2]!.away.recipients, "a deleted account is not mailed").toEqual([]);
    expect(batch[4]!.home.entrantId, "the placeholder seat keeps its (absent) id").toBeNull();
    expect(batch[3]!.home.side, "the seat's side is the board's, not the entrant's").toBe("home");
    expect(batch[3]!.away.side).toBe("away");
  });
});
