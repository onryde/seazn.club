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
import {
  ageBandEligibilityIssues,
  isValidCutoffDay,
  mixedCompositionTally,
  rosterCompositionIssues,
} from "../registration-rules";

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

// RS007 review finding L1: age_cutoff_day was validated only 1-31, so
// `new Date(Date.UTC(seasonStartYear, cutoffMonth - 1, cutoffDay))` silently
// rolled an out-of-range day into the next month (31 September -> 1
// October, 30 February -> 1/2 March) — eligibility shifted by days with no
// error anywhere. The write path (checkAgeCutoff, api-v1/schemas.ts) now
// rejects the combination before it is ever stored; these pin the shared
// predicate it uses, and this file's own read-side backstop.
describe("isValidCutoffDay (RS007 review fix L1)", () => {
  it("accepts every real day of a 31-day month", () => {
    expect(isValidCutoffDay(1, 1)).toBe(true);
    expect(isValidCutoffDay(1, 31)).toBe(true);
  });

  it("rejects a day beyond a 30-day month", () => {
    expect(isValidCutoffDay(9, 30)).toBe(true); // September genuinely has 30
    expect(isValidCutoffDay(9, 31)).toBe(false); // no such day
  });

  it("caps February at 28 — 29 is rejected even though it is a real leap-year date", () => {
    // Deliberate: the SAME month/day pair is re-evaluated every season
    // against a different seasonStartYear (ageBandEligibilityIssues below),
    // so a leap-only day would still roll over 3 years out of 4.
    expect(isValidCutoffDay(2, 28)).toBe(true);
    expect(isValidCutoffDay(2, 29)).toBe(false);
    expect(isValidCutoffDay(2, 30)).toBe(false);
  });

  it("rejects an out-of-range month or a non-positive day", () => {
    expect(isValidCutoffDay(0, 1)).toBe(false);
    expect(isValidCutoffDay(13, 1)).toBe(false);
    expect(isValidCutoffDay(1, 0)).toBe(false);
  });
});

describe("ageBandEligibilityIssues — an invalid stored cutoff is SKIPPED, never thrown (RS007 review fix L1, superseded by RS011 review fix 2)", () => {
  const division = { age_min: 10, age_max: 15 };

  // RS007 fix L1 originally threw here so `Date.UTC` could never silently
  // roll an impossible day into the next month. RS011 review found that
  // throw itself reachable in production (a legacy row bypassing
  // checkAgeCutoff, the DB CHECK only range-checking 1-31) from call sites
  // that cannot tolerate an uncaught Error — setTeamSquad's "never
  // hard-blocks" contract, and 4 organiser gate points expecting a coded 422
  // rather than an unhandled 500. The fix: skip the age check entirely for
  // an unenforceable cutoff, never throw, never roll into the wrong month.
  it("does not throw for a day that does not exist in its month — treated as no enforceable age rule", () => {
    expect(() =>
      ageBandEligibilityIssues(
        { ...division, age_cutoff_month: 9, age_cutoff_day: 31 },
        { dob: "2010-07-10" },
        2026,
      ),
    ).not.toThrow();
  });

  it("an invalid cutoff returns NO age issues even for a dob that would clearly violate the band under any valid cutoff — proves the check is genuinely skipped, not accidentally passing", () => {
    const badCutoff = { ...division, age_cutoff_month: 2, age_cutoff_day: 30 }; // Feb 30 never exists
    // 2000-01-01 is ~26 in 2026 — a hard AGE_TOO_OLD against age_max: 15
    // under any real cutoff date in that range.
    expect(ageBandEligibilityIssues(badCutoff, { dob: "2000-01-01" }, 2026)).toEqual([]);
    // And the symmetric case: nothing is silently rolled into 1 March either
    // — a dob that WOULD be AGE_TOO_YOUNG evaluated at 1 March also reports
    // no issue, because no cutoff is evaluated at all.
    expect(ageBandEligibilityIssues(badCutoff, { dob: "2015-01-01" }, 2026)).toEqual([]);
  });

  it("never throws for valid input — the 1-January default, or a real configured cutoff", () => {
    expect(() => ageBandEligibilityIssues(division, { dob: "2010-07-10" }, 2026)).not.toThrow();
    expect(() =>
      ageBandEligibilityIssues(
        { ...division, age_cutoff_month: 9, age_cutoff_day: 1 },
        { dob: "2010-07-10" },
        2026,
      ),
    ).not.toThrow();
  });
});
