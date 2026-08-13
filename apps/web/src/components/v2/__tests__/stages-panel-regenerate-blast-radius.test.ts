import { describe, expect, it } from "vitest";
import { regenerationBlastRadius } from "@/components/v2/stages-panel";

// P6/D4b task B scope item 2 — the destructive-edit warning dialog. Design
// ruling (plan doc): "the dialog is client-side and computes its own blast
// radius from the fixtures the panel already holds" — every fixture
// currently in the stage is at risk (generateStageFixtures's diff can't be
// replicated client-side), named alongside how many are scheduled and how
// many carry a result. Pure function, no DOM — mirrors
// generatePreconditionMessage's export-for-unit-testing convention in this
// same file.
type FixtureRow = Parameters<typeof regenerationBlastRadius>[0][number];

function fixture(overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    id: "f1",
    stage_id: "s1",
    pool_id: null,
    round_no: 1,
    seq_in_round: 1,
    fixture_no: 1,
    home_entrant_id: null,
    away_entrant_id: null,
    scheduled_at: null,
    venue: null,
    court_label: null,
    status: "scheduled",
    outcome: null,
    ...overrides,
  };
}

describe("regenerationBlastRadius", () => {
  it("an empty stage (first-ever generate) counts zero on every axis", () => {
    expect(regenerationBlastRadius([])).toEqual({ discarded: 0, scheduled: 0, withResults: 0 });
  });

  it("discarded is the total fixture count, regardless of scheduled/result state", () => {
    const fixtures = [fixture({ id: "a" }), fixture({ id: "b" }), fixture({ id: "c" })];
    expect(regenerationBlastRadius(fixtures).discarded).toBe(3);
  });

  it("scheduled counts only fixtures with a non-null scheduled_at", () => {
    const fixtures = [
      fixture({ id: "a", scheduled_at: "2026-09-01T10:00:00Z" }),
      fixture({ id: "b", scheduled_at: null }),
      fixture({ id: "c", scheduled_at: "2026-09-02T10:00:00Z" }),
    ];
    expect(regenerationBlastRadius(fixtures).scheduled).toBe(2);
  });

  it("withResults counts only fixtures whose outcome carries a real kind (mirrors outcomeText's own check)", () => {
    const fixtures = [
      fixture({ id: "a", outcome: { kind: "win", winner: "e1" } }),
      fixture({ id: "b", outcome: null }),
      fixture({ id: "c", outcome: { kind: "draw" } }),
    ];
    expect(regenerationBlastRadius(fixtures).withResults).toBe(2);
  });

  it("an outcome object with no kind (e.g. {}) does not count as a result", () => {
    const fixtures = [fixture({ id: "a", outcome: {} })];
    expect(regenerationBlastRadius(fixtures).withResults).toBe(0);
  });

  it("a realistic mixed stage: 4 fixtures, 3 scheduled, 1 decided", () => {
    const fixtures = [
      fixture({ id: "a", scheduled_at: "2026-09-01T10:00:00Z", outcome: { kind: "win", winner: "e1" }, status: "decided" }),
      fixture({ id: "b", scheduled_at: "2026-09-01T11:00:00Z" }),
      fixture({ id: "c", scheduled_at: "2026-09-01T12:00:00Z" }),
      fixture({ id: "d" }),
    ];
    expect(regenerationBlastRadius(fixtures)).toEqual({ discarded: 4, scheduled: 3, withResults: 1 });
  });
});
