// Scoring-defects batch (help-audit follow-up, 2026-11-19): copy that told a person something the product cannot do.
// One file for the batch; each describe is one item and carries its own anti-vacuity count.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { TIPS } from "@/config/tips";
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

// ── Item 3: a tip nothing mounts, whose words were false for a tile tap ──────────────────────────────────────────────
// `scoring.seq-conflict` ("Someone else scored first … re-enter your point") was mounted by no <Tip>, and a tile tap
// that loses a seq race is renegotiated and resent by the pad itself, so there is never a point to re-enter. Gone from the
// registry and from every dictionary, so a copy of it cannot be re-mounted by accident.
describe("item 3: the dead seq-conflict tip is gone", () => {
  const ID = "scoring.seq-conflict";

  it("is not in the registry, and no locale carries its title or body", () => {
    expect(Object.keys(TIPS), "precondition: the registry is not empty").not.toHaveLength(0);
    expect(Object.keys(TIPS)).not.toContain(ID);
    let checked = 0;
    for (const loc of LOCALES) {
      for (const part of ["title", "body"]) {
        expect(DICTS[loc], `${loc} tips.${ID}.${part}`).not.toHaveProperty(`tips.${ID}.${part}`);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x title and body").toBe(LOCALES.length * 2);
  });

  it("the negative pair: every tip that remains still has its title and body in all four locales", () => {
    let checked = 0;
    for (const id of Object.keys(TIPS)) {
      for (const loc of LOCALES) {
        for (const part of ["title", "body"]) {
          const v = DICTS[loc][`tips.${id}.${part}`];
          expect(typeof v === "string" && v.length > 0, `${loc} tips.${id}.${part}`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: every remaining tip x 4 locales x 2").toBe(Object.keys(TIPS).length * LOCALES.length * 2);
  });
});
