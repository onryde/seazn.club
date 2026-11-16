/**
 * The tennis match behind the tennis page's working demo. A deliberately small model of a deciding set, NOT the
 * engine: games with deuce and advantage, sets with a two-game margin, a tie-break at six games all. Pure and
 * immutable. The rules are PARAMETERS (the engine's, read on the server in tennis-rules.ts), never imports.
 */

export type Side = "a" | "b";

export type TennisRules = {
  /** How the first points of a game are called, in order. */
  calls: string[];
  /** Sets in the match; always odd. */
  bestOf: number;
};

export type TennisState = {
  /** Completed sets, in games, as [a, b]. */
  sets: [number, number][];
  /** Games in the open set. */
  ga: number;
  gb: number;
  /** Points in the open game, counted. */
  pa: number;
  pb: number;
  last: Side | null;
  history: TennisState[];
};

const GAMES = 6;
const TIEBREAK_TO = 7;
const inTiebreak = (s: TennisState) => s.ga === GAMES && s.gb === GAMES;

export function setsWon(s: TennisState): { a: number; b: number } {
  return { a: s.sets.filter(([a, b]) => a > b).length, b: s.sets.filter(([a, b]) => b > a).length };
}

export function matchWinner(s: TennisState, r: TennisRules): Side | null {
  const need = Math.ceil(r.bestOf / 2);
  const won = setsWon(s);
  return won.a >= need ? "a" : won.b >= need ? "b" : null;
}

/** The deciding set, level on sets, the leader serving for the match at 5-4, two points up to one. */
export function openingTennis(r: TennisRules): TennisState {
  const sets = Array.from({ length: r.bestOf - 1 }, (_, i): [number, number] => (i % 2 === 0 ? [6, 4] : [3, 6]));
  return { sets, ga: 5, gb: 4, pa: 2, pb: 1, last: null, history: [] };
}

/** What the scoreboard shows for the open game: the engine's calls, `ad` for advantage, plain numbers in a tie-break. */
export function calls(s: TennisState, r: TennisRules, ad: string): { a: string; b: string } {
  if (inTiebreak(s)) return { a: String(s.pa), b: String(s.pb) };
  const top = r.calls.length - 1;
  if (s.pa <= top && s.pb <= top) return { a: r.calls[s.pa]!, b: r.calls[s.pb]! };
  if (s.pa === s.pb) return { a: r.calls[top]!, b: r.calls[top]! };
  return s.pa > s.pb ? { a: ad, b: r.calls[top]! } : { a: r.calls[top]!, b: ad };
}

export function point(s: TennisState, side: Side, r: TennisRules): TennisState {
  if (matchWinner(s, r)) return s;
  const pa = s.pa + (side === "a" ? 1 : 0);
  const pb = s.pb + (side === "b" ? 1 : 0);
  const base = { last: side, history: [...s.history, s] };
  // A game is won one point past the last call with two clear; a tie-break at seven with two clear.
  const to = inTiebreak(s) ? TIEBREAK_TO : r.calls.length;
  if (Math.max(pa, pb) < to || Math.abs(pa - pb) < 2) return { ...s, pa, pb, ...base };
  const ga = s.ga + (pa > pb ? 1 : 0);
  const gb = s.gb + (pb > pa ? 1 : 0);
  // A set is won at six games with two clear, or at seven (7-5, or the tie-break's 7-6).
  const top = Math.max(ga, gb);
  const setDone = top > GAMES || (top === GAMES && Math.abs(ga - gb) >= 2);
  return setDone
    ? { sets: [...s.sets, [ga, gb]], ga: 0, gb: 0, pa: 0, pb: 0, ...base }
    : { sets: s.sets, ga, gb, pa: 0, pb: 0, ...base };
}

export function undo(s: TennisState): TennisState {
  return s.history[s.history.length - 1] ?? s;
}
