import type { TacticPuzzle } from "./types";

// Trick Shots packs. White to move; playing the solution (or any move that
// pulls off the same trick — the engine judges) wins the case.
export const TACTICS: Record<"fork" | "pin" | "skewer" | "disco", TacticPuzzle[]> = {
  fork: [
    {
      fen: "r3k3/8/8/1N6/8/8/8/6K1 w - - 0 1",
      solution: "b5c7",
      story: "The pony sees the king AND the rook. One hop, two dinners!",
    },
    {
      fen: "6k1/8/8/2n1n3/8/3P4/8/6K1 w - - 0 1",
      solution: "d3d4",
      story: "The littlest soldier can poke two ponies at once.",
    },
    {
      fen: "6k1/1n6/8/8/8/8/8/3Q2K1 w - - 0 1",
      solution: "d1d5",
      story: "Find the magic square where the queen shouts CHECK and grabs the pony next turn.",
    },
    {
      fen: "2k1q3/8/8/8/2N5/8/8/6K1 w - - 0 1",
      solution: "c4d6",
      story: "The royal family fork — king and queen on one fork. The fanciest trick in chess!",
    },
    {
      fen: "6k1/8/8/2r1r3/8/8/1B6/6K1 w - - 0 1",
      solution: "b2d4",
      story: "The bishop walks up the long road and stares at BOTH towers at once.",
    },
    {
      fen: "6k1/8/8/8/1n3n2/8/8/3R2K1 w - - 0 1",
      solution: "d1d4",
      story: "Even the tower can fork! Slide it out so two ponies are in trouble and only one can run.",
    },
  ],
  pin: [
    {
      fen: "4k3/8/2n5/8/8/8/8/5BK1 w - - 0 1",
      solution: "f1b5",
      story: "Freeze the pony! If it moves, the king behind it is in trouble.",
    },
    {
      fen: "3k4/8/8/3q4/8/8/8/R3K3 w - - 0 1",
      solution: "a1d1",
      story: "Pin the queen to her king. If she takes you, your king takes her back!",
    },
    {
      fen: "k7/8/2q5/8/2B2N2/8/8/6K1 w - - 0 1",
      solution: "c4d5",
      story: "The bishop lines up queen and king. Your pony guards the landing spot.",
    },
    {
      fen: "2q4k/8/8/2n5/8/8/8/K5R1 w - - 0 1",
      solution: "g1c1",
      story: "Slide the tower across the bottom. Now the pony daren't budge, or the queen gets grabbed.",
    },
    {
      fen: "k7/8/7q/8/5r2/B7/8/6K1 w - - 0 1",
      solution: "a3c1",
      story: "Tuck the bishop into the quiet corner and the tower is stuck — the queen hides right behind it.",
    },
    {
      fen: "6k1/8/8/3b4/8/8/7Q/6K1 w - - 0 1",
      solution: "h2a2",
      story: "Send the queen all the way to the far edge and the bishop is glued to the spot forever.",
    },
  ],
  skewer: [
    {
      fen: "4r3/8/8/4k3/8/8/8/R5K1 w - - 0 1",
      solution: "a1e1",
      story: "Check! The king must step aside — and look what was hiding behind him.",
    },
    {
      fen: "q7/8/8/3k4/8/8/4B3/6K1 w - - 0 1",
      solution: "e2f3",
      story: "A shish-kebab on the long diagonal: king in front, queen behind.",
    },
    {
      fen: "4q3/8/4k3/8/8/8/8/3Q2K1 w - - 0 1",
      solution: "d1e2",
      story: "Queens face off — but their king is standing in the middle of the road.",
    },
    {
      fen: "k2r4/8/8/3q4/8/8/8/1R4K1 w - - 0 1",
      solution: "b1d1",
      story: "Point the tower up the empty road. The queen must dash away, and her friend behind cannot.",
    },
    {
      fen: "8/8/B1k5/8/4r3/8/8/6K1 w - - 0 1",
      solution: "a6b7",
      story: "A tiny bishop step, and check! The king has to duck — then the tower is your snack.",
    },
    {
      fen: "7r/6k1/8/8/8/8/8/K2Q4 w - - 0 1",
      solution: "d1d4",
      story: "The queen checks from miles away on the long slanty road. Nobody is guarding the corner.",
    },
  ],
  disco: [
    {
      fen: "4k3/8/8/8/4N3/8/8/4R1K1 w - - 0 1",
      solution: "e4d6",
      story: "Move the pony and — surprise! — the rook behind him was aiming all along.",
    },
    {
      fen: "3k4/8/8/3B4/8/8/8/3R2K1 w - - 0 1",
      solution: "d5c6",
      story: "The bishop steps off the road and the rook thunders down it.",
    },
    {
      fen: "6k1/8/8/3P4/8/8/B7/6K1 w - - 0 1",
      solution: "d5d6",
      story: "Even a tiny pawn step can open the curtain for the archer.",
    },
    {
      fen: "7k/8/8/5r2/3N4/8/1Q6/6K1 w - - 0 1",
      solution: "d4f5",
      story: "The pony hops off to grab a tower, and the queen behind him shouts CHECK!",
    },
    {
      fen: "1k2r3/8/8/4R3/8/8/7B/6K1 w - - 0 1",
      solution: "e5e8",
      story: "Charge the tower up the road for a snack — the bishop was pointing at the king all along.",
    },
    {
      fen: "3k4/8/4r3/3P4/8/8/8/3Q2K1 w - - 0 1",
      solution: "d5e6",
      story: "One little sideways nibble, and the queen's road swings wide open.",
    },
  ],
};
