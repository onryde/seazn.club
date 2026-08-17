// RS002 wave 2 (rewritten per _INDEX.md "RS002 entry conditions" item 5,
// 2026-08-17): eligibility extracted from registrations.ts, evaluating the
// V364 first-class divisions.category/age_min/age_max columns alongside the
// existing jsonb eligibility rules, plus roster-level rosterIssues.
//
// Return shape is now STRUCTURED (EligibilityIssue[] with a machine `code`),
// not string[] — RS011's organiser-side gates consume this same evaluator and
// need codes for a 422's extra.violations[] and an override dialog, not
// English sentences to re-parse. Assertions below check `code`/`meta`
// wherever the old version checked a sentence; formatted-English coverage is
// deliberately kept to ONE test so the display path (formatEligibilityIssues)
// stays covered without re-coupling every case to exact wording.
import { describe, expect, it } from "vitest";
import {
  ageAt,
  divisionEligibilityIssues,
  formatEligibilityIssues,
  isMinor,
  requiresDob,
  rosterIssues,
  type EligibilityDivision,
  type EligibilityIssue,
  type EligibilityRosterPlayer,
} from "../registration-eligibility";
// The move must not shrink the set of importers: registrations.ts re-exports
// every moved symbol verbatim. `eligibilityIssues` was ALSO re-exported here
// originally, but the legacy string[] wrapper it named was deleted at its
// source (RS002 W5 whole-branch review — zero production callers repo-wide,
// dead since this file's own W2) — nothing re-exports it any more, so this
// file no longer imports it either.
import {
  ageAt as reexportedAgeAt,
  isMinor as reexportedIsMinor,
  requiresDob as reexportedRequiresDob,
} from "../registrations";

const NO_RULES: EligibilityDivision = {
  eligibility: [],
  category: null,
  age_min: null,
  age_max: null,
};

/** Strip `message` for assertions that only care about the structured part —
 *  keeps every test below decoupled from the exact English wording. */
function codesOf(issues: EligibilityIssue[]) {
  return issues.map(({ code, meta, playerIndex, playerName }) => ({
    code,
    ...(meta !== undefined ? { meta } : {}),
    ...(playerIndex !== undefined ? { playerIndex } : {}),
    ...(playerName !== undefined ? { playerName } : {}),
  }));
}

describe("registrations.ts re-exports the moved eligibility helpers", () => {
  it("re-exported ageAt/isMinor/requiresDob behave identically to the originals", () => {
    expect(reexportedAgeAt("2010-06-05", new Date("2026-06-05T00:00:00Z"))).toBe(
      ageAt("2010-06-05", new Date("2026-06-05T00:00:00Z")),
    );
    expect(reexportedIsMinor("2010-01-01", new Date("2026-01-01T00:00:00Z"))).toBe(
      isMinor("2010-01-01", new Date("2026-01-01T00:00:00Z")),
    );
    expect(reexportedRequiresDob([])).toBe(false);
    expect(reexportedRequiresDob([{ kind: "age", maxAgeAt: 10 }])).toBe(true);
  });
});

describe("requiresDob (division-aware overload, V364) — unaffected by the code rework, still boolean", () => {
  it("is true for a division with only age_min/age_max set and no jsonb age rule", () => {
    expect(requiresDob({ eligibility: [], age_min: 10, age_max: null })).toBe(true);
    expect(requiresDob({ eligibility: [], age_min: null, age_max: 18 })).toBe(true);
  });

  it("is false when neither the jsonb rules nor the age columns require one", () => {
    expect(requiresDob({ eligibility: [], age_min: null, age_max: null })).toBe(false);
  });

  it("still honours the jsonb rules when passed as a division", () => {
    expect(
      requiresDob({ eligibility: [{ kind: "age", maxAgeAt: 15 }], age_min: null, age_max: null }),
    ).toBe(true);
  });

  it("legacy bare-array call keeps working (jsonb-only overload)", () => {
    expect(requiresDob([])).toBe(false);
    expect(requiresDob([{ kind: "age", maxAgeAt: 15 }])).toBe(true);
    expect(requiresDob([{ kind: "gender", allowed: ["f"] }])).toBe(false);
  });
});

