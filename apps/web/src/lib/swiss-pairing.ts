// Which pairing model a Swiss "Pair next" uses — the ONE authority, shared by
// swissGen (server) and the desk's split button (client), the same way
// swiss-shell.ts is. Spec: docs/superpowers/specs/2026-09-22-swiss-round-one-pairing-design.md
//
// Round 1 (the round being paired has round_no 1) defaults to top-vs-bottom:
// rank-adjacent (Hammes) pairs neighbours by STANDINGS, and before any result
// the only rank is the seed, so neighbours would be seed 1 v seed 2.
import { pairRound, type SwissStanding } from "@seazn/engine/scheduling";
import type { EntrantId } from "@seazn/engine/core";

export type SwissPairing = "fold" | "rank_adjacent";
export const SWISS_PAIRINGS: readonly SwissPairing[] = ["fold", "rank_adjacent"];

export const SWISS_PAIRING_ROUND_ONE_ONLY_CODE = "SWISS_PAIRING_ROUND_ONE_ONLY";
export const SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE =
  "pairing mode can only be chosen for round 1, and only when a round is waiting to be paired";
export const SWISS_PAIRING_NOT_SWISS_CODE = "SWISS_PAIRING_NOT_SWISS";
export const SWISS_PAIRING_NOT_SWISS_MESSAGE = "pairing only applies to swiss stages";

export function storedSwissPairing(config: Record<string, unknown>): SwissPairing {
  return config.pairing === "rank_adjacent" ? "rank_adjacent" : "fold";
}

export function effectiveSwissPairing(i: {
  override?: SwissPairing;
  stored: SwissPairing;
  /** The round being paired — `nextUnseatedSwissRound`. Round NUMBER, never
   *  "has a decided board": a bye is minted `forfeited` at seat time, so that
   *  test is already true the moment an odd round 1 is paired. */
  round: number;
}): SwissPairing {
  if (i.override !== undefined) return i.override;
  return i.round === 1 ? "fold" : i.stored;
}

/** Round-1 pairs by seed position (1-based), lower seed first, sorted —
 *  computed by the engine's own pairRound so the hint cannot drift from it. */
export function roundOnePairs(fieldSize: number, pairing: SwissPairing): Array<[number, number]> {
  if (fieldSize < 2) return [];
  const standings: SwissStanding[] = Array.from({ length: fieldSize }, (_, i) => ({
    entrantId: String(i + 1) as EntrantId,
    score: 0,
    rank: i + 1,
  }));
  const round = pairRound(standings, { played: new Set() }, pairing === "rank_adjacent" ? { pairing } : {});
  return round.pairings
    .map((p) => {
      const a = Number(p.home);
      const b = Number(p.away);
      return (a < b ? [a, b] : [b, a]) as [number, number];
    })
    .sort((x, y) => x[0] - y[0]);
}
