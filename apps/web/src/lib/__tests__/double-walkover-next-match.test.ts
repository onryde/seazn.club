// W2b D19 (X-DW-3) — the one reading of "a double walkover is refused here" that the append guard and the console's
// forfeit dialog share (Task 11). Expectations are D19's own rows, typed: a final of a feeding bracket kind refuses; a
// line that feeds a next match, a ladder, a table stage and a stage-less fixture never do.
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { doubleWalkoverRefused, doubleWalkoverNeedsNextMatch } from "@/lib/double-walkover-next-match";

/** D19's feeding kinds (plan D19; spec §7 row 3): a final, a stepladder's last rung, a page playoff final, a
 *  third-place match, a double-elimination grand final. */
const FEEDING = ["knockout", "double_elim", "stepladder", "page_playoff"];

describe("D19 / X-DW-3: where a double walkover is refused", () => {
  it("empty case first: a fixture with no stage never refuses, whatever its edges", () => {
    expect(doubleWalkoverRefused(null, false)).toBe(false);
    expect(doubleWalkoverRefused(null, true)).toBe(false);
  });

  it("X-DW-3: every stage kind the engine declares — the feeding bracket kinds refuse on a line that feeds nothing, and only there", () => {
    let checked = 0;
    for (const kind of StageKind.options) {
      const feeding = FEEDING.includes(kind);
      expect(doubleWalkoverNeedsNextMatch(kind), kind).toBe(feeding);
      expect(doubleWalkoverRefused(kind, false), `${kind}, a final`).toBe(feeding);
      expect(doubleWalkoverRefused(kind, true), `${kind}, a line that feeds a next match`).toBe(false);
      checked++;
    }
    expect(checked, `stage kinds checked: ${checked}`).toBe(StageKind.options.length);
    expect(checked).toBeGreaterThan(FEEDING.length);
    // The ladder is a bracket kind (it forbids a level result) and still never refuses: positions, not a feed graph.
    expect(StageKind.options).toContain("ladder");
    expect(doubleWalkoverRefused("ladder", false)).toBe(false);
  });
});
