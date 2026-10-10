import "server-only";
import { Chess } from "chess.js";

/** Replay a UCI list into a FEN. chess.js (BSD-2) is a RENDERER here, never
 *  an arbiter: Lichess decides legality (spec §1), so a move it accepted and
 *  chess.js rejects stops the replay and leaves the caller to reconcile —
 *  it must not refuse the player's move. Throws nothing. */
export function fenAfter(moves: readonly string[]): { fen: string; replayed: number } {
  const board = new Chess();
  let replayed = 0;
  for (const uci of moves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    try {
      board.move(promotion === undefined ? { from, to } : { from, to, promotion });
    } catch {
      return { fen: board.fen(), replayed };
    }
    replayed++;
  }
  // An empty list is chess.js's own start position — no special case.
  return { fen: board.fen(), replayed };
}
