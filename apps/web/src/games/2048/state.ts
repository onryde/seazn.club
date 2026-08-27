// 2048 state -- persistence shape (GameState), the write-path reducer that
// runs one move (applyMove), "New game" (newGame), storage coercion
// (migrateState), keyboard mapping (directionForKey), and the swipe pointer
// reducer (swipeTransition). No DOM, no localStorage read/write of its own
// -- index.tsx is the thin glue that wires physical keydown + pointer
// events to these, and useGameStore (from _shared) to migrateState, the
// same pure-reducer/thin-glue split Board.tsx uses for
// dragTransition/runDragAction, and Daily Word's state.ts uses for
// handleKey.
import { emptyBoard, SIZE, slide, spawn, swipeDirection, type Board2048, type Direction } from "./engine";

export const STORAGE_KEY = "seazn-games:2048:v1";

export type GameState = {
  board: Board2048;
  score: number;
  best: number;
  /** One-time "you reached 2048" banner, dismissed = true. Persisted so a
   * reload mid-game (after dismissal) doesn't re-show the banner; reset to
   * false by newGame. */
  keepPlaying: boolean;
};

/**
 * The "never initialized yet" sentinel -- an empty board (see engine.ts's
 * isEmptyBoard: unreachable through real play). This is NOT a playable
 * position; it exists only so index.tsx's mount effect can detect a brand
 * new player (or a corrupt/malformed stored board recovered by
 * migrateState below) and spawn the real opening two tiles itself.
 *
 * This indirection matters because _shared's useGameStore skips `migrate`
 * ENTIRELY on a player's first-ever visit (loadStoredValue returns
 * `initial` the moment nothing is stored yet, before migrate ever runs --
 * see reference_use_game_store_first_load_bypasses_migrate.md). Daily
 * Word hit this exact trap with its `lastPlayedDate: ""` sentinel: logic
 * that only ran inside `migrate` silently never corrected a first-time
 * player's state. Spawning the opening tiles inside `migrate` here would
 * have the identical bug -- a brand new player would see a permanently
 * empty, unplayable board. Putting the correction in the component's mount
 * effect instead (checked unconditionally, every mount) sidesteps it
 * entirely, and doubles as the recovery path for a corrupt stored board
 * (migrateState below falls back to emptyBoard(), not a freshly spawned
 * game, for exactly this reason -- no rng is threaded through migrate's
 * one-argument signature, and none needs to be).
 */
export const INITIAL_STATE: GameState = {
  board: emptyBoard(),
  score: 0,
  best: 0,
  keepPlaying: false,
};

/** Starts a fresh game: two freshly spawned tiles, score and keepPlaying
 * reset, but `best` carried forward -- "New game resets everything but
 * best" (design doc, 2048 section). */
export function newGame(prevBest: number, rng: () => number = Math.random): GameState {
  const board = spawn(spawn(emptyBoard(), rng), rng);
  return { board, score: 0, best: prevBest, keepPlaying: false };
}

/**
 * Runs one move: slides `state.board` toward `dir`, and only if that
 * actually changed anything, spawns a new tile and updates score/best.
 * Returns the EXACT SAME state reference when the move was illegal (no
 * cells changed) -- a cheap, intentional signal a caller can use to bail
 * out of a state update entirely (React's setState bails out a re-render
 * when given the same reference back), matching the spec: "pressing a
 * direction that changes nothing should NOT spawn a tile or count as a
 * real move."
 *
 * Also returns `mergedAt` (threaded straight from slide()'s own result)
 * and `spawnedAt` -- the exact positions index.tsx needs to play the right
 * animation on the right cell. `spawnedAt` is found by diffing the
 * post-slide board against the post-spawn board: spawn() only ever
 * changes exactly one cell (0 -> 2 or 4), so that diff is unambiguous,
 * unlike trying to infer ANYTHING from a before/after diff of the whole
 * move (see slideLine's comment in engine.ts for why that's unsafe for
 * merges). Found via a live browser check: an earlier version of
 * index.tsx tried to infer spawn/merge by diffing state.board across
 * renders, and mislabeled a merge landing on a previously-empty cell as a
 * "spawn" -- see engine.test.ts's and this file's "mergedAt"/"spawnedAt"
 * describe blocks for the regression cases that catch it.
 */
