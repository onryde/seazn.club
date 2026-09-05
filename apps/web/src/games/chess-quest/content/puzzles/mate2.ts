import type { MatePuzzle } from "./types";

// Mate-in-2 pack (Track 2). White to move; the engine accepts ANY move that
// forces mate in two (isMateIn2After), then plays black's toughest defense.
// Every entry is machine-verified: no mate-in-1 exists, and the solution
// forces mate against every reply.
//
// 24 puzzles in four lesson slices of six (content/lessons.ts slices MATE2
// [0,6) [6,12) [12,18) [18,24) for lessons 25, 26, 42 and 48;
// content/__tests__/lessons.test.ts pins that partition):
//   0-5   L25 "Forcing Moves: Mate in 2" — the plain forcing chains: ladder
//         one rung early, king step then queen.
//   6-11  L26 "The Back-Rank Story" — the black king is ON rank 8 with two or
//         more of his OWN pawns walling him in on rank 7 (puzzles.test.ts
//         pins exactly that), and the lone back-row guard has to be dragged
//         off, traded off or fed something.
//   12-17 L42 "Endgame Habits" — few pieces, the king joins in, a pawn
//         promotes, a quiet move takes the last square.
//   18-23 L48 "Boss Battle: Rising Player" — the named patterns: smothered
//         mate, Boden's, Anastasia's, a discovered check, a sacrifice first.
export const MATE2: MatePuzzle[] = [
  /* ---- 0-5 · lesson 25 · Forcing Moves: Mate in 2 ---- */
  {
    fen: "8/7k/R7/1R6/8/8/8/6K1 w - - 0 1",
    solution: "b5b7",
    name: "The ladder, one rung early",
    hint: "Check on the 7th row first — then the back row slams shut.",
  },
  {
    fen: "8/k7/7R/6R1/8/8/8/6K1 w - - 0 1",
    solution: "g5g7",
    name: "Ladder from the left",
    hint: "Same ladder, other side. Which rook gives the check?",
  },
  {
    fen: "8/7k/R7/1Q6/8/8/8/6K1 w - - 0 1",
    solution: "b5b7",
    name: "Queen joins the ladder",
    hint: "The queen takes the 7th row — the rook finishes on the 8th.",
  },
  {
    fen: "8/2K5/8/8/1Q6/R7/7k/8 w - - 0 1",
    solution: "b4b2",
    name: "Ladder, going down",
    hint: "The ladder works downhill too. Queen checks, rook finishes.",
  },
  {
    fen: "7k/8/8/4K3/8/8/6Q1/8 w - - 0 1",
    solution: "e5f6",
    name: "The king lends a hand",
    hint: "A quiet king step first. Then the queen lands right next door.",
  },
  {
    fen: "k7/8/2K5/8/8/8/4Q3/8 w - - 0 1",
    solution: "c6b6",
    name: "Walk, then strike",
    hint: "March your king one step closer — the queen sweeps the back row.",
  },

  /* ---- 6-11 · lesson 26 · The Back-Rank Story ----
     Black king on rank 8, two or more of his own pawns on rank 7. Pinned by
     puzzles.test.ts, so a puzzle pasted in here that isn't a back-ranker
     fails loudly. */
  {
    fen: "2r3k1/5ppp/8/Q7/8/8/8/3R2K1 w - - 0 1",
    solution: "a5d8",
    name: "The queen knocks first",
    hint: "Offer your queen on the back row where only the guard can take her. A guard that is busy eating is not guarding.",
  },
  {
    fen: "6k1/5ppp/8/q7/8/8/3R4/3R2K1 w - - 0 1",
    solution: "d2d8",
    name: "Two rooks, one road",
    hint: "Both rooks are already stacked on the same road. Send the front one in; the back one has the last word.",
  },
  {
    fen: "6k1/5ppp/n7/8/8/8/1Q6/1R4K1 w - - 0 1",
    solution: "b2b8",
    name: "The pony on guard duty",
    hint: "One pony is watching the far corner of the back row. Put something delicious on that square — he cannot guard it and eat it.",
  },
  {
    fen: "1k4r1/ppp5/8/7Q/8/8/7K/4R3 w - - 0 1",
    solution: "e1e8",
    name: "Cheap piece first",
    hint: "Kings hide on this side of the board too. Send the rook in first — the queen is watching that square from far away.",
  },
  {
    fen: "2k4r/1ppp4/8/8/8/8/5R2/5RK1 w - - 0 1",
    solution: "f2f8",
    name: "Back door, other side",
    hint: "His rook is miles away on the wrong wing. One of yours is bait, the other is the finish.",
  },
  {
    fen: "5rk1/6pp/8/7B/8/8/8/3Q1RK1 w - - 0 1",
    solution: "f1f8",
    name: "The last guard trades off",
    hint: "Trade the only piece watching the back row. The king has to take it himself — and the bishop already covers his one escape hole.",
  },

  /* ---- 12-17 · lesson 42 · Endgame Habits ---- */
  {
    fen: "7k/5K2/6P1/6P1/8/8/8/8 w - - 0 1",
    solution: "g6g7",
    name: "Crowning with check",
    hint: "Push! The brand-new queen arrives with checkmate — the little brother guards the exit.",
  },
  {
    fen: "k7/2K5/1P6/1P6/8/8/8/8 w - - 0 1",
    solution: "b6b7",
    name: "Coronation corner",
    hint: "One more pawn step. Where does the king have to go?",
  },
  {
    fen: "4k3/8/8/8/8/8/1R6/R5K1 w - - 0 1",
    solution: "b2b7",
    name: "Cut, then slam",
    hint: "First cut off the 7th row — no check needed. Then slam the 8th.",
  },
  {
    fen: "7k/8/8/6K1/8/8/8/R7 w - - 0 1",
    solution: "g5g6",
    name: "Shoulder to shoulder",
    hint: "Step your king up close first. Then the rook delivers the letter.",
  },
  {
    fen: "k7/8/8/1K6/8/8/8/7R w - - 0 1",
    solution: "b5b6",
    name: "Cornered by teamwork",
    hint: "King to b6 takes every door away. The rook does the rest.",
  },
  {
    fen: "k7/2K5/8/1P5p/3B4/8/8/8 w - - 0 1",
    solution: "b5b6",
    name: "The quiet squeeze",
    hint: "No check at all! Take away the last free square and wait one move.",
  },

  /* ---- 18-23 · lesson 48 · Boss Battle: Rising Player ---- */
  {
    fen: "7k/p5pp/5n2/8/8/1B6/8/3R2K1 w - - 0 1",
    solution: "d1d8",
    name: "Both jumps lose",
    hint: "Check along the back row and count his answers. The pony can leap in front of you two different ways — and your bishop already poisons one of the landing squares.",
  },
  {
    fen: "r6k/p5pp/8/8/8/1B6/8/3Q2KR w - - 0 1",
    solution: "h1h7",
    name: "Lift the roof off",
    hint: "Tear the last pawn off the king's roof and make him take. Your queen can reach that side of the board in one hop.",
  },
  {
    fen: "r6k/4Nppp/8/7Q/8/3R4/8/6K1 w - - 0 1",
    solution: "h5h7",
    name: "Anastasia's net",
    hint: "The pony already guards both squares the king would run to. Give the whole queen to drag him out of the corner.",
  },
  {
    fen: "3k4/2p1p3/5N2/3B4/r7/8/8/3R2K1 w - - 0 1",
    solution: "d5b7",
    name: "Step aside and check",
    hint: "Your bishop is standing in front of the rook. Move it out of the way — but land somewhere that covers the king's escape square.",
  },
  {
    fen: "2kr4/1p1n4/2p5/3Q4/2B2B2/8/8/6K1 w - - 0 1",
    solution: "d5c6",
    name: "Two bishops crossing",
    hint: "Two bishops on crossing roads are a net. Feed your queen to the pawn that is blocking one of those roads.",
  },
  {
    fen: "5r1k/6pp/7N/3Q4/8/8/8/6K1 w - - 0 1",
    solution: "d5g8",
    name: "The smothered finish",
    hint: "Hand your queen to the rook so the rook has to stand on the king's last free square. Then the pony ends it.",
  },
];
