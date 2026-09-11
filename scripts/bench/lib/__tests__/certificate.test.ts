// certificate.test.ts — the §6.3 protocol, and above all its ORDER.
//
// The suite's contract with itself: every case below states the mutation that
// reds it, and the three ORDER cases exist because nothing else can see the
// difference. A `certify` that read `solverStatus` before running history
// through the checker, or one that read the unplaced counts before the solver
// status, passes every single-branch case in this file and fails only the
// pair that holds two inputs fixed and flips the third.
//
// That third pair is the one ruling R27 turns on, so read it before changing
// it: with the solver at `infeasible`, `placed < total` is a consequence of
// the infeasibility, and the certificate must name the cause (PRODUCT_DEFECT)
// rather than the symptom (UNPLACED).
//
// The history boards are `cleanBoard()` from `_board-fixtures.ts`, perturbed
// by exactly one thing — the SAME hand-built board `checker.test.ts` uses,
// because the claim this module makes is that the rules judging history are
// the rules that judged the product's board. Building a second fixture family
// for history would let the two drift apart quietly.

import { describe, expect, it } from "vitest";
import { certify } from "../certificate.ts";
import type { Board, CertificateBranch } from "../board.ts";
import type { PackHistoricalAssignment } from "../pack-schema.ts";
import {
  cleanBoard,
  cleanConstraints,
  COURT_1,
  COURT_2,
  DIVISION_REF,
  MON,
  movedTo,
} from "./_board-fixtures.ts";

type CertifyInput = Parameters<typeof certify>[0];

/** What the pack declared about where the real tournament actually played.
 *
 *  Three rows for the clean board's three fixtures. `venue` is the real
 *  world's free text (`pack-schema.ts:838`), not a pack ref. */
function historyRows(divisionRef: string = DIVISION_REF): PackHistoricalAssignment[] {
  return [
    {
      divisionRef,
      fixtureExtKey: "r1-a",
      venue: "Lord's Cricket Ground",
      startsAt: "2027-06-07T09:00:00+01:00",
    },
    {
      divisionRef,
      fixtureExtKey: "r1-b",
      venue: "Lord's Cricket Ground",
      court: "Nursery Ground",
      startsAt: "2027-06-07T09:00:00+01:00",
    },
    {
      divisionRef,
      fixtureExtKey: "r2-a",
      venue: "Lord's Cricket Ground",
      startsAt: "2027-06-07T11:00:00+01:00",
      endsAt: "2027-06-07T11:30:00+01:00",
    },
  ];
}

/** The FEASIBLE case, which every other case perturbs by one field. Declared
 *  once so a case that means to move the solver status cannot also move the
 *  history, which is the whole thing the order cases are measuring. */
function input(patch: Partial<CertifyInput> = {}): CertifyInput {
  return {
    historical: historyRows(),
    historyBoard: cleanBoard(),
    constraints: cleanConstraints(),
    solverStatus: "ok",
    placed: 3,
    total: 3,
    ...patch,
  };
}

/** History that double-books `court-1`: `fx-1` moved onto `fx-0`'s court at
 *  `fx-0`'s instant. One perturbation, one finding. */
function doubleBookedHistory(): Board {
  const b = cleanBoard();
  const fixtures = [...b.fixtures];
  fixtures[1] = {
    ...fixtures[1],
    courtId: fixtures[0].courtId,
    start: fixtures[0].start,
    end: fixtures[0].end,
  };
  return { ...b, fixtures };
}

/** `ScheduleSolverInfo.status`' full vocabulary
 *  (`apps/web/src/server/api-v1/schemas.ts:1731-1770`), minus `infeasible`.
 *  Enumerated rather than sampled: one lucky status is not a parity sweep,
 *  and a `!==`-shaped inversion of the product-defect test passes on any
 *  single one of them. */
const NON_INFEASIBLE_STATUSES: readonly string[] = [
  "ok",
  "already_optimal",
  "verifier_rejected",
  "solver_busy",
  "not_searched",
  "solver_unavailable",
];

