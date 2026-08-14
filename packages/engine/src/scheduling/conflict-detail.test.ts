// C3 (2026-08-13 design amendment) — the shared primitive every structured
// conflict detail canonicalizes through. `conflictKey` (calendar.ts:218)
// folds `canonConflictDetail` into the conflict identity the delta gate
// (`deltaConflicts`), `repair-minimality.ts` and the joint apply gate all key
// on, so this file is the guarantee that a field silently dropped from canon
// — or an id array silently re-ordered — cannot ship quietly. See
// `docs/superpowers/specs/2026-08-12-conflict-detail-names-design.md`,
// "AMENDED 2026-08-13" section, for the 25-kind table this file is
// table-driven over, and for `conflictKey`'s own three load-bearing comments
// (calendar.ts:829, :1364-1376, :1479-1495) this canon must keep true.
import { describe, expect, it } from "vitest";
import { canonConflictDetail, type ConflictDetail, type ConflictDetailKind } from "./conflict-detail.ts";
import { conflictKey, type Conflict } from "./calendar.ts";

// The 25-kind table, field-for-field, written out explicitly rather than
// generated so it reads beside the design doc's table and a missing kind is a
// `Record<ConflictDetailKind, …>` type error rather than a silently skipped
// row — the same reasoning `RULE_BY_REASON` uses for `ConflictReason`.
const FULL_DETAIL: Record<ConflictDetailKind, ConflictDetail> = {
  person_double_booking: { kind: "person_double_booking", personIds: ["p1", "p2"], otherFixtureId: "f-other" },
  locked_slot_clash: { kind: "locked_slot_clash", court: "C1" },
  no_slot_start_window: { kind: "no_slot_start_window" },
  no_slot_person_bound: { kind: "no_slot_person_bound", personIds: ["p1", "p2"], otherFixtureId: "f-other" },
  no_slot_horizon: { kind: "no_slot_horizon" },
  instruction_feeder_gap: { kind: "instruction_feeder_gap", minutes: 20, requiredMinutes: 40 },
  instruction_day_cap: { kind: "instruction_day_cap", count: 4, day: "2026-08-10", requiredCount: 2 },
  instruction_weekday: {
    kind: "instruction_weekday",
    weekday: "FRI",
    day: "2026-08-10",
    requiredWeekday: "MON",
  },
  instruction_date: { kind: "instruction_date", day: "2026-08-10", requiredDate: "2026-08-07" },
  instruction_time: {
    kind: "instruction_time",
    time: "09:00",
    ruleType: "not_before",
    requiredTime: "20:00",
  },
  outside_competition_window: { kind: "outside_competition_window" },
  outside_start_window: { kind: "outside_start_window" },
  court_double_booking: { kind: "court_double_booking", court: "C1", otherFixtureId: "f-other" },
  inside_blackout: { kind: "inside_blackout" },
  outside_session_windows: { kind: "outside_session_windows" },
  entrant_overlap: { kind: "entrant_overlap", entrantIds: ["e1", "e2"], otherFixtureId: "f-other" },
  entrant_below_rest: { kind: "entrant_below_rest", entrantIds: ["e1", "e2"] },
  person_overlap: { kind: "person_overlap", personIds: ["p1", "p2"], otherFixtureId: "f-other" },
  person_below_rest: { kind: "person_below_rest", personIds: ["p1", "p2"] },
  order_before_feeder: { kind: "order_before_feeder", otherFixtureId: "f-other" },
  order_inside_feeder_rest: {
    kind: "order_inside_feeder_rest",
    otherFixtureId: "f-other",
    requiredMinutes: 40,
  },
  round_order_day: {
    kind: "round_order_day",
    roundNo: 3,
    otherRoundNo: 2,
    day: "2026-08-10",
    otherDay: "2026-08-09",
  },
  round_order_same_day: { kind: "round_order_same_day", roundNo: 3, otherRoundNo: 2, day: "2026-08-10" },
  no_slot_lattice: { kind: "no_slot_lattice" },
  no_slot_budget: { kind: "no_slot_budget" },
};

const ALL_KINDS = Object.keys(FULL_DETAIL) as ConflictDetailKind[];

/** One alternate value per field — what the field-participation mutation
 *  changes TO. Arrays carry a different length AND different content than
 *  `FULL_DETAIL`'s samples, so a canon that only hashed array length would
 *  still be caught. */
const ALT_VALUE: { [K in keyof Omit<ConflictDetail, "kind">]-?: NonNullable<ConflictDetail[K]> } = {
  entrantIds: ["e9"],
  personIds: ["p9"],
  otherFixtureId: "f-changed",
  court: "C2",
  day: "2026-08-11",
  otherDay: "2026-08-12",
  weekday: "SAT",
  requiredWeekday: "TUE",
  requiredDate: "2026-08-08",
  time: "10:00",
  requiredTime: "21:00",
  ruleType: "not_after",
  roundNo: 5,
  otherRoundNo: 4,
  minutes: 25,
  requiredMinutes: 45,
  count: 6,
  requiredCount: 3,
};

