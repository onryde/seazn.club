// RS006 W3 (step 3 — DETAILS) extracted the roster-composition tally out of
// server/usecases/registration-eligibility.ts's rosterIssues, into THIS
// client-safe leaf, so the public stepper's mixed-composition meter can
// evaluate the SAME rule the server enforces at submit rather than forking a
// second implementation (this file's own header: "two eligibility evaluators
// is the exact failure the RS011 re-homing exists to prevent" — applies to a
// roster-wide predicate exactly as much as to the per-person ones already
// here). registration-eligibility.test.ts's existing
// "rosterIssues — mixed composition" describe block is the regression pin
// that the SERVER-SIDE behaviour is unchanged by this extraction; these
// tests pin the extracted primitive directly.
import { describe, expect, it } from "vitest";
import { mixedCompositionTally, rosterCompositionIssues } from "../registration-rules";

describe("mixedCompositionTally", () => {
  it("is false/false for an empty roster", () => {
    expect(mixedCompositionTally([])).toEqual({ hasM: false, hasF: false });
  });

  it("counts at least one of each independently", () => {
    expect(mixedCompositionTally([{ gender: "m" }])).toEqual({ hasM: true, hasF: false });
    expect(mixedCompositionTally([{ gender: "f" }])).toEqual({ hasM: false, hasF: true });
    expect(mixedCompositionTally([{ gender: "m" }, { gender: "f" }])).toEqual({ hasM: true, hasF: true });
  });

  it("x and null/undefined gender count toward NEITHER side", () => {
    expect(mixedCompositionTally([{ gender: "x" }, { gender: null }, { gender: undefined }])).toEqual({
      hasM: false,
      hasF: false,
    });
  });

  it("multiple players of the same gender don't change the tally beyond true", () => {
    expect(mixedCompositionTally([{ gender: "m" }, { gender: "m" }, { gender: "f" }])).toEqual({
      hasM: true,
      hasF: true,
    });
  });
});

describe("rosterCompositionIssues", () => {
  it("a mixed division with both genders present has no issue", () => {
    expect(rosterCompositionIssues({ category: "mixed" }, [{ gender: "m" }, { gender: "f" }])).toEqual([]);
  });

  it("a mixed division with only one gender present fails with MIXED_NEEDS_BOTH_GENDERS", () => {
    const issues = rosterCompositionIssues({ category: "mixed" }, [{ gender: "m" }, { gender: "m" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("MIXED_NEEDS_BOTH_GENDERS");
  });

  it("an all-x/null roster on a mixed division still fails (neither side satisfied)", () => {
    const issues = rosterCompositionIssues({ category: "mixed" }, [{ gender: "x" }, { gender: null }]);
    expect(issues.map((i) => i.code)).toEqual(["MIXED_NEEDS_BOTH_GENDERS"]);
  });

  it("an empty roster on a mixed division fails too (vacuously unsatisfied, not vacuously true)", () => {
    expect(rosterCompositionIssues({ category: "mixed" }, []).map((i) => i.code)).toEqual([
      "MIXED_NEEDS_BOTH_GENDERS",
    ]);
  });

  it("a non-mixed category is never checked, regardless of composition", () => {
    expect(rosterCompositionIssues({ category: "open" }, [{ gender: "m" }])).toEqual([]);
    expect(rosterCompositionIssues({ category: "womens" }, [{ gender: "m" }])).toEqual([]);
    expect(rosterCompositionIssues({ category: null }, [])).toEqual([]);
  });
});
