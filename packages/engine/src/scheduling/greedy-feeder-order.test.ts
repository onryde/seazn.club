// Greedy must place a fixture AFTER the fixtures that feed it.
//
// `SchedulableFixture.roundNo`'s own doc comment claims the placer schedules
// "in ascending round order (feed dependencies respected)". For a ROUND-ROBIN
// stage that is true. For a BRACKET stage it is not, and the gap is structural:
// apps/web stamps `roundNo` only when the stage is round-robin (C1's ruling —
// a bracket's display numbering must not masquerade as round-robin order), and
// `SlotInput` carried no dependency information at all. So every fixture in a
// knockout stage sorted as `roundNo ?? 0` and the comparator fell through to
// the id tiebreak — a UUID.
//
// When the final's uuid happened to sort first, greedy placed it at the very
// start, before its semis existed on the board, and the order check then
// dropped it: an auto-schedule that returned 2 of 3 fixtures with an
// `order_before_feeder` conflict, roughly one run in three. That is the
// intermittent red on `court-tags-scheduling.spec.ts` in CI.
//
// The ids below are chosen so the final sorts FIRST alphabetically, which is
// exactly the losing half of that coin flip — made deterministic.
import { describe, expect, it } from "vitest";
import {
  slotFixtures,
  validateAssignments,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 21, 9, 0);

const cfg = (over: Partial<SlotConfig> = {}): SlotConfig => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["c-tagged", "c-untagged", "c-spare"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 24 * 60 * MIN },
  ...over,
});

// "a-final" sorts before "b-semi-1"/"b-semi-2" — the bad draw.
const FINAL = "a-final";
const SEMI_1 = "b-semi-1";
const SEMI_2 = "b-semi-2";

const fixtures: SchedulableFixture[] = [
  { id: FINAL, divisionId: "d1" },
  { id: SEMI_1, home: "e1", away: "e2", divisionId: "d1" },
  { id: SEMI_2, home: "e3", away: "e4", divisionId: "d1" },
];

const dependencies = [
  { fixtureId: FINAL, dependsOn: SEMI_1, direct: true },
  { fixtureId: FINAL, dependsOn: SEMI_2, direct: true },
];

describe("slotFixtures places a dependent after its feeders", () => {
  it("does not start the final before both semis have finished, whatever the ids sort like", () => {
    const out = slotFixtures({ fixtures, config: cfg(), dependencies });

    const by = new Map(out.assignments.map((a) => [a.fixtureId, a] as const));
    expect(out.assignments).toHaveLength(3);
    const final = by.get(FINAL)!;
    const semi1 = by.get(SEMI_1)!;
    const semi2 = by.get(SEMI_2)!;
    expect(final.startAt).toBeGreaterThanOrEqual(Math.max(semi1.endAt, semi2.endAt));
  });

  it("produces a board its OWN verifier accepts on the order family", () => {
    // The parity half, and it has to go through `validateAssignments`:
    // `slotFixtures` does not emit `order` conflicts itself, so asserting on
    // its own `conflicts` array passes whether or not the bug is present —
    // vacuous, which is exactly the failure this repo keeps paying for.
    const out = slotFixtures({ fixtures, config: cfg(), dependencies });

    const conflicts = validateAssignments(out.assignments, {
      ...cfg(),
      dependencies,
    } as Parameters<typeof validateAssignments>[1]);

    expect(conflicts.filter((c) => c.reason === "order")).toEqual([]);
  });

  it("still honours roundNo when it is supplied, and needs no dependencies to do so", () => {
    // Round-robin stages keep working exactly as before: this is additive.
    const rr: SchedulableFixture[] = [
      { id: "z-late", roundNo: 2, home: "e1", away: "e2", divisionId: "d1" },
      { id: "a-early", roundNo: 1, home: "e3", away: "e4", divisionId: "d1" },
    ];

    const out = slotFixtures({ fixtures: rr, config: cfg() });

    const by = new Map(out.assignments.map((a) => [a.fixtureId, a] as const));
    expect(by.get("a-early")!.startAt).toBeLessThanOrEqual(by.get("z-late")!.startAt);
  });

  it("does not hang or drop fixtures on a dependency cycle", () => {
    // A cycle cannot arise from a real bracket, but a topological order must
    // degrade to "place them anyway" rather than loop or silently lose a card.
    const cyclic = [
      { fixtureId: SEMI_1, dependsOn: SEMI_2 },
      { fixtureId: SEMI_2, dependsOn: SEMI_1 },
    ];

    const out = slotFixtures({ fixtures, config: cfg(), dependencies: cyclic });

    expect(out.assignments).toHaveLength(3);
  });
});
