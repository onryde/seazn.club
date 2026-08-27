// Daily Word state -- pure reducer (handleKey), stats bookkeeping
// (updateStats), day-rollover (applyRollover), and storage coercion
// (migrateState). No DOM: this workspace has no jsdom (see _shared's
// use-game-store.test.tsx header for the same fact), and per the design
// doc's own guidance for W2's drag input, keyboard handling is split into
// a pure, directly-testable reducer with a thin DOM-glue wrapper in
// index.tsx -- the same split Board.tsx uses for dragTransition/
// runDragAction, and _shared/use-game-store.ts uses for
// loadStoredValue/saveStoredValue.
import { describe, expect, it } from "vitest";
import { loadStoredValue, saveStoredValue } from "../../_shared/use-game-store";
import {
  applyGuessResult,
  applyRollover,
  handleKey,
  INITIAL_STATE,
  INITIAL_STATS,
  migrateState,
  STORAGE_KEY,
  updateStats,
  type DailyWordState,
  type RowState,
} from "../state";

const ANSWER = "MOTOR";

// Minimal in-memory Storage, same shape as _shared/use-game-store.test.tsx's
// fakeStorage().
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

describe("handleKey -- letter", () => {
  it("appends an uppercase letter to the current row", () => {
    const state: RowState = { current: "", guesses: [], status: "playing" };
    const { state: next } = handleKey(state, { type: "letter", key: "m" }, ANSWER);
    expect(next.current).toBe("M");
  });

  it("ignores a letter once the row already has 5 characters", () => {
    const state: RowState = { current: "MOTOR", guesses: [], status: "playing" };
    const { state: next } = handleKey(state, { type: "letter", key: "x" }, ANSWER);
    expect(next.current).toBe("MOTOR");
  });

  it("ignores non-alphabetic keys", () => {
    const state: RowState = { current: "MO", guesses: [], status: "playing" };
    expect(handleKey(state, { type: "letter", key: "1" }, ANSWER).state.current).toBe("MO");
    expect(handleKey(state, { type: "letter", key: "-" }, ANSWER).state.current).toBe("MO");
    expect(handleKey(state, { type: "letter", key: "Enter" }, ANSWER).state.current).toBe("MO");
  });
});

describe("handleKey -- backspace", () => {
  it("removes the last character", () => {
    const state: RowState = { current: "MOT", guesses: [], status: "playing" };
    const { state: next } = handleKey(state, { type: "backspace" }, ANSWER);
    expect(next.current).toBe("MO");
  });

  it("is a no-op on an empty row", () => {
    const state: RowState = { current: "", guesses: [], status: "playing" };
    const { state: next } = handleKey(state, { type: "backspace" }, ANSWER);
    expect(next.current).toBe("");
  });
});

describe("handleKey -- enter", () => {
  it("reports too-short and leaves the row untouched under 5 letters", () => {
    const state: RowState = { current: "MOT", guesses: [], status: "playing" };
    const { state: next, error } = handleKey(state, { type: "enter" }, ANSWER);
    expect(error).toBe("too-short");
    expect(next.current).toBe("MOT");
    expect(next.guesses).toEqual([]);
  });

  it("reports invalid-word for a 5-letter non-word and leaves the row untouched", () => {
    const state: RowState = { current: "ZZZZZ", guesses: [], status: "playing" };
    const { state: next, error } = handleKey(state, { type: "enter" }, ANSWER);
    expect(error).toBe("invalid-word");
    expect(next.current).toBe("ZZZZZ");
    expect(next.guesses).toEqual([]);
  });

  it("submits a valid guess: clears the row and appends to guesses", () => {
    const state: RowState = { current: "ROBOT", guesses: [], status: "playing" };
    const { state: next, error } = handleKey(state, { type: "enter" }, ANSWER);
    expect(error).toBeUndefined();
    expect(next.current).toBe("");
    expect(next.guesses).toEqual(["ROBOT"]);
    expect(next.status).toBe("playing");
  });

  it("sets status to won when the guess matches the answer", () => {
    const state: RowState = { current: "MOTOR", guesses: ["ROBOT"], status: "playing" };
    const { state: next } = handleKey(state, { type: "enter" }, ANSWER);
    expect(next.status).toBe("won");
  });

  it("sets status to lost on the 6th non-matching guess", () => {
    const state: RowState = {
      current: "ROBOT",
      guesses: ["ROBOT", "ROBOT", "ROBOT", "ROBOT", "ROBOT"],
      status: "playing",
    };
    const { state: next } = handleKey(state, { type: "enter" }, ANSWER);
    expect(next.guesses).toHaveLength(6);
    expect(next.status).toBe("lost");
  });

  it("stays playing on the 6th guess if it's the winning one", () => {
    const state: RowState = {
      current: "MOTOR",
      guesses: ["ROBOT", "ROBOT", "ROBOT", "ROBOT", "ROBOT"],
      status: "playing",
    };
    const { state: next } = handleKey(state, { type: "enter" }, ANSWER);
    expect(next.status).toBe("won");
  });
});

