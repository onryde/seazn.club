// 2048 state -- persistence shape (GameState), the write-path reducer that
// runs a move (applyMove), "New game" (newGame), storage coercion
// (migrateState), keyboard mapping (directionForKey), and the swipe pointer
// reducer (swipeTransition). No DOM: this workspace has no jsdom (see
// _shared/use-game-store.test.tsx's header), so swipeTransition is tested as
// a plain reducer exactly like chess-quest's Board.tsx tests dragTransition/
// runDragAction, and Daily Word's state.test.ts tests handleKey.
import { describe, expect, it } from "vitest";
import { emptyBoard, isEmptyBoard, type Board2048 } from "../engine";
import { loadStoredValue, saveStoredValue } from "../../_shared/use-game-store";
import {
  applyMove,
  directionForKey,
  INITIAL_STATE,
  migrateState,
  newGame,
  STORAGE_KEY,
  swipeTransition,
  type GameState,
} from "../state";

function board(rows: number[][]): Board2048 {
  return rows;
}

// Minimal in-memory Storage, same shape as the other games' fakeStorage().
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

function fakeRng(sequence: number[]): () => number {
  const queue = [...sequence];
  return () => queue.shift() ?? 0;
}

describe("INITIAL_STATE", () => {
  it("is the empty-board sentinel, never a real playable position", () => {
    expect(isEmptyBoard(INITIAL_STATE.board)).toBe(true);
    expect(INITIAL_STATE.score).toBe(0);
    expect(INITIAL_STATE.best).toBe(0);
    expect(INITIAL_STATE.keepPlaying).toBe(false);
  });
});

describe("newGame", () => {
  it("spawns exactly two tiles on an otherwise empty board", () => {
    const state = newGame(0, fakeRng([0, 0, 0.5, 0]));
    let nonZero = 0;
    for (const row of state.board) for (const cell of row) if (cell !== 0) nonZero += 1;
    expect(nonZero).toBe(2);
  });

  it("resets score and keepPlaying but carries the previous best forward", () => {
    const state = newGame(512, fakeRng([0, 0, 0.5, 0]));
    expect(state.score).toBe(0);
    expect(state.keepPlaying).toBe(false);
    expect(state.best).toBe(512);
  });
});

