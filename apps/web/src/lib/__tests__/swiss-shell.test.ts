import { describe, expect, it } from "vitest";
import {
  swissBoardsForField,
  planSwissShells,
  isSwissBoardSeated,
  nextUnseatedSwissRound,
  latestSeatedSwissRound,
  swissRoundHasPlayedResult,
} from "@/lib/swiss-shell";

describe("swissBoardsForField", () => {
  it("even field → N/2 boards, no bye", () => {
    expect(swissBoardsForField(8)).toEqual({ boards: 4, bye: false });
  });
  it("odd field → floor boards + bye", () => {
    expect(swissBoardsForField(5)).toEqual({ boards: 2, bye: true });
  });
});

describe("planSwissShells", () => {
  it("mints N rounds of empty boards with stable ext_keys", () => {
    const plan = planSwissShells(3, 4);
    expect(plan).toHaveLength(6); // 2 boards × 3
    expect(plan.map((p) => p.extKey)).toEqual([
      "sw-r1-b1", "sw-r1-b2",
      "sw-r2-b1", "sw-r2-b2",
      "sw-r3-b1", "sw-r3-b2",
    ]);
  });
  it("adds one bye shell per round when odd", () => {
    const plan = planSwissShells(2, 3);
    expect(plan.filter((p) => p.bye).map((p) => p.extKey)).toEqual([
      "sw-r1-bye",
      "sw-r2-bye",
    ]);
  });
});

describe("seating / readiness helpers", () => {
  it("treats null-null scheduled as unseated", () => {
    expect(
      isSwissBoardSeated({
        home_entrant_id: null,
        away_entrant_id: null,
        outcome: null,
      }),
    ).toBe(false);
  });
  it("treats award bye as seated", () => {
    expect(
      isSwissBoardSeated({
        home_entrant_id: "e1",
        away_entrant_id: null,
        outcome: { kind: "award", winner: "e1" },
      }),
    ).toBe(true);
  });
  it("nextUnseated skips seated R1 when R2 shells empty", () => {
    const fx = [
      {
        round_no: 1,
        home_entrant_id: "a",
        away_entrant_id: "b",
        outcome: null,
        ext_key: "sw-r1-b1",
      },
      {
        round_no: 2,
        home_entrant_id: null,
        away_entrant_id: null,
        outcome: null,
        ext_key: "sw-r2-b1",
      },
    ];
    expect(nextUnseatedSwissRound(fx)).toBe(2);
  });
  it("bye award does not count as played result for Unpair", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "forfeited",
            outcome: { kind: "award", winner: "e1" },
            ext_key: "sw-r1-bye",
            home_entrant_id: "e1",
            away_entrant_id: null,
          },
          {
            round_no: 1,
            status: "scheduled",
            outcome: null,
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(false);
  });
  it("decided non-bye blocks Unpair", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "decided",
            outcome: { kind: "win", winner: "a" },
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });
});
