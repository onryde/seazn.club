// MateInOne/MateInTwo used to share one global puzzle pool across every
// lesson that launched them (no per-lesson scoping), so all quest lessons
// using a given game showed the identical puzzle progression; HangingHunt
// (Piece Detective) had the same defect until its four lessons were given
// ranges too. The fix partitions each pool into a contiguous,
// non-overlapping range per lesson via gameOpts.range. This test derives the
// expected partition from LESSONS itself plus the pools' own lengths
// (MATE1.length / MATE2.length / HUNTS.length) — never a hardcoded table —
// so it moves with the source of truth.
import { describe, expect, it } from "vitest";
import { LESSONS } from "../lessons";
import { HUNTS, MATE1, MATE2 } from "../puzzles";

const RANGED_GAMES = {
  mateInOne: MATE1,
  mateInTwo: MATE2,
  hangingHunt: HUNTS,
} as const;

function assertContiguousCoveringPartition(gameId: keyof typeof RANGED_GAMES, poolLength: number) {
  const lessons = LESSONS.filter((l) => l.game === gameId).sort((a, b) => a.n - b.n);
  expect(lessons.length).toBeGreaterThan(0);

  let expectedStart = 0;
  for (const l of lessons) {
    const range = l.gameOpts?.range;
    expect(range, `lesson ${l.n} (game "${gameId}") is missing gameOpts.range`).toBeDefined();
    const [start, end] = range as [number, number];
    expect(start, `lesson ${l.n}: range should start where the previous one ended`).toBe(expectedStart);
    expect(end, `lesson ${l.n}: range end must be after its start`).toBeGreaterThan(start);
    expectedStart = end;
  }
  expect(expectedStart, `the ranges for "${gameId}" must exactly cover the pool of ${poolLength}`).toBe(
    poolLength,
  );
}

describe("ranged-game lesson ranges partition their pools", () => {
  for (const gameId of Object.keys(RANGED_GAMES) as (keyof typeof RANGED_GAMES)[]) {
    it(`${gameId} lessons partition their pool contiguously, in n order, covering it exactly once`, () => {
      assertContiguousCoveringPartition(gameId, RANGED_GAMES[gameId].length);
    });
  }

  // The point of scoping: no two lessons of a ranged game may ever show the
  // same puzzle. Enumerated pairwise so a regression to a shared slice (or a
  // dropped range on one lesson) names the two lessons that collide.
  it("no puzzle index is shared between two lessons of the same ranged game", () => {
    for (const gameId of Object.keys(RANGED_GAMES) as (keyof typeof RANGED_GAMES)[]) {
      const lessons = LESSONS.filter((l) => l.game === gameId);
      for (const a of lessons) {
        for (const b of lessons) {
          if (a.n >= b.n) continue;
          const ra = a.gameOpts?.range ?? [0, RANGED_GAMES[gameId].length];
          const rb = b.gameOpts?.range ?? [0, RANGED_GAMES[gameId].length];
          const overlap = Math.max(0, Math.min(ra[1], rb[1]) - Math.max(ra[0], rb[0]));
          expect(overlap, `lessons ${a.n} and ${b.n} (${gameId}) share ${overlap} puzzle(s)`).toBe(0);
        }
      }
    }
  });

  // Each lesson slice has to be big enough to be a session: at least four
  // puzzles, so a single slip does not end the lesson.
  it("every ranged lesson gets at least four puzzles", () => {
    for (const l of LESSONS) {
      if (!l.game || !(l.game in RANGED_GAMES)) continue;
      const [start, end] = l.gameOpts!.range!;
      expect(end - start, `lesson ${l.n} (${l.game})`).toBeGreaterThanOrEqual(4);
    }
  });
});
