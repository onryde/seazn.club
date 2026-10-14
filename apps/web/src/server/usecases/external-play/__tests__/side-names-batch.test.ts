// T16 fix round 1, I2 + M8 — `loadSideNames`, the ONE read the organiser queue and the Open-round confirmation now
// make for every board's names, must name each seat exactly as `loadSides` (the per-board reader the room, the
// invite and the Flagged list use) names it — so no board ever carries two names on one screen.
//
// The rulebook anchor (lib/entrant-name.ts): a singles entrant reads as its PERSON, never the registration snapshot
// ("Entry 3"); with no live member left it falls back to the snapshot, never to an id. Single-sport by
// construction: only a boardgame division can play online.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { loadSideNames, loadSides } from "../guard";

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
