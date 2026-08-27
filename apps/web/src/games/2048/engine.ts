// 2048 engine -- pure functions only (no DOM, no localStorage; state.ts owns
// persistence and interaction reducers, index.tsx is the thin DOM glue --
// same three-way split as Daily Word's engine.ts/state.ts/index.tsx). The
// board is a plain SIZE x SIZE number array (0 = empty), never a tile-object
// model with per-tile identity -- see this file's header comment on
// `slide` for what that does and doesn't buy us animation-wise.
export const SIZE = 4;

export type Board2048 = number[][];
export type Direction = "up" | "down" | "left" | "right";

/** A fresh SIZE x SIZE grid of zeros -- the "nothing placed yet" board. */
export function emptyBoard(): Board2048 {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

/**
 * True only for a board with zero non-zero cells. This state is otherwise
 * UNREACHABLE through real gameplay (a merge always leaves exactly one tile
 * behind, so the on-board tile count only ever grows or holds steady net of
 * a spawn each move) -- it exists solely as the "never initialized yet"
 * sentinel state.ts's INITIAL_STATE uses, so index.tsx's mount effect can
 * detect it and spawn the real opening two tiles itself. See
 * state.ts's header for why that correction can't live in `migrate` (the
 * exact trap Daily Word's lastPlayedDate sentinel hit).
 */
export function isEmptyBoard(board: Board2048): boolean {
  return board.every((row) => row.every((cell) => cell === 0));
}

function boardsEqual(a: Board2048, b: Board2048): boolean {
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

/**
 * Compacts + merges one line (a row or column, already oriented so "toward
 * the start of this array" is the direction of travel) exactly once:
 * remove zeros, then walk left to right merging each tile with the NEXT one
 * only if they're equal -- and only once, by jumping the scan pointer past
 * both tiles the moment a merge happens. This single "jump past both on a
 * merge" rule is what makes `[2,2,2,2] -> [4,4,0,0]` instead of `[8,0,0,0]`
 * (a triple/quadruple merge) or the merged tile re-merging with whatever
 * comes after it in the same pass -- see engine.test.ts's "merge once per
 * move" cases for both directions this bites.
 *
 * `mergedIndices` names which positions IN THE RETURNED (pre-padding) line
 * are merge results, in this line's own not-yet-reversed orientation --
 * `slide` below maps them back to real board coordinates. This exists
 * purely so animation code can tell "this cell is a merge result" apart
 * from "this cell is a tile that simply slid into a gap" or "this cell got
 * a brand new spawned tile" -- three cases that look identical from a
 * plain before/after value diff the moment a merge lands on a cell that
 * was empty before the move (very common; see engine.test.ts's
 * "mergedAt" describe block, added after a live browser check caught
 * exactly this misclassification).
 */
function slideLine(line: number[]): { line: number[]; gained: number; mergedIndices: number[] } {
  const compacted = line.filter((v) => v !== 0);
  const merged: number[] = [];
  const mergedIndices: number[] = [];
  let gained = 0;
  let i = 0;
  while (i < compacted.length) {
    if (i + 1 < compacted.length && compacted[i] === compacted[i + 1]) {
      const value = compacted[i] * 2;
      mergedIndices.push(merged.length);
      merged.push(value);
      gained += value;
      i += 2;
    } else {
      merged.push(compacted[i]);
      i += 1;
    }
  }
  while (merged.length < line.length) merged.push(0);
  return { line: merged, gained, mergedIndices };
}

/**
 * Slides every tile toward `dir` on a 4x4 (or SIZE x SIZE) board: rows for
 * left/right, columns for up/down. `left`/`up` compact straight toward
 * index 0 of their line; `right`/`down` reverse the line first (so their
 * own "far edge" becomes index 0 for slideLine), then reverse the result
 * back -- one shared compaction routine, oriented four ways, specifically
 * so a transpose/reverse mistake in ONE direction can't hide behind the
 * other three passing (see engine.test.ts: all four directions are tested
 * independently, not just one generalized).
 *
 * `gained` is the sum of every merge's resulting value this move (for
 * score). `moved` is whether ANY cell's value actually changed -- not
 * derived from `gained`, since a pure compaction with no merge still counts
 * as a move (and a legal-looking but fully-settled board must NOT spawn a
 * tile or count as a real move). `mergedAt` lists the exact [row, col] of
 * every merge result in the RETURNED board -- see slideLine's comment for
 * why this can't be recovered later by diffing before/after boards.
 */
export function slide(
  board: Board2048,
  dir: Direction,
): { board: Board2048; gained: number; moved: boolean; mergedAt: [number, number][] } {
  const size = board.length;
  let gained = 0;
  let result: Board2048;
  const mergedAt: [number, number][] = [];

  if (dir === "left" || dir === "right") {
    result = board.map((row, r) => {
      const reversed = dir === "right";
      const line = reversed ? [...row].reverse() : [...row];
      const { line: merged, gained: g, mergedIndices } = slideLine(line);
      gained += g;
      for (const idx of mergedIndices) {
        mergedAt.push([r, reversed ? line.length - 1 - idx : idx]);
      }
      return reversed ? merged.reverse() : merged;
    });
  } else {
    result = board.map((row) => [...row]);
    for (let col = 0; col < size; col++) {
      const column = board.map((row) => row[col]);
      const reversed = dir === "down";
      const line = reversed ? [...column].reverse() : column;
      const { line: merged, gained: g, mergedIndices } = slideLine(line);
      gained += g;
      for (const idx of mergedIndices) {
        mergedAt.push([reversed ? line.length - 1 - idx : idx, col]);
      }
      const finalColumn = reversed ? merged.reverse() : merged;
      for (let row = 0; row < size; row++) {
        result[row][col] = finalColumn[row];
      }
    }
  }

  return { board: result, gained, moved: !boardsEqual(board, result), mergedAt };
}

/**
 * Places a new tile (90% a 2, 10% a 4) on a uniformly-chosen empty cell.
 * `rng` is injected (`() => number` in [0,1), defaulting to `Math.random`
 * for real callers -- this default is ordinary app code, not a
 * workflow-script `Math.random` ban) precisely so a test can supply a fixed
 * sequence and assert exactly which cell and value were chosen. Reads
 * `rng()` twice, in order: once to pick the cell index, once to pick the
 * value. A full board (no empty cells) is a safe no-op -- callers only
 * spawn after `slide` reports `moved: true`, which guarantees at least one
 * empty cell, but this stays defensive rather than throwing.
 */
export function spawn(board: Board2048, rng: () => number = Math.random): Board2048 {
  const next = board.map((row) => [...row]);
  const empties: [number, number][] = [];
  for (let r = 0; r < next.length; r++) {
    for (let c = 0; c < next[r].length; c++) {
      if (next[r][c] === 0) empties.push([r, c]);
    }
  }
  if (empties.length === 0) return next;

  const [r, c] = empties[Math.floor(rng() * empties.length)];
  next[r][c] = rng() < 0.9 ? 2 : 4;
  return next;
}

/**
 * True if at least one legal move remains in ANY direction: an empty cell
 * exists, or two cells adjacent in either axis are equal. Checking only
 * rightward/downward neighbors from every cell covers both axes without
 * double-checking the same pair twice.
 */
export function canMove(board: Board2048): boolean {
  const size = board.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < board[r].length; c++) {
      if (board[r][c] === 0) return true;
      if (c + 1 < board[r].length && board[r][c] === board[r][c + 1]) return true;
      if (r + 1 < size && board[r][c] === board[r + 1][c]) return true;
    }
  }
  return false;
}

