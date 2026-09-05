// Star formulas — ported 1:1 from the original games (chess-quest js/games.js),
// except packStars, which is now scaled to the pack it scores (see below).
// Pure so thresholds stay pinned by lib/__tests__/stars.test.ts.

export const STAR_RULES = {
  squareRace(score: number): number {
    return score >= 12 ? 3 : score >= 7 ? 2 : score >= 3 ? 1 : 0;
  },
  // Sliders (R/B/Q) reach coins fast; steppers (N/K/P) get looser pars.
  coinHop(moves: number, piece: string): number {
    const easy = piece !== "N" && piece !== "K" && piece !== "P";
    const s3 = easy ? 9 : 14;
    const s2 = easy ? 13 : 20;
    return moves <= s3 ? 3 : moves <= s2 ? 2 : 1;
  },
  pawnWars(whiteWon: boolean): number {
    return whiteWon ? 3 : 1;
  },
  // Every solve-the-pack game (mate packs, Piece Detective, all Trick Shots
  // tiers) awards on solved count, scaled to the size of the pack being
  // scored: a third solved = 1 star, two thirds = 2, the whole pack = 3.
  // The original fixed thresholds (12 / 8 / 4 for a 12-pack, 9 / 6 / 3 for
  // mate-in-3) are exactly this formula at those sizes; scaling it lets a
  // lesson-scoped slice of five puzzles earn stars at all — under the fixed
  // numbers a five-puzzle lesson could never reach even one star.
  packStars(solved: number, total: number): number {
    if (total <= 0) return 0;
    if (solved >= total) return 3;
    if (solved >= Math.ceil((2 * total) / 3)) return 2;
    if (solved >= Math.ceil(total / 3)) return 1;
    return 0;
  },
  rookMaze(moves: number, par: number): number {
    return moves <= par ? 3 : moves <= par + 1 ? 2 : 1;
  },
  // Opening Trainer: clean run 3 stars, a slip or two still 2.
  openingTrainer(mistakes: number): number {
    return mistakes === 0 ? 3 : mistakes <= 2 ? 2 : 1;
  },
};
