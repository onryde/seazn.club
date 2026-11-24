// SEEDING_* error-code -> organiser copy (P6/D4b task B, owner ruling: wire
// the 13 shipped codes only, ×4 locales, plus the resolver that renders a
// code into copy — see docs/superpowers/plans/2026-08-13-p6-progression-ui-plan.md
// "Owner ruling — SEEDING_* error copy is P6's, scoped"). The wire codes are
// HttpError codes thrown by computeSeedProposal/confirmSeedProposal
// (server/usecases/stages/), ALL_CAPS_SNAKE by repo convention
// (api-v1/schemas/) — never i18n keys themselves. This module is the
// ONE place a code becomes display text.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROPOSAL_STALE_REDRAWN, PROPOSAL_STALE_SUPERSEDED, seedingErrorMessage, SEEDING_ERROR_CODES, type SeedingErrorCode } from "@/lib/seeding-error";
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

  it("SEEDING_ERROR_CODES lists exactly the 13 shipped codes, plus F3 review item 4's SEEDING_MAP_SOURCE_AMBIGUOUS, F6's SEEDING_CARRY_SOURCE_INVALID the withdrawn-qualifier refusal, the empty-draw refusal and W5's two best-Nth refusals", () => {
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
      // confirmSeedProposal's departed-qualifier refusal: an entrant about to
      // be filled into the bracket has withdrawn or been disqualified. Her
      // seat is left empty (nobody is promoted into it — owner decision
      // pending), so the copy tells the organiser to recompute rather than to
      // go looking for a roster mistake, which is why it is not
      // SEEDING_ENTRANT_FOREIGN.
      "SEEDING_ENTRANT_WITHDRAWN",
      // confirmSeedProposal's empty-draw refusal (review finding F1). Before
      // the departed-qualifier filter a resolvable progression always had at
      // least one qualifier; now it can have none, and confirming an empty
      // draw used to succeed and burn the terminal `confirmed` status.
      "SEEDING_NOTHING_TO_FILL",
      // W4 app PR B (M4): a roundLosers take from a double-elimination source.
      "SEEDING_ROUNDLOSERS_DE_SOURCE",
      // W4 app PR B (Task 8): a firstLosses take from a double-elimination source.
      "SEEDING_FIRSTLOSSES_DE_SOURCE",
      // W5 app PR B (Task 4, K19): engine 10's best-Nth STAGE_NOT_READY reasons, named (`bestNthRefusal`).
      "SEEDING_BESTNTH_NO_SUPPLIER",
      "SEEDING_POOL_RESULTS_MISSING",
      "SEEDING_POOL_SEPARATION_IMPOSSIBLE",
      "SEEDING_PAGE_PLAYOFF_NEEDS_FOUR",
      "SEEDING_CROSS_POOL_DRAW_INVALID",
      // W5 app PR B D-B2-2: a cross-pool draw past the builder's bounds, refused by name before the engine's search.
      "SEEDING_CROSS_POOL_DRAW_TOO_LARGE",
      // W5 follow-ups A2: a Top N (rankRange) take saved against a source of several groups, refused at save by name.
      "SEEDING_TOP_N_ACROSS_GROUPS",
      // Add stage after groups (owner Option C): a count under a knockout's minimum, refused at save.
      "SEEDING_QUALIFY_TOO_FEW",
    ];
    expect([...SEEDING_ERROR_CODES].sort()).toEqual([...expected].sort());
  });
});

describe("seedingErrorMessage — real dictionaries, all 4 locales, every code", () => {
  for (const locale of LOCALES) {
    for (const code of SEEDING_ERROR_CODES) {
      it(`${locale}: ${code} resolves to real copy — never the raw code, never the PREFIXED dictionary key, never empty, no leftover {placeholder}`, () => {
        // W5 app PR B T4: the two best-Nth refusals carry the engine's numbers (rank, available, pool); every code is given them
        // and a code that names none ignores them, so the leftover-{placeholder} check still catches a misspelt name.
        const out = seedingErrorMessage(locale, code, "SHOULD_NOT_SEE_FALLBACK", { rank: 3, available: 2, pool: "A", count: 5, entrants: 8, reason: "tier_invalid", pools: 9, maxPools: 8, maxEntrants: 32, min: 2, qualified: 1 });
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

// W5 stress fix F5: SEEDING_PROPOSAL_STALE with `reason: "superseded"` (a newer draft replaced this one) renders its own copy,
// never "standings changed". Expected values are the dictionary files' own entries, read here, not the resolver's output.
describe("seedingErrorMessage — a superseded draft (F5)", () => {
  const files = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(resolve(__dirname, `../../dictionaries/${l}/errors.json`), "utf8")) as Record<string, string>]),
  );
  let checked = 0;
  for (const locale of LOCALES) {
    it(`${locale}: reason superseded -> the superseded copy; no reason -> the standings copy`, () => {
      const superseded = files[locale]!["seeding.proposalSuperseded"];
      const stale = files[locale]!["seeding.SEEDING_PROPOSAL_STALE"];
      expect(superseded, `${locale} has the copy`).toBeTypeOf("string");
      expect(superseded).not.toBe(stale);
      expect(seedingErrorMessage(locale, "SEEDING_PROPOSAL_STALE", "x", { reason: PROPOSAL_STALE_SUPERSEDED, newer: "p2" })).toBe(superseded);
      expect(seedingErrorMessage(locale, "SEEDING_PROPOSAL_STALE", "x")).toBe(stale);
      // Another code carrying the same reason is not re-routed: the variant is SEEDING_PROPOSAL_STALE's alone.
      expect(seedingErrorMessage(locale, "SEEDING_ALREADY_CONFIRMED", "x", { reason: PROPOSAL_STALE_SUPERSEDED })).toBe(files[locale]!["seeding.SEEDING_ALREADY_CONFIRMED"]);
      checked++;
    });
  }
  it("anti-vacuity: every locale was checked", () => {
    expect(checked).toBe(LOCALES.length);
  });
});

// W5 app PR B review I-1: SEEDING_PROPOSAL_STALE with `reason: "redrawn"` (a tie answer re-drew round one, so the confirm's other edits
// were stored as a new draft to make again) renders its own copy - never "standings changed", never the superseded copy. Expected
// values are the dictionary files' own entries, read here.
describe("seedingErrorMessage — a re-drawn draft (I-1)", () => {
  const files = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(resolve(__dirname, `../../dictionaries/${l}/errors.json`), "utf8")) as Record<string, string>]),
  );
  let checked = 0;
  for (const locale of LOCALES) {
    it(`${locale}: reason redrawn -> the redrawn copy, distinct from the standings and superseded copies`, () => {
      const redrawn = files[locale]!["seeding.proposalRedrawn"];
      expect(redrawn, `${locale} has the copy`).toBeTypeOf("string");
      expect(redrawn).not.toBe(files[locale]!["seeding.SEEDING_PROPOSAL_STALE"]);
      expect(redrawn).not.toBe(files[locale]!["seeding.proposalSuperseded"]);
      expect(seedingErrorMessage(locale, "SEEDING_PROPOSAL_STALE", "x", { reason: PROPOSAL_STALE_REDRAWN, reproposed: "p2" })).toBe(redrawn);
      checked++;
    });
  }
  it("anti-vacuity: every locale was checked, and the copies differ across locales", () => {
    expect(checked).toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => files[l]!["seeding.proposalRedrawn"])).size).toBe(LOCALES.length);
  });
});
