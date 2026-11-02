// W3 T15 Carry A (controller ruling 2026-11-02) — the tables a progression's CUT reads, pure: a withdrawn or
// disqualified entrant leaves a SWISS source's cut and the next eligible entrant backfills; every other source kind is
// read as it was (a group or league cut is W4/W5's to rule on). The DB proof — Finish, a plain Complete, the on_complete
// knockout, a tie at the boundary after the backfill — is swiss-finish-now.test.ts's "T15 Carry A" describe.
import { describe, expect, it } from "vitest";
import type { StandingsRow } from "@seazn/engine/competition";
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
  it("every stage kind: only a Swiss source drops its departed rows; any other kind's tables are read as they were", () => {
    // The ruling, typed here — never read off CUT_SKIPS_DEPARTED_KINDS, the set under test.
    const ruledSkips = (kind: string) => kind === "swiss";
    let checked = 0;
    const answers = new Set<boolean>();
    for (const kind of StageKind.options) {
      const before = table();
      const out = cutEligiblePools(kind, before, new Set(["A"]));
      if (ruledSkips(kind)) {
        expect(out[0]!.rows.map((r) => [r.entrantId, r.rank]), kind).toEqual([["B", 1], ["C", 2], ["D", 3], ["E", 4]]);
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

  it("a departed member of a level class: the class keeps the others, each naming only who is left", () => {
    const [p] = cutEligiblePools("swiss", table(), new Set(["C"]));
    expect(p!.rows).toEqual([row("A", 1), row("B", 2, ["D"]), row("D", 3, ["B"]), row("E", 4)]);
  });

  it("a class left with one member is no tie: its flag and its partner list go", () => {
    const [p] = cutEligiblePools("swiss", table(), new Set(["B", "C"]));
    expect(p!.rows).toEqual([row("A", 1), row("D", 2), row("E", 3)]);
    expect(p!.rows[1]).not.toHaveProperty("tieUnbroken");
    expect(p!.rows[1]).not.toHaveProperty("tieBreak");
  });

  it("the order is the table's rank order, whatever order the snapshot stored its rows in", () => {
    const shuffled = [{ pool: "A", rows: [row("E", 5), row("A", 1), row("D", 4, ["B", "C"]), row("B", 2, ["C", "D"]), row("C", 3, ["B", "D"])] }];
    const [p] = cutEligiblePools("swiss", shuffled, new Set(["D"]));
    expect(p!.pool).toBe("A");
    expect(p!.rows.map((r) => [r.entrantId, r.rank])).toEqual([["A", 1], ["B", 2], ["C", 3], ["E", 4]]);
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
      ["B", [["B2", 1], ["B3", 2]]],
    ]);
  });
});
