/**
 * The day behind the Match Day page's working demo: three courts and a line of matches. A small model of the desk, NOT
 * the product: it exists so a visitor can call a match and watch a volunteer's phone and the courts' cameras follow,
 * on a public, statically cached page. Pure and immutable.
 *
 * Its rules are the product's, as the help page states them (content/help/scheduling/match-day.md): a court with a
 * match playing or called takes no call; a match whose player is on another court cannot be called; Undo call puts
 * the match back; a court's phone streams a match only while it is being played.
 */
export type Court = { kind: "free" } | { kind: "called" | "playing"; match: string };
export type DayEvent = { type: "call" | "start" | "result" | "undo"; court: number; match: string };
export type DayState = { courts: Court[]; waiting: string[]; done: string[]; last: DayEvent | null };

/** Teams are indexes into the page's list of demo club names, so no name ships twice. */
export const MATCHES: Record<string, { a: number; b: number }> = {
  m1: { a: 0, b: 1 },
  m2: { a: 2, b: 3 },
  m3: { a: 1, b: 4 },
  m4: { a: 5, b: 6 },
  m5: { a: 7, b: 4 },
};

export function openingDay(): DayState {
  return { courts: [{ kind: "playing", match: "m1" }, { kind: "free" }, { kind: "free" }], waiting: ["m2", "m3", "m4", "m5"], done: [], last: null };
}

/** The court one of this match's teams is already on, or null when both are free to play. */
export function blockedBy(s: DayState, matchId: string): number | null {
  const m = MATCHES[matchId]!;
  const at = s.courts.findIndex((c) => {
    if (c.kind === "free" || c.match === matchId) return false;
    const o = MATCHES[c.match]!;
    return [o.a, o.b].some((t) => t === m.a || t === m.b);
  });
  return at === -1 ? null : at;
}

/** The match a call would take: the first in line whose teams are both free. */
export function nextFor(s: DayState): string | null {
  return s.waiting.find((id) => blockedBy(s, id) === null) ?? null;
}

const put = (s: DayState, court: number, to: Court, rest: Partial<DayState>, event: DayEvent): DayState => ({
  ...s,
  ...rest,
  courts: s.courts.map((c, i) => (i === court ? to : c)),
  last: event,
});

export function call(s: DayState, court: number): DayState {
  const match = nextFor(s);
  if (s.courts[court]?.kind !== "free" || match === null) return s;
  return put(s, court, { kind: "called", match }, { waiting: s.waiting.filter((id) => id !== match) }, { type: "call", court, match });
}

export function start(s: DayState, court: number): DayState {
  const c = s.courts[court];
  if (c?.kind !== "called") return s;
  return put(s, court, { kind: "playing", match: c.match }, {}, { type: "start", court, match: c.match });
}

export function result(s: DayState, court: number): DayState {
  const c = s.courts[court];
  if (c?.kind !== "playing") return s;
  return put(s, court, { kind: "free" }, { done: [...s.done, c.match] }, { type: "result", court, match: c.match });
}

export function undoCall(s: DayState, court: number): DayState {
  const c = s.courts[court];
  if (c?.kind !== "called") return s;
  return put(s, court, { kind: "free" }, { waiting: [c.match, ...s.waiting] }, { type: "undo", court, match: c.match });
}

/** What a court's camera phone is doing: nothing without a phone, on air while a match plays, otherwise waiting. */
export function streamOf(s: DayState, court: number, linked: readonly boolean[]): "none" | "waiting" | "live" {
  if (!linked[court]) return "none";
  return s.courts[court]?.kind === "playing" ? "live" : "waiting";
}
