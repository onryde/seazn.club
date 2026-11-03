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
import { swissAbsentRounds } from "../swiss-absent-rounds";

interface Row {
  round_no: number | null;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
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
