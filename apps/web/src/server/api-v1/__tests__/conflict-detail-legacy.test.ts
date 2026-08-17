// C3 (2026-08-13 design amendment,
// docs/superpowers/specs/2026-08-12-conflict-detail-names-design.md) — no DB
// needed, every case here is a pure function or a zod parse.
//
// Three concerns, three describe blocks:
//   1. `legacyConflictDetail` reproduces the pre-C3 (commit d0cd9a25) English
//      byte for byte, for EVERY one of the 25 family templates. The expected
//      strings below are typed BACK from `git show d0cd9a25:packages/engine/
//      src/scheduling/{calendar,build}.ts`, independently of
//      conflict-detail-legacy.ts's own `LEGACY_PROSE` table — copying that
//      table here would only prove the module agrees with itself.
//   2. The wire schemas (`ScheduleConflict` snake_case, `AiPlanConflict`
//      camelCase) round-trip `details` through zod untouched. zod strips an
//      undeclared field silently (schemas.ts's own comment on this), so this
//      is the test that would have caught it.
//   3. `legacyVerifierConflict` — the AI repair round's copy of a conflict —
//      never carries `details`, whatever the input. The end-to-end version of
//      this (the real usecase, a mocked SDK call, the field set pinned on the
//      captured request body) lives in schedule-ai-repair.test.ts and
//      competition-schedule-ai-repair.test.ts; this is the unit-level half.
import { describe, expect, it } from "vitest";
import type { ConflictDetail, ConflictDetailKind } from "@seazn/engine/scheduling";
import { legacyConflictDetail, legacyVerifierConflict, withLegacyDetail } from "../conflict-detail-legacy";
import { AiPlanResponse, ScheduleConflict } from "../schemas";

// ===========================================================================
// 1. Legacy parity, per kind — exhaustive
// ===========================================================================

/** One row per `ConflictDetailKind`. `Record<ConflictDetailKind, ...>` means
 *  a 26th kind (or a typo'd one) is a TYPE ERROR on this object literal, not
 *  a silently-skipped row — the same exhaustiveness guarantee
 *  `conflict-detail-legacy.ts`'s own `LEGACY_PROSE` table has, applied here
 *  independently. */
const CASES: Record<ConflictDetailKind, { detail: ConflictDetail; expected: string }> = {
  person_double_booking: {
    detail: { kind: "person_double_booking", personIds: ["p1"], otherFixtureId: "f2" },
    expected: "person p1 also in f2",
  },
  locked_slot_clash: {
    detail: { kind: "locked_slot_clash", court: "Court 1" },
    expected: "locked slot clashes on Court 1",
  },
  no_slot_start_window: {
    detail: { kind: "no_slot_start_window" },
    expected: "no feasible slot before the start window's notAfter bound",
  },
  no_slot_person_bound: {
    detail: { kind: "no_slot_person_bound", personIds: ["p1"], otherFixtureId: "f2" },
    expected: "no court/time within horizon free of person p1 (also in f2)",
  },
  no_slot_horizon: {
    detail: { kind: "no_slot_horizon" },
    expected: "no court/time within horizon",
  },
  instruction_feeder_gap: {
    detail: { kind: "instruction_feeder_gap", minutes: 20, requiredMinutes: 60 },
    expected: "starts 20 min after its feeder, instruction requires 60",
  },
  instruction_day_cap: {
    detail: { kind: "instruction_day_cap", count: 3, day: "2026-08-01", requiredCount: 2 },
    expected: "3 fixtures on 2026-08-01 exceed the 2/day cap",
  },
  instruction_weekday: {
    detail: { kind: "instruction_weekday", weekday: "Friday", day: "2026-08-07", requiredWeekday: "Monday" },
    expected: "is on Friday 2026-08-07, instruction requires Monday",
  },
  instruction_date: {
    detail: { kind: "instruction_date", day: "2026-08-07", requiredDate: "2026-08-08" },
    expected: "is on 2026-08-07, instruction requires 2026-08-08",
  },
  instruction_time: {
    detail: { kind: "instruction_time", time: "09:00", ruleType: "not_before", requiredTime: "10:00" },
    expected: "starts 09:00, violating not_before 10:00",
  },
  outside_competition_window: {
    detail: { kind: "outside_competition_window" },
    expected: "outside the competition window",
  },
  outside_start_window: {
    detail: { kind: "outside_start_window" },
    expected: "outside the target's start window",
  },
  court_double_booking: {
    detail: { kind: "court_double_booking", court: "Court 1", otherFixtureId: "f2" },
    expected: "court Court 1 double-booked with f2",
  },
  inside_blackout: {
    detail: { kind: "inside_blackout" },
    expected: "inside a blackout window",
  },
  outside_session_windows: {
    detail: { kind: "outside_session_windows" },
    expected: "outside session windows",
  },
  entrant_overlap: {
    detail: { kind: "entrant_overlap", entrantIds: ["e1"], otherFixtureId: "f2" },
    expected: "entrant e1 overlap with f2",
  },
  entrant_below_rest: {
    detail: { kind: "entrant_below_rest", entrantIds: ["e1"] },
    expected: "entrant e1 below rest",
  },
  person_overlap: {
    detail: { kind: "person_overlap", personIds: ["p1"], otherFixtureId: "f2" },
    expected: "person p1 overlap with f2",
  },
  person_below_rest: {
    detail: { kind: "person_below_rest", personIds: ["p1", "p2"] },
    expected: "person p1/p2 below rest",
  },
  order_before_feeder: {
    detail: { kind: "order_before_feeder", otherFixtureId: "f1" },
    expected: "starts before feeder f1 ends",
  },
  order_inside_feeder_rest: {
    detail: { kind: "order_inside_feeder_rest", otherFixtureId: "f1", requiredMinutes: 30 },
    expected: "starts inside feeder f1's 30 min rest",
  },
  round_order_day: {
    detail: { kind: "round_order_day", roundNo: 2, otherRoundNo: 1, day: "2026-08-02", otherDay: "2026-08-01" },
    expected: "round 2 (day 2026-08-02) starts before round 1 (day 2026-08-01)",
  },
  round_order_same_day: {
    detail: { kind: "round_order_same_day", roundNo: 2, otherRoundNo: 1, day: "2026-08-01" },
    expected: "round 2 starts before round 1 on the same day (2026-08-01)",
  },
  no_slot_lattice: {
    detail: { kind: "no_slot_lattice" },
    expected: "no legal slot in the lattice",
  },
  no_slot_budget: {
    detail: { kind: "no_slot_budget" },
    expected: "left unplaced when the solver's budget expired",
  },
};

