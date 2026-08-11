// Shared shootout primitive — v6/00 §3. Extracted from football's private
// best-of-5 alternating early-out (spec 04 §1.4) and parameterized so one
// shape serves football pens, IIHF GWS and the FIH shoot-out: `attempts`
// regulation kicks per side with an early decision when the lead exceeds the
// opponent's remaining entitlement, then sudden-death pairs until decided.
// Attempt metadata (FIH 8-second clock, GWS penalty-box ineligibility) rides
// on the events, never in this math (v6/00 §6.5).

export type ShootoutSide = "home" | "away";

export interface ShootoutKick {
  side: ShootoutSide;
  scored: boolean;
  /** W4 (#407) — the taker. Both sheets name him: IIHF's GWS section lists the
   *  shooting order, FIH App 12 the one-on-one attacker. Optional: coarse
   *  scoring records only side + result. */
  person?: string;
  /** W4 (#407) — the goalkeeper who faced the attempt (IIHF GWS records the
   *  goalie per shot; FIH's 8-second run is against a named keeper). */
  goalkeeper?: string;
  /**
   * W5 (#416) — App 12 / GWS foul outcomes: a defender foul during the
   * one-on-one sends it to a RETAKE rather than recording a real attempt
   * (hockey/DOMAIN.md's "a foul during the shoot-out" row — App 12's foul
   * outcomes are their own small rulebook: defender foul → retake or a
   * stroke awarded elsewhere; attacker foul → the attempt simply ends and
   * DOES count, so that case is NOT void). A void kick counts toward
   * NEITHER `taken` nor `scored` — it contributes nothing, as if it never
   * happened; the retake that follows is a separate, later kick event.
   * Optional and defaults to falsy, so a kick recorded before this field
   * existed counts exactly as it always did (no recorded stream can carry
   * `void: true` — the field did not exist for them to write it).
   */
  void?: boolean;
}

function opponent(side: ShootoutSide): ShootoutSide {
  return side === "home" ? "away" : "home";
}

/**
 * Attempts actually TAKEN per side — a void kick (retake pending) is not
 * one of them. THE ONE tally both `shootoutDecision` (early-decision math)
 * and `expectedKicker` (whose turn is next) read, so the two can never fork
 * on what "taken" means. Before this function existed each computed its own
 * copy of this loop — this repo's recurring placer/verifier bug, closed
 * structurally here rather than left to two hand-kept counts agreeing by
 * accident.
 */
function countTaken(kicks: readonly ShootoutKick[]): { home: number; away: number } {
  const taken = { home: 0, away: 0 };
  for (const kick of kicks) if (!kick.void) taken[kick.side]++;
  return taken;
}

// Winner of the shootout at this kick sequence, or null while undecided.
// Early decision when lead exceeds the opponent's remaining entitlement: up
// to `attempts` in regulation; in sudden death a side is entitled to match
// the opponent's kick count (complete the pair).
export function shootoutDecision(
  kicks: readonly ShootoutKick[],
  attempts = 5,
): ShootoutSide | null {
  const taken = countTaken(kicks);
  const scored = { home: 0, away: 0 };
  for (const kick of kicks) {
    if (kick.void) continue;
    if (kick.scored) scored[kick.side]++;
  }
  const remaining = (side: ShootoutSide): number =>
    taken[side] < attempts
      ? attempts - taken[side]
      : Math.max(0, taken[opponent(side)] - taken[side]);
  if (scored.home > scored.away + remaining("away")) return "home";
  if (scored.away > scored.home + remaining("home")) return "away";
  return null;
}

// The side due to kick next, or null when either side may start.
export function expectedKicker(kicks: readonly ShootoutKick[]): ShootoutSide | null {
  if (kicks.length === 0) return null;
  const taken = countTaken(kicks);
  if (taken.home === taken.away) return (kicks[0] as ShootoutKick).side;
  return taken.home < taken.away ? "home" : "away";
}

/** Scored tallies per side — the scorebug's "(GWS 2–1)" numbers. A void kick
 *  counts toward neither `taken` nor `scored` (see `ShootoutKick.void`), so
 *  whatever it carries in `scored` must not reach the displayed tally either. */
export function shootoutTally(kicks: readonly ShootoutKick[]): { home: number; away: number } {
  const tally = { home: 0, away: 0 };
  for (const kick of kicks) if (!kick.void && kick.scored) tally[kick.side]++;
  return tally;
}
