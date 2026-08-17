// RS002 wave 2: eligibility extracted from registrations.ts, extended to
// read the V364 first-class `divisions.category`/`age_min`/`age_max`
// columns alongside the existing jsonb `eligibility` rules, plus the new
// roster-level `rosterIssues`. Pure — no DB.
import { describe, expect, it } from "vitest";
import {
  ageAt,
  divisionEligibilityIssues,
  eligibilityIssues,
  isMinor,
  requiresDob,
  rosterIssues,
  type EligibilityDivision,
} from "../registration-eligibility";
// The move must not shrink the set of importers: registrations.ts re-exports
// every moved symbol verbatim.
import {
  ageAt as reexportedAgeAt,
  eligibilityIssues as reexportedEligibilityIssues,
  isMinor as reexportedIsMinor,
  requiresDob as reexportedRequiresDob,
} from "../registrations";

const NO_RULES: EligibilityDivision = {
  eligibility: [],
  category: null,
  age_min: null,
  age_max: null,
};

describe("registrations.ts re-exports the moved eligibility helpers", () => {
  it("re-exported ageAt/isMinor/eligibilityIssues/requiresDob behave identically to the originals", () => {
    expect(reexportedAgeAt("2010-06-05", new Date("2026-06-05T00:00:00Z"))).toBe(
      ageAt("2010-06-05", new Date("2026-06-05T00:00:00Z")),
    );
    expect(reexportedIsMinor("2010-01-01", new Date("2026-01-01T00:00:00Z"))).toBe(
      isMinor("2010-01-01", new Date("2026-01-01T00:00:00Z")),
    );
    expect(reexportedEligibilityIssues([], { dob: null }, 2026)).toEqual([]);
    expect(reexportedRequiresDob([])).toBe(false);
    expect(reexportedRequiresDob([{ kind: "age", maxAgeAt: 10 }])).toBe(true);
  });
});

