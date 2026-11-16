/**
 * The cricket chase behind the product pages' working demo ("one tap, four screens"). A deliberately small model of a
 * second innings, NOT the engine: it exists so a visitor can tap a pad and watch the other screens move, on a public,
 * statically cached page with no match behind it. Pure and immutable; the island in `chase-demo.tsx` holds one of
 * these in state.
 *
 * The over length is a PARAMETER, never an import: it is the engine's declaration, read on the server
 * (cricket-chase-rules.ts) and passed down, because this file ships to the browser and the engine must not.
 */

export type ChaseKey = "0" | "1" | "2" | "3" | "4" | "6" | "wide" | "out";

export type ChaseState = {
  runs: number;
  wkts: number;
  /** Legal balls bowled in the innings. */
  balls: number;
  /** This over's deliveries as the pad's strip shows them ("4", "wd", "W"). */
  over: string[];
  last: string | null;
  history: ChaseState[];
};

export const CHASE = { target: 49, wicketsToFall: 10, overs: 20, opening: { runs: 27, wkts: 2, balls: 19 } } as const;

export function openingChase(): ChaseState {
  return { ...CHASE.opening, over: ["1"], last: null, history: [] };
}

export function chaseOver(s: ChaseState): "won" | "allOut" | null {
  if (s.runs >= CHASE.target) return "won";
  if (s.wkts >= CHASE.wicketsToFall) return "allOut";
  return null;
}

export function tap(s: ChaseState, key: ChaseKey, ballsPerOver: number): ChaseState {
  if (chaseOver(s)) return s;
  const legal = key !== "wide";
  const mark = key === "wide" ? "wd" : key === "out" ? "W" : key;
  const runs = key === "wide" ? 1 : key === "out" ? 0 : Number(key);
  // The strip belongs to one over: the first delivery after a completed over starts a new one.
  const overDone = s.balls > 0 && s.balls % ballsPerOver === 0 && s.over.some((d) => d !== "wd");
  return {
    runs: s.runs + runs,
    wkts: s.wkts + (key === "out" ? 1 : 0),
    balls: s.balls + (legal ? 1 : 0),
    over: [...(overDone ? [] : s.over), mark],
    last: mark,
    history: [...s.history, s],
  };
}

export function undo(s: ChaseState): ChaseState {
  return s.history[s.history.length - 1] ?? s;
}

export function oversText(balls: number, ballsPerOver: number): string {
  return `${Math.floor(balls / ballsPerOver)}.${balls % ballsPerOver}`;
}

export function needText(s: ChaseState): { runs: number } {
  return { runs: Math.max(0, CHASE.target - s.runs) };
}

/** Legal balls left in the chasing side's innings. */
export function ballsLeft(s: ChaseState, ballsPerOver: number): number {
  return Math.max(0, CHASE.overs * ballsPerOver - s.balls);
}

/**
 * What the stream tile announces after the last tap, the way the real overlay does: a boundary or a wicket for the
 * ball itself, and an end-of-over card when that ball was the over's last legal one. Derived from the state alone, so
 * taking a ball back takes its moment back.
 */
export type ChaseMoment = { ball: "six" | "four" | "out" | null; endOfOver: { over: number; runs: number } | null };

const MARK_RUNS = (mark: string) => (mark === "wd" ? 1 : mark === "W" ? 0 : Number(mark));

export function chaseMoment(s: ChaseState, ballsPerOver: number): ChaseMoment {
  const ball = s.last === "6" ? "six" : s.last === "4" ? "four" : s.last === "W" ? "out" : null;
  // A wide is not a ball of the over: only a legal delivery can be the one that ends it.
  const ended = s.last !== null && s.last !== "wd" && s.balls > 0 && s.balls % ballsPerOver === 0;
  return { ball, endOfOver: ended ? { over: s.balls / ballsPerOver, runs: s.over.reduce((n, m) => n + MARK_RUNS(m), 0) } : null };
}
