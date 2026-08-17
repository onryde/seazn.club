// Decomposed repair (#401) — the graph half.
//
// The wave's lock is "no fixture-count gate: solve the full 500-movable range".
// The solver cannot: the bare feasibility probe does not return in 119 s from
// about 80 movable up. What CAN is freezing all but one interaction component
// into `existing`, solving that component, committing it, and moving on — so
// these tests are first of all tests of the partition, because a partition that
// separates two fixtures which can actually collide is a partition that hands
// the solver a board the verifier then rejects.
import { describe, expect, it } from "vitest";
import type { Assignment, OrderDependency, VerifyConfig } from "./calendar.ts";
import { validateAssignments } from "./calendar.ts";
import {
  dayCapGuard,
  repairComponents,
} from "./repair-decompose.ts";
import { disjointConflictBound } from "./repair-minimality.ts";
import {} from "./repair-synthetic-board.ts";
import {
} from "./solver-test-bounds.ts";




const MIN = 60_000;
const T0 = Date.parse("2026-09-07T09:00:00Z");

const at = (
  id: string,
  court: string,
  offsetMin: number,
  entrants: string[],
  durationMin = 40,
): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + offsetMin * MIN,
  endAt: T0 + (offsetMin + durationMin) * MIN,
  entrants,
  people: entrants.map((e) => `p-${e}`),
});

const cfg = (over: Partial<VerifyConfig> = {}): VerifyConfig & { courts: readonly string[] } => ({
  matchMinutes: 40,
  gapMinutes: 5,
  perEntrantMinRest: 45,
  blackouts: [],
  sessionWindows: [],
  tz: "UTC",
  courts: ["C1", "C2"],
  ...over,
});

const idsOf = (
  proposal: readonly Assignment[],
  dependencies: readonly OrderDependency[] = [],
  config = cfg(),
): string[][] => repairComponents({ proposal, dependencies, config }).map((c) => [...c.fixtureIds]);

describe("repairComponents", () => {
  it("separates fixtures that share neither a court nor a person nor an hour", () => {
    // Different courts, different entrants, and far enough apart that no rest
    // rule could ever reach across.
    const board = [
      at("f1", "C1", 0, ["e1", "e2"]),
      at("f2", "C2", 600, ["e3", "e4"]),
    ];
    expect(idsOf(board)).toEqual([["f1"], ["f2"]]);
  });

  it("joins two fixtures on one court at one time", () => {
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    expect(idsOf(board)).toEqual([["f1", "f2"]]);
  });

  it("joins two fixtures sharing a person even on different courts", () => {
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 0, ["e2", "e3"])];
    expect(idsOf(board)).toEqual([["f1", "f2"]]);
  });

  it("joins a pair that never overlaps but still owes rest", () => {
    // 40-minute matches 50 minutes apart: no overlap at all, and a 45-minute
    // rest the shared entrant is still owed. A graph built on OCCUPANCY overlap
    // alone would cut this edge, hand the two halves to separate solves, and
    // let one of them place a card the verifier scores as a rest breach.
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 50, ["e2", "e3"])];
    expect(idsOf(board)).toEqual([["f1", "f2"]]);
  });

  it("joins fixtures wired by an order dependency however far apart they sit", () => {
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 900, ["e3", "e4"])];
    expect(idsOf(board, [{ fixtureId: "f2", dependsOn: "f1", direct: true }])).toEqual([
      ["f1", "f2"],
    ]);
  });

  it("is transitive: a chain of overlaps is one component", () => {
    const board = [
      at("f1", "C1", 0, ["e1", "e2"]),
      at("f2", "C1", 0, ["e3", "e4"]),
      at("f3", "C2", 0, ["e4", "e5"]),
      at("f4", "C2", 500, ["e9", "e8"]),
    ];
    expect(idsOf(board)).toEqual([["f1", "f2", "f3"], ["f4"]]);
  });

  it("reads the separation from the config, not from a constant", () => {
    // Ten hours apart. Only a rest rule that long can make this an edge, and it
    // has to come from the config the verifier reads.
    const board = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 600, ["e2", "e3"])];
    expect(idsOf(board)).toEqual([["f1"], ["f2"]]);
    expect(idsOf(board, [], cfg({ perEntrantMinRest: 24 * 60 }))).toEqual([["f1", "f2"]]);
  });

  it("orders components and their fixtures by id, whatever order the board came in", () => {
    const board = [
      at("f9", "C1", 300, ["e7", "e8"]),
      at("f2", "C2", 0, ["e3", "e4"]),
      at("f1", "C1", 0, ["e1", "e2"]),
    ];
    const forward = idsOf(board);
    const reversed = idsOf([...board].reverse());
    expect(forward).toEqual([["f1"], ["f2"], ["f9"]]);
    expect(reversed).toEqual(forward);
  });
});

