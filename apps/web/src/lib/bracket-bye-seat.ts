// N-1 (W4 app A Task 22; owner rulings 116/117) — a SETTLED bye is not "to be decided".
//
// A bye's empty seat is empty for good: the draw (or a dead feeder) left it so, and the award that settled the line
// names nobody there. Every bracket tile printed "TBD" for it all the same wherever the seat carried no stored label
// (the legacy double-elimination byes, pre-flight census: a one-seat award with no reason and no label) and in the
// public tile's footer, which fell through to the no-time word because a bye has no score and no time. Ruling 117
// handed that "TBD" to W4. One predicate here, read by every bracket tile, so no surface decides it alone.
//
// Client-safe: `fixture-bye.ts` (type-only engine import) and `forfeit-tag.ts` are both already in client bundles.
import { isOneSidedAwardBye } from "./fixture-bye";
import { unseatedForfeitLoser } from "./forfeit-tag";

type ByeLike = Parameters<typeof isOneSidedAwardBye>[0];

/**
 * True for a settled bye: a one-seat award its seated side won (`isOneSidedAwardBye`) that names nobody in the empty
 * seat. Ruling 116's withdrawn winner is the exception that is NOT a bye: her award names her in the empty seat, so the
 * line reads as the walkover it is (`unseatedForfeitLoser`, the one reader) and keeps its own words.
 */
export function isSettledBye(fixture: ByeLike): boolean {
  if (!isOneSidedAwardBye(fixture)) return false;
  const empty = fixture.home_entrant_id === null ? "home" : "away";
  return unseatedForfeitLoser(fixture, empty) === null;
}

/**
 * The dictionary key a bracket tile falls back to for a seat with no entrant and no label: the bye's own word on the
 * empty seat of a settled bye (`bracket.slot.bye`, the label `stages.ts` stamps on every bye it writes), and the tile's
 * "to be decided" (`bracket.tbd`) everywhere else — a seat still waiting on a result is exactly what that word is for.
 */
// No return-type annotation on purpose: the inferred `"bracket.slot.bye" | "bracket.tbd"` is the same type, and a key
// spelled in a TYPE position is counted by the R116-4 sweep's regex census but not by its parser (it renders nothing).
export function bracketSeatFallbackKey(fixture: ByeLike, seat: "home" | "away") {
  const empty = (seat === "home" ? fixture.home_entrant_id : fixture.away_entrant_id) === null;
  return empty && isOneSidedAwardBye(fixture) && unseatedForfeitLoser(fixture, seat) === null ? "bracket.slot.bye" : "bracket.tbd";
}
