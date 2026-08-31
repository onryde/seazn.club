// RS002 wave 2 (rewritten per _INDEX.md "RS002 entry conditions" item 5,
// 2026-08-17): eligibility extracted from registrations.ts, evaluating the
// V364 first-class divisions.category/age_min/age_max columns, plus
// roster-level rosterIssues. RS007/V380 (owner ruling, _INDEX.md
// "Eligibility consolidation") later dropped the jsonb `eligibility` rules
// this file used to evaluate ALONGSIDE those columns — category/age_min/
// age_max/age_cutoff_month/age_cutoff_day are now the only representation;
// see registration-eligibility.ts's own header for the full account.
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
  requiresGender,
  rosterIssues,
  splitEligibilityIssues,
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
  category: null,
  age_min: null,
  age_max: null,
  age_cutoff_month: null,
  age_cutoff_day: null,
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
    expect(reexportedRequiresDob({ age_min: null, age_max: null })).toBe(false);
    expect(reexportedRequiresDob({ age_min: null, age_max: 10 })).toBe(true);
  });
});

describe("requiresDob (division-aware, V364/V380) — unaffected by the code rework, still boolean", () => {
  it("is true for a division with only age_min/age_max set", () => {
    expect(requiresDob({ age_min: 10, age_max: null })).toBe(true);
    expect(requiresDob({ age_min: null, age_max: 18 })).toBe(true);
  });

  it("is false when neither age column requires one", () => {
    expect(requiresDob({ age_min: null, age_max: null })).toBe(false);
  });
});

