// The replay of a game's UCI moves into a position, for every reader — the room, the public fixture document, the
// reconcile. A LEAF: chess.js and nothing of this app, so the public read path loads no database client and no
// write-side usecase (T17 fix round 5, I2: `external-play-read.ts` once took `fenAfter` from `usecases/external-play/
// play.ts`, whose graph reaches `org-posts.ts`'s module-load `sql`). `no-import-cycle.test.ts` pins the leaf.
import { Chess } from "chess.js";

/** The board after `moves`, as far as chess.js can follow them, and how
 *  many it applied. An empty list is chess.js's own start position. */
export function replay(moves: readonly string[]): { board: Chess; replayed: number } {
  const board = new Chess();
  let replayed = 0;
  for (const uci of moves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    try {
      board.move(promotion === undefined ? { from, to } : { from, to, promotion });
    } catch {
      break;
    }
    replayed++;
  }
  return { board, replayed };
}

/** Replay a UCI list into a FEN. chess.js (BSD-2) is a RENDERER here, never
 *  an arbiter: Lichess decides legality (spec §1), so a move it accepted and
 *  chess.js rejects stops the replay and leaves the caller to reconcile —
 *  it must not refuse the player's move. Throws nothing. */
export function fenAfter(moves: readonly string[]): { fen: string; replayed: number; san: string[] } {
  const { board, replayed } = replay(moves);
  // The replayed plies in standard notation — the spectators' move list (T16 fix round 1, I4).
  return { fen: board.fen(), replayed, san: board.history() };
}
