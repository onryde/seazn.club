// The five sentences a "+5 min" that is not offered once said in its place ("Can't extend check-in: a game has started", ...). Match Day
// prints none of them (Task 7 M5, owner sign-off), and since B1 the dictionary carries none either: the keys, their four translations
// and the helpers that read them were deleted because nothing drew them. The words live HERE, typed, so the guard that no screen says them
// again does not depend on a key that exists - a re-added line under any key still has to say one of these to be caught, and a copy of it
// under a NEW key and different words is caught by the lead-in. Used by the unit renders (help-checkin-extend-copy, board-focus,
// round-focus) and by e2e/checkin-extend.spec.ts.
export const RETIRED_EXTEND_REASONS = {
  gameStarted: "Can't extend check-in: a game has started",
  capReached: "Can't extend check-in: no extensions left",
  notOpen: "Can't extend check-in: it hasn't opened yet",
  closed: "Can't extend check-in: it has closed",
  roundNoneOpen: "No board can be extended right now",
} as const;

/** What the four per-board reasons share, and the one the round says for a mix: a reason in any other words still starts like this. */
export const RETIRED_EXTEND_REASON_LEADS = ["Can't extend check-in", "No board can be extended"] as const;

/** Every retired sentence and lead-in, for a probe that wants any of them. */
export const RETIRED_EXTEND_WORDS: readonly string[] = [...Object.values(RETIRED_EXTEND_REASONS), ...RETIRED_EXTEND_REASON_LEADS];
