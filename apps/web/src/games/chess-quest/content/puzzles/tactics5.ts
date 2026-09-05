import type { TacticPuzzle } from "./types";

// Tier-5 Trick Shots: "Win a Piece" — a MIXED pack. Unlike tiers 1-4, the
// pack name does not tell the learner which trick applies: each case is won
// by a different motif (fork, pin, skewer, discovered attack, deflection,
// decoy, remove-the-defender, trapped piece, back-rank, pawn fork …) and the
// learner has to spot WHICH one. Judged by material outcome exactly like
// tiers 3-4 (tacticGainAfter: the solution must net >= 3 points against
// black's best defence, or force mate, and be strictly better than every
// other legal first move). Free-play only — no quest lesson points here;
// it lives in the Trick Shots chip row and the arcade.
//
// STORIES ARE ATMOSPHERE ONLY. TacticTrainer renders `story` as the standing
// prompt in Story mode, not behind the Hint button — so a story that names or
// paraphrases the motif ("say hello to two at once", "not allowed to move",
// "count its ways home") hands over the one thing this pack exists to hide.
// Set the scene, name no trick.
export const TACTICS5: Record<"winPiece", TacticPuzzle[]> = {
  winPiece: [
    {
      fen: "2r4k/1b4pp/3q4/4N3/8/8/1B3PPP/4R1K1 w - - 0 1",
      solution: "e5f7",
      story: "Both armies still have plenty on the board and everything looks well guarded. Somewhere in that crowd is one square that changes the whole game.",
    },
    {
      fen: "3k1b1r/pp4pp/8/3n4/8/8/5PPP/R5K1 w - - 0 1",
      solution: "a1d1",
      story: "Nothing is hanging. Nothing is even attacked yet. Find the quiet move that makes him regret where one of his pieces is standing.",
    },
    {
      fen: "4k2r/1pp2ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
      solution: "a1a8",
      story: "He never did get his king tucked safely away. Start with the loudest move you have and watch what falls out afterwards.",
    },
    {
      fen: "r3kb2/pq4pp/3n4/8/4N3/8/5PPP/4R1K1 w - - 0 1",
      solution: "e4d6",
      story: "Your pony is having a comfortable time in the middle of the board. It could be having a much ruder time somewhere else.",
    },
    {
      fen: "6k1/b5pp/2n5/4r3/3P4/8/5PPP/R5K1 w - - 0 1",
      solution: "d4e5",
      story: "Quiet position, ordinary pieces, nothing shouting at you. Take a long look at what is really holding his camp together.",
    },
    {
      fen: "2r3k1/1b3ppp/8/3n4/8/1B5P/5PP1/3R2K1 w - - 0 1",
      solution: "b3d5",
      story: "Something here is loose, but not the way it looks. Work out who is holding up whom.",
    },
    {
      fen: "r5k1/1b3ppp/8/8/3Q4/8/5PPP/3R2K1 w - - 0 1",
      solution: "d4d8",
      story: "A tidy little position: three pawns, a bishop, and a king that has never gone anywhere. Be brave here.",
    },
    {
      fen: "1k5r/pp5p/5p1B/7n/8/4P3/5PPP/7K w - - 0 1",
      solution: "g2g4",
      story: "One of his pieces went for a wander along the edge of the board. Give it something to think about before it strolls back.",
    },
  ],
};
