// W3 app-B Task 8 (X-SW-8; FIDE C.04.2 2.4, C.07 (2026) 16.1; Review Focus 2, 3, 4) — `swissAbsentRounds`: the producer of
// `TableStage.swissAbsentRounds`, from the stage's fixture rows. Pure: no database. The DB test beside it
// (`swiss-art16-producer.test.ts`) drives the same rule through the product's own writers and the engine's ranker.
//
// The rule, from the plan's task brief (the rulebook's §4 reading of art. 16): a Swiss ROUND is the round number of a fixture
// whose ext_key is a Swiss shell (`sw-r{n}-b{k}` / `sw-r{n}-bye`); a round is OPEN for absence when it holds at least one
// seated fixture; an entrant is ABSENT in an open round when it holds no seat in any fixture of that round (home, away, or
// a bye's award winner, whatever the status). Only table entrants are keyed, and an entrant whose list is empty is omitted.
//
// Sequence: the empty case first → each state a stage passes through (late entry, withdrawal, a pending board, a bye) → the
// rows that must NOT open a round (ad-hoc, unseated shells) → the key filter → a second call. Every case reports how many
// entrants it checked: zero checked is a failure (TEST-STRATEGY, anti-vacuity).
import { describe, expect, it } from "vitest";
import { MatchOutcome, type StandingsDelta } from "@seazn/engine/core";
import {
  completeTableStage,
  payout,
  swissDrawFactsOf,
  type FixtureResult,
  type StandingsRow,
  type TableFixture,
  type TableStage,
} from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { tableRulesOf } from "@seazn/engine/testkit";
import { swissAbsentRounds } from "../swiss-absent-rounds";
import { unpinnedRulesDoc } from "./helpers/table-rules-doc";

interface Row {
  round_no: number | null;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  /** The loader's `FixtureRow` carries it; the producer reads seats, never the status (the m2 test below pins that). */
  status?: string;
}

/** A board shell `sw-r{round}-b{k}`, seated or not. */
const board = (round: number, k: number, home: string | null, away: string | null): Row => ({
  round_no: round,
  ext_key: `sw-r${round}-b${k}`,
  home_entrant_id: home,
  away_entrant_id: away,
  outcome: null,
});
/** A bye shell `sw-r{round}-bye`, as the product writes a seated one: home = winner, away null, an award. */
const bye = (round: number, winner: string | null): Row => ({
  round_no: round,
  ext_key: `sw-r${round}-bye`,
  home_entrant_id: winner,
  away_entrant_id: null,
  outcome: winner === null ? null : { kind: "award", winner, reason: "bye" },
});
const entries = (m: ReadonlyMap<string, readonly number[]>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));

