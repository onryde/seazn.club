import { isSwissBoardExtKey, isSwissByeShellExtKey } from "@/lib/swiss-shell";

// W3 app-B Task 8 (X-SW-8; FIDE C.04.2 2.4, C.07 (2026) art. 16.1, 16.2.3/16.2.5; ruling 251) — the producer of the engine's
// `TableStage.swissAbsentRounds`: per table entrant, the Swiss rounds in which it was in the stage but held no seat. Each is
// a zero-point unplayed round on its card (16.3.2, 16.4.2). Until this fed the engine every absence read as "nobody was
// absent" and a latecomer's or a withdrawn entrant's Buchholz ranked a plausible wrong table (AGENTS.md class 1: the seam
// declared in the engine and read by nothing in production).
//
// The rule, one reading for every way an entrant can be off a round's cards (a late entry's rounds before it joined, a
// withdrawn or disqualified entrant's rounds after it left, a legacy implicit bye):
//   - a Swiss ROUND is the round number of a fixture whose ext_key is a Swiss shell (`sw-r{n}-b{k}` / `sw-r{n}-bye`, the
//     keys `planSwissShells` mints). An ad-hoc row (`adhoc-N`, a legacy `addFixture` on a Swiss stage, round maxRound+1)
//     is not a shell, so its round is never a Swiss round: reading it as one would make every entrant it does not seat a
//     phantom bye (the #846 defect reborn as a phantom VUR) — Review Focus 3;
//   - a round is OPEN for absence when at least one of its shells is SEATED. A round Pair has not reached holds empty
//     shells, so nobody is absent from it — and an ad-hoc row that shares an open round's number does not open it;
//   - an entrant holds a SEAT in a round when it is the home or away side of any fixture of that round, a bye's award winner
//     included, whatever the fixture's status. A seat on a PENDING board is a seat (Review Focus 4: the table is ranked
//     mid-round), and so is one on a void or walked-over row: the engine refuses an absent round the entrant holds a card in,
//     and a card is any counted fixture the entrant is on;
//   - it is ABSENT in every open round in which it holds no seat.
// Keys are the table's entrants only (Review Focus 2): the engine refuses a key that is not one, which would fail EVERY
// standings read of the stage. A case-(c) latecomer with no seat yet is on the roster but not on the table, so it has no
// key until the next Pair seats it. An entrant absent from no round has no key either (the engine's map omits the empty).

/** The columns of a `fixtures` row this reads — the loader's `FixtureRow` satisfies it. */
export interface AbsentRoundsFixture {
  round_no: number | null;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}

/** The entrant an `award` outcome names as its winner (a bye's recipient), or null. */
function awardWinnerOf(outcome: unknown): string | null {
  if (typeof outcome !== "object" || outcome === null) return null;
  const o = outcome as { kind?: unknown; winner?: unknown };
  return o.kind === "award" && typeof o.winner === "string" ? o.winner : null;
}

export function swissAbsentRounds(
  fixtures: readonly AbsentRoundsFixture[],
  tableEntrants: readonly string[],
): ReadonlyMap<string, readonly number[]> {
  // round number → every entrant that holds a seat in any fixture of it; and the rounds a seated shell opens
  const seatsByRound = new Map<number, Set<string>>();
  const open = new Set<number>();
  for (const f of fixtures) {
    if (f.round_no === null) continue;
    const seated = [f.home_entrant_id, f.away_entrant_id, awardWinnerOf(f.outcome)].filter((id): id is string => id !== null);
    let seats = seatsByRound.get(f.round_no);
    if (seats === undefined) seatsByRound.set(f.round_no, (seats = new Set()));
    for (const id of seated) seats.add(id);
    if (seated.length > 0 && (isSwissBoardExtKey(f.ext_key) || isSwissByeShellExtKey(f.ext_key))) open.add(f.round_no);
  }
  const rounds = [...open].sort((a, b) => a - b);
  const out = new Map<string, readonly number[]>();
  for (const entrant of tableEntrants) {
    const missed = rounds.filter((r) => !seatsByRound.get(r)?.has(entrant));
    if (missed.length > 0) out.set(entrant, missed);
  }
  return out;
}