describe("formatEligibilityIssues(divisionEligibilityIssues(...)) — literal English is pinned per code", () => {
  // Review finding (MAJOR, post-W2b) this describe block exists to satisfy:
  // comparing the display path against ITSELF is tautological. These five
  // assertions hardcode the literal sentence instead, so something pins the
  // actual bytes, not just "whatever the code currently does" — the display
  // strings are the thing that must not drift silently.
  //
  // Previously routed through the legacy `eligibilityIssues` string[]
  // wrapper (deleted, RS002 W5 whole-branch review — zero production callers
  // repo-wide, dead since this file's own W2). Moved onto
  // `formatEligibilityIssues(divisionEligibilityIssues(...))` directly —
  // the REAL display path, not a wrapper around it — with the exact same
  // hardcoded expected strings, unchanged.
  const ageRule = [
    {
      kind: "age",
      maxAgeAt: 15,
      minAgeAt: 10,
      cutoff: { month: 1, day: 1, yearOf: "season_start" as const },
    },
  ];
  const genderRule = [{ kind: "gender", allowed: ["f"] }];
  const noCategoryOrAgeBand = { category: null, age_min: null, age_max: null };

  it("MISSING_DOB", () => {
    // Reverting registration-eligibility.ts's jsonb age branch's MISSING_DOB
    // push changes this string and reds the test.
    const division: EligibilityDivision = { eligibility: ageRule, ...noCategoryOrAgeBand };
    expect(formatEligibilityIssues(divisionEligibilityIssues(division, { dob: null }, 2026))).toEqual([
      "Date of birth is required for this age-restricted division.",
    ]);
  });

  it("AGE_TOO_OLD", () => {
    // Pins the age-16-over-maxAgeAt-15 branch.
    const division: EligibilityDivision = { eligibility: ageRule, ...noCategoryOrAgeBand };
    expect(
      formatEligibilityIssues(divisionEligibilityIssues(division, { dob: "2010-01-01" }, 2026)),
    ).toEqual(["Too old for this division (must be 15 or younger on the cutoff date)."]);
  });

  it("AGE_TOO_YOUNG", () => {
    // Pins the age-9-under-minAgeAt-10 branch.
    const division: EligibilityDivision = { eligibility: ageRule, ...noCategoryOrAgeBand };
    expect(
      formatEligibilityIssues(divisionEligibilityIssues(division, { dob: "2017-01-01" }, 2026)),
    ).toEqual(["Too young for this division (must be 10 or older on the cutoff date)."]);
  });

  it("GENDER_NOT_ALLOWED", () => {
    const division: EligibilityDivision = { eligibility: genderRule, ...noCategoryOrAgeBand };
    expect(formatEligibilityIssues(divisionEligibilityIssues(division, { gender: "m" }, 2026))).toEqual([
      "This division is not open to your gender category.",
    ]);
  });

  it("MISSING_GENDER", () => {
    // Pins the jsonb gender branch.
    const division: EligibilityDivision = { eligibility: genderRule, ...noCategoryOrAgeBand };
    expect(formatEligibilityIssues(divisionEligibilityIssues(division, { gender: null }, 2026))).toEqual([
      "Gender is required for this division.",
    ]);
  });

  it("still returns [] for an eligible input", () => {
    expect(formatEligibilityIssues(divisionEligibilityIssues(NO_RULES, { dob: null }, 2026))).toEqual([]);
  });
});

