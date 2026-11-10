// W4 T3 (K2; X-SD-5): the fixture shapes "is this a bye line?" is asked of, each with the answer the RULES give — one
// table, read by the pure predicate's test (bye-line.test.ts) and by its SQL twin's (bracket-bye-line-slot.test.ts), so
// both are held to the same answers and never merely to each other.
//
// Where each answer comes from (never from the code under test):
// - A bye is not played, so it takes no court and no time (W3 spec §4; X-SW-29; engine row X-SD-5).
// - A SYSTEM bye is an `award` with reason `bye` over at most one seat, that seat the winner — the contract
//   engine-db/system-bye-sql.ts declares (W2b C-5: a bye names its reason and no loser). The orphan (both seats empty,
//   its holder deleted) is still one; a two-seated award, a `withdrew` walkover (ruling 116) and a reasonless award are not.
// - A PRE-AWARD bye line is a `scheduled` line with no outcome whose EMPTY side carries the bye slot label — the marker
//   the generator stamps on the phantom side nobody ever occupies (usecases/stages/bracket-seats.ts `awardSeededByes`' own reading). A seated
//   side is not a phantom, whatever its label says.
// - A Swiss bye shell (`sw-r{N}-bye`) is a bye seated or not (lib/swiss-shell.ts); a Swiss BOARD shell is not.
//
// `H`/`A` stand for two real entrant ids; `rowOf` maps them (the DB test passes the rig's own entrants).
export type Seat = "H" | "A" | null;

interface ShapeOutcome {
  kind: string;
  winner?: Seat;
  loser?: Seat;
  reason?: string;
}

export interface ByeLineShape {
  name: string;
  expected: boolean;
  ext_key: string | null;
  status: string;
  outcome: ShapeOutcome | null;
  home: Seat;
  away: Seat;
  home_slot_label: unknown;
  away_slot_label: unknown;
}

const BYE = { key: "bracket.slot.bye", params: {} };
const SEED = (seed: number) => ({ key: "bracket.slot.seed", params: { seed }, seed });
const WINNER_OF = { key: "bracket.slot.winnerOf", params: { match: 1 } };

const base = {
  ext_key: null,
  status: "scheduled",
  outcome: null,
  home: null,
  away: null,
  home_slot_label: null,
  away_slot_label: null,
} as const satisfies Omit<ByeLineShape, "name" | "expected">;

export const BYE_LINE_SHAPES: readonly ByeLineShape[] = [
  // THE EMPTY CASE FIRST: every nullable field null — a later-round line still waiting on both feeders.
  { ...base, name: "the empty row (scheduled, no seats, no labels, no outcome)", expected: false },

  // Pre-award bye lines.
  { ...base, name: "pre-award, day one: the seed side unfilled, the away side the bye", home_slot_label: SEED(1), away_slot_label: BYE, expected: true },
  { ...base, name: "pre-award, seated: the seed filled, the award not yet written", home: "H", away_slot_label: BYE, expected: true },
  { ...base, name: "pre-award, mirrored: the HOME side is the bye", away: "A", home_slot_label: BYE, expected: true },
  { ...base, name: "a bye label over a SEATED side is no phantom", home: "H", away: "A", away_slot_label: BYE, expected: false },
  { ...base, name: "a bye label on a cancelled line (not scheduled)", status: "cancelled", home: "H", away_slot_label: BYE, expected: false },
  { ...base, name: "a malformed label (a bare string, not {key})", home: "H", away_slot_label: "bracket.slot.bye", expected: false },
  { ...base, name: "a line waiting on a feeder ('Winner of …')", home: "H", away_slot_label: WINNER_OF, expected: false },

  // System byes (awarded).
  { ...base, name: "system bye, home seated", status: "forfeited", outcome: { kind: "award", winner: "H", loser: null, reason: "bye" }, home: "H", away_slot_label: BYE, expected: true },
  { ...base, name: "system bye, away seated", status: "forfeited", outcome: { kind: "award", winner: "A", loser: null, reason: "bye" }, away: "A", home_slot_label: BYE, expected: true },
  { ...base, name: "an empty-seat orphan bye (its holder deleted)", status: "forfeited", outcome: { kind: "award", winner: "H", loser: null, reason: "bye" }, expected: true },
  { ...base, name: "a two-seated award with reason bye", status: "forfeited", outcome: { kind: "award", winner: "H", loser: null, reason: "bye" }, home: "H", away: "A", expected: false },
  { ...base, name: "a withdrew walkover over a dead seat (ruling 116)", status: "forfeited", outcome: { kind: "award", winner: "H", loser: "A", reason: "withdrew" }, home: "H", away_slot_label: BYE, expected: false },
  { ...base, name: "a one-seated bye award naming the OTHER side the winner", status: "forfeited", outcome: { kind: "award", winner: "A", loser: null, reason: "bye" }, home: "H", expected: false },
  { ...base, name: "a reasonless award over one seat (pre-W2b)", status: "forfeited", outcome: { kind: "award", winner: "H" }, home: "H", expected: false },

  // Swiss.
  { ...base, name: "a Swiss bye shell before Pair", ext_key: "sw-r2-bye", expected: true },
  { ...base, name: "a Swiss bye shell after Pair (seated, settled)", ext_key: "sw-r1-bye", status: "forfeited", outcome: { kind: "award", winner: "H", loser: null, reason: "bye" }, home: "H", expected: true },
  { ...base, name: "a Swiss board shell", ext_key: "sw-r1-b1", expected: false },

  // Real matches.
  { ...base, name: "a real match, both seated, unplayed", home: "H", away: "A", expected: false },
  { ...base, name: "a real match, decided", status: "decided", outcome: { kind: "win", winner: "H", loser: "A" }, home: "H", away: "A", expected: false },
];

/** The shape as a fixtures row over two real entrant ids. */
export function rowOf(s: ByeLineShape, ids: { H: string; A: string }) {
  const id = (x: Seat | undefined) => (x === undefined ? undefined : x === null ? null : ids[x]);
  const outcome =
    s.outcome === null
      ? null
      : Object.fromEntries(
          Object.entries({ ...s.outcome, winner: id(s.outcome.winner), loser: id(s.outcome.loser) }).filter(([, v]) => v !== undefined),
        );
  return {
    ext_key: s.ext_key,
    status: s.status,
    outcome,
    home_entrant_id: id(s.home) ?? null,
    away_entrant_id: id(s.away) ?? null,
    home_slot_label: s.home_slot_label,
    away_slot_label: s.away_slot_label,
  };
}
