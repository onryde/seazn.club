// W4 app-A Task 13 (K9; rulebook RB4-V2…V5; rules X-LL-1…X-LL-4): who takes a departed qualifier's main-draw seat — the
// LUCKY LOSER, the best loser below a knockout source's cut.
//
// "Best" (pre-flight ruling C2): the qualifying bracket's losers grouped by the ROUND they were knocked out in, read off
// the stage's own fixtures (as `roundLosers` reads them) — a later round is a better loser — then, inside a round, by
// seed, and the unseeded by lot with the DESTINATION stage's draw seed (RB4-V5). Never the snapshot's rank: the engine's
// final ranks break every equal-round tie by seed and then by id (3.0.2 `bracketRanks`), so ranking by them would let the
// id order, not the draw, pick the lucky loser. A loser by walkover, withdrawal or disqualification is not eligible
// (RB4-V5); a retirement is a loss on court and is.
//
// Pure and client-safe: the lot is the house draw (`swissRoundOneOrder`, W3 X-SW-22 / W4 T7 K5 — one PRNG, one rule).
import { legacyAwardForfeitReason } from "@seazn/engine/core";
import { swissRoundOneOrder } from "@/lib/swiss-draw";

/** How a qualifying-stage entrant lost the line that knocked them out. */
export type LuckyLostBy = "played" | "retired" | "walkover" | "withdrew" | "disqualified";

export interface LuckyCandidate {
  id: string;
  /** The qualifying bracket's round of their knock-out (a later round is a better loser, C2). A third-place line's
   *  winner reads half a round above its loser — a placing match decides the two semi-final losers' order. */
  eliminatedIn: number;
  seed: number | null;
  lostBy: LuckyLostBy;
}

/** RB4-V5: a loss nobody played for is no ticket back in. */
export const NOT_LUCKY: ReadonlySet<LuckyLostBy> = new Set(["walkover", "withdrew", "disqualified"]);

/**
 * The lucky-loser order (RB4-V2, C2): the eligible candidates (RB4-V5) by elimination round, the latest first; inside a
 * round the seeded by seed, then the unseeded drawn with `drawSeed` — the destination stage's (`swissDrawSeed`), so the
 * same field always draws the same order. A round's candidates are put in id order before the draw, so the order the
 * caller lists them in never moves the result. Empty in, empty out.
 */
export function luckyLoserOrder(pool: readonly LuckyCandidate[], drawSeed: number): string[] {
  const eligible = pool.filter((c) => !NOT_LUCKY.has(c.lostBy));
  const rounds = [...new Set(eligible.map((c) => c.eliminatedIn))].sort((a, b) => b - a);
  return rounds.flatMap((round) =>
    swissRoundOneOrder(
      drawSeed,
      eligible.filter((c) => c.eliminatedIn === round).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ),
  );
}

/**
 * How the LOSER of a decided bracket line lost it, off the line's stored outcome: a result on court is `played`; a
 * forfeit award names its reason (`retired`, `walkover`, `withdrew`, `disqualified` — a pre-W2b award through its legacy
 * `method`, `legacyAwardForfeitReason`). Null for anything that knocked nobody out: no outcome, a bye, a double walkover,
 * a level result.
 */
export function luckyLostBy(outcome: unknown): LuckyLostBy | null {
  if (outcome === null || typeof outcome !== "object") return null;
  const o = outcome as { kind?: unknown; reason?: unknown; method?: unknown };
  // A pre-W2b forfeit stored as a `win` (`isLegacyForfeitWin`, engine-db/fed-seats.ts — server-side, so its two methods
  // are read here as it reads them) was a walkover, not a match.
  if (o.kind === "win") return o.method === "forfeit" || o.method === "walkover" ? "walkover" : "played";
  if (o.kind !== "award") return null;
  const reason = legacyAwardForfeitReason(o) ?? o.reason;
  return reason === "retired" || reason === "walkover" || reason === "withdrew" || reason === "disqualified" ? reason : null;
}
