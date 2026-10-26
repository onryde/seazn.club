// A person who belongs to BOTH entrants of a fixture is one person at that
// fixture. Listed twice, the placement service refuses the whole solve
// (INVALID_REQUEST "person_indices repeats a person"), and on stg on
// 2026-10-26 that one fixture sent a whole board to greedy.
import { describe, expect, it } from "vitest";
import { toAssignment, type FixtureLite } from "../schedule";

const fixture = (home: string | null, away: string | null): FixtureLite => ({
  id: "f1",
  stage_id: "s1",
  division_id: "d1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  ext_key: null,
  home_entrant_id: home,
  away_entrant_id: away,
  scheduled_at: "2026-10-26T10:00:00Z",
  court_id: "c1",
  venue_id: null,
  court_label: null,
  venue: null,
  status: "scheduled",
  schedule_locked: false,
  winner_to_fixture: null,
  loser_to_fixture: null,
});

describe("toAssignment people — one entry per person", () => {
  // The stg shape: home {p3,p0,p2,p1}, away {p0,p1,p2}.
  const people = new Map([
    ["home", ["p3", "p0", "p2", "p1"]],
    ["away", ["p0", "p1", "p2"]],
  ]);

  it("a member of both entrants appears once, in first-seen order", () => {
    const got = toAssignment(fixture("home", "away"), 30, people).people;
    expect(got).toEqual(["p3", "p0", "p2", "p1"]);
    expect(new Set(got).size, "no person repeated").toBe(got.length);
  });

  it("disjoint rosters keep every person (the positive pair)", () => {
    const disjoint = new Map([
      ["home", ["a1", "a2"]],
      ["away", ["b1", "b2"]],
    ]);
    expect(toAssignment(fixture("home", "away"), 30, disjoint).people).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("a TBD side contributes nobody", () => {
    expect(toAssignment(fixture("home", null), 30, people).people).toEqual(["p3", "p0", "p2", "p1"]);
    expect(toAssignment(fixture(null, null), 30, people).people).toEqual([]);
  });
});
