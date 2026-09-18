// Pure helpers for Swiss shell fixture minting and seating predicates.
//
// Client-safe on purpose: the stage generator, the stage rail, and unit tests
// must agree on board counts and seated/unseated rules without importing
// server-only modules.

export type SwissShellFixtureRef = {
  extKey: string;
  roundNo: number;
  seqInRound: number;
  /** true ⇒ bye shell (one side will become award on Pair) */
  bye: boolean;
};

export function swissBoardsForField(entrants: number): { boards: number; bye: boolean } {
  const n = Number.isFinite(entrants) ? Math.max(0, Math.trunc(entrants)) : 0;
  const boards = Math.floor(n / 2);
  const bye = n % 2 === 1;
  return { boards, bye };
}

export function planSwissShells(rounds: number, entrants: number): SwissShellFixtureRef[] {
  const { boards, bye } = swissBoardsForField(entrants);
  const plan: SwissShellFixtureRef[] = [];
  for (let roundNo = 1; roundNo <= rounds; roundNo++) {
    for (let b = 1; b <= boards; b++) {
      plan.push({
        extKey: `sw-r${roundNo}-b${b}`,
        roundNo,
        seqInRound: b,
        bye: false,
      });
    }
    if (bye) {
      plan.push({
        extKey: `sw-r${roundNo}-bye`,
        roundNo,
        seqInRound: boards + 1,
        bye: true,
      });
    }
  }
  return plan;
}

function isAwardOutcome(outcome: unknown): outcome is { kind: "award" } {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    "kind" in outcome &&
    (outcome as { kind: unknown }).kind === "award"
  );
}

export function isSwissByeRow(f: { ext_key: string | null; outcome: unknown }): boolean {
  return f.ext_key?.endsWith("-bye") === true || isAwardOutcome(f.outcome);
}

export function isSwissBoardSeated(f: {
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}): boolean {
  if (isAwardOutcome(f.outcome)) return true;
  return f.home_entrant_id !== null && f.away_entrant_id !== null;
}

type SwissFixtureRow = {
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  ext_key: string | null;
};

function roundIsFullySeated(
  fixtures: readonly SwissFixtureRow[],
  roundNo: number,
): boolean {
  const inRound = fixtures.filter((f) => f.round_no === roundNo);
  if (inRound.length === 0) return false;
  return inRound.every((f) =>
    isSwissBoardSeated({
      home_entrant_id: f.home_entrant_id,
      away_entrant_id: f.away_entrant_id,
      outcome: f.outcome,
    }),
  );
}

/** Lowest round that still has an unseated board; null if all seated. */
export function nextUnseatedSwissRound(fixtures: readonly SwissFixtureRow[]): number | null {
  const roundNos = [...new Set(fixtures.map((f) => f.round_no))].sort((a, b) => a - b);
  for (const roundNo of roundNos) {
    const inRound = fixtures.filter((f) => f.round_no === roundNo);
    const hasUnseated = inRound.some(
      (f) =>
        !isSwissBoardSeated({
          home_entrant_id: f.home_entrant_id,
          away_entrant_id: f.away_entrant_id,
          outcome: f.outcome,
        }),
    );
    if (hasUnseated) return roundNo;
  }
  return null;
}

/** Highest fully seated round; null if none seated. */
export function latestSeatedSwissRound(fixtures: readonly SwissFixtureRow[]): number | null {
  const roundNos = [...new Set(fixtures.map((f) => f.round_no))].sort((a, b) => a - b);
  let latest: number | null = null;
  for (const roundNo of roundNos) {
    if (roundIsFullySeated(fixtures, roundNo)) latest = roundNo;
  }
  return latest;
}

/** True if a non-bye fixture in `roundNo` has a played result (blocks Unpair). */
export function swissRoundHasPlayedResult(
  fixtures: readonly {
    round_no: number;
    status: string;
    outcome: unknown;
    ext_key: string | null;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  }[],
  roundNo: number,
): boolean {
  return fixtures
    .filter((f) => f.round_no === roundNo)
    .some((f) => {
      if (isSwissByeRow(f)) return false;
      if (f.status === "decided" || f.status === "finalized") return true;
      if (f.status === "forfeited" && !isAwardOutcome(f.outcome)) return true;
      return false;
    });
}
