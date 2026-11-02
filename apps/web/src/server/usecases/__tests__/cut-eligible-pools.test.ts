// W3 T15 Carry A (controller rulings 2026-11-02; fix round 1 I3) — the tables a progression's CUT reads, pure: a
// withdrawn or disqualified entrant moves to the BOTTOM of a SWISS source's table, so the next eligible entrant
// backfills her place and only a shortfall (fewer eligible entrants than the cut) reaches her; every other source kind is
// read as it was (a group or league cut is W4/W5's to rule on). The DB proof — Finish, a plain Complete, the on_complete
// knockout, a tie at the boundary after the backfill, a shortfall on both timings — is swiss-finish-now.test.ts's
// "T15 Carry A" describe.
import { describe, expect, it } from "vitest";
import { resolveProgression, type StandingsRow } from "@seazn/engine/competition";
import { StageKind } from "@/server/api-v1/schemas";
import { cutEligiblePools } from "../stage-seeding";

const row = (entrantId: string, rank: number, tie?: string[]): StandingsRow => ({
  entrantId,
  played: 3,
  won: 0,
  drawn: 0,
  lost: 0,
  points: 0,
  metrics: {},
  rank,
  ...(tie ? { tieUnbroken: true, tieBreak: { key: "seed", with: tie } } : {}),
});

/** A, then B C D level (an unbroken class), then E. */
const table = () => [{ pool: "", rows: [row("A", 1), row("B", 2, ["C", "D"]), row("C", 3, ["B", "D"]), row("D", 4, ["B", "C"]), row("E", 5)] }];

describe("cutEligiblePools (T15 Carry A)", () => {
  it("every stage kind: only a Swiss source moves its departed rows to the bottom; any other kind's tables are read as they were", () => {
    // The ruling, typed here — never read off CUT_SKIPS_DEPARTED_KINDS, the set under test.
    const ruledSkips = (kind: string) => kind === "swiss";
    let checked = 0;
    const answers = new Set<boolean>();
    for (const kind of StageKind.options) {
      const before = table();
      const out = cutEligiblePools(kind, before, new Set(["A"]));
      if (ruledSkips(kind)) {
        expect(out[0]!.rows.map((r) => [r.entrantId, r.rank]), kind).toEqual([["B", 1], ["C", 2], ["D", 3], ["E", 4], ["A", 5]]);
      } else {
        expect(out, kind).toEqual(table());
      }
      expect(before, `${kind}: the input is never mutated`).toEqual(table());
      answers.add(ruledSkips(kind));
      checked++;
    }
    expect(checked, "anti-vacuity: every stage kind").toBe(StageKind.options.length);
    expect(checked).toBeGreaterThanOrEqual(9);
    expect([...answers].sort(), "both answers reached").toEqual([false, true]);
  });

  it("a departed member of a level class: the class keeps the others, each naming only who is left; she sinks with no tie", () => {
    const [p] = cutEligiblePools("swiss", table(), new Set(["C"]));
    expect(p!.rows).toEqual([row("A", 1), row("B", 2, ["D"]), row("D", 3, ["B"]), row("E", 4), row("C", 5)]);
    expect(p!.rows[4], "the departed row carries no tie: her place is the rule's").not.toHaveProperty("tieUnbroken");
    expect(p!.rows[4]).not.toHaveProperty("tieBreak");
  });

  it("a class left with one member is no tie: its flag and its partner list go", () => {
    const [p] = cutEligiblePools("swiss", table(), new Set(["B", "C"]));
    expect(p!.rows).toEqual([row("A", 1), row("D", 2), row("E", 3), row("B", 4), row("C", 5)]);
    for (const i of [1, 3, 4]) {
      expect(p!.rows[i], `${p!.rows[i]!.entrantId}: no flag`).not.toHaveProperty("tieUnbroken");
      expect(p!.rows[i], `${p!.rows[i]!.entrantId}: no partner list`).not.toHaveProperty("tieBreak");
    }
  });

  it("the order is the table's rank order, whatever order the snapshot stored its rows in", () => {
    const shuffled = [{ pool: "A", rows: [row("E", 5), row("A", 1), row("D", 4, ["B", "C"]), row("B", 2, ["C", "D"]), row("C", 3, ["B", "D"])] }];
    const [p] = cutEligiblePools("swiss", shuffled, new Set(["D", "A"]));
    expect(p!.pool).toBe("A");
    // Both halves in table order: the eligible by rank, then the departed by rank (A, rank 1, before D, rank 4).
    expect(p!.rows.map((r) => [r.entrantId, r.rank])).toEqual([["B", 1], ["C", 2], ["E", 3], ["A", 4], ["D", 5]]);
  });

  it("the empty cases: nobody departed, a departure outside this table, and no tables at all", () => {
    expect(cutEligiblePools("swiss", table(), new Set())).toEqual(table());
    expect(cutEligiblePools("swiss", table(), new Set(["Z"]))).toEqual(table());
    expect(cutEligiblePools("swiss", [], new Set(["A"]))).toEqual([]);
  });

  it("every pool of a pooled table is read on its own: a departure in one pool renumbers that pool only", () => {
    const pools = [
      { pool: "A", rows: [row("A1", 1), row("A2", 2)] },
      { pool: "B", rows: [row("B1", 1), row("B2", 2), row("B3", 3)] },
    ];
    const out = cutEligiblePools("swiss", pools, new Set(["B1"]));
    expect(out.map((p) => [p.pool, p.rows.map((r) => [r.entrantId, r.rank])])).toEqual([
      ["A", [["A1", 1], ["A2", 2]]],
      ["B", [["B2", 1], ["B3", 2], ["B1", 3]]],
    ]);
  });

  it("a shortfall — fewer eligible entrants than the cut — keeps the table whole: the engine's cut of 4 resolves, the eligible first, then the departed in table order (review I3: a dropped row left it short, STAGE_NOT_READY)", () => {
    // A, B, C, D, E in table order; B and D departed. Eligible: A, C, E — three, under a cut of 4.
    const five = [{ pool: "", rows: ["A", "B", "C", "D", "E"].map((id, i) => row(id, i + 1)) }];
    const departed = new Set(["B", "D"]);
    const ids = ["A", "B", "C", "D", "E"];
    // The ruling, typed here: the table less the departed, then the departed, top 4.
    const expected = [...ids.filter((id) => !departed.has(id)), ...ids.filter((id) => departed.has(id))].slice(0, 4);
    expect(expected, "premise: one departed entrant is reached").toEqual(["A", "C", "E", "B"]);
    const spec = { sources: [{ stage: "previous" as const, take: [{ kind: "rankRange" as const, from: 1, to: 4 }] }], placement: "rank_order" as const };
    const cut = (pools: typeof five) => resolveProgression(spec, [{ poolKeys: [""] }], [{ pools }]);
    const { qualifiers } = cut(cutEligiblePools("swiss", five, departed));
    expect([...qualifiers].sort((a, b) => a.seed - b.seed).map((q) => q.entrantId)).toEqual(expected);
    // The defect this replaces: the same cut over a table with the departed rows dropped refuses (STAGE_NOT_READY).
    const dropped = [{ pool: "", rows: five[0]!.rows.filter((r) => !departed.has(r.entrantId)).map((r, i) => ({ ...r, rank: i + 1 })) }];
    expect(() => cut(dropped)).toThrow(expect.objectContaining({ code: "STAGE_NOT_READY" }));
  });
});
