// B05 — the override dialog rendered `{issue.message}`, the raw English
// sentence the SERVER built (registration-rules.ts's `EligibilityIssue.message`
// is documented as "English, the display fallback … a locale-aware surface
// renders off `code` instead"), inside a component whose own header cites
// AGENTS.md's "all 4 locale dictionaries, never hardcoded English" for every
// OTHER string it renders. A non-English organiser read the refusal reasons in
// English while the dialog around them was translated.
//
// Two surfaces already rendered off `code` — `INELIGIBLE_MESSAGE_KEY`
// (public-site/register/eligibility-presentation.ts, registrant-facing) and
// `ISSUE_I18N` (import-wizard.tsx, but for the disjoint IMPORT-PLAN code space:
// DIVISION_NOT_FOUND/AMBIGUOUS_PERSON/…, not `EligibilityCode` at all). This
// dialog is the organiser-facing one, and it is mounted by BOTH organiser
// surfaces (entrants-panel.tsx and import-wizard.tsx), so one map here covers
// both without a third private copy.
//
// `renderToStaticMarkup` under a real `DictProvider`, the convention
// `eligibility-override-dialog-i18n.test.tsx` beside this file already uses.
// Expected sentences are DERIVED FROM THE DICTIONARY, never typed in here, so
// a copy change moves the test with it (AGENTS.md rule 19) — only the NUMBER
// and the codes are pinned by hand.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";
import type { EligibilityIssue } from "@/lib/registration-rules";

const enDict = en as unknown as Dict;
const esDict = es as unknown as Dict;
const enText = en as unknown as Record<string, string>;
const esText = es as unknown as Record<string, string>;

function render(violations: EligibilityIssue[], dict: Dict, locale: "en" | "es"): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <EligibilityOverrideDialog
        open={true}
        violations={violations}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </DictProvider>,
  );
}

/** The exact sentence `ageBandEligibilityIssues` (registration-rules.ts) puts
 *  on the wire for an over-age player, limit and all. */
function ageTooOld(limit: number): EligibilityIssue {
  return {
    code: "AGE_TOO_OLD",
    message: `Too old for this division (must be ${limit} or younger on the cutoff date).`,
    meta: { limit },
    playerIndex: 1,
    playerName: "Alex Doe",
  };
}

const KEY = {
  ageTooOld: "divset.entrants.eligibilityGate.issue.ageTooOld",
  ageTooYoung: "divset.entrants.eligibilityGate.issue.ageTooYoung",
  missingDob: "divset.entrants.eligibilityGate.issue.missingDob",
  missingGender: "divset.entrants.eligibilityGate.issue.missingGender",
  categoryMismatch: "divset.entrants.eligibilityGate.issue.categoryMismatch",
  mixedNeedsBothGenders: "divset.entrants.eligibilityGate.issue.mixedNeedsBothGenders",
} as const;

describe("EligibilityOverrideDialog — refusal reasons render off `code`, not the server's English sentence", () => {
  it("renders the Spanish sentence for AGE_TOO_OLD, and never the server's English one", () => {
    const html = render([ageTooOld(35)], esDict, "es");
    expect(html).toContain(esText[KEY.ageTooOld].replace("{limit}", "35"));
    expect(html).not.toContain("Too old for this division");
  });

  it("renders the DICTIONARY English sentence under en, not the server's — the map is used in every locale", () => {
    const html = render([ageTooOld(35)], enDict, "en");
    expect(html).toContain(enText[KEY.ageTooOld].replace("{limit}", "35"));
    // The en dictionary sentence is deliberately worded differently from
    // `ageBandEligibilityIssues`'s, so an English-only harness can still tell
    // a routed render from an inert one.
    expect(html).not.toContain("must be 35 or younger");
  });

  it("interpolates the REAL limit — two divisions with different bands render different numbers", () => {
    // AGENTS.md rule 19: a key that interpolates nothing passes a test that
    // only checks for non-English text. Pin the number, and pin that the two
    // renders DIFFER, so a hardcoded constant cannot satisfy both.
    const at35 = render([ageTooOld(35)], esDict, "es");
    const at8 = render([ageTooOld(8)], esDict, "es");
    expect(at35).toContain(esText[KEY.ageTooOld].replace("{limit}", "35"));
    expect(at35).not.toContain(esText[KEY.ageTooOld].replace("{limit}", "8"));
    expect(at8).toContain(esText[KEY.ageTooOld].replace("{limit}", "8"));
    expect(at8).not.toContain(esText[KEY.ageTooOld].replace("{limit}", "35"));
    expect(at35).not.toEqual(at8);
  });

  it("AGE_TOO_YOUNG carries its own minimum, distinct from the maximum's key", () => {
    const html = render(
      [
        {
          code: "AGE_TOO_YOUNG",
          message: "Too young for this division (must be 12 or older on the cutoff date).",
          meta: { limit: 12 },
        },
      ],
      esDict,
      "es",
    );
    expect(html).toContain(esText[KEY.ageTooYoung].replace("{limit}", "12"));
    expect(html).not.toContain("Too young for this division");
  });

  it.each([
    ["MISSING_DOB", "Date of birth is required for this age-restricted division.", KEY.missingDob],
    ["MISSING_GENDER", "Gender is required for this division.", KEY.missingGender],
    [
      "CATEGORY_MISMATCH",
      "This division is not open to your gender category.",
      KEY.categoryMismatch,
    ],
    [
      "MIXED_NEEDS_BOTH_GENDERS",
      "This division requires a mixed roster (at least one male and one female player).",
      KEY.mixedNeedsBothGenders,
    ],
  ] as const)("%s renders its Spanish sentence, never the server's English one", (code, english, key) => {
    const html = render(
      [{ code, message: english } as EligibilityIssue],
      esDict,
      "es",
    );
    expect(html).toContain(esText[key]);
    expect(html).not.toContain(english);
  });

  it("an UNMAPPED code degrades to the server's English message, never to blank", () => {
    // GENDER_NOT_ALLOWED has no producer left (RS007/V380 dropped the jsonb
    // rules) and so deliberately has no key — the fallback must still say
    // something rather than render an empty bullet.
    const english = "This division is not open to your gender.";
    const html = render(
      [{ code: "GENDER_NOT_ALLOWED", message: english }],
      esDict,
      "es",
    );
    expect(html).toContain(english);
  });

  it("a mapped-but-parameterised code with NO meta falls back to English rather than leaking a raw placeholder", () => {
    // `msg()` leaves an unsupplied `{limit}` in the output verbatim
    // (lib/messages.ts). A sentence that silently drops its number is worse
    // than the English one it replaced — so this case must not use the key.
    const html = render(
      [{ code: "AGE_TOO_OLD", message: "Too old for this division (must be 35 or younger on the cutoff date)." }],
      esDict,
      "es",
    );
    expect(html).not.toContain("{limit}");
    expect(html).toContain("Too old for this division");
  });
});
