// W4 knockout app PR B, Task 7 (X-PL-6): what an UNDECIDED knockout source proves for each take kind (`provenBy`,
// knockout-cut-drift.ts) — the take-reader sweep's arm for `firstLosses`. Pure, no DB.
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { provenBy } from "../knockout-cut-drift";

const line = (round_no: number, home: string, away: string, winner: string | null, is_final = false) => ({
  round_no,
  is_final,
  third_place: false,
  outcome: winner === null ? null : { kind: "win", winner, loser: winner === home ? away : home },
  home_entrant_id: home,
  away_entrant_id: away,
});
// an 8-draw, round 1 decided, one quarter-final line decided
const LINES = [line(1, "a", "b", "a"), line(1, "c", "d", "d"), line(1, "e", "f", "e"), line(1, "g", "h", "g"), line(2, "a", "d", "a"), line(2, "e", "g", null)];

describe("provenBy — what a decided result proves while the source is undecided, per take kind", () => {
  it("roundLosers proves that round's losers (the legacy plate) — the positive pair", () => {
    const read = provenBy(LINES, [{ kind: "roundLosers", round: 1 }]);
    expect([...(read?.proven ?? [])].sort()).toEqual(["b", "c", "f", "h"]);
  });

  it("X-PL-6 firstLosses proves nobody and says it cannot tell (null): a first loss depends on byes and forfeits across the draw", () => {
    let checked = 0;
    for (const take of [[{ kind: "firstLosses" }], [{ kind: "rankRange", from: 1, to: 4 }, { kind: "firstLosses" }], [{ kind: "firstLosses" }, { kind: "roundLosers", round: 1 }]]) {
      expect(provenBy(LINES, take), JSON.stringify(take)).toBeNull();
      checked++;
    }
    expect(provenBy(LINES, [])?.proven.size, "empty take: nothing proven, but readable").toBe(0);
    expect(checked).toBe(3);
  });
});
