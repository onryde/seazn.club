// Unit coverage for `lib/board.ts` — B04's transport-free seam.
//
// The file under test is mostly TYPES, and a type cannot be tested. What CAN
// be tested is the two pure functions that live beside them, and both of them
// are places where a silent wrong answer is worse than a loud refusal:
//
//   - `encodeConstraints` builds the checker's ORACLE. Every rule in
//     `checker.ts` measures the product's board against this object, so a
//     knob this function drops, defaults, or mis-converts does not fail — it
//     makes the checker agree with a board it should have reddened. That is
//     failure class 3 ("a guard nothing kills is not tested") one layer up.
//   - `judgeDivision` is the only place the three verification layers are
//     combined into one verdict. A test that asserted only `red === true`
//     could not tell a working composition from `return { red: true }`, so
//     every red case below asserts BOTH the boolean AND that `reasons` names
//     the specific trigger that fired.
//
// Two habits this suite keeps on purpose:
//   - **Values, not shapes.** `45`/`3`/`570` are asserted, never "a number" —
//     a mapper reading `count` off the wrong union member still produces a
//     one-entry array (the brief's own note), and a wall clock read as an
//     integer still produces a number.
//   - **Asymmetric fixtures.** `blockingCount: 2` / `unplacedCount: 7` /
//     three schedule errors in the all-five case, so a transposed field read
//     shows up as the wrong number in the wrong reason rather than passing.
//
// Epoch literals below were derived OUTSIDE this process (`date -u -r`), not
// from `Date.parse` — deriving the expectation from the implementation's own
// call is the tautology this repo has already paid for.
import { describe, expect, it } from "vitest";
import {
  encodeConstraints,
  judgeDivision,
  type CertificateVerdict,
  type CheckerFinding,
  type CheckerReport,
} from "../board.ts";

const COURT_ONE = "11111111-1111-4111-8111-111111111111";
const courts = new Map([["c-one", COURT_ONE]]);

