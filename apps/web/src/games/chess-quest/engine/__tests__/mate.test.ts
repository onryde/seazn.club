import { describe, expect, it } from "vitest";
import { parseFEN, sqIdx } from "../board";
import { applyMove, legalTargets } from "../moves";
import {
  isMate,
  isStalemate,
  hasMateIn1,
  isMateIn2After,
  bestDefense,
  isMateInNAfter,
  hasMateInN,
} from "../mate";

const b = (fen: string) => parseFEN(fen).board;

describe("mate and stalemate", () => {
  it("back-rank mate detected", () => {
    const board = applyMove(b("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1"), sqIdx("e1"), sqIdx("e8"));
    expect(isMate(board, false)).toBe(true);
  });
  it("corner stalemate detected, and is not mate", () => {
    const board = b("k7/2Q5/1K6/8/8/8/8/8 b - - 0 1");
    expect(isStalemate(board, false)).toBe(true);
    expect(isMate(board, false)).toBe(false);
  });
});

describe("mate-in-2 verifier (ladder pattern)", () => {
  // Kh7 vs Ra6+Rb5: Rb7+ forces Kg8/Kh8, then Ra8#.
  const fen = "8/7k/R7/1R6/8/8/8/6K1 w - - 0 1";
  it("no mate-in-1 here", () => {
    expect(hasMateIn1(b(fen), true)).toBe(false);
  });
  it("Rb7+ is mate in 2; Rb6 is not", () => {
    expect(isMateIn2After(b(fen), sqIdx("b5"), sqIdx("b7"))).toBe(true);
    expect(isMateIn2After(b(fen), sqIdx("b5"), sqIdx("b6"))).toBe(false);
  });
  it("bestDefense returns a legal black king reply", () => {
    const afterCheck = applyMove(b(fen), sqIdx("b5"), sqIdx("b7"));
    const d = bestDefense(afterCheck);
    expect(d).not.toBeNull();
    expect(afterCheck[d!.from]).toBe("k");
    expect(legalTargets(afterCheck, d!.from)).toContain(d!.to);
  });
});

describe("mate-in-2 guardrails", () => {
  it("an immediate mate is not mate-in-2", () => {
    const board = b("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1");
    expect(hasMateIn1(board, true)).toBe(true);
    expect(isMateIn2After(board, sqIdx("e1"), sqIdx("e8"))).toBe(false);
  });
  it("bare kings force nothing", () => {
    const board = b("k7/8/8/8/8/8/8/K7 w - - 0 1");
    expect(hasMateIn1(board, true)).toBe(false);
    expect(isMateIn2After(board, sqIdx("a1"), sqIdx("a2"))).toBe(false);
  });
});

// isMateInNAfter/hasMateInN are a separate, independently-written generalisation
// (not a wrapper around isMateIn2After — that stays untouched above). Each case
// here checks the new functions directly against a position whose true mate
// distance is known ahead of time, rather than cross-checking one function
// against the other's output.
describe("isMateInNAfter / hasMateInN — general depth-N verifier", () => {
  it("n=1 matches the known mate-in-1 (back-rank ladder)", () => {
    const board = b("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1");
    expect(isMateInNAfter(board, sqIdx("e1"), sqIdx("e8"), 1)).toBe(true);
    expect(hasMateInN(board, true, 1)).toBe(true);
  });

  it("n=3 does not falsely accept an immediate mate as 'exactly 3'", () => {
    const board = b("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1");
    expect(isMateInNAfter(board, sqIdx("e1"), sqIdx("e8"), 3)).toBe(false);
  });

  it("n=2 matches the known ladder from the describe block above", () => {
    const board = b("8/7k/R7/1R6/8/8/8/6K1 w - - 0 1");
    expect(hasMateInN(board, true, 1)).toBe(false);
    expect(isMateInNAfter(board, sqIdx("b5"), sqIdx("b7"), 2)).toBe(true);
    expect(isMateInNAfter(board, sqIdx("b5"), sqIdx("b6"), 2)).toBe(false);
    expect(hasMateInN(board, true, 2)).toBe(true);
  });

  it("n=3: a genuine three-move forced mate (double-rook, king pushed one rank further than the n=2 ladder)", () => {
    // Kf6; Ra5 (cuts rank5), Rb1 (reaches rank6 with check); Kg1; a stray black
    // pawn on d3. Mate distance independently confirmed exactly 3 (never 1 or
    // 2) by a from-scratch minimax written only for authoring, not shipped —
    // this test exercises the real isMateInNAfter/hasMateInN directly.
    const board = b("8/8/5k2/R7/8/3p4/8/1R4K1 w - - 0 1");
    expect(hasMateIn1(board, true)).toBe(false);
    expect(hasMateInN(board, true, 2)).toBe(false);
    expect(isMateInNAfter(board, sqIdx("b1"), sqIdx("b6"), 3)).toBe(true);
    expect(hasMateInN(board, true, 3)).toBe(true);
  });

  it("bare kings force nothing at any depth", () => {
    const board = b("k7/8/8/8/8/8/8/K7 w - - 0 1");
    expect(hasMateInN(board, true, 1)).toBe(false);
    expect(hasMateInN(board, true, 2)).toBe(false);
    expect(hasMateInN(board, true, 3)).toBe(false);
  });
});