describe("W3 T8 — swissAbsentRounds (X-SW-8): the rounds a table entrant was in the stage but not paired", () => {
  it("empty case first: no fixtures, and no entrants, are an empty map", () => {
    expect(swissAbsentRounds([], []).size).toBe(0);
    expect(swissAbsentRounds([], ["A", "B"]).size, "entrants but no fixture: no round is open, nobody is absent").toBe(0);
    expect(swissAbsentRounds([board(1, 1, "A", "B")], []).size, "fixtures but no table entrants: nobody to key").toBe(0);
  });

  it("a late entrant first seated in round 3 of 3 open rounds is absent in [1, 2]", () => {
    // Rounds 1 and 2: A v B and C v D; round 3: A v L and B v C — L (admitted after round 2) and D (a legacy sit-out in round 3)
    // are the only ones off a card in some round. D holds seats in rounds 1 and 2 and none in round 3.
    const rows = [
      board(1, 1, "A", "B"), board(1, 2, "C", "D"),
      board(2, 1, "A", "C"), board(2, 2, "B", "D"),
      board(3, 1, "A", "L"), board(3, 2, "B", "C"),
    ];
    const out = swissAbsentRounds(rows, ["A", "B", "C", "D", "L"]);
    expect(out.get("L")).toEqual([1, 2]);
    expect(out.get("D")).toEqual([3]);
    expect(entries(out).map(([k]) => k), "A, B and C sat every round: no key at all").toEqual(["D", "L"]);
    expect(out.size, "anti-vacuity: two entrants are absent somewhere").toBe(2);
  });

  it("a withdrawn entrant with seats in rounds 1-2 of 4 open rounds is absent in [3, 4]", () => {
    const rows = [
      board(1, 1, "A", "W"), board(1, 2, "B", "C"),
      board(2, 1, "A", "B"), board(2, 2, "W", "C"),
      board(3, 1, "A", "C"), board(3, 2, "B", null),
      board(4, 1, "A", "B"), bye(4, "C"),
    ];
    const out = swissAbsentRounds(rows, ["A", "B", "C", "W"]);
    expect(out.get("W")).toEqual([3, 4]);
    expect(out.size).toBe(1);
  });

  it("Review Focus 4 — a seated PENDING board is a seat: nobody on it is absent (the table is ranked mid-round)", () => {
    // Round 2 is half played: its two boards are seated but no result exists (the rows carry no outcome at all).
    const rows = [board(1, 1, "A", "B"), board(1, 2, "C", "D"), board(2, 1, "A", "C"), board(2, 2, "B", "D")];
    const out = swissAbsentRounds(rows, ["A", "B", "C", "D", "Z"]);
    expect(out.get("Z"), "positive pair: an entrant with no seat IS absent from both open rounds, so the rounds were read").toEqual([1, 2]);
    expect(out.size, "five entrants checked: the four seated ones are not keyed, Z alone is").toBe(1);
    // The one-sided half of a seated board (the other seat deleted) is still a seat for the entrant that remains.
    expect(swissAbsentRounds([board(1, 1, "A", "B"), board(2, 1, "A", null)], ["A", "B"]).get("B")).toEqual([2]);
    expect(swissAbsentRounds([board(1, 1, "A", "B"), board(2, 1, "A", null)], ["A", "B"]).has("A")).toBe(false);
  });

  it("a bye winner is seated: not absent in the bye's round (home = winner), and the award winner counts when no seat is filled", () => {
    const homeBye = [board(1, 1, "A", "B"), bye(1, "C"), board(2, 1, "A", "C"), bye(2, "B")];
    const out = swissAbsentRounds(homeBye, ["A", "B", "C", "Z"]);
    expect(out.get("Z"), "positive pair: Z holds no seat and is absent from both rounds").toEqual([1, 2]);
    expect(out.size, "four entrants checked: the bye winners are not keyed, Z alone is").toBe(1);
    // An award whose winner is named in the outcome only: the winner holds the seat the award gives.
    const awardOnly: Row = { round_no: 2, ext_key: "sw-r2-bye", home_entrant_id: null, away_entrant_id: null, outcome: { kind: "award", winner: "C", reason: "bye" } };
    const out2 = swissAbsentRounds([board(1, 1, "A", "B"), bye(1, "C"), board(2, 1, "A", "B"), awardOnly], ["A", "B", "C", "Z"]);
    expect([...out2.keys()], "C's award is its seat in round 2; Z alone is absent").toEqual(["Z"]);
    // ...and a bye shell with no seat and no award opens nothing and holds nobody: round 2 below is NOT open, so L is absent
    // from round 1 only (positive pair).
    expect(swissAbsentRounds([board(1, 1, "A", "B"), bye(1, null), bye(2, null)], ["A", "B", "L"]).get("L")).toEqual([1]);
  });

  it("Review Focus 3 — an ad-hoc round (adhoc-1, round 4) is never an open round, and its seats exempt nobody from a shell round", () => {
    const adhoc: Row = { round_no: 4, ext_key: "adhoc-1", home_entrant_id: "A", away_entrant_id: "B", outcome: null };
    const rows = [board(1, 1, "A", "B"), board(1, 2, "C", "D"), board(2, 1, "A", "C"), board(2, 2, "B", "D"), board(3, 1, "A", "D"), board(3, 2, "B", "C"), adhoc];
    const out = swissAbsentRounds(rows, ["A", "B", "C", "D", "L"]);
    // C and D hold no seat in round 4, but round 4 is not a Swiss round: only L (a fifth entrant, seated nowhere) is absent,
    // and from the three Swiss rounds alone — the positive pair that proves the rounds were read.
    expect(out.get("L")).toEqual([1, 2, 3]);
    expect(out.size).toBe(1);
    // An ad-hoc row sharing a shell round's number never opens that round: a round with no seated SHELL is not open.
    const sharing: Row = { round_no: 2, ext_key: "adhoc-2", home_entrant_id: "A", away_entrant_id: "B", outcome: null };
    expect(swissAbsentRounds([board(1, 1, "A", "B"), board(1, 2, "C", "D"), board(2, 1, null, null), sharing], ["A", "B", "C", "D"]).size, "round 2's shell is empty").toBe(0);
    // ...but its seats are seats of that round when the round IS open (the engine refuses an absence where a card exists).
    const open = swissAbsentRounds([board(1, 1, "A", "B"), board(1, 2, "C", "D"), board(2, 1, "A", "C"), sharing], ["A", "B", "C", "D"]);
    expect(open.get("D")).toEqual([2]);
    expect(open.has("B"), "B holds a seat in round 2 through the ad-hoc row").toBe(false);
  });

  it("shells with no seats (an unpaired future round) are never open", () => {
    const rows = [board(1, 1, "A", "B"), board(1, 2, "C", "D"), board(2, 1, null, null), board(2, 2, null, null), board(3, 1, null, null), bye(3, null)];
    expect(swissAbsentRounds(rows, ["A", "B", "C", "D"]).size, "rounds 2 and 3 are unpaired").toBe(0);
    // positive pair: a fifth entrant, off round 1's cards, is absent from the paired round and from no unpaired one
    expect(swissAbsentRounds(rows, ["A", "B", "C", "D", "L"]).get("L"), "round 1 only").toEqual([1]);
  });

  it("Review Focus 2 — an entrant that is not a table entrant gets no key (a case-(c) latecomer with no seat yet)", () => {
    const rows = [board(1, 1, "A", "B"), board(1, 2, "C", "D"), board(2, 1, "A", "C"), board(2, 2, "B", "D")];
    // L is on the roster but holds no seat anywhere, so it is not among the table's entrants: absent from both rounds in fact,
    // and still no key (the engine refuses a key that is not a table entrant).
    const out = swissAbsentRounds(rows, ["A", "B", "C", "D"]);
    expect(out.has("L")).toBe(false);
    // The same state with L named a table entrant IS keyed — the filter is the table entrants, not a property of L.
    expect(swissAbsentRounds(rows, ["A", "B", "C", "D", "L"]).get("L")).toEqual([1, 2]);
  });

  it("a fixture with no round number or no ext_key is ignored, not an open round", () => {
    const noRound: Row = { round_no: null, ext_key: "sw-r1-b1", home_entrant_id: "A", away_entrant_id: "B", outcome: null };
    const noKey: Row = { round_no: 2, ext_key: null, home_entrant_id: "A", away_entrant_id: "B", outcome: null };
    expect(swissAbsentRounds([noRound, noKey, board(1, 1, "A", "B")], ["A", "B", "C"]).get("C")).toEqual([1]);
  });

  it("a second call gives the same map, and does not mutate its inputs", () => {
    const rows = [board(1, 1, "A", "B"), board(2, 1, "A", "C"), board(2, 2, "B", null)];
    const frozen = JSON.stringify(rows);
    const first = swissAbsentRounds(rows, ["A", "B", "C"]);
    const second = swissAbsentRounds(rows, ["A", "B", "C"]);
    expect(entries(second)).toEqual(entries(first));
    expect(entries(first)).toEqual([["C", [1]]]);
    expect(JSON.stringify(rows)).toBe(frozen);
  });

  it("rounds are listed ascending whatever the row order", () => {
    const rows = [board(3, 1, "A", "B"), board(1, 1, "A", "B"), board(2, 1, "A", "B"), board(4, 1, "A", "B")];
    expect(swissAbsentRounds(rows, ["A", "B", "L"]).get("L")).toEqual([1, 2, 3, 4]);
  });
});

