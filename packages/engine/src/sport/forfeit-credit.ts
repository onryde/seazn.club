// W2b (spec §5.2; plan D9) — the shared arithmetic every module's `forfeitCredit` and `standingsDelta` use. Each module
// owns its RULE (what a walkover or a retirement credits, Appendix A); this file owns only how a credit is laid over a
// side's played ledger, so eleven modules cannot each get that part slightly different.
import { EngineError } from "../core/errors.ts";
import { legacyAwardForfeitReason, type AwardReason, type ForfeitCredit, type MatchOutcome } from "../core/types.ts";

export type CreditSide = "home" | "away";
type Ledger = Readonly<Record<string, number>>;

/** The reason an `award` is ranked under: its typed `reason` (D2), a bye wherever it names no loser (C-5).
 *  An award STORED before W2b carries neither `reason` nor `loser` (Loop R I-1): it is the forfeit its `method` names
 *  when that is a forfeit reason (`legacyAwardForfeitReason`; only a pre-W2b `core.forfeit` wrote a `method`, and a
 *  forfeit was recorded on a seated fixture, so such a row holds both seats), and otherwise the bye it was (the server's
 *  pre-W2b bye writers stored `{kind, winner}` alone). The old comment here read every reason-less award as a bye on the
 *  premise that ruling 104 found no stored forfeit; ruling 112 disproved it — production and staging each hold one
 *  pre-W2b walkover — so that reading credited them the bye's 0-0 instead of their walkover credit. */
export function awardReasonOf(outcome: Extract<MatchOutcome, { kind: "award" }>): AwardReason {
  const stored = outcome as { reason?: AwardReason; loser?: string | null };
  if (stored.reason !== undefined) return stored.loser == null ? "bye" : stored.reason;
  return legacyAwardForfeitReason(outcome) ?? "bye";
}

/** Review M-4 — the seat an award is charged to: its typed `loser` (D9), read through the module's own `sideOf`, so a
 *  loser who is no seat of this fixture is that module's refusal rather than a credit silently given to whoever is
 *  not the winner. A bye — and a legacy reason-less award (C-5) — has no loser: the seat that is not the winner's (the
 *  server's phantom opponent). */
export function awardOffenderSide(
  outcome: Extract<MatchOutcome, { kind: "award" }>,
  winnerSide: CreditSide,
  sideOfEntrant: (entrantId: string) => CreditSide,
): CreditSide {
  const loser = (outcome as { loser?: string | null }).loser;
  if (loser == null) return winnerSide === "home" ? "away" : "home";
  const side = sideOfEntrant(loser);
  if (side === winnerSide) {
    throw new EngineError("INVALID_EVENT", `an award's loser "${loser}" sits in its winner's seat`, { winner: outcome.winner, loser });
  }
  return side;
}

/** perSide, in [home, away] order, from the WINNER's and the OFFENDER's credited records. */
export function creditFor(offender: CreditSide, winner: Ledger, offending: Ledger): ForfeitCredit["perSide"] {
  return offender === "home" ? [offending, winner] : [winner, offending];
}

/** A side's table metrics for an award: the played ledger, the credited keys laid over it, and every excluded key read
 *  as 0 for this match (so no ratio reader changes its arithmetic, D9). */
export function creditedMetrics(played: Ledger, credit: ForfeitCredit, side: CreditSide): Record<string, number> {
  const out: Record<string, number> = { ...played, ...credit.perSide[side === "home" ? 0 : 1] };
  for (const key of credit.excluded) if (key in out) out[key] = 0;
  return out;
}

/** X-DW-4 — a double walkover credits nothing and is out of every ratio: every key either side's ledger carries, and
 *  every key the sport declares, reads 0. */
export function doubleWalkoverCredit(home: Ledger, away: Ledger, declared: readonly string[]): ForfeitCredit {
  const keys = [...new Set([...declared, ...Object.keys(home), ...Object.keys(away)])];
  const zero = Object.fromEntries(keys.map((key) => [key, 0]));
  return { perSide: [zero, zero], excluded: keys };
}

/** FB-RT-1 / HK-RT-1 / IH-RT-1 (FDC Art. 28; FIH GTR 13), and GN-RT-1 at generic's 0-0 (ruling 124) — the awarded
 *  score, unless the real score's margin is WORSE for the offender, in which case the real score stands. An equal
 *  margin takes the awarded score. A walkover has no real score (nothing was played), so it is always the awarded one. */
export function goalCredit(awarded: number, real: { winner: number; offender: number }): { winner: number; offender: number } {
  return real.winner - real.offender > awarded ? real : { winner: awarded, offender: 0 };
}
