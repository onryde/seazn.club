// W5 B3 fix (review m-9; controller ruling 2): an adjustment is not a result. The engine counts each adjustment as a fixture that
// "holds something" (stage.js: `countedFixtures = results + awardDeltas + carried + adjusted`, the engine plan's call), so a started
// table where nothing has been played yet stopped being EMPTY the moment one entrant was adjusted - and its level rows were split by
// a drawing of lots that was then stored. An empty table draws no lots (W2d §5.8 step 1, anti-goal 3): its residual classes take
// seed then id. This keeps that rule for a table whose only content is adjustments, by handing the fold its cascade without the
// lot until something is played - the engine's own fallback then orders the level rows, exactly as on a table with no adjustment.
//
// What "something is played" means is the engine's own list of what makes a table non-empty, minus the adjustments: a result, a
// sit-out award, or a carried opening that holds something (played > 0 or points other than 0). A fixture is read as holding a
// result the way `locksThatFit` (lib/rank-override.ts) reads it - a result or an award on the engine fixture.
//
// Stage-wide, not per pool: the cascade is the stage's one `rules.tiebreakers`, and the engine takes no per-pool cascade. A pooled
// stage where one pool has played and another, adjusted, has not still draws in the unplayed pool (an engine-side fix: count
// adjustments out of `countedFixtures`). Pure.

interface FixtureLike {
  result?: unknown;
  awardDelta?: unknown;
}

interface OpeningLike {
  played: number;
  points: number;
}

export function cascadeWhileNothingPlayed<K extends string>(
  tiebreakers: readonly K[],
  table: { fixtures: readonly FixtureLike[]; openings: readonly OpeningLike[]; adjustments: number },
): readonly K[] {
  if (table.adjustments === 0) return tiebreakers;
  const played =
    table.fixtures.some((f) => f.result !== undefined || f.awardDelta !== undefined) ||
    table.openings.some((o) => o.played > 0 || o.points !== 0);
  return played ? tiebreakers : tiebreakers.filter((k) => k !== "lots");
}