describe("MISSING_DOB / MISSING_GENDER are plain codes — no severity, no baked-in policy", () => {
  it("the module never attaches a severity field; blocking-vs-warning is entirely the caller's decision", () => {
    const ageOnlyDivision: EligibilityDivision = { ...NO_RULES, age_min: 10, age_max: null };
    const dobIssues = divisionEligibilityIssues(ageOnlyDivision, { dob: null }, 2026);
    expect(codesOf(dobIssues)).toEqual([{ code: "MISSING_DOB" }]);
    expect(dobIssues[0]).not.toHaveProperty("severity");

    const mensDivision: EligibilityDivision = { ...NO_RULES, category: "mens" };
    const genderIssues = divisionEligibilityIssues(mensDivision, { gender: null }, 2026);
    expect(codesOf(genderIssues)).toEqual([{ code: "MISSING_GENDER" }]);
    expect(genderIssues[0]).not.toHaveProperty("severity");

    // The jsonb-rule path emits the SAME codes for the SAME reason (no dob
    // present for an age rule, no gender present for a gender rule) — one
    // vocabulary, whichever source triggered it.
    const jsonbAgeDivision: EligibilityDivision = {
      ...NO_RULES,
      eligibility: [{ kind: "age", maxAgeAt: 15 }],
    };
    expect(codesOf(divisionEligibilityIssues(jsonbAgeDivision, { dob: null }, 2026))).toEqual([
      { code: "MISSING_DOB" },
    ]);
  });
});

describe("meta carries structured detail a consumer would otherwise have to re-parse from the sentence", () => {
  it("AGE_TOO_OLD/AGE_TOO_YOUNG carry the limit, GENDER_NOT_ALLOWED the allowed list, CATEGORY_MISMATCH the category", () => {
    const ageDivision: EligibilityDivision = { ...NO_RULES, age_min: 10, age_max: 15 };
    expect(codesOf(divisionEligibilityIssues(ageDivision, { dob: "2010-01-01" }, 2026))).toEqual([
      { code: "AGE_TOO_OLD", meta: { limit: 15 } },
    ]); // age 16
    expect(codesOf(divisionEligibilityIssues(ageDivision, { dob: "2017-01-01" }, 2026))).toEqual([
      { code: "AGE_TOO_YOUNG", meta: { limit: 10 } },
    ]); // age 9

    const jsonbGenderDivision: EligibilityDivision = {
      ...NO_RULES,
      eligibility: [{ kind: "gender", allowed: ["f", "x"] }],
    };
    expect(
      codesOf(divisionEligibilityIssues(jsonbGenderDivision, { gender: "m" }, 2026)),
    ).toEqual([{ code: "GENDER_NOT_ALLOWED", meta: { allowed: ["f", "x"] } }]);

    const mensDivision: EligibilityDivision = { ...NO_RULES, category: "mens" };
    expect(codesOf(divisionEligibilityIssues(mensDivision, { gender: "f" }, 2026))).toEqual([
      { code: "CATEGORY_MISMATCH", meta: { category: "mens" } },
    ]);
  });
});

describe("divisionEligibilityIssues — category (mens/womens), x never blocks", () => {
  const mens: EligibilityDivision = { ...NO_RULES, category: "mens" };
  const womens: EligibilityDivision = { ...NO_RULES, category: "womens" };

  it("mens: an f player yields CATEGORY_MISMATCH", () => {
    expect(codesOf(divisionEligibilityIssues(mens, { gender: "f" }, 2026))).toEqual([
      { code: "CATEGORY_MISMATCH", meta: { category: "mens" } },
    ]);
  });

  it("mens: an x player is NOT an issue", () => {
    expect(divisionEligibilityIssues(mens, { gender: "x" }, 2026)).toEqual([]);
  });

  it("mens: a null-gender player yields MISSING_GENDER", () => {
    expect(codesOf(divisionEligibilityIssues(mens, { gender: null }, 2026))).toEqual([
      { code: "MISSING_GENDER" },
    ]);
  });

  it("mens: an m player is eligible", () => {
    expect(divisionEligibilityIssues(mens, { gender: "m" }, 2026)).toEqual([]);
  });

  it("womens: an m player is CATEGORY_MISMATCH, f is eligible, x is eligible", () => {
    expect(codesOf(divisionEligibilityIssues(womens, { gender: "m" }, 2026))).toEqual([
      { code: "CATEGORY_MISMATCH", meta: { category: "womens" } },
    ]);
    expect(divisionEligibilityIssues(womens, { gender: "f" }, 2026)).toEqual([]);
    expect(divisionEligibilityIssues(womens, { gender: "x" }, 2026)).toEqual([]);
  });

  it("open and null category constrain nothing at the individual level", () => {
    const open: EligibilityDivision = { ...NO_RULES, category: "open" };
    for (const gender of ["m", "f", "x", null]) {
      expect(divisionEligibilityIssues(open, { gender }, 2026)).toEqual([]);
      expect(divisionEligibilityIssues(NO_RULES, { gender }, 2026)).toEqual([]);
    }
  });

  it("mixed constrains nothing at the individual level (roster-wide only)", () => {
    const mixed: EligibilityDivision = { ...NO_RULES, category: "mixed" };
    for (const gender of ["m", "f", "x", null]) {
      expect(divisionEligibilityIssues(mixed, { gender }, 2026)).toEqual([]);
    }
  });
});

