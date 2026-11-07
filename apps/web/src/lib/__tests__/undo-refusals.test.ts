// W4 app-A Task 5 (K1): the one client-side dispatch from an undo step's refusal code to its sentence key, across the two
// families (Swiss barriers since W3 T5, the seed confirm's knockout barrier since W4 T5). Every code of both tables is
// swept; the expected key is each table's own row, the source of truth the dispatch must route to.
import { describe, expect, it } from "vitest";
import { KNOCKOUT_REFUSALS, type KnockoutRefusalCode } from "@/lib/knockout-refusals";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
import { isUndoRefusalCode, undoRefusalKey } from "@/lib/undo-refusals";

describe("undoRefusalKey — a refusal of either family to its own sentence key", () => {
  it("routes every Swiss and every knockout code to its own table's key", () => {
    const swiss = Object.keys(SWISS_REFUSALS) as SwissRefusalCode[];
    const knockout = Object.keys(KNOCKOUT_REFUSALS) as KnockoutRefusalCode[];
    let checked = 0;
    for (const code of swiss) {
      expect(isUndoRefusalCode(code), code).toBe(true);
      expect(undoRefusalKey(code), code).toBe(SWISS_REFUSALS[code].key);
      checked++;
    }
    for (const code of knockout) {
      expect(isUndoRefusalCode(code), code).toBe(true);
      expect(undoRefusalKey(code), code).toBe(KNOCKOUT_REFUSALS[code].key);
      checked++;
    }
    expect(checked, "anti-vacuity: both tables swept").toBe(swiss.length + knockout.length);
    expect(knockout, "the seed confirm's barrier is a knockout code").toContain("SEED_CONFIRM_NOT_UNDOABLE");
  });

  it("answers no for anything that is not a code of either table — prototype names included", () => {
    for (const code of [undefined, null, "", "SEQ_CONFLICT", "toString", "constructor", "__proto__", 409]) {
      expect(isUndoRefusalCode(code), String(code)).toBe(false);
    }
  });
});
