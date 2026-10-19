import { Chess } from "chess.js";

/** Legal destinations from `from` that Lichess would require a promotion
 *  suffix for. Derived from chess.js's own move generation (BSD-2) rather
 *  than a rank comparison: a rook landing on the eighth is not a promotion,
 *  and a rank-only check cannot tell the difference. chessground ships no
 *  promotion UI (design §2), so this is our decision to open the picker;
 *  the board must send the suffix — the server refuses a suffixless
 *  promotion as INVALID_UCI rather than auto-queening it. */
export function promotionSquares(fen: string, from: string): string[] {
  const game = new Chess(fen);
  const squares = game
    .moves({ verbose: true })
    .filter((m) => m.from === from && m.promotion !== undefined)
    .map((m) => m.to as string);
  // chess.js lists one move per promotion piece; one square each.
  return [...new Set(squares)];
}

export function needsPromotion(fen: string, from: string, to: string): boolean {
  return promotionSquares(fen, from).includes(to);
}

/** The four pieces the picker offers, in the canvas's order (Queen first,
 *  pre-selected styling). UCI suffix letters. */
export const PROMOTION_PIECES = ["q", "r", "b", "n"] as const;
export type PromotionPiece = (typeof PROMOTION_PIECES)[number];
