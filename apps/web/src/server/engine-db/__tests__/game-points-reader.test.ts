// W2d T9 fix round 1, m2: a result's GAME points (B5) are read from the identity-keyed map the standings read fills as
// it pays each result. A result the map does not hold is one this stage never paid: the reader throws, never falls back
// to the paid points (which would rank `direct` and `sberger` by the table's numbers, silently). Both directions.
import { describe, expect, it } from "vitest";
import type { FixtureResult } from "@seazn/engine/competition";
import { gamePointsReader } from "../competition";

const side = (entrantId: string, points: number) => ({ entrantId, points, played: 1, won: 0, drawn: 0, lost: 0, metrics: {} });

describe("gamePointsReader (fix round 1, m2)", () => {
  it("returns the game points of a result the stage paid, and throws for one it did not — even one equal in every field", () => {
    const paid = [side("a", 3), side("b", 0)] as unknown as FixtureResult;
    const read = gamePointsReader(new Map([[paid, [2, 1] as const]]));
    expect(read(paid), "the paid result's game points, not its table points").toEqual([2, 1]);
    const clone = [side("a", 3), side("b", 0)] as unknown as FixtureResult;
    expect(clone, "premise: structurally the same result").toEqual(paid);
    expect(() => read(clone), "a result the stage never paid").toThrow(/did not pay \(a v b\)/);
  });
});