describe("encodeConstraints", () => {
  it("resolves an @-sigil court ref to the seeded court id", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { courts: ["@c-one"], matchMinutes: 45 },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.courtIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(out.matchMinutes).toBe(45);
  });

  it("REPORTS a hard constraint it cannot model rather than dropping it", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [{ type: "fixture_on_weekday", weekday: "FR", selector: {}, scope: {} }],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toHaveLength(0);
    expect(out.unmodelled).toEqual([
      { type: "fixture_on_weekday", reason: expect.stringContaining("not modelled") },
    ]);
  });

  // The value, not just the key: a mapper that read `count` off the wrong
  // member would still produce a one-entry array.
  it("carries max_fixtures_per_day's own count, not a default", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: { hard: [{ type: "max_fixtures_per_day", count: 3, scope: {} }] },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([{ type: "max_fixtures_per_day", count: 3 }]);
  });

  it("refuses an unresolvable court ref instead of silently emitting the sigil", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { courts: ["@c-missing"] },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/c-missing/);
  });

  it("defaults matchMinutes to the product's own default when the pack omits it", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {},
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.matchMinutes).toBe(30); // ScheduleConfig.matchMinutes default
  });

  // ---- beyond the brief's five: the rest of what step 3 mandates ---------
  // Each behaviour below is required by the task brief's implementation step
  // and reached by none of the five tests above. Shipping them untested would
  // hand T2 an oracle whose conversions nothing kills.

  it("passes a real court id through untouched and preserves the pack's order", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // Sigil SECOND, so a mapper that resolved only the head of the array —
      // or that sorted — differs visibly from the right answer.
      scheduleConfig: { courts: [other, "@c-one"] },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.courtIds).toEqual([other, COURT_ONE]);
  });

  it("converts every ISO instant to epoch ms, offset included, and resolves a blackout's own court ref", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        startAt: "2027-06-01T08:00:00+00:00",
        endAt: "2027-06-03T20:00:00+00:00",
        // +05:30, deliberately: an implementation that dropped the offset and
        // read the wall clock as UTC would answer 1811860200000 here.
        sessionWindows: [{ from: "2027-06-01T14:30:00+05:30", to: "2027-06-01T17:00:00+00:00" }],
        blackouts: [
          { court: "@c-one", from: "2027-06-01T12:00:00+00:00", to: "2027-06-01T13:00:00+00:00" },
        ],
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.startAt).toBe(1811836800000);
    expect(out.endAt).toBe(1812052800000);
    expect(out.sessionWindows).toEqual([{ from: 1811840400000, to: 1811869200000 }]);
    expect(out.blackouts).toEqual([
      { courtId: COURT_ONE, from: 1811851200000, to: 1811854800000 },
    ]);
  });

  it("leaves a global blackout global — an absent court is not resolved to one", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        blackouts: [{ from: "2027-06-01T12:00:00+00:00", to: "2027-06-01T13:00:00+00:00" }],
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.blackouts).toHaveLength(1);
    expect(out.blackouts[0]?.courtId).toBeUndefined();
  });

  it("converts not_before/not_after wall clock to minutes into the day", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [
            { type: "not_before", time: "09:30", scope: {} },
            { type: "not_after", time: "21:15", scope: {} },
          ],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    // 570 and 1275, NOT 930 and 2115 — an HHMM read as a decimal integer is
    // the exact bug this asserts against, and both differ from their wrong
    // answer.
    expect(out.hard).toEqual([
      { type: "not_before", minutesIntoDay: 570 },
      { type: "not_after", minutesIntoDay: 1275 },
    ]);
    expect(out.unmodelled).toEqual([]);
  });

  it("renames min_rest_minutes' rest_scope to restScope and carries its declared value", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: {
          hard: [
            // The MIDDLE member, so a hardcoded first-member default differs
            // from the right answer.
            { type: "min_rest_minutes", minutes: 45, rest_scope: "feeder_to_dependent", scope: {} },
          ],
        },
      },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([
      { type: "min_rest_minutes", minutes: 45, restScope: "feeder_to_dependent" },
    ]);
  });

  it("reports a modellable rule whose own operand is unreadable, rather than emitting a broken one", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // A `max_fixtures_per_day` with no `count` — schema-illegal, but
      // `PackDivision.scheduleConfig` is an opaque record that nothing
      // type-checks, so this reaches here.
      scheduleConfig: { constraints: { hard: [{ type: "max_fixtures_per_day", scope: {} }] } },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.hard).toEqual([]);
    expect(out.unmodelled).toEqual([
      { type: "max_fixtures_per_day", reason: expect.stringContaining("not modelled") },
    ]);
  });

  it("refuses a present-but-unreadable matchMinutes instead of falling back to the default", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny",
        scheduleConfig: { matchMinutes: "45" },
        courtIdByRef: courts,
        isRoundRobin: true,
        pins: [],
      }),
    ).toThrow(/matchMinutes/);
  });

  it("defaults every knob the pack omits and carries pins and isRoundRobin verbatim", () => {
    const pins = [{ fixtureId: "f-7", start: 1811836800000, courtId: COURT_ONE }];
    const out = encodeConstraints({
      divisionRef: "d-other",
      scheduleConfig: undefined,
      courtIdByRef: courts,
      // FALSE here, unlike every test above — a hardcoded `true` dies.
      isRoundRobin: false,
      pins,
    });
    expect(out.divisionRef).toBe("d-other");
    expect(out.matchMinutes).toBe(30);
    expect(out.gapMinutes).toBe(0);
    expect(out.perEntrantMinRest).toBe(0);
    expect(out.startAt).toBeUndefined();
    expect(out.endAt).toBeUndefined();
    expect(out.courtIds).toEqual([]);
    expect(out.blackouts).toEqual([]);
    expect(out.sessionWindows).toEqual([]);
    expect(out.hard).toEqual([]);
    expect(out.unmodelled).toEqual([]);
    expect(out.isRoundRobin).toBe(false);
    expect(out.pins).toEqual(pins);
  });

  it("carries gapMinutes and perEntrantMinRest when the pack declares them", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      // Distinct from each other AND from every default, so a swap is visible.
      scheduleConfig: { gapMinutes: 10, perEntrantMinRest: 90 },
      courtIdByRef: courts,
      isRoundRobin: true,
      pins: [],
    });
    expect(out.gapMinutes).toBe(10);
    expect(out.perEntrantMinRest).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// judgeDivision
// ---------------------------------------------------------------------------

function finding(kind: CheckerFinding["kind"]): CheckerFinding {
  return { kind, divisionRef: "d-tiny", fixtureIds: ["f-1", "f-2"], detail: `${kind} detail` };
}

function checker(over: Partial<CheckerReport> = {}): CheckerReport {
  return { findings: [], unchecked: [], clean: true, ...over };
}