/** True once any single cell reaches exactly 2048 -- the "keep playing"
 * banner trigger. Exactly 2048, not >= 2048: the banner is a one-time event
 * gated by state.ts's persisted `keepPlaying` flag, not a running "has a
 * big tile" check, so there's no need (and no correctness reason) to keep
 * matching once play continues past it into 4096 and beyond. */
export function hasWon(board: Board2048): boolean {
  return board.some((row) => row.some((cell) => cell === 2048));
}

/**
 * Which of the four directions a pointer-down-to-up delta represents, or
 * null if neither axis moved at least `threshold` px. Compares |dx| to |dy|
 * to pick the dominant axis first, then the sign of that axis to pick the
 * direction -- an exact axis tie (|dx| === |dy|) breaks toward horizontal,
 * an arbitrary but fixed and tested choice (see engine.test.ts). Pure and
 * DOM-free by design: this workspace has no jsdom, so a real touch gesture
 * can't be simulated in a unit test -- state.ts's swipeTransition wires this
 * to actual pointer events.
 */
export function swipeDirection(dx: number, dy: number, threshold = 24): Direction | null {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (Math.max(absX, absY) < threshold) return null;
  if (absX >= absY) {
    return dx > 0 ? "right" : "left";
  }
  return dy > 0 ? "down" : "up";
}
