// Tactic detectors (Trick Shots / Tactic Trainer judging) and the coach's
// attacker/defender helpers.
import { Board, isWhitePiece, Piece } from "./board";
import { allLegalMoves, applyMove, attackSquares, findKing, inCheck, isAttacked, sliderDirs, step } from "./moves";
import { isMate } from "./mate";

const VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 100 };

export function pieceValue(p: Piece): number {
  return VALUE[p.toUpperCase()] ?? 0;
}

// Fork: the piece that just landed on `to` attacks 2+ enemy non-pawn pieces
// (king counts) and stands on a square no enemy piece attacks.
export function isForkAfter(board: Board, to: number): boolean {
  const p = board[to];
  if (p === "") return false;
  const white = isWhitePiece(p);
  const targets = attackSquares(board, to).filter(
    (t) => board[t] !== "" && isWhitePiece(board[t]) !== white && board[t].toUpperCase() !== "P",
  );
  return targets.length >= 2 && !isAttacked(board, to, !white);
}

// Walk each ray of the slider on `sq`; report the first two enemy pieces
// stacked on one ray as {front, back}.
function rayPairs(board: Board, sq: number): { front: number; back: number }[] {
  const p = board[sq];
  const type = p.toUpperCase();
  if (type !== "B" && type !== "R" && type !== "Q") return [];
  const white = isWhitePiece(p);
  const pairs: { front: number; back: number }[] = [];
  for (const [df, dr] of sliderDirs(type)) {
    let t = step(sq, df, dr);
    let front = -1;
    while (t >= 0) {
      if (board[t] !== "") {
        if (isWhitePiece(board[t]) === white) break;
        if (front < 0) {
          front = t;
        } else {
          pairs.push({ front, back: t });
          break;
        }
      }
      t = step(t, df, dr);
    }
  }
  return pairs;
}

// Pin: enemy piece in front is stuck because something bigger (or the king)
// hides behind it. Skewer: the big one is in front and must run.
export function isPinAfter(board: Board, to: number): boolean {
  return rayPairs(board, to).some(
    ({ front, back }) =>
      board[back].toUpperCase() === "K" || pieceValue(board[back]) > pieceValue(board[front]),
  );
}

export function isSkewerAfter(board: Board, to: number): boolean {
  return rayPairs(board, to).some(
    ({ front, back }) =>
      board[front].toUpperCase() === "K" || pieceValue(board[front]) > pieceValue(board[back]),
  );
}

// Discovered attack: after the move, the enemy king is in check from a piece
// OTHER than the one that just moved.
export function isDiscoveredAfter(board: Board, to: number, white: boolean): boolean {
  const k = findKing(board, !white);
  if (k < 0 || !inCheck(board, !white)) return false;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (i !== to && p !== "" && isWhitePiece(p) === white && attackSquares(board, i).includes(k))
      return true;
  }
  return false;
}

// Which pieces of `byWhite` attack this square? (the coach uses these)
export function attackersOf(board: Board, sq: number, byWhite: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p !== "" && isWhitePiece(p) === byWhite && attackSquares(board, i).includes(sq)) out.push(i);
  }
  return out;
}

// Which friends could recapture on this piece's square? (its bodyguards)
export function defendersOf(board: Board, sq: number): number[] {
  const p = board[sq];
  if (p === "") return [];
  const white = isWhitePiece(p);
  const probe = board.slice();
  probe[sq] = white ? "p" : "P"; // stand-in enemy piece
  return attackersOf(probe, sq, white);
}

// Sentinel dominating any material total, so a forced mate always outranks
// a merely-large capture when comparing candidate first moves.
const MATE_GAIN = 1000;

// Best immediate result for the side to move on `board`: a forced mate
// (MATE_GAIN) if one exists, else the most valuable capture on offer, else 0.
function bestFollowUp(board: Board, white: boolean): number {
  for (const m of allLegalMoves(board, white)) {
    if (isMate(applyMove(board, m.from, m.to), !white)) return MATE_GAIN;
  }
  let best = 0;
  for (const m of allLegalMoves(board, white)) {
    if (board[m.to] === "") continue;
    const v = pieceValue(board[m.to]);
    if (v > best) best = v;
  }
  return best;
}

// Trick Shots tier-3 judge (deflection / decoy / remove-the-defender /
// interference — motifs with no single structural detector like fork/pin's).
// Plays from -> to, then black's best defense (the reply that minimizes
// white's net result), and returns white's material swing: what this move
// itself captures, minus what black's reply recaptures, plus white's best
// follow-up next move — or MATE_GAIN if mate is forced. A puzzle is sound
// when this is >= 3 for the solution and strictly less for every other
// legal first move (content/__tests__/puzzles.test.ts enforces both).
export function tacticGainAfter(board: Board, from: number, to: number): number {
  const white = isWhitePiece(board[from]);
  const wins1 = board[to] !== "" ? pieceValue(board[to]) : 0;
  const b1 = applyMove(board, from, to);
  if (isMate(b1, !white)) return MATE_GAIN; // the move itself mates
  const replies = allLegalMoves(b1, !white);
  if (replies.length === 0) return 0; // stalemate — never a real puzzle
  let worst = Infinity;
  for (const r of replies) {
    const losesToReply = b1[r.to] !== "" ? pieceValue(b1[r.to]) : 0;
    const after = applyMove(b1, r.from, r.to);
    const followUp = bestFollowUp(after, white);
    const net = followUp >= MATE_GAIN ? MATE_GAIN : wins1 - losesToReply + followUp;
    if (net < worst) worst = net;
  }
  return worst;
}