describe("certify — branch 1, SKIPPED_NO_HISTORY", () => {
  it("SKIPPED_NO_HISTORY when the pack declares none, and never reds", () => {
    const v = certify(input({ historical: undefined, historyBoard: undefined }));
    expect(v.branch).toBe("SKIPPED_NO_HISTORY");
    expect(v.red).toBe(false);
    expect(v.reason).toMatch(/no historicalAssignment/i);
    expect(v.violations).toEqual([]);
  });

  // An EMPTY array is a declaration of nothing, not a clean timetable. Running
  // it through `checkBoard` would report `clean` having measured zero rows —
  // the vacuous-clean class design §1.4 exists to prevent — and the resulting
  // FEASIBLE would assert history satisfies the encoding on no evidence.
  it("SKIPPED_NO_HISTORY on an EMPTY array, which is not a clean history", () => {
    const v = certify(input({ historical: [], historyBoard: undefined }));
    expect(v.branch).toBe("SKIPPED_NO_HISTORY");
    expect(v.red).toBe(false);
  });

  // The rows carry their own `divisionRef` and so do the constraints, so a
  // caller may hand over the whole pack's list. A certificate that skipped the
  // filter would judge ANOTHER division's timetable against this division's
  // encoding and file the resulting breach as this pack's authoring bug.
  it("SKIPPED_NO_HISTORY when every row names ANOTHER division", () => {
    const v = certify(
      input({ historical: historyRows("d-somewhere-else"), historyBoard: undefined }),
    );
    expect(v.branch).toBe("SKIPPED_NO_HISTORY");
    expect(v.red).toBe(false);
  });

  it("certifies on the rows for THIS division when the list mixes divisions", () => {
    const mixed = [...historyRows("d-somewhere-else"), ...historyRows()];
    const v = certify(input({ historical: mixed, historyBoard: doubleBookedHistory() }));
    expect(v.branch).toBe("PACK_AUTHORING_BUG");
  });
});

