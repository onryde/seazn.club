import { describe, expect, it } from "vitest";
import { parseFEN, sqIdx, sqName } from "../board";
import { applyMove } from "../moves";
import {
  pieceValue,
  isForkAfter,
  isPinAfter,
  isSkewerAfter,
  isDiscoveredAfter,
  attackersOf,
  defendersOf,
  tacticGainAfter,
} from "../tactics";

const b = (fen: string) => parseFEN(fen).board;
const names = (idxs: number[]) => idxs.map(sqName).sort();

describe("piece values", () => {
  it("standard values, case-insensitive, empty is 0", () => {
    expect(pieceValue("Q")).toBe(9);
    expect(pieceValue("n")).toBe(3);
    expect(pieceValue("")).toBe(0);
  });
});

describe("detectors", () => {
  it("royal knight fork detected (knight on c7 hits king a8 and rook e8)", () => {
    const board = applyMove(b("k3r3/8/2N5/8/8/8/8/6K1 w - - 0 1"), sqIdx("c6"), sqIdx("c7"));
    expect(isForkAfter(board, sqIdx("c7"))).toBe(true);
  });
  it("pin detected: rook pins knight to the king behind it", () => {
    // From e1 up the e-file: knight e5 in front, king e8 hides behind → pin.
    const board = b("4k3/8/8/4n3/8/8/8/4R1K1 w - - 0 1");
    expect(isPinAfter(board, sqIdx("e1"))).toBe(true);
  });
  it("skewer detected: king in front must run, queen behind falls", () => {
    // From e1 up the e-file: king e6 in front, queen e8 behind → skewer.
    const board = b("4q3/8/4k3/8/8/8/8/4R1K1 b - - 0 1");
    expect(isSkewerAfter(board, sqIdx("e1"))).toBe(true);
  });
  it("discovered check: the mover is not the checker", () => {
    // Bishop moves off the e-file, Re1 behind gives the check
    const start = b("4k3/8/8/8/4B3/8/8/4R1K1 w - - 0 1");
    const after = applyMove(start, sqIdx("e4"), sqIdx("c6"));
    expect(isDiscoveredAfter(after, sqIdx("c6"), true)).toBe(true);
  });
});

describe("coach helpers (attackers and bodyguards)", () => {
  // black bishop e7 attacked by Re1; knight a6 guarded by pawn b7
  const board = b("6k1/1p2bppp/n7/8/8/8/8/4R1K1 w - - 0 1");
  it("attackersOf finds the rook", () => {
    expect(names(attackersOf(board, sqIdx("e7"), true))).toEqual(["e1"]);
  });
  it("bishop e7 has no bodyguards", () => {
    expect(defendersOf(board, sqIdx("e7"))).toHaveLength(0);
  });
  it("knight a6 guarded by the b7 pawn", () => {
    expect(names(defendersOf(board, sqIdx("a6")))).toEqual(["b7"]);
  });
});

// ---------------------------------------------------------------------------
// tacticGainAfter is the ONLY verifier the gain-judged packs have
// (content/__tests__/puzzles.test.ts calls it for TACTICS3/4/5), so the data
// and its judge used to share one blind spot: the follow-up capture counted
// the captured piece's raw value and never asked whether the capturing piece
// survived. Five puzzles shipped through a green suite scoring exactly 3 on
// lines that win nothing (review 2026-09-05, cross-checked against an
// independent negamax + quiescence). These cases pin the fix; the exact
// expected numbers are pinned too, not just "< 3", so a drift shows up as a
// diff instead of hiding inside the inequality.
// ---------------------------------------------------------------------------
const gain = (fen: string, move: string) => {
  const { board } = parseFEN(fen);
  return tacticGainAfter(board, sqIdx(move.slice(0, 2)), sqIdx(move.slice(2, 4)));
};

const REFUTED: [string, string, string, number][] = [
  [
    "back-rank check the knight blocks on a square its own king defends (1.Ra8+ Nf8!)",
    "6k1/3n1ppp/8/8/8/8/8/R5K1 w - - 0 1",
    "a1a8",
    0,
  ],
  [
    "trapped-knight push whose flight square its own pawn defends (1.g4 Nf6!)",
    "6k1/6p1/8/3N3n/8/4B3/6PK/8 w - - 0 1",
    "g2g4",
    0,
  ],
  [
    "trapped-knight push whose flight square its own king defends (1.g4 Ng7!)",
    "r5k1/pp5p/5p1B/7n/8/4P3/5PPP/6K1 w - - 0 1",
    "g2g4",
    0,
  ],
  [
    "a won knight handed back by an in-between check (1.Bxd7 Bxf2+! 2.Kxf2 Rxd7)",
    "3r2k1/3n1ppp/1b6/8/6B1/8/5PPP/1R4K1 w - - 0 1",
    "g4d7",
    2,
  ],
  [
    "a zwischenzug check that walks the target off the board first (1.Nxe5 Bc5+!)",
    "5b1k/6pp/5p2/4r3/2N5/8/8/5RK1 w - - 0 1",
    "c4e5",
    2,
  ],
];

const SOUND: [string, string, string, number][] = [
  [
    "a stranded knight nobody defends is really worth three",
    "k7/8/8/n7/8/2B5/8/6K1 w - - 0 1",
    "c3a5",
    3,
  ],
  [
    "a queen won for a bishop that bites back is really worth six",
    "7k/2b5/1q6/3N4/8/8/8/7K w - - 0 1",
    "d5b6",
    6,
  ],
  [
    "a forced mate still outranks every capture",
    "r5k1/5ppp/8/8/8/8/1R6/1Q4K1 w - - 0 1",
    "b2b8",
    1000,
  ],
];

describe("tacticGainAfter: the capturing piece has to survive", () => {
  it.each(REFUTED.map((r) => [r[0], r] as const))("%s", (_label, [, fen, move, expected]) => {
    expect(gain(fen, move)).toBe(expected);
    expect(gain(fen, move)).toBeLessThan(3); // the bar puzzles.test.ts enforces
  });

  it.each(SOUND.map((r) => [r[0], r] as const))("%s", (_label, [, fen, move, expected]) => {
    expect(gain(fen, move)).toBe(expected);
    expect(gain(fen, move)).toBeGreaterThanOrEqual(3);
  });

  it("one square decides it: the same trapped-knight push, king on g8 vs off it", () => {
    // Identical motif, identical solution, one black king moved. With the
    // king on g8 the knight's last flight square (g7) is defended and the
    // push wins nothing; with the king on b8 it is loose and the push wins a
    // piece. A judge that cannot tell these apart scores both the same.
    const defended = "r5k1/pp5p/5p1B/7n/8/4P3/5PPP/6K1 w - - 0 1";
    const loose = "1k5r/pp5p/5p1B/7n/8/4P3/5PPP/7K w - - 0 1";
    expect(gain(defended, "g2g4")).toBe(0);
    expect(gain(loose, "g2g4")).toBe(3);
  });
});
