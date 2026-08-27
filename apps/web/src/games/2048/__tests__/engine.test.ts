// 2048 engine -- pure functions only, no DOM. slide() is the single most
// failure-prone piece of this game (see this file's "slide" describe blocks):
// every direction is tested independently with its own hand-verified cases,
// including the classic "merge once per move" bug (four equal tiles must
// become two doubled tiles, never one quadrupled tile and never a
// triple-merge chain).
import { describe, expect, it } from "vitest";
import {
  canMove,
  emptyBoard,
  hasWon,
  isEmptyBoard,
  SIZE,
  slide,
  spawn,
  swipeDirection,
  type Board2048,
} from "../engine";

function board(rows: number[][]): Board2048 {
  return rows;
}

describe("slide -- left", () => {
  it("compacts a gap with no merge", () => {
    const result = slide(board([[0, 2, 0, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.board[0]).toEqual([2, 4, 0, 0]);
    expect(result.gained).toBe(0);
    expect(result.moved).toBe(true);
  });

  it("merges a single adjacent pair", () => {
    const result = slide(board([[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.board[0]).toEqual([4, 0, 0, 0]);
    expect(result.gained).toBe(4);
    expect(result.moved).toBe(true);
  });

  it("the classic merge-once-per-move bug: four equal tiles become two doubles, not one quadruple", () => {
    const result = slide(board([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.board[0]).toEqual([4, 4, 0, 0]);
    expect(result.gained).toBe(8);
  });

  it("three equal tiles merge only the first pair, the leftover stays unmerged", () => {
    const result = slide(board([[2, 2, 2, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.board[0]).toEqual([4, 2, 0, 0]);
    expect(result.gained).toBe(4);
  });

  it("two independent merges in one row both count", () => {
    const result = slide(board([[4, 4, 8, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.board[0]).toEqual([8, 16, 0, 0]);
    expect(result.gained).toBe(24);
  });

  it("a merged tile never merges again with the next original tile in the same move", () => {
    // 4,2,2,4 -> the middle pair merges to 4; that new 4 must NOT then merge
    // with the trailing 4 (they were never adjacent as a merge candidate).
    const result = slide(board([[4, 2, 2, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.board[0]).toEqual([4, 4, 4, 0]);
    expect(result.gained).toBe(4);
  });

  it("reports moved=false when the row is already fully left-aligned with no merges", () => {
    const result = slide(board([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.board[0]).toEqual([2, 4, 8, 16]);
    expect(result.gained).toBe(0);
    expect(result.moved).toBe(false);
  });

  it("rows are independent -- one row's merge never bleeds into another", () => {
    const result = slide(
      board([
        [2, 2, 0, 0],
        [4, 0, 4, 0],
        [0, 0, 0, 0],
        [8, 8, 8, 8],
      ]),
      "left",
    );
    expect(result.board).toEqual([
      [4, 0, 0, 0],
      [8, 0, 0, 0],
      [0, 0, 0, 0],
      [16, 16, 0, 0],
    ]);
    expect(result.gained).toBe(4 + 8 + 16 + 16);
  });
});

describe("slide -- right", () => {
  it("compacts toward the right edge with no merge", () => {
    const result = slide(board([[2, 0, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "right");
    expect(result.board[0]).toEqual([0, 0, 2, 4]);
    expect(result.moved).toBe(true);
    expect(result.gained).toBe(0);
  });

  it("merges toward the right edge", () => {
    const result = slide(board([[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "right");
    expect(result.board[0]).toEqual([0, 0, 0, 4]);
    expect(result.gained).toBe(4);
  });

  it("merge-once-per-move: four equal tiles become two doubles at the right edge", () => {
    const result = slide(board([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "right");
    expect(result.board[0]).toEqual([0, 0, 4, 4]);
    expect(result.gained).toBe(8);
  });

  it("two independent merges land at the right edge in order", () => {
    const result = slide(board([[4, 4, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "right");
    expect(result.board[0]).toEqual([0, 0, 8, 4]);
    expect(result.gained).toBe(12);
  });

  it("reports moved=false when already right-aligned with no merges", () => {
    const result = slide(board([[0, 0, 4, 8], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "right");
    expect(result.board[0]).toEqual([0, 0, 4, 8]);
    expect(result.moved).toBe(false);
  });
});

describe("slide -- up", () => {
  it("compacts a column toward the top with no merge", () => {
    const result = slide(
      board([
        [0, 0, 0, 0],
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [4, 0, 0, 0],
      ]),
      "up",
    );
    expect([result.board[0][0], result.board[1][0], result.board[2][0], result.board[3][0]]).toEqual([2, 4, 0, 0]);
    expect(result.gained).toBe(0);
    expect(result.moved).toBe(true);
  });

  it("merges a column pair toward the top", () => {
    const result = slide(
      board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [2, 0, 0, 0],
      ]),
      "up",
    );
    expect([result.board[0][0], result.board[1][0], result.board[2][0], result.board[3][0]]).toEqual([4, 0, 0, 0]);
    expect(result.gained).toBe(4);
  });

  it("merge-once-per-move vertically: four equal tiles become two doubles, not one quadruple", () => {
    const result = slide(
      board([
        [2, 0, 0, 0],
        [2, 0, 0, 0],
        [2, 0, 0, 0],
        [2, 0, 0, 0],
      ]),
      "up",
    );
    expect([result.board[0][0], result.board[1][0], result.board[2][0], result.board[3][0]]).toEqual([4, 4, 0, 0]);
    expect(result.gained).toBe(8);
  });

  it("reports moved=false when the column is already fully settled with no merges", () => {
    const initial = board([
      [2, 0, 0, 0],
      [4, 0, 0, 0],
      [8, 0, 0, 0],
      [16, 0, 0, 0],
    ]);
    const result = slide(initial, "up");
    expect(result.board).toEqual(initial);
    expect(result.moved).toBe(false);
  });

  it("columns are independent -- one column's merge never bleeds into another", () => {
    const result = slide(
      board([
        [2, 4, 0, 8],
        [2, 0, 0, 8],
        [0, 4, 0, 8],
        [0, 0, 0, 8],
      ]),
      "up",
    );
    expect(result.board).toEqual([
      [4, 8, 0, 16],
      [0, 0, 0, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
  });
});

describe("slide -- down", () => {
  it("compacts a column toward the bottom with no merge", () => {
    const result = slide(
      board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [4, 0, 0, 0],
        [0, 0, 0, 0],
      ]),
      "down",
    );
    expect([result.board[0][0], result.board[1][0], result.board[2][0], result.board[3][0]]).toEqual([0, 0, 2, 4]);
    expect(result.gained).toBe(0);
    expect(result.moved).toBe(true);
  });

  it("merges a column pair toward the bottom, leaving an unmatched tile alone", () => {
    // Column top->bottom [2,0,2,4]: the two 2's fall together and merge just
    // above the already-bottom 4 (which cannot merge with them, 2 != 4).
    const result = slide(
      board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [2, 0, 0, 0],
        [4, 0, 0, 0],
      ]),
      "down",
    );
    expect([result.board[0][0], result.board[1][0], result.board[2][0], result.board[3][0]]).toEqual([0, 0, 4, 4]);
    expect(result.gained).toBe(4);
  });

  it("merge-once-per-move vertically at the bottom edge: four equal tiles become two doubles", () => {
    const result = slide(
      board([
        [2, 0, 0, 0],
        [2, 0, 0, 0],
        [2, 0, 0, 0],
        [2, 0, 0, 0],
      ]),
      "down",
    );
    expect([result.board[0][0], result.board[1][0], result.board[2][0], result.board[3][0]]).toEqual([0, 0, 4, 4]);
    expect(result.gained).toBe(8);
  });

  it("reports moved=false when already bottom-aligned with no merges", () => {
    const initial = board([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [2, 0, 0, 0],
      [4, 0, 0, 0],
    ]);
    const result = slide(initial, "down");
    expect(result.board).toEqual(initial);
    expect(result.moved).toBe(false);
  });
});

describe("slide -- does not mutate the input board", () => {
  it("leaves the original board array untouched", () => {
    const original = board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const snapshot = original.map((row) => [...row]);
    slide(original, "left");
    expect(original).toEqual(snapshot);
  });
});

describe("slide -- mergedAt reports the EXACT final positions of merge results", () => {
  // Found via a live browser check, not a unit test (see project memory /
  // agent report): index.tsx originally tried to INFER "spawn vs merge" by
  // diffing the board before/after a move, position by position. That's
  // wrong whenever a merge's result lands on a cell that was empty before
  // the move (extremely common -- compaction moves values across cells
  // constantly), because "previously 0, now non-zero" is indistinguishable
  // from an ordinary tile sliding into a gap, or a genuinely new spawned
  // tile. slide() must report merge positions directly so nothing has to
  // guess.
  it("left: a single merge lands at the compacted column, not the tile's original column", () => {
    const result = slide(board([[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.mergedAt).toEqual([[0, 0]]);
  });

  it("right: a single merge lands at the far (right) edge", () => {
    const result = slide(board([[2, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "right");
    expect(result.mergedAt).toEqual([[0, 3]]);
  });

  it("right: two independent merges both report their own final position", () => {
    const result = slide(board([[4, 4, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "right");
    expect(result.board[0]).toEqual([0, 0, 8, 4]); // from the earlier "slide -- right" case
    expect(result.mergedAt).toEqual(
      expect.arrayContaining([
        [0, 2],
        [0, 3],
      ]),
    );
    expect(result.mergedAt).toHaveLength(2);
  });

  it("up: the exact regression case -- a merge landing on a cell that was EMPTY before the move", () => {
    // Column top->bottom [2,0,0,2] (rows 0 and 3 populated, 1 and 2 empty):
    // sliding up merges both into row 0, which held nothing before this
    // move. A before/after diff at (0,0) alone can't tell "merge" apart
    // from "brand new tile spawned here" or "a lone tile just slid here".
    const result = slide(
      board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [2, 0, 0, 0],
      ]),
      "up",
    );
    expect(result.mergedAt).toEqual([[0, 0]]);
  });

  it("down: only the cell that actually merged is reported -- an adjacent equal-valued tile that merely slid is not", () => {
    // Column top->bottom [2,0,2,4]: the two 2's merge into a 4 at row 2;
    // the ORIGINAL 4 at row 3 just slides down by zero cells and stays put
    // -- same final value (4) as its new neighbour, but it never merged,
    // so it must NOT appear in mergedAt.
    const result = slide(
      board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [2, 0, 0, 0],
        [4, 0, 0, 0],
      ]),
      "down",
    );
    expect([result.board[0][0], result.board[1][0], result.board[2][0], result.board[3][0]]).toEqual([0, 0, 4, 4]);
    expect(result.mergedAt).toEqual([[2, 0]]);
  });

  it("is empty when a move compacts but nothing merges", () => {
    const result = slide(board([[0, 2, 0, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.mergedAt).toEqual([]);
  });

  it("is empty when the move is a no-op", () => {
    const result = slide(board([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), "left");
    expect(result.mergedAt).toEqual([]);
  });
});

describe("spawn", () => {
  function fakeRng(sequence: number[]): () => number {
    const queue = [...sequence];
    return () => queue.shift() ?? 0;
  }

  it("places a tile on the first empty cell when rng picks index 0, value 2 (rng < 0.9)", () => {
    const empty = emptyBoard();
    const rng = fakeRng([0, 0]);
    const result = spawn(empty, rng);
    expect(result[0][0]).toBe(2);
    // every other cell remains empty
    let nonZero = 0;
    for (const row of result) for (const cell of row) if (cell !== 0) nonZero += 1;
    expect(nonZero).toBe(1);
  });

  it("places a 4 when the second rng draw is >= 0.9", () => {
    const empty = emptyBoard();
    const rng = fakeRng([0, 0.95]);
    const result = spawn(empty, rng);
    expect(result[0][0]).toBe(4);
  });

  it("picks the empty cell selected by the injected rng deterministically", () => {
    // Exactly two empty cells: (0,0) and (0,1). rng() * 2 with rng=0.5 -> index 1.
    const partial = board([[2, 0, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]]);
    const rng = fakeRng([0.5, 0]);
    const result = spawn(partial, rng);
    expect(result[0][1]).toBe(2);
    expect(result[0][0]).toBe(2); // unchanged, still the only other non-zero already there
  });

  it("does not mutate the input board", () => {
    const empty = emptyBoard();
    const snapshot = empty.map((row) => [...row]);
    spawn(empty, fakeRng([0, 0]));
    expect(empty).toEqual(snapshot);
  });

  it("is a safe no-op (does not throw, board unchanged) when there are no empty cells", () => {
    const full = board([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    const result = spawn(full, fakeRng([0, 0]));
    expect(result).toEqual(full);
  });

  it("defaults its rng to Math.random when none is provided (does not throw)", () => {
    expect(() => spawn(emptyBoard())).not.toThrow();
  });
});

describe("canMove", () => {
  it("is true when at least one empty cell exists, even with no adjacent equals", () => {
    const b = board([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 0],
    ]);
    expect(canMove(b)).toBe(true);
  });

  it("is true on a full board with a horizontally adjacent equal pair", () => {
    const b = board([
      [2, 2, 4, 8],
      [4, 8, 2, 4],
      [8, 4, 8, 2],
      [2, 8, 4, 8],
    ]);
    expect(canMove(b)).toBe(true);
  });

  it("is true on a full board with only a vertically adjacent equal pair", () => {
    const b = board([
      [2, 4, 8, 2],
      [2, 8, 4, 8],
      [4, 2, 8, 4],
      [8, 4, 2, 8],
    ]);
    // col0: 2,2 adjacent vertically at rows 0-1
    expect(canMove(b)).toBe(true);
  });

  it("is false on a full board with no empty cells and no adjacent equals in either axis (game over)", () => {
    const b = board([
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ]);
    expect(canMove(b)).toBe(false);
  });
});

describe("hasWon", () => {
  it("is true once a cell reaches exactly 2048", () => {
    const b = board([
      [2, 4, 8, 16],
      [32, 64, 128, 256],
      [512, 1024, 2048, 4],
      [2, 4, 8, 16],
    ]);
    expect(hasWon(b)).toBe(true);
  });

  it("is false when no cell has reached 2048 yet", () => {
    const b = board([
      [2, 4, 8, 16],
      [32, 64, 128, 256],
      [512, 1024, 4, 4],
      [2, 4, 8, 16],
    ]);
    expect(hasWon(b)).toBe(false);
  });
});

describe("emptyBoard / isEmptyBoard", () => {
  it("emptyBoard produces a SIZE x SIZE grid of zeros", () => {
    const b = emptyBoard();
    expect(b).toHaveLength(SIZE);
    for (const row of b) {
      expect(row).toHaveLength(SIZE);
      expect(row.every((c) => c === 0)).toBe(true);
    }
  });

  it("isEmptyBoard is true for a fresh empty board and false once any cell is populated", () => {
    expect(isEmptyBoard(emptyBoard())).toBe(true);
    const populated = emptyBoard();
    populated[0][0] = 2;
    expect(isEmptyBoard(populated)).toBe(false);
  });
});

describe("swipeDirection", () => {
  it("detects right on a dominant positive horizontal delta", () => {
    expect(swipeDirection(30, 5)).toBe("right");
  });

  it("detects left on a dominant negative horizontal delta", () => {
    expect(swipeDirection(-30, 5)).toBe("left");
  });

  it("detects down on a dominant positive vertical delta", () => {
    expect(swipeDirection(5, 30)).toBe("down");
  });

  it("detects up on a dominant negative vertical delta", () => {
    expect(swipeDirection(5, -30)).toBe("up");
  });

  it("returns null below the threshold in both axes", () => {
    expect(swipeDirection(10, 10)).toBeNull();
  });

  it("treats the threshold as inclusive (exactly 24px counts)", () => {
    expect(swipeDirection(24, 0)).toBe("right");
  });

  it("respects a custom threshold", () => {
    expect(swipeDirection(10, 0, 5)).toBe("right");
    expect(swipeDirection(4, 0, 5)).toBeNull();
  });

  it("breaks an exact horizontal/vertical tie toward the horizontal axis", () => {
    expect(swipeDirection(30, 30)).toBe("right");
    expect(swipeDirection(-30, 30)).toBe("left");
  });
});
