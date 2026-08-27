// Game-ending detection and the mate-in-2 verifier used to machine-check
// the puzzle packs (and to judge moves in the Mate in 2 game).
import { Board, Move, isWhitePiece } from "./board";
import { allLegalMoves, applyMove, inCheck } from "./moves";

export function isMate(board: Board, white: boolean): boolean {
  return inCheck(board, white) && allLegalMoves(board, white).length === 0;
}

export function isStalemate(board: Board, white: boolean): boolean {
  return !inCheck(board, white) && allLegalMoves(board, white).length === 0;
}

export function hasMateIn1(board: Board, white: boolean): boolean {
  for (const m of allLegalMoves(board, white)) {
    if (isMate(applyMove(board, m.from, m.to), !white)) return true;
  }
  return false;
}

// Forced mate in exactly two: after this move the enemy is NOT yet mated,
// still has replies, and every one of them leaves us a mate-in-1.
export function isMateIn2After(board: Board, from: number, to: number): boolean {
  const white = isWhitePiece(board[from]);
  const b1 = applyMove(board, from, to);
  if (inCheck(b1, white)) return false;
  if (isMate(b1, !white)) return false;
  const replies = allLegalMoves(b1, !white);
  if (replies.length === 0) return false; // stalemate
  for (const r of replies) {
    if (!hasMateIn1(applyMove(b1, r.from, r.to), white)) return false;
  }
  return true;
}

// Forced mate in exactly n: after this move the enemy is not yet mated
// (n === 1 is the immediate-mate case), and — for n > 1 — every reply the
// enemy could make still leaves the mover a forced mate in exactly n-1.
// Generalises isMateIn2After (n===2 matches its shape exactly), which stays
// untouched and independently implemented below — this is new code, not a
// wrapper around it.
export function isMateInNAfter(board: Board, from: number, to: number, n: number): boolean {
  const white = isWhitePiece(board[from]);
  const b1 = applyMove(board, from, to);
  if (inCheck(b1, white)) return false; // illegal: own king left in check
  if (n === 1) return isMate(b1, !white);
  if (isMate(b1, !white)) return false; // faster than intended: not "exactly n"
  const replies = allLegalMoves(b1, !white);
  if (replies.length === 0) return false; // stalemate, not a mate
  for (const r of replies) {
    if (!hasMateInN(applyMove(b1, r.from, r.to), white, n - 1)) return false;
  }
  return true;
}

export function hasMateInN(board: Board, white: boolean, n: number): boolean {
  if (n === 1) return hasMateIn1(board, white);
  for (const m of allLegalMoves(board, white)) {
    if (isMateInNAfter(board, m.from, m.to, n)) return true;
  }
  return false;
}

// Black's toughest reply: the one leaving white the fewest mating moves.
export function bestDefense(board: Board): Move | null {
  let best: Move | null = null;
  let fewest = Infinity;
  for (const r of allLegalMoves(board, false)) {
    const after = applyMove(board, r.from, r.to);
    let mates = 0;
    for (const m of allLegalMoves(after, true)) {
      if (isMate(applyMove(after, m.from, m.to), false)) mates++;
    }
    if (mates < fewest) {
      fewest = mates;
      best = r;
    }
  }
  return best;
}
