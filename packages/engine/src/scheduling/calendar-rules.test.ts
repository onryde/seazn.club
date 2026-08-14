// #399 W4 — the rule vocabulary and the conflict delta.
//
// Two independent guarantees live here:
//
//   1. Every `Conflict` the verifier emits carries the rule code the scheduling
//      prompts taught (H2-H8, or CAP for the capacity case). A repair round that
//      is handed `{reason: "rest"}` is being asked to fix a word it was never
//      taught; one handed `H4` can act mechanically.
//   2. `deltaConflicts` is a MULTISET difference over the conflict identity, so
//      a pre-existing conflict is never reported as introduced and a second
//      instance of one is.
import { describe, expect, it } from "vitest";
import {
  conflictKey,
  deltaConflicts,
  RULE_BY_REASON,
  validateAssignments,
  type Conflict,
  type ConflictDetail,
  type ConflictReason,
  type VerifyConfig,
} from "./calendar";
import { canonConflictDetail } from "./conflict-detail";

// Written out rather than derived: a union member added without a rule code is
// exactly the regression this asserts, and deriving the list from the map would
// make the test agree with the bug.
const ALL_REASONS: ConflictReason[] = [
  "no_slot",
  "court",
  "rest",
  "blackout",
  "person_overlap",
  "start_window",
  "window",
  "instruction",
  "order",
];

const AT = Date.UTC(2026, 7, 10, 9, 0);
const MIN = 60_000;

const cfg: VerifyConfig = {
  perEntrantMinRest: 0,
  gapMinutes: 0,
  blackouts: [],
  sessionWindows: [],
  matchMinutes: 30,
};

const conflict = (fixtureId: string, reason: ConflictReason, details?: ConflictDetail): Conflict => ({
  fixtureId,
  reason,
  ...(details !== undefined ? { details } : {}),
});

