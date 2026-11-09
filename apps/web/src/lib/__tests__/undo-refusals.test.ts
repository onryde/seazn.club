// W4 app-A Task 5 (K1): the one client-side dispatch from an undo step's refusal code to its sentence key, across the two
// families (Swiss barriers since W3 T5, the seed confirm's knockout barrier since W4 T5). Every code of both tables is
// swept; the expected key is each table's own row, the source of truth the dispatch must route to.
import { describe, expect, it } from "vitest";
import { KNOCKOUT_REFUSALS, type KnockoutRefusalCode } from "@/lib/knockout-refusals";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
import { isUndoRefusalCode, undoRefusalKey, undoRefusalText } from "@/lib/undo-refusals";
import { msg } from "@/lib/messages";
import enUi from "@/dictionaries/en/ui.json";

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

// W4 T12 follow-up: a sentence that names something (`{min}`, `{stage}`) takes it from the envelope's fields. Four screens say an
// undo step's refusal (the History panel, Undo-last beside a notice, the AI console's one-tap Undo, the joint-undo card); the
// key alone prints the hole. Expected sentences are typed from the dictionary's own templates.
const EN = enUi as unknown as Record<string, string>;
const HOLE = /\{\w+\}/;

describe("undoRefusalText — a refusal of either family said in full, its fields filled", () => {
  it("leaves no hole in the sentence of ANY code of either table, whatever it names", () => {
    const swiss = Object.keys(SWISS_REFUSALS) as SwissRefusalCode[];
    const knockout = Object.keys(KNOCKOUT_REFUSALS) as KnockoutRefusalCode[];
    const FIELDS = { min: 4, stage: "Qualifying", can_rebuild: true, nested: { no: 1 } };
    const named: string[] = [];
    let checked = 0;
    for (const code of [...swiss, ...knockout]) {
      if (HOLE.test(EN[undoRefusalKey(code)] ?? "")) named.push(code);
      expect(undoRefusalText(code, FIELDS, msg), code).not.toMatch(HOLE);
      checked++;
    }
    expect(checked, "anti-vacuity: both tables swept").toBe(swiss.length + knockout.length);
    // The two sentences that name something today; a third reds here, and its test belongs beside them.
    expect(named.sort(), "the codes whose sentence has a hole to fill").toEqual(["KO_LATE_ENTRY_FED_STAGE", "QUALIFYING_MAIN_TOO_FEW"]);
  });

  it("says each sentence with the field the envelope carried", () => {
    expect(undoRefusalText("QUALIFYING_MAIN_TOO_FEW", { min: 4 }, msg)).toBe("Qualifying + Main draw needs at least 4 entrants.");
    expect(undoRefusalText("QUALIFYING_MAIN_TOO_FEW", { min: 8 }, msg), "another bound, another sentence").toBe(
      "Qualifying + Main draw needs at least 8 entrants.",
    );
    expect(undoRefusalText("KO_LATE_ENTRY_FED_STAGE", { stage: "Group stage" }, msg)).toBe("This knockout is filled from Group stage. Add the player there.");
  });

  it("says a code that names nothing as the dictionary does, with or without fields (positive pair)", () => {
    expect(undoRefusalText("SEED_CONFIRM_NOT_UNDOABLE", undefined, msg)).toBe(EN["knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE"]);
    expect(undoRefusalText("SEED_CONFIRM_NOT_UNDOABLE", { min: 4 }, msg)).toBe(EN["knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE"]);
    expect(undoRefusalText("SWISS_LATE_ENTRY_NOT_UNDOABLE", undefined, msg)).toBe(EN["swiss.refusal.SWISS_LATE_ENTRY_NOT_UNDOABLE"]);
    expect(undoRefusalText("SWISS_LATE_ENTRY_NOT_UNDOABLE", { min: 4 }, msg)).toBe(EN["swiss.refusal.SWISS_LATE_ENTRY_NOT_UNDOABLE"]);
  });
});
