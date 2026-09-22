// apps/web/src/lib/__tests__/swiss-pairing.test.ts
import { describe, expect, it } from "vitest";
import { pairRound, type SwissStanding } from "@seazn/engine/scheduling";
import type { EntrantId } from "@seazn/engine/core";
import {
  effectiveSwissPairing,
  roundOnePairs,
  storedSwissPairing,
} from "@/lib/swiss-pairing";

describe("effectiveSwissPairing", () => {
  // Empty case FIRST (AGENTS rule: a ladder states its empty case first).
  it("no override, round 1, fold stored ⇒ fold", () => {
    expect(effectiveSwissPairing({ stored: "fold", round: 1 })).toBe("fold");
  });
  it("round 1 of a rank_adjacent stage defaults to fold (ruling C)", () => {
    expect(effectiveSwissPairing({ stored: "rank_adjacent", round: 1 })).toBe("fold");
  });
  it.each([2, 3, 4])("round %i uses the stored mode", (round) => {
    expect(effectiveSwissPairing({ stored: "rank_adjacent", round })).toBe("rank_adjacent");
    expect(effectiveSwissPairing({ stored: "fold", round })).toBe("fold");
  });
  it("an override wins in round 1", () => {
    expect(effectiveSwissPairing({ override: "rank_adjacent", stored: "fold", round: 1 })).toBe("rank_adjacent");
    expect(effectiveSwissPairing({ override: "fold", stored: "rank_adjacent", round: 1 })).toBe("fold");
  });
});

describe("storedSwissPairing", () => {
  it("absent or unknown ⇒ fold; rank_adjacent ⇒ rank_adjacent", () => {
    expect(storedSwissPairing({})).toBe("fold");
    expect(storedSwissPairing({ pairing: "nonsense" })).toBe("fold");
    expect(storedSwissPairing({ pairing: "rank_adjacent" })).toBe("rank_adjacent");
  });
});

describe("roundOnePairs mirrors the engine", () => {
  // Derived from pairRound itself so a change to the engine moves this test.
  function engine(n: number, pairing: "fold" | "rank_adjacent"): Array<[number, number]> {
    const standings: SwissStanding[] = Array.from({ length: n }, (_, i) => ({
      entrantId: String(i + 1) as EntrantId,
      score: 0,
      rank: i + 1,
    }));
    return pairRound(standings, { played: new Set() }, pairing === "rank_adjacent" ? { pairing } : {})
      .pairings.map((p) => [Number(p.home), Number(p.away)].sort((a, b) => a - b) as [number, number])
      .sort((a, b) => a[0] - b[0]);
  }
  it.each([2, 3, 7, 8, 10, 11])("n=%i", (n) => {
    expect(roundOnePairs(n, "fold")).toEqual(engine(n, "fold"));
    expect(roundOnePairs(n, "rank_adjacent")).toEqual(engine(n, "rank_adjacent"));
  });
  it("the two modes differ for 10 (the prod case)", () => {
    expect(roundOnePairs(10, "fold")[0]).toEqual([1, 6]);
    expect(roundOnePairs(10, "rank_adjacent")[0]).toEqual([1, 2]);
  });
  it("fewer than 2 ⇒ no pairs", () => expect(roundOnePairs(1, "fold")).toEqual([]));
});
