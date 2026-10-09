// W2a fix round 2 (review N4): the bracket withdrawal mapping names every fixtures.status and refuses an unknown one,
// as `engineFixtureStatus` does — a status added to the domain without a ruling here throws instead of silently
// reading as "void".
// W2a loop R I-1 (ruling D-R1, option a): an `in_play` fixture whose decider is still owed (the engine's
// `deciderPending` — a chess knockout draw in its tie-break) is a HOLD, the C17 shape, never a pending fixture to walk
// over: boardgame refuses `core.forfeit` outside phase "live", so the walkover 422'd the whole withdrawal.
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES, type FixtureStatusValue } from "@/lib/fixture-status";
import { bracketWithdrawalStatus } from "@/server/usecases/withdrawal";

/** The ruling per status with NO decider pending, typed from the rulings (spec 05 §5; W2a ruling C17 for the held
 *  fixture), not read from the code under test. */
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
      expect(bracketWithdrawalStatus(s, false), s).toBe(RULED[s]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("N4: an unknown status throws (never a silent void)", () => {
    expect(() => bracketWithdrawalStatus("postponed", false)).toThrow(/^bracketWithdrawalStatus: unknown fixtures\.status "postponed"$/);
    expect(() => bracketWithdrawalStatus("", false)).toThrow(/unknown fixtures\.status ""/);
  });

  it("D-R1: an in_play fixture whose decider is pending is a hold (\"void\"), not a pending fixture to walk over", () => {
    expect(bracketWithdrawalStatus("in_play", true)).toBe("void");
    expect(bracketWithdrawalStatus("in_play", false), "the positive pair: a live game walks over").toBe("scheduled");
  });

  it("D-R1: a pending decider on any status but in_play is a contradiction (a decider owes no outcome yet and a started, unabandoned game) and throws", () => {
    let checked = 0;
    for (const s of FIXTURE_STATUSES) {
      if (s === "in_play") continue;
      expect(() => bracketWithdrawalStatus(s, true), s).toThrow(
        new RegExp(`^bracketWithdrawalStatus: a pending decider on a "${s}" fixture$`),
      );
      checked++;
    }
    expect(checked).toBe(FIXTURE_STATUSES.length - 1);
    expect(checked).toBeGreaterThan(0);
  });
});
