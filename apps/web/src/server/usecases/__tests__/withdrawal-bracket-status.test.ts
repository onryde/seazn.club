// W2a fix round 2 (review N4): the bracket withdrawal mapping names every fixtures.status and refuses an unknown one,
// as `engineFixtureStatus` does — a status added to the domain without a ruling here throws instead of silently
// reading as "void".
// W2b (spec §5.4, rulings R8/R14): the W2a HOLDS are gone. A held level result (needs_decision, X-WD-1), a pending
// tie-break (R14 — the engine admits `withdrew` in every phase but "over") and a scorer-abandoned, unsettled line
// (D-G2 corner 1: the cascade voids the abandon first) are all walked over, so each maps to "scheduled" — a line the
// planner hands to the remaining side. The D-R1 contradiction throw (a pending decider on any status but in_play) went
// with the hold: the decider no longer changes the mapping (C-2).
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES, type FixtureStatusValue } from "@/lib/fixture-status";
import { bracketWithdrawalStatus } from "@/server/usecases/withdrawal";

type Ruled = "decided" | "scheduled" | "void";

/** The ruling per status, typed from the rulings (spec 05 §5; W2b spec §5.4's table), not read from the code under
 *  test. Without an active abandon: */
const RULED: Record<FixtureStatusValue, Ruled> = {
  decided: "decided", // played: the result stands
  finalized: "decided",
  forfeited: "decided",
  scheduled: "scheduled", // still to play
  in_play: "scheduled", // live, or a chess tie-break pending (R14)
  needs_decision: "scheduled", // X-WD-1: a held level result walks over, retirement credit
  abandoned: "void", // the cascade's own void (no event): dead already, nothing to walk over
  cancelled: "void",
};

/** …and with an ACTIVE `core.abandon` in the ledger (`hasActiveAbandonSql`): only a scorer-abandoned line differs —
 *  D-G2 corner 1, the abandon is voided and the line walked over. A settle over an abandon folds to `decided`. */
const RULED_ACTIVE_ABANDON: Record<FixtureStatusValue, Ruled> = { ...RULED, abandoned: "scheduled" };

describe("bracketWithdrawalStatus (review N4; W2b R8/R14)", () => {
  it("N4: every fixtures.status maps as ruled, with and without an active abandon, and the ruling table covers exactly the status domain", () => {
    expect(Object.keys(RULED).sort()).toEqual([...FIXTURE_STATUSES].sort());
    let checked = 0;
    for (const s of FIXTURE_STATUSES) {
      expect(bracketWithdrawalStatus(s, false), s).toBe(RULED[s]);
      expect(bracketWithdrawalStatus(s, true), `${s} (active abandon)`).toBe(RULED_ACTIVE_ABANDON[s]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(FIXTURE_STATUSES.length);
    // The one row the flag moves, with its pair.
    expect([bracketWithdrawalStatus("abandoned", true), bracketWithdrawalStatus("abandoned", false)]).toEqual(["scheduled", "void"]);
  });

  it("N4: an unknown status throws (never a silent void), with or without an active abandon", () => {
    for (const flag of [false, true]) {
      expect(() => bracketWithdrawalStatus("postponed", flag)).toThrow(/^bracketWithdrawalStatus: unknown fixtures\.status "postponed"$/);
      expect(() => bracketWithdrawalStatus("", flag)).toThrow(/unknown fixtures\.status ""/);
    }
  });

  it("X-WD-1 / R14: the W2a holds are walk-overs now — a held level result and a live (or tie-break) game both map to scheduled", () => {
    expect(bracketWithdrawalStatus("needs_decision", false), "X-WD-1: was the C17 hold (void)").toBe("scheduled");
    expect(bracketWithdrawalStatus("in_play", false), "R14: a pending tie-break is in_play, walked over").toBe("scheduled");
  });
});
