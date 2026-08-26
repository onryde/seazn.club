// RS006 ENTRIES step — self-ineligibility presentation mapping (pure, no
// DOM). Uses the SAME predicates the server evaluates with
// (@/lib/registration-rules) — this file only maps their output onto a
// division-card-shaped result, never re-derives the rule itself. That is
// the whole point of the RS006 W1 leaf-extraction refactor: one evaluator,
// two call sites.
import { describe, expect, it } from "vitest";
import {
  INELIGIBLE_MESSAGE_KEY,
  rosterEligibilityForDivision,
  rosterIssueMessageKey,
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

describe("rosterEligibilityForDivision — step 3's per-player + roster-wide verdict", () => {
  it("every player's own category/age-band issues carry a 1-based playerIndex and playerName", () => {
    const division = { category: "womens", age_min: null, age_max: null };
    const r = rosterEligibilityForDivision(
      division,
      [
        { full_name: "Alex", gender: "f", dob: null },
        { full_name: "Sam", gender: "m", dob: null },
      ],
      2026,
    );
    expect(r.eligible).toBe(false);
    const samIssue = r.issues.find((i) => i.playerName === "Sam");
    expect(samIssue?.code).toBe("CATEGORY_MISMATCH");
    expect(samIssue?.playerIndex).toBe(2);
    expect(r.issues.find((i) => i.playerName === "Alex")).toBeUndefined();
  });

  it("a mixed division with only one gender present reports MIXED_NEEDS_BOTH_GENDERS with NO playerIndex (roster-wide)", () => {
    const division = { category: "mixed", age_min: null, age_max: null };
    const r = rosterEligibilityForDivision(
      division,
      [
        { full_name: "Alex", gender: "m", dob: null },
        { full_name: "Sam", gender: "m", dob: null },
      ],
      2026,
    );
    expect(r.eligible).toBe(false);
    const mixedIssue = r.issues.find((i) => i.code === "MIXED_NEEDS_BOTH_GENDERS");
    expect(mixedIssue).toBeTruthy();
    expect(mixedIssue?.playerIndex).toBeUndefined();
  });

  it("a mixed division with both genders present, and every player's own eligibility satisfied, is fully eligible", () => {
    const division = { category: "mixed", age_min: null, age_max: null };
    const r = rosterEligibilityForDivision(
      division,
      [
        { full_name: "Alex", gender: "m", dob: null },
        { full_name: "Sam", gender: "f", dob: null },
      ],
      2026,
    );
    expect(r.eligible).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("an underage player is named by row (age-banded division)", () => {
    const division = { category: null, age_min: 18, age_max: null };
    const r = rosterEligibilityForDivision(
      division,
      [
        { full_name: "Adult Player", gender: null, dob: "1990-01-01" },
        { full_name: "Young Player", gender: null, dob: "2020-01-01" },
      ],
      2026,
    );
    expect(r.eligible).toBe(false);
    const issue = r.issues[0]!;
    expect(issue.code).toBe("AGE_TOO_YOUNG");
    expect(issue.playerIndex).toBe(2);
    expect(issue.playerName).toBe("Young Player");
  });

  it("an empty roster on a non-mixed division is vacuously eligible (nothing to check yet)", () => {
    const r = rosterEligibilityForDivision({ category: null, age_min: null, age_max: null }, [], 2026);
    expect(r.eligible).toBe(true);
  });
});

describe("rosterIssueMessageKey — step 3's roster-row override for MISSING_DOB/MISSING_GENDER", () => {
  it("MISSING_DOB/MISSING_GENDER get roster-row-specific copy, NOT the step-1-framed INELIGIBLE_MESSAGE_KEY sentence", () => {
    expect(rosterIssueMessageKey("MISSING_DOB")).not.toBe(INELIGIBLE_MESSAGE_KEY.MISSING_DOB);
    expect(rosterIssueMessageKey("MISSING_GENDER")).not.toBe(INELIGIBLE_MESSAGE_KEY.MISSING_GENDER);
    expect(rosterIssueMessageKey("MISSING_DOB")).toBeTruthy();
    expect(rosterIssueMessageKey("MISSING_GENDER")).toBeTruthy();
  });

  it("every other code falls back to INELIGIBLE_MESSAGE_KEY unchanged — one shared mapping, not a second parallel table", () => {
    expect(rosterIssueMessageKey("CATEGORY_MISMATCH")).toBe(INELIGIBLE_MESSAGE_KEY.CATEGORY_MISMATCH);
    expect(rosterIssueMessageKey("AGE_TOO_OLD")).toBe(INELIGIBLE_MESSAGE_KEY.AGE_TOO_OLD);
    expect(rosterIssueMessageKey("AGE_TOO_YOUNG")).toBe(INELIGIBLE_MESSAGE_KEY.AGE_TOO_YOUNG);
    expect(rosterIssueMessageKey("MIXED_NEEDS_BOTH_GENDERS")).toBe(INELIGIBLE_MESSAGE_KEY.MIXED_NEEDS_BOTH_GENDERS);
  });
});

describe("INELIGIBLE_MESSAGE_KEY now covers MIXED_NEEDS_BOTH_GENDERS too (RS006 W3 — rosterEligibilityForDivision produces it)", () => {
  it("has a key, distinct from every other code's key", () => {
    const key = INELIGIBLE_MESSAGE_KEY.MIXED_NEEDS_BOTH_GENDERS;
    expect(key).toBeTruthy();
    expect(Object.values(INELIGIBLE_MESSAGE_KEY).filter((k) => k === key)).toHaveLength(1);
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
