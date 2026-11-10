// Review 2 of #857, I2. "Undo" beside a stages-panel notice painted the
// server's sentence on a refusal: for a change that touches a match that has
// started or finished, that was the engine's English — once with a fixture
// UUID and a "force-clear" control that does not exist. The played refusal is
// now said locally, off its CODE; anything this client does not recognise
// keeps its own message.
import { describe, expect, it } from "vitest";
import { undoRefusalMessage } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";
import { msg } from "@/lib/messages";
import enUi from "@/dictionaries/en/ui.json";

const EN = enUi as unknown as Record<string, string>;
const ENGINE = "a match this change touches has started or finished, so it can't be undone or redone";

describe("undoRefusalMessage — StagesPanel's Undo-last refusal", () => {
  it("says the played refusal with the dictionary's sentence, not the engine's", () => {
    expect(typeof EN["history.error.played"], "history.error.played is missing").toBe("string");
    const text = undoRefusalMessage(new ApiV1Error(ENGINE, 422, PLAYED_REFUSAL_CODE), msg);
    expect(text).toBe(EN["history.error.played"]);
    expect(text).not.toBe(ENGINE);
  });

  it("says each Swiss step refusal with the dictionary's sentence (W3 T5, X-SW-28)", () => {
    // Undo-last is a history Undo: over a Swiss round with a started match, or across an undo barrier, the server
    // refuses with a Swiss code and an English sentence. The server's text here differs from the dictionary's, so a
    // fall-through to `err.message` is told apart from the branch.
    const codes: SwissRefusalCode[] = [
      "SWISS_UNDO_ROUND_STARTED",
      "SWISS_LATE_ENTRY_NOT_UNDOABLE",
      "SWISS_ROUNDS_CHANGE_NOT_UNDOABLE",
    ];
    let checked = 0;
    for (const code of codes) {
      const local = EN[SWISS_REFUSALS[code].key];
      expect(typeof local, `${code}: en/ui.json has its sentence`).toBe("string");
      // At the status the server answers with for this code (the table's): SWISS_UNDO_ROUND_STARTED is a 422.
      expect(undoRefusalMessage(new ApiV1Error(`server: ${code}`, SWISS_REFUSALS[code].status, code), msg), code).toBe(local);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("says the confirmed-draw barrier (a KNOCKOUT code) with the dictionary's sentence (W4 T5, K1)", () => {
    // Undo-last after a seed confirm: the server refuses with SEED_CONFIRM_NOT_UNDOABLE (409, the plan's) — a knockout
    // refusal, not a Swiss one, so a Swiss-only branch let its English through.
    const local = EN["knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE"];
    expect(typeof local, "en/ui.json has its sentence").toBe("string");
    const text = undoRefusalMessage(new ApiV1Error("server: SEED_CONFIRM_NOT_UNDOABLE", 409, "SEED_CONFIRM_NOT_UNDOABLE"), msg);
    expect(text).toBe(local);
  });

  it("fills a knockout sentence's fields from the envelope: QUALIFYING_MAIN_TOO_FEW says its {min}, never a literal hole", () => {
    // The History panel fills these (knockoutRefusalText); Undo-last beside a notice is the same refusal and must say the same
    // sentence. The bound rides on the envelope beside the code (`knockoutRefusal(code, { min })` → `err.extra`).
    expect(msg("knockout.refusal.QUALIFYING_MAIN_TOO_FEW"), "premise: the dictionary's sentence has a hole to fill").toContain("{min}");
    const text = undoRefusalMessage(new ApiV1Error("server: needs 4", 422, "QUALIFYING_MAIN_TOO_FEW", { min: 4 }), msg);
    expect(text).toBe("Qualifying + Main draw needs at least 4 entrants.");
    expect(text).not.toContain("{");
  });

  it("keeps an unrecognised refusal's own message", () => {
    expect(undoRefusalMessage(new ApiV1Error("division is mid-solve", 409, "BUSY"), msg)).toBe(
      "division is mid-solve",
    );
    expect(undoRefusalMessage(new Error("network down"), msg)).toBe("network down");
  });

  it("falls back to the generic sentence for a throw that is not an Error", () => {
    expect(undoRefusalMessage("nope", msg)).toBe(EN["schedule.error.undoFailed"]);
  });
});