// A board of independent two-card court clashes, each one 10 hours from the
// next: several DIRTY components, each repairable by moving exactly one card,
// and a free court to move it to. Small on purpose — what these tests measure is
// the driver's behaviour, and every one of them pays a WASM boot per component.
const clashBoard = (
  groups: number,
): { proposal: Assignment[]; config: VerifyConfig & { courts: readonly string[] } } => {
  const proposal: Assignment[] = [];
  for (let g = 0; g < groups; g++) {
    const off = g * 600;
    proposal.push(at(`g${g}a`, "C1", off, [`e${g}0`, `e${g}1`]));
    proposal.push(at(`g${g}b`, "C1", off, [`e${g}2`, `e${g}3`]));
  }
  return {
    proposal,
    config: cfg({
      window: { from: T0 - 60 * MIN, to: T0 + (groups * 600 + 120) * MIN },
    }),
  };
};

describe("the max_fixtures_per_day guard", () => {
  // Three cards on one calendar day under a 2/day cap, split across two
  // components: `A` alone in the morning, `B`+`C` back to back in the evening.
  // `A` and `B` are NOT in `ruleFixtures`.
  //
  // That is the whole bug. `assertDayCap` filters `existing` by
  // `fixtureById.has()` — an outside booking is not a fixture and counting one
  // would invent a cap breach out of a blackout — so the moment an unindexed
  // PROPOSAL card is frozen it becomes invisible to the cap. Solving `B`+`C`
  // with `A` frozen counts one card on the day; solving `A` with `B`+`C` frozen
  // counts one; the whole-board verifier counts three and rejects the board the
  // solver called repaired. Fourth instance of this wave's dominant bug class:
  // an encoder unit that is not the verifier's unit.
  const cappedBoard = (
    knownIds: readonly string[],
  ): { proposal: Assignment[]; config: VerifyConfig & { courts: readonly string[] } } => ({
    proposal: [
      at("a", "C1", 0, ["e1", "e2"]),
      at("b", "C1", 540, ["e3", "e4"]),
      at("c", "C1", 590, ["e5", "e6"]),
    ],
    config: cfg({
      window: { from: T0 - 60 * MIN, to: T0 + (2 * 1440 + 600) * MIN },
      hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
      ruleFixtures: knownIds.map((id) => ({ id, extKey: null, winnerTo: null })),
    }),
  });

  it("splits the board when every movable fixture is one the cap can see", () => {
    const { proposal, config } = cappedBoard(["a", "b", "c"]);
    expect(repairComponents({ proposal, config })).toHaveLength(2);
  });

  /**
   * DIRECT tests for the guard, added in C8.
   *
   * Every case below used to reach `dayCapGuard` through `repairDecomposed`,
   * the z3 driver — so when C8 deleted that driver the guard's ONLY coverage
   * went with it, silently: the assertions that remained were about
   * `repairComponents`, and they pass whether or not the guard works. The
   * guard itself is pure and solver-agnostic (it reads the hard rules and the
   * fixture index, nothing else), and `repair-decompose-cpsat.ts` calls it on
   * the production path, so it is worth testing on its own terms rather than
   * through whichever driver happens to exist.
   */
  it("declines to decompose when a movable fixture is invisible to the cap", () => {
    const { proposal, config } = cappedBoard(["c"]);
    // Two components by the graph — and solving them apart is exactly what
    // must not happen here: each half would count one card against a cap the
    // whole board breaches with three.
    expect(repairComponents({ proposal, config })).toHaveLength(2);
    expect(dayCapGuard(proposal, config)).toBe("day_cap_unindexed_fixtures");
  });

  it("allows decomposition when the cap can see every movable fixture", () => {
    const { proposal, config } = cappedBoard(["a", "b", "c"]);
    expect(dayCapGuard(proposal, config)).toBeNull();
  });

  it("allows decomposition when there is no per-day cap at all", () => {
    const { proposal } = cappedBoard([]);
    // Same board, same empty fixture index — only the rule is gone. Without
    // this case the assertion above passes for a guard that returns its
    // refusal unconditionally.
    const noCap = cfg({
      window: { from: T0 - 60 * MIN, to: T0 + (2 * 1440 + 600) * MIN },
      hard: [],
      ruleFixtures: [],
    });
    expect(dayCapGuard(proposal, noCap)).toBeNull();
  });

});

