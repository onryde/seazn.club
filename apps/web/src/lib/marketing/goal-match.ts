/**
 * The match behind the football, hockey and ice hockey pages' working demo: goals, a card, full time. A deliberately
 * small model, NOT the engine: it exists so a visitor can tap a pad and watch the other screens move on a public,
 * statically cached page with no match behind it. Pure and immutable.
 */

export type Side = "a" | "b";
export type GoalEvent = { kind: "goal" | "card"; side: Side; minute: number };

export type GoalState = {
  a: number;
  b: number;
  events: GoalEvent[];
  over: boolean;
  history: GoalState[];
};

/** Level late on, a goal each already on the timeline: one tap decides it. */
export function openingGoal(): GoalState {
  return { a: 1, b: 1, events: [{ kind: "goal", side: "a", minute: 12 }, { kind: "goal", side: "b", minute: 40 }], over: false, history: [] };
}

/** The demo's clock: each action lands a little after the last, starting late in the match. */
function nextMinute(s: GoalState): number {
  return Math.max(76, s.events[s.events.length - 1]?.minute ?? 0) + 2;
}

export function goal(s: GoalState, side: Side): GoalState {
  if (s.over) return s;
  return { ...s, a: s.a + (side === "a" ? 1 : 0), b: s.b + (side === "b" ? 1 : 0), events: [...s.events, { kind: "goal", side, minute: nextMinute(s) }], history: [...s.history, s] };
}

export function card(s: GoalState, side: Side): GoalState {
  if (s.over) return s;
  return { ...s, events: [...s.events, { kind: "card", side, minute: nextMinute(s) }], history: [...s.history, s] };
}

export function fullTime(s: GoalState): GoalState {
  if (s.over) return s;
  return { ...s, over: true, history: [...s.history, s] };
}

/** Null while the match is being played. */
export function outcome(s: GoalState): Side | "draw" | null {
  if (!s.over) return null;
  return s.a === s.b ? "draw" : s.a > s.b ? "a" : "b";
}

export function undo(s: GoalState): GoalState {
  return s.history[s.history.length - 1] ?? s;
}
