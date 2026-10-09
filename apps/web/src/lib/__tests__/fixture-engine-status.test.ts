// The ONE DB → engine fixture-status mapping (spec 05 §1). Three call sites
// used to carry a verbatim copy each (engine-db/competition.ts, the bracket
// rebuild in usecases/stages.ts, and the qualification builder would have been
// the third); a copy that drifts lets the standings fold and the qualification
// status disagree about whether a match counts as played. The table is pinned
// whole, so a changed row reds here before it reds in a standings suite.
// W2a: the default now THROWS (finding 18), so an unknown status is a loud
// failure rather than an unplayed match.
import { describe, expect, it } from "vitest";
import { engineFixtureStatus } from "../fixture-engine-status";
import { FIXTURE_STATUSES } from "../fixture-status";

describe("engineFixtureStatus — DB fixtures.status → engine FixtureStatus", () => {
  it("maps every DB status the fixtures table writes (the table is held to FIXTURE_STATUSES)", () => {
    const table: Record<string, string> = {
      scheduled: "scheduled",
      in_play: "in_play",
      decided: "decided",
      finalized: "decided",
      forfeited: "walkover",
      abandoned: "void",
      cancelled: "void",
      // W2a (finding 18): held — played, not finished, nobody seated; open to the fold.
      needs_decision: "in_play",
    };
    expect(Object.keys(table).sort()).toEqual([...FIXTURE_STATUSES].sort());
    let checked = 0;
    for (const db of FIXTURE_STATUSES) {
      expect(engineFixtureStatus(db), db).toBe(table[db]);
      checked++;
    }
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });
  it("needs_decision maps to in_play, and an unknown status throws (never a silent \"scheduled\")", () => {
    expect(engineFixtureStatus("needs_decision")).toBe("in_play");
    expect(() => engineFixtureStatus("postponed")).toThrow(/unknown fixtures.status "postponed"/);
    expect(() => engineFixtureStatus("")).toThrow(/unknown fixtures.status ""/);
  });
});