describe("divisionEligibilityIssues — one code per root cause (jsonb GenderRule + mens/womens category overlap)", () => {
  // Review finding (MINOR 1): a division carrying BOTH a jsonb GenderRule and
  // a mens/womens category used to double-emit for one person — MISSING_GENDER
  // from both blocks, or GENDER_NOT_ALLOWED + CATEGORY_MISMATCH together.
  // Ruling: the jsonb rule (organiser-authored, more specific) wins; the
  // category block emits nothing further for gender once jsonb already has.
  const bothSources: EligibilityDivision = {
    eligibility: [{ kind: "gender", allowed: ["m"] }],
    category: "mens",
    age_min: null,
    age_max: null,
  };

  it("gender=null yields exactly ONE MISSING_GENDER, not two", () => {
    // Reverting the dedup guard on registration-eligibility.ts's category
    // block (the `!jsonbGenderIssue &&` condition) makes this a 2-element
    // array again and reds.
    expect(codesOf(divisionEligibilityIssues(bothSources, { gender: null }, 2026))).toEqual([
      { code: "MISSING_GENDER" },
    ]);
  });

  it("a gender failing both sources yields only GENDER_NOT_ALLOWED — jsonb wins over CATEGORY_MISMATCH", () => {
    expect(codesOf(divisionEligibilityIssues(bothSources, { gender: "f" }, 2026))).toEqual([
      { code: "GENDER_NOT_ALLOWED", meta: { allowed: ["m"] } },
    ]);
  });

  it("roster-level MIXED_NEEDS_BOTH_GENDERS still fires independently — it is a roster property, not a person one", () => {
    const mixedWithJsonbRule: EligibilityDivision = {
      eligibility: [{ kind: "gender", allowed: ["m", "f"] }], // both pass this jsonb rule
      category: "mixed",
      age_min: null,
      age_max: null,
    };
    const players: EligibilityRosterPlayer[] = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "m" }, // both pass jsonb; roster still lacks an f
    ];
    expect(codesOf(rosterIssues(mixedWithJsonbRule, players, 2026))).toEqual([
      { code: "MIXED_NEEDS_BOTH_GENDERS" },
    ]);
  });
});

