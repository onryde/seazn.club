/**
 * The rally match behind the badminton, table tennis and volleyball pages' working demo. A deliberately small model of
 * a deciding set, NOT the engine: it exists so a visitor can tap a pad and watch the other screens move, on a public,
 * statically cached page with no match behind it. Pure and immutable.
 *
 * The rules are PARAMETERS, never imports: they are the engine's declarations, read on the server (rally-rules.ts) and
 * passed down, because this file ships to the browser and the engine must not.
 */

export type Side = "a" | "b";

export type RallyRules = {
  /** Sets in the match; always odd. */
  bestOf: number;
  /** The points a set is played to, by set index. */
  targets: number[];
  /** The score at which a set ends whatever the lead. */
  bound: number;
};

export type RallyState = {
  /** Completed sets, as [a, b]. */
  sets: [number, number][];
  a: number;
  b: number;
  last: Side | null;
  history: RallyState[];
};

/** A set is won at its target with two clear, or outright at the bound. */
function setWinner(a: number, b: number, target: number, bound: number): Side | null {
  const top = Math.max(a, b);
  if (top < target) return null;
  if (top < bound && Math.abs(a - b) < 2) return null;
  return a > b ? "a" : "b";
}

export function setsWon(s: RallyState, r: RallyRules): { a: number; b: number } {
  const won = { a: 0, b: 0 };
  s.sets.forEach(([a, b], i) => {
    const w = setWinner(a, b, r.targets[i]!, r.bound);
    if (w) won[w] += 1;
  });
  return won;
}

export function matchWinner(s: RallyState, r: RallyRules): Side | null {
  const need = Math.ceil(r.bestOf / 2);
  const won = setsWon(s, r);
  return won.a >= need ? "a" : won.b >= need ? "b" : null;
}

/** The deciding set, level on sets, the leader three points from the match: a few taps finish it. */
export function openingRally(r: RallyRules): RallyState {
  const sets = Array.from({ length: r.bestOf - 1 }, (_, i): [number, number] => {
    const t = r.targets[i]!;
    return i % 2 === 0 ? [t, t - 3] : [t - 4, t];
  });
  const decider = r.targets[r.bestOf - 1]!;
  return { sets, a: decider - 3, b: decider - 4, last: null, history: [] };
}

export function point(s: RallyState, side: Side, r: RallyRules): RallyState {
  if (matchWinner(s, r)) return s;
  const a = s.a + (side === "a" ? 1 : 0);
  const b = s.b + (side === "b" ? 1 : 0);
  const done = setWinner(a, b, r.targets[s.sets.length]!, r.bound);
  return done
    ? { sets: [...s.sets, [a, b]], a: 0, b: 0, last: side, history: [...s.history, s] }
    : { sets: s.sets, a, b, last: side, history: [...s.history, s] };
}

export function undo(s: RallyState): RallyState {
  return s.history[s.history.length - 1] ?? s;
}
