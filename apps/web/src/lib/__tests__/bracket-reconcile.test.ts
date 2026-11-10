// W4 app-A Task 8 (FX-G2; spec 2026-11-04 §6.5): the shared position-keyed reconcile's PURE half — the planner that says
// whether a Generate over a bracket that already has lines changes nothing, places and vacates in place, or regenerates,
// and RB4-L4's choice of which bye a newcomer takes. The DB half (the surgeries and the driver) is
// server/usecases/__tests__/bracket-reconcile.test.ts.
//
// Expected values: a bracket's role keys come from the ENGINE's own bracket (`engineBracketRows`, pre-flight R9); the
// bye choice from the shared RB4-L4 oracle (`rb4-l4-oracle.ts`, controller ruling 3), never from the code under test.
import { describe, expect, it } from "vitest";
import {
  KNOCKOUT_IDENTITY,
  chooseByeLine,
  knockoutLines,
  knockoutUpdateDrawOffered,
  planReconcile,
  type LineIdentity,
  type SeatRef,
} from "@/lib/bracket-reconcile";
import { engineBracketRows } from "./engine-bracket-rows";
import { engineLineDrawPosition, rb4L4ExpectedLine, type StoredByeLine } from "./rb4-l4-oracle";

interface Toy {
  id: string;
  k: string;
}
const TOY: LineIdentity<Toy> = { key: (l) => l.k };
const toys = (...keys: string[]): Toy[] => keys.map((k, i) => ({ id: `l${i}`, k }));
const roster = (active: string[], seated: [string, SeatRef][]) => ({ active: new Set(active), seated: new Map(seated) });
const seat = (lineId: string, s: "home" | "away"): SeatRef => ({ lineId, seat: s });

