// B06a Task 5 — `provenancePct`. `report.ts` has declared the field since B01
// and nothing ever wrote it, so every report the bench has produced carries the
// honesty number the spec asks for as `undefined`.
//
// It matters most for the suites that are deliberately thin: suite 10 (carrom)
// exists to measure how the product behaves on reconstructed data, and a run
// that cannot say what fraction of its streams were reconstructed cannot make
// that point.
import { describe, expect, it } from "vitest";
import { computeProvenance } from "../provenance.ts";

function packWith(provenances: readonly string[]) {
  return {
    streams: provenances.map((provenance, i) => ({
      divisionRef: "d-tiny",
      fixtureExtKey: `f${i}`,
      provenance,
    })),
  } as Parameters<typeof computeProvenance>[0];
}

describe("computeProvenance", () => {
  it("counts each provenance value and reports the real percentage", () => {
    expect(computeProvenance(packWith(["real", "real", "reconstructed", "synthetic"]))).toEqual({
      total: 4,
      real: 2,
      reconstructed: 1,
      synthetic: 1,
      realPct: 50,
    });
  });

  it("rounds to one decimal rather than truncating", () => {
    expect(computeProvenance(packWith(["real", "real", "reconstructed"])).realPct).toBe(66.7);
  });

  it("reports the committed _tiny mix, so the number is anchored to a real pack", () => {
    // 6 real of 8 — if `_tiny` gains or loses a stream this reds, which is the
    // point: the percentage is only meaningful if it tracks the pack.
    expect(computeProvenance(packWith(["real", "real", "real", "real", "real", "real", "reconstructed", "reconstructed"]))).toMatchObject({
      total: 8,
      real: 6,
      realPct: 75,
    });
  });

  it("returns zero for a pack with no streams instead of dividing by zero", () => {
    expect(computeProvenance(packWith([]))).toEqual({
      total: 0,
      real: 0,
      reconstructed: 0,
      synthetic: 0,
      realPct: 0,
    });
  });

  it("counts a provenance value it does not know rather than dropping it", () => {
    // `total` must always equal the stream count: a value added to PackSchema
    // later must show up as a gap between total and the three known buckets,
    // never as a silently smaller denominator that flatters the percentage.
    const p = computeProvenance(packWith(["real", "borrowed" as string]));
    expect(p.total).toBe(2);
    expect(p.realPct).toBe(50);
  });
});
