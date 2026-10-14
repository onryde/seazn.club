import { describe, expect, it } from "vitest";
import { needsPromotion, promotionSquares } from "../promotion";

const WHITE_SEVENTH = "8/PPPPPPPP/8/8/8/8/8/K6k w - - 0 1";
const BLACK_SECOND = "K6k/8/8/8/8/8/pppppppp/8 b - - 0 1";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

describe("needsPromotion", () => {
  it("every white pawn on the seventh promoting to the eighth needs a piece", () => {
    let checked = 0;
    for (const f of FILES) {
      expect(needsPromotion(WHITE_SEVENTH, `${f}7`, `${f}8`), `${f}7${f}8`).toBe(true);
      checked += 1;
    }
    expect(checked, "anti-vacuity: white files checked").toBe(8);
  });

  it("every black pawn on the second promoting to the first needs a piece", () => {
    let checked = 0;
    for (const f of FILES) {
      expect(needsPromotion(BLACK_SECOND, `${f}2`, `${f}1`), `${f}2${f}1`).toBe(true);
      checked += 1;
    }
    expect(checked, "anti-vacuity: black files checked").toBe(8);
  });

  it("a capture that promotes needs a piece too (the diagonal, not only the push)", () => {
    // White pawn e7, black rook d8: exd8 is a promotion; e8 is also open.
    const fen = "3r4/4P3/8/8/8/8/8/K6k w - - 0 1";
    expect(needsPromotion(fen, "e7", "d8")).toBe(true);
    expect(promotionSquares(fen, "e7").sort()).toEqual(["d8", "e8"]);
  });

  it("a pawn move that is not to the last rank does not", () => {
    expect(needsPromotion("8/8/8/8/8/8/PPPPPPPP/K6k w - - 0 1", "e2", "e4")).toBe(false);
  });

  it("a NON-pawn arriving on the last rank does not — this is the mutant a rank-only check survives", () => {
    expect(needsPromotion("8/4R3/8/8/8/8/8/K6k w - - 0 1", "e7", "e8")).toBe(false);
  });

  it("promotionSquares lists the destinations a given pawn can promote onto, and is EMPTY for a piece that cannot", () => {
    expect(promotionSquares(WHITE_SEVENTH, "e7").sort()).toEqual(["e8"]);
    expect(promotionSquares("8/8/8/8/8/8/PPPPPPPP/K6k w - - 0 1", "e2")).toEqual([]);
  });

  it("a promotion square for the side NOT to move is not offered (it is not that player's move)", () => {
    // White pawn on e7 but Black to move.
    expect(needsPromotion("7k/4P3/8/8/8/8/8/K7 b - - 0 1", "e7", "e8")).toBe(false);
  });
});