describe("requiresDob (division-aware overload, V364)", () => {
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

describe("divisionEligibilityIssues — category (mens/womens), x never blocks", () => {
  const mens: EligibilityDivision = { ...NO_RULES, category: "mens" };
  const womens: EligibilityDivision = { ...NO_RULES, category: "womens" };

  it("mens: an f player is an issue", () => {
    expect(divisionEligibilityIssues(mens, { gender: "f" }, 2026)).toEqual([
      "This division is not open to your gender category.",
    ]);
  });

  it("mens: an x player is NOT an issue", () => {
    expect(divisionEligibilityIssues(mens, { gender: "x" }, 2026)).toEqual([]);
  });

  it("mens: a null-gender player yields the 'Gender is required' issue", () => {
    expect(divisionEligibilityIssues(mens, { gender: null }, 2026)).toEqual([
      "Gender is required for this division.",
    ]);
  });

  it("mens: an m player is eligible", () => {
    expect(divisionEligibilityIssues(mens, { gender: "m" }, 2026)).toEqual([]);
  });

  it("womens: an m player is an issue, f is eligible, x is eligible", () => {
    expect(divisionEligibilityIssues(womens, { gender: "m" }, 2026)).toEqual([
      "This division is not open to your gender category.",
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

describe("divisionEligibilityIssues — age band (first-class age_min/age_max)", () => {
  // Cutoff = 1 Jan of seasonStartYear. Dobs land exactly on Jan 1 so the age
  // math is exact: age = seasonStartYear - dobYear (see ageAt's UTC
  // month/day comparison — a Jan-1 dob never triggers the "before birthday"
  // subtraction against a Jan-1 cutoff).
  const division: EligibilityDivision = { ...NO_RULES, age_min: 10, age_max: 15 };
  const seasonStartYear = 2026;

  it("above age_max is an issue", () => {
    expect(divisionEligibilityIssues(division, { dob: "2010-01-01" }, seasonStartYear)).toEqual([
      "Too old for this division (must be 15 or younger on the cutoff date).",
    ]); // age 16
  });

  it("below age_min is an issue", () => {
    expect(divisionEligibilityIssues(division, { dob: "2017-01-01" }, seasonStartYear)).toEqual([
      "Too young for this division (must be 10 or older on the cutoff date).",
    ]); // age 9
  });

  it("exactly on the age_max boundary is eligible", () => {
    expect(divisionEligibilityIssues(division, { dob: "2011-01-01" }, seasonStartYear)).toEqual([]); // age 15
  });

  it("exactly on the age_min boundary is eligible", () => {
    expect(divisionEligibilityIssues(division, { dob: "2016-01-01" }, seasonStartYear)).toEqual([]); // age 10
  });

  it("missing dob is an issue when age_min/age_max is set", () => {
    expect(divisionEligibilityIssues(division, { dob: null }, seasonStartYear)).toEqual([
      "Date of birth is required for this age-restricted division.",
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
    // Evaluated "today" this person would be 16 (10 + 6 years drift) > 12 —
    // an issue. Evaluated correctly at the season-start cutoff they are 10,
    // well under the age_max=12 band — eligible.
    expect(divisionEligibilityIssues(overAgeMax, { dob }, pastSeasonStartYear)).toEqual([]);
  });
});

describe("divisionEligibilityIssues — jsonb rules and first-class columns apply together", () => {
  it("a division with both a jsonb gender rule and a first-class age_min yields both issues", () => {
    const division: EligibilityDivision = {
      eligibility: [{ kind: "gender", allowed: ["f"] }],
      category: null,
      age_min: 21,
      age_max: null,
    };
    expect(
      divisionEligibilityIssues(division, { dob: "2015-01-01", gender: "m" }, 2026),
    ).toEqual([
      "This division is not open to your gender category.", // jsonb rule
      "Too young for this division (must be 21 or older on the cutoff date).", // first-class column, age 11
    ]);
  });

  it("plain eligibilityIssues (jsonb-only) is unaffected by the extension", () => {
    const rules = [{ kind: "gender", allowed: ["f", "x"] }];
    expect(eligibilityIssues(rules, { gender: "m" }, 2026)).toEqual([
      "This division is not open to your gender category.",
    ]);
  });
});

describe("rosterIssues — per-player prefixing", () => {
  it("names the offending row by 1-based index and player name", () => {
    const division: EligibilityDivision = { ...NO_RULES, category: "mens" };
    const players = [
      { full_name: "Sam Lee", gender: "f" },
      { full_name: "Alex Kim", gender: "m" },
    ];
    expect(rosterIssues(division, players, 2026)).toEqual([
      "Player 1 (Sam Lee): This division is not open to your gender category.",
    ]);
  });

  it("age band issues in a roster name their 1-based row index; boundary rows are silent", () => {
    const division: EligibilityDivision = { ...NO_RULES, age_min: 10, age_max: 15 };
    const players = [
      { full_name: "Over Age", dob: "2010-01-01" }, // 16 — over age_max
      { full_name: "Under Age", dob: "2017-01-01" }, // 9 — under age_min
      { full_name: "At Max", dob: "2011-01-01" }, // 15 — boundary, eligible
      { full_name: "At Min", dob: "2016-01-01" }, // 10 — boundary, eligible
    ];
    const issues = rosterIssues(division, players, 2026);
    expect(issues).toEqual([
      "Player 1 (Over Age): Too old for this division (must be 15 or younger on the cutoff date).",
      "Player 2 (Under Age): Too young for this division (must be 10 or older on the cutoff date).",
    ]);
  });
});

describe("rosterIssues — mixed composition (roster-wide)", () => {
  const mixed: EligibilityDivision = { ...NO_RULES, category: "mixed" };

  it("all-male roster fails the mixed rule", () => {
    const players = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "m" },
    ];
    expect(rosterIssues(mixed, players, 2026)).toEqual([
      "This division requires a mixed roster (at least one male and one female player).",
    ]);
  });

  it("one m + one f satisfies the mixed rule", () => {
    const players = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "f" },
    ];
    expect(rosterIssues(mixed, players, 2026)).toEqual([]);
  });

  it("m + f + x satisfies the mixed rule", () => {
    const players = [
      { full_name: "A", gender: "m" },
      { full_name: "B", gender: "f" },
      { full_name: "C", gender: "x" },
    ];
    expect(rosterIssues(mixed, players, 2026)).toEqual([]);
  });

  it("an all-x roster fails the mixed rule, with NO per-player gender issue", () => {
    const players = [
      { full_name: "A", gender: "x" },
      { full_name: "B", gender: "x" },
    ];
    const issues = rosterIssues(mixed, players, 2026);
    expect(issues).toEqual([
      "This division requires a mixed roster (at least one male and one female player).",
    ]);
    // Specifically: no "Player N (...): Gender is required" / "not open to
    // your gender category" issue anywhere in the output.
    expect(issues.some((i) => i.includes("Gender") || i.includes("gender category"))).toBe(false);
  });

  it("an all-null-gender roster fails the mixed rule too (want of both sides, not the null itself)", () => {
    const players = [
      { full_name: "A", gender: null },
      { full_name: "B", gender: null },
    ];
    expect(rosterIssues(mixed, players, 2026)).toEqual([
      "This division requires a mixed roster (at least one male and one female player).",
    ]);
  });
});
