/**
 * The Scheduling page's demo model: four teams, two courts, three start times, six matches. Pure, no network.
 *
 * It keeps the two rules the real schedule board enforces on a move (components/v2/board: `conflict.court`, "two
 * matches would use the same court at the same time", and `warn.person_overlap`, "someone would be playing in two
 * matches at once ... a clash you introduce is refused"): a move that breaks either is refused, never placed.
 */
export type Match = { id: string; home: number; away: number };
export type Cell = { court: number; slot: number };
export type Refusal = { kind: "court"; matchId: string } | { kind: "team"; matchId: string; team: number };
export type DayState = {
  placed: Record<string, Cell>;
  picked: string | null;
  refused: Refusal | null;
  published: boolean;
  delayMinutes: number;
};

export const COURTS = 2;
export const SLOTS = 3;
export const SLOT_MINUTES = 40;
export const DELAY_STEP = 15;
export const MAX_DELAY = 60;
const FIRST_START = 9 * 60;

/** Everyone plays everyone once, listed round by round. */
export const MATCHES: readonly Match[] = [
  { id: "m1", home: 0, away: 1 },
  { id: "m2", home: 2, away: 3 },
  { id: "m3", home: 0, away: 2 },
  { id: "m4", home: 1, away: 3 },
  { id: "m5", home: 0, away: 3 },
  { id: "m6", home: 1, away: 2 },
];
const byId = (id: string) => MATCHES.find((m) => m.id === id);

/** Half a morning already on the board, three matches left for the visitor. */
export function openingDay(): DayState {
  return {
    placed: { m1: { court: 0, slot: 0 }, m2: { court: 1, slot: 0 }, m3: { court: 0, slot: 1 } },
    picked: null,
    refused: null,
    published: false,
    delayMinutes: 0,
  };
}

/** Why `match` cannot go in `cell`, or null when it can. */
function clash(placed: Record<string, Cell>, match: Match, cell: Cell): Refusal | null {
  for (const other of MATCHES) {
    const at = placed[other.id];
    if (!at || other.id === match.id || at.slot !== cell.slot) continue;
    if (at.court === cell.court) return { kind: "court", matchId: match.id };
    const shared = [match.home, match.away].find((t) => t === other.home || t === other.away);
    if (shared !== undefined) return { kind: "team", matchId: match.id, team: shared };
  }
  return null;
}

/** Pick a match up. One already on the board is lifted off it, which takes a published board back to draft. */
export function pick(s: DayState, id: string): DayState {
  if (!byId(id)) return s;
  if (s.placed[id]) {
    const rest = Object.fromEntries(Object.entries(s.placed).filter(([k]) => k !== id));
    return { ...s, placed: rest, picked: id, refused: null, published: false };
  }
  return { ...s, picked: s.picked === id ? null : id, refused: null };
}

/** Put the picked match in a cell, or refuse it with the rule it would break. */
export function placeAt(s: DayState, cell: Cell): DayState {
  const match = s.picked ? byId(s.picked) : undefined;
  if (!match || cell.court < 0 || cell.court >= COURTS || cell.slot < 0 || cell.slot >= SLOTS) return s;
  const refused = clash(s.placed, match, cell);
  if (refused) return { ...s, refused };
  return { ...s, placed: { ...s.placed, [match.id]: cell }, picked: null, refused: null, published: false };
}

function solve(placed: Record<string, Cell>): Record<string, Cell> | null {
  const next = MATCHES.find((m) => !placed[m.id]);
  if (!next) return placed;
  for (let slot = 0; slot < SLOTS; slot++)
    for (let court = 0; court < COURTS; court++) {
      if (clash(placed, next, { court, slot })) continue;
      const done = solve({ ...placed, [next.id]: { court, slot } });
      if (done) return done;
    }
  return null;
}

/** Place every match still off the board. Keeps what is already placed when the day can be finished around it, and
 *  lays the whole day out again when it cannot. */
export function fillRest(s: DayState): DayState {
  if (isComplete(s)) return s;
  const placed = solve(s.placed) ?? solve({});
  if (!placed) throw new Error("day-board: six matches must fit six cells");
  return { ...s, placed, picked: null, refused: null, published: false };
}

export const isComplete = (s: DayState) => MATCHES.every((m) => s.placed[m.id]);

export function publish(s: DayState): DayState {
  return isComplete(s) ? { ...s, published: true, picked: null, refused: null } : s;
}

/** Push the whole day back one step (a rain delay). A published board stays published: its times just move. */
export function delay(s: DayState): DayState {
  return { ...s, delayMinutes: Math.min(MAX_DELAY, s.delayMinutes + DELAY_STEP) };
}

export function clockAt(slot: number, delayMinutes: number): string {
  const m = FIRST_START + slot * SLOT_MINUTES + delayMinutes;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** What players see: nothing until the board is published, then every match in time order. */
export function publicRows(s: DayState): { matchId: string; time: string; court: number }[] {
  if (!s.published) return [];
  return MATCHES.map((m) => ({ m, at: s.placed[m.id]! }))
    .sort((a, b) => a.at.slot - b.at.slot || a.at.court - b.at.court)
    .map(({ m, at }) => ({ matchId: m.id, time: clockAt(at.slot, s.delayMinutes), court: at.court }));
}