function certificate(over: Partial<CertificateVerdict> = {}): CertificateVerdict {
  return {
    branch: "FEASIBLE",
    reason: "history satisfies the encoding",
    violations: [],
    red: false,
    ...over,
  };
}

type JudgeInput = Parameters<typeof judgeDivision>[0];

function judgeInput(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    divisionRef: "d-tiny",
    blockingCount: 0,
    checker: checker(),
    certificate: certificate(),
    unplacedCount: 0,
    scheduleErrors: [],
    ...over,
  };
}

describe("judgeDivision", () => {
  it("returns a clean verdict with NO reasons when every layer is clean", () => {
    expect(judgeDivision(judgeInput())).toEqual({ red: false, reasons: [] });
  });

  it("reds on blocking conflicts and names the count", () => {
    const out = judgeDivision(judgeInput({ blockingCount: 2 }));
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/blocking conflicts = 2/);
  });

  it("reds on a checker report that is not clean and names the finding kinds", () => {
    const out = judgeDivision(
      judgeInput({
        checker: checker({ findings: [finding("court_double_booking")], clean: false }),
      }),
    );
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/checker findings = 1 \(court_double_booking\)/);
  });

  // The differential that separates "reads `clean`" from "reads
  // `findings.length`": `clean` is the checker's own verdict and the only
  // authority here, so a report that declares itself dirty MUST red even
  // with nothing listed.
  it("reds on clean:false even when the report lists no findings", () => {
    const out = judgeDivision(judgeInput({ checker: checker({ clean: false }) }));
    expect(out.red).toBe(true);
    expect(out.reasons[0]).toMatch(/checker findings = 0/);
  });

  it("reds on a red certificate and names its branch", () => {
    const out = judgeDivision(
      judgeInput({
        certificate: certificate({
          branch: "PACK_AUTHORING_BUG",
          reason: "history breaches the pack's own blackout",
          violations: [finding("inside_blackout")],
          red: true,
        }),
      }),
    );
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/certificate PACK_AUTHORING_BUG/);
    expect(out.reasons[0]).toMatch(/history breaches the pack's own blackout/);
  });

  it("reds on unplaced fixtures and names the count", () => {
    const out = judgeDivision(judgeInput({ unplacedCount: 1 }));
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/unplaced fixtures = 1/);
  });

  it("reds on schedule errors and names them", () => {
    const out = judgeDivision(judgeInput({ scheduleErrors: ["schedule-settings PUT 422"] }));
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toMatch(/schedule errors = 1/);
    expect(out.reasons[0]).toMatch(/schedule-settings PUT 422/);
  });

  // §3.3: a non-empty `unchecked` is REPORTED beside the verdict, never a red
  // in itself. A judge that reddened on it would make every pack carrying a
  // `fixture_on_date` permanently red.
  it("does NOT red on a clean report that carries unchecked constraints", () => {
    const out = judgeDivision(
      judgeInput({
        checker: checker({
          unchecked: [{ type: "fixture_on_date", reason: "not modelled by the bench checker" }],
        }),
      }),
    );
    expect(out).toEqual({ red: false, reasons: [] });
  });

  it("names EVERY trigger that fired, each with its own value, in a fixed order", () => {
    const out = judgeDivision(
      judgeInput({
        // Five distinct numbers, so a transposed read lands a visibly wrong
        // value in a visibly wrong reason instead of passing.
        blockingCount: 2,
        checker: checker({
          findings: [finding("entrant_below_rest"), finding("day_cap_exceeded")],
          clean: false,
        }),
        certificate: certificate({
          branch: "PRODUCT_DEFECT",
          reason: "history is feasible and the solver returned infeasible",
          red: true,
        }),
        unplacedCount: 7,
        scheduleErrors: ["auto 500", "apply 409", "validate 503"],
      }),
    );
    expect(out.red).toBe(true);
    expect(out.reasons).toHaveLength(5);
    expect(out.reasons[0]).toMatch(/blocking conflicts = 2/);
    expect(out.reasons[1]).toMatch(/checker findings = 2 \(entrant_below_rest, day_cap_exceeded\)/);
    expect(out.reasons[2]).toMatch(/certificate PRODUCT_DEFECT/);
    expect(out.reasons[3]).toMatch(/unplaced fixtures = 7/);
    expect(out.reasons[4]).toMatch(/schedule errors = 3/);
    // Every reason locates itself, so a multi-division report can print them
    // flat without re-attributing them.
    expect(out.reasons.every((r) => r.startsWith("d-tiny: "))).toBe(true);
  });
});
