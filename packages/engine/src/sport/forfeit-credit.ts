// W2b (spec §5.2; plan D9) — the shared arithmetic every module's `forfeitCredit` and `standingsDelta` use. Each module
// owns its RULE (what a walkover or a retirement credits, Appendix A); this file owns only how a credit is laid over a
// side's played ledger, so eleven modules cannot each get that part slightly different.
import type { AwardReason, ForfeitCredit, MatchOutcome } from "../core/types.ts";

export type CreditSide = "home" | "away";
type Ledger = Readonly<Record<string, number>>;

/** The reason an `award` is ranked under. A legacy award written before W2b carries no `reason` and no `loser` (the
 *  server's bye writers, C-5) — it is read as the bye it was, so its delta stays exactly the pre-W2b one. */
export function awardReasonOf(outcome: Extract<MatchOutcome, { kind: "award" }>): AwardReason {
  const legacy = outcome as { reason?: AwardReason; loser?: string | null };
  return legacy.reason === undefined || legacy.loser == null ? "bye" : legacy.reason;
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

/** FB-RT-1 / HK-RT-1 / IH-RT-1 (FDC Art. 28; FIH GTR 13) — the awarded score, unless the real score's margin is WORSE
 *  for the offender, in which case the real score stands. An equal margin takes the awarded score. A walkover has no
 *  real score (nothing was played), so it is always the awarded one. */
export function goalCredit(awarded: number, real: { winner: number; offender: number }): { winner: number; offender: number } {
  return real.winner - real.offender > awarded ? real : { winner: awarded, offender: 0 };
}
