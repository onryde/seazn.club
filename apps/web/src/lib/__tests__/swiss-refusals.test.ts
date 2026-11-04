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
  // UI5 item 4 (owner 2026-11-03): a chess Swiss always balances colours; switching them off is refused by name.
  "SWISS_CHESS_ALWAYS_ON",
  "SWISS_ROUNDS_BELOW_SEATED",
  "SWISS_FINISH_ROUND_UNDECIDED",
  "SWISS_FINISH_NOTHING_PLAYED",
  "STAGE_NOT_SWISS",
  // T18 (RB3-7(c), X-SW-18): requested half/zero byes are deferred. A BODY refusal raised from the zod issue by `http.ts`
  // (the stage-decider precedent), so a 400 like every other body validation, not the 409/422 of a usecase refusal.
  "SWISS_REQUESTED_BYES_DEFERRED",
  // App-B T1 (X-SW-3, engine 2.0.0 `pairRound`'s refusal): a round with no legal pairing. 422 as sent, 409 when Finish is
  // the way out (R5 of the app-B pre-flight scan; the `judgeSwissRoundsAt` precedent above).
  "SWISS_NO_LEGAL_PAIRING",
] as const;

/** The codes whose cause is either kind of refusal: a 422 as sent, a 409 when the organiser can resolve it another way
 *  (`resolvableStatus`). Typed here, not read off the table under test. */
const RESOLVABLE_CODES = ["SWISS_ROUNDS_ABOVE_MAX", "SWISS_NO_LEGAL_PAIRING"] as const;

/** Codes raised at the body door, from a zod issue (`api-v1/http.ts`), not by a usecase: they answer 400. */
const BODY_REFUSALS: readonly string[] = ["SWISS_REQUESTED_BYES_DEFERRED"];

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
      if (BODY_REFUSALS.includes(code)) {
        expect(row.status, `${code}: a body refusal is a 400, as every other body validation`).toBe(400);
      } else {
        expect([409, 422], `${code}: a refusal is a 409 (a state the organiser resolves) or a 422 (never succeeds as sent)`).toContain(row.status);
      }
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
    // Anti-vacuity: 17 codes × 4 locales. Zero checked is a failure, not a pass.
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
    expect(yes, "anti-vacuity: every plan code judged").toBe(17);
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

  // App-B T1 (X-SW-3; R5): the row `swissGen` raises when the engine's `pairRound` answers `ok: false`. Its statuses are read
  // off the table by every caller (the wire, the smoke check), never typed at a call site.
  it("SWISS_NO_LEGAL_PAIRING has a row with status 422 and a key present in all 4 locales", () => {
    const row = SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING;
    expect(row, "the row exists").toBeDefined();
    expect(row).toMatchObject({ status: 422, resolvableStatus: 409, key: "swiss.refusal.SWISS_NO_LEGAL_PAIRING" });
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const text = dict[row.key];
      expect(typeof text === "string" && text.trim() !== "", `${locale}/ui.json has ${row.key}`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: 4 locales checked").toBe(4);
    expect(en[row.key as keyof typeof en], "one English sentence, not two").toBe(row.message);
  });

  it("SWISS_REQUESTED_BYES_DEFERRED carries the RB3-7(c) guidance (spec §8 Q5, ruling 252): a walkover is the way out", () => {
    expect(SWISS_REFUSALS.SWISS_REQUESTED_BYES_DEFERRED).toMatchObject({
      status: 400,
      message:
        "Requested half-point or zero-point byes aren't offered yet. If a player must miss a round, record a walkover on their board.",
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
    for (const code of PLAN_CODES.filter((c) => !(RESOLVABLE_CODES as readonly string[]).includes(c))) {
      expect(SWISS_REFUSALS[code].resolvableStatus, code).toBeUndefined();
      expect(() => swissRefusal(code, undefined, { resolvable: true }), code).toThrow(/declares no resolvable status/);
      others++;
    }
    expect(others, "anti-vacuity: every other code judged").toBe(PLAN_CODES.length - RESOLVABLE_CODES.length);
  });

  // App-B T1 (X-SW-3; R5): the second code that declares a resolvable status. 422 as sent (no legal pairing can be found
  // by re-sending); 409 when Finish is the way out (the organiser resolves it another way). Both read off the table.
  it("SWISS_NO_LEGAL_PAIRING: 422 as sent, 409 when resolvable, both from the table, with the details as the body's extra", () => {
    const row = SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING;
    const details = { round: 4, reason: "rematch", field: 6 };
    expect(swissRefusal("SWISS_NO_LEGAL_PAIRING", details)).toMatchObject({
      status: row.status,
      code: "SWISS_NO_LEGAL_PAIRING",
      message: row.message,
      extra: details,
    });
    expect(swissRefusal("SWISS_NO_LEGAL_PAIRING", details, { resolvable: true })).toMatchObject({
      status: row.resolvableStatus,
      code: "SWISS_NO_LEGAL_PAIRING",
    });
    expect([row.status, row.resolvableStatus], "the two statuses differ, so the choice is witnessed").toEqual([422, 409]);
  });

  it("with no details carries no extra (the envelope adds nothing)", () => {
    const err = swissRefusal("SWISS_ADHOC_REFUSED");
    expect(err).toMatchObject({ status: 422, code: "SWISS_ADHOC_REFUSED" });
    expect(err.extra).toBeUndefined();
  });
});