describe("handleKey -- game already over", () => {
  it("ignores letter/backspace/enter once status is won", () => {
    const state: RowState = { current: "", guesses: ["MOTOR"], status: "won" };
    expect(handleKey(state, { type: "letter", key: "a" }, ANSWER).state).toEqual(state);
    expect(handleKey(state, { type: "backspace" }, ANSWER).state).toEqual(state);
    expect(handleKey(state, { type: "enter" }, ANSWER).state).toEqual(state);
  });

  it("ignores further input once status is lost", () => {
    const state: RowState = {
      current: "ROBOT",
      guesses: ["ROBOT", "ROBOT", "ROBOT", "ROBOT", "ROBOT", "ROBOT"],
      status: "lost",
    };
    expect(handleKey(state, { type: "letter", key: "a" }, ANSWER).state).toEqual(state);
  });
});

describe("updateStats", () => {
  it("records a win: played, wins, currentStreak and distribution all move", () => {
    const stats = updateStats(INITIAL_STATS, "won", 3);
    expect(stats.played).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.currentStreak).toBe(1);
    expect(stats.maxStreak).toBe(1);
    expect(stats.distribution).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it("records a loss: played moves, wins/streak do not, streak resets", () => {
    const afterWin = updateStats(INITIAL_STATS, "won", 2);
    const afterLoss = updateStats(afterWin, "lost", 6);
    expect(afterLoss.played).toBe(2);
    expect(afterLoss.wins).toBe(1);
    expect(afterLoss.currentStreak).toBe(0);
    expect(afterLoss.maxStreak).toBe(1); // a loss never raises maxStreak, and never erases it
  });

  it("keeps maxStreak at the historical peak across a broken streak", () => {
    let stats = INITIAL_STATS;
    stats = updateStats(stats, "won", 1);
    stats = updateStats(stats, "won", 1);
    stats = updateStats(stats, "won", 1); // currentStreak 3, maxStreak 3
    stats = updateStats(stats, "lost", 6); // currentStreak resets to 0
    stats = updateStats(stats, "won", 1); // currentStreak back to 1
    expect(stats.currentStreak).toBe(1);
    expect(stats.maxStreak).toBe(3);
  });
});

describe("applyRollover", () => {
  const played: DailyWordState = {
    lastPlayedDate: "2026-08-27",
    guesses: ["ROBOT"],
    status: "playing",
    stats: { ...INITIAL_STATS, played: 4 },
  };

  it("leaves state untouched when it's still the same calendar day", () => {
    expect(applyRollover(played, "2026-08-27")).toEqual(played);
  });

  it("resets guesses and status, keeps stats, and stamps the new day", () => {
    const next = applyRollover(played, "2026-08-28");
    expect(next.lastPlayedDate).toBe("2026-08-28");
    expect(next.guesses).toEqual([]);
    expect(next.status).toBe("playing");
    expect(next.stats).toEqual(played.stats);
  });
});

describe("migrateState", () => {
  it("round-trips a well-formed value", () => {
    const value: DailyWordState = {
      lastPlayedDate: "2026-08-27",
      guesses: ["ROBOT", "MOTOR"],
      status: "won",
      stats: { played: 5, wins: 3, currentStreak: 2, maxStreak: 4, distribution: [0, 1, 1, 1, 0, 0] },
    };
    expect(migrateState(value)).toEqual(value);
  });

  it("throws on a hopeless (non-object) value, so loadStoredValue can fall back", () => {
    expect(() => migrateState(null)).toThrow();
    expect(() => migrateState("garbage")).toThrow();
  });

  it("coerces a corrupt guesses field to an empty array instead of discarding everything", () => {
    const result = migrateState({ lastPlayedDate: "2026-08-27", guesses: "not-an-array", status: "playing" });
    expect(result.guesses).toEqual([]);
    expect(result.lastPlayedDate).toBe("2026-08-27");
  });

  it("falls back to INITIAL_STATS when stats is corrupt", () => {
    const result = migrateState({ guesses: [], status: "playing", stats: "nope" });
    expect(result.stats).toEqual(INITIAL_STATS);
  });
});

describe("applyGuessResult", () => {
  it("always stamps today, even from the uninitialized '' sentinel (regression)", () => {
    // Regression: found via a live browser check, not a unit test. _shared's
    // loadStoredValue returns INITIAL_STATE (lastPlayedDate: "") on a
    // player's first-ever visit WITHOUT calling migrate/applyRollover at
    // all (nothing stored yet short-circuits before migrate ever runs). A
    // version of this function that spread `...prev` instead of stamping
    // `today` would carry that "" sentinel into the first real save; the
    // NEXT load (now non-null, so migrate DOES run) would see "" !== today
    // and applyRollover would wipe the player's own just-submitted guess.
    const result = applyGuessResult(INITIAL_STATE, { guesses: ["CRANE"], status: "playing" }, "2026-08-27");
    expect(result.lastPlayedDate).toBe("2026-08-27");
    expect(result.guesses).toEqual(["CRANE"]);
  });

  it("survives the exact first-visit-then-reload sequence through loadStoredValue/saveStoredValue", () => {
    const storage = fakeStorage();
    const today = "2026-08-27";
    const migrate = (raw: unknown) => applyRollover(migrateState(raw), today);

    // First-ever visit: nothing stored yet, so migrate never runs.
    const firstLoad = loadStoredValue(storage, STORAGE_KEY, INITIAL_STATE, migrate);
    expect(firstLoad).toEqual(INITIAL_STATE);

    // Player submits one guess; index.tsx's dispatch calls this on every
    // submitted guess.
    const afterGuess = applyGuessResult(firstLoad, { guesses: ["CRANE"], status: "playing" }, today);
    saveStoredValue(storage, STORAGE_KEY, afterGuess);

    // Reload, same day: migrate DOES run this time (non-null stored value).
    // The guess must still be there.
    const reloaded = loadStoredValue(storage, STORAGE_KEY, INITIAL_STATE, migrate);
    expect(reloaded.guesses).toEqual(["CRANE"]);
    expect(reloaded.lastPlayedDate).toBe(today);
  });

  it("bumps stats exactly once, the moment a guess ends the game", () => {
    const result = applyGuessResult(INITIAL_STATE, { guesses: ["MOTOR"], status: "won" }, "2026-08-27");
    expect(result.stats.played).toBe(1);
    expect(result.stats.wins).toBe(1);
    expect(result.stats.currentStreak).toBe(1);
  });

  it("leaves stats untouched while the game is still playing", () => {
    const result = applyGuessResult(INITIAL_STATE, { guesses: ["CRANE"], status: "playing" }, "2026-08-27");
    expect(result.stats).toEqual(INITIAL_STATS);
  });

  it("does not double-count stats for a guess submitted after the game already ended", () => {
    const won: DailyWordState = { ...INITIAL_STATE, status: "won", stats: updateStats(INITIAL_STATS, "won", 3) };
    // handleKey itself refuses further input once status !== "playing", so
    // this shouldn't happen in practice -- but applyGuessResult must still
    // not re-bump stats if it's ever called after the fact.
    const result = applyGuessResult(won, { guesses: won.guesses, status: won.status }, "2026-08-27");
    expect(result.stats).toEqual(won.stats);
  });
});

describe("stats/persistence round-trip via useGameStore's storage helpers", () => {

  it("round-trips a played state through save/load under STORAGE_KEY", () => {
    const storage = fakeStorage();
    const played: DailyWordState = {
      lastPlayedDate: "2026-08-27",
      guesses: ["ROBOT"],
      status: "playing",
      stats: updateStats(INITIAL_STATS, "won", 4),
    };
    saveStoredValue(storage, STORAGE_KEY, played);
    const loaded = loadStoredValue(storage, STORAGE_KEY, INITIAL_STATE, migrateState);
    expect(loaded).toEqual(played);
  });

  it("falls back to INITIAL_STATE when nothing is stored yet", () => {
    const storage = fakeStorage();
    expect(loadStoredValue(storage, STORAGE_KEY, INITIAL_STATE, migrateState)).toEqual(INITIAL_STATE);
  });
});
