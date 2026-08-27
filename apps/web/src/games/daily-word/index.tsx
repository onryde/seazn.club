"use client";

// Daily Word -- a Wordle-style daily puzzle. Thin glue only: all the real
// logic lives in engine.ts (evaluate/answerFor/etc., pure) and state.ts
// (handleKey/updateStats/applyRollover/migrateState, pure). This component
// wires physical keydown + on-screen Keyboard taps to the same handleKey
// reducer (the same pure-reducer/thin-glue split Board.tsx uses for
// dragTransition/runDragAction), and useGameStore (from _shared) to
// migrateState for persistence.
import { useCallback, useEffect, useState } from "react";
import { GameFrame } from "../_shared/game-frame";
import { ShareResult } from "../_shared/share-result";
import { useGameStore } from "../_shared/use-game-store";
import { Grid } from "./components/Grid";
import { Keyboard } from "./components/Keyboard";
import { answerFor, keyStatuses, puzzleNumber, shareText, todayISO } from "./engine";
import {
  applyGuessResult,
  applyRollover,
  handleKey,
  INITIAL_STATE,
  MAX_GUESSES,
  migrateState,
  STORAGE_KEY,
  type DailyWordState,
  type KeyAction,
  type RowState,
} from "./state";

function keyActionFor(label: string): KeyAction {
  if (label === "ENTER") return { type: "enter" };
  if (label === "BACKSPACE") return { type: "backspace" };
  return { type: "letter", key: label };
}

export default function DailyWord() {
  // Resolved once per mount via useGameStore's migrate (see use-game-store.ts:
  // its lazy useState initializer only ever runs on mount), which is exactly
  // when "today" should be captured for a "one puzzle per calendar day" game.
  const today = todayISO();
  const answer = answerFor(today);

  const migrate = (raw: unknown) => applyRollover(migrateState(raw), today);
  const [state, setState] = useGameStore<DailyWordState>(STORAGE_KEY, INITIAL_STATE, migrate);

  const [current, setCurrent] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(id);
  }, [toast]);

  const dispatch = useCallback(
    (action: KeyAction) => {
      const rowState: RowState = { current, guesses: state.guesses, status: state.status };
      const { state: next, error } = handleKey(rowState, action, answer);
      setCurrent(next.current);

      if (error) {
        setToast(error === "too-short" ? "Not enough letters" : "Not in word list");
        return;
      }

      const guessSubmitted = next.guesses.length !== state.guesses.length;
      if (guessSubmitted) {
        setState((prev) => applyGuessResult(prev, next, today));
      }
    },
    [current, state, answer, today, setState],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        dispatch({ type: "enter" });
      } else if (e.key === "Backspace") {
        e.preventDefault();
        dispatch({ type: "backspace" });
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        dispatch({ type: "letter", key: e.key });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  const gameOver = state.status !== "playing";
  const puzzle = puzzleNumber(today);
  const statuses = keyStatuses(state.guesses, answer);
  const winPct = state.stats.played > 0 ? Math.round((state.stats.wins / state.stats.played) * 100) : 0;

  const status = gameOver
    ? state.status === "won"
      ? `Nice! You got it in ${state.guesses.length}/${MAX_GUESSES}.`
      : `So close -- the word was ${answer}.`
    : (toast ?? `Guess ${state.guesses.length + 1} of ${MAX_GUESSES} -- 5-letter word.`);

  return (
    <GameFrame
      title="Daily Word"
      score={`🔥 ${state.stats.currentStreak} · 🏆 ${winPct}%`}
      status={status}
      footer={
        gameOver ? (
          <ShareResult text={shareText(puzzle, state.guesses, answer, MAX_GUESSES)} label="Share result" />
        ) : undefined
      }
    >
      <div className="flex flex-col items-center gap-5">
        <Grid guesses={state.guesses} current={current} answer={answer} />
        <Keyboard statuses={statuses} onKey={(key) => dispatch(keyActionFor(key))} />
      </div>
    </GameFrame>
  );
}
