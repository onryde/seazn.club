// W5 follow-up (RB5-D4 copy; w2d e2e fix report, "open product question"): the three refusals a cross-pool draw raises when a take
// cannot be seated - SEEDING_POOL_SEPARATION_IMPOSSIBLE, SEEDING_PAGE_PLAYOFF_NEEDS_FOUR, SEEDING_CROSS_POOL_DRAW_TOO_LARGE - used to
// tell the organiser to change how many go through, or add a group. Neither can be done where the refusal is seen: the draw is only
// made once the source stage is complete, so results exist and the division's format is LOCKED (FORMAT_LOCKED).
//
// The facts the copy now rests on, each proved against the REAL usecases (not here - this file is the copy's own reader) in
// `server/usecases/__tests__/cross-pool-draw.test.ts` "organiser copy premises", at both doors that raise the refusal:
//   1. the format is locked (divisionFormatLocked, replaceStages -> FORMAT_LOCKED);
//   2. the stage the qualifiers were going into holds nothing played, deletes, and the group results stay;
//   3. "Add stage" is NOT a way out: it takes Top N of ONE table (a `rankRange`), which the engine cannot read from a source of
//      several groups, so the copy must not send the organiser there.
// So the sentence names the delete door, by the verb the control itself carries, and offers none of the advice the lock forbids.
//
// The expected words come from the product's own declarations (the delete and Add-stage controls' labels in ui.json); only the
// retired advice is a typed table - it is what this change removed, and has no declaration to derive from.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { completedSeedingFailedText, STAGE_COMPLETED_SEEDING_FAILED } from "@/lib/completed-seeding-failed";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { CROSS_POOL_REFUSAL_CODES, seedingErrorMessage } from "@/lib/seeding-error";

/** The refusals that say a take cannot be seated (not CROSS_POOL_DRAW_INVALID: a wiring fault, whose copy is "recompute"). */
const UNSEATABLE = ["SEEDING_POOL_SEPARATION_IMPOSSIBLE", "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR", "SEEDING_CROSS_POOL_DRAW_TOO_LARGE"] as const;

/** Every variable any of the three copies names, so a misspelt `{name}` is caught as a leftover. */
const VARS = { pool: "B", count: 3, entrants: 4, shape: "single_elim", pools: 9, maxPools: 8, maxEntrants: 32 };

/** The advice the format lock forbids, as each locale said it before (change the take / add a group / fewer groups / list seats). */
const RETIRED: Record<Locale, RegExp> = {
  en: /change how many|add a group|fewer groups|list the seats/i,
  es: /cambia cu[aá]ntos|a[ñn]ade un grupo|menos grupos|indica t[uú] mismo/i,
  fr: /changez le nombre|ajoutez un groupe|moins de groupes|indiquez vous-m[eê]me/i,
  nl: /verander hoeveel|voeg een groep toe|minder groepen|wijs de plaatsen zelf/i,
};

/** The stem of the Delete control's own verb (the imperative inflects, the first five letters do not). */
const deleteStem = (locale: Locale) => msgFor(locale, "schedule.delete").slice(0, 5).toLowerCase();
/** The Add-stage control's own label: the copy must not send the organiser to a control that cannot re-take from groups. */
const addStageLabel = (locale: Locale) => msgFor(locale, "schedule.addStageBtn").toLowerCase();

describe("cross-pool refusals that cannot be seated name the door that opens, never the one the format lock shut", () => {
  it("premise: the three are cross-pool refusals the wrapper reads (else the sweep below is vacuous)", () => {
    for (const code of UNSEATABLE) expect(CROSS_POOL_REFUSAL_CODES.has(code), code).toBe(true);
    expect(LOCALES.length).toBe(4);
  });

  it("every locale x refusal: it names the delete (the control's own verb), offers no retired advice, never Add stage, fills every slot", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const code of UNSEATABLE) {
        const out = seedingErrorMessage(locale, code, "SHOULD_NOT_SEE_FALLBACK", VARS);
        expect(out, `${locale} ${code}: the dictionary's copy`).not.toBe("SHOULD_NOT_SEE_FALLBACK");
        expect(out.toLowerCase(), `${locale} ${code}: names the delete door`).toContain(deleteStem(locale));
        expect(out, `${locale} ${code}: no advice the format lock forbids`).not.toMatch(RETIRED[locale]);
        expect(out.toLowerCase(), `${locale} ${code}: Add stage cannot re-take from groups`).not.toContain(addStageLabel(locale));
        expect(out, `${locale} ${code}: every slot filled`).not.toMatch(/\{\w+\}/);
        checked++;
      }
    }
    expect(checked, "3 refusals x 4 locales").toBe(12);
  });

  it("the Complete door's 'completed, but' sentence carries the same remedy, in the reader's language", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const msg = (key: Parameters<typeof msgFor>[1], vars?: Record<string, string | number>) => msgFor(locale, key, vars);
      for (const code of UNSEATABLE) {
        // completion.ts's wrap: the refusal's own fields plus `cause` (its code) and the two stage ids.
        const wrapped = new ApiV1Error("raw server english", 409, STAGE_COMPLETED_SEEDING_FAILED, { ...VARS, cause: code, stageId: "s1", nextStageId: "s2" });
        const out = completedSeedingFailedText(wrapped, msg, locale);
        expect(out, `${locale} ${code}: the wrapper reads it`).not.toBeNull();
        expect(out!.toLowerCase(), `${locale} ${code}: names the delete door`).toContain(deleteStem(locale));
        expect(out!, `${locale} ${code}: no advice the format lock forbids`).not.toMatch(RETIRED[locale]);
        expect(out!, `${locale} ${code}: never the server's English`).not.toContain("raw server english");
        checked++;
      }
    }
    expect(checked, "3 refusals x 4 locales").toBe(12);
  });
});