// ── batch 1 review m2: a void row is a SEAT, not a CARD ────────────────────────────────────────────────────────────────────
// The engine's ledger counts only the fixtures whose status is `decided` or `walkover` (`COUNTS_FOR_STANDINGS`), so a `void` row
// writes no card; and it refuses an absence in a round the entrant holds a card in. The producer reads SEATS (home / away / award
// winner), whatever the status, so a void row still seats both of its players. Together: a round whose only seat is a void row is
// NEITHER a played card NOR a zero-point unplayed round for either player - the engine reads "a round with no card and no declared
// absence" as not on the entrant's card at all. A latecomer's missed round, on the other hand, IS absent.
//
// The expected values come from the ENGINE's own fold (`completeTableStage`, Swiss ledger and Buchholz family), never from
// `swissAbsentRounds`: the producer's output is the thing under test, and the only absences written by hand are the scene's own
// facts (L and M joined at round 2, so each missed round 1). The scene:
//   R1  A 1-0 B    C 1/2 D    E 1-0 F           (L and M are not in the stage yet)
//   R2  A 1-0 C    L 1-0 B    E 1/2 M    D v F  -> VOID   (D's and F's only seat in round 2 is the void row)
// single-sport: boardgame (chess scoring, the half-point Swiss sport). The producer is sport-blind (it reads seats), and so is
// the engine's status filter; `swiss-art16-producer.test.ts` sweeps the sports through the DB.
describe("batch 1 m2 - a void row is a seat but not a card: a void-only round is neither played nor absent", () => {
  const bg = builtinModules.find((m) => m.key === "boardgame")!;
  const cfg = bg.variants.classical;
  const doc = unpinnedRulesDoc({ module: bg, kind: "swiss", divisionConfig: cfg });
  // The Buchholz family must be ON the stage's order, or the engine computes none of the ledger's effect.
  const CASCADE: TiebreakerKey[] = [...new Set<TiebreakerKey>([...doc.tiebreakers, "buchholz", "buchholz_cut1"])];
  const ENTRANTS = ["A", "B", "C", "D", "E", "F", "L", "M"];

  type Result = "home" | "away" | "draw";
  interface Game {
    round: number;
    k: number;
    home: string;
    away: string;
    result: Result;
  }
  const PLAYED: Game[] = [
    { round: 1, k: 1, home: "A", away: "B", result: "home" },
    { round: 1, k: 2, home: "C", away: "D", result: "draw" },
    { round: 1, k: 3, home: "E", away: "F", result: "home" },
    { round: 2, k: 1, home: "A", away: "C", result: "home" },
    { round: 2, k: 2, home: "B", away: "L", result: "away" },
    { round: 2, k: 3, home: "E", away: "M", result: "draw" },
  ];
  /** The board that gets voided: D v F, round 2, board 4 - the only seat either of them holds in round 2. */
  const VOIDED: Game = { round: 2, k: 4, home: "D", away: "F", result: "home" };

  const delta = (entrantId: string, won: number, drawn: number, lost: number): StandingsDelta => ({
    entrantId, played: 1, won, drawn, lost, points: 0, metrics: { wins: won },
  });
  /** The engine fixture of a game: paid by the stage's own rule, as the loader pays a decided result. */
  function resultOf(g: Game): FixtureResult {
    const draw = g.result === "draw";
    const winner = g.result === "home" ? g.home : g.away;
    const loser = winner === g.home ? g.away : g.home;
    const pair: FixtureResult = [
      delta(g.home, !draw && winner === g.home ? 1 : 0, draw ? 1 : 0, !draw && winner === g.away ? 1 : 0),
      delta(g.away, !draw && winner === g.away ? 1 : 0, draw ? 1 : 0, !draw && winner === g.home ? 1 : 0),
    ];
    const outcome = draw ? MatchOutcome.parse({ kind: "draw" }) : MatchOutcome.parse({ kind: "win", winner, loser });
    return payout(outcome, draw ? null : "regulation", pair, true, doc.points, undefined, undefined);
  }
  const outcomeOf = (g: Game): unknown =>
    g.result === "draw"
      ? { kind: "draw" }
      : { kind: "win", winner: g.result === "home" ? g.home : g.away, loser: g.result === "home" ? g.away : g.home };
  const decidedFixture = (g: Game): TableFixture => ({ id: `r${g.round}b${g.k}`, roundNo: g.round, status: "decided", unplayed: null, result: resultOf(g) });
  /** The DB row of a game, as the loader hands it to the producer (a `status` column, seats, the shell's ext_key). */
  const rowOf = (g: Game, status: string, outcome: unknown = outcomeOf(g)): Row => ({
    round_no: g.round,
    ext_key: `sw-r${g.round}-b${g.k}`,
    home_entrant_id: g.home,
    away_entrant_id: g.away,
    outcome,
    status,
  });

  /** The engine's own fold of a Swiss stage over `fixtures`, with `absent` as the stage's declared absences. */
  const fold = (fixtures: readonly TableFixture[], absent: ReadonlyMap<string, readonly number[]>): StandingsRow[] => {
    const stage = {
      id: "swiss-void-row",
      kind: "swiss",
      entrants: ENTRANTS,
      rules: tableRulesOf(CASCADE, doc.points),
      swiss: true,
      swissDraw: swissDrawFactsOf(bg, cfg),
      swissAbsentRounds: absent,
      rounds: 3,
    } as TableStage;
    return [...completeTableStage(stage, fixtures).tables.overall!];
  };
  const byId = (rows: readonly StandingsRow[]) => new Map(rows.map((r) => [r.entrantId, r]));
  /** The ids whose whole row differs between two folds of the same entrants. */
  const differing = (a: readonly StandingsRow[], b: readonly StandingsRow[]): string[] => {
    const bb = byId(b);
    return a.filter((r) => JSON.stringify(r) !== JSON.stringify(bb.get(r.entrantId))).map((r) => r.entrantId);
  };

  const played = PLAYED.map(decidedFixture);
  // the scene's own facts: L and M joined at round 2, so each missed round 1 - and nobody else missed anything
  const SCENE_ABSENT: ReadonlyMap<string, readonly number[]> = new Map([["L", [1]], ["M", [1]]]);
  // The engine's table when D and F hold NEITHER a card NOR a declared absence in round 2 - how it reads a round that is not on
  // their card at all. The void row must leave the table exactly here (not at "absent from round 2", which is a different table).
  const NO_CARD_NO_ABSENCE = fold(played, SCENE_ABSENT);

  // The two shapes a voided board takes in the DB: nothing recorded (a pending board voided by a withdrawal), and one that
  // KEPT its result (`loadStageInputs` attaches a result to any row with an outcome and a state, whatever its status).
  const SHAPES: { name: string; row: Row; fixture: TableFixture }[] = [
    {
      name: "a pending board voided (no outcome, no result)",
      row: rowOf(VOIDED, "void", null),
      fixture: { id: "void-r2b3", roundNo: 2, status: "void" },
    },
    {
      name: "a played board voided afterwards (it kept its outcome and its result)",
      row: rowOf(VOIDED, "void"),
      fixture: { id: "void-r2b3", roundNo: 2, status: "void", unplayed: null, result: resultOf(VOIDED) },
    },
  ];

  it("premise (empty case first): without any void row D and F are absent from round 2 beside the latecomers' round 1, and the engine ranks eight entrants", () => {
    const rows = [...PLAYED.map((g) => rowOf(g, "decided"))];
    const out = swissAbsentRounds(rows, ENTRANTS);
    // D and F hold no seat in round 2 here, so they ARE absent from it: the void row is what changes that, below
    expect(entries(out)).toEqual([["D", [2]], ["F", [2]], ["L", [1]], ["M", [1]]]);
    expect(NO_CARD_NO_ABSENCE).toHaveLength(8);
    // positive pair on the contrast: the engine's fold moves when an absence is declared (a no-absence fold is a different table)
    expect(differing(NO_CARD_NO_ABSENCE, fold(played, new Map())), "L's and M's missed round changes their rows").toEqual(expect.arrayContaining(["L", "M"]));
  });

  for (const shape of SHAPES) {
    describe(shape.name, () => {
      const rows = [...PLAYED.map((g) => rowOf(g, "decided")), shape.row];
      const fixtures = [...played, shape.fixture];
      const produced = swissAbsentRounds(rows, ENTRANTS);

      it("the producer keeps the void row's seat: D and F are absent from nothing, the latecomers only from round 1", () => {
        expect(entries(produced)).toEqual([["L", [1]], ["M", [1]]]);
        expect(produced.has("D"), "D's only seat in round 2 is the void row").toBe(false);
        expect(produced.has("F"), "F's only seat in round 2 is the void row").toBe(false);
        expect(produced.get("L"), "L missed round 1 (a latecomer's round IS absent) and nothing else").toEqual([1]);
      });

      it("the engine's fold of the stage equals its fold with D and F holding neither a card nor an absence in round 2: the void row is no card, and no absence stands in for it", () => {
        const actual = fold(fixtures, produced);
        expect(actual).toHaveLength(8);
        expect(differing(actual, NO_CARD_NO_ABSENCE), "eight rows compared: none moves").toEqual([]);
        expect(actual).toEqual(NO_CARD_NO_ABSENCE);
      });

      it("the engine's own definition of a card: a void round is no card (an absence declared in it is accepted), a decided round is one (refused)", () => {
        // the engine refuses an absent round the entrant holds a card in; neither D nor F holds a card in round 2, whatever the
        // void row seats - checked for both of the void row's players
        for (const id of ["D", "F"]) {
          expect(() => fold(fixtures, new Map([...SCENE_ABSENT, [id, [2]]])), `${id} may be declared absent from the void round`).not.toThrow();
          // ...and the engine does refuse one in round 1, where the same player's decided game is a card - same call, so the refusal is real
          expect(() => fold(fixtures, new Map([...SCENE_ABSENT, [id, [1]]])), `${id} holds a card in round 1`).toThrow(/holds a card/);
        }
      });

      it("the contrast the producer must not produce: counting the void round as absent moves a table row for each of the void row's players", () => {
        // what a producer that read a void row as NO seat would hand the engine: D and F absent from round 2 as well
        const asAbsent = new Map<string, readonly number[]>([...SCENE_ABSENT, ["D", [2]], ["F", [2]]]);
        const wrong = fold(fixtures, asAbsent);
        const moved = differing(wrong, NO_CARD_NO_ABSENCE);
        expect(moved, "a void-as-absent table is a different table, for both of the void row's players").toEqual(expect.arrayContaining(["D", "F"]));
        expect(entries(asAbsent), "the contrast is not what the producer returned").not.toEqual(entries(produced));
      });
    });
  }
});
