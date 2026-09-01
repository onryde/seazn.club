"use client";

// 2048 -- thin glue only: all the real logic lives in engine.ts (slide/
// spawn/canMove/hasWon/swipeDirection, pure) and state.ts (applyMove/
// newGame/migrateState/directionForKey/swipeTransition, pure). This
// component wires physical keydown + pointer swipe to those, and
// useGameStore (from _shared) to migrateState for persistence -- the same
// pure-reducer/thin-glue split Board.tsx uses for dragTransition/
// runDragAction, and Daily Word's index.tsx uses for handleKey.
import "./2048.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { GameFrame } from "../_shared/game-frame";
import { useGameStore } from "../_shared/use-game-store";
import { Board } from "./components/Board";
import { canMove, hasWon, isEmptyBoard, type Board2048, type Direction } from "./engine";
import {
  applyMove,
  directionForKey,
  INITIAL_STATE,
  migrateState,
  newGame,
  STORAGE_KEY,
  swipeTransition,
  type GameState,
  type SwipeState,
} from "./state";

type CellAnims = Map<string, "spawn" | "merge">;

function cellKey(r: number, c: number): string {
  return `${r}-${c}`;
}

/** Every non-zero cell on a just-built board, marked "spawn" -- used for
 * newGame()'s two opening tiles, where there's no prior board to diff
 * against and none needed: a fresh board is unambiguously all new. */
function animsForFreshBoard(b: Board2048): CellAnims {
  const anims: CellAnims = new Map();
  for (let r = 0; r < b.length; r++) {
    for (let c = 0; c < b[r].length; c++) {
      if (b[r][c] !== 0) anims.set(cellKey(r, c), "spawn");
    }
  }
  return anims;
}

/** Turns applyMove's exact mergedAt/spawnedAt positions into the Map Board
 * expects -- straight from data the pure layer already computed, never a
 * before/after board diff (see state.ts's applyMove comment for why a diff
 * can't reliably tell "merge" apart from "spawn" apart from "just slid"). */
function animsForMove(mergedAt: [number, number][], spawnedAt: [number, number] | null): CellAnims {
  const anims: CellAnims = new Map();
  for (const [r, c] of mergedAt) anims.set(cellKey(r, c), "merge");
  if (spawnedAt) anims.set(cellKey(spawnedAt[0], spawnedAt[1]), "spawn");
  return anims;
}

export default function Game2048() {
  const [state, setState] = useGameStore<GameState>(STORAGE_KEY, INITIAL_STATE, migrateState);

  // Which cells just spawned or merged, for Board's animation classes --
  // set directly from applyMove/newGame's own exact positions (never
  // inferred by diffing boards -- see animsForMove's comment and
  // state.ts's applyMove for the live-check-caught bug that approach had).
  const [cellAnims, setCellAnims] = useState<CellAnims>(new Map());
  const [animGen, setAnimGen] = useState(0);

  // First-ever visit (or recovery from a corrupt stored board -- see
  // state.ts's INITIAL_STATE comment): migrate never ran, so the board may
  // still be the "uninitialized" empty sentinel. Correct it here,
  // unconditionally on every mount, rather than inside migrate -- exactly
  // the fix Daily Word's own lastPlayedDate sentinel bug called for (see
  // reference_use_game_store_first_load_bypasses_migrate.md: useGameStore
  // skips `migrate` entirely the first time, before anything is stored).
  const isUninitialized = isEmptyBoard(state.board);
  useEffect(() => {
    if (!isUninitialized) return;
    setState(newGame(state.best));
  }, [isUninitialized, state.best, setState]);

  const move = useCallback(
    (dir: Direction) => {
      const { state: next, moved, mergedAt, spawnedAt } = applyMove(state, dir);
      if (!moved) return;
      setState(next);
      setCellAnims(animsForMove(mergedAt, spawnedAt));
      setAnimGen((g) => g + 1);
    },
    [state, setState],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const dir = directionForKey(e.key);
      if (!dir) return;
      e.preventDefault();
      move(dir);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [move]);

  // Touch swipe -- swipeTransition (state.ts) is the pure decision; this is
  // just the DOM wiring, same split as chess-quest's Board.tsx pointer
  // handlers around dragTransition/runDragAction. touch-action below is set
  // STATICALLY, never toggled off a `swiping` state: the browser decides
  // whether a real touch gesture is a page-scroll/pan or an app-handled
  // gesture AT touchstart, using whatever touch-action value is already in
  // effect at that instant -- a value a React re-render commits a few ms
  // later is always too late to change that decision. (A reactive
  // `swiping`-gated flip shipped here once; on a real touchscreen the
  // browser had already claimed every swipe as a page scroll before the
  // state update landed, so no swipe ever reached the board.)
  const swipeRef = useRef<SwipeState>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const { state: next } = swipeTransition(swipeRef.current, {
      type: "down",
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
    });
    swipeRef.current = next;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const { state: next, direction } = swipeTransition(swipeRef.current, {
      type: "up",
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
    });
    swipeRef.current = next;
    if (direction) move(direction);
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const { state: next } = swipeTransition(swipeRef.current, { type: "cancel", pointerId: e.pointerId });
    swipeRef.current = next;
  };

  const gameOver = !canMove(state.board);
  const won = hasWon(state.board);
  const showBanner = won && !state.keepPlaying;

  const handleNewGame = () => {
    const next = newGame(state.best);
    setState(next);
    setCellAnims(animsForFreshBoard(next.board));
    setAnimGen((g) => g + 1);
  };
  const dismissBanner = () => setState((prev) => ({ ...prev, keepPlaying: true }));

  const status = showBanner ? (
    <div className="flex items-center justify-between gap-3">
      <span>🎉 You reached 2048!</span>
      <button
        type="button"
        onClick={dismissBanner}
        className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold text-white"
      >
        Keep playing
      </button>
    </div>
  ) : gameOver ? (
    `Game over — final score ${state.score}.`
  ) : (
    "Arrow keys, WASD, or swipe to move tiles."
  );

  return (
    <GameFrame
      title="2048"
      score={`Score: ${state.score} · Best: ${state.best}`}
      status={status}
      footer={
        <button
          type="button"
          onClick={handleNewGame}
          className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-900"
        >
          New game
        </button>
      }
    >
      <div
        data-testid="2048-swipe-area"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ touchAction: "none" }}
      >
        <Board board={state.board} anims={cellAnims} moveGen={animGen} />
      </div>
    </GameFrame>
  );
}