describe("applyMove", () => {
  it("advances the board and adds gained points to score when the move is legal", () => {
    const state: GameState = {
      board: board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
      score: 10,
      best: 10,
      keepPlaying: false,
    };
    const { state: next, moved } = applyMove(state, "left", fakeRng([0, 0]));
    expect(moved).toBe(true);
    expect(next.board[0][0]).toBe(4);
    expect(next.score).toBe(14); // 10 + gained(4)
  });

  it("raises best when score surpasses the previous best", () => {
    const state: GameState = {
      board: board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
      score: 0,
      best: 0,
      keepPlaying: false,
    };
    const { state: next } = applyMove(state, "left", fakeRng([0, 0]));
    expect(next.best).toBe(4);
  });

  it("never lowers best below its previous value", () => {
    const state: GameState = {
      board: board([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
      score: 0,
      best: 999,
      keepPlaying: false,
    };
    const { state: next } = applyMove(state, "right", fakeRng([0, 0]));
    expect(next.best).toBe(999);
  });

  it("is a no-op (same reference, no spawn, no score change) when the move is illegal", () => {
    const state: GameState = {
      board: board([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
      score: 5,
      best: 5,
      keepPlaying: false,
    };
    const { state: next, moved } = applyMove(state, "left", fakeRng([0, 0]));
    expect(moved).toBe(false);
    expect(next).toBe(state); // exact same reference -- lets a caller bail out cheaply
  });

  it("does not mutate the board it was given", () => {
    const originalBoard = board([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const snapshot = originalBoard.map((row) => [...row]);
    const state: GameState = { board: originalBoard, score: 0, best: 0, keepPlaying: false };
    applyMove(state, "left", fakeRng([0, 0]));
    expect(originalBoard).toEqual(snapshot);
  });
});

describe("applyMove -- mergedAt/spawnedAt (exact positions for animation)", () => {
  // Found via a live browser check: two 2's at (2,0) and (3,0) sliding up
  // merge into a 4 at (0,0), a cell that was empty before the move. Naively
  // diffing the board before/after can't tell that apart from "a tile just
  // slid here" or "a brand new tile spawned here" -- applyMove must report
  // it directly, threaded straight from slide()'s own mergedAt. See
  // engine.test.ts's matching "mergedAt" describe block and
  // reference_use_game_store_first_load_bypasses_migrate.md-style project
  // memory on why inferring instead of reporting shipped a real bug here.
  it("reports the merge's exact final position, not its tiles' original ones", () => {
    const state: GameState = {
      board: board([
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [2, 0, 0, 0],
      ]),
      score: 0,
      best: 0,
      keepPlaying: false,
    };
    const { mergedAt } = applyMove(state, "up", fakeRng([0, 0]));
    expect(mergedAt).toEqual([[0, 0]]);
  });

  it("reports the spawned tile's exact position, distinct from any merge", () => {
    // Board starts completely full (16/16). Sliding left merges row0's
    // leading 2,2 into a 4 at (0,0) -- the ONLY thing a slide ever does to
    // a full board's empty-cell count is CREATE cells via a merge, never
    // remove any (only spawn() removes one) -- so this merge frees exactly
    // one cell, at (0,3) (row0 becomes [4,4,8,0]: the merge result at
    // col0, the original unmerged 4 and 8 each shift one column left, and
    // the vacated slot lands at the far end, col3). That is the sole
    // empty cell anywhere on the board, so spawn()'s injected rng need not
    // even pick among choices for the index draw to be deterministic.
    const state: GameState = {
      board: board([
        [2, 2, 4, 8],
        [16, 32, 64, 128],
        [256, 512, 1024, 2],
        [4, 8, 16, 32],
      ]),
      score: 0,
      best: 0,
      keepPlaying: false,
    };
    const { state: next, mergedAt, spawnedAt } = applyMove(state, "left", fakeRng([0, 0]));
    expect(mergedAt).toEqual([[0, 0]]); // the leading 2,2 merges to 4
    expect(spawnedAt).toEqual([0, 3]);
    const [sr, sc] = spawnedAt!;
    expect(next.board[sr][sc]).not.toBe(0);
    expect(mergedAt).not.toContainEqual(spawnedAt); // a merge and a spawn are never the same cell
  });

  it("reports an empty mergedAt and a null spawnedAt for a no-op move", () => {
    const state: GameState = {
      board: board([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
      score: 0,
      best: 0,
      keepPlaying: false,
    };
    const { mergedAt, spawnedAt, moved } = applyMove(state, "left", fakeRng([0, 0]));
    expect(moved).toBe(false);
    expect(mergedAt).toEqual([]);
    expect(spawnedAt).toBeNull();
  });
});

describe("directionForKey", () => {
  it("maps arrow keys", () => {
    expect(directionForKey("ArrowUp")).toBe("up");
    expect(directionForKey("ArrowDown")).toBe("down");
    expect(directionForKey("ArrowLeft")).toBe("left");
    expect(directionForKey("ArrowRight")).toBe("right");
  });

  it("maps WASD, both cases", () => {
    expect(directionForKey("w")).toBe("up");
    expect(directionForKey("W")).toBe("up");
    expect(directionForKey("s")).toBe("down");
    expect(directionForKey("S")).toBe("down");
    expect(directionForKey("a")).toBe("left");
    expect(directionForKey("A")).toBe("left");
    expect(directionForKey("d")).toBe("right");
    expect(directionForKey("D")).toBe("right");
  });

  it("returns null for an unrelated key", () => {
    expect(directionForKey("Enter")).toBeNull();
    expect(directionForKey("q")).toBeNull();
    expect(directionForKey(" ")).toBeNull();
  });
});

describe("swipeTransition", () => {
  it("starts tracking on down and reports no direction yet", () => {
    const { state, direction } = swipeTransition(null, { type: "down", x: 10, y: 10, pointerId: 1 });
    expect(state).toEqual({ x: 10, y: 10, pointerId: 1 });
    expect(direction).toBeNull();
  });

  it("ignores a second pointer's down while one is already tracked", () => {
    const afterFirst = swipeTransition(null, { type: "down", x: 0, y: 0, pointerId: 1 }).state;
    const { state } = swipeTransition(afterFirst, { type: "down", x: 50, y: 50, pointerId: 2 });
    expect(state).toEqual(afterFirst); // unchanged -- still pointer 1's start
  });

  it("computes the swipe direction on up and clears tracking", () => {
    const afterDown = swipeTransition(null, { type: "down", x: 0, y: 0, pointerId: 1 }).state;
    const { state, direction } = swipeTransition(afterDown, { type: "up", x: 40, y: 0, pointerId: 1 });
    expect(direction).toBe("right");
    expect(state).toBeNull();
  });

  it("ignores up from a pointerId that never went down here", () => {
    const afterDown = swipeTransition(null, { type: "down", x: 0, y: 0, pointerId: 1 }).state;
    const { state, direction } = swipeTransition(afterDown, { type: "up", x: 40, y: 0, pointerId: 2 });
    expect(direction).toBeNull();
    expect(state).toEqual(afterDown); // untouched
  });

  it("reports null when the release never crossed the threshold", () => {
    const afterDown = swipeTransition(null, { type: "down", x: 0, y: 0, pointerId: 1 }).state;
    const { direction } = swipeTransition(afterDown, { type: "up", x: 5, y: 5, pointerId: 1 });
    expect(direction).toBeNull();
  });

  it("cancel clears tracking without ever reporting a direction", () => {
    const afterDown = swipeTransition(null, { type: "down", x: 0, y: 0, pointerId: 1 }).state;
    const { state, direction } = swipeTransition(afterDown, { type: "cancel", pointerId: 1 });
    expect(state).toBeNull();
    expect(direction).toBeNull();
  });

  it("ignores a cancel for a pointerId that isn't the tracked one", () => {
    const afterDown = swipeTransition(null, { type: "down", x: 0, y: 0, pointerId: 1 }).state;
    const { state } = swipeTransition(afterDown, { type: "cancel", pointerId: 2 });
    expect(state).toEqual(afterDown);
  });
});

describe("migrateState", () => {
  it("round-trips a well-formed value", () => {
    const value: GameState = {
      board: board([[2, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]),
      score: 40,
      best: 100,
      keepPlaying: true,
    };
    expect(migrateState(value)).toEqual(value);
  });

  it("throws on a hopeless (non-object) value, so loadStoredValue can fall back", () => {
    expect(() => migrateState(null)).toThrow();
    expect(() => migrateState("garbage")).toThrow();
  });

  it("falls back to an empty board when the stored board field is malformed", () => {
    const result = migrateState({ board: "not-a-board", score: 5, best: 5, keepPlaying: false });
    expect(isEmptyBoard(result.board)).toBe(true);
  });

  it("falls back to an empty board when the stored board has the wrong dimensions", () => {
    const result = migrateState({ board: [[2, 2], [2, 2]], score: 0, best: 0, keepPlaying: false });
    expect(isEmptyBoard(result.board)).toBe(true);
  });

  it("coerces non-finite/missing score and best to 0, and non-boolean keepPlaying to false", () => {
    const result = migrateState({ board: emptyBoard(), score: "nope", keepPlaying: "yes" });
    expect(result.score).toBe(0);
    expect(result.best).toBe(0);
    expect(result.keepPlaying).toBe(false);
  });

  it("raises best to at least score if a corrupt/stale best was stored lower than score", () => {
    const result = migrateState({ board: emptyBoard(), score: 500, best: 10, keepPlaying: false });
    expect(result.best).toBe(500);
  });
});

describe("first-visit bypass regression: migrate never runs before anything is stored", () => {
  // Same shape as Daily Word's applyGuessResult regression test (see
  // reference_use_game_store_first_load_bypasses_migrate.md): confirms the
  // INITIAL_STATE sentinel is what a brand new player actually gets (empty
  // board, migrate never called), which is exactly why index.tsx's mount
  // effect -- not migrateState -- is responsible for spawning the opening
  // two tiles. See state.ts's header comment.
  it("loadStoredValue returns INITIAL_STATE verbatim, without calling migrate, when nothing is stored", () => {
    const storage = fakeStorage();
    const result = loadStoredValue(storage, STORAGE_KEY, INITIAL_STATE, migrateState);
    expect(result).toEqual(INITIAL_STATE);
    expect(isEmptyBoard(result.board)).toBe(true);
  });

  it("round-trips a real played state through save/load under STORAGE_KEY", () => {
    const storage = fakeStorage();
    const played = newGame(0, fakeRng([0, 0, 0.5, 0]));
    saveStoredValue(storage, STORAGE_KEY, played);
    const reloaded = loadStoredValue(storage, STORAGE_KEY, INITIAL_STATE, migrateState);
    expect(reloaded).toEqual(played);
  });
});
