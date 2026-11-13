// F-T8-6 (owner, 13 Nov 2026): the free-court panel said "Nothing is waiting" while the court list showed a Women's Singles
// match queued on Court 1, because a court offered only its FIRST ready queued match and the desk then filtered by division.
// A court offers its first ready queued match PER DIVISION, so a division filter can never empty the panel while the court
// list shows a match of that division. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { matchDayCandidates } from "../match-day";
import { at, between, person, place, seedCompetition, seedDay } from "./_match-day-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("matchDayCandidates — one per division per court", () => {
  it("a court's queue of two divisions offers each division's first ready match; a one-division queue is unchanged", async () => {
    const day = await seedDay();
    const [p1, p2, p3] = day.comp.pairs;
    // A second division in the same competition, with its own two people.
    const solo = [await person(day.orgId, "Ida Iyer"), await person(day.orgId, "Jon Joy")];
    const singles = await seedCompetition(day.auth, "Singles", solo.map((p) => [p]), {
      courts: [day.courts.c1, day.courts.c2, day.courts.c3],
      competitionId: day.comp.id,
      division: "Singles",
    });
    const doublesFirst = between(day.comp, p1!, p2!);
    const doublesSecond = between(day.comp, p1!, p3!);
    const singlesFirst = singles.fixtures[0]!;
    // Court 1's queue: a Doubles match, another Doubles match, then the Singles one.
    await place(day, doublesFirst.id, 10, day.courts.c1);
    await place(day, doublesSecond.id, 40, day.courts.c1);
    await place(day, singlesFirst.id, 70, day.courts.c1);

    const offered = await matchDayCandidates(day.auth, day.comp.id, day.courts.c3, at(0));
    const fromCourt1 = offered.filter((c) => c.from_court_name === "Court 1").map((c) => [c.fixture.division_name, c.fixture.id]);

    // The Doubles one first in the queue, and the Singles one — never the second Doubles match.
    expect(fromCourt1).toEqual(expect.arrayContaining([["Doubles", doublesFirst.id], ["Singles", singlesFirst.id]]));
    expect(fromCourt1).toHaveLength(2);

    // Filtering by the second division (what the desk's panel does) leaves the Singles match.
    expect(offered.filter((c) => c.fixture.division_name === "Singles").map((c) => c.fixture.id)).toContain(singlesFirst.id);
    // Filtering by the first division changes nothing from before: its first ready match.
    expect(offered.filter((c) => c.fixture.division_name === "Doubles" && c.from_court_name === "Court 1").map((c) => c.fixture.id)).toEqual([
      doublesFirst.id,
    ]);
  });
});
