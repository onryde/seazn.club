import { describe, expect, it } from "vitest";
import {
  parseFEN,
  sqIdx,
  sqName,
  isWhitePiece,
  isAttacked,
  inCheck,
  isStalemate,
  legalTargets,
  applyMove,
  allLegalMoves,
  isMate,
  hasMateIn1,
  isMateIn2After,
  isMateInNAfter,
  hasMateInN,
  isForkAfter,
  isPinAfter,
  isSkewerAfter,
  isDiscoveredAfter,
  tacticGainAfter,
  pieceValue,
  rankRow,
  fileOf,
} from "../../engine";
import {
  MATE1,
  HUNTS,
  TACTICS,
  MATE2,
  TACTICS2,
  MATE3,
  TACTICS3,
  TACTICS4,
  TACTICS5,
} from "../puzzles";

const mv = (sol: string) => ({ from: sqIdx(sol.slice(0, 2)), to: sqIdx(sol.slice(2, 4)) });

// White's army as a sorted string of piece letters (king excluded), e.g.
// "QR" — used to pin what material a themed group is built from.
const whiteArmy = (board: string[]) =>
  board
    .filter((p) => p !== "" && isWhitePiece(p) && p !== "K")
    .sort()
    .join("");
const count = (board: string[], piece: string) => board.filter((p) => p === piece).length;
const blackPieces = (board: string[]) => board.filter((p) => p !== "" && !isWhitePiece(p)).length;
const material = (board: string[], white: boolean) =>
  board
    .filter((p) => p !== "" && isWhitePiece(p) === white && p.toUpperCase() !== "K")
    .reduce((s, p) => s + pieceValue(p), 0);
const menOnBoard = (board: string[]) => board.filter((p) => p !== "").length;

// ---------------------------------------------------------------------------
// Every position in every pack must be one a real game could actually have
// reached. Cheap arithmetic only — but the first run of it found MATE1[30],
// a Scholar's-mate trap taught as "a real opening" with White holding TWO
// queens while all eight of his pawns were still on their starting squares.
// A wrong board in a puzzle presented as a real opening teaches a wrong idea,
// so this runs on every puzzle of every family, not just the mate packs.
//   - exactly one king a side, and the two kings never adjacent
//   - no pawn on rank 1 or rank 8 (it would have promoted, or never started)
//   - per side: pawns still on the board + pieces beyond the starting count
//     of that type <= 8, because every surplus piece cost a pawn to promote
// ---------------------------------------------------------------------------
const STARTING_COUNT = { Q: 1, R: 2, B: 2, N: 2 } as const;

function expectLegalPosition(board: string[], label: string) {
  const count = (piece: string) => board.filter((p) => p === piece).length;
  expect(count("K"), `${label}: white kings`).toBe(1);
  expect(count("k"), `${label}: black kings`).toBe(1);
  const strandedPawns = board
    .map((p, i) => (p.toUpperCase() === "P" && (rankRow(i) === 0 || rankRow(i) === 7) ? sqName(i) : ""))
    .filter((s) => s !== "");
  expect(strandedPawns, `${label}: pawn on a promotion rank`).toEqual([]);
  const wk = board.indexOf("K");
  const bk = board.indexOf("k");
  const kingGap = Math.max(Math.abs(fileOf(wk) - fileOf(bk)), Math.abs(rankRow(wk) - rankRow(bk)));
  expect(kingGap, `${label}: kings are adjacent`).toBeGreaterThan(1);
  for (const white of [true, false]) {
    const letter = (piece: string) => (white ? piece : piece.toLowerCase());
    const promotions = Object.entries(STARTING_COUNT).reduce(
      (sum, [piece, start]) => sum + Math.max(0, count(letter(piece)) - start),
      0,
    );
    const pawns = count(letter("P"));
    expect(
      pawns + promotions,
      `${label}: ${white ? "white" : "black"} has ${pawns} pawns and needs ${promotions} promotions`,
    ).toBeLessThanOrEqual(8);
  }
}