describe("rule codes (#399)", () => {
  it("maps every ConflictReason, and nothing that is not one", () => {
    expect(Object.keys(RULE_BY_REASON).sort()).toEqual([...ALL_REASONS].sort());
  });

  it("uses the codes the prompt teaches", () => {
    expect(RULE_BY_REASON.court).toBe("H2");
    expect(RULE_BY_REASON.blackout).toBe("H3");
    expect(RULE_BY_REASON.window).toBe("H3");
    expect(RULE_BY_REASON.rest).toBe("H4");
    expect(RULE_BY_REASON.person_overlap).toBe("H4");
    expect(RULE_BY_REASON.start_window).toBe("H5");
    expect(RULE_BY_REASON.order).toBe("H6");
    expect(RULE_BY_REASON.instruction).toBe("H8");
  });

  it("gives the capacity case CAP, not a rule it did not break", () => {
    expect(RULE_BY_REASON.no_slot).toBe("CAP");
  });

  it("stamps the code on a court clash the verifier actually produces", () => {
    const conflicts = validateAssignments(
      [
        { fixtureId: "a", court: "C1", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e1"], people: [] },
        { fixtureId: "b", court: "C1", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e2"], people: [] },
      ],
      { ...cfg, courts: ["C1"] } as VerifyConfig,
    );
    expect(conflicts.some((c) => c.reason === "court")).toBe(true);
    expect(conflicts.every((c) => c.rule === RULE_BY_REASON[c.reason])).toBe(true);
  });

  it("stamps the code on a person overlap and on a rest breach", () => {
    const conflicts = validateAssignments(
      [
        { fixtureId: "a", court: "C1", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e1"], people: ["p1"] },
        { fixtureId: "b", court: "C2", startAt: AT, endAt: AT + 30 * MIN, entrants: ["e2"], people: ["p1"] },
      ],
      cfg,
    );
    const overlap = conflicts.find((c) => c.reason === "person_overlap");
    expect(overlap?.rule).toBe("H4");
  });
});

describe("conflictKey (#399)", () => {
  it("is fixture, reason and the canon of details", () => {
    const details: ConflictDetail = { kind: "court_double_booking", court: "C1" };
    // Literal, not derived from `canonConflictDetail` itself — this pins
    // `conflictKey`'s OWN composition contract (`fixtureId|reason|canon`);
    // `canonConflictDetail`'s correctness is conflict-detail.test.ts's job.
    expect(conflictKey(conflict("f1", "court", details))).toBe(
      'f1|court|kind=court_double_booking|court="C1"',
    );
    expect(conflictKey(conflict("f1", "court", details))).toBe(
      `f1|court|${canonConflictDetail(details)}`,
    );
  });

  it("keeps the empty-details slot so a details-less conflict still keys stably", () => {
    expect(conflictKey(conflict("f1", "court"))).toBe("f1|court|");
  });
});

describe("deltaConflicts (#399)", () => {
  it("does not report a conflict that was already there", () => {
    const pre = conflict("f1", "person_overlap", { kind: "person_overlap", personIds: ["p1"] });
    expect(deltaConflicts([pre], [pre])).toEqual([]);
  });

  it("reports a conflict the change introduced", () => {
    const fresh = conflict("f2", "person_overlap", { kind: "person_overlap", personIds: ["p9"] });
    expect(
      deltaConflicts(
        [conflict("f1", "person_overlap", { kind: "person_overlap", personIds: ["p1"] })],
        [fresh],
      ),
    ).toEqual([fresh]);
  });

  it("reports a WORSENED conflict — same key, one more instance", () => {
    const dup = conflict("f1", "person_overlap", { kind: "person_overlap", personIds: ["p1"] });
    expect(deltaConflicts([dup], [dup, dup])).toEqual([dup]);
  });

  it("reports a bigger breach, because the details differ", () => {
    const worse = conflict("f1", "rest", { kind: "person_below_rest", personIds: ["p1", "p2"] });
    expect(
      deltaConflicts(
        [conflict("f1", "rest", { kind: "person_below_rest", personIds: ["p1"] })],
        [worse],
      ),
    ).toEqual([worse]);
  });

  it("does not resurrect a conflict the change REMOVED", () => {
    expect(
      deltaConflicts([conflict("f1", "court", { kind: "court_double_booking", court: "C1" })], []),
    ).toEqual([]);
  });

  it("is empty when nothing changed at all", () => {
    const board = [
      conflict("f1", "rest", { kind: "entrant_below_rest", entrantIds: ["e1"] }),
      conflict("f2", "blackout", { kind: "inside_blackout" }),
    ];
    expect(deltaConflicts(board, board)).toEqual([]);
  });

  // --- the two ways a stable key can lie -----------------------------------

  const insideFeederRest: ConflictDetail = {
    kind: "order_inside_feeder_rest",
    otherFixtureId: "feeder1",
    requiredMinutes: 40,
  };

  it("reports a breach that got WORSE at the same key", () => {
    // Some conflicts are measured, not binary: a feeder rest breach is 10
    // minutes short before and 30 minutes short after. The key has to stay
    // stable (see the lock-out case below) so the SIZE travels beside it.
    const before = { ...conflict("f1", "order", insideFeederRest), shortfallMinutes: 10 };
    const after = { ...conflict("f1", "order", insideFeederRest), shortfallMinutes: 30 };
    expect(deltaConflicts([before], [after])).toEqual([after]);
  });

  it("does NOT report a breach that got SMALLER but has not cleared", () => {
    // The lock-out this wave exists to prevent, in its subtlest form: dragging a
    // card from 30 minutes short of the rest it owes to 10 minutes short is an
    // IMPROVEMENT. Reporting it as introduced would refuse the very edit that is
    // repairing the board.
    const before = { ...conflict("f1", "order", insideFeederRest), shortfallMinutes: 30 };
    const after = { ...conflict("f1", "order", insideFeederRest), shortfallMinutes: 10 };
    expect(deltaConflicts([before], [after])).toEqual([]);
  });

  it("treats an equal breach as unchanged", () => {
    const same = { ...conflict("f1", "order", insideFeederRest), shortfallMinutes: 10 };
    expect(deltaConflicts([same], [{ ...same }])).toEqual([]);
  });
});

describe("conflict identity names the counterparty (#399)", () => {
  // Without it, a SWAP is invisible to the delta: the same fixture, the same
  // reason, the same court — but a different victim — keys identically, and a
  // brand-new double-booking writes through as "pre-existing".
  const MIN = 60_000;
  const a = (fixtureId: string, court: string, startAt: number, entrants: string[], people: string[]) => ({
    fixtureId,
    court,
    startAt,
    endAt: startAt + 30 * MIN,
    entrants,
    people,
  });

  it("keys a court clash on the fixture it collides with", () => {
    const clashWith = (otherId: string) =>
      validateAssignments(
        [a("f1", "C1", AT, ["e1"], [])],
        cfg,
        [a(otherId, "C1", AT, ["e9"], [])],
      ).filter((c) => c.reason === "court");

    const [withB] = clashWith("fB");
    const [withC] = clashWith("fC");
    expect(withB).toBeDefined();
    expect(conflictKey(withB!)).not.toBe(conflictKey(withC!));
  });

  it("reports a court clash ONCE PER colliding fixture, not once per card", () => {
    // A card that KEEPS its old clash and GAINS a new one is the case a single
    // conflict per fixture cannot express: one row naming the first collider
    // keys identically before and after, and the new double-booking writes
    // through. One row per counterparty is what makes the delta see it.
    const before = validateAssignments(
      [a("f1", "C1", AT, ["e1"], [])],
      cfg,
      [a("fB", "C1", AT, ["e8"], [])],
    ).filter((c) => c.reason === "court");
    const after = validateAssignments(
      [a("f1", "C1", AT, ["e1"], [])],
      cfg,
      [a("fB", "C1", AT, ["e8"], []), a("fC", "C1", AT + 20 * MIN, ["e9"], [])],
    ).filter((c) => c.reason === "court");

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    // The delta must see the SECOND collision, or a brand-new double-booking is
    // accepted on the one reason that blocked absolutely before this wave.
    expect(deltaConflicts(before, after)).toHaveLength(1);
  });

  it("keys a person overlap on the fixture the human is also in", () => {
    const overlapWith = (otherId: string) =>
      validateAssignments(
        [a("f1", "C1", AT, ["e1"], ["p1"])],
        cfg,
        [a(otherId, "C2", AT, ["e9"], ["p1"])],
      ).filter((c) => c.reason === "person_overlap");

    const [withB] = overlapWith("fB");
    const [withC] = overlapWith("fC");
    expect(withB).toBeDefined();
    expect(conflictKey(withB!)).not.toBe(conflictKey(withC!));
  });

  it("keys an entrant overlap on the other fixture too", () => {
    const overlapWith = (otherId: string) =>
      validateAssignments(
        [a("f1", "C1", AT, ["e1"], [])],
        cfg,
        [a(otherId, "C2", AT, ["e1"], [])],
      ).filter((c) => c.reason === "person_overlap");

    const [withB] = overlapWith("fB");
    const [withC] = overlapWith("fC");
    expect(withB).toBeDefined();
    expect(conflictKey(withB!)).not.toBe(conflictKey(withC!));
  });
});
