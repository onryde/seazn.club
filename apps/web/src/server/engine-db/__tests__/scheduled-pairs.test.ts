// W2d Task 12 (spec §5.6 "ST-G12", X-TB-8) — `scheduledPairsOf`: the stage's schedule the head-to-head steps read, built
// from the same fixture rows and engine statuses as the counted results. Pure: no database.
//
// Sequence: an empty stage → a seated fixture of every engine status → a seat still to be filled → a double round robin
// (one entry per fixture) → a void (a withdrawal's expunge) → the guard (a fixture with no engine status).
import { describe, expect, it } from "vitest";
import type { FixtureStatus } from "@seazn/engine/competition";
import { scheduledPairsOf } from "../competition";

const fixture = (id: string, home: string | null, away: string | null) => ({ id, home_entrant_id: home, away_entrant_id: away });
const status = (id: string, s: FixtureStatus) => ({ id, status: s });

describe("W2d T12 — the stage's schedule for the head-to-head steps (X-TB-8)", () => {
  it("empty: a stage with no fixtures schedules nothing", () => {
    expect(scheduledPairsOf([], [])).toEqual([]);
  });

  it("X-TB-8 every seated fixture is on it, decided or not, one entry per fixture; a void one and an unfilled seat are not", () => {
    // Every engine status a table fixture can carry (`completionEngineStatus`), counted: only `void` leaves the schedule.
    const statuses: FixtureStatus[] = ["scheduled", "in_play", "decided", "walkover", "void"];
    const fixtures = statuses.map((s, i) => fixture(`f${i}`, "A", "B"));
    const pairs = scheduledPairsOf(fixtures, statuses.map((s, i) => status(`f${i}`, s)));
    expect(pairs).toEqual([["A", "B"], ["A", "B"], ["A", "B"], ["A", "B"]]);
    expect(pairs.length, "anti-vacuity: four statuses stay on the schedule").toBe(statuses.length - 1);
    // A seat still to be filled (a bye's empty side, a knockout feeder) names nobody.
    expect(scheduledPairsOf([fixture("h", "A", null), fixture("a", null, "B")], [status("h", "scheduled"), status("a", "scheduled")])).toEqual([]);
    // A double round robin lists each pair twice, as each leg is seated.
    expect(scheduledPairsOf([fixture("l1", "A", "B"), fixture("l2", "B", "A")], [status("l1", "decided"), status("l2", "scheduled")])).toEqual([
      ["A", "B"],
      ["B", "A"],
    ]);
  });

  it("X-TB-8 after a withdrawal: the withdrawn entrant's expunged (void) fixtures leave the schedule, its played ones stay", () => {
    const pairs = scheduledPairsOf(
      [fixture("ad", "A", "D"), fixture("bd", "B", "D"), fixture("ab", "A", "B")],
      [status("ad", "decided"), status("bd", "void"), status("ab", "scheduled")],
    );
    expect(pairs).toEqual([["A", "D"], ["A", "B"]]);
  });

  it("a fixture with no engine status is refused: the schedule and the table would read different fixtures", () => {
    expect(() => scheduledPairsOf([fixture("x", "A", "B")], [])).toThrow(/fixture x has no engine status/);
  });
});