describe("certify — the wiring guards", () => {
  // A division that DECLARES history and arrives with no board rendered is a
  // bench wiring fault. Reporting SKIPPED_NO_HISTORY for it would turn a
  // forgotten render into a permanently green certificate — an absent symptom
  // that means suppressed, not safe.
  it("throws when history is declared but no board was rendered", () => {
    expect(() => certify(input({ historyBoard: undefined }))).toThrow(
      /declares 3 historicalAssignment row/i,
    );
  });

  // `checkBoard` SKIPS unplaced fixtures by design (checker.ts convention 2),
  // so a board whose fixtures carry no `start` is reported clean having
  // measured nothing. Every historical row carries a REQUIRED `startsAt`
  // (`pack-schema.ts:844`), so a board with no placed fixture cannot be a
  // faithful rendering of one.
  it("throws when the rendered history board carries no PLACED fixture", () => {
    const b = cleanBoard();
    const unplaced: Board = {
      ...b,
      fixtures: b.fixtures.map((f) => ({ ...f, start: undefined, end: undefined })),
    };
    expect(() => certify(input({ historyBoard: unplaced }))).toThrow(/no placed fixture/i);
  });

  // I1. `checkBoard` skips a fixture whose `start` is a NaN as well as one
  // whose `start` is absent (`checker.ts:182` — `typeof` AND `Number.isFinite`,
  // because a NaN compares false against every bound and would make every
  // containment rule pass vacuously). A weaker predicate here lets that
  // fixture count as rendered, the checker then skips it, and the certificate
  // reports a clean history it never examined.
  //
  // Reds on its own under an I1-only regression: with `Number.isFinite`
  // dropped, `fx-0` counts as placed, coverage is satisfied, and this
  // certifies FEASIBLE instead of throwing.
  it("counts a NaN start as UNPLACED, exactly as checkBoard does", () => {
    const b = cleanBoard();
    const naN: Board = {
      ...b,
      fixtures: b.fixtures.map((f, i) =>
        i === 0 ? { ...f, start: Number.NaN, end: Number.NaN } : f,
      ),
    };
    // `r1-a` is `fx-0`'s extKey — the row the checker would silently skip.
    expect(() => certify(input({ historyBoard: naN }))).toThrow(/r1-a/);
  });

  // I2. The rows are filtered on `constraints.divisionRef`; taking the BOARD's
  // on trust in the same function would read as a decision rather than an
  // omission. Neither `checkBoard` nor this module can otherwise notice the
  // mispairing — every finding is attributed to `constraints.divisionRef`
  // regardless of which board produced it.
  it("refuses a history board rendered for ANOTHER division", () => {
    const foreign: Board = { ...cleanBoard(), divisionRef: "d-somewhere-else" };
    const run = () => certify(input({ historyBoard: foreign }));
    expect(run).toThrow(/d-somewhere-else/);
    expect(run).toThrow(new RegExp(DIVISION_REF));
  });

  // I3. The sharpest of the three, because it needs no malformed data — just
  // an incomplete render. A board carrying ONE of three declared rows passes
  // any "is there at least one placed fixture" test, and the checker then
  // reports clean having measured a third of the timetable.
  //
  // Reds on its own under an I3-only regression (coverage weakened back to
  // `some`): `fx-0` is placed, so nothing throws and this certifies FEASIBLE.
  it("throws when the render is PARTIAL — one of three declared rows placed", () => {
    const b = cleanBoard();
    const partial: Board = { ...b, fixtures: [b.fixtures[0]] };
    const run = () => certify(input({ historyBoard: partial }));
    expect(run).toThrow(/r1-b/);
    expect(run).toThrow(/r2-a/);
    // …and names how many of how many, so the reader is not left counting.
    expect(run).toThrow(/2 of 3/);
  });

  // I4 (finding R03). The ONLY hole in this module that produced a wrong
  // POSITIVE verdict rather than a missing one — the certificate actively
  // asserting the product is fine on counts it could not read.
  //
  // `input.placed < input.total` is `false` when EITHER side is `NaN`, so a
  // non-finite pair sailed past branch 4 and landed on FEASIBLE: "the product
  // placed all NaN fixtures". Reachability is not theoretical — R28 leaves
  // `ScheduleOutcome.metrics` optional, so a caller deriving these from a
  // solver that never answered is one `Number()` away from a NaN, and this
  // repo has already been bitten by `Number()` serving a finite 0 where a
  // fallback was intended.
  //
  // Enumerated rather than sampled: `NaN` reaches FEASIBLE through the
  // comparison being false, `Infinity` as `total` through a different route
  // (`3 < Infinity` is TRUE, so it reaches UNPLACED and reports a shortfall
  // against an unbounded total), and a negative `total` through the same
  // false comparison as NaN. One sample cannot witness all three.
  it("REFUSES non-finite or nonsensical counts rather than certifying FEASIBLE", () => {
    for (const patch of [
      { placed: Number.NaN, total: 3 },
      { placed: 3, total: Number.NaN },
      { placed: Number.NaN, total: Number.NaN },
      { placed: Number.POSITIVE_INFINITY, total: 3 },
      { placed: 3, total: Number.POSITIVE_INFINITY },
      { placed: 1.5, total: 3 },
      { placed: 3, total: -1 },
    ]) {
      const run = () => certify(input(patch));
      expect(run).toThrow(/placed.*total|counts/i);
      // A WIRING fault, named as one. The five branches are a closed protocol
      // about the pack and the product, and an unreadable count is a fact
      // about neither — the same reasoning the two guards above already use.
      expect(run).toThrow(/wiring/i);
    }
  });

  // The positive pair. Without it the guard could refuse EVERYTHING and the
  // case above would still pass — and a zero-fixture division is exactly the
  // legal input a careless `> 0` guard would reject.
  it("accepts finite counts, including a legitimate zero", () => {
    expect(certify(input({ placed: 0, total: 0 })).branch).toBe("FEASIBLE");
    expect(certify(input({ placed: 0, total: 3 })).branch).toBe("UNPLACED");
  });
});

