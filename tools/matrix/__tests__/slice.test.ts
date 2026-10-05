import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import {
  CANARY_CHECK, SCENARIO_KEYS, SLICE_ROWS, SLICE_SPORTS, UnknownFilter, checkCanary, checkCellFilter, checkSliceFilter, isSliceCell, planCanaryCase, planSliceCases,
} from "../lib/slice.ts";

const v = (s: string) => (s === "generic" ? "score" : "bwf");

describe("planSliceCases — empty/unknown first", () => {
  it("an unknown --only or --scenario throws instead of running zero cases", () => {
    expect(() => planSliceCases(v, { only: "league|genric" })).toThrow(UnknownFilter);
    expect(() => planSliceCases(v, { scenario: "M9" })).toThrow(UnknownFilter);
    expect(() => planCanaryCase(v, "LIFECYCLE")).toThrow(UnknownFilter); // LIFECYCLE has no canary
  });
  it("an EMPTY filter value is refused, never read as 'no filter' (which would run the whole slice)", () => {
    expect(() => planSliceCases(v, { only: "" })).toThrow(UnknownFilter);
    expect(() => planSliceCases(v, { scenario: "" })).toThrow(UnknownFilter);
    expect(() => planCanaryCase(v, "")).toThrow(UnknownFilter);
  });
  it("the refusal names the flag, the value and every allowed value", () => {
    expect(() => planSliceCases(v, { only: "league|genric" })).toThrow(
      "slice: unknown --only cell 'league|genric' (allowed: league|generic, league|badminton, knockout|generic, knockout|badminton, swiss|generic, swiss|badminton)",
    );
    expect(() => planSliceCases(v, { scenario: "M9" })).toThrow("slice: unknown --scenario 'M9' (allowed: LIFECYCLE, M1, R4, F1)");
    expect(() => planCanaryCase(v, "LIFECYCLE")).toThrow("slice: unknown --canary 'LIFECYCLE' (allowed: M1, R4, F1)");
  });
  it("PF13: run.ts's pre-I/O checks refuse exactly what the planners refuse, and need no variants", () => {
    expect(() => checkSliceFilter({ only: "league|genric" })).toThrow(UnknownFilter);
    expect(() => checkSliceFilter({ scenario: "M9" })).toThrow(UnknownFilter);
    expect(() => checkSliceFilter({ only: "" })).toThrow(UnknownFilter);
    expect(() => checkCanary("LIFECYCLE")).toThrow(UnknownFilter);
    expect(() => checkCanary("M9")).toThrow(UnknownFilter);
    expect(() => checkSliceFilter({})).not.toThrow();
    expect(() => checkSliceFilter({ only: "swiss|badminton", scenario: "F1" })).not.toThrow();
    expect(checkCanary("R4")).toBe("R4");
  });
  it("DENIED is registered but is not a slice scenario: --scenario and --canary refuse it (Task 9)", () => {
    expect(SCENARIOS.DENIED.key).toBe("DENIED");
    expect(() => checkSliceFilter({ scenario: "DENIED" })).toThrow("slice: unknown --scenario 'DENIED' (allowed: LIFECYCLE, M1, R4, F1)");
    expect(() => checkCanary("DENIED")).toThrow("slice: unknown --canary 'DENIED' (allowed: M1, R4, F1)");
  });
});

