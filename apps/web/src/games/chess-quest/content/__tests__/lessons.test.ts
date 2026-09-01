// MateInOne/MateInTwo used to share one global puzzle pool across every
// lesson that launched them (no per-lesson scoping), so all quest lessons
// using a given game showed the identical puzzle progression. The fix
// partitions each pool into a contiguous, non-overlapping range per lesson
// via gameOpts.range. This test derives the expected partition from LESSONS
// itself plus the pools' own lengths (MATE1.length / MATE2.length) — never
// a hardcoded table — so it moves with the source of truth.
import { describe, expect, it } from "vitest";
import { LESSONS } from "../lessons";
import { MATE1, MATE2 } from "../puzzles";

function assertContiguousCoveringPartition(gameId: "mateInOne" | "mateInTwo", poolLength: number) {
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

describe("mateInOne/mateInTwo lesson ranges partition their pools", () => {
  it("mateInOne lessons partition MATE1 contiguously, in n order, covering it exactly once", () => {
    assertContiguousCoveringPartition("mateInOne", MATE1.length);
  });

  it("mateInTwo lessons partition MATE2 contiguously, in n order, covering it exactly once", () => {
    assertContiguousCoveringPartition("mateInTwo", MATE2.length);
  });
});
