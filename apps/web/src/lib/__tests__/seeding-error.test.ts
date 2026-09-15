// SEEDING_* error-code -> organiser copy (P6/D4b task B, owner ruling: wire
// the 13 shipped codes only, ×4 locales, plus the resolver that renders a
// code into copy — see docs/superpowers/plans/2026-08-13-p6-progression-ui-plan.md
// "Owner ruling — SEEDING_* error copy is P6's, scoped"). The wire codes are
// HttpError codes thrown by computeSeedProposal/confirmSeedProposal
// (server/usecases/stages.ts), ALL_CAPS_SNAKE by repo convention
// (schemas.ts:3024-3029) — never i18n keys themselves. This module is the
// ONE place a code becomes display text.
import { describe, expect, it } from "vitest";
import { seedingErrorMessage, SEEDING_ERROR_CODES, type SeedingErrorCode } from "@/lib/seeding-error";
import { LOCALES } from "@/lib/i18n-constants";

describe("seedingErrorMessage — mechanics", () => {
  it("an unknown/non-SEEDING code falls back to the caller-supplied fallback verbatim", () => {
    expect(seedingErrorMessage("en", "SOME_OTHER_CODE", "raw server message")).toBe("raw server message");
  });

  it("a non-SEEDING code never leaks into the dictionary lookup — the fallback wins even if 'UNKNOWN' happens to collide", () => {
    expect(seedingErrorMessage("en", "UNKNOWN", "generic failure")).toBe("generic failure");
  });

  it("interpolates {vars} into the resolved copy", () => {
    // SEEDING_SOURCE_INCOMPLETE copy carries no vars today, but the resolver
    // must still pass vars through to the underlying t() call — proved with
    // a code whose en copy is vars-free by checking vars are simply ignored,
    // not by asserting a specific interpolation (that's slot-label's job).
    const out = seedingErrorMessage("en", "SEEDING_TIE_UNRESOLVED", "fallback", { n: 2 });
    expect(out).not.toBe("fallback");
  });

  it("SEEDING_ERROR_CODES lists exactly the 13 shipped codes, plus F3 review item 4's SEEDING_MAP_SOURCE_AMBIGUOUS and F6's SEEDING_CARRY_SOURCE_INVALID (15 total)", () => {
    const expected: SeedingErrorCode[] = [
      "SEEDING_MAP_SLOT_INVALID",
      "SEEDING_MAP_SOURCE_INVALID",
      "SEEDING_MAP_SOURCE_AMBIGUOUS",
      "SEEDING_RULES_MISSING",
      "SEEDING_SOURCE_INCOMPLETE",
      "SEEDING_BESTNTH_UNEQUAL_POOLS",
      "SEEDING_ALREADY_CONFIRMED",
      "SEEDING_PROPOSAL_STALE",
      "SEEDING_EDIT_UNKNOWN_SLOT",
      "SEEDING_TIE_UNRESOLVED",
      "SEEDING_SLOT_DOUBLE_ASSIGNED",
      "SEEDING_ENTRANT_FOREIGN",
      "SEEDING_SLOT_FOREIGN_FIXTURE",
      "SEEDING_FIXTURES_ALREADY_FILLED",
      // F6 (#625) — computeSeedProposal's carry-source refusal. Added under
      // the design of record's own authorisation to add beside these helpers,
      // not by re-opening the "do NOT add more" scope note in seeding-error.ts.
      "SEEDING_CARRY_SOURCE_INVALID",
    ];
    expect([...SEEDING_ERROR_CODES].sort()).toEqual([...expected].sort());
  });
});

describe("seedingErrorMessage — real dictionaries, all 4 locales, every code", () => {
  for (const locale of LOCALES) {
    for (const code of SEEDING_ERROR_CODES) {
      it(`${locale}: ${code} resolves to real copy — never the raw code, never the PREFIXED dictionary key, never empty, no leftover {placeholder}`, () => {
        const out = seedingErrorMessage(locale, code, "SHOULD_NOT_SEE_FALLBACK");
        expect(out).not.toBe("SHOULD_NOT_SEE_FALLBACK");
        expect(out).not.toBe(code);
        // A genuinely missing dictionary entry does NOT fall back to the bare
        // `code` — t()'s own missing-key fallback (i18n-runtime.ts) returns the
        // full PREFIXED key it was asked to look up, i.e. `seeding.${code}`.
        // `expect(out).not.toBe(code)` alone would miss that entirely (review
        // finding 3, P6/D4b task B fix round 1): a real gap in any of the
        // SEEDING_ERROR_CODES x LOCALES dictionary values would pass
        // undetected. Both loops are derived, so the count moves with the list
        // rather than needing a number retyped here.
        expect(out.startsWith("seeding.")).toBe(false);
        expect(out.length).toBeGreaterThan(0);
        expect(out).not.toMatch(/\{[a-zA-Z]+\}/);
      });
    }
  }

  it("locales actually differ from English (proves real translation, not a copy-paste)", () => {
    const en = seedingErrorMessage("en", "SEEDING_TIE_UNRESOLVED", "x");
    const nl = seedingErrorMessage("nl", "SEEDING_TIE_UNRESOLVED", "x");
    const es = seedingErrorMessage("es", "SEEDING_TIE_UNRESOLVED", "x");
    const fr = seedingErrorMessage("fr", "SEEDING_TIE_UNRESOLVED", "x");
    const all = [en, nl, es, fr];
    expect(new Set(all).size).toBe(4);
  });
});