describe("divisionEligibilityIssues — age band (first-class age_min/age_max)", () => {
  // Cutoff = 1 Jan of seasonStartYear. Dobs land exactly on Jan 1 so the age
  // math is exact: age = seasonStartYear - dobYear.
  const division: EligibilityDivision = { ...NO_RULES, age_min: 10, age_max: 15 };
  const seasonStartYear = 2026;

  it("above age_max is AGE_TOO_OLD", () => {
    expect(codesOf(divisionEligibilityIssues(division, { dob: "2010-01-01" }, seasonStartYear))).toEqual([
      { code: "AGE_TOO_OLD", meta: { limit: 15 } },
    ]); // age 16
  });

  it("below age_min is AGE_TOO_YOUNG", () => {
    expect(codesOf(divisionEligibilityIssues(division, { dob: "2017-01-01" }, seasonStartYear))).toEqual([
      { code: "AGE_TOO_YOUNG", meta: { limit: 10 } },
    ]); // age 9
  });

  it("exactly on the age_max boundary is eligible", () => {
    expect(divisionEligibilityIssues(division, { dob: "2011-01-01" }, seasonStartYear)).toEqual([]); // age 15
  });

  it("exactly on the age_min boundary is eligible", () => {
    expect(divisionEligibilityIssues(division, { dob: "2016-01-01" }, seasonStartYear)).toEqual([]); // age 10
  });

  it("missing dob is MISSING_DOB when age_min/age_max is set", () => {
    expect(codesOf(divisionEligibilityIssues(division, { dob: null }, seasonStartYear))).toEqual([
      { code: "MISSING_DOB" },
    ]);
  });

  it("is evaluated at 1 January of seasonStartYear, not 'today'", () => {
    // seasonStartYear deliberately far from the real current year: if the
    // production code used `new Date()` instead of the season-start cutoff,
    // this dob would read as 6 years OLDER than intended and fail age_max.
    const currentYear = new Date().getUTCFullYear();
    const pastSeasonStartYear = currentYear - 6;
    const overAgeMax: EligibilityDivision = { ...NO_RULES, age_max: 12 };
    const dob = `${pastSeasonStartYear - 10}-01-01`; // age 10 AT the season-start cutoff
    expect(divisionEligibilityIssues(overAgeMax, { dob }, pastSeasonStartYear)).toEqual([]);
  });
});

describe("divisionEligibilityIssues — jsonb rules and first-class columns apply together", () => {
  it("a division with both a jsonb gender rule and a first-class age_min yields both codes", () => {
    const division: EligibilityDivision = {
      eligibility: [{ kind: "gender", allowed: ["f"] }],
      category: null,
      age_min: 21,
      age_max: null,
    };
    expect(
      codesOf(divisionEligibilityIssues(division, { dob: "2015-01-01", gender: "m" }, 2026)),
    ).toEqual([
      { code: "GENDER_NOT_ALLOWED", meta: { allowed: ["f"] } }, // jsonb rule
      { code: "AGE_TOO_YOUNG", meta: { limit: 21 } }, // first-class column, age 11
    ]);
  });
});

describe("rosterIssues — per-player codes carry 1-based index and name", () => {
  it("names the offending row by 1-based index and player name", () => {
    const division: EligibilityDivision = { ...NO_RULES, category: "mens" };
    const players: EligibilityRosterPlayer[] = [
      { full_name: "Sam Lee", gender: "f" },
      { full_name: "Alex Kim", gender: "m" },
    ];
    expect(codesOf(rosterIssues(division, players, 2026))).toEqual([
      { code: "CATEGORY_MISMATCH", meta: { category: "mens" }, playerIndex: 1, playerName: "Sam Lee" },
    ]);
  });

  it("age band issues in a roster carry their 1-based row index; boundary rows are silent", () => {
    const division: EligibilityDivision = { ...NO_RULES, age_min: 10, age_max: 15 };
    const players: EligibilityRosterPlayer[] = [
      { full_name: "Over Age", dob: "2010-01-01" }, // 16 — over age_max
      { full_name: "Under Age", dob: "2017-01-01" }, // 9 — under age_min
      { full_name: "At Max", dob: "2011-01-01" }, // 15 — boundary, eligible
      { full_name: "At Min", dob: "2016-01-01" }, // 10 — boundary, eligible
    ];
    expect(codesOf(rosterIssues(division, players, 2026))).toEqual([
      { code: "AGE_TOO_OLD", meta: { limit: 15 }, playerIndex: 1, playerName: "Over Age" },
      { code: "AGE_TOO_YOUNG", meta: { limit: 10 }, playerIndex: 2, playerName: "Under Age" },
    ]);
  });
});

