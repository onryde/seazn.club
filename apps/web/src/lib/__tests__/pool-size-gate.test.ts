// W5 Task 12 (X-BD-1, RB5-E4, PO-1): the one rule "each pool needs at least 2 entrants", with the pool count that works.
// The builder's Next and the server's first Generate (C38) both read this function, so they say the same numbers.
// Expected values are the rulebook's (7 into 4 leaves a pool of floor(7/4)=1; 3 pools hold floor(7/3)=2), never the function's own.
import { describe, expect, it } from "vitest";
import { poolSizeIssue } from "../pool-size-gate";

describe("poolSizeIssue (X-BD-1)", () => {
  it("X-BD-1 7 into 4 is refused naming 3", () => {
    // RB5-E4: floor(7/3)=2 works, floor(7/4)=1 does not.
    // differential: today (C38) the refusal carries no suggested count at all.
    expect(poolSizeIssue(7, 4)).toEqual({ size: 1, suggested: 3 });
  });

  it("X-BD-1 4 into 2 passes", () => {
    expect(poolSizeIssue(4, 2)).toBeNull();
  });

  it("X-BD-1 5 into 2 passes", () => {
    // pools of 3 and 2: the smallest is floor(5/2)=2.
    expect(poolSizeIssue(5, 2)).toBeNull();
  });

  it("X-BD-1 3 into 2 names 1", () => {
    expect(poolSizeIssue(3, 2)).toEqual({ size: 1, suggested: 1 });
  });

  it("X-BD-1 1 into 1 names none (the empty case: no count works)", () => {
    expect(poolSizeIssue(1, 1)).toEqual({ size: 1, suggested: null });
    expect(poolSizeIssue(0, 3)).toEqual({ size: 0, suggested: null });
  });

  it("the minimum is a parameter: min 3 turns 7 into 3 into a refusal naming 2", () => {
    expect(poolSizeIssue(7, 3, 3)).toEqual({ size: 2, suggested: 2 });
    expect(poolSizeIssue(9, 3, 3)).toBeNull();
  });

  it("sweep: every entrants 0..40 x pools 1..8 agrees with the stated rule, counted", () => {
    // The rule as the brief states it, worked by brute force: the largest count <= pools with floor(entrants/count) >= min.
    let checked = 0, refused = 0, named = 0, none = 0;
    for (let entrants = 0; entrants <= 40; entrants++) {
      for (let pools = 1; pools <= 8; pools++) {
        let want: number | null = null;
        for (let c = pools; c >= 1; c--) if (Math.floor(entrants / c) >= 2) { want = c; break; }
        const got = poolSizeIssue(entrants, pools);
        checked++;
        if (Math.floor(entrants / pools) >= 2) {
          expect(got, `${entrants} into ${pools}`).toBeNull();
          continue;
        }
        refused++;
        expect(got, `${entrants} into ${pools}`).toEqual({ size: Math.floor(entrants / pools), suggested: want });
        if (want === null) none++; else named++;
        // A suggestion is never a count the rule refuses, and never more than was asked.
        if (want !== null) { expect(want).toBeLessThan(pools); expect(Math.floor(entrants / want)).toBeGreaterThanOrEqual(2); }
      }
    }
    expect(checked, "anti-vacuity").toBe(41 * 8);
    expect(refused).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(0);
  });

  it("refuses an input it cannot mean, by name (a pool count under 1, a fraction, a negative field)", () => {
    expect(() => poolSizeIssue(7, 0)).toThrow(RangeError);
    expect(() => poolSizeIssue(7, 2.5)).toThrow(RangeError);
    expect(() => poolSizeIssue(-1, 2)).toThrow(RangeError);
    expect(() => poolSizeIssue(7, 2, 0)).toThrow(RangeError);
  });
});
