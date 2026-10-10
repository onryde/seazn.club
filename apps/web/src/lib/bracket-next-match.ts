// W2b D19 (X-DW-3) and loop-F review I-5: does a bracket line feed a NEXT match — one a double walkover on this
// line would leave someone to play? A pure read of the two feed edges, shared by every double-walkover writer (the
// append guard, the withdrawal cascade, the seat resolver), so the three can never disagree about what a final is.
//
// - A final feeds nothing: no winner edge, no loser edge.
// - A double-elimination grand final WITH a bracket reset (scheduling/bracket.ts `gf-reset`: `winnerOf("gf")` v
//   `loserOf("gf")`) wires BOTH its edges into the same fixture — the same two entrants again. A double walkover there
//   leaves the reset with two dead seats, which voids, and the stage completes with no champion. So it is a final too.
//   (So is a two-entrant double elimination's one winners' match, whose winner and loser both go to the grand final.)
// - Any other wiring sends somebody somewhere else, and is a next match.

export interface FeedEdges {
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
}

export function feedsNextMatch(f: FeedEdges): boolean {
  if (f.winner_to_fixture === null && f.loser_to_fixture === null) return false;
  return f.winner_to_fixture !== f.loser_to_fixture;
}