export function applyMove(
  state: GameState,
  dir: Direction,
  rng: () => number = Math.random,
): {
  state: GameState;
  moved: boolean;
  mergedAt: [number, number][];
  spawnedAt: [number, number] | null;
} {
  const { board, gained, moved, mergedAt } = slide(state.board, dir);
  if (!moved) return { state, moved: false, mergedAt: [], spawnedAt: null };

  const nextBoard = spawn(board, rng);
  const spawnedAt = findSpawnedCell(board, nextBoard);
  const score = state.score + gained;
  const best = Math.max(state.best, score);
  return {
    state: { board: nextBoard, score, best, keepPlaying: state.keepPlaying },
    moved: true,
    mergedAt,
    spawnedAt,
  };
}

/** The one cell that differs between a pre-spawn and post-spawn board --
 * null when spawn() was a no-op (board already completely full). */
function findSpawnedCell(before: Board2048, after: Board2048): [number, number] | null {
  for (let r = 0; r < after.length; r++) {
    for (let c = 0; c < after[r].length; c++) {
      if (after[r][c] !== before[r][c]) return [r, c];
    }
  }
  return null;
}

const KEY_DIRECTIONS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  W: "up",
  s: "down",
  S: "down",
  a: "left",
  A: "left",
  d: "right",
  D: "right",
};

/** Arrow keys and WASD (either case) -> a move direction; anything else ->
 * null. Pure so index.tsx's keydown listener stays thin wiring. */
export function directionForKey(key: string): Direction | null {
  return KEY_DIRECTIONS[key] ?? null;
}

export type SwipeState = { x: number; y: number; pointerId: number } | null;

export type SwipeAction =
  | { type: "down"; x: number; y: number; pointerId: number }
  | { type: "up"; x: number; y: number; pointerId: number }
  | { type: "cancel"; pointerId: number };

/**
 * Pure pointer-gesture reducer for touch swipe, no DOM -- see the unit
 * tests in state.test.ts. Single-pointer only, same posture as
 * chess-quest's Board.tsx dragTransition: a second pointer going down while
 * one is already tracked is dropped rather than stealing the slot (that
 * exact bug -- a second finger overwriting the first's start point --
 * shipped once in chess-quest's drag input; see Board.tsx's dragTransition
 * comment). `up`/`cancel` for any pointerId other than the tracked one are
 * ignored the same way.
 */
export function swipeTransition(
  state: SwipeState,
  action: SwipeAction,
  threshold = 24,
): { state: SwipeState; direction: Direction | null } {
  switch (action.type) {
    case "down":
      if (state) return { state, direction: null };
      return { state: { x: action.x, y: action.y, pointerId: action.pointerId }, direction: null };
    case "up": {
      if (!state || action.pointerId !== state.pointerId) return { state, direction: null };
      const direction = swipeDirection(action.x - state.x, action.y - state.y, threshold);
      return { state: null, direction };
    }
    case "cancel": {
      if (!state || action.pointerId !== state.pointerId) return { state, direction: null };
      return { state: null, direction: null };
    }
  }
}

function isValidBoard(v: unknown): v is Board2048 {
  if (!Array.isArray(v) || v.length !== SIZE) return false;
  return v.every(
    (row) =>
      Array.isArray(row) &&
      row.length === SIZE &&
      row.every((cell) => typeof cell === "number" && Number.isFinite(cell) && cell >= 0),
  );
}

/**
 * Coerces whatever JSON.parse handed back into a well-formed GameState --
 * same posture as Daily Word's migrateState and _shared's useGameStore:
 * never trust a stored blob's shape. Throws only for utterly hopeless
 * input (not an object at all), which loadStoredValue catches and turns
 * into INITIAL_STATE plus a console.warn. A malformed `board` specifically
 * falls back to emptyBoard() -- NOT a freshly spawned game -- so recovery
 * funnels through the exact same "mount effect notices an empty board and
 * spawns real tiles" path a brand new player takes (see INITIAL_STATE's
 * comment above); this also means migrateState never needs an rng.
 */
export function migrateState(raw: unknown): GameState {
  if (!raw || typeof raw !== "object") {
    throw new Error("2048: corrupt stored state (not an object)");
  }
  const r = raw as Record<string, unknown>;
  const board = isValidBoard(r.board) ? r.board : emptyBoard();
  const score = typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0;
  const bestRaw = typeof r.best === "number" && Number.isFinite(r.best) ? r.best : 0;
  const best = Math.max(bestRaw, score);
  const keepPlaying = typeof r.keepPlaying === "boolean" ? r.keepPlaying : false;
  return { board, score, best, keepPlaying };
}
