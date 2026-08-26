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
} from "../../engine";
import { MATE1, HUNTS, TACTICS, MATE2, TACTICS2, MATE3, TACTICS3 } from "../puzzles";

const mv = (sol: string) => ({ from: sqIdx(sol.slice(0, 2)), to: sqIdx(sol.slice(2, 4)) });

describe("MATE1: every solution is a legal mate-in-1", () => {
  it.each(MATE1.map((p) => [p.name, p] as const))("%s", (_name, pz) => {
    const { board } = parseFEN(pz.fen);
    const { from, to } = mv(pz.solution);
    expect(inCheck(board, false)).toBe(false); // black not already in check
    expect(legalTargets(board, from)).toContain(to);
    expect(isMate(applyMove(board, from, to), false)).toBe(true);
  });
});

describe("HUNTS: exactly one hanging black piece, matching the answer", () => {
  it.each(HUNTS.map((h) => [h.answer, h] as const))("hunt %s", (_a, h) => {
    const { board } = parseFEN(h.fen);
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

const DETECTOR = {
  fork: isForkAfter,
  pin: isPinAfter,
  skewer: isSkewerAfter,
  disco: (b: string[], to: number) => isDiscoveredAfter(b, to, true),
} as const;

describe("TACTICS: every solution performs its named trick", () => {
  for (const pack of ["fork", "pin", "skewer", "disco"] as const) {
    it.each(TACTICS[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (_label, tc) => {
        const { board } = parseFEN(tc.fen);
        const { from, to } = mv(tc.solution);
        expect(inCheck(board, false)).toBe(false);
        expect(inCheck(board, true)).toBe(false);
        expect(legalTargets(board, from)).toContain(to);
        expect(DETECTOR[pack](applyMove(board, from, to), to)).toBe(true);
      },
    );
  }
});

describe("MATE2: forced in exactly two, never one", () => {
  it("has 12 puzzles", () => {
    expect(MATE2).toHaveLength(12);
  });
  it.each(MATE2.map((p) => [p.name, p] as const))("%s", (_name, pz) => {
    const { board } = parseFEN(pz.fen);
    const { from, to } = mv(pz.solution);
    expect(inCheck(board, false)).toBe(false);
    expect(inCheck(board, true)).toBe(false);
    expect(hasMateIn1(board, true)).toBe(false); // no hidden mate-in-1 (caught 2 bad puzzles before)
    expect(legalTargets(board, from)).toContain(to);
    expect(isMateIn2After(board, from, to)).toBe(true);
  });
});

const DETECTOR2 = {
  fork2: isForkAfter,
  pin2: isPinAfter,
  skewer2: isSkewerAfter,
  disco2: (b: string[], to: number) => isDiscoveredAfter(b, to, true),
} as const;

describe("TACTICS2: tier-2 packs", () => {
  it("has all four packs of 3", () => {
    for (const pack of ["fork2", "pin2", "skewer2", "disco2"] as const) {
      expect(TACTICS2[pack]).toHaveLength(3);
    }
  });
  for (const pack of ["fork2", "pin2", "skewer2", "disco2"] as const) {
    it.each(TACTICS2[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (_label, tc) => {
        const { board } = parseFEN(tc.fen);
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

// Tier-3 Trick Shots (Track 4): deflection, decoy, remove-the-defender,
// interference. These motifs have no single structural detector the way
// fork/pin/skewer/disco do, so verification is by outcome instead: playing
// the solution against black's best defense must win >= 3 points of material
// (or force mate — tacticGainAfter returns a dominating sentinel for that),
// and no other legal first move may do as well or better.
describe("TACTICS3: tier-3 packs (defended targets — the motif has to be set up)", () => {
  it("has all four packs of 3", () => {
    for (const pack of ["deflection", "decoy", "removeDefender", "interference"] as const) {
      expect(TACTICS3[pack]).toHaveLength(3);
    }
  });
  for (const pack of ["deflection", "decoy", "removeDefender", "interference"] as const) {
    it.each(TACTICS3[pack].map((tc, i) => [`${pack} ${i + 1}`, tc] as const))(
      "%s",
      (_label, tc) => {
        const { board, whiteToMove } = parseFEN(tc.fen);
        expect(whiteToMove).toBe(true);
        expect(inCheck(board, false)).toBe(false);
        expect(inCheck(board, true)).toBe(false);
        const { from, to } = mv(tc.solution);
        expect(legalTargets(board, from)).toContain(to);
        const gain = tacticGainAfter(board, from, to);
        expect(gain).toBeGreaterThanOrEqual(3);
        for (const m of allLegalMoves(board, true)) {
          if (m.from === from && m.to === to) continue;
          expect(tacticGainAfter(board, m.from, m.to)).toBeLessThan(gain);
        }
      },
    );
  }
});
