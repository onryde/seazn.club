import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// RS007 #20b. `claim.*` is an ESTABLISHED, DIFFERENT product concept: an
// account taking ownership of a player profile ("Invite to claim",
// "Claimed", "claim link" — ui.json `claim.*`). The registration join flow
// is not that: a person confirms they are the human a captain typed onto a
// roster row. #20 renamed the roster ROW STATES onto a check-in metaphor
// but left the surrounding copy on "claim", so one card showed
// "Not checked in" and "Send {name} their claim link" three lines apart —
// re-conflating the two concepts in the one spot a reader acts on.
//
// This pins the vocabulary rather than the wording: the strings may be
// reworded freely, they may not reach back for the profile-claim verb.
// Scoped to the join flow's own keys, so the real `claim.*` namespace and
// every other surface are untouched by it.
const LOCALES = ["en", "fr", "es", "nl"] as const;

// Each locale's own claim-verb root, not a translation of the English one:
// fr réclamer, es reclamar, nl claimen/geclaimd.
const CLAIM_VOCABULARY: Record<(typeof LOCALES)[number], RegExp> = {
  en: /\bclaim(s|ed|ing)?\b/i,
  fr: /réclam/i,
  es: /reclam/i,
  nl: /claim/i,
};

const inJoinFlow = (key: string) =>
  key.startsWith("register.status.roster.") || key.startsWith("register.join.");

function dictionary(locale: string): Record<string, string> {
  const path = join(process.cwd(), "src/dictionaries", locale, "ui.json");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

describe("the registration join flow does not borrow the profile-claim vocabulary (RS007 #20b)", () => {
  for (const locale of LOCALES) {
    it(`${locale}: no join-flow string uses the claim verb`, () => {
      const dict = dictionary(locale);
      const keys = Object.keys(dict).filter(inJoinFlow);
      // Guard the guard: a key-prefix rename would otherwise make this pass
      // by matching nothing at all.
      expect(keys.length, `no ${locale} keys matched the join-flow prefixes`).toBeGreaterThan(15);

      // Placeholder NAMES are not reader-facing — `{claimed}` is the
      // interpolation slot #20 deliberately left alone (renaming it would
      // touch every call site for no reader benefit). Strip them, or this
      // guard fails on `"{claimed} of {total} checked in"`, which is
      // exactly the copy it is meant to bless.
      const offenders = keys
        .filter((k) => CLAIM_VOCABULARY[locale].test(dict[k]!.replace(/\{[^}]*\}/g, " ")))
        .map((k) => `${k} = ${JSON.stringify(dict[k])}`);
      expect(
        offenders,
        `these ${locale} join-flow strings reach for the profile-claim verb; ` +
          `use this locale's check-in wording instead (see register.status.roster.claimed)`,
      ).toEqual([]);
    });
  }

  it("the profile-claim namespace itself is untouched — the two concepts stay separate", () => {
    const en = dictionary("en");
    // If this ever goes empty the test above has stopped meaning anything:
    // there would be no second concept left to collide with.
    const profileClaimKeys = Object.keys(en).filter((k) => k.startsWith("claim."));
    expect(profileClaimKeys.length).toBeGreaterThan(5);
    expect(en["claim.claimed"]).toMatch(/\bclaimed\b/i);
  });
});