// RS006 chassis: the WHO step (design §4 step 1) shows a gender field only
// when at least one open division needs one — mirrors requiresDob's own
// "does the form need to collect this at all" role, but for gender.
//
// RS007 review fix M2 (2026-08-29 — see requiresGender's own doc comment for
// the full account): a 2026-08-27 revision ALSO fired this on any non-empty
// `eligibility_note`, on the theory that V380 dropped the jsonb
// `eligibility` rules without a first-class replacement for every
// gender-rule shape a note might be the only remaining record of. In
// practice that made an UNRELATED organiser note ("bring your own kit",
// "club members only") force the public WHO step to demand gender on a
// division `divisionEligibilityIssues` never gates on gender for — the
// browser blocked a registrant the API would accept. Ruling: a free-text
// note must never make a field mandatory. `category` mens/womens/mixed is
// now the ONLY trigger — agrees EXACTLY with divisionEligibilityIssues's
// gender source (categoryEligibilityIssues/rosterCompositionIssues).
describe("requiresGender (RS007 review fix M2) — category alone; eligibility_note is NEVER a trigger", () => {
  it("is true for mens/womens category (first-class column alone)", () => {
    expect(requiresGender({ category: "mens" })).toBe(true);
    expect(requiresGender({ category: "womens" })).toBe(true);
  });

  it("is true for a mixed category (roster composition needs every player's gender)", () => {
    expect(requiresGender({ category: "mixed" })).toBe(true);
    expect(requiresGender({ category: "mixed", eligibility_note: null })).toBe(true);
    // Roster-wide, per the schema comment on `category` — it does NOT
    // constrain an individual (categoryEligibilityIssues never fires for
    // `mixed`), so requiresGender=true here is a collection signal only.
    expect(divisionEligibilityIssues({ ...NO_RULES, category: "mixed" }, { gender: "x" }, 2026)).toEqual(
      [],
    );
  });

  it("is false for open/null category with no eligibility_note", () => {
    expect(requiresGender({ category: "open" })).toBe(false);
    expect(requiresGender({ category: null })).toBe(false);
  });

  // THE regression this fix closes: a free-text note that has nothing to do
  // with gender ("bring your own kit") — or one that happens to mention it
  // ("Girls only (club rule)") — must NOT force gender collection on a
  // division `category` alone already proves unrestricted.
  // divisionEligibilityIssues never reads note text either way (nothing
  // programmatically evaluates it — only a human, reading the note against
  // the submitted roster, can), so this was purely a client-side dead end:
  // blocking a registrant the API would happily accept.
  it("a non-empty eligibility_note does NOT force gender collection on a null/open category", () => {
    expect(requiresGender({ category: null, eligibility_note: "Girls only (club rule)" })).toBe(false);
    expect(requiresGender({ category: "open", eligibility_note: "Girls only (club rule)" })).toBe(false);
    expect(divisionEligibilityIssues(NO_RULES, { gender: "x" }, 2026)).toEqual([]);
  });

  it("blank, whitespace-only, null and absent eligibility_note all agree — false either way", () => {
    expect(requiresGender({ category: null, eligibility_note: "" })).toBe(false);
    expect(requiresGender({ category: null, eligibility_note: "   " })).toBe(false);
    expect(requiresGender({ category: null, eligibility_note: null })).toBe(false);
    expect(requiresGender({ category: null })).toBe(false);
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
  //
  // RS007/V380: the age/gender rule fixtures below used to be jsonb
  // (`{kind:"age",maxAgeAt:15,minAgeAt:10}` / `{kind:"gender",allowed:["f"]}`)
  // — rewritten onto age_min/age_max and category:"womens" respectively.
  // `allowed:["f"]` maps onto `womens` exactly: categoryEligibilityIssues'
  // own "x never blocks" rule means only `f` passes `womens` besides `x`,
  // which the original jsonb rule excluded too — same admitted set, same
  // expected sentences.
  const ageRule = { age_min: 10, age_max: 15 };
  const genderRule = { category: "womens" };
  const noCategoryOrAgeBand = NO_RULES;

  it("MISSING_DOB", () => {
    // Reverting ageBandEligibilityIssues's MISSING_DOB push changes this
    // string and reds the test.
    const division: EligibilityDivision = { ...noCategoryOrAgeBand, ...ageRule };
    expect(formatEligibilityIssues(divisionEligibilityIssues(division, { dob: null }, 2026))).toEqual([
      "Date of birth is required for this age-restricted division.",
    ]);
  });

  it("AGE_TOO_OLD", () => {
    // Pins the age-16-over-age_max-15 branch.
    const division: EligibilityDivision = { ...noCategoryOrAgeBand, ...ageRule };
    expect(
      formatEligibilityIssues(divisionEligibilityIssues(division, { dob: "2010-01-01" }, 2026)),
    ).toEqual(["Too old for this division (must be 15 or younger on the cutoff date)."]);
  });

  it("AGE_TOO_YOUNG", () => {
    // Pins the age-9-under-age_min-10 branch.
    const division: EligibilityDivision = { ...noCategoryOrAgeBand, ...ageRule };
    expect(
      formatEligibilityIssues(divisionEligibilityIssues(division, { dob: "2017-01-01" }, 2026)),
    ).toEqual(["Too young for this division (must be 10 or older on the cutoff date)."]);
  });

  it("GENDER_NOT_ALLOWED equivalent (CATEGORY_MISMATCH — the one gender-rejection code left)", () => {
    const division: EligibilityDivision = { ...noCategoryOrAgeBand, ...genderRule };
    expect(formatEligibilityIssues(divisionEligibilityIssues(division, { gender: "m" }, 2026))).toEqual([
      "This division is not open to your gender category.",
    ]);
  });

  it("MISSING_GENDER", () => {
    const division: EligibilityDivision = { ...noCategoryOrAgeBand, ...genderRule };
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

    // Same MISSING_DOB code fires off age_max alone, not just age_min — one
    // vocabulary regardless of which side of the band is set.
    const ageMaxOnlyDivision: EligibilityDivision = { ...NO_RULES, age_max: 15 };
    expect(codesOf(divisionEligibilityIssues(ageMaxOnlyDivision, { dob: null }, 2026))).toEqual([
      { code: "MISSING_DOB" },
    ]);
  });
});

describe("meta carries structured detail a consumer would otherwise have to re-parse from the sentence", () => {
  it("AGE_TOO_OLD/AGE_TOO_YOUNG carry the limit, CATEGORY_MISMATCH the category", () => {
    const ageDivision: EligibilityDivision = { ...NO_RULES, age_min: 10, age_max: 15 };
    expect(codesOf(divisionEligibilityIssues(ageDivision, { dob: "2010-01-01" }, 2026))).toEqual([
      { code: "AGE_TOO_OLD", meta: { limit: 15 } },
    ]); // age 16
    expect(codesOf(divisionEligibilityIssues(ageDivision, { dob: "2017-01-01" }, 2026))).toEqual([
      { code: "AGE_TOO_YOUNG", meta: { limit: 10 } },
    ]); // age 9

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

describe("divisionEligibilityIssues — age band (first-class age_min/age_max/age_cutoff_month/age_cutoff_day)", () => {
  // Cutoff = 1 Jan of seasonStartYear (default, no age_cutoff_month/day set).
  // Dobs land exactly on Jan 1 so the age math is exact:
  // age = seasonStartYear - dobYear.
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

  it("is evaluated at 1 January of seasonStartYear BY DEFAULT, not 'today'", () => {
    // seasonStartYear deliberately far from the real current year: if the
    // production code used `new Date()` instead of the season-start cutoff,
    // this dob would read as 6 years OLDER than intended and fail age_max.
    const currentYear = new Date().getUTCFullYear();
    const pastSeasonStartYear = currentYear - 6;
    const overAgeMax: EligibilityDivision = { ...NO_RULES, age_max: 12 };
    const dob = `${pastSeasonStartYear - 10}-01-01`; // age 10 AT the season-start cutoff
    expect(divisionEligibilityIssues(overAgeMax, { dob }, pastSeasonStartYear)).toEqual([]);
  });

  // RS007/V380 criterion 2's proof: age_cutoff_month/age_cutoff_day must
  // actually change the evaluated outcome vs the 1-January default — the
  // whole reason the migration added them rather than just dropping the
  // jsonb rules outright (V380 migration header, defect 1: dropping the
  // cutoff without replacing it would silently re-anchor every school-year
  // age group onto 1 January and change who is eligible).
  it("a configured cutoff evaluates differently from the 1-January default", () => {
    // A July dob falls strictly between 1 Jan and 1 Sept, so the two
    // cutoffs disagree about whether the birthday has happened yet: on
    // 1 Jan it hasn't (still 15, eligible for age_max 15); on 1 Sept it has
    // (turned 16, AGE_TOO_OLD). Same division shape otherwise, same dob —
    // only the cutoff differs.
    const dob = "2010-07-10";
    const defaultCutoff: EligibilityDivision = { ...NO_RULES, age_max: 15 };
    const septCutoff: EligibilityDivision = {
      ...NO_RULES,
      age_max: 15,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
    };
    expect(divisionEligibilityIssues(defaultCutoff, { dob }, seasonStartYear)).toEqual([]);
    expect(codesOf(divisionEligibilityIssues(septCutoff, { dob }, seasonStartYear))).toEqual([
      { code: "AGE_TOO_OLD", meta: { limit: 15 } },
    ]);
  });
});

describe("divisionEligibilityIssues — category and age band apply together", () => {
  // RS007/V380: this used to be a jsonb gender rule + a first-class
  // age_min, proving the two SOURCES were additive. With one representation
  // left there is nothing left to be additive ACROSS — this now proves the
  // same thing about the two CHECKS within that one representation
  // (categoryEligibilityIssues + ageBandEligibilityIssues): a division that
  // sets both category and an age band gets issues from both, independently.
  it("a division with both category and age_min yields both codes", () => {
    const division: EligibilityDivision = {
      ...NO_RULES,
      category: "womens",
      age_min: 21,
    };
    expect(
      codesOf(divisionEligibilityIssues(division, { dob: "2015-01-01", gender: "m" }, 2026)),
    ).toEqual([
      { code: "CATEGORY_MISMATCH", meta: { category: "womens" } },
      { code: "AGE_TOO_YOUNG", meta: { limit: 21 } }, // age 11
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

// RS011 — organiser-side gates classify issues into blocking violations vs
// advisory warnings by ONE rule (`splitEligibilityIssues`): only
// MISSING_DOB/MISSING_GENDER are warnings, everything else blocks. Pure —
// no DB — so it's unit-tested here rather than in the DB-integration suite
// (entrants-eligibility.test.ts), which asserts the WIRED behaviour (throw/
// audit) this function's split feeds.
describe("splitEligibilityIssues (RS011) — MISSING_DOB/MISSING_GENDER are the ONLY warning codes", () => {
  it("MISSING_DOB and MISSING_GENDER land in warnings, nothing in violations", () => {
    const issues: EligibilityIssue[] = [
      { code: "MISSING_DOB", message: "x" },
      { code: "MISSING_GENDER", message: "y" },
    ];
    expect(splitEligibilityIssues(issues)).toEqual({ violations: [], warnings: issues });
  });

  it("AGE_TOO_OLD/AGE_TOO_YOUNG/GENDER_NOT_ALLOWED/CATEGORY_MISMATCH/MIXED_NEEDS_BOTH_GENDERS all land in violations, none in warnings", () => {
    const issues: EligibilityIssue[] = [
      { code: "AGE_TOO_OLD", message: "x" },
      { code: "AGE_TOO_YOUNG", message: "x" },
      { code: "CATEGORY_MISMATCH", message: "x" },
      { code: "MIXED_NEEDS_BOTH_GENDERS", message: "x" },
    ];
    expect(splitEligibilityIssues(issues)).toEqual({ violations: issues, warnings: [] });
  });

  it("a mixed list of both splits correctly and preserves order within each bucket", () => {
    const dob: EligibilityIssue = { code: "MISSING_DOB", message: "a" };
    const old: EligibilityIssue = { code: "AGE_TOO_OLD", message: "b" };
    const gender: EligibilityIssue = { code: "MISSING_GENDER", message: "c" };
    const mismatch: EligibilityIssue = { code: "CATEGORY_MISMATCH", message: "d" };
    expect(splitEligibilityIssues([dob, old, gender, mismatch])).toEqual({
      violations: [old, mismatch],
      warnings: [dob, gender],
    });
  });

  it("an empty list splits into two empty lists", () => {
    expect(splitEligibilityIssues([])).toEqual({ violations: [], warnings: [] });
  });

  it("real rosterIssues output for a mens division with a missing-gender AND wrong-gender row splits as expected — the mutation this function exists to prevent (a MISSING_* code accidentally blocking, or a real violation accidentally downgraded to a warning)", () => {
    const mensDivision: EligibilityDivision = {
      category: "mens",
      age_min: null,
      age_max: null,
      age_cutoff_month: null,
      age_cutoff_day: null,
    };
    const players: EligibilityRosterPlayer[] = [
      { full_name: "No Gender", gender: null },
      { full_name: "Wrong Gender", gender: "f" },
    ];
    const issues = rosterIssues(mensDivision, players, 2026);
    const { violations, warnings } = splitEligibilityIssues(issues);
    expect(warnings.map((w) => w.code)).toEqual(["MISSING_GENDER"]);
    expect(violations.map((v) => v.code)).toEqual(["CATEGORY_MISMATCH"]);
  });
});
