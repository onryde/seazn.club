import { cricketPadRules } from "@seazn/engine/pad";

/**
 * The cricket chase behind the product pages' working demo ("one tap, four screens"). A deliberately small model of a
 * second innings, NOT the engine: it exists so a visitor can tap a pad and watch the other screens move, on a public,
 * statically cached page with no match behind it. Pure and immutable; the island in `chase-demo.tsx` holds one of
 * these in state.
 *
 * The over length is the engine's declaration (`cricketPadRules.ballsPerOver`), so the demo cannot drift from the
 * real pad's over.
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

export const CHASE = { target: 49, wicketsToFall: 10, opening: { runs: 27, wkts: 2, balls: 19 } } as const;

export const BALLS_PER_OVER: number = cricketPadRules.ballsPerOver({});

export function openingChase(): ChaseState {
  return { ...CHASE.opening, over: ["1"], last: null, history: [] };
}

export function chaseOver(s: ChaseState): "won" | "allOut" | null {
  if (s.runs >= CHASE.target) return "won";
  if (s.wkts >= CHASE.wicketsToFall) return "allOut";
  return null;
}

export function tap(s: ChaseState, key: ChaseKey): ChaseState {
  if (chaseOver(s)) return s;
  const legal = key !== "wide";
  const mark = key === "wide" ? "wd" : key === "out" ? "W" : key;
  const runs = key === "wide" ? 1 : key === "out" ? 0 : Number(key);
  // The strip belongs to one over: the first delivery after a completed over starts a new one.
  const overDone = s.balls > 0 && s.balls % BALLS_PER_OVER === 0 && s.over.some((d) => d !== "wd");
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