describe("legacyConflictDetail — byte-for-byte pre-C3 English (d0cd9a25)", () => {
  for (const [kind, { detail, expected }] of Object.entries(CASES)) {
    it(`${kind}`, () => {
      expect(legacyConflictDetail(detail)).toBe(expected);
    });
  }

  it("court_double_booking WITHOUT otherFixtureId falls back to the literal (calendar.ts:1384's reportability guard)", () => {
    expect(legacyConflictDetail({ kind: "court_double_booking", court: "Court 1" })).toBe(
      "court Court 1 double-booked with another fixture",
    );
  });
});

// ===========================================================================
// 1b. P9 pass 3a: `court` is now a real `courts.id` (uuid). `courtName` is
// the caller-attached resolution — never rendered as a bare uuid.
// ===========================================================================

describe("legacyConflictDetail — courtName (P9 pass 3a, venues/courts cutover)", () => {
  const courtId = "44444444-4444-4444-4444-444444444444";

  it("court_double_booking prefers courtName over the raw id", () => {
    expect(
      legacyConflictDetail({
        kind: "court_double_booking",
        court: courtId,
        courtName: "Centre Court",
        otherFixtureId: "f2",
      }),
    ).toBe("court Centre Court double-booked with f2");
  });

  it("locked_slot_clash prefers courtName over the raw id", () => {
    expect(
      legacyConflictDetail({ kind: "locked_slot_clash", court: courtId, courtName: "Centre Court" }),
    ).toBe("locked slot clashes on Centre Court");
  });

  it("falls back to the bare id when courtName is unset — never throws, still not silent", () => {
    expect(legacyConflictDetail({ kind: "court_double_booking", court: courtId, otherFixtureId: "f2" })).toBe(
      `court ${courtId} double-booked with f2`,
    );
  });
});

// ===========================================================================
// 2. Zod round-trip — `details` survives a `.parse()` on both wire schemas
// ===========================================================================

describe("ScheduleConflict / AiPlanConflict — details round-trips through zod (C3, 2026-08-13)", () => {
  it("ScheduleConflict.parse preserves a snake_case details object untouched", () => {
    const input = {
      fixture_id: "11111111-1111-4111-8111-111111111111",
      code: "warn.rest" as const,
      blocking: false,
      details: {
        kind: "entrant_below_rest" as const,
        entrant_ids: ["22222222-2222-4222-8222-222222222222"],
      },
    };
    const parsed = ScheduleConflict.parse(input);
    expect(parsed.details).toEqual(input.details);
  });

  // `AiPlanConflict` is not exported on its own (this file's module keeps
  // sub-object schemas private — same as `AiPlanAssignment`); reached through
  // its array element on the one exported response that carries it, which is
  // also the shape actually validated on the wire.
  it("AiPlanConflict (AiPlanResponse.warnings[]) preserves a camelCase details object untouched", () => {
    const element = AiPlanResponse.shape.warnings.element;
    const input = {
      fixtureId: "11111111-1111-1111-1111-111111111111",
      reason: "rest",
      details: {
        kind: "entrant_below_rest" as const,
        entrantIds: ["22222222-2222-2222-2222-222222222222"],
      },
    };
    const parsed = element.parse(input);
    expect(parsed.details).toEqual(input.details);
  });

  it("both schemas keep `detail` too — additive, not a replacement", () => {
    const entrantId = "33333333-3333-4333-8333-333333333333";
    const parsed = ScheduleConflict.parse({
      fixture_id: "11111111-1111-4111-8111-111111111111",
      code: "warn.rest" as const,
      blocking: false,
      detail: `entrant ${entrantId} below rest`,
      details: { kind: "entrant_below_rest" as const, entrant_ids: [entrantId] },
    });
    expect(parsed.detail).toBe(`entrant ${entrantId} below rest`);
    expect(parsed.details).toEqual({ kind: "entrant_below_rest", entrant_ids: [entrantId] });
  });
});

