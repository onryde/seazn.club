// W3 Swiss app-A (spec 2026-10-31-format-matrix-w3-swiss-design.md §11: "refusal codes, i18n keys and copy for every
// new message, all 4 locales"). Every Swiss refusal the W3 app raises lives in ONE client-safe table
// (`lib/swiss-refusals.ts`): its HTTP status, the server's English sentence and the `swiss.refusal.<CODE>` key the desk
// renders. These tests pin the table against the plan's code list and the four dictionaries, so a code added without
// copy, or copy added in one locale only, is red here and not a raw wire code on an organiser's screen.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { HttpError } from "@/lib/errors";
import { SWISS_REFUSALS, isSwissRefusalCode, swissRefusalKey, type SwissRefusalCode } from "@/lib/swiss-refusals";
import { swissRefusal } from "@/server/usecases/swiss-refusal";

// The plan's list (W3 app-A plan, Task 4 "Interfaces → Codes defined here, for every later task"), typed here rather
// than read from the table under test: a code dropped from the table, or one added without a ruling, fails the equality.
// A later task that adds a code (T18's requested-bye refusal) adds it to this list in the same change.
const PLAN_CODES = [
  "SWISS_ADHOC_REFUSED",
  "SWISS_BYE_NOT_PLACEABLE",
  "SWISS_UNDO_ROUND_STARTED",
  "SWISS_LATE_ENTRY_NOT_UNDOABLE",
  "SWISS_ROUNDS_CHANGE_NOT_UNDOABLE",
  "SWISS_NO_ROUND_LEFT",
  "SWISS_OVER",
  "SWISS_ROUNDS_ABOVE_MAX",
  "SWISS_ROUNDS_LOCKED",
  // T12 Phase 2 (controller ruling: chess colours lock at the first start with their OWN copy, never the rounds sentence).
  "SWISS_CHESS_LOCKED",
  "SWISS_ROUNDS_BELOW_SEATED",
  "SWISS_FINISH_ROUND_UNDECIDED",
  "SWISS_FINISH_NOTHING_PLAYED",
  "STAGE_NOT_SWISS",
] as const;

const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("SWISS_REFUSALS (W3 app-A)", () => {
  it("holds exactly the plan's codes", () => {
    expect(Object.keys(SWISS_REFUSALS).sort()).toEqual([...PLAN_CODES].sort());
  });

  it("every SwissRefusalCode has a key present in all 4 dictionaries", () => {
    let checked = 0;
    for (const [code, row] of Object.entries(SWISS_REFUSALS) as [SwissRefusalCode, (typeof SWISS_REFUSALS)[SwissRefusalCode]][]) {
      // The plan's Global "Locale" convention: one `swiss.refusal.<CODE>` key per code.
      expect(row.key, code).toBe(`swiss.refusal.${code}`);
      expect(swissRefusalKey(code), code).toBe(row.key);
      expect([409, 422], `${code}: a refusal is a 409 (a state the organiser resolves) or a 422 (never succeeds as sent)`).toContain(row.status);
      expect(row.message.trim(), `${code}: the server's English sentence`).not.toBe("");
      for (const [locale, dict] of Object.entries(LOCALES)) {
        const text = dict[row.key];
        expect(typeof text === "string" && text.trim() !== "", `${code}: ${locale}/ui.json has ${row.key}`).toBe(true);
        // A placeholder the English copy names and a locale drops (or invents) renders as a hole or a raw `{token}`.
        expect(placeholders(text!), `${code}: ${locale} placeholders match en`).toEqual(placeholders(en[row.key as keyof typeof en]));
        // A locale that copied the English is untranslated copy on that reader's screen (T4 review minor).
        if (locale !== "en") expect(text, `${code}: ${locale} is translated, not the English`).not.toBe(en[row.key as keyof typeof en]);
        checked++;
      }
      // One English sentence, not two: the desk's English is the server's English.
      expect(en[row.key as keyof typeof en], `${code}: en/ui.json says what the server says`).toBe(row.message);
    }
    // Anti-vacuity: 14 codes × 4 locales. Zero checked is a failure, not a pass.
    expect(checked, "anti-vacuity: (code, locale) pairs checked").toBe(PLAN_CODES.length * 4);
    expect(checked).toBeGreaterThan(0);
  });

  it("isSwissRefusalCode (W3 T5): true for every plan code, false for any other wire code or a prototype name", () => {
    // The client branches on the CODE to say a Swiss refusal in the reader's language (history-panel.tsx, the Undo
    // toast in stages-panel.tsx); a guard that answered yes to a prototype key would hand `swissRefusalKey` an
    // undefined row.
    let yes = 0;
    for (const code of PLAN_CODES) {
      expect(isSwissRefusalCode(code), code).toBe(true);
      yes++;
    }
    expect(yes, "anti-vacuity: every plan code judged").toBe(14);
    const others = ["SEQ_CONFLICT", "SCHEDULE_LOCKED", "FORMAT_LOCKED", "swiss_undo_round_started", "", "toString", "__proto__", "constructor", undefined, null, 409];
    for (const other of others) expect(isSwissRefusalCode(other), String(other)).toBe(false);
    expect(others.length).toBe(11);
  });

  it("SWISS_ADHOC_REFUSED carries the RB3-15 guidance (spec §8 Q1 A, ruling 252)", () => {
    expect(SWISS_REFUSALS.SWISS_ADHOC_REFUSED).toMatchObject({
      status: 422,
      message: "Swiss rounds are paired by the system. Add friendlies in another stage.",
    });
  });
});

