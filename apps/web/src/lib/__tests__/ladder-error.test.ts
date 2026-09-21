// LADDER_* error-code -> organiser copy. The ladder console rendered
// `err.message` — the server's own English prose — for every challenge
// refusal, in all four locales. These are the wire codes `issueChallenge`
// (server/usecases/stages.ts) throws; this module is the ONE place a code
// becomes display text. Mirrors seeding-error.test.ts, deliberately.
import { describe, expect, it } from "vitest";
import { ladderErrorMessage, LADDER_ERROR_CODES, type LadderErrorCode } from "@/lib/ladder-error";
import { LOCALES } from "@/lib/i18n-constants";

describe("ladderErrorMessage — mechanics", () => {
  it("an unknown/non-LADDER code falls back to the caller-supplied fallback verbatim", () => {
    expect(ladderErrorMessage("en", "SOME_OTHER_CODE", undefined, "raw server message")).toBe(
      "raw server message",
    );
  });

  it("PAYMENT_REQUIRED and SCHEDULE_LOCKED are not this resolver's business", () => {
    expect(ladderErrorMessage("en", "PAYMENT_REQUIRED", undefined, "pay up")).toBe("pay up");
    expect(ladderErrorMessage("en", "SCHEDULE_LOCKED", undefined, "frozen")).toBe("frozen");
  });

  it("LADDER_ERROR_CODES lists exactly the four refusals the challenge form can raise", () => {
    const expected: LadderErrorCode[] = [
      "LADDER_ENTRANT_FOREIGN",
      "LADDER_ENTRANT_WITHDRAWN",
      "LADDER_CHALLENGE_NOT_UPWARD",
      "LADDER_CHALLENGE_OUT_OF_RANGE",
    ];
    expect([...LADDER_ERROR_CODES].sort()).toEqual([...expected].sort());
  });

  it("the range refusal names the number the server sent, in every locale", () => {
    for (const locale of LOCALES) {
      const out = ladderErrorMessage(locale, "LADDER_CHALLENGE_OUT_OF_RANGE", { range: 4 }, "fallback");
      expect(out, `${locale} dropped the range`).toContain("4");
      expect(out).not.toBe("fallback");
      // A different number must produce different copy, or the test could not
      // witness a resolver that ignores `extra` and hard-codes a value.
      const other = ladderErrorMessage(
        locale,
        "LADDER_CHALLENGE_OUT_OF_RANGE",
        { range: 7 },
        "fallback",
      );
      expect(other).not.toBe(out);
      expect(other).toContain("7");
    }
  });

  it("a range refusal with nothing to name degrades to the server's English, never a sentence with a hole in it", () => {
    for (const extra of [undefined, {}, { range: "4" }, { range: Number.NaN }]) {
      const out = ladderErrorMessage(
        "nl",
        "LADDER_CHALLENGE_OUT_OF_RANGE",
        extra as { range?: unknown },
        "server english",
      );
      expect(out, `extra ${JSON.stringify(extra)} rendered a hole`).toBe("server english");
    }
  });
});

describe("ladderErrorMessage — real dictionaries, all 4 locales, every code", () => {
  for (const locale of LOCALES) {
    for (const code of LADDER_ERROR_CODES) {
      it(`${locale}: ${code} resolves to real copy — never the raw code, never the PREFIXED key, never empty, no leftover {placeholder}`, () => {
        const out = ladderErrorMessage(locale, code, { range: 3 }, "SHOULD_NOT_SEE_FALLBACK");
        expect(out).not.toBe("SHOULD_NOT_SEE_FALLBACK");
        expect(out).not.toBe(code);
        // t()'s missing-key fallback (i18n-runtime.ts) returns the full
        // PREFIXED key, so `not.toBe(code)` alone would miss a real gap.
        expect(out.startsWith("ladder.")).toBe(false);
        expect(out.length).toBeGreaterThan(0);
        expect(out).not.toMatch(/\{[a-zA-Z]+\}/);
      });
    }
  }

  it("locales actually differ from English (proves real translation, not a copy-paste)", () => {
    for (const code of LADDER_ERROR_CODES) {
      const all = LOCALES.map((l) => ladderErrorMessage(l, code, { range: 3 }, "x"));
      expect(new Set(all).size, `${code} is not translated in all four locales`).toBe(LOCALES.length);
    }
  });
});
