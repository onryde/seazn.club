// Daily Word state -- pure reducer for keyboard input (handleKey), stats
// bookkeeping (updateStats), day-rollover (applyRollover) and storage
// coercion (migrateState). No DOM, no localStorage read/write of its own --
// index.tsx is the thin glue that wires physical keydown + on-screen
// keyboard taps to handleKey, and useGameStore (from _shared) to
// migrateState, the same pure-reducer/thin-glue split Board.tsx uses for
// dragTransition/runDragAction.
import { isValidGuess } from "./engine";

export const STORAGE_KEY = "seazn-games:daily-word:v1";
export const MAX_GUESSES = 6;
export const WORD_LENGTH = 5;

export type GameStatus = "playing" | "won" | "lost";

export type Stats = {
  played: number;
  wins: number;
  currentStreak: number;
  maxStreak: number;
  /** Wins-by-guess-count histogram; index 0 = won in 1 guess, ... index 5 = won in 6. */
  distribution: [number, number, number, number, number, number];
};

export const INITIAL_STATS: Stats = {
  played: 0,
  wins: 0,
  currentStreak: 0,
  maxStreak: 0,
  distribution: [0, 0, 0, 0, 0, 0],
};

/** The persisted shape, under STORAGE_KEY. `guesses`/`status` belong to
 * whatever day `lastPlayedDate` names -- applyRollover resets them (but
 * never `stats`) once "today" has moved on. The in-progress (not yet
 * submitted) row is deliberately NOT here: it's ephemeral component state,
 * same posture as a half-typed form field -- only completed guesses need
 * to survive a reload. */
export type DailyWordState = {
  lastPlayedDate: string;
  guesses: string[];
  status: GameStatus;
  stats: Stats;
};

export const INITIAL_STATE: DailyWordState = {
  lastPlayedDate: "",
  guesses: [],
  status: "playing",
  stats: INITIAL_STATS,
};

/** The live-typing view handleKey operates over: today's persisted
 * guesses/status, plus the in-progress row. */
export type RowState = {
  current: string;
  guesses: string[];
  status: GameStatus;
};

export type KeyAction = { type: "letter"; key: string } | { type: "backspace" } | { type: "enter" };

export type KeyError = "too-short" | "invalid-word";

/**
 * Pure keyboard reducer -- no DOM. Handles a single physical keydown or
 * on-screen key tap: typing a letter, backspace, or submitting the row on
 * enter (validated against the allowed-word list, then scored against
 * `answer` to decide win/loss). Once `state.status` is no longer "playing"
 * every action is a no-op -- the puzzle for the day is over.
 */
export function handleKey(
  state: RowState,
  action: KeyAction,
  answer: string,
): { state: RowState; error?: KeyError } {
  if (state.status !== "playing") return { state };

  switch (action.type) {
    case "letter": {
      if (state.current.length >= WORD_LENGTH) return { state };
      if (!/^[a-zA-Z]$/.test(action.key)) return { state };
      return { state: { ...state, current: state.current + action.key.toUpperCase() } };
    }

    case "backspace": {
      if (state.current.length === 0) return { state };
      return { state: { ...state, current: state.current.slice(0, -1) } };
    }

    case "enter": {
      if (state.current.length < WORD_LENGTH) {
        return { state, error: "too-short" };
      }
      if (!isValidGuess(state.current)) {
        return { state, error: "invalid-word" };
      }
      const guesses = [...state.guesses, state.current];
      const won = state.current.toUpperCase() === answer.toUpperCase();
      const lost = !won && guesses.length >= MAX_GUESSES;
      const status: GameStatus = won ? "won" : lost ? "lost" : "playing";
      return { state: { current: "", guesses, status } };
    }
  }
}

/**
 * Stats bookkeeping for one just-finished game -- called exactly once, by
 * the caller, at the moment handleKey's `enter` transitions status away
 * from "playing" (kept separate from handleKey itself so keystroke
 * handling and stats bookkeeping stay two independently-testable
 * concerns).
 */