describe("rosterIssues accepts a persons-shaped row (organiser gates call it against `persons`, no full_name required)", () => {
  it("works with a row that has no full_name — code/meta/playerIndex are still correct, playerName is null", () => {
    const division: EligibilityDivision = { ...NO_RULES, category: "mens" };
    // A `persons` row: no full_name at all, unlike a registration_players row.
    const players: EligibilityRosterPlayer[] = [{ gender: "f" }, { full_name: "Sam Lee", gender: "f" }];
    const issues = rosterIssues(division, players, 2026);
    expect(codesOf(issues)).toEqual([
      { code: "CATEGORY_MISMATCH", meta: { category: "mens" }, playerIndex: 1, playerName: null },
      { code: "CATEGORY_MISMATCH", meta: { category: "mens" }, playerIndex: 2, playerName: "Sam Lee" },
    ]);
    // The ONE test in this file asserting formatted English: proves
    // formatEligibilityIssues' two branches (no name / with name) directly,
    // per the acceptance criterion's own example format `Player 3: …`.
    expect(formatEligibilityIssues(issues)).toEqual([
      "Player 1: This division is not open to your gender category.",
      "Player 2 (Sam Lee): This division is not open to your gender category.",
    ]);
  });
});

describe("rosterIssues — mixed composition (roster-wide, MIXED_NEEDS_BOTH_GENDERS)", () => {
  const mixed: EligibilityDivision = { ...NO_RULES, category: "mixed" };

  it("all-male roster fails the mixed rule", () => {
    const players: EligibilityRosterPlayer[] = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "m" },
    ];
    expect(codesOf(rosterIssues(mixed, players, 2026))).toEqual([
      { code: "MIXED_NEEDS_BOTH_GENDERS" },
    ]);
  });

  it("one m + one f satisfies the mixed rule", () => {
    const players: EligibilityRosterPlayer[] = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "f" },
    ];
    expect(rosterIssues(mixed, players, 2026)).toEqual([]);
  });

  it("m + f + x still satisfies the mixed rule (x present, roster already has both)", () => {
    const players: EligibilityRosterPlayer[] = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "f" },
      { full_name: "C", gender: "x" },
    ];
    expect(rosterIssues(mixed, players, 2026)).toEqual([]);
  });

  it("m + x FAILS the mixed rule — x satisfies neither side, it does not substitute for the missing f", () => {
    // Review finding (MINOR 2): the m+f+x case above proves nothing about x,
    // since hasM/hasF are already both true from m and f alone — it would
    // pass regardless of what x did. THIS case is the one with teeth: if x
    // wrongly counted toward hasF, this roster would be reported eligible.
    const players: EligibilityRosterPlayer[] = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "x" },
    ];
    expect(codesOf(rosterIssues(mixed, players, 2026))).toEqual([
      { code: "MIXED_NEEDS_BOTH_GENDERS" },
    ]);
  });

  it("an all-x roster fails the mixed rule, with NO per-player gender issue", () => {
    const players: EligibilityRosterPlayer[] = [
      { full_name: "A", gender: "x" },
      { full_name: "B", gender: "x" },
    ];
    const issues = rosterIssues(mixed, players, 2026);
    expect(codesOf(issues)).toEqual([{ code: "MIXED_NEEDS_BOTH_GENDERS" }]);
    expect(issues.some((i) => i.code === "MISSING_GENDER" || i.code === "CATEGORY_MISMATCH")).toBe(
      false,
    );
  });

  it("an all-null-gender roster fails the mixed rule too (want of both sides, not the null itself)", () => {
    const players: EligibilityRosterPlayer[] = [
      { full_name: "A", gender: null },
      { full_name: "B", gender: null },
    ];
    expect(codesOf(rosterIssues(mixed, players, 2026))).toEqual([
      { code: "MIXED_NEEDS_BOTH_GENDERS" },
    ]);
  });
});