// ---------------------------------------------------------------------------
// Mate in 1 — 35 puzzles in seven lesson groups of five (content/lessons.ts
// slices MATE1 [0,5) [5,10) … [30,35) for lessons 7, 9, 10, 11, 22, 24, 36;
// content/__tests__/lessons.test.ts pins that partition). The groups are
// THEMED to their lesson, and the theme is pinned here by the material on the
// board so a puzzle pasted into the wrong group fails loudly:
//   0-4   L7  "Checkmate vs. the Sneaky Tie": king + ONE heavy piece, the
//              first mates a child ever sees. MATE1[0] must stay the e1-e8
//              hallway — apps/web/e2e/games.spec.ts plays it by hand.
//   5-9   L9  "The Lawnmower": two heavy pieces (RR or QR), nothing else.
//   10-14 L10 "The Queen's Box": king + queen ONLY.
//   15-19 L11 "Puzzle Storm": mixed — every one uses a knight or a bishop.
//   20-24 L22 "Think Like a Champ": mixed, at least two involve a pawn.
//   25-29 L24 "Boss Battle": busier boards, black has 5+ pieces.
//   30-34 L36 "Punish Opening Mistakes": opening-shaped, black has 10+
//              pieces still standing.
// ---------------------------------------------------------------------------
describe("MATE1: every solution is a legal mate-in-1", () => {
  it("has 35 puzzles", () => {
    expect(MATE1).toHaveLength(35);
  });
  it("keeps the e2e's hallway mate first (e1-e8)", () => {
    expect(MATE1[0].fen).toBe("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1");
    expect(MATE1[0].solution).toBe("e1e8");
  });
  it.each(MATE1.map((p) => [p.name, p] as const))("%s", (_name, pz) => {
    const { board, whiteToMove } = parseFEN(pz.fen);
    expect(whiteToMove).toBe(true);
    expectLegalPosition(board, pz.name);
    const { from, to } = mv(pz.solution);
    expect(inCheck(board, false)).toBe(false); // black not already in check
    expect(inCheck(board, true)).toBe(false);
    expect(legalTargets(board, from)).toContain(to);
    expect(isMate(applyMove(board, from, to), false)).toBe(true);
  });
});

