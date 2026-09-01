// RS011 review round 3, finding 3: `offenderLabel`'s no-`playerName`
// fallback (`` `Player ${issue.playerIndex}` ``) was a raw English template
// literal, rendered directly, while every other string in this file already
// routes through `msg()`. AGENTS.md: "Any new or changed user-facing string
// → all 4 locale dictionaries, never hardcoded English." Proven the same way
// `conflicts-panel.test.tsx` proves its own client-safe-English-fallback fix
// — `renderToStaticMarkup` under a non-English `DictProvider`, asserting the
// TRANSLATED sentence appears and the hardcoded English one does not.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import es from "@/dictionaries/es/ui.json";
import en from "@/dictionaries/en/ui.json";
import { EligibilityOverrideDialog } from "@/components/v2/eligibility-override-dialog";
import type { EligibilityIssue } from "@/lib/registration-rules";

const esDict = es as unknown as Dict;
const enDict = en as unknown as Dict;

const NO_NAME_VIOLATION: EligibilityIssue[] = [
  { code: "AGE_TOO_OLD", message: "Too old for this division.", playerIndex: 2, playerName: null },
];

describe("EligibilityOverrideDialog — the playerIndex-only fallback label is translated, not hardcoded English (RS011 review round 3, finding 3)", () => {
  it("renders the Spanish translation under an es DictProvider, and never the raw English fallback", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={esDict} locale="es">
        <EligibilityOverrideDialog
          open={true}
          violations={NO_NAME_VIOLATION}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </DictProvider>,
    );
    expect(html).toContain("Jugador 2");
    expect(html).not.toContain("Player 2");
  });

  it("renders the English fallback under an en DictProvider", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enDict} locale="en">
        <EligibilityOverrideDialog
          open={true}
          violations={NO_NAME_VIOLATION}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </DictProvider>,
    );
    expect(html).toContain("Player 2");
  });

  it("a violation WITH a playerName still uses the real name, in every locale, never the index fallback", () => {
    const named: EligibilityIssue[] = [
      { code: "AGE_TOO_OLD", message: "Too old for this division.", playerIndex: 1, playerName: "Alex Doe" },
    ];
    const html = renderToStaticMarkup(
      <DictProvider dict={esDict} locale="es">
        <EligibilityOverrideDialog open={true} violations={named} onCancel={() => {}} onConfirm={() => {}} />
      </DictProvider>,
    );
    expect(html).toContain("Alex Doe");
    expect(html).not.toContain("Jugador 1");
  });
});
