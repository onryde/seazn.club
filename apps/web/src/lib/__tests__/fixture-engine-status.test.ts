// The ONE DB → engine fixture-status mapping (spec 05 §1). Three call sites
// used to carry a verbatim copy each (engine-db/competition.ts, the bracket
// rebuild in usecases/stages.ts, and the qualification builder would have been
// the third); a copy that drifts lets the standings fold and the qualification
// status disagree about whether a match counts as played. The table is pinned
// whole, so a changed row reds here before it reds in a standings suite.
import { describe, expect, it } from "vitest";
import { engineFixtureStatus } from "../fixture-engine-status";

describe("engineFixtureStatus — DB fixtures.status → engine FixtureStatus", () => {
  it("maps every DB status the fixtures table writes", () => {
    const table: Record<string, string> = {
      scheduled: "scheduled",
      in_play: "in_play",
      decided: "decided",
      finalized: "decided",
      forfeited: "walkover",
      abandoned: "void",
      cancelled: "void",
    };
    for (const [db, engine] of Object.entries(table)) expect(engineFixtureStatus(db), db).toBe(engine);
  });
  it("an unknown status reads as unplayed, never as settled", () => {
    expect(engineFixtureStatus("postponed")).toBe("scheduled");
    expect(engineFixtureStatus("")).toBe("scheduled");
  });
});