// B06b — a published timetable can genuinely contradict itself. Suite 11's
// sources put two matches on one board at overlapping times, agreed by three
// independent feeds, and no `matchMinutes` reconciles that: any width above
// the gap reports it and any width below is shorter than every real match,
// which would make the whole check vacuous. A breach landing ONLY on rows the
// pack declared gets its own branch and does not gate.
describe("certify — HISTORY_SELF_CONFLICT, the declared-source-conflict branch", () => {
  /** Both fixtures of the double-booking, declared. `doubleBookedHistory()`
   *  moves `fx-1` (`r1-b`) onto `fx-0`'s (`r1-a`) court and instant, so the
   *  finding names both and both must be declared. */
  const bothDeclared = (): PackHistoricalAssignment[] =>
    historyRows().map((row) =>
      row.fixtureExtKey === "r1-a" || row.fixtureExtKey === "r1-b"
        ? { ...row, knownConflict: "three independent feeds agree the real timetable double-books this board" }
        : row,
    );

  it("reports without gating when every breach lands on a declared row", () => {
    const v = certify(input({ historical: bothDeclared(), historyBoard: doubleBookedHistory() }));

    expect(v.branch).toBe("HISTORY_SELF_CONFLICT");
    expect(v.red).toBe(false);
    // The reason carries the pack's own words, so a reader is not left to
    // guess why a breach was waived.
    expect(v.reason).toMatch(/three independent feeds/);
    // And the findings are still REPORTED — waived is not hidden.
    expect(v.violations.length).toBeGreaterThan(0);
  });

  it("STILL reds when even one fixture of the breach is undeclared", () => {
    // The positive pair, and the whole reason the declaration is per-ROW: an
    // exemption spread over breaches nobody looked at is a disarmed gate.
    const onlyOne = historyRows().map((row) =>
      row.fixtureExtKey === "r1-a" ? { ...row, knownConflict: "half the story" } : row,
    );

    const v = certify(input({ historical: onlyOne, historyBoard: doubleBookedHistory() }));

    expect(v.branch).toBe("PACK_AUTHORING_BUG");
    expect(v.red).toBe(true);
  });

  it("is unreachable for a pack that declares nothing — the old behaviour, unchanged", () => {
    const v = certify(input({ historyBoard: doubleBookedHistory() }));

    expect(v.branch).toBe("PACK_AUTHORING_BUG");
    expect(v.red).toBe(true);
  });

  it("does not fire on a CLEAN history that happens to carry a declaration", () => {
    // A declaration is permission for a breach that occurs, never an assertion
    // that one must. A clean board certifies FEASIBLE regardless.
    const v = certify(input({ historical: bothDeclared() }));

    expect(v.branch).toBe("FEASIBLE");
    expect(v.red).toBe(false);
  });
});

