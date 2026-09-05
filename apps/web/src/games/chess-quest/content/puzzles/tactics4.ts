import type { TacticPuzzle } from "./types";

// Tier-4 Trick Shots (appended to Track 4 / Puzzle Gorge): double
// check, back-rank mate, trapped piece, pawn fork. Same verification shape
// as TACTICS3 (tacticGainAfter: material swing, or a dominating sentinel
// for forced mate; solution must be uniquely best). The engine has no
// castling, en passant or under-promotion (engine/board.ts) — back-rank
// kings are placed directly rather than reached by castling, and no entry
// here depends on en passant.
export const TACTICS4: Record<
  "doubleCheck" | "backRank" | "trappedPiece" | "pawnFork",
  TacticPuzzle[]
> = {
  doubleCheck: [
    {
      fen: "7k/6p1/8/7N/8/8/8/K6R w - - 0 1",
      solution: "h5f6",
      story: "Two checks at once — the pony reveals the rook AND checks him itself. No answer to that!",
    },
    {
      fen: "7k/6p1/8/3r3N/8/8/8/K6R w - - 0 1",
      solution: "h5f6",
      story: "That lonely rook over there won't make it back in time. Two checks, nowhere to go!",
    },
    {
      fen: "7k/6p1/8/7N/1b6/8/p7/K6R w - - 0 1",
      solution: "h5f6",
      story: "Ignore the spectators on the other side of the board — this hop ends it with a double check.",
    },
    {
      fen: "2r3k1/6pp/1P6/3N4/8/8/B7/6K1 w - - 0 1",
      solution: "d5e7",
      story: "The pony hops in checking and wakes the bishop up checking too. He can only run — then the rook is yours.",
    },
  ],
  backRank: [
    {
      fen: "r5k1/5ppp/8/8/8/8/8/R6K w - - 0 1",
      solution: "a1a8",
      story: "The back row is wide open — his own pawns won't let him escape upward!",
    },
    {
      fen: "1k6/ppp5/8/8/5n2/8/8/6KQ w - - 0 1",
      solution: "h1h8",
      story: "Slide all the way across the board — three little pawns are a wall, not a shield.",
    },
    {
      fen: "4k3/3ppp2/8/8/1b6/8/8/R6K w - - 0 1",
      solution: "a1a8",
      story: "That bishop only watched from far away. Your rook owns the whole back rank.",
    },
    {
      fen: "6k1/5ppp/8/1b6/8/8/8/R6K w - - 0 1",
      solution: "a1a8",
      story: "Charge to the back row. The bishop can throw itself in the way — but only on a square his king cannot reach, so take it and it is STILL mate.",
    },
  ],
  trappedPiece: [
    {
      fen: "k7/8/7b/8/8/8/K7/7R w - - 0 1",
      solution: "h1h6",
      story: "That bishop wandered all the way to the rim with nowhere safe left to go. Scoop it up!",
    },
    {
      fen: "k7/8/8/n7/8/2B5/8/6K1 w - - 0 1",
      solution: "c3a5",
      story: "A knight on the rim is dim — and this one has no way back home.",
    },
    {
      fen: "7k/8/8/8/q7/2N5/8/6K1 w - - 0 1",
      solution: "c3a4",
      story: "The queen went hunting alone and got cut off. Your pony collects the bounty.",
    },
    {
      fen: "k7/8/8/3N3n/6P1/8/7P/6K1 w - - 0 1",
      solution: "g4h5",
      story: "His pony has exactly ONE quiet square left to hop to. Do not give him the move he needs to use it.",
    },
  ],
  pawnFork: [
    {
      fen: "8/5k1q/8/6PP/8/8/8/K7 w - - 0 1",
      solution: "g5g6",
      story: "One little step pokes his king AND his queen at the same moment. He has to answer the king — and then she is yours.",
    },
    {
      fen: "8/k1r5/8/PP6/8/8/8/7K w - - 0 1",
      solution: "b5b6",
      story: "March right up beside his king. Your other pawn is watching that square, so nobody can eat yours — and the rook is next.",
    },
    {
      fen: "8/8/2k1r3/3n4/4P3/2N5/8/7K w - - 0 1",
      solution: "e4d5",
      story: "Munch the pony — then look where your little soldier landed. Now his king and his rook are both in trouble.",
    },
    {
      fen: "8/1pk1r1p1/8/3P4/8/8/8/3R2K1 w - - 0 1",
      solution: "d5d6",
      story: "Poke the pawn right under his nose — your rook is holding it, so the king must step away and the rook is dinner.",
    },
  ],
};
