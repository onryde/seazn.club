import type { HuntPuzzle } from "./types";

// Hanging-piece positions for the Piece Detective game. White to move;
// exactly one black piece (never the king) is attacked and undefended.
// Uniqueness is machine-verified by the tests.
//
// Four lesson slices of eight, in order (content/lessons.ts slices HUNTS
// [0,8) [8,16) [16,24) [24,32) for lessons 17, 21, 33, 46; the themes are
// pinned by shape in content/__tests__/puzzles.test.ts):
//   0-7   L17 "The Free-Stuff Detector": plain hanging pieces on quiet boards.
//   8-15  L21 "Winning the Won Game": white is ALREADY up a rook or more, so
//              the free piece is how you convert, not a trap to fear.
//   16-23 L33 "Guard the Gate: Trap Defense": opening-shaped (move 4-10 of a
//              real game), black still has 10+ pieces, and the loose piece is
//              the kind that hangs after a careless opening move.
//   24-31 L46 "Candidate Moves": busy boards with several attacked-but-
//              DEFENDED black pieces as decoys, so the learner has to count
//              guards before grabbing.
export const HUNTS: HuntPuzzle[] = [
  {
    fen: "6k1/3n1ppp/8/8/8/8/8/3Q2K1 w - - 0 1",
    answer: "d7",
    story: "The queen stares down the d-file. Someone forgot their bodyguard…",
  },
  {
    fen: "6k1/1p2bppp/n7/8/8/8/8/4R1K1 w - - 0 1",
    answer: "e7",
    story: "One black piece has a friend nearby. The other is all alone.",
  },
  {
    fen: "6k1/5ppp/8/1q6/8/2N5/8/6K1 w - - 0 1",
    answer: "b5",
    story: "Even a queen can be free stuff if nobody guards her!",
  },
  {
    fen: "2r3k1/5ppp/8/8/8/7B/8/6K1 w - - 0 1",
    answer: "c8",
    story: "The bishop peeks all the way down the long diagonal.",
  },
  {
    fen: "6k1/5ppp/8/3n4/2P5/8/8/6K1 w - - 0 1",
    answer: "d5",
    story: "The littlest attacker! Pawns love catching big ponies.",
  },
  {
    fen: "6k1/5ppp/8/8/8/2r5/8/2R3K1 w - - 0 1",
    answer: "c3",
    story: "Two rooks on one road — but only one of them is safe.",
  },
  {
    fen: "3b2k1/5ppp/8/8/8/8/3R4/3R2K1 w - - 0 1",
    answer: "d8",
    story: "Double trouble on the d-file. The bishop never saw it coming.",
  },
  {
    fen: "6k1/5ppp/2n5/8/3N4/8/8/6K1 w - - 0 1",
    answer: "c6",
    story: "Pony vs. pony! One of them wandered too far from home.",
  },

  // --- L21 "Winning the Won Game" — white is already up a rook or more. ---
  {
    fen: "6k1/5ppp/1n6/8/8/8/8/1R1Q2K1 w - - 0 1",
    answer: "b6",
    story: "You're a whole rook ahead. Don't get fancy — just pocket the loose pony.",
  },
  {
    fen: "6k1/5ppp/b7/8/8/8/1P6/R3R1K1 w - - 0 1",
    answer: "a6",
    story: "Winning already? Then win a bit more. One bishop forgot to bring a guard.",
  },
  {
    fen: "6k1/5ppp/5n2/8/8/2r5/8/R1R1Q1K1 w - - 0 1",
    answer: "c3",
    story: "Rook, rook and queen, all pointing the same way. Something is coming home with you.",
  },
  {
    fen: "7k/p5pp/8/7Q/3n4/8/8/3R2K1 w - - 0 1",
    answer: "d4",
    story: "Miles ahead, so keep it boring: find the pony nobody is watching.",
  },
  {
    fen: "1r4k1/5ppp/8/8/2B5/8/8/1R2R1K1 w - - 0 1",
    answer: "b8",
    story: "That rook in the corner is doing nothing at all — and nothing is minding it either.",
  },
  {
    fen: "k7/pp6/8/4n3/3Q4/8/8/4R1K1 w - - 0 1",
    answer: "e5",
    story: "Careful now. One black piece has a helper; the other one only has hope.",
  },
  {
    fen: "6k1/6pp/8/3p4/8/1Q6/8/3R2K1 w - - 0 1",
    answer: "d5",
    story: "Even a lonely little pawn counts. Sweep it up and the game finishes itself.",
  },
  {
    fen: "7k/6pp/8/1n6/8/8/2Q5/1R2R1K1 w - - 0 1",
    answer: "b5",
    story: "Big lead, calm hands. Look for the piece that stepped out without a buddy.",
  },

  // --- L33 "Guard the Gate: Trap Defense" — opening-shaped boards. ---
  {
    fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/1PB1P3/5N2/P1PP1PPP/RNBQK2R w - - 0 1",
    answer: "c5",
    story: "Move six of a real game! A bishop came out early and nobody stayed behind for it.",
  },
  {
    fen: "rnbqkb1r/pppppppp/8/8/2PPn3/2N5/PP2PPPP/R1BQKBNR w - - 0 1",
    answer: "e4",
    story: "The pony leapt into the middle on move two. Very brave… and completely alone.",
  },
  {
    fen: "rnbqk1nr/pppp1ppp/8/4p3/1b2P3/P1N5/1PPP1PPP/R1BQKBNR w - - 0 1",
    answer: "b4",
    story: "A pawn just poked one of the bishops in the ribs. Is anyone coming to help? Nope.",
  },
  {
    fen: "rn1qkbnr/ppp1pppp/8/3pN3/3P2b1/8/PPP1PPPP/RNBQKB1R w - - 0 1",
    answer: "g4",
    story: "The bishop slipped outside before the pawns did, and a pony crept up behind it.",
  },
  {
    fen: "rnbqkbnr/p1p1pppp/8/1p6/P1pP4/4P3/1P3PPP/RNBQKBNR w - - 0 1",
    answer: "b5",
    story: "Black went pawn-grabbing. One of those grabby pawns has nobody looking after it.",
  },
  {
    fen: "rn1qkb1r/ppp1pppp/5n2/3p1b2/3P4/3BPN2/PPP2PPP/RNBQK2R w - - 0 1",
    answer: "f5",
    story: "Two bishops staring each other down. Only one of them brought backup.",
  },
  {
    fen: "rnbqkb1r/pppppppp/8/4P3/1nP5/P7/1P1P1PPP/RNBQKBNR w - - 0 1",
    answer: "b4",
    story: "The pony hopped up the board all on its own. Something is leaning on it now, and no friend is close enough to help.",
  },
  {
    fen: "r1bqkbnr/pppp1ppp/8/4n3/3PP3/8/PPP2PPP/RNBQKB1R w - - 0 1",
    answer: "e5",
    story: "The swap looked fair until a pawn stepped forward. Ponies hate being shoved.",
  },

  // --- L46 "Candidate Moves" — busy boards full of defended decoys. ---
  {
    fen: "2r3k1/pp2qppp/2n1b3/3p3n/6P1/1B3N2/PP2QP1P/2RR2K1 w - - 0 1",
    answer: "h5",
    story: "Four black pieces are under attack. Three of them have guards. Find the odd one out.",
  },
  {
    fen: "1rbq1rk1/p1p1pppp/5n2/6B1/3P4/5N2/1PQ2PPP/R3R1K1 w - - 0 1",
    answer: "a7",
    story: "Loads of targets here. Check every single one for a helper before you grab anything.",
  },
  {
    fen: "2r2bk1/p3qppp/2p5/1b1p2B1/8/2N4B/PP2QPPP/3R2K1 w - - 0 1",
    answer: "c8",
    story: "Something big is parked at the end of an empty road. Follow the road with your eyes.",
  },
  {
    fen: "2b2rk1/1ppn1ppp/3p4/qB2p3/8/5N2/5PPP/R2R2K1 w - - 0 1",
    answer: "a5",
    story: "The queen marched off to the edge to look brave. Nobody marched with her.",
  },
  {
    fen: "5rk1/ppq2ppp/4bn2/6B1/3p4/5N2/PP2QPPP/R2R2K1 w - - 0 1",
    answer: "d4",
    story: "A little one crept deep into your camp, miles away from anyone who could save it.",
  },
  {
    fen: "r4r1k/1bq2ppp/p3p3/1p6/2Bn4/5N2/PP2QPPP/3RR1K1 w - - 0 1",
    answer: "d4",
    story: "A pony parked right in the middle of your army. Cheeky — and nobody is minding it.",
  },
  {
    fen: "5rk1/pp3ppp/1qp2n2/3p2B1/n7/8/1PB2PPP/R2R2K1 w - - 0 1",
    answer: "a4",
    story: "Busy board! Count the guards on every attacked piece, then take the one with zero.",
  },
  {
    fen: "3q1rk1/pb3ppp/1p3n2/2p1r3/3P4/5N2/PPQ2PBP/3RR1K1 w - - 0 1",
    answer: "e5",
    story: "The rook rolled into the middle looking scary. Scary is not the same as safe.",
  },
];