describe("planSliceCases", () => {
  it("the full slice is 3 rows × 2 sports × 4 scenarios = 24 unique cases", () => {
    const cases = planSliceCases(v);
    expect(cases).toHaveLength(24);
    expect(new Set(cases.map((c) => c.caseId)).size).toBe(24);
    expect(cases.every((c) => !c.canary)).toBe(true);
    expect(cases[0]).toMatchObject({ caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score" });
  });
  it("the slice is the product of its three lists, each variant read from variantFor per sport", () => {
    const cases = planSliceCases(v);
    const want = SLICE_ROWS.flatMap((row) => SLICE_SPORTS.flatMap((sport) => SCENARIO_KEYS.map((scenario) => `${row}|${sport}|${v(sport)}|${scenario}`)));
    expect(cases.map((c) => c.caseId)).toEqual(want);
    for (const c of cases) expect(c.caseId).toBe(`${c.row}|${c.sport}|${c.variant}|${c.scenario}`);
  });
  it("filters narrow to exactly one case", () => {
    expect(planSliceCases(v, { only: "swiss|badminton", scenario: "F1" }).map((c) => c.caseId)).toEqual(["swiss|badminton|bwf|F1"]);
  });
  it("each filter alone narrows along its own axis only", () => {
    expect(planSliceCases(v, { only: "knockout|generic" }).map((c) => c.caseId)).toEqual(SCENARIO_KEYS.map((k) => `knockout|generic|score|${k}`));
    expect(planSliceCases(v, { scenario: "R4" }).map((c) => c.caseId)).toEqual(
      ["league|generic|score", "league|badminton|bwf", "knockout|generic|score", "knockout|badminton|bwf", "swiss|generic|score", "swiss|badminton|bwf"].map((p) => `${p}|R4`),
    );
  });
  it("every scenario key is registered, and each pilot names its canary check", () => {
    // Every registered scenario but DENIED (⛔, Task 9: gated rows under a deny
    // only), PADPROOF (W1c Task 7: --set pad-proof under --driver browser only) and
    // VOIDPROOF (W1d Task 14: --set void-proof only).
    expect([...SCENARIO_KEYS].sort()).toEqual(Object.keys(SCENARIOS).filter((k) => k !== "DENIED" && k !== "PADPROOF" && k !== "VOIDPROOF").sort());
    for (const k of ["DENIED", "PADPROOF", "VOIDPROOF"]) {
      expect(Object.keys(SCENARIOS)).toContain(k);
      expect(SCENARIO_KEYS as readonly string[]).not.toContain(k);
    }
    for (const k of ["M1", "R4", "F1"] as const) {
      expect(SCENARIOS[k].canaryCheck).not.toBeNull();
      expect(planCanaryCase(v, k)).toMatchObject({ canary: true, row: "league", sport: "generic", scenario: k });
    }
  });
});

describe("CANARY_CHECK and planCanaryCase", () => {
  it("CANARY_CHECK is a view of the registry, never a second table", () => {
    expect(CANARY_CHECK).toEqual(Object.fromEntries(Object.entries(SCENARIOS).filter(([k]) => k !== "DENIED" && k !== "PADPROOF" && k !== "VOIDPROOF").map(([k, s]) => [k, s.canaryCheck])));
    expect(CANARY_CHECK.LIFECYCLE).toBeNull();
  });
  it("a canary case is league|generic under generic's builder variant, with an id no slice case can hold", () => {
    const c = planCanaryCase(v, "M1");
    expect(c).toEqual({ caseId: "league|generic|score|M1|canary", row: "league", sport: "generic", variant: "score", scenario: "M1", canary: true });
    expect(planSliceCases(v).map((x) => x.caseId)).not.toContain(c.caseId);
  });
});

// W1-driving Task 12: --only on any catalogue cell. checkSliceFilter keeps the
// slice's semantics (above); checkCellFilter admits ROW_KEYS × SPORT_KEYS, the
// catalogue registry's own lists. Empty and malformed first.
describe("checkCellFilter — empty and malformed first", () => {
  it("an empty, one-sided, three-part or unknown cell is UnknownFilter", () => {
    let refused = 0;
    for (const only of ["", "|", "league", "league|", "|generic", "league|generic|x", "nope|generic", "league|nope", "LEAGUE|generic", " league|generic"]) {
      expect(() => checkCellFilter(only), JSON.stringify(only)).toThrow(UnknownFilter);
      refused++;
    }
    expect(refused).toBe(10);
  });
  it("the refusal names the flag, the value, and the rows and sports it takes", () => {
    expect(() => checkCellFilter("league|genric")).toThrow(
      `slice: unknown --only cell 'league|genric' (allowed: <row>|<sport>, row one of: ${ROW_KEYS.join(" ")}, sport one of: ${SPORT_KEYS.join(" ")})`,
    );
  });
  it("every catalogue cell is admitted and answers its own row and sport — the registry swept, counted", () => {
    let admitted = 0;
    for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) {
      expect(checkCellFilter(`${row}|${sport}`)).toEqual({ row, sport });
      admitted++;
    }
    expect(admitted).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(admitted).toBeGreaterThan(SLICE_ROWS.length * SLICE_SPORTS.length);
  });
  it("isSliceCell: exactly the six slice cells, and no other catalogue cell", () => {
    let inside = 0;
    let outside = 0;
    for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) {
      const want = (SLICE_ROWS as readonly string[]).includes(row) && (SLICE_SPORTS as readonly string[]).includes(sport);
      expect(isSliceCell(`${row}|${sport}`), `${row}|${sport}`).toBe(want);
      if (want) inside++;
      else outside++;
    }
    expect(inside).toBe(6);
    expect(outside).toBeGreaterThan(0);
    expect(isSliceCell("")).toBe(false);
  });
});
