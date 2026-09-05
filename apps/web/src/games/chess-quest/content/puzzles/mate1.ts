import type { MatePuzzle } from "./types";

// Mate-in-1 puzzle pack. White to move in every puzzle.
// solution is the move we hint toward; the game accepts ANY legal move
// that delivers checkmate.
//
// 35 puzzles in seven themed groups of five — content/lessons.ts slices this
// array [0,5) [5,10) … [30,35) for lessons 7, 9, 10, 11, 22, 24 and 36, and
// content/__tests__/puzzles.test.ts pins each group's material so a puzzle
// pasted into the wrong group fails loudly:
//   0-4   L7  "Checkmate vs. the Sneaky Tie" — king + ONE heavy piece.
//   5-9   L9  "The Lawnmower"                — two heavy pieces, nothing else.
//   10-14 L10 "The Queen's Box"              — king + queen only.
//   15-19 L11 "Puzzle Storm"                 — every one uses a knight/bishop.
//   20-24 L22 "Think Like a Champ"           — mixed, pawns among them.
//   25-29 L24 "Boss Battle & Crown"          — busy boards, 5+ black pieces.
//   30-34 L36 "Punish Opening Mistakes"      — opening-shaped, 10+ black.
// MATE1[0] must stay the e1-e8 hallway: apps/web/e2e/games.spec.ts plays it.
export const MATE1: MatePuzzle[] = [
  // --- 0-4 · Lesson 7 · Checkmate vs. the Sneaky Tie -----------------------
  {
    fen: "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1",
    solution: "e1e8",
    name: "Sneak down the hallway",
    hint: "The back row is wide open — slide all the way!",
  },
  {
    fen: "6k1/5ppp/8/8/8/8/8/3Q2K1 w - - 0 1",
    solution: "d1d8",
    name: "Queen takes the hallway",
    hint: "Same trick, stronger piece.",
  },
  {
    fen: "5k2/8/5K2/8/8/8/8/7R w - - 0 1",
    solution: "h1h8",
    name: "Box on the edge",
    hint: "Your king blocks the whole row below. Slide across the top!",
  },
  {
    fen: "4k3/4p3/4K3/8/8/8/8/7R w - - 0 1",
    solution: "h1h8",
    name: "Trapped in the middle",
    hint: "His own pawn is in the way — and your king does the rest.",
  },
  {
    fen: "7k/8/5K2/8/8/8/8/6Q1 w - - 0 1",
    solution: "g1g7",
    name: "Careful — that's a tie!",
    hint: "One shiny queen move leaves him with no moves and no check at all: a boring tie. Step right up beside him instead, where your king is watching.",
  },

  // --- 5-9 · Lesson 9 · The Lawnmower --------------------------------------
  {
    fen: "7k/R7/1R6/8/8/8/8/6K1 w - - 0 1",
    solution: "b6b8",
    name: "The lawnmower",
    hint: "One rook holds the row — the other one finishes the job.",
  },
  {
    fen: "k7/6R1/8/8/8/8/8/5K1R w - - 0 1",
    solution: "h1h8",
    name: "Lawnmower, other side",
    hint: "Rooks take turns. Whose turn is it?",
  },
  {
    fen: "k7/8/8/8/7R/8/1R6/6K1 w - - 0 1",
    solution: "h4a4",
    name: "Ladder lying down",
    hint: "The ladder works sideways too. One rook holds the b-file…",
  },
  {
    fen: "3k4/R7/8/8/8/8/8/6KR w - - 0 1",
    solution: "h1h8",
    name: "Ladder to the top floor",
    hint: "Your first rook already fenced off the row below him. Sweep the whole top row with the other one.",
  },
  {
    fen: "8/8/8/k7/8/6K1/1Q6/2R5 w - - 0 1",
    solution: "c1a1",
    name: "The queen joins the mow",
    hint: "Your queen fences off the lane next door. Slide the rook along the bottom row to the far edge.",
  },

  // --- 10-14 · Lesson 10 · The Queen's Box ---------------------------------
  {
    fen: "6k1/8/6K1/8/8/8/8/Q7 w - - 0 1",
    solution: "a1a8",
    name: "The queen's fence",
    hint: "Lock the whole top row. Your king guards the doors.",
  },
  {
    fen: "7k/Q7/6K1/8/8/8/8/8 w - - 0 1",
    solution: "a7g7",
    name: "The royal hug",
    hint: "The queen stands right next to the king — bodyguard behind her.",
  },
  {
    fen: "3k4/8/3K4/8/8/8/8/Q7 w - - 0 1",
    solution: "a1a8",
    name: "Queen slam",
    hint: "The kings are staring at each other. Slam the back row!",
  },
  {
    fen: "k7/p7/2K5/8/8/8/8/1Q6 w - - 0 1",
    solution: "b1b7",
    name: "The bodyguard queen",
    hint: "Stand right next to the king — your own king protects you.",
  },
  {
    fen: "8/8/8/k1K5/8/8/8/7Q w - - 0 1",
    solution: "h1a1",
    name: "Don't squeeze him too gently",
    hint: "Creep the queen up close and he has no moves and no check — that's a tie, not a win. Take the bottom row to the far edge instead; your king already holds the doors.",
  },

  // --- 15-19 · Lesson 11 · Puzzle Storm ------------------------------------
  {
    fen: "7k/6p1/5N2/8/8/8/8/R5K1 w - - 0 1",
    solution: "a1a8",
    name: "Knight and rook team up",
    hint: "The pony already guards the escape squares.",
  },
  {
    fen: "6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1",
    solution: "g5f7",
    name: "The smother",
    hint: "The king is trapped by his own friends. Who can jump in?",
  },
  {
    fen: "kr6/p7/P7/1N6/8/8/8/6K1 w - - 0 1",
    solution: "b5c7",
    name: "Corner pony",
    hint: "The king's own army boxes him in. One hop ends it.",
  },
  {
    fen: "6k1/5p1p/8/8/3Q4/8/1B6/6K1 w - - 0 1",
    solution: "d4g7",
    name: "Bishop points, queen punches",
    hint: "Your bishop stares down the long slope already. Put the queen right in front of the king — the bishop keeps her safe.",
  },
  {
    fen: "kr6/pp6/4N3/8/8/8/8/6K1 w - - 0 1",
    solution: "e6c7",
    name: "Nowhere left to stand",
    hint: "His castle and his soldiers fill every way out. One hop finishes it.",
  },

  // --- 20-24 · Lesson 22 · Think Like a Champ ------------------------------
  {
    fen: "k7/p1K5/1P6/8/8/8/8/8 w - - 0 1",
    solution: "b6b7",
    name: "The little giant",
    hint: "Even the smallest soldier can win the war.",
  },
  {
    fen: "2k5/P7/2K5/8/8/8/8/8 w - - 0 1",
    solution: "a7a8",
    name: "Crowned!",
    hint: "Walk one more step and the pawn becomes a queen — with checkmate!",
  },
  {
    fen: "6k1/6p1/6P1/8/8/8/8/R5K1 w - - 0 1",
    solution: "a1a8",
    name: "Pawn locks the gate",
    hint: "Your little pawn guards both escape doors already.",
  },
  {
    fen: "6rk/6p1/8/8/3Q4/8/8/6K1 w - - 0 1",
    solution: "d4h4",
    name: "The side door",
    hint: "The h-file is a wide-open corridor.",
  },
  {
    fen: "6k1/4Pppp/8/8/8/8/8/6K1 w - - 0 1",
    solution: "e7e8",
    name: "A brand-new queen crashes in",
    hint: "Your last little soldier is one step from growing up — and he grows up with a bang.",
  },

  // --- 25-29 · Lesson 24 · Boss Battle & Crown -----------------------------
  {
    fen: "6k1/1p3ppp/p7/n7/8/3r4/5PPP/4R1K1 w - - 0 1",
    solution: "e1e8",
    name: "Boss fight: no window",
    hint: "His soldiers never opened a window for their king. Charge straight down the empty road.",
  },
  {
    fen: "5rk1/pp3ppp/2n5/7Q/8/3B4/5PPP/6K1 w - - 0 1",
    solution: "h5h7",
    name: "Queen knocks, bishop guards",
    hint: "Two of your big pieces aim at the same door beside his king. Take it — somebody is covering you.",
  },
  {
    fen: "r6k/pppR4/5Np1/8/8/8/5PPP/6K1 w - - 0 1",
    solution: "d7h7",
    name: "Rook walks right up",
    hint: "Your rook can march to the square next door because the pony is watching it. Nobody can bite back.",
  },
  {
    fen: "r1b5/ppp1Nppk/8/R7/8/8/5PPP/6K1 w - - 0 1",
    solution: "a5h5",
    name: "Pinned against the wall",
    hint: "The pony covers both inside doors already. Fly the rook across into his open lane.",
  },
  {
    fen: "5r1k/pbp5/1p5p/7N/8/6Q1/5PPP/6K1 w - - 0 1",
    solution: "g3g7",
    name: "Queen in the boss room",
    hint: "March the queen right next to the king. Look who is guarding that square — your pony on the edge.",
  },

  // --- 30-34 · Lesson 36 · Punish Opening Mistakes -------------------------
  {
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w - - 0 1",
    solution: "h5f7",
    name: "The four-move ambush",
    hint: "Two of your pieces already stare at his weakest square — the one only his king defends.",
  },
  {
    fen: "rnbqkbnr/ppppp2p/5p2/6p1/3PP3/8/PPP2PPP/RNBQKBNR w - - 0 1",
    solution: "d1h5",
    name: "He opened his own door",
    hint: "Those two little pawn moves cracked open a long slanted road straight to his king. Send the queen down it.",
  },
  {
    fen: "r2q1bnr/ppp1kB1p/3p2p1/4N3/4P3/2N5/PPPP1PPP/R1BbK2R w - - 0 1",
    solution: "c3d5",
    name: "Greedy grab, big price",
    hint: "He grabbed your queen and forgot his king. Hop the spare pony into the middle — every escape door is watched already.",
  },
  {
    fen: "r1bqkb1r/pp1npppp/2p2n2/8/3PN3/8/PPP1QPPP/R1B1KBNR w - - 0 1",
    solution: "e4d6",
    name: "Stuffed by his own friends",
    hint: "Look how crowded his side is. One hop lands right beside the king and nobody can answer.",
  },
  {
    fen: "rnbq1bnr/ppppkppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w - - 0 1",
    solution: "h5e5",
    name: "Never walk your king out early",
    hint: "He strolled his king out on move two. Snap up the pawn in the middle and the whole lane belongs to you.",
  },
];
