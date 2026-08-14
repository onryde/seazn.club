// C3 (2026-08-13 design amendment) — the two proofs the design doc's
// "conflictKey" section demands, because neither alone is sufficient:
//
//   * LEGACY PARITY, CORPUS: real boards through the CURRENT engine
//     (`validateAssignments`, which folds in `validateInstructionRules` and
//     `roundOrderConflicts`) — not hand-built `ConflictDetail` objects (that
//     is `conflict-detail-legacy.test.ts`'s job) — must derive the exact
//     pre-C3 English for every conflict they produce. This is the proof that
//     the engine's own field POPULATION (which id lands in `personIds[0]`,
//     which fixture becomes `otherFixtureId`) matches what the old inline
//     template read off the same local variables, not just that the template
//     STRINGS were ported correctly.
//   * PARTITION PARITY (the important one, design doc's own words): grouping
//     this corpus by the OLD key (`fixtureId|reason|legacyProse`) and by the
//     NEW `conflictKey` (`fixtureId|reason|canonConflictDetail(details)`)
//     must yield the SAME partition — same group count, same membership.
//     This is the proof that `deltaConflicts` and the joint apply gate did
//     not change which edits an organiser's apply refuses.
//
// No DB: `validateAssignments` is a pure function over in-memory
// Assignments/VerifyConfig.
//
// SCOPE: covers the `validateAssignments`-reachable kinds (10 of the 25) —
// court/entrant/person overlap+rest, order (feeder), round order, and an
// instruction day-cap. The other 15 (the GREEDY PLACER's
// person_double_booking/locked_slot_clash/no_slot_* and build.ts's
// no_slot_lattice/no_slot_budget, plus the remaining instruction/window
// variants) are exhaustively covered by `conflict-detail-legacy.test.ts`'s
// per-kind table instead — this file's job is proving real engine WIRING,
// not re-proving the 25 templates a second time.
import { describe, expect, it } from "vitest";
import {
  conflictKey,
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { legacyConflictDetail } from "../conflict-detail-legacy";

const at = (iso: string): number => Date.parse(iso);

/** Bare-bones Assignment — every field defaults to "disjoint from everything
 *  else in this corpus" so one scenario cannot bleed into another. */
function a(over: Partial<Assignment> & Pick<Assignment, "fixtureId" | "court" | "startAt" | "endAt">): Assignment {
  return { entrants: [], people: [], ...over };
}

const REST_MIN = 30;

const assignments: Assignment[] = [
  // --- A: court_double_booking (only) — disjoint entrants/people ----------
  // THREE on one court, not two: A1 collides with BOTH A2 and A3, so it
  // carries TWO `court` rows differing only in `otherFixtureId` — the exact
  // "one row per colliding fixture" case the design doc's own comment on
  // `court_double_booking` names, and the reason partition parity has
  // anything to prove here. A key that dropped the counterparty (the old
  // per-CARD bug the design doc's `:1364-1376` comment records) would
  // collapse these two rows into one group; the real `conflictKey` may not.
  a({ fixtureId: "A1", court: "CA", startAt: at("2026-08-03T09:00:00Z"), endAt: at("2026-08-03T10:00:00Z") }),
  a({ fixtureId: "A2", court: "CA", startAt: at("2026-08-03T09:00:00Z"), endAt: at("2026-08-03T10:00:00Z") }),
  a({ fixtureId: "A3", court: "CA", startAt: at("2026-08-03T09:00:00Z"), endAt: at("2026-08-03T10:00:00Z") }),

  // --- B: entrant_overlap (only) — shared entrant, overlapping, different courts
  a({
    fixtureId: "B1",
    court: "CB1",
    startAt: at("2026-08-03T09:00:00Z"),
    endAt: at("2026-08-03T10:00:00Z"),
    entrants: ["EB"],
  }),
  a({
    fixtureId: "B2",
    court: "CB2",
    startAt: at("2026-08-03T09:00:00Z"),
    endAt: at("2026-08-03T10:00:00Z"),
    entrants: ["EB"],
  }),

  // --- C: entrant_below_rest (only) — shared entrant, NOT overlapping, gap < REST_MIN
  a({
    fixtureId: "C1",
    court: "CC1",
    startAt: at("2026-08-03T09:00:00Z"),
    endAt: at("2026-08-03T10:00:00Z"),
    entrants: ["EC"],
  }),
  a({
    fixtureId: "C2",
    court: "CC2",
    startAt: at("2026-08-03T10:05:00Z"),
    endAt: at("2026-08-03T11:05:00Z"),
    entrants: ["EC"],
  }),

  // --- D: person_overlap (only) — shared person, DIFFERENT entrants, overlapping
  a({
    fixtureId: "D1",
    court: "CD1",
    startAt: at("2026-08-03T09:00:00Z"),
    endAt: at("2026-08-03T10:00:00Z"),
    entrants: ["ED1"],
    people: ["PD"],
  }),
  a({
    fixtureId: "D2",
    court: "CD2",
    startAt: at("2026-08-03T09:00:00Z"),
    endAt: at("2026-08-03T10:00:00Z"),
    entrants: ["ED2"],
    people: ["PD"],
  }),

  // --- E: person_below_rest (only) — shared person, different entrants, gap < REST_MIN
  a({
    fixtureId: "E1",
    court: "CE1",
    startAt: at("2026-08-03T09:00:00Z"),
    endAt: at("2026-08-03T10:00:00Z"),
    entrants: ["EE1"],
    people: ["PE"],
  }),
  a({
    fixtureId: "E2",
    court: "CE2",
    startAt: at("2026-08-03T10:05:00Z"),
    endAt: at("2026-08-03T11:05:00Z"),
    entrants: ["EE2"],
    people: ["PE"],
  }),

  // --- F: order_before_feeder — dependent starts before the feeder ends ---
  a({ fixtureId: "F1", court: "CF1", startAt: at("2026-08-03T09:00:00Z"), endAt: at("2026-08-03T10:00:00Z") }),
  a({ fixtureId: "F2a", court: "CF2", startAt: at("2026-08-03T09:30:00Z"), endAt: at("2026-08-03T10:30:00Z") }),

  // --- G: order_inside_feeder_rest — starts after the feeder, inside REST_MIN
  a({ fixtureId: "F3", court: "CF3", startAt: at("2026-08-03T09:00:00Z"), endAt: at("2026-08-03T10:00:00Z") }),
  a({ fixtureId: "F4", court: "CF4", startAt: at("2026-08-03T10:10:00Z"), endAt: at("2026-08-03T11:10:00Z") }),

  // --- H: round_order_day — round 2 lands on an EARLIER day than round 1 --
  a({
    fixtureId: "G1",
    court: "CG1",
    startAt: at("2026-08-03T09:00:00Z"),
    endAt: at("2026-08-03T10:00:00Z"),
    roundNo: 1,
    stageId: "STA",
  }),
  a({
    fixtureId: "G2",
    court: "CG2",
    startAt: at("2026-08-02T09:00:00Z"),
    endAt: at("2026-08-02T10:00:00Z"),
    roundNo: 2,
    stageId: "STA",
  }),

  // --- I: round_order_same_day — round 2 starts earlier on the SAME day ---
  a({
    fixtureId: "G3",
    court: "CG3",
    startAt: at("2026-08-05T09:00:00Z"),
    endAt: at("2026-08-05T10:00:00Z"),
    roundNo: 1,
    stageId: "STB",
  }),
  a({
    fixtureId: "G4",
    court: "CG4",
    startAt: at("2026-08-05T08:00:00Z"),
    endAt: at("2026-08-05T09:00:00Z"),
    roundNo: 2,
    stageId: "STB",
  }),

  // --- J: instruction_day_cap — three fixtures on one day, cap 2 ----------
  a({ fixtureId: "H1", court: "CH1", startAt: at("2026-08-06T08:00:00Z"), endAt: at("2026-08-06T09:00:00Z") }),
  a({ fixtureId: "H2", court: "CH2", startAt: at("2026-08-06T10:00:00Z"), endAt: at("2026-08-06T11:00:00Z") }),
  a({ fixtureId: "H3", court: "CH3", startAt: at("2026-08-06T12:00:00Z"), endAt: at("2026-08-06T13:00:00Z") }),
];

const dependencies: OrderDependency[] = [
  { fixtureId: "F2a", dependsOn: "F1", direct: true },
  { fixtureId: "F4", dependsOn: "F3", direct: true },
];

const config: VerifyConfig = {
  perEntrantMinRest: REST_MIN,
  gapMinutes: 0,
  tz: "UTC",
  hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
};

// Computed once — every `it` below reads the same corpus, and the
// PARTITION-PARITY describe block needs to compare it two different ways.
const conflicts: Conflict[] = validateAssignments(assignments, config, [], dependencies);

describe("legacy parity, corpus — real validateAssignments output vs pre-C3 English", () => {
  it("produced at least one conflict for every scenario in the corpus (guards the guard)", () => {
    // If this is empty or short, the scenarios below aren't testing what they
    // claim to — a silently-vacuous corpus proves nothing.
    expect(conflicts.length).toBeGreaterThanOrEqual(20);
  });

  const expectDetail = (fixtureId: string, reason: Conflict["reason"], expected: string) => {
    const rows = conflicts.filter((c) => c.fixtureId === fixtureId && c.reason === reason);
    expect(rows.length, `expected a ${reason} row on ${fixtureId}; got ${JSON.stringify(conflicts)}`).toBeGreaterThan(
      0,
    );
    for (const c of rows) {
      expect(c.details, `row on ${fixtureId} has no details: ${JSON.stringify(c)}`).toBeDefined();
      expect(legacyConflictDetail(c.details!)).toBe(expected);
    }
  };

  it("A: court_double_booking — THREE on one court, each carries TWO rows, one per counterparty, never collapsed", () => {
    // All three overlap all three: A1×{A2,A3}, A2×{A1,A3}, A3×{A1,A2}.
    for (const [id, others] of [
      ["A1", ["A2", "A3"]],
      ["A2", ["A1", "A3"]],
      ["A3", ["A1", "A2"]],
    ] as const) {
      const rows = conflicts.filter((c) => c.fixtureId === id && c.reason === "court");
      expect(rows, `${id}: ${JSON.stringify(conflicts)}`).toHaveLength(2);
      const prose = rows.map((c) => legacyConflictDetail(c.details!)).sort();
      expect(prose).toEqual(others.map((o) => `court CA double-booked with ${o}`).sort());
    }
  });

  it("B: entrant_overlap, both sides", () => {
    expectDetail("B1", "person_overlap", "entrant EB overlap with B2");
    expectDetail("B2", "person_overlap", "entrant EB overlap with B1");
  });

  it("C: entrant_below_rest, both sides", () => {
    expectDetail("C1", "rest", "entrant EC below rest");
    expectDetail("C2", "rest", "entrant EC below rest");
  });

  it("D: person_overlap, both sides", () => {
    expectDetail("D1", "person_overlap", "person PD overlap with D2");
    expectDetail("D2", "person_overlap", "person PD overlap with D1");
  });

  it("E: person_below_rest, both sides", () => {
    expectDetail("E1", "rest", "person PE below rest");
    expectDetail("E2", "rest", "person PE below rest");
  });

  it("F: order_before_feeder", () => {
    expectDetail("F2a", "order", "starts before feeder F1 ends");
  });

  it("G: order_inside_feeder_rest", () => {
    expectDetail("F4", "order", `starts inside feeder F3's ${REST_MIN} min rest`);
  });

  it("H: round_order_day", () => {
    expectDetail("G2", "order", "round 2 (day 2026-08-02) starts before round 1 (day 2026-08-03)");
  });

  it("I: round_order_same_day", () => {
    expectDetail("G4", "order", "round 2 starts before round 1 on the same day (2026-08-05)");
  });

  it("J: instruction_day_cap, all three", () => {
    for (const id of ["H1", "H2", "H3"]) {
      expectDetail(id, "instruction", "3 fixtures on 2026-08-06 exceed the 2/day cap");
    }
  });
});

describe("partition parity — grouping by the OLD key and the NEW key agree (design doc's own proof)", () => {
  /** The identity `conflictKey` replaced: `fixtureId|reason|prose`. Built
   *  from `legacyConflictDetail`, never from the wire's own `detail` (there
   *  isn't one on a bare engine `Conflict`) — this is what a caller keying on
   *  today's derived English, pre-C3 style, would have computed. */
  const oldKey = (c: Conflict): string => `${c.fixtureId}|${c.reason}|${c.details ? legacyConflictDetail(c.details) : ""}`;

  /** Groups `conflicts` by `keyFn`, returning each group as a SORTED array of
   *  fixtureIds — comparable across the two keyings regardless of which
   *  order either key function happens to iterate in. */
  function partitionBy(keyFn: (c: Conflict) => string): string[][] {
    const groups = new Map<string, string[]>();
    for (const c of conflicts) {
      const k = keyFn(c);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c.fixtureId);
    }
    return [...groups.values()].map((g) => [...g].sort()).sort((x, y) => (x.join(",") < y.join(",") ? -1 : 1));
  }

  it("same NUMBER of groups", () => {
    expect(partitionBy(conflictKey).length).toBe(partitionBy(oldKey).length);
  });

  it("same MEMBERSHIP — every group under the new key exists, byte-identical, under the old key", () => {
    expect(partitionBy(conflictKey)).toEqual(partitionBy(oldKey));
  });

  it("is not vacuously true: a key that IGNORED `details` partitions differently", () => {
    // The two `it`s above compare two keyings of the same corpus. That proves
    // nothing unless the corpus actually exercises the discrimination
    // `details` carries: if every conflict here had a unique
    // (fixtureId, reason), the bare pair would partition identically and both
    // assertions would still pass against a `conflictKey` that had dropped the
    // detail from its identity altogether — which is the precise regression
    // they exist to catch.
    //
    // So falsify it directly. A1 carries TWO `court` rows differing ONLY in
    // `otherFixtureId` (corpus section A) — the per-CARD collapse
    // `calendar.ts:1364-1376` records as a bug that shipped once already, where
    // a card that kept its clash with B and gained one with C reported the
    // single row it always did. The degenerate key MUST be strictly coarser
    // than the real one here, or this corpus cannot see that regression.
    //
    // The previous form of this guard asserted `length < conflicts.length + 1`,
    // which no partition can ever violate — a vacuous falsifier is worse than
    // none, because it reads as protection.
    const degenerate = (c: Conflict): string => `${c.fixtureId}|${c.reason}`;
    expect(partitionBy(degenerate)).not.toEqual(partitionBy(conflictKey));
    expect(partitionBy(degenerate).length).toBeLessThan(partitionBy(conflictKey).length);
    expect(partitionBy(conflictKey).length).toBeGreaterThan(1);
  });
});
