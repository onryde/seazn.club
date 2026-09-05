import type { TacticPuzzle } from "./types";

// Tier-2 Trick Shots (Track 2): same detectors, trickier boards — poisoned
// squares, defended targets, double threats. Verified like TACTICS.
export const TACTICS2: Record<"fork2" | "pin2" | "skewer2" | "disco2", TacticPuzzle[]> = {
  fork2: [
    {
      fen: "4q1k1/5p1p/8/3N4/8/8/8/6K1 w - - 0 1",
      solution: "d5f6",
      story: "The pony leaps in with CHECK — and lands on the queen's fork too!",
    },
    {
      fen: "r5k1/6pp/8/8/8/8/8/3Q2K1 w - - 0 1",
      solution: "d1d5",
      story: "One magic square sees two windows: the king down one diagonal, the rook down the other.",
    },
    {
      fen: "4k3/8/8/6p1/R6b/8/8/6K1 w - - 0 1",
      solution: "a4e4",
      story: "Don't grab the guarded bishop — slide to the crossroads and fork it with the king!",
    },
    {
      fen: "2r1k1r1/2p5/8/8/4N3/8/8/K7 w - - 0 1",
      solution: "e4f6",
      story: "Both hopping spots look yummy, but a little soldier is guarding one of them. Take the safe one!",
    },
    {
      fen: "7k/8/8/8/n1bn1n2/8/1P2P3/6K1 w - - 0 1",
      solution: "e2e3",
      story: "Two soldiers both want to poke. One landing square is watched by the bishop — send the other one.",
    },
  ],
  pin2: [
    {
      fen: "1k6/pp6/3q4/8/7B/8/7P/6K1 w - - 0 1",
      solution: "h4g3",
      story: "Tuck the bishop behind your own pawn — now the queen is frozen to her king.",
    },
    {
      fen: "q3k3/3p4/2n5/8/8/8/4B3/6K1 w - - 0 1",
      solution: "e2f3",
      story: "The long diagonal! Freeze the pony to the queen hiding in the corner.",
    },
    {
      fen: "6k1/6pp/4r3/8/8/8/8/2Q3K1 w - - 0 1",
      solution: "c1c4",
      story: "Pin the rook from the side — it can't step off the king's diagonal.",
    },
    {
      fen: "6k1/5p1p/6n1/3R4/8/8/8/1K6 w - - 0 1",
      solution: "d5g5",
      story: "Slide across and glue the pony in front of his king. A soldier guards it, so you cannot eat it — but it can never move again.",
    },
    {
      fen: "1k6/8/8/4q3/1p6/r7/8/2B3K1 w - - 0 1",
      solution: "c1f4",
      story: "That lonely tower looks free, but a soldier is watching it. Freeze the queen instead!",
    },
  ],
  skewer2: [
    {
      fen: "8/pr6/8/3k4/8/7B/8/6K1 w - - 0 1",
      solution: "h3g2",
      story: "Check from the corner pocket! The king must step aside — his rook was hiding behind.",
    },
    {
      fen: "4r2k/7p/8/4q3/8/8/8/R4K2 w - - 0 1",
      solution: "a1e1",
      story: "Poke the queen down the open file. When she runs, grab what stood behind her.",
    },
    {
      fen: "8/8/5kp1/8/8/8/1q6/6KQ w - - 0 1",
      solution: "h1h8",
      story: "The longest skewer in chess: corner to corner, king in front, queen behind.",
    },
    {
      fen: "1r5k/8/1q6/6p1/7n/8/K7/7R w - - 0 1",
      solution: "h1b1",
      story: "The pony looks free, but a soldier guards him. Poke the queen from underneath instead — your own king keeps the tower safe, so she has to run.",
    },
    {
      fen: "5r2/8/5p2/2k3n1/8/8/8/2B3K1 w - - 0 1",
      solution: "c1a3",
      story: "Don't snatch the guarded pony. Check from the quiet corner and the king must hop off the long road.",
    },
  ],
  disco2: [
    {
      fen: "6k1/3q1p1p/8/8/6N1/8/8/6RK w - - 0 1",
      solution: "g4f6",
      story: "The pony jumps away, the rook shouts CHECK — and the pony pokes the queen. Double magic!",
    },
    {
      fen: "3k4/5p2/8/8/8/3B4/8/3Q2K1 w - - 0 1",
      solution: "d3b5",
      story: "Step the bishop aside with a threat — the queen was aiming down the road all along.",
    },
    {
      fen: "3r2k1/7p/4P3/8/8/1B6/8/6K1 w - - 0 1",
      solution: "e6e7",
      story: "One tiny pawn step: the bishop checks the king AND the pawn attacks the rook!",
    },
    {
      fen: "1k6/3r4/2n5/1P6/8/8/8/1R4K1 w - - 0 1",
      solution: "b5c6",
      story: "A sideways snack! The soldier munches the pony, the tower yells CHECK, and the soldier is already eyeing a tower.",
    },
    {
      fen: "3k4/5pp1/8/q7/3N4/8/8/3R2K1 w - - 0 1",
      solution: "d4c6",
      story: "Two checks at once — the other hopping square is guarded, so pick the one that also chases the queen.",
    },
  ],
};
