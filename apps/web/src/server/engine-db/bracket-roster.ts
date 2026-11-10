// W4 app PR B (C1/C12, X-FR-1, X-SP-4): the entrants a bracket stage DREW, which is what `BracketStage.entrants` declares
// and what its ranks cover. A pure function of three facts, so the three sites that declare a roster (the completion read,
// the generate-time departed-qualifier planner, the withdrawal planner) cannot drift.
//
// - `drawn`: the order the bracket was drawn with. A fed stage stores it as `config.qualified` (departed qualifiers
//   included - the draw keeps their positions, F14); a root stage has no stored list and its draw order is rebuilt by the
//   caller (`knockoutDrawOrder`), or is simply empty.
// - `seated`: everyone holding a seat in the stage's fixtures - departed included, because the fixtures name them.
// - `waiting`: entrants a late arrival parked on this stage (`entrants.knockout_waiting_stage_id`, app A V494). They are
//   not in the draw yet, so declaring one would rank her last in a stage she has not entered.
//
// Anyone who never held a seat and is not on the drawn list (withdrew before the draw; never qualified from a group or
// league) is NOT declared: that would rank her last in a stage she never played in.

export function bracketRosterOf(input: {
  /** `config.qualified` when stored, else the caller's rebuilt draw order (may be empty). */
  drawn: readonly string[];
  seated: readonly string[];
  waiting?: ReadonlySet<string>;
}): string[] {
  const waiting = input.waiting ?? new Set<string>();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...input.drawn, ...input.seated]) {
    if (seen.has(id) || waiting.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The DRAW seeds (never a registration seed the draw did not use): position in the drawn order, 1-based. */
export function drawSeedsOf(roster: readonly string[]): Map<string, number> {
  return new Map(roster.map((id, i) => [id, i + 1] as const));
}
