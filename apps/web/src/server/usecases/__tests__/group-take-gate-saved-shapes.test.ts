// Every `on_complete` per-group take (`topNPerGroup` / `bestNth`) that an existing DB test or e2e spec SAVES out of two or more pools is
// folded here through the REAL save gate (`refuseGroupTakeShape`, the door `validateStageProgression` calls for every saved stage), so a
// change to the gate's policy - it refuses only a shape the draw refuses for EVERY outcome - cannot silently turn one of those scenes red
// in CI. The shapes are a CENSUS, not hand-picked: the gate was instrumented and the whole of src/server's per-group suites (and the
// vitest files that build groups_ko stages) run against a real database; each distinct (pools, take) it judged is below, with the file
// that saves it. The e2e specs cannot be instrumented locally (CI runs them), so their takes are read from the specs.
// The fake transaction answers the two reads the gate makes (the roster size, whether the source is fed); nothing else is touched.
// Anti-vacuity: the table's size is pinned, and the refused rows are named (a gate that refuses everything or nothing fails).
import { describe, expect, it } from "vitest";
import type { TakeRule } from "@seazn/engine/competition";
import { refuseGroupTakeShape } from "../stages/group-take-gate";
import type { Tx } from "../stages/types";

function fakeTx(roster: number): Tx {
  const tx = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (/count\(\*\)/.test(text)) return Promise.resolve([{ n: roster }]);
    if (/progression is not null/.test(text)) return Promise.resolve([{ fed: false }]);
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };
  return tx as unknown as Tx;
}

const top = (n: number): TakeRule => ({ kind: "topNPerGroup", n });
const best = (nth: number, count: number, normaliseUnequalPools = false): TakeRule => (normaliseUnequalPools ? { kind: "bestNth", nth, count, normaliseUnequalPools } : { kind: "bestNth", nth, count }) as TakeRule;

interface Shape {
  /** The suite or spec that saves it. */
  from: string;
  pools: number;
  take: TakeRule[];
  /** The division's active roster when the scene has entrants at save (null: none yet - the roster check is skipped). */
  roster: number | null;
  /** The source stage's status at save. */
  source?: "pending" | "active" | "complete";
  /** Set when the scene's own premise is that the save is refused: the code. */
  refused?: string;
}

const SHAPES: Shape[] = [
  { from: "table-rules-pin.test.ts", pools: 2, take: [best(1, 2)], roster: 8 },
  { from: "tables-producer-consumer.test.ts", pools: 2, take: [best(1, 2)], roster: 8 },
  { from: "public-stages-qualification-db.test.ts", pools: 2, take: [top(2)], roster: 8 },
  { from: "public-stages-qualification-db.test.ts", pools: 2, take: [top(1)], roster: 8 },
  { from: "public-stages-qualification-db.test.ts", pools: 3, take: [top(2), best(2, 1)], roster: 12 },
  { from: "public-stages-qualification-db.test.ts", pools: 3, take: [top(1)], roster: 12 },
  { from: "public-stages-qualification-db.test.ts", pools: 3, take: [top(1), best(2, 0)], roster: 12 },
  { from: "public-stages-qualification-db.test.ts", pools: 4, take: [top(1)], roster: 16 },
  { from: "public-stages-qualification-db.test.ts", pools: 4, take: [best(2, 2)], roster: 16 },
  { from: "table-cut-departed.test.ts", pools: 2, take: [top(2), best(3, 1, true)], roster: 10 },
  { from: "qualification-view-db.test.ts", pools: 2, take: [top(1)], roster: 8 },
  { from: "lucky-loser.test.ts", pools: 3, take: [top(2), best(3, 2, true)], roster: 12 },
  { from: "field-cut-gate.test.ts (the pair of its refusal)", pools: 2, take: [top(3)], roster: 7 },
  { from: "add-stage-after-groups.test.ts", pools: 2, take: [top(2)], roster: 8, source: "complete" },
  { from: "stage-qualification-db.test.ts", pools: 2, take: [top(2)], roster: 8 },
  // e2e specs (read, not instrumented): the form's own counts on 4 groups, the standings-qualification finals, the tables-w2d rig.
  { from: "e2e/add-stage-after-groups.spec.ts (qualify 8)", pools: 4, take: [top(2)], roster: 18 },
  { from: "e2e/add-stage-after-groups.spec.ts (qualify 10)", pools: 4, take: [top(2), best(3, 2)], roster: 18 },
  { from: "e2e/standings-qualification.spec.ts (finals added before any entrant)", pools: 2, take: [top(1)], roster: null },
  { from: "e2e/walkthrough/tables-w2d.spec.ts (best third rig)", pools: 2, take: [top(1), best(2, 1), best(3, 1)], roster: 6 },
  // The one scene whose premise is a refusal: 7 into 3 pools cannot supply every winner and two best 3rds.
  { from: "field-cut-gate.test.ts (X-BD-8 on_complete)", pools: 3, take: [top(1), best(3, 2, true)], roster: 7, refused: "RR_CUT_EXCEEDS_FIELD" },
];

describe("every on_complete per-group take the existing scenes save from several groups, through the real save gate", () => {
  it("the census table is whole (anti-vacuity: its size, its refused rows, and the shapes the policy turned on)", () => {
    expect(SHAPES.length).toBe(20);
    expect(SHAPES.filter((s) => s.refused !== undefined).map((s) => s.from)).toEqual(["field-cut-gate.test.ts (X-BD-8 on_complete)"]);
    // The rig that motivated the policy (three of its four outcomes refuse in the draw) is in the table, and the form's own best-3rd shape.
    expect(SHAPES.some((s) => s.take.length === 3)).toBe(true);
    expect(SHAPES.some((s) => s.from.includes("qualify 10"))).toBe(true);
  });

  for (const shape of SHAPES) {
    it(`${shape.from}: ${shape.pools} groups, ${JSON.stringify(shape.take)} ${shape.refused === undefined ? "saves" : `is refused ${shape.refused}`}`, async () => {
      const ran = refuseGroupTakeShape(
        shape.roster === null ? fakeTx(0) : fakeTx(shape.roster),
        { division_id: "d", kind: "knockout" },
        { sources: [{ stage: "previous", take: shape.take }], placement: "rank_order", timing: "on_complete" } as never,
        [{ id: "s1", kind: "group", status: shape.source ?? "pending" }],
        [shape.pools],
      );
      if (shape.refused === undefined) {
        await expect(ran).resolves.toBeUndefined();
      } else {
        await expect(ran).rejects.toMatchObject({ status: 422, code: shape.refused });
      }
    });
  }
});