export function updateStats(stats: Stats, outcome: "won" | "lost", guessCount: number): Stats {
  const played = stats.played + 1;
  const wins = stats.wins + (outcome === "won" ? 1 : 0);
  const currentStreak = outcome === "won" ? stats.currentStreak + 1 : 0;
  const maxStreak = Math.max(stats.maxStreak, currentStreak);
  const distribution = [...stats.distribution] as Stats["distribution"];
  if (outcome === "won" && guessCount >= 1 && guessCount <= MAX_GUESSES) {
    distribution[guessCount - 1] += 1;
  }
  return { played, wins, currentStreak, maxStreak, distribution };
}

/**
 * Builds the persisted DailyWordState after a guess has just been
 * submitted. Always stamps `today` into `lastPlayedDate` explicitly --
 * never derived from `prev.lastPlayedDate` -- because _shared's
 * useGameStore returns `initial` (INITIAL_STATE, whose lastPlayedDate is
 * the "" sentinel) on a player's very first-ever visit WITHOUT ever
 * calling `migrate` at all (see use-game-store.ts's loadStoredValue:
 * nothing stored yet short-circuits on `item == null` before migrate/
 * applyRollover ever run). If this function instead spread `...prev`,
 * that "" sentinel would be written to storage as part of the player's
 * first real save; the NEXT load -- now with a non-null stored value, so
 * migrate DOES run this time -- would see "" !== today and applyRollover
 * would wrongly treat the player's own just-submitted guess as belonging
 * to a stale prior day, wiping it on reload. Found via a live browser
 * check (unit tests alone never exercised the "nothing stored yet"
 * bypass); see state.test.ts's regression case.
 */
export function applyGuessResult(
  prev: DailyWordState,
  next: { guesses: string[]; status: GameStatus },
  today: string,
): DailyWordState {
  const justEnded = prev.status === "playing" && next.status !== "playing";
  const stats = justEnded
    ? updateStats(prev.stats, next.status as "won" | "lost", next.guesses.length)
    : prev.stats;
  return { lastPlayedDate: today, guesses: next.guesses, status: next.status, stats };
}

/**
 * "One puzzle per calendar day": if the persisted state belongs to an
 * earlier day than `today`, start a fresh row (empty guesses, status back
 * to "playing") but keep `stats` -- stats span every day played, not just
 * today's. A same-day load is returned unchanged.
 */
export function applyRollover(state: DailyWordState, today: string): DailyWordState {
  if (state.lastPlayedDate === today) return state;
  return { ...state, lastPlayedDate: today, guesses: [], status: "playing" };
}

function migrateStats(raw: unknown): Stats {
  if (!raw || typeof raw !== "object") return INITIAL_STATS;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const distribution =
    Array.isArray(r.distribution) && r.distribution.length === 6
      ? (r.distribution.map(num) as Stats["distribution"])
      : ([...INITIAL_STATS.distribution] as Stats["distribution"]);
  return {
    played: num(r.played),
    wins: num(r.wins),
    currentStreak: num(r.currentStreak),
    maxStreak: num(r.maxStreak),
    distribution,
  };
}

/**
 * Coerces whatever JSON.parse handed back into a well-formed
 * DailyWordState -- same posture as chess-quest's progress.tsx and
 * _shared's use-game-store: never trust a stored blob's shape. Throws only
 * for utterly hopeless input (not an object at all), which loadStoredValue
 * catches and turns into INITIAL_STATE plus a console.warn; anything that
 * IS an object gets coerced field by field so one corrupt field (say,
 * `guesses`) doesn't have to take stats down with it.
 */
export function migrateState(raw: unknown): DailyWordState {
  if (!raw || typeof raw !== "object") {
    throw new Error("Daily Word: corrupt stored state (not an object)");
  }
  const r = raw as Record<string, unknown>;
  const guesses = Array.isArray(r.guesses) ? r.guesses.filter((g): g is string => typeof g === "string") : [];
  const status: GameStatus = r.status === "won" || r.status === "lost" ? r.status : "playing";
  const lastPlayedDate = typeof r.lastPlayedDate === "string" ? r.lastPlayedDate : "";
  return { lastPlayedDate, guesses, status, stats: migrateStats(r.stats) };
}
