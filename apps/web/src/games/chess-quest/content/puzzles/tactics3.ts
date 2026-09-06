import type { TacticPuzzle } from "./types";

// Tier-3 Trick Shots (Track 4): deflection, decoy, remove-the-defender,
// interference — the "pull the guard away" family, one step up from
// fork/pin/skewer/disco. Every entry carries a genuine defender, so the
// motif has to be set up, not merely spotted: verified by material swing
// (content/__tests__/puzzles.test.ts uses tacticGainAfter, since these
// motifs have no single structural detector like isForkAfter) rather than
// a shape check — solution must net >= 3 points against black's best
// defense (or force mate), and be strictly better than every other move.
export const TACTICS3: Record<
  "deflection" | "decoy" | "removeDefender" | "interference",
  TacticPuzzle[]
> = {
  deflection: [
    {
      fen: "2b4k/1r6/P7/8/8/8/8/K7 w - - 0 1",
      solution: "a6b7",
      story: "The bishop guards the rook... but pawns don't care about bishops. Snap it up!",
    },
    {
      fen: "6k1/1p6/2q5/4N3/8/8/8/6K1 w - - 0 1",
      solution: "e5c6",
      story: "Fork the queen! She has a pawn standing by, but nothing that stops the pony in time.",
    },
    {
      fen: "7k/1n6/8/8/1r6/P7/8/7K w - - 0 1",
      solution: "a3b4",
      story: "A little pawn does what a knight never could — it just walks past the guard.",
    },
    {
      fen: "6k1/1b2r1pp/8/4r3/3P4/8/8/1R4K1 w - - 0 1",
      solution: "d4e5",
      story: "His rook is minding TWO things at once. Grab one and see which job it drops.",
    },
  ],
  decoy: [
    {
      fen: "7k/8/1p6/n7/1P6/8/8/R6K w - - 0 1",
      solution: "b4a5",
      story: "The pawn LOOKS like backup. Watch what happens if it actually tries to help.",
    },
    {
      fen: "k7/8/8/6p1/7r/6P1/8/K7 w - - 0 1",
      solution: "g3h4",
      story: "A whole rook for one little pawn? Even if he bites back, take that trade every time.",
    },
    {
      fen: "7k/2b5/1q6/3N4/8/8/8/7K w - - 0 1",
      solution: "d5b6",
      story: "The bishop stands guard over the queen — but your knight never asked permission.",
    },
    {
      fen: "r5k1/5ppp/8/8/8/8/1R6/1Q4K1 w - - 0 1",
      solution: "b2b8",
      story: "Park your rook on his back row where his rook MUST take it. Then look who lands there next.",
    },
  ],
  removeDefender: [
    {
      fen: "r5k1/p7/1N6/8/8/8/8/6K1 w - - 0 1",
      solution: "b6a8",
      story: "That pawn on a7 looks like a bodyguard. Pawns can't defend backward — the rook's all alone!",
    },
    {
      fen: "6k1/8/2b5/3n4/2P5/8/8/3R2K1 w - - 0 1",
      solution: "c4d5",
      story: "Clear the little guard first. However the bishop answers, your rook cleans up next.",
    },
    {
      fen: "k7/5b2/6q1/4N3/8/8/8/K7 w - - 0 1",
      solution: "e5g6",
      story: "Take the queen! The bishop can bite back, but you still made the trade of the day.",
    },
    {
      fen: "6k1/1p3ppp/2n5/1B2r3/8/8/1Q6/6K1 w - - 0 1",
      solution: "b5c6",
      story: "The rook only feels safe because of that pony. Trade the pony off and it is all alone.",
    },
  ],
  interference: [
    {
      fen: "6k1/8/2p5/3q4/1N6/8/8/6K1 w - - 0 1",
      solution: "b4d5",
      story: "The pawn thinks it has the queen covered. Your knight strongly disagrees.",
    },
    {
      fen: "7k/8/8/2p5/3r4/1N6/8/3R3K w - - 0 1",
      solution: "b3d4",
      story: "Grab the rook. If the pawn steps in to recapture, your OTHER rook is already lined up.",
    },
    {
      fen: "k7/8/8/4p3/5n2/6P1/8/K4R2 w - - 0 1",
      solution: "g3f4",
      story: "Trade pawn for pony — and if his friend recaptures, your rook was waiting right there.",
    },
    {
      fen: "5b1k/6pp/5p2/4r3/2N5/8/8/5R1K w - - 0 1",
      solution: "c4e5",
      story: "Snap up the rook. If that pawn recaptures it steps aside — and your rook can finally see the bishop.",
    },
  ],
};
