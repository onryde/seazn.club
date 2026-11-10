// W3 T11 review I1 — the division page's Rebuild (`stages-panel.tsx` `rebuildStage` → `rebuildErrorText`) mints the
// Swiss again against today's field, so it can be refused SWISS_ROUNDS_ABOVE_MAX (422 as sent). Before this the line fell
// through `ruleRefusalOf` (null for a Swiss code) to `err.message`: the server's English in every locale. It now says the
// dictionary's refusal and the field's guidance (rulebook §3.2 for a field of 4: 2 rounds recommended, at most 3).
//
// Asserted in Spanish and French: the English dictionary sentence equals the server's message, so only a non-English
// locale tells the localised path from the raw one (review m6). `rebuildErrorText` is exported pure for the reason the
// panel gives — the panel's tests never fire the Rebuild handler, which hands it the island's own `msg`/`msgPlural`.
//
// Single-sport by nature: the refusal's details are numbers; no sport field reaches the line.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import { addStageErrorText, rebuildErrorText } from "@/components/v2/stages-panel";

const DICTS = { es: esUi, fr: frUi } as unknown as Record<"es" | "fr", Dict & Record<string, string>>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

describe.each(["es", "fr"] as const)("rebuildErrorText — a Rebuild refused above a Swiss's hard maximum (X-SW-16) [%s]", (locale) => {
  const D = DICTS[locale];
  const msg = (key: string, vars?: Record<string, string | number>) => tRuntime(D, key, vars);
  const msgPlural = (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(D, key, count, locale, vars);
  const english = SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message;

  it("says the refusal and the field's guidance in the reader's language, never the server's English", () => {
    const err = new ApiV1Error(english, 422, "SWISS_ROUNDS_ABOVE_MAX", { rounds: 5, field: 4, hardMax: 3, canFinish: false });
    const line = rebuildErrorText(err, msg as never, msgPlural);
    expect(line).toBe(`${D["swiss.refusal.SWISS_ROUNDS_ABOVE_MAX"]} ${fill(D["swiss.rounds.guidance.other"]!, { n: 4, count: 2, hardMax: 3 })}`);
    expect(line).not.toContain(english);
  });

  it("W4 T15: a Rebuild refused by the field's size says the bound in the reader's language (X-PL-1, X-QM-5)", () => {
    const plate = KNOCKOUT_REFUSALS.KO_PLATE_TOO_FEW;
    expect(rebuildErrorText(new ApiV1Error(plate.en, plate.status, "KO_PLATE_TOO_FEW", { min: 4 }), msg as never, msgPlural)).toBe(D[plate.key]);
    const main = KNOCKOUT_REFUSALS.QUALIFYING_MAIN_TOO_FEW;
    const line = rebuildErrorText(new ApiV1Error(main.en.replace("{min}", "8"), main.status, "QUALIFYING_MAIN_TOO_FEW", { min: 8 }), msg as never, msgPlural);
    expect(line).toBe(fill(D[main.key]!, { min: 8 }));
    expect(line).not.toContain("{min}");
  });

  it("W4 T15: Add stage after a knockout, with a Top N that is no whole round, says so in the reader's language (X-QM-2)", () => {
    const row = KNOCKOUT_REFUSALS.KO_CUT_NOT_WHOLE_ROUND;
    const line = addStageErrorText(new ApiV1Error(row.en, row.status, "KO_CUT_NOT_WHOLE_ROUND", { width: 3 }), msg as never);
    expect(line).toBe(D[row.key]);
    expect(line).not.toBe(row.en);
    expect(addStageErrorText(new ApiV1Error("division is mid-solve", 409, "BUSY"), msg as never), "the negative pair").toBe("division is mid-solve");
    expect(addStageErrorText("not an error", msg as never), "the unknown throw").toBe(D["schedule.error.failed"]);
  });

  it("the negative pair: an unrecognised refusal keeps its own message", () => {
    expect(rebuildErrorText(new ApiV1Error("division is mid-solve", 409, "BUSY"), msg as never, msgPlural)).toBe("division is mid-solve");
  });
});
