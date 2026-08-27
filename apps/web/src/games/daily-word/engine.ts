// Daily Word engine -- pure functions only (no DOM, no localStorage; state.ts
// and the components own that side of things). Every function here takes
// its inputs explicitly and returns a value with no hidden dependency on
// mutable/global state, except todayISO()/answerFor()'s default argument,
// which resolves "now" once at the call site the same way _shared's
// dailySeed() and chess-quest's lib/progress.tsx do -- see their comments
// for why that's fine for ordinary app code (it's build/workflow scripts
// that must avoid real-time reads, not this).
import { siteOrigin } from "../../lib/site-origin";
import { dailySeed } from "../_shared/daily-seed";
import { ALLOWED } from "./content/allowed";
import { ANSWERS } from "./content/answers";

export type LetterResult = "hit" | "near" | "miss";

const ALLOWED_SET = new Set(ALLOWED);

/**
 * Same local-calendar-day formula as chess-quest's lib/progress.tsx
 * (todayISO) and _shared's daily-seed.ts -- getFullYear/getMonth+1/getDate,
 * zero-padded, LOCAL time (never UTC). Daily Word's rule is "one puzzle per
 * calendar day, local time", so every caller that needs "today" (answerFor's
 * default, the per-day storage key, puzzle-number display) goes through
 * this one formula.
 */
export function todayISO(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

/**
 * Evaluates a 5-letter guess against the answer, producing one of
 * "hit" (right letter, right position) / "near" (right letter, wrong
 * position) / "miss" (letter not present, or already fully accounted for)
 * per position -- the classic Wordle-style genre, including its classic
 * duplicate-letter bug. Two-pass algorithm, the only correct way to handle
 * repeated letters:
 *
 *   Pass 1 (hits): walk both words position by position. Every exact match
 *   is a "hit". For every NON-match position, tally that answer letter into
 *   a `remaining` count -- this is the pool of answer-letters not yet
 *   "claimed" by an exact hit.
 *
 *   Pass 2 (near/miss): walk the guess again, left to right, skipping hits.
 *   For each remaining letter, if `remaining[letter] > 0`, mark it "near"
 *   and decrement the pool; otherwise "miss".
 *
 * Getting this wrong (the classic bug) means marking a guess letter "near"
 * just because it "appears somewhere in the answer", which over-counts
 * when the guess repeats a letter more times than the answer has it -- see
 * this file's test suite (ALLEY/LEVEL, SPEED/ABIDE, ROBOT/MOTOR) for the
 * exact cases that catch that mistake.
 */
export function evaluate(guess: string, answer: string): LetterResult[] {
  const g = guess.toUpperCase().split("");
  const a = answer.toUpperCase().split("");
  const result: LetterResult[] = new Array(g.length).fill("miss");
  const remaining: Record<string, number> = {};

  for (let i = 0; i < a.length; i++) {
    if (g[i] === a[i]) {
      result[i] = "hit";
    } else {
      remaining[a[i]] = (remaining[a[i]] ?? 0) + 1;
    }
  }

  for (let i = 0; i < g.length; i++) {
    if (result[i] === "hit") continue;
    const letter = g[i];
    if ((remaining[letter] ?? 0) > 0) {
      result[i] = "near";
      remaining[letter] -= 1;
    } else {
      result[i] = "miss";
    }
  }

  return result;
}

/** Whether `word` is a legal guess -- membership in the (larger) allowed list. */
export function isValidGuess(word: string): boolean {
  return ALLOWED_SET.has(word.toUpperCase());
}

/**
 * The day's answer, deterministic from `date` (an ISO calendar-date string,
 * local time -- see todayISO()) via _shared's dailySeed, salted with this
 * game's own slug so Daily Word and any future daily game landing on the
 * same date never draw the same index from their own content lists.
 */
export function answerFor(date: string = todayISO()): string {
  const seed = dailySeed(date, "daily-word");
  return ANSWERS[seed % ANSWERS.length];
}

// Daily Word's epoch: the calendar day this game launched, so puzzle #1 is
// the first day it was playable (the same convention Wordle-likes use --
// "Wordle 269" counts days since ITS launch, not some other reference).
// Keep this in sync with engine.test.ts's puzzleNumber tests.
const LAUNCH_DATE = "2026-08-27";

/** Days between two ISO calendar-date strings, computed via UTC-midnight
 * instants for both so the result is an exact integer with no DST skew --
 * safe because only the Y/M/D components are ever read out of the string,
 * never a local-timezone Date parse of it. */
function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const fromUTC = Date.UTC(fy, fm - 1, fd);
  const toUTC = Date.UTC(ty, tm - 1, td);
  return Math.round((toUTC - fromUTC) / 86_400_000);
}

/** The puzzle number shown in the share text ("Seazn Word #N …") for the
 * calendar day `date` -- 1 on LAUNCH_DATE, incrementing once per day after.
 * Clamped to a minimum of 1 so a misconfigured system clock set earlier
 * than LAUNCH_DATE can never display "#0" or a negative puzzle number. */
export function puzzleNumber(date: string): number {
  return Math.max(1, daysBetween(LAUNCH_DATE, date) + 1);
}

/**
 * Best-status-per-letter across every guess so far, for coloring the
 * on-screen keyboard. A letter's status only ever upgrades (miss < near <
 * hit) as more guesses come in -- once a key has shown green, a later guess
 * that happens to show that same letter as grey elsewhere must not paint
 * over the green.
 */
export function keyStatuses(guesses: string[], answer: string): Partial<Record<string, LetterResult>> {
  const rank: Record<LetterResult, number> = { miss: 0, near: 1, hit: 2 };
  const best: Partial<Record<string, LetterResult>> = {};

  for (const guess of guesses) {
    const results = evaluate(guess, answer);
    const letters = guess.toUpperCase().split("");
    for (let i = 0; i < letters.length; i++) {
      const letter = letters[i];
      const result = results[i];
      const current = best[letter];
      if (!current || rank[result] > rank[current]) {
        best[letter] = result;
      }
    }
  }

  return best;
}

const RESULT_EMOJI: Record<LetterResult, string> = {
  hit: "🟩",
  near: "🟨",
  miss: "⬛",
};

/**
 * Spoiler-free share text: "Seazn Word #N x/6" (x is the guess count that
 * won, or "X" on a loss) followed by an emoji-only grid -- no letters ever,
 * matching the genre's standing convention (the design doc: "no letters").
 */
export function shareText(puzzle: number, guesses: string[], answer: string, maxGuesses = 6): string {
  const won = guesses.some((g) => g.toUpperCase() === answer.toUpperCase());
  const scoreLabel = won ? String(guesses.length) : "X";
  const grid = guesses
    .map((g) => evaluate(g, answer).map((r) => RESULT_EMOJI[r]).join(""))
    .join("\n");
  // Absolute, not "/games/daily-word" -- on the games.* subdomain the proxy
  // rewrites relative paths oddly for anything other than "/" and "/games"
  // (see gamesHostRewrite in proxy.ts, and the identical fix already applied
  // to the Powered-by links in app/games/**), so a shared link needs to be
  // unambiguous regardless of which host the sharer is actually on.
  return `Seazn Word #${puzzle} ${scoreLabel}/${maxGuesses}\n\n${grid}\n\n${siteOrigin()}/games/daily-word`;
}