describe("certify — branch 2, PACK_AUTHORING_BUG", () => {
  it("PACK_AUTHORING_BUG when the REAL timetable violates our own encoding", () => {
    const v = certify(input({ historyBoard: doubleBookedHistory(), solverStatus: "infeasible" }));
    expect(v.branch).toBe("PACK_AUTHORING_BUG");
    expect(v.red).toBe(true);
  });

  it("carries the history's own findings as `violations`, both fixtures named", () => {
    const v = certify(input({ historyBoard: doubleBookedHistory() }));
    expect(v.violations.map((f) => f.kind)).toEqual(["court_double_booking"]);
    expect([...v.violations[0].fixtureIds].sort()).toEqual(["fx-0", "fx-1"]);
    expect(v.violations[0].divisionRef).toBe(DIVISION_REF);
  });

  it("says fix the PACK, not the solver, and names the kinds it found", () => {
    const v = certify(input({ historyBoard: doubleBookedHistory() }));
    expect(v.reason).toMatch(/court_double_booking/);
    expect(v.reason).toMatch(/pack/i);
  });

  // The differential that proves `checkBoard` itself is what ran, rather than
  // a parallel implementation that happens to agree on double-bookings:
  // `court-1` closes at 14:00 and `court-2` at 20:00, so the SAME instant is a
  // breach on one court and clean on the other. A re-implementation that
  // unioned every court's hours calls both clean.
  it("runs the checker's own PER-COURT hours: 14:00 breaches court-1, not court-2", () => {
    const onCourt1 = certify(input({ historyBoard: movedTo(cleanBoard(), 2, MON, "14:00") }));
    expect(onCourt1.branch).toBe("PACK_AUTHORING_BUG");
    expect(onCourt1.violations.map((f) => f.kind)).toEqual(["outside_court_hours"]);

    const onCourt2 = certify(
      input({ historyBoard: movedTo(cleanBoard(), 2, MON, "14:00", COURT_2) }),
    );
    expect(onCourt2.branch).toBe("FEASIBLE");
    expect(onCourt2.violations).toEqual([]);
  });

  // `unchecked` is `constraints.unmodelled` forwarded and NEVER makes a report
  // dirty (board.ts's `CheckerReport` note). A certificate that read the list
  // instead of `clean` would file a pack-authoring bug against every pack that
  // declared a knob this build does not model — which is most of them.
  it("an UNMODELLED knob never makes history dirty", () => {
    const constraints = {
      ...cleanConstraints(),
      unmodelled: [{ type: "gapMinutes", reason: "not modelled by the bench checker" }],
    };
    const v = certify(input({ constraints }));
    expect(v.branch).toBe("FEASIBLE");
    expect(v.red).toBe(false);
  });
});

describe("certify — the branch ORDER is the protocol", () => {
  // History before the solver verdict. Identical inputs except the legality of
  // the real timetable; a `certify` that tested `solverStatus === "infeasible"`
  // first answers PRODUCT_DEFECT to both and files a pack-authoring bug
  // against the solver.
  it("reads history BEFORE the solver verdict", () => {
    const bad = certify(
      input({ historyBoard: doubleBookedHistory(), solverStatus: "infeasible" }),
    );
    const good = certify(input({ historyBoard: cleanBoard(), solverStatus: "infeasible" }));
    expect(bad.branch).toBe("PACK_AUTHORING_BUG");
    expect(good.branch).toBe("PRODUCT_DEFECT");
  });

  // THE case that separates two shippable behaviours, and the only one in the
  // suite that can (ruling R27). When the solver has declared `infeasible`,
  // `placed < total` is a CONSEQUENCE of it: UNPLACED would name the symptom
  // where PRODUCT_DEFECT names the cause. Swapping branches 3 and 4 leaves
  // every single-branch case in this file green and reds only this one, so
  // it is what pins which of the two orders actually shipped.
  //
  // The pair also proves the gate is not simply dead: with the SAME counts and
  // a non-infeasible status it does fire, and lands on UNPLACED.
  it("reads the solver verdict BEFORE the unplaced counts", () => {
    const declared = certify(input({ solverStatus: "infeasible", placed: 2, total: 3 }));
    const silent = certify(input({ solverStatus: "not_searched", placed: 2, total: 3 }));
    expect(declared.branch).toBe("PRODUCT_DEFECT");
    expect(silent.branch).toBe("UNPLACED");
  });

  // …and history before both of them, so a pack whose own timetable breaches
  // the encoding is never reported as the product failing to place.
  it("reads history BEFORE the unplaced counts", () => {
    const v = certify(
      input({ historyBoard: doubleBookedHistory(), solverStatus: "ok", placed: 2, total: 3 }),
    );
    expect(v.branch).toBe("PACK_AUTHORING_BUG");
  });
});