// ===========================================================================
// 3. legacyVerifierConflict — the model's copy never carries `details`
// ===========================================================================

describe("legacyVerifierConflict — the AI repair round's byte-identical copy", () => {
  it("strips `details` and derives `detail` from it", () => {
    const c = {
      fixtureId: "f1",
      reason: "rest" as const,
      details: { kind: "entrant_below_rest" as const, entrantIds: ["e1"] },
    };
    const out = legacyVerifierConflict(c);
    expect(out).not.toHaveProperty("details");
    expect(out.detail).toBe("entrant e1 below rest");
    expect(out.fixtureId).toBe("f1");
    expect(out.reason).toBe("rest");
  });

  it("carries every OTHER field through completely unchanged", () => {
    const c = {
      fixtureId: "f1",
      reason: "order" as const,
      direct: true,
      rule: "H6" as const,
      shortfallMinutes: 15,
      details: { kind: "order_before_feeder" as const, otherFixtureId: "f0" },
    };
    const out = legacyVerifierConflict(c);
    expect(out.direct).toBe(true);
    expect(out.rule).toBe("H6");
    expect(out.shortfallMinutes).toBe(15);
    expect(out.detail).toBe("starts before feeder f0 ends");
  });

  it("rebuilds the pre-C3 key order — `detail` sits where it always did, not wherever the destructure left it (review finding 4)", () => {
    // Pre-C3 (git show d0cd9a25:packages/engine/src/scheduling/calendar.ts),
    // every push site wrote `{ fixtureId, reason, detail, [direct],
    // [shortfallMinutes] }` in that literal order, and `withRule` appended
    // `rule` last (`{ ...c, rule: RULE_BY_REASON[c.reason] }` — `rule` is
    // never already a key on `c`, so the spread always adds it at the end).
    // `{ ...rest, detail: ... }` on a `rest` that still carries `direct`/
    // `shortfallMinutes`/`rule` from the CURRENT (post-C3) object instead
    // puts `detail` at the very end, after `rule` — same field SET, wrong
    // BYTES, which is what licenses the "byte-identical model payload"
    // claim behind the AI-credit token-weight argument.
    const c = {
      fixtureId: "f1",
      reason: "order" as const,
      direct: true,
      rule: "H6" as const,
      shortfallMinutes: 15,
      details: { kind: "order_before_feeder" as const, otherFixtureId: "f0" },
    };
    const out = legacyVerifierConflict(c);
    expect(Object.keys(out)).toEqual([
      "fixtureId",
      "reason",
      "detail",
      "direct",
      "shortfallMinutes",
      "rule",
    ]);
    // The same invariant as it actually reaches the model: JSON.stringify
    // drops nothing here (every field is defined), so key order in the JS
    // object IS the order the bytes serialize in.
    expect(Object.keys(JSON.parse(JSON.stringify(out)))).toEqual(Object.keys(out));
  });

  it("a conflict with no `details` at all gets no `detail` either — mirrors pre-C3 exactly", () => {
    const c = { fixtureId: "f1", reason: "instruction" as const };
    expect(legacyVerifierConflict(c)).toEqual({ fixtureId: "f1", reason: "instruction" });
  });
});

describe("withLegacyDetail — restores `detail` on a verbatim wire response", () => {
  it("keeps `details` AND adds the derived `detail` (additive, unlike legacyVerifierConflict)", () => {
    const c = {
      fixtureId: "f1",
      reason: "rest" as const,
      details: { kind: "entrant_below_rest" as const, entrantIds: ["e1"] },
    };
    const out = withLegacyDetail(c);
    expect(out.details).toEqual(c.details);
    expect(out.detail).toBe("entrant e1 below rest");
  });

  it("a conflict with no `details` passes through unchanged", () => {
    const c: { fixtureId: string; reason: "instruction"; details?: ConflictDetail } = {
      fixtureId: "f1",
      reason: "instruction",
    };
    expect(withLegacyDetail(c)).toBe(c);
  });
});
