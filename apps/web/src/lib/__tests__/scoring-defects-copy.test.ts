// Scoring-defects batch (help-audit follow-up, 2026-11-19): copy that told a person something the product cannot do.
// One file for the batch; each describe is one item and carries its own anti-vacuity count.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { LOCALES } from "@/lib/i18n-constants";

const DICTS: Record<(typeof LOCALES)[number], Record<string, string>> = { en, es, fr, nl };

// ── Item 1: "Reopen" for a feature that does not exist ───────────────────────────────────────────────────────────────
// A decided match that is NOT finalized reopens when the deciding entry is voided (the console's "⟲ Void last entry");
// a finalized match takes no append from anyone (append-event.ts ALREADY_DECIDED). So neither line may say "reopen" or
// send the reader to an organiser for a correction that cannot be made.
describe("item 1: the decided / finalized lines say what a person can actually do", () => {
  const REOPEN_WORDS = /reopen|reábr|reabr|rouvr|heropen|herstel/i; // en, es x2, fr, nl
  const ASK_ORGANISER = /organi[sz](er|ador|ateur|ator)/i;
  // the button's own label, minus its glyph: the line must name the control the person will look for
  const voidLabel = (loc: (typeof LOCALES)[number]) => DICTS[loc]["score.voidLast"]!.replace(/^⟲\s*/, "");

  it("ALREADY_DECIDED names the console's own void control, in every locale, and never 'reopen'", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const line = DICTS[loc]["engineError.ALREADY_DECIDED"]!;
      expect(typeof line, loc).toBe("string");
      expect(voidLabel(loc).length, `${loc}: the label this is derived from exists`).toBeGreaterThan(4);
      expect(line, `${loc} names the control`).toContain(voidLabel(loc));
      expect(line, `${loc} promises no reopen`).not.toMatch(REOPEN_WORDS);
      checked += 1;
    }
    expect(checked, "anti-vacuity: four locales").toBe(LOCALES.length);
  });

  it("the finalized View-only line says the result is final and sends nobody to an organiser, in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const line = DICTS[loc]["device.scan.viewOnly.finalized"]!;
      expect(typeof line, loc).toBe("string");
      expect(line, `${loc} asks nobody to correct it`).not.toMatch(ASK_ORGANISER);
      expect(line, `${loc} promises no reopen`).not.toMatch(REOPEN_WORDS);
      checked += 1;
    }
    expect(checked, "anti-vacuity: four locales").toBe(LOCALES.length);
  });

  it("the negative pair: the carried-forward line still sends the reader to the organiser (that correction exists)", () => {
    for (const loc of LOCALES) {
      expect(DICTS[loc]["device.scan.viewOnly.carried"]!, loc).toMatch(ASK_ORGANISER);
    }
  });
});