describe("certify — branch 3, PRODUCT_DEFECT", () => {
  it("PRODUCT_DEFECT reds", () => {
    const v = certify(input({ solverStatus: "infeasible" }));
    expect(v.branch).toBe("PRODUCT_DEFECT");
    expect(v.red).toBe(true);
    expect(v.violations).toEqual([]);
  });

  it("names the solver status and says history satisfied the encoding", () => {
    const v = certify(input({ solverStatus: "infeasible" }));
    expect(v.reason).toMatch(/infeasible/);
    expect(v.reason).toMatch(/satisf/i);
  });

  it("no OTHER solver status reads as a product defect", () => {
    for (const status of NON_INFEASIBLE_STATUSES) {
      const v = certify(input({ solverStatus: status }));
      expect(v.branch, status).toBe("FEASIBLE");
      expect(v.red, status).toBe(false);
    }
    const absent = certify(input({ solverStatus: undefined }));
    expect(absent.branch).toBe("FEASIBLE");
    expect(absent.red).toBe(false);
  });
});

describe("certify — branch 4, UNPLACED", () => {
  it("UNPLACED when placed < total and the solver never declared infeasible", () => {
    const v = certify(input({ solverStatus: "ok", placed: 2, total: 3 }));
    expect(v.branch).toBe("UNPLACED");
    expect(v.red).toBe(true);
    expect(v.reason).toMatch(/2 of 3/);
    expect(v.violations).toEqual([]);
  });

  // `<`, not `!==`: a board that placed MORE rows than the proposal counted is
  // not an unplaced-fixture defect, and reporting one would send a reader
  // hunting for a fixture that is on the board.
  it("does not red when placed exceeds total", () => {
    const v = certify(input({ solverStatus: "ok", placed: 4, total: 3 }));
    expect(v.branch).toBe("FEASIBLE");
    expect(v.red).toBe(false);
  });
});

describe("certify — branch 5, FEASIBLE", () => {
  it("FEASIBLE when history is clean and a full board was produced", () => {
    const v = certify(input());
    expect(v.branch).toBe("FEASIBLE");
    expect(v.red).toBe(false);
    expect(v.violations).toEqual([]);
  });

  it("is pure — the same input twice gives the same verdict", () => {
    const first = certify(input({ historyBoard: doubleBookedHistory() }));
    const second = certify(input({ historyBoard: doubleBookedHistory() }));
    expect(second).toEqual(first);
  });
});

describe("certify — redness is a property of the branch", () => {
  // `red` is looked up from the branch, never computed beside it, so a verdict
  // that reds without a branch to explain it is unrepresentable. Pinned as a
  // table so a branch whose redness silently flipped reds here rather than in
  // whichever consumer noticed first.
  const expected: Readonly<Record<CertificateBranch, boolean>> = {
    SKIPPED_NO_HISTORY: false,
    PACK_AUTHORING_BUG: true,
    PRODUCT_DEFECT: true,
    UNPLACED: true,
    FEASIBLE: false,
  };

  const cases: readonly { branch: CertificateBranch; call: () => CertifyInput }[] = [
    { branch: "SKIPPED_NO_HISTORY", call: () => input({ historical: [], historyBoard: undefined }) },
    { branch: "PACK_AUTHORING_BUG", call: () => input({ historyBoard: doubleBookedHistory() }) },
    { branch: "PRODUCT_DEFECT", call: () => input({ solverStatus: "infeasible" }) },
    { branch: "UNPLACED", call: () => input({ placed: 1, total: 3 }) },
    { branch: "FEASIBLE", call: () => input() },
  ];

  it("every branch is reachable, and each reds exactly as the protocol says", () => {
    const seen = new Set<CertificateBranch>();
    for (const c of cases) {
      const v = certify(c.call());
      expect(v.branch).toBe(c.branch);
      expect(v.red, c.branch).toBe(expected[c.branch]);
      // Every reason is a sentence fragment `judgeDivision` concatenates after
      // an em dash, so an empty one renders as a dangling dash in the report.
      expect(v.reason.length, c.branch).toBeGreaterThan(0);
      seen.add(v.branch);
    }
    expect(seen.size).toBe(cases.length);
  });

  it("the clean board's only court is one of the two the pack declared", () => {
    // Guards the fixture family itself: every case above leans on `court-1`
    // being narrower than `court-2`, and a fixture edit that moved both onto
    // one court would quietly make the per-court differential vacuous.
    expect(cleanConstraints().courtIds).toEqual([COURT_1, COURT_2]);
  });
});
