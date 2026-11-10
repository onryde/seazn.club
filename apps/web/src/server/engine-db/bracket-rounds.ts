// W4 app PR B (C5/C9): the engine's bracket round is 0-BASED PER LANE (`BracketFixture.round`: "0 is the opening round, as
// the generators emit"), while the stored `fixtures.round_no` is the generator's `laneOffset(lane) + round + 1`
// (usecases/stages/generators.ts `bracketToGen`): winners' side 1..W, losers' side W+1.., grand final 2W+1.. where W is the
// winners' round count (`laneDepth`). This is the ONE inverse. Every reader that hands rows to the engine uses it, so the
// opening round is 0 on every lane (`firstLossField` refuses a field with no round-0 row, `first_loss_no_opening_round`),
// and a stepladder rung is read from the round it is due in (X-SP-4).
//
// Lanes come from the ext_key (`parseExtKey`, engine-db/competition.ts) - never re-derived from round numbers, which number
// sparsely across lanes. A bracket with no lane prefix (knockout rows written as `wb-`, stepladder, page playoff) has offset 0.

export type BracketLane = "WB" | "LB" | "GF" | undefined;

/** W: the winners' side's round count, read off the stored rows (the generator's `laneDepth`). 0 when no winners' row. */
export function laneDepthOf(rows: readonly { lane: BracketLane; roundNo: number }[]): number {
  let depth = 0;
  for (const r of rows) if (r.lane === "WB" && r.roundNo > depth) depth = r.roundNo;
  return depth;
}

/** The engine's 0-based, per-lane round of a stored `round_no`. */
export function engineRoundOf(roundNo: number, lane: BracketLane, laneDepth: number): number {
  const offset = lane === "LB" ? laneDepth : lane === "GF" ? laneDepth * 2 : 0;
  return roundNo - 1 - offset;
}

export interface FeedEdgeRow {
  id: string;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

/** C6/C14: INVERT the stored forward edges (`winner_to_*`, `loser_to_*`: "my winner goes to fixture X, slot n") into the
 *  engine's backward ones (`homeFrom` / `awayFrom`: "my home seat is filled by fixture Y's winner"). Without them a seat a
 *  withdrawal emptied (X-WD-3, ruling 116) cannot be attributed to the entrant who left, so a withdrawn finalist ranks nowhere
 *  and a bye holder is never eliminated. Slot 1 is the home seat, slot 2 the away seat. Returns the number of edges attached,
 *  so a caller (and a test) can see it was not vacuous. */
export function attachFeedRefs<T extends { id: string; homeFrom?: { fixtureId: string; side: "winner" | "loser" }; awayFrom?: { fixtureId: string; side: "winner" | "loser" } }>(
  byId: ReadonlyMap<string, T>,
  edges: readonly FeedEdgeRow[],
): number {
  let attached = 0;
  for (const e of edges) {
    for (const [to, slot, side] of [
      [e.winner_to_fixture, e.winner_to_slot, "winner"],
      [e.loser_to_fixture, e.loser_to_slot, "loser"],
    ] as const) {
      const target = to === null ? undefined : byId.get(to);
      if (target === undefined || (slot !== 1 && slot !== 2)) continue;
      target[slot === 1 ? "homeFrom" : "awayFrom"] = { fixtureId: e.id, side };
      attached++;
    }
  }
  return attached;
}
