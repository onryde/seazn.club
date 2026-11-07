// W4 app-A (plan Task 3; later tasks grow the table one code at a time). Every knockout refusal the W4 app work raises
// lives in ONE client-safe table (`lib/knockout-refusals.ts`): its HTTP status, the server's English sentence and the
// `knockout.refusal.<CODE>` key a screen renders in the reader's language. These tests pin the table against the plan's
// code list and the four dictionaries, as swiss-refusals.test.ts does for the Swiss table, so a code added without
// copy, or copy added in one locale only, is red here and not a raw wire code on an organiser's screen.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { HttpError } from "@/lib/errors";
import { KNOCKOUT_REFUSALS, isKnockoutRefusalCode, knockoutRefusalKey, type KnockoutRefusalCode } from "@/lib/knockout-refusals";
import { knockoutRefusal } from "@/server/usecases/knockout-refusal";

// The plan's list, typed here rather than read from the table under test: a code dropped from the table, or one added
// without a ruling, fails the equality. A later task that adds a code adds it to this list in the same change.
const PLAN_CODES = [
  // T3 (K2, X-SD-5): a bye line is not played, so it never takes a court or a time.
  "BYE_LINE_NOT_PLACEABLE",
  // T5 (K1): Undo, Redo and Restore never step across a seed confirm.
  "SEED_CONFIRM_NOT_UNDOABLE",
  // T6 (AN-2): a bracket completes only with every match decided.
  "STAGE_HAS_UNDECIDED_FIXTURES",
] as const;

const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("KNOCKOUT_REFUSALS (W4 app-A)", () => {
  it("holds exactly the plan's codes", () => {
    expect(Object.keys(KNOCKOUT_REFUSALS).sort()).toEqual([...PLAN_CODES].sort());
  });

  it("every KnockoutRefusalCode has a key present, translated, in all 4 dictionaries, and en says what the server says", () => {
    let checked = 0;
    for (const [code, row] of Object.entries(KNOCKOUT_REFUSALS) as [KnockoutRefusalCode, (typeof KNOCKOUT_REFUSALS)[KnockoutRefusalCode]][]) {
      expect(row.key, code).toBe(`knockout.refusal.${code}`);
      expect(knockoutRefusalKey(code), code).toBe(row.key);
      expect([400, 409, 422], `${code}: a refusal is a 400, 409 or 422`).toContain(row.status);
      expect(row.en.trim(), `${code}: the server's English sentence`).not.toBe("");
      for (const [locale, dict] of Object.entries(LOCALES)) {
        const text = dict[row.key];
        expect(typeof text === "string" && text.trim() !== "", `${code}: ${locale}/ui.json has ${row.key}`).toBe(true);
        expect(placeholders(text!), `${code}: ${locale} placeholders match en`).toEqual(placeholders(en[row.key as keyof typeof en]));
        if (locale !== "en") expect(text, `${code}: ${locale} is translated, not the English`).not.toBe(en[row.key as keyof typeof en]);
        checked++;
      }
      expect(en[row.key as keyof typeof en], `${code}: en/ui.json says what the server says`).toBe(row.en);
    }
    // Anti-vacuity: every (code, locale) pair. Zero checked is a failure, not a pass.
    expect(checked, "(code, locale) pairs checked").toBe(PLAN_CODES.length * 4);
    expect(checked).toBeGreaterThan(0);
  });

  it("isKnockoutRefusalCode: true for every plan code, false for any other wire code or a prototype name", () => {
    let yes = 0;
    for (const code of PLAN_CODES) {
      expect(isKnockoutRefusalCode(code), code).toBe(true);
      yes++;
    }
    expect(yes, "every plan code judged").toBe(PLAN_CODES.length);
    const others = ["SWISS_BYE_NOT_PLACEABLE", "SEQ_CONFLICT", "bye_line_not_placeable", "", "toString", "__proto__", "constructor", undefined, null, 422];
    for (const other of others) expect(isKnockoutRefusalCode(other), String(other)).toBe(false);
    expect(others.length).toBe(10);
  });

  it("BYE_LINE_NOT_PLACEABLE: 422 (re-sending it changes nothing), with the plan's sentence", () => {
    expect(KNOCKOUT_REFUSALS.BYE_LINE_NOT_PLACEABLE).toEqual({
      status: 422,
      en: "A bye is not played, so it never takes a court or a time.",
      key: "knockout.refusal.BYE_LINE_NOT_PLACEABLE",
    });
  });

  it("SEED_CONFIRM_NOT_UNDOABLE: 409 (a state of the division, resolved another way), with the plan's sentence", () => {
    expect(KNOCKOUT_REFUSALS.SEED_CONFIRM_NOT_UNDOABLE).toEqual({
      status: 409,
      en: "A confirmed draw can't be undone. Recompute the proposal instead.",
      key: "knockout.refusal.SEED_CONFIRM_NOT_UNDOABLE",
    });
  });

  it("STAGE_HAS_UNDECIDED_FIXTURES: 409, with the plan's sentence", () => {
    expect(KNOCKOUT_REFUSALS.STAGE_HAS_UNDECIDED_FIXTURES).toEqual({
      status: 409,
      en: "This bracket still has matches without a result. Finish or settle them first.",
      key: "knockout.refusal.STAGE_HAS_UNDECIDED_FIXTURES",
    });
  });

  it("knockoutRefusal builds the HttpError from the row: status, code, English and details", () => {
    const err = knockoutRefusal("BYE_LINE_NOT_PLACEABLE", { fixtureId: "f1" });
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422, code: "BYE_LINE_NOT_PLACEABLE", message: KNOCKOUT_REFUSALS.BYE_LINE_NOT_PLACEABLE.en });
    expect(knockoutRefusal("BYE_LINE_NOT_PLACEABLE")).toMatchObject({ status: 422, code: "BYE_LINE_NOT_PLACEABLE" });
  });
});
