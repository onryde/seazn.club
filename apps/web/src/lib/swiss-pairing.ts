// Which pairing model a Swiss "Pair next" uses — the ONE authority, shared by
// swissGen (server) and the desk's split button (client), the same way
// swiss-shell.ts is. Spec: docs/superpowers/specs/2026-09-22-swiss-round-one-pairing-design.md
//
// Round 1 (the round being paired has round_no 1) defaults to top-vs-bottom:
// rank-adjacent (Hammes) pairs neighbours by STANDINGS, and before any result
// the only rank is the seed, so neighbours would be seed 1 v seed 2.
//
// Client-safe: import the swiss LEAF, never the scheduling barrel. The barrel no
// longer reaches @grpc/grpc-js (the client moved to @seazn/scheduler, engine
// split D11) but still re-exports the whole solver; see its header in
// packages/engine/src/scheduling/index.ts. The test pins this.
import { pairRound } from "@seazn/engine/scheduling/swiss";
import type { SwissConstraints, SwissStanding } from "@seazn/engine/scheduling/swiss";
import type { EntrantId } from "@seazn/engine/core";

/** The pairing MODEL, taken from the engine's own `SwissConstraints.pairing`
 *  so the engine stays the one source. Named `...Mode` because the engine
 *  already exports `SwissPairing`, which is one `{home, away}` board. */
export type SwissPairingMode = NonNullable<SwissConstraints["pairing"]>;
export const SWISS_PAIRINGS: readonly SwissPairingMode[] = ["fold", "rank_adjacent"];

export const SWISS_PAIRING_ROUND_ONE_ONLY_CODE = "SWISS_PAIRING_ROUND_ONE_ONLY";
export const SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE =
  "pairing mode can only be chosen for round 1, and only when a round is waiting to be paired";
export const SWISS_PAIRING_NOT_SWISS_CODE = "SWISS_PAIRING_NOT_SWISS";
export const SWISS_PAIRING_NOT_SWISS_MESSAGE = "pairing only applies to swiss stages";

export function storedSwissPairing(config: Record<string, unknown>): SwissPairingMode {
  return config.pairing === "rank_adjacent" ? "rank_adjacent" : "fold";
}

export function effectiveSwissPairing(i: {
  override?: SwissPairingMode;
  stored: SwissPairingMode;
  /** The round being paired — `nextUnseatedSwissRound`. Round NUMBER, never
   *  "has a decided board": a bye is minted `forfeited` at seat time, so that
   *  test is already true the moment an odd round 1 is paired. */
  round: number;
}): SwissPairingMode {
  if (i.override !== undefined) return i.override;
  return i.round === 1 ? "fold" : i.stored;
}

/** The hint's premise broke: round 1 of a fresh field of two or more has no refusal in it (rulebook-W3 section 3.1: a refusal
 *  needs a meeting, a bye or a colour already on record), yet the engine refused one. A named error, so a log line and a test
 *  can say which assumption failed. */
export class SwissRoundOnePremiseError extends Error {
  constructor(
    readonly fieldSize: number,
    readonly reason: string,
  ) {
    super(`premise: round 1 of a fresh field of ${fieldSize} pairs, but the engine refused it (${reason})`);
    this.name = "SwissRoundOnePremiseError";
  }
}

/** Round-1 pairs by seed position (1-based), lower seed first, sorted —
 *  computed by the engine's own pairRound so the hint cannot drift from it. */
export function roundOnePairs(fieldSize: number, pairing: SwissPairingMode): Array<[number, number]> {
  if (fieldSize < 2) return [];
  const standings: SwissStanding[] = Array.from({ length: fieldSize }, (_, i) => ({
    entrantId: String(i + 1) as EntrantId,
    score: 0,
    rank: i + 1,
  }));
  const round = pairRound(standings, { played: new Set() }, pairing === "rank_adjacent" ? { pairing } : {});
  // W3 app-B T1 (X-SW-3; engine 2.0.0): a refusal (`ok: false`) carries no pairings. Round one of two or more fresh entrants
  // always pairs (no meeting, no bye, no colour history to run out), so a refusal here is a broken premise, not an answer:
  // it is raised by name, never read as "no pairs" (which would print a hint with no boards for a field that has them).
  if (!round.ok) throw new SwissRoundOnePremiseError(fieldSize, round.reason);
  return round.pairings
    .map((p) => {
      const a = Number(p.home);
      const b = Number(p.away);
      return (a < b ? [a, b] : [b, a]) as [number, number];
    })
    .sort((x, y) => x[0] - y[0]);
}
