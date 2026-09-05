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

// How far the capture-only search below looks. Four plies is enough for
// "I take, you take back, I take back, you take back" — the shape that
// separates winning a piece from swapping one.
const SWING_PLIES = 4;

const isKing = (p: Piece): boolean => p !== "" && p.toUpperCase() === "K";

// Quiescence: the material `side` can win from `board` by CAPTURES alone,
// `plies` deep, with either side free to stop capturing at any point (so it
// is never negative — nobody is obliged to walk into a losing exchange).
// This is the piece that gives the judge teeth: a "won" bishop whose
// capturer is taken straight back scores 3 - 3 = 0, not 3.
function captureSwing(board: Board, side: boolean, plies: number): number {
  if (plies <= 0) return 0;
  let best = 0; // stand pat: stop capturing here
  for (const m of allLegalMoves(board, side)) {
    const prey = board[m.to];
    if (prey === "" || isKing(prey)) continue;
    const net =
      pieceValue(prey) - captureSwing(applyMove(board, m.from, m.to), !side, plies - 1);
    if (net > best) best = net;
  }
  return best;
}

// Best result for `white` to move on `board`: a forced mate (MATE_GAIN), the
// sentinel's negative if white is already mated, else the capture swing.
//
// KNOWN GAP (state as of 2026-09-05, replacing the 2026-08-27 note).
//
// What the judge now SEES, and did not before: whether the capturing piece
// survives — captureSwing plays the recapture, and the re-recapture, four
// plies deep, so a bishop traded for the knight it took scores 0 rather than
// 3; and that a defence arriving WITH CHECK buys white no tempo, because
// forcedAnswer below plays out every legal answer and then hands black the
// move again. Between them these red five puzzles that shipped through a
// green suite (review 2026-09-05) and the pre-existing pawnFork trio, all of
// which the old raw-capture-value follow-up scored at exactly 3.
//
// What it still does NOT see, in both directions:
//   - Too generous: any QUIET refutation. Black's defence is one ply, so a
//     mate threat, a counter-pin, or a piece that simply walks away next move
//     is invisible; and after a non-checking defence white is assumed to have
//     a free tempo to guard whatever black threatens.
//   - Too harsh: a defence that checks and cannot be met by a capture zeroes
//     the whole follow-up, because forcedAnswer stops after black's reply to
//     the forced answer. A sound puzzle whose refutation attempt is a safe
//     spite check will therefore under-score. That is the safe direction for
//     a judge, but it is why some genuinely winning positions are unusable.
//
// The residue is a ceiling on gain-judged content, not a licence: positions
// still have to be played out by hand, or against an independent engine,
// before they ship. Every replacement in this wave was cross-checked against
// a separate negamax + quiescence search at five plies, and that check caught
// two candidates this judge had already passed.
function bestFollowUp(board: Board, white: boolean): number {
  const moves = allLegalMoves(board, white);
  if (moves.length === 0) return isMate(board, white) ? -MATE_GAIN : 0;
  for (const m of moves) {
    if (isMate(applyMove(board, m.from, m.to), !white)) return MATE_GAIN;
  }
  return captureSwing(board, white, SWING_PLIES);
}

// Same question, for the case where the defence arrived with CHECK: white's
// answer is forced, so it buys no time to defend anything else. Every legal
// answer is played out and the opponent is handed the move again — this is
// what catches the zwischenzug ("check first, recapture second").
function forcedAnswer(board: Board, white: boolean): number {
  const moves = allLegalMoves(board, white);
  if (moves.length === 0) return isMate(board, white) ? -MATE_GAIN : 0;
  let best = -MATE_GAIN;
  for (const m of moves) {
    const prey = board[m.to];
    const won = prey === "" || isKing(prey) ? 0 : pieceValue(prey);
    const after = applyMove(board, m.from, m.to);
    if (isMate(after, !white)) return MATE_GAIN;
    const net = won - captureSwing(after, !white, SWING_PLIES - 1);
    if (net > best) best = net;
  }
  return best;
}

// Trick Shots tier-3 judge (deflection / decoy / remove-the-defender /
// interference — motifs with no single structural detector like fork/pin's).
// Plays from -> to, then black's best defense (the reply that minimizes
// white's net result), and returns white's material swing: what this move
// itself captures, minus what black's reply recaptures, plus what white can
// still win once the dust settles — or MATE_GAIN if mate is forced. A puzzle
// is sound when this is >= 3 for the solution and strictly less for every
// other legal first move (content/__tests__/puzzles.test.ts enforces both).
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
    // A defence that gives check leaves white no free move to spend.
    const followUp = inCheck(after, white)
      ? forcedAnswer(after, white)
      : bestFollowUp(after, white);
    let net: number;
    if (followUp >= MATE_GAIN) net = MATE_GAIN;
    else if (followUp <= -MATE_GAIN) net = -MATE_GAIN;
    else net = wins1 - losesToReply + followUp;
    if (net < worst) worst = net;
  }
  return worst;
}