describe("MATE1: each lesson group holds its theme", () => {
  const group = (g: number) => MATE1.slice(g * 5, g * 5 + 5);
  it("group 0 (L7, first mates): king + exactly one rook or queen", () => {
    for (const pz of group(0)) {
      expect(["R", "Q"], pz.name).toContain(whiteArmy(parseFEN(pz.fen).board));
    }
  });
  it("group 1 (L9, lawnmower): two heavy pieces and nothing else", () => {
    for (const pz of group(1)) {
      expect(["RR", "QR"], pz.name).toContain(whiteArmy(parseFEN(pz.fen).board));
    }
  });
  it("group 2 (L10, queen's box): king + queen only", () => {
    for (const pz of group(2)) {
      expect(whiteArmy(parseFEN(pz.fen).board), pz.name).toBe("Q");
    }
  });
  it("group 3 (L11, puzzle storm): every puzzle uses a knight or bishop", () => {
    for (const pz of group(3)) {
      const { board } = parseFEN(pz.fen);
      expect(count(board, "N") + count(board, "B"), pz.name).toBeGreaterThan(0);
    }
  });
  it("group 4 (L22): at least two puzzles involve a white pawn", () => {
    const withPawn = group(4).filter((pz) => count(parseFEN(pz.fen).board, "P") > 0);
    expect(withPawn.length).toBeGreaterThanOrEqual(2);
  });
  it("group 5 (L24, boss battle): black has five or more pieces", () => {
    for (const pz of group(5)) {
      expect(blackPieces(parseFEN(pz.fen).board), pz.name).toBeGreaterThanOrEqual(5);
    }
  });
  it("group 6 (L36, punish opening mistakes): opening-shaped, black has ten or more pieces", () => {
    for (const pz of group(6)) {
      expect(blackPieces(parseFEN(pz.fen).board), pz.name).toBeGreaterThanOrEqual(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Piece Detective — 32 cases in four lesson slices of eight (lessons 17, 21,
// 33, 46; lessons.test.ts pins the partition). Themes pinned by shape:
//   0-7   L17 "The Free-Stuff Detector": plain hanging pieces on quiet
//              boards — nine men at most, and white is NOT already winning.
//   8-15  L21 "Winning the Won Game": white is already up a rook or more.
//   16-23 L33 "Guard the Gate: Trap Defense": opening-shaped, black has 10+
//              pieces still on the board.
//   24-31 L46 "Candidate Moves": busy boards, 12+ pieces in total.
// ---------------------------------------------------------------------------
describe("HUNTS: exactly one hanging black piece, matching the answer", () => {
  it("has 32 cases", () => {
    expect(HUNTS).toHaveLength(32);
  });
  it.each(HUNTS.map((h, i) => [`${i + 1} · ${h.answer}`, h] as const))("hunt %s", (_a, h) => {
    const { board, whiteToMove } = parseFEN(h.fen);
    expect(whiteToMove).toBe(true);
    expectLegalPosition(board, h.answer);
    const hanging: string[] = [];
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (p === "" || isWhitePiece(p) || p === "k") continue;
      const attacked = isAttacked(board, i, true);
      const probe = board.slice();
      probe[i] = "P"; // stand-in white piece: can black recapture here?
      const defended = isAttacked(probe, i, false);
      if (attacked && !defended) hanging.push(sqName(i));
    }
    expect(hanging).toEqual([h.answer]);
    expect(inCheck(board, false)).toBe(false);
    expect(inCheck(board, true)).toBe(false);
  });
});

describe("HUNTS: each lesson slice holds its theme", () => {
  const slice = (g: number) => HUNTS.slice(g * 8, g * 8 + 8);
  it("slice 0 (L17, free-stuff detector): quiet boards, and white is NOT already winning", () => {
    // Both halves are chosen so a neighbouring slice would red here: slice 1
    // is defined by white being a rook up, slices 2 and 3 are the busy
    // opening / candidate-move boards (10+ black pieces, 12+ men).
    for (const h of slice(0)) {
      const { board } = parseFEN(h.fen);
      expect(menOnBoard(board), h.answer).toBeLessThanOrEqual(9);
      expect(material(board, true) - material(board, false), h.answer).toBeLessThan(5);
    }
  });
  it("slice 1 (L21, winning the won game): white is up a rook or more", () => {
    for (const h of slice(1)) {
      const { board } = parseFEN(h.fen);
      expect(material(board, true) - material(board, false), h.answer).toBeGreaterThanOrEqual(5);
    }
  });
  it("slice 2 (L33, trap defense): opening-shaped, black has ten or more pieces", () => {
    for (const h of slice(2)) {
      expect(blackPieces(parseFEN(h.fen).board), h.answer).toBeGreaterThanOrEqual(10);
    }
  });
  it("slice 3 (L46, candidate moves): busy boards, twelve or more pieces", () => {
    for (const h of slice(3)) {
      const { board } = parseFEN(h.fen);
      expect(board.filter((p) => p !== "").length, h.answer).toBeGreaterThanOrEqual(12);
    }
  });
});

const DETECTOR = {
  fork: isForkAfter,
  pin: isPinAfter,
  skewer: isSkewerAfter,
  disco: (b: string[], to: number) => isDiscoveredAfter(b, to, true),
} as const;

describe("TACTICS: every solution performs its named trick", () => {
  it("has all four packs of 6", () => {
    for (const pack of ["fork", "pin", "skewer", "disco"] as const) {
      expect(TACTICS[pack], pack).toHaveLength(6);
    }
  });
  for (const pack of ["fork", "pin", "skewer", "disco"] as const) {
    it.each(TACTICS[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (label, tc) => {
        const { board, whiteToMove } = parseFEN(tc.fen);
        expect(whiteToMove).toBe(true);
        expectLegalPosition(board, label);
        const { from, to } = mv(tc.solution);
        expect(inCheck(board, false)).toBe(false);
        expect(inCheck(board, true)).toBe(false);
        expect(legalTargets(board, from)).toContain(to);
        expect(DETECTOR[pack](applyMove(board, from, to), to)).toBe(true);
      },
    );
  }
});

// Mate-in-2 — 24 puzzles in four lesson slices of six (lessons 25, 26, 42,
// 48; lessons.test.ts pins the partition). All FOUR slices carry a shape
// assertion, and each one is chosen so a puzzle pasted in from a neighbouring
// slice reds:
//   0-5   L25 "Forcing Moves": heavy pieces only, black has nothing but his
//              king, four men at most.
//   6-11  L26 "The Back-Rank Story": its copy promises back-rank mates, so
//              the black king is on rank 8 with two or more of his own pawns
//              walling him in on the rank in front.
//   12-17 L42 "Endgame Habits": five men at most, and no white queen.
//   18-23 L48 "Boss Battle": seven men or more, and white always brings a
//              knight or a bishop.
describe("MATE2: forced in exactly two, never one", () => {
  it("has 24 puzzles", () => {
    expect(MATE2).toHaveLength(24);
  });
  it.each(MATE2.map((p) => [p.name, p] as const))("%s", (_name, pz) => {
    const { board, whiteToMove } = parseFEN(pz.fen);
    expect(whiteToMove).toBe(true);
    expectLegalPosition(board, pz.name);
    const { from, to } = mv(pz.solution);
    expect(inCheck(board, false)).toBe(false);
    expect(inCheck(board, true)).toBe(false);
    expect(hasMateIn1(board, true)).toBe(false); // no hidden mate-in-1 (caught 2 bad puzzles before)
    expect(legalTargets(board, from)).toContain(to);
    expect(isMateIn2After(board, from, to)).toBe(true);
  });
  it("slice 0 (L25, forcing moves): bare heavy-piece chains — black has only his king", () => {
    // Every neighbouring slice reds on one of these: slice 1's back-rankers
    // give black his wall of pawns, slice 2 has pawns and a bishop of its
    // own, slice 3 hands black a rook and a knight on a nine-man board.
    for (const pz of MATE2.slice(0, 6)) {
      const { board } = parseFEN(pz.fen);
      expect(whiteArmy(board).replace(/[QR]/g, ""), pz.name).toBe("");
      expect(blackPieces(board), pz.name).toBe(1);
      expect(menOnBoard(board), pz.name).toBeLessThanOrEqual(4);
    }
  });
  it("slice 1 (L26, the back-rank story): black king on rank 8 behind two or more of his pawns", () => {
    for (const pz of MATE2.slice(6, 12)) {
      const { board } = parseFEN(pz.fen);
      const k = board.indexOf("k");
      expect(rankRow(k), pz.name).toBe(0);
      const pawnsInFront = board.filter((p, i) => p === "p" && rankRow(i) === 1).length;
      expect(pawnsInFront, pz.name).toBeGreaterThanOrEqual(2);
    }
  });
  it("slice 2 (L42, endgame habits): five men at most, and no white queen", () => {
    // The five-man ceiling is what a neighbour fails: slice 1's back-rankers
    // are eight to ten men, slice 3's boss battles seven to nine. The
    // no-queen half additionally reds four of slice 0's six.
    for (const pz of MATE2.slice(12, 18)) {
      const { board } = parseFEN(pz.fen);
      expect(menOnBoard(board), pz.name).toBeLessThanOrEqual(5);
      expect(count(board, "Q"), pz.name).toBe(0);
    }
  });
  it("slice 3 (L48, boss battle): busy boards, and white always brings a minor piece", () => {
    // Slice 2 fails the seven-man floor; five of slice 1's six back-rankers
    // and every one of slice 0's are heavy pieces only, so they fail the
    // knight-or-bishop half.
    for (const pz of MATE2.slice(18, 24)) {
      const { board } = parseFEN(pz.fen);
      expect(menOnBoard(board), pz.name).toBeGreaterThanOrEqual(7);
      expect(count(board, "N") + count(board, "B"), pz.name).toBeGreaterThan(0);
    }
  });
});

const DETECTOR2 = {
  fork2: isForkAfter,
  pin2: isPinAfter,
  skewer2: isSkewerAfter,
  disco2: (b: string[], to: number) => isDiscoveredAfter(b, to, true),
} as const;

describe("TACTICS2: tier-2 packs", () => {
  it("has all four packs of 5", () => {
    for (const pack of ["fork2", "pin2", "skewer2", "disco2"] as const) {
      expect(TACTICS2[pack], pack).toHaveLength(5);
    }
  });
  for (const pack of ["fork2", "pin2", "skewer2", "disco2"] as const) {
    it.each(TACTICS2[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (label, tc) => {
        const { board, whiteToMove } = parseFEN(tc.fen);
        expect(whiteToMove).toBe(true);
        expectLegalPosition(board, label);
        const { from, to } = mv(tc.solution);
        expect(inCheck(board, false)).toBe(false);
        expect(inCheck(board, true)).toBe(false);
        expect(legalTargets(board, from)).toContain(to);
        expect(DETECTOR2[pack](applyMove(board, from, to), to)).toBe(true);
      },
    );
  }
});

// Mate-in-3 pack (Track 4). MATE3 is authored in three groups of three, in
// order: Queen + King (0-2), Single Rook (3-5), Double Rook (6-8). Every
// entry is machine-verified forced in exactly three white moves against
// every black defence — never one, never two — via isMateInNAfter/hasMateInN
// (engine/mate.ts), and each group is checked to actually hold its named
// material so a FEN pasted into the wrong group fails loudly.
describe("MATE3: forced in exactly three, never fewer", () => {
  it("has 9 puzzles", () => {
    expect(MATE3).toHaveLength(9);
  });
  it.each(MATE3.map((p) => [p.name, p] as const))("%s", (_name, pz) => {
    const { board, whiteToMove } = parseFEN(pz.fen);
    expect(whiteToMove).toBe(true);
    expectLegalPosition(board, pz.name);
    expect(inCheck(board, false)).toBe(false);
    expect(inCheck(board, true)).toBe(false);
    expect(isStalemate(board, false)).toBe(false);
    expect(board.filter((p) => p !== "").length).toBeLessThanOrEqual(8);
    const { from, to } = mv(pz.solution);
    expect(legalTargets(board, from)).toContain(to);
    // Not shorter: no hidden mate-in-1, no hidden mate-in-2 either.
    expect(hasMateIn1(board, true)).toBe(false);
    expect(hasMateInN(board, true, 2)).toBe(false);
    // Forced in exactly three, against every black reply.
    expect(isMateInNAfter(board, from, to, 3)).toBe(true);
  });
});

describe("MATE3: each group holds its named material", () => {
  it("group 1 (Queen + King): a lone white queen", () => {
    for (const pz of MATE3.slice(0, 3)) {
      const { board } = parseFEN(pz.fen);
      expect(board.filter((p) => p === "Q"), pz.name).toHaveLength(1);
      expect(board.filter((p) => p === "R"), pz.name).toHaveLength(0);
    }
  });
  it("group 2 (Single Rook): exactly one white rook, no queen", () => {
    for (const pz of MATE3.slice(3, 6)) {
      const { board } = parseFEN(pz.fen);
      expect(board.filter((p) => p === "R"), pz.name).toHaveLength(1);
      expect(board.filter((p) => p === "Q"), pz.name).toHaveLength(0);
    }
  });
  it("group 3 (Double Rook): exactly two white rooks, no queen", () => {
    for (const pz of MATE3.slice(6, 9)) {
      const { board } = parseFEN(pz.fen);
      expect(board.filter((p) => p === "R"), pz.name).toHaveLength(2);
      expect(board.filter((p) => p === "Q"), pz.name).toHaveLength(0);
    }
  });
});

// Gain-judged packs (tiers 3, 4 and 5): these motifs have no single
// structural detector the way fork/pin/skewer/disco do, so verification is
// by outcome instead: playing the solution against black's best defense must
// win >= 3 points of material (or force mate — tacticGainAfter returns a
// dominating sentinel for that), and no other legal first move may do as
// well or better.
function expectGainJudged(tc: { fen: string; solution: string }, maxPieces: number, label = "") {
  const { board, whiteToMove } = parseFEN(tc.fen);
  expect(whiteToMove).toBe(true);
  expectLegalPosition(board, label || tc.solution);
  expect(inCheck(board, false)).toBe(false);
  expect(inCheck(board, true)).toBe(false);
  expect(board.filter((p) => p !== "").length).toBeLessThanOrEqual(maxPieces);
  const { from, to } = mv(tc.solution);
  expect(legalTargets(board, from)).toContain(to);
  const gain = tacticGainAfter(board, from, to);
  expect(gain).toBeGreaterThanOrEqual(3);
  for (const m of allLegalMoves(board, true)) {
    if (m.from === from && m.to === to) continue;
    expect(tacticGainAfter(board, m.from, m.to), `${sqName(m.from)}${sqName(m.to)}`).toBeLessThan(gain);
  }
}

// Tier-3 Trick Shots (Track 4): deflection, decoy, remove-the-defender,
// interference — defended targets, so the motif has to be set up.
describe("TACTICS3: tier-3 packs (defended targets — the motif has to be set up)", () => {
  it("has all four packs of 4", () => {
    for (const pack of ["deflection", "decoy", "removeDefender", "interference"] as const) {
      expect(TACTICS3[pack], pack).toHaveLength(4);
    }
  });
  for (const pack of ["deflection", "decoy", "removeDefender", "interference"] as const) {
    it.each(TACTICS3[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (label, tc) => expectGainJudged(tc, 12, label),
    );
  }
});

// Tier-4 Trick Shots: double check, back-rank mate, trapped piece, pawn
// fork. No castling/en passant/under-promotion anywhere in this pack
// (engine/board.ts does not model them): back-rank kings are placed
// directly, pawn forks never depend on en passant.
describe("TACTICS4: tier-4 packs (double check / back-rank / trapped piece / pawn fork)", () => {
  it("has all four packs of 4", () => {
    for (const pack of ["doubleCheck", "backRank", "trappedPiece", "pawnFork"] as const) {
      expect(TACTICS4[pack], pack).toHaveLength(4);
    }
  });
  for (const pack of ["doubleCheck", "backRank", "trappedPiece", "pawnFork"] as const) {
    it.each(TACTICS4[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (label, tc) => expectGainJudged(tc, 8, label),
    );
  }
});

// Tier-5 Trick Shots: "Win a Piece", the mixed pack — the motif is not
// named, so it is verified purely by outcome. Richer boards are allowed
// (up to 14 pieces) because a real-game look is the point: the learner has
// to find the trick among ordinary pieces, not read it off an empty board.
describe("TACTICS5: the mixed Win a Piece pack", () => {
  it("has 8 cases", () => {
    expect(TACTICS5.winPiece).toHaveLength(8);
  });
  it.each(TACTICS5.winPiece.map((tc, i) => [`winPiece ${i + 1}`, tc] as const))(
    "%s",
    (label, tc) => expectGainJudged(tc, 14, label),
  );
  it("is genuinely mixed: not every case is the same motif", () => {
    // A cheap witness of variety: the solutions cannot ALL be immediate
    // captures, and cannot ALL be quiet moves.
    const captures = TACTICS5.winPiece.filter((tc) => {
      const { board } = parseFEN(tc.fen);
      return board[mv(tc.solution).to] !== "";
    }).length;
    expect(captures).toBeGreaterThan(0);
    expect(captures).toBeLessThan(TACTICS5.winPiece.length);
  });
});

// ---------------------------------------------------------------------------
// No puzzle appears twice anywhere. "The same puzzle" is the same board with
// the same side to move, whatever pack it sits in and whatever it is called —
// a learner who meets a position in lesson 9 must not meet it again in
// lesson 24 or in a Trick Shots pack.
// ---------------------------------------------------------------------------
describe("no position is shared between any two puzzles, across every pack", () => {
  it("every FEN (board + side to move) is unique", () => {
    const all: { where: string; fen: string }[] = [];
    MATE1.forEach((p, i) => all.push({ where: `MATE1[${i}] ${p.name}`, fen: p.fen }));
    MATE2.forEach((p, i) => all.push({ where: `MATE2[${i}] ${p.name}`, fen: p.fen }));
    MATE3.forEach((p, i) => all.push({ where: `MATE3[${i}] ${p.name}`, fen: p.fen }));
    HUNTS.forEach((p, i) => all.push({ where: `HUNTS[${i}]`, fen: p.fen }));
    for (const [family, packs] of [
      ["TACTICS", TACTICS],
      ["TACTICS2", TACTICS2],
      ["TACTICS3", TACTICS3],
      ["TACTICS4", TACTICS4],
      ["TACTICS5", TACTICS5],
    ] as const) {
      for (const [pack, cases] of Object.entries(packs)) {
        cases.forEach((tc, i) => all.push({ where: `${family}.${pack}[${i}]`, fen: tc.fen }));
      }
    }
    const seen = new Map<string, string>();
    for (const { where, fen } of all) {
      const key = fen.split(" ").slice(0, 2).join(" ");
      expect(seen.get(key), `${where} repeats ${seen.get(key)}`).toBeUndefined();
      seen.set(key, where);
    }
    expect(all.length).toBeGreaterThan(0);
  });
});
