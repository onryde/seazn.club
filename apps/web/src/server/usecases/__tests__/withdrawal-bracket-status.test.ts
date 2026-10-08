// W2a fix round 2 (review N4): the bracket withdrawal mapping names every fixtures.status and refuses an unknown one,
// as `engineFixtureStatus` does — a status added to the domain without a ruling here throws instead of silently
// reading as "void".
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES, type FixtureStatusValue } from "@/lib/fixture-status";
import { bracketWithdrawalStatus } from "@/server/usecases/withdrawal";

/** The ruling per status, typed from the rulings (spec 05 §5; W2a ruling C17 for the held fixture), not read from the
 *  code under test. */
const RULED: Record<FixtureStatusValue, "decided" | "scheduled" | "void"> = {
  decided: "decided", // played: the result stands
  finalized: "decided",
  forfeited: "decided",
  scheduled: "scheduled", // still to play
  in_play: "scheduled",
  needs_decision: "void", // C17: held — nobody walked over on it; the organiser settles it for the remaining entrant
  abandoned: "void", // no result to keep
  cancelled: "void",
};

describe("bracketWithdrawalStatus (review N4)", () => {
  it("N4: every fixtures.status maps as ruled, and the ruling table covers exactly the status domain", () => {
    expect(Object.keys(RULED).sort()).toEqual([...FIXTURE_STATUSES].sort());
    let checked = 0;
    for (const s of FIXTURE_STATUSES) {
      expect(bracketWithdrawalStatus(s), s).toBe(RULED[s]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("N4: an unknown status throws (never a silent void)", () => {
    expect(() => bracketWithdrawalStatus("postponed")).toThrow(/^bracketWithdrawalStatus: unknown fixtures\.status "postponed"$/);
    expect(() => bracketWithdrawalStatus("")).toThrow(/unknown fixtures\.status ""/);
  });
});
