// Match Day E1 item 3: where a stage's bracket tree is drawn. The expectations come from the ENGINE'S OWN generators and layout
// readers (`generateSingleElim` / `generateDoubleElim` / `generatePagePlayoff` / `generateStepladder`, then the same `twoSidedBracket`
// / `doubleElimBracket` / `pagePlayoffBracket` the panel draws with) - never a table of kinds typed here. A single-elimination shape
// is drawn in the stage's card; the two-lane double-elimination layout and the stepladder keep the page; no bracket yet draws nowhere.
import { describe, expect, it } from "vitest";
import {
  doubleElimBracket,
  pagePlayoffBracket,
  twoSidedBracket,
  type BracketFixtureRef,
} from "@seazn/engine/scheduling/bracket-layout";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder, type GeneratedBracket } from "@seazn/engine/scheduling";
import { bracketPlacement } from "../bracket-view";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `T${i + 1}`);

/** The rows a persisted stage holds, built the way the stage writer numbers them: `round_no` from the generator's round (a double
 *  elimination's lanes are offset, exactly as `doc-bracket-geometry.test.ts` numbers them), `seq_in_round` counting per lane+round. */
function rowsOf(gen: GeneratedBracket, deLanes = false): BracketFixtureRef[] {
  const counters = new Map<string, number>();
  return gen.fixtures.map((f) => {
    const lane = f.bracket ?? "WB";
    const offset = !deLanes ? 0 : lane === "LB" ? gen.rounds : lane === "GF" ? 2 * gen.rounds : 0;
    const round_no = offset + f.round + 1;
    const key = `${lane}:${round_no}`;
    const seq = (counters.get(key) ?? 0) + 1;
    counters.set(key, seq);
    return { id: f.id, round_no, seq_in_round: seq };
  });
}

describe("bracketPlacement", () => {
  it("a single-elimination tree of any size is drawn in the stage's card (swept over field sizes, byes and a third-place match)", () => {
    let checked = 0;
    for (const n of [3, 4, 5, 6, 7, 8, 12, 16]) {
      for (const thirdPlace of [false, true]) {
        const rows = rowsOf(generateSingleElim({ entrants: field(n), thirdPlace }));
        // The premise, from the engine: the panel's own reader accepts it as a two-sided tree - otherwise "card" proves nothing.
        expect(twoSidedBracket(rows).ok, `premise: ${n} entrants / third=${thirdPlace} reads as a two-sided tree`).toBe(true);
        expect(bracketPlacement("knockout", rows), `${n} / third=${thirdPlace}`).toBe("card");
        checked += 1;
      }
    }
    expect(checked).toBe(16);
  });

  it("a double-elimination tree keeps the page (it has no card button), with and without the bracket reset", () => {
    let checked = 0;
    for (const n of [4, 8, 16]) {
      for (const bracketReset of [false, true]) {
        const rows = rowsOf(generateDoubleElim({ entrants: field(n), bracketReset }), true);
        expect(twoSidedBracket(rows).ok, `premise: ${n} double-elim is not a two-sided tree`).toBe(false);
        expect(doubleElimBracket(rows).ok, `premise: ${n} double-elim reads as the two-lane layout`).toBe(true);
        expect(bracketPlacement("double_elim", rows), `${n} / reset=${bracketReset}`).toBe("page");
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  it("a stepladder keeps the page, a page playoff is a four-team tree drawn in the card", () => {
    const ladder = rowsOf(generateStepladder({ entrants: field(4) }));
    expect(ladder.length, "premise: the stepladder has rungs").toBeGreaterThan(0);
    expect(bracketPlacement("stepladder", ladder)).toBe("page");
    const pp = rowsOf(generatePagePlayoff({ entrants: field(4) }));
    expect(pagePlayoffBracket(pp).ok, "premise: the engine reads it as a page playoff").toBe(true);
    expect(bracketPlacement("page_playoff", pp)).toBe("card");
  });

  it("no bracket yet draws nowhere: every bracket kind with no fixtures is null (the empty case)", () => {
    let checked = 0;
    for (const kind of ["knockout", "double_elim", "stepladder", "page_playoff"]) {
      expect(bracketPlacement(kind, []), kind).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("only a bracket-kind stage draws a tree: tree-shaped rows under a league (or any non-bracket kind) are null", () => {
    const tree = rowsOf(generateSingleElim({ entrants: field(8) }));
    expect(twoSidedBracket(tree).ok, "premise: the rows are a tree").toBe(true);
    let checked = 0;
    for (const kind of ["league", "round_robin", "swiss", "groups", "ladder", "americano", "anything"]) {
      expect(bracketPlacement(kind, tree), kind).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(7);
  });

  it("a placement is a promise the panel draws: whatever is 'card' or 'page' reads as a layout, whatever is null does not", () => {
    // Fixtures a knockout stage can hold that are not a bracket (a round-robin-shaped heap): nothing to draw, so no button.
    const heap: BracketFixtureRef[] = [
      { id: "a", round_no: 1, seq_in_round: 1 },
      { id: "b", round_no: 1, seq_in_round: 2 },
      { id: "c", round_no: 1, seq_in_round: 3 },
    ];
    expect(twoSidedBracket(heap).ok).toBe(false);
    expect(doubleElimBracket(heap).ok).toBe(false);
    expect(bracketPlacement("knockout", heap)).toBeNull();
  });
});
