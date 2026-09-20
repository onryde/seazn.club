import { describe, expect, it } from "vitest";
import {
  swissBoardsForField,
  planSwissShells,
  isSwissBoardSeated,
  nextUnseatedSwissRound,
  latestSeatedSwissRound,
  swissRoundHasPlayedResult,
} from "@/lib/swiss-shell";
import { isOneSidedAwardBye } from "@/lib/fixture-bye";

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

  // C1 (2026-09-20 review). Every sport kernel emits `{kind:"award"}` for a
  // real TWO-SIDED forfeit or retirement, so classifying any award as a bye
  // let Unpair null out a played board's entrants, status and outcome.
  // Owner ruling 3: only a genuine system bye — exactly one seat, award
  // outcome, seated side is the winner — is exempt.
  it("two-sided forfeit award blocks Unpair (both seats set)", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "forfeited",
            outcome: { kind: "award", winner: "b" },
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("two-sided retirement award blocks Unpair even while status is scheduled", () => {
    // `fixtures.status` moves BACKWARDS when a `core.start` is voided
    // (append-event.ts fixtureStatusFromFold), so status alone may only ADD
    // refusals. The outcome shape is what decides this row.
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "scheduled",
            outcome: { kind: "award", winner: "b" },
            ext_key: "sw-r1-b2",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("an award on a one-sided row whose SEATED side is not the winner blocks", () => {
    // Not a system bye: the sitting-out entrant always wins its own bye.
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "forfeited",
            outcome: { kind: "award", winner: "ghost" },
            ext_key: "sw-r1-bye",
            home_entrant_id: "e1",
            away_entrant_id: null,
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("a two-sided award the HOME seat won blocks Unpair", () => {
    // The sibling case below has the AWAY seat winning, where `seated =
    // home ?? away` already differs from the winner and the one-seat rule is
    // never consulted. Only this orientation — winner === home, away also
    // set — can witness a dropped "exactly one seat" clause.
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "forfeited",
            outcome: { kind: "award", winner: "a" },
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("finalized blocks Unpair", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "finalized",
            outcome: { kind: "win", winner: "a", loser: "b" },
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("a forfeited row whose outcome is a WIN blocks Unpair", () => {
    // Not hypothetical: `boardgame` is the one module whose `core.forfeit`
    // folds to `{kind:"win", method:"forfeit"}` rather than an award
    // (boardgame.ts decideResult), so a chess walkover is status `forfeited`
    // with a `win` outcome. Nothing but the status list can refuse it.
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "forfeited",
            outcome: { kind: "win", winner: "a", loser: "b", method: "forfeit" },
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("in_play blocks Unpair", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "in_play",
            outcome: null,
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("abandoned blocks Unpair", () => {
    // A match that was PLAYED and stopped — match-reports.ts accepts a report
    // on exactly this status (same hole stages.ts's rebuild guard names).
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "abandoned",
            outcome: null,
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("a played board in the round blocks even when the bye row is scanned first", () => {
    // The evidence check runs over ALL rows in the round, never a "non-bye"
    // subset — the genuine bye is exempt, the board beside it is not.
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
            status: "forfeited",
            outcome: { kind: "award", winner: "b" },
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("only looks at the round it was asked about", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 2,
            status: "decided",
            outcome: { kind: "win", winner: "a" },
            ext_key: "sw-r2-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(false);
  });
  // Replaces `isSwissByeRow matches ext_key suffix and award outcome`, which
  // asserted the C1 DEFECT: it pinned a BOARD `ext_key` carrying an award
  // outcome as a bye. That is a two-sided forfeit or retirement, and calling
  // it a bye is what let Unpair destroy it. `ext_key` is not part of the test
  // at all now — an organiser cannot rename a row into being a played match.
  describe("isOneSidedAwardBye", () => {
    it("a bye: one seat, award, seated side wins", () => {
      expect(
        isOneSidedAwardBye({
          outcome: { kind: "award", winner: "e1" },
          home_entrant_id: "e1",
          away_entrant_id: null,
        }),
      ).toBe(true);
    });
    it("away-seated bye counts too", () => {
      expect(
        isOneSidedAwardBye({
          outcome: { kind: "award", winner: "e2" },
          home_entrant_id: null,
          away_entrant_id: "e2",
        }),
      ).toBe(true);
    });
    it("NOT a bye: award with BOTH seats set (forfeit / retirement)", () => {
      expect(
        isOneSidedAwardBye({
          outcome: { kind: "award", winner: "b" },
          home_entrant_id: "a",
          away_entrant_id: "b",
        }),
      ).toBe(false);
    });
    it("NOT a bye: both seats set and the HOME seat is the winner", () => {
      // The case above is decided by `seated !== winner` whichever way the
      // "exactly one seat" rule goes, so it cannot witness that rule. Here
      // `seated` WOULD equal the winner, and only the one-seat rule refuses.
      expect(
        isOneSidedAwardBye({
          outcome: { kind: "award", winner: "a" },
          home_entrant_id: "a",
          away_entrant_id: "b",
        }),
      ).toBe(false);
    });
    it("NOT a bye: one seat, but the seated side is not the winner", () => {
      expect(
        isOneSidedAwardBye({
          outcome: { kind: "award", winner: "ghost" },
          home_entrant_id: "e1",
          away_entrant_id: null,
        }),
      ).toBe(false);
    });
    it("NOT a bye: award with no winner named", () => {
      expect(
        isOneSidedAwardBye({
          outcome: { kind: "award" },
          home_entrant_id: "e1",
          away_entrant_id: null,
        }),
      ).toBe(false);
    });
    it("NOT a bye: an unseated shell, or a non-award outcome", () => {
      expect(
        isOneSidedAwardBye({ outcome: null, home_entrant_id: null, away_entrant_id: null }),
      ).toBe(false);
      expect(
        isOneSidedAwardBye({
          outcome: { kind: "win", winner: "a", loser: "b" },
          home_entrant_id: "a",
          away_entrant_id: "b",
        }),
      ).toBe(false);
    });
  });
  it("latestSeatedSwissRound picks the highest fully seated round", () => {
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
        home_entrant_id: "c",
        away_entrant_id: "d",
        outcome: null,
        ext_key: "sw-r2-b1",
      },
      {
        round_no: 3,
        home_entrant_id: null,
        away_entrant_id: null,
        outcome: null,
        ext_key: "sw-r3-b1",
      },
    ];
    expect(latestSeatedSwissRound(fx)).toBe(2);
  });
});