describe("canonConflictDetail — per-kind field participation (all 25 kinds)", () => {
  for (const kind of ALL_KINDS) {
    const base = FULL_DETAIL[kind];
    const fields = Object.keys(base).filter((k) => k !== "kind") as (keyof Omit<ConflictDetail, "kind">)[];

    describe(kind, () => {
      if (fields.length === 0) {
        it("has no fields beyond kind — kind alone is its whole identity", () => {
          expect(canonConflictDetail(base)).toBe(canonConflictDetail({ kind }));
        });
        return;
      }

      for (const field of fields) {
        it(`\`${field}\` participates in the canon — dropping it would go undetected`, () => {
          const mutated = { ...base, [field]: ALT_VALUE[field] };
          // Guard the fixture itself: if this ever stops being an actual
          // mutation the assertion below would pass for the wrong reason.
          expect(mutated).not.toEqual(base);
          expect(canonConflictDetail(mutated)).not.toBe(canonConflictDetail(base));
        });
      }
    });
  }
});

describe("canonConflictDetail — insertion-order independence", () => {
  it("canons identically regardless of the literal property order (two fields)", () => {
    const a: ConflictDetail = { kind: "entrant_overlap", entrantIds: ["e1"], otherFixtureId: "f9" };
    const b: ConflictDetail = { otherFixtureId: "f9", entrantIds: ["e1"], kind: "entrant_overlap" };
    expect(canonConflictDetail(a)).toBe(canonConflictDetail(b));
  });

  it("canons identically regardless of the literal property order (four fields)", () => {
    const a: ConflictDetail = {
      kind: "round_order_day",
      roundNo: 3,
      otherRoundNo: 2,
      day: "2026-08-10",
      otherDay: "2026-08-09",
    };
    const b: ConflictDetail = {
      otherDay: "2026-08-09",
      day: "2026-08-10",
      kind: "round_order_day",
      otherRoundNo: 2,
      roundNo: 3,
    };
    expect(canonConflictDetail(a)).toBe(canonConflictDetail(b));
  });

  it("does NOT just JSON.stringify the object as given — a naive stringify would fail this", () => {
    const a: ConflictDetail = { kind: "locked_slot_clash", court: "C1" };
    const b: ConflictDetail = { court: "C1", kind: "locked_slot_clash" };
    // A bare `JSON.stringify` depends on insertion order, so this is the one
    // assertion a `JSON.stringify(d)` implementation fails.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(canonConflictDetail(a)).toBe(canonConflictDetail(b));
  });
});

describe("canonConflictDetail — id array order is meaningful", () => {
  // `person_below_rest` joins `sharedPeople` in board order today
  // (calendar.ts:1451, `sharedPeople.join("/")`); the legacy prose must be
  // reproducible from the structure, so the canon may not silently sort.
  it("does not canon two orderings of the same people the same way", () => {
    const forward: ConflictDetail = { kind: "person_below_rest", personIds: ["p1", "p2"] };
    const reversed: ConflictDetail = { kind: "person_below_rest", personIds: ["p2", "p1"] };
    expect(canonConflictDetail(forward)).not.toBe(canonConflictDetail(reversed));
  });

  it("preserves the exact given order for a 3+ id array", () => {
    const given: ConflictDetail = { kind: "person_below_rest", personIds: ["p3", "p1", "p2"] };
    const same: ConflictDetail = { kind: "person_below_rest", personIds: ["p3", "p1", "p2"] };
    const sorted: ConflictDetail = { kind: "person_below_rest", personIds: ["p1", "p2", "p3"] };
    expect(canonConflictDetail(given)).toBe(canonConflictDetail(same));
    expect(canonConflictDetail(given)).not.toBe(canonConflictDetail(sorted));
  });
});

describe("canonConflictDetail — zero-field kinds are still distinguishable", () => {
  it("gives every zero-field kind its own canon (kind alone carries identity)", () => {
    const zeroFieldKinds = ALL_KINDS.filter((k) => Object.keys(FULL_DETAIL[k]).length === 1);
    // Sanity on the fixture: the design table names 8 kinds with no fields
    // beyond `kind` (rows 3, 5, 11, 12, 14, 15, 24, 25).
    expect(zeroFieldKinds).toHaveLength(8);
    const canons = zeroFieldKinds.map((k) => canonConflictDetail({ kind: k }));
    expect(new Set(canons).size).toBe(canons.length);
  });
});

describe("conflictKey folds canonConflictDetail into the conflict identity", () => {
  it("differs for two conflicts identical but for one detail field", () => {
    const a: Conflict = {
      fixtureId: "f1",
      reason: "court",
      details: { kind: "court_double_booking", court: "C1", otherFixtureId: "b" },
    };
    const b: Conflict = {
      fixtureId: "f1",
      reason: "court",
      details: { kind: "court_double_booking", court: "C1", otherFixtureId: "c" },
    };
    expect(conflictKey(a)).not.toBe(conflictKey(b));
  });

  it("is equal for two structurally equal conflicts", () => {
    const a: Conflict = {
      fixtureId: "f1",
      reason: "rest",
      details: { kind: "entrant_below_rest", entrantIds: ["e1"] },
    };
    const b: Conflict = {
      fixtureId: "f1",
      reason: "rest",
      details: { kind: "entrant_below_rest", entrantIds: ["e1"] },
    };
    expect(conflictKey(a)).toBe(conflictKey(b));
  });

  it("stays stable, and empty, when a conflict carries no details at all", () => {
    const a: Conflict = { fixtureId: "f1", reason: "window" };
    const b: Conflict = { fixtureId: "f1", reason: "window" };
    expect(conflictKey(a)).toBe(conflictKey(b));
    expect(conflictKey(a)).toBe("f1|window|");
  });
});