describe("swissRefusal (server)", () => {
  it("builds the HttpError from the table: status, code, the English sentence, and the details as the body's extra", () => {
    const err = swissRefusal("SWISS_ROUNDS_LOCKED", { canFinish: true, canAddRound: false });
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({
      status: SWISS_REFUSALS.SWISS_ROUNDS_LOCKED.status,
      code: "SWISS_ROUNDS_LOCKED",
      message: SWISS_REFUSALS.SWISS_ROUNDS_LOCKED.message,
      extra: { canFinish: true, canAddRound: false },
    });
  });

  // W3 T11 (controller status rule): SWISS_ROUNDS_ABOVE_MAX is a 422 as sent (Generate or Start with that round count can
  // never succeed), and a 409 when the field shrank under a running Swiss — resolvable another way (Finish the Swiss
  // after the completed rounds; a late player). Every other code has ONE status, and asking it for a second is refused.
  it("SWISS_ROUNDS_ABOVE_MAX: 422 as sent, 409 when resolvable; no other code declares a resolvable status", () => {
    expect(SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX).toMatchObject({ status: 422, resolvableStatus: 409 });
    expect(swissRefusal("SWISS_ROUNDS_ABOVE_MAX", { canFinish: false })).toMatchObject({ status: 422, code: "SWISS_ROUNDS_ABOVE_MAX" });
    expect(swissRefusal("SWISS_ROUNDS_ABOVE_MAX", { canFinish: true }, { resolvable: true })).toMatchObject({
      status: 409,
      code: "SWISS_ROUNDS_ABOVE_MAX",
      message: SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message,
      extra: { canFinish: true },
    });
    let others = 0;
    for (const code of PLAN_CODES.filter((c) => c !== "SWISS_ROUNDS_ABOVE_MAX")) {
      expect(SWISS_REFUSALS[code].resolvableStatus, code).toBeUndefined();
      expect(() => swissRefusal(code, undefined, { resolvable: true }), code).toThrow(/declares no resolvable status/);
      others++;
    }
    expect(others, "anti-vacuity: every other code judged").toBe(PLAN_CODES.length - 1);
  });

  it("with no details carries no extra (the envelope adds nothing)", () => {
    const err = swissRefusal("SWISS_ADHOC_REFUSED");
    expect(err).toMatchObject({ status: 422, code: "SWISS_ADHOC_REFUSED" });
    expect(err.extra).toBeUndefined();
  });
});