describe("planReconcile (toy identity)", () => {
  const ids = { existing: TOY, fresh: TOY };
  it("equal key sets and an equal roster: noop", () => {
    expect(planReconcile(toys("a", "b"), toys("b", "a"), ids, roster(["x", "y"], [["x", seat("l0", "home")], ["y", seat("l0", "away")]]))).toEqual({
      kind: "noop",
    });
  });
  it("equal key sets, a newcomer: in place, the newcomer to place", () => {
    expect(planReconcile(toys("a"), toys("a"), ids, roster(["x", "y", "z"], [["x", seat("l0", "home")], ["y", seat("l0", "away")]]))).toEqual({
      kind: "in_place",
      place: ["z"],
      vacate: [],
    });
  });
  it("equal key sets, a seated entrant no longer active: in place, that seat to vacate", () => {
    expect(planReconcile(toys("a"), toys("a"), ids, roster(["x"], [["x", seat("l0", "home")], ["y", seat("l0", "away")]]))).toEqual({
      kind: "in_place",
      place: [],
      vacate: [seat("l0", "away")],
    });
  });
  it("both at once, newcomers in the roster's own order (the draw's)", () => {
    expect(
      planReconcile(toys("a", "b"), toys("a", "b"), ids, roster(["w", "x", "v"], [["x", seat("l0", "home")], ["y", seat("l1", "away")]])),
    ).toEqual({ kind: "in_place", place: ["w", "v"], vacate: [seat("l1", "away")] });
  });
  it("a fresh set that grows, shrinks or differs: regenerate (the shape moved)", () => {
    const r = roster(["x"], [["x", seat("l0", "home")]]);
    let checked = 0;
    for (const [before, after] of [
      [["a"], ["a", "b"]],
      [["a", "b"], ["a"]],
      [["a", "b"], ["a", "c"]],
      [[], ["a"]],
    ] as const) {
      expect(planReconcile(toys(...before), toys(...after), ids, r), `${before} → ${after}`).toEqual({ kind: "regenerate" });
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("a repeated key on either side is no identity: regenerate, never a guess", () => {
    const r = roster(["x"], [["x", seat("l0", "home")]]);
    expect(planReconcile(toys("a", "a"), toys("a"), ids, r)).toEqual({ kind: "regenerate" });
    expect(planReconcile(toys("a"), toys("a", "a"), ids, r)).toEqual({ kind: "regenerate" });
  });
});

describe("planReconcile (KNOCKOUT_IDENTITY over the engine's brackets)", () => {
  const ids = { existing: KNOCKOUT_IDENTITY, fresh: KNOCKOUT_IDENTITY };
  const lines = (n: number, thirdPlace: boolean) => knockoutLines(engineBracketRows(n, thirdPlace));
  const unchanged = roster(["x"], [["x", seat("l0", "home")]]);
  it("within a power of two the role keys agree (6 → 7, 7 → 6, 5 → 8), across one they do not (8 → 9, 9 → 8, 4 → 5), with or without a third place", () => {
    let checked = 0;
    let refused = 0;
    for (const thirdPlace of [false, true]) {
      for (const [from, to, same] of [
        [6, 7, true],
        [7, 6, true],
        [5, 8, true],
        [8, 9, false],
        [9, 8, false],
        [4, 5, false],
        [3, 2, false],
      ] as const) {
        // Engine 5.0.0 (X-TP-5): a third place needs two real semi-finals, so [3, 2] has none to draw with it - the engine
        // refuses (asserted below), and that pair is checked without a third place only.
        if (thirdPlace && (from < 4 || to < 4)) {
          refused++;
          continue;
        }
        // The premise, from the engine: the same size ⇔ the same number of lines.
        expect(lines(from, thirdPlace).length === lines(to, thirdPlace).length, `premise ${from} → ${to}`).toBe(same);
        const plan = planReconcile(lines(from, thirdPlace), lines(to, thirdPlace), ids, unchanged);
        expect(plan.kind, `${from} → ${to} third place ${thirdPlace}`).toBe(same ? "noop" : "regenerate");
        checked++;
      }
    }
    expect(checked).toBe(13);
    expect(refused, "anti-vacuity: the pair a third place cannot be drawn for was reached").toBe(1);
    for (const n of [2, 3]) {
      expect(() => engineBracketRows(n, true), `${n} entrants with a third place`).toThrow(/two real semi-finals/);
    }
  });
  it("knockoutLines keys each side against its own final, and an empty side is empty", () => {
    expect(knockoutLines([])).toEqual([]);
    const eight = knockoutLines(engineBracketRows(8, true));
    const final = eight.find((l) => KNOCKOUT_IDENTITY.key(l) === ":0:1");
    expect(final?.ext_key, "the final's role key is the engine's final").toBe(engineBracketRows(8, true).find((r) => r.isFinal)!.ext_key);
    expect(eight.filter((l) => KNOCKOUT_IDENTITY.key(l) === ":3p").length).toBe(1);
  });
});

describe("chooseByeLine — RB4-L4 (the lowest-seeded holder's bye, ties by the later draw position)", () => {
  /** The candidates as the server reads them, the draw position from the engine (the oracle's own reader). */
  const candidates = (size: number, lines: StoredByeLine[]) =>
    lines.map((l) => ({ lineId: l.lineId, holderId: l.holderId, drawPosition: engineLineDrawPosition(size, l.seq) }));

  it("two unseeded holders: the LATER draw position — not the first bye (the differential case)", () => {
    // A field of six in a bracket of eight: the byes sit on round-1 lines 1 and 4 (the engine's fold).
    const stored: StoredByeLine[] = [
      { lineId: "L1", holderId: "a", seq: 1 },
      { lineId: "L4", holderId: "b", seq: 4 },
    ];
    const seeds = new Map<string, number | null>([["a", null], ["b", null]]);
    const want = rb4L4ExpectedLine(stored, seeds, 4);
    expect(want, "premise: the oracle's answer is not the first bye").toBe("L4");
    expect(chooseByeLine(candidates(8, stored), seeds)).toBe(want);
  });

  it("a seeded and an unseeded holder: the unseeded one's line, whatever the draw position", () => {
    const stored: StoredByeLine[] = [
      { lineId: "L1", holderId: "a", seq: 1 },
      { lineId: "L4", holderId: "b", seq: 4 },
    ];
    const seeds = new Map<string, number | null>([["a", null], ["b", 2]]);
    const want = rb4L4ExpectedLine(stored, seeds, 4);
    expect(want, "premise: the seed outranks the draw position here").toBe("L1");
    expect(chooseByeLine(candidates(8, stored), seeds)).toBe(want);
  });

  it("two seeded holders: the larger seed number; every shape of a field of five agrees with the oracle", () => {
    let checked = 0;
    const stored: StoredByeLine[] = [
      { lineId: "L1", holderId: "a", seq: 1 },
      { lineId: "L3", holderId: "c", seq: 3 },
      { lineId: "L4", holderId: "b", seq: 4 },
    ];
    for (const seedA of [null, 1, 2, 3])
      for (const seedB of [null, 1, 2, 3])
        for (const seedC of [null, 1, 2, 3]) {
          const seeds = new Map<string, number | null>([["a", seedA], ["b", seedB], ["c", seedC]]);
          expect(chooseByeLine(candidates(8, stored), seeds), JSON.stringify([...seeds])).toBe(rb4L4ExpectedLine(stored, seeds, 4));
          checked++;
        }
    expect(checked, "anti-vacuity: seed combinations judged").toBe(64);
  });

  it("no bye line left: null; a holder with no seed given is refused by name (a caller's bug, never a guess)", () => {
    expect(chooseByeLine([], new Map())).toBeNull();
    expect(() => chooseByeLine([{ lineId: "L1", holderId: "ghost", drawPosition: 1 }], new Map())).toThrow(/ghost/);
  });
});

// W4 B2 fix round 1 (item 6, controller ruling): before the DIVISION starts, a ROOT knockout with lines whose active roster
// differs from its seats offers Generate ("Update draw"); once the division has started it is hidden (D8-1). Stated from the
// ruling: each condition is flipped on its own from the one offering state, and each flip hides it.
describe("knockoutUpdateDrawOffered", () => {
  const offering: Parameters<typeof knockoutUpdateDrawOffered>[0] = {
    stage: { kind: "knockout", progression: null, config: { thirdPlace: false } },
    divisionStatus: "setup",
    fixtureCount: 7,
    matchesBegun: 0,
    rosterDrifted: true,
  };
  it("a root knockout with lines, before Start, whose roster moved: offered", () => {
    expect(knockoutUpdateDrawOffered(offering)).toBe(true);
  });
  it("each condition flipped alone hides it (another kind, a fed stage, a fed field, a started division, no lines, no drift)", () => {
    const flips: [string, typeof offering][] = [
      ["a league", { ...offering, stage: { ...offering.stage, kind: "league" } }],
      ["a double elimination", { ...offering, stage: { ...offering.stage, kind: "double_elim" } }],
      ["a knockout fed by an earlier stage", { ...offering, stage: { ...offering.stage, progression: { from: "s0" } as never } }],
      ["a knockout with a stored qualified field", { ...offering, stage: { ...offering.stage, config: { qualified: ["a", "b"] } } }],
      ["a division in play", { ...offering, divisionStatus: "active" }],
      ["a finished division", { ...offering, divisionStatus: "completed" }],
      ["a division status the panel does not know", { ...offering, divisionStatus: undefined as never }],
      ["no lines yet (a first Generate is the ordinary one)", { ...offering, fixtureCount: 0 }],
      ["the roster unchanged", { ...offering, rosterDrifted: false }],
      ["a real match (byes out) already begun", { ...offering, matchesBegun: 1 }],
    ];
    let checked = 0;
    for (const [why, input] of flips) {
      expect(knockoutUpdateDrawOffered(input), why).toBe(false);
      checked++;
    }
    expect(checked).toBe(10);
  });
});