describe("disjointConflictBound", () => {
  // The certificate on its own, without a solver in the way. What it must never
  // do is over-count: a bound larger than the true minimum turns an honest
  // "upper_bound" into a false "proved", which is the only way this file can
  // lie.
  it("counts one move per clash when the clashes share no fixture", () => {
    const { proposal, config } = clashBoard(2);
    const bound = disjointConflictBound({
      proposal,
      config,
      conflicts: validateAssignments(proposal, config),
    });
    expect(bound.lowerBound).toBe(2);
    expect(bound.witnesses.map((w) => [...w.fixtureIds])).toEqual([
      ["g0a", "g0b"],
      ["g1a", "g1b"],
    ]);
    expect(bound.unattributed).toBe(0);
  });

  it("never counts one card twice, even when it is in several conflicts", () => {
    // Three cards on one court at one time. Six conflict rows, three pairs, and
    // every pair shares a fixture with both others — so the disjoint set holds
    // exactly one. Two moves are actually needed here, which is the point: this
    // is a LOWER bound, and a weak lower bound is honest where an inflated one
    // would certify a repair that moved one card too many.
    const proposal = [
      at("a", "C1", 0, ["e1", "e2"]),
      at("b", "C1", 0, ["e3", "e4"]),
      at("c", "C1", 0, ["e5", "e6"]),
    ];
    const config = cfg();
    expect(validateAssignments(proposal, config).length).toBeGreaterThan(1);
    expect(disjointConflictBound({ proposal, config, conflicts: validateAssignments(proposal, config) }).lowerBound).toBe(1);
  });

  it("still counts a clash whose counterparty cannot be moved", () => {
    const movable = [at("a", "C1", 0, ["e1", "e2"])];
    const immovable = [at("z", "C1", 0, ["e3", "e4"])];
    const config = cfg();
    const bound = disjointConflictBound({
      proposal: movable,
      existing: immovable,
      config,
      conflicts: validateAssignments(movable, config, immovable),
    });
    // One move, and it has to be `a` — the witness names only what can move.
    expect(bound.lowerBound).toBe(1);
    expect(bound.witnesses[0]?.fixtureIds).toEqual(["a"]);
  });

  it("proves nothing from a per-day cap, and says how many rows it could not use", () => {
    // A cap row names one card and its detail carries the whole DAY's total, so
    // no one- or two-card sub-board reproduces it. Left out of the bound rather
    // than guessed at: three cards on a day are not three independent moves.
    const proposal = [
      at("a", "C1", 0, ["e1", "e2"]),
      at("b", "C1", 540, ["e3", "e4"]),
      at("c", "C1", 590, ["e5", "e6"]),
    ];
    const config = cfg({
      hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "competition" } }],
      ruleFixtures: ["a", "b", "c"].map((id) => ({ id, extKey: null, winnerTo: null })),
    });
    const conflicts = validateAssignments(proposal, config);
    expect(conflicts).toHaveLength(3);
    const bound = disjointConflictBound({ proposal, config, conflicts });
    expect(bound.lowerBound).toBe(0);
    expect(bound.unattributed).toBe(3);
  });
});

