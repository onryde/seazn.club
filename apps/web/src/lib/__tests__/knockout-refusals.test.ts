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
import { KNOCKOUT_REFUSALS, isKnockoutRefusalCode, knockoutRefusalKey, knockoutRefusalText, type KnockoutRefusalCode } from "@/lib/knockout-refusals";
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
  // T7 (RB4-D9, X-SD-10): country separation is not offered — refused by name at the body door.
  "COUNTRY_SEPARATION_NOT_OFFERED",
  // T8 (FX-G2): after Start, Generate never reshapes a root knockout whose roster changed.
  "KO_GENERATE_AFTER_START",
  // B2 fix round 1 (I1): a redraw over organiser setup is refused, pointing to Rebuild.
  "KO_REDRAW_WOULD_CLEAR_SETUP",
  // B2 fix round 2 (item 2): Start reconciles in place only; a redraw is Update draw's, refused at Start by name.
  "KO_START_NEEDS_UPDATE_DRAW",
  // T9 (X-LE-2): a fed knockout never takes a late player; the refusal names the stage that fills it.
  "KO_LATE_ENTRY_FED_STAGE",
  // T10 (X-LE-6): round 1 has no slot left; Rebuild is offered (details.can_rebuild) only when nothing has started.
  "KO_LATE_ENTRY_NO_SLOT",
  // T10 (X-LE-13): Add late player has no Undo; the refusal points to Withdraw.
  "KO_LATE_ENTRY_NOT_UNDOABLE",
  // T11 (X-LE-10): the one-tap place route, on an entrant that does not wait on this stage.
  "KO_LATE_ENTRY_NOT_WAITING",
  // T15 (X-PL-1): Knockout + Plate below 4 entrants.
  "KO_PLATE_TOO_FEW",
  // T15 (X-QM-5): a qualifying draw on a field that cannot fill its cut.
  "QUALIFYING_MAIN_TOO_FEW",
  // T26c fix round 1 (I1): a fed page playoff on a field below its four.
  "PAGE_PLAYOFF_TOO_FEW",
  // T15 (X-QM-2): a rank cut from a knockout that is no whole round.
  "KO_CUT_NOT_WHOLE_ROUND",
  // T16 (SP-UI, X-SP-6, ruling 269): a stepladder or page playoff with no table to seed from — one code per kind (D13).
  "STEPLADDER_NEEDS_TABLE_SOURCE",
  "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE",
  // T8 (X-PL-2): a plate proposal on a field under two first-match losers.
  "PLATE_FIELD_TOO_SMALL",
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

  it("SEED_CONFIRM_NOT_UNDOABLE: 409, and it names no recovery (B1b fix round 1, I1: no product path re-opens a confirmed draw)", () => {
    // The plan's second sentence, "Recompute the proposal instead", sent the organiser to an action the product refuses: once a proposal is
    // confirmed, Recompute answers 409 SEEDING_ALREADY_CONFIRMED forever, and no writer moves a proposal out of `confirmed`.
    expect(KNOCKOUT_REFUSALS.SEED_CONFIRM_NOT_UNDOABLE).toEqual({
      status: 409,
      en: "This draw is confirmed and can't be undone.",
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

  it("KO_LATE_ENTRY_FED_STAGE: 422 (re-sending changes nothing), with the plan's sentence naming the feeding stage", () => {
    expect(KNOCKOUT_REFUSALS.KO_LATE_ENTRY_FED_STAGE).toEqual({
      status: 422,
      en: "This knockout is filled from {stage}. Add the player there.",
      key: "knockout.refusal.KO_LATE_ENTRY_FED_STAGE",
    });
    // The server's sentence names the stage (its `{stage}` filled from the details the client renders the key with).
    const err = knockoutRefusal("KO_LATE_ENTRY_FED_STAGE", { stage: "Groups" });
    expect(err).toMatchObject({ status: 422, code: "KO_LATE_ENTRY_FED_STAGE", message: "This knockout is filled from Groups. Add the player there." });
    expect(err.extra).toMatchObject({ stage: "Groups" });
    // A placeholder with no value is a sentence with a hole in it: refused by name, never sent as "{stage}".
    expect(() => knockoutRefusal("KO_LATE_ENTRY_FED_STAGE")).toThrow(/KO_LATE_ENTRY_FED_STAGE.*stage/);
    expect(() => knockoutRefusal("KO_LATE_ENTRY_FED_STAGE", { other: 1 })).toThrow(/stage/);
  });

  it("KO_LATE_ENTRY_NO_SLOT and KO_LATE_ENTRY_NOT_UNDOABLE: 409, with the plan's sentences", () => {
    expect(KNOCKOUT_REFUSALS.KO_LATE_ENTRY_NO_SLOT).toEqual({
      status: 409,
      en: "Round 1 complete; no slot left.",
      key: "knockout.refusal.KO_LATE_ENTRY_NO_SLOT",
    });
    expect(KNOCKOUT_REFUSALS.KO_LATE_ENTRY_NOT_UNDOABLE).toEqual({
      status: 409,
      en: "Adding a late player can't be undone. Withdraw the player instead.",
      key: "knockout.refusal.KO_LATE_ENTRY_NOT_UNDOABLE",
    });
  });

  it("KO_LATE_ENTRY_NOT_WAITING: 409 (the entrant's state, not the request, is wrong), with its sentence", () => {
    expect(KNOCKOUT_REFUSALS.KO_LATE_ENTRY_NOT_WAITING).toEqual({
      status: 409,
      en: "This player isn't waiting to join this bracket.",
      key: "knockout.refusal.KO_LATE_ENTRY_NOT_WAITING",
    });
  });

  it("T26c I1: a fed page playoff below four is 422 (the field has to change), and the sentence names the page playoff's size", () => {
    expect(KNOCKOUT_REFUSALS.PAGE_PLAYOFF_TOO_FEW).toEqual({ status: 422, en: "A page playoff needs at least 4 entrants.", key: "knockout.refusal.PAGE_PLAYOFF_TOO_FEW" });
    const err = knockoutRefusal("PAGE_PLAYOFF_TOO_FEW", { min: 4 });
    expect([err.status, err.code, err.message]).toEqual([422, "PAGE_PLAYOFF_TOO_FEW", "A page playoff needs at least 4 entrants."]);
  });

  it("T15's three: 422 (the field or the cut has to change, re-sending changes nothing), with the plan's sentences", () => {
    expect(KNOCKOUT_REFUSALS.PLATE_FIELD_TOO_SMALL).toEqual({ status: 422, en: "The plate needs at least two first-match losers.", key: "knockout.refusal.PLATE_FIELD_TOO_SMALL" });
    expect(KNOCKOUT_REFUSALS.KO_PLATE_TOO_FEW).toEqual({ status: 422, en: "Knockout + Plate needs at least 4 entrants.", key: "knockout.refusal.KO_PLATE_TOO_FEW" });
    expect(KNOCKOUT_REFUSALS.QUALIFYING_MAIN_TOO_FEW).toEqual({ status: 422, en: "Qualifying + Main draw needs at least {min} entrants.", key: "knockout.refusal.QUALIFYING_MAIN_TOO_FEW" });
    expect(KNOCKOUT_REFUSALS.KO_CUT_NOT_WHOLE_ROUND).toEqual({ status: 422, en: "From a knockout, qualify a whole round: 1, 2, 4, 8 …", key: "knockout.refusal.KO_CUT_NOT_WHOLE_ROUND" });
    const err = knockoutRefusal("QUALIFYING_MAIN_TOO_FEW", { min: 8 });
    expect(err.message).toBe("Qualifying + Main draw needs at least 8 entrants.");
    expect(err.extra).toMatchObject({ min: 8 });
    expect(() => knockoutRefusal("QUALIFYING_MAIN_TOO_FEW"), "a hole in the sentence is refused by name").toThrow(/QUALIFYING_MAIN_TOO_FEW.*min/);
  });

  it("knockoutRefusalText fills a sentence from the envelope's fields, in the reader's language, and takes no non-scalar with it", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const msg = (key: string, vars?: Record<string, string | number>) => dict[key]!.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
      const text = knockoutRefusalText("QUALIFYING_MAIN_TOO_FEW", { min: 8, other: { nested: true } }, msg);
      expect(text, locale).toContain("8");
      expect(text, `${locale}: no hole left`).not.toContain("{min}");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("X-SP-6 the standalone refusals: 422 (re-sending the same stage changes nothing), the rulebook's sentence per kind, and each locale names the format by its own title (D13: no raw kind token)", () => {
    // RB4-S6: "needs a table to seed from; add a league or groups first". The page playoff's names Swiss too (RB4-S7:
    // league or Swiss then page playoff).
    expect(KNOCKOUT_REFUSALS.STEPLADDER_NEEDS_TABLE_SOURCE).toEqual({
      status: 422,
      en: "A stepladder needs a table to seed from. Add a league or groups first.",
      key: "knockout.refusal.STEPLADDER_NEEDS_TABLE_SOURCE",
    });
    expect(KNOCKOUT_REFUSALS.PAGE_PLAYOFF_NEEDS_TABLE_SOURCE).toEqual({
      status: 422,
      en: "A page playoff needs a table to seed from. Add a league, groups or a Swiss stage first.",
      key: "knockout.refusal.PAGE_PLAYOFF_NEEDS_TABLE_SOURCE",
    });
    // Each translation names the format the way that locale's format gallery titles it (`format.<kind>.title`, the
    // product's own copy, not a list typed here), and never carries the wire's kind token.
    let checked = 0;
    for (const [code, kind] of [["STEPLADDER_NEEDS_TABLE_SOURCE", "stepladder"], ["PAGE_PLAYOFF_NEEDS_TABLE_SOURCE", "page_playoff"]] as const) {
      for (const [locale, dict] of Object.entries(LOCALES)) {
        if (locale === "en") continue;
        const text = dict[KNOCKOUT_REFUSALS[code].key]!.toLowerCase();
        const title = dict[`format.${kind}.title`]!;
        expect(typeof title === "string" && title !== "", `${locale}: format.${kind}.title`).toBe(true);
        expect(text, `${code} ${locale}: names the format by its title "${title}"`).toContain(title.toLowerCase());
        expect(text, `${code} ${locale}: no raw kind token`).not.toContain(kind === "page_playoff" ? "page_playoff" : "stepladder_");
        checked++;
      }
    }
    expect(checked, "(code, translated locale) pairs checked").toBe(6);
  });

  it("knockoutRefusal builds the HttpError from the row: status, code, English and details", () => {
    const err = knockoutRefusal("BYE_LINE_NOT_PLACEABLE", { fixtureId: "f1" });
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422, code: "BYE_LINE_NOT_PLACEABLE", message: KNOCKOUT_REFUSALS.BYE_LINE_NOT_PLACEABLE.en });
    expect(knockoutRefusal("BYE_LINE_NOT_PLACEABLE")).toMatchObject({ status: 422, code: "BYE_LINE_NOT_PLACEABLE" });
  });
});
