// RS006 ENTRIES step — self-ineligibility presentation mapping (pure, no
// DOM). Uses the SAME predicates the server evaluates with
// (@/lib/registration-rules) — this file only maps their output onto a
// division-card-shaped result, never re-derives the rule itself. That is
// the whole point of the RS006 W1 leaf-extraction refactor: one evaluator,
// two call sites.
import { describe, expect, it } from "vitest";
import {
  INELIGIBLE_MESSAGE_KEY,
  seasonStartYearFrom,
  selfEligibilityForDivision,
} from "../eligibility-presentation";

describe("selfEligibilityForDivision", () => {
  it("open/null category, no age band: everyone is eligible, even with no dob/gender known yet", () => {
    const r = selfEligibilityForDivision(
      { category: null, age_min: null, age_max: null },
      { dob: null, gender: null },
      2026,
    );
    expect(r.eligible).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("womens category: a male contact is ineligible with CATEGORY_MISMATCH", () => {
    const r = selfEligibilityForDivision(
      { category: "womens", age_min: null, age_max: null },
      { dob: null, gender: "m" },
      2026,
    );
    expect(r.eligible).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["CATEGORY_MISMATCH"]);
  });

  it("womens category: gender 'x' is eligible (owner ruling — x never blocks a category check)", () => {
    const r = selfEligibilityForDivision(
      { category: "womens", age_min: null, age_max: null },
      { dob: null, gender: "x" },
      2026,
    );
    expect(r.eligible).toBe(true);
  });

  it("mixed category imposes NOTHING at the individual level (roster-wide, not evaluated here)", () => {
    const r = selfEligibilityForDivision(
      { category: "mixed", age_min: null, age_max: null },
      { dob: null, gender: "m" },
      2026,
    );
    expect(r.eligible).toBe(true);
  });

  it("age band: too young/too old both surface with AGE_TOO_YOUNG/AGE_TOO_OLD", () => {
    const division = { category: null, age_min: 18, age_max: 35 };
    const tooYoung = selfEligibilityForDivision(division, { dob: "2020-01-01", gender: null }, 2026);
    expect(tooYoung.issues.map((i) => i.code)).toEqual(["AGE_TOO_YOUNG"]);
    const tooOld = selfEligibilityForDivision(division, { dob: "1950-01-01", gender: null }, 2026);
    expect(tooOld.issues.map((i) => i.code)).toEqual(["AGE_TOO_OLD"]);
    const inBand = selfEligibilityForDivision(division, { dob: "2000-01-01", gender: null }, 2026);
    expect(inBand.eligible).toBe(true);
  });

  it("category AND age band together yield BOTH issues (independent, additive — matches divisionEligibilityIssues)", () => {
    const r = selfEligibilityForDivision(
      { category: "mens", age_min: 18, age_max: 35 },
      { dob: "2020-01-01", gender: "f" },
      2026,
    );
    expect(r.eligible).toBe(false);
    expect(r.issues.map((i) => i.code).sort()).toEqual(["AGE_TOO_YOUNG", "CATEGORY_MISMATCH"]);
  });

  it("no dob known yet on an age-restricted division reads as MISSING_DOB, not silently eligible", () => {
    const r = selfEligibilityForDivision(
      { category: null, age_min: 18, age_max: null },
      { dob: null, gender: null },
      2026,
    );
    expect(r.issues.map((i) => i.code)).toEqual(["MISSING_DOB"]);
  });
});

describe("INELIGIBLE_MESSAGE_KEY — the ONE presentation mapping DivisionCard and EntryCart both key off (fix wave finding #3: no second rule evaluation)", () => {
  it("has an i18n key for every code selfEligibilityForDivision can actually produce", () => {
    const r = selfEligibilityForDivision(
      { category: "mens", age_min: 18, age_max: 35 },
      { dob: "2020-01-01", gender: "f" },
      2026,
    );
    for (const issue of r.issues) {
      expect(INELIGIBLE_MESSAGE_KEY[issue.code], `no key for ${issue.code}`).toBeTruthy();
    }
  });

  it("MISSING_DOB and MISSING_GENDER map to their own distinct keys (not a shared generic one)", () => {
    expect(INELIGIBLE_MESSAGE_KEY.MISSING_DOB).toBe("register.entries.ineligible.missingDob");
    expect(INELIGIBLE_MESSAGE_KEY.MISSING_GENDER).toBe("register.entries.ineligible.missingGender");
  });

  it("AGE_TOO_OLD and AGE_TOO_YOUNG share the one generic age-range key", () => {
    expect(INELIGIBLE_MESSAGE_KEY.AGE_TOO_OLD).toBe(INELIGIBLE_MESSAGE_KEY.AGE_TOO_YOUNG);
  });
});

describe("seasonStartYearFrom", () => {
  it("reads the year off a real starts_on date", () => {
    expect(seasonStartYearFrom("2026-09-15")).toBe(2026);
  });

  it("falls back to the given date's year when starts_on is null", () => {
    expect(seasonStartYearFrom(null, new Date("2027-03-01T00:00:00Z"))).toBe(2027);
  });

  it("falls back on an unparsable starts_on rather than propagating NaN", () => {
    expect(seasonStartYearFrom("not-a-date", new Date("2027-03-01T00:00:00Z"))).toBe(2027);
  });
});
