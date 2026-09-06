import type { MatePuzzle } from "./types";

// Mate-in-3 pack (Track 4). White to move; the engine accepts ANY move that
// forces mate in three (isMateInNAfter … 3), then plays black's toughest
// defense twice more. Authored in three groups of three, in this fixed
// order: Queen + King (0-2), Single Rook (3-5), Double Rook (6-8) — see the
// group-composition tests in content/__tests__/puzzles.test.ts. Every entry
// is machine-verified: no mate-in-1, no mate-in-2, forced in exactly three
// against every black defence, and carries an obstructing or decoy pawn
// (too far away to matter, or just watching) so the position is never a
// bare textbook box. None of these pawns are actually pinned — an earlier
// draft claimed one was and the engine disproved it (2026-08-27).
export const MATE3: MatePuzzle[] = [
  // --- Queen + King ---
  {
    fen: "7k/8/8/4K3/3p4/8/8/Q7 w - - 0 1",
    solution: "e5f6",
    name: "The frozen guard",
    hint: "That little pawn can't help black at all — ignore it and walk your king in first.",
  },
  {
    fen: "7k/p7/3K4/8/8/8/6Q1/8 w - - 0 1",
    solution: "d6e6",
    name: "The far-off pawn",
    hint: "Ignore the lonely pawn all the way over there. Walk your king closer, then box him in.",
  },
  {
    fen: "7k/1p6/8/5K2/8/1Q6/8/8 w - - 0 1",
    solution: "f5f6",
    name: "Queen waits her turn",
    hint: "March your king up first — the queen finishes the job from the side.",
  },
  // --- Single Rook ---
  {
    fen: "7k/8/8/5K2/8/8/8/6R1 w - - 0 1",
    solution: "f5g6",
    name: "The silent rook",
    hint: "Neither move is check! Walk your king in close, then let the rook wait quietly.",
  },
  {
    fen: "7k/8/8/4K3/8/8/8/R7 w - - 0 1",
    solution: "e5f6",
    name: "Two doors, one key",
    hint: "Bring your king up. Wherever he runs next, your rook finds the far corner.",
  },
  {
    fen: "7k/R7/4K3/8/8/8/8/8 w - - 0 1",
    solution: "e6f7",
    name: "One square left",
    hint: "Step your king closer — he's down to one square. Then swing the rook clear across.",
  },
  // --- Double Rook ---
  {
    fen: "8/8/5k2/R7/8/3p4/8/1R4K1 w - - 0 1",
    solution: "b1b6",
    name: "The ladder, two rungs back",
    hint: "That stray pawn can't help him. Climb the ladder one rank at a time.",
  },
  {
    fen: "8/8/2k5/7R/8/4p3/6R1/6K1 w - - 0 1",
    solution: "g2g6",
    name: "Ladder from the right",
    hint: "Same ladder, mirrored — the lonely pawn is just watching.",
  },
  {
    fen: "8/8/5k2/R7/8/3p4/1R6/6K1 w - - 0 1",
    solution: "b2b6",
    name: "One more step back",
    hint: "Patience — the ladder still works, it just needs one extra rung.",
  },
];
