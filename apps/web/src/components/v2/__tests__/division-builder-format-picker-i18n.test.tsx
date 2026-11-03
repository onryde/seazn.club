// F3 Task 6: the format picker's 14 STAGE_TEMPLATES cards used to render
// hardcoded English label/help strings straight off the array. They now read
// `format.template.<key>.label` / `.help` via useMsg() — format-templates.ts
// no longer even HAS those fields (see its own "F3 Task 6" comment). This
// file pins that the picker actually renders the ACTIVE locale's dictionary
// copy, which is the one thing a plain "the dictionary has the keys" check
// (format-templates.test.ts's coverage test) cannot prove — a component can
// still hardcode English while the dictionary sits there unused.
//
// The Format step's section is CSS-hidden (not JS-conditional) when another
// tab is active — `className={... ${tab === "format" ? "" : "hidden"}}`, not
// `{tab === "format" && ...}` (division-builder.tsx, the `tab === "format"`
// section) — so its markup is present in a bare renderToStaticMarkup pass
// regardless of which tab is "active" in the initial render. That's what
// makes a plain SSR pass (same DictProvider + renderToStaticMarkup harness as
// division-builder-schedule-seed.test.tsx) enough here — no interactive
// harness needed, unlike division-settings.tsx's Format Group, which
// defaults CLOSED (see division-settings-format-i18n.test.tsx for why that
// one needs a different approach).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { engineEntrantChoice } from "@/lib/__tests__/_engine-entrant-kinds";

// The builder offers every template but the Triple round robin, retired from every sport's offer (owner ruling
// 2026-11-01, Match Day D1); its copy still renders in Settings for a division stored as one.
const PICKER_TEMPLATES = STAGE_TEMPLATES.filter((t) => t.key !== "triple_rr");
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

const en = enUi as Record<string, string>;

const NON_ENGLISH: [Locale, Dict][] = [
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];

// The sport as the page hands it over, with the ENGINE's entrant model (`entrants`): the offer reads its kinds (C9 fix
// round 1, I5), and generic's model holds individuals and pairs, so every live template - Americano too - is offered.
const SPORTS: SportOption[] = [
  { key: "generic", name: "Generic", variants: [{ key: "score", name: "Score", system: true }], entrants: engineEntrantChoice("generic") },
];

function renderBuilder(dict: Dict, locale: Locale): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <DivisionBuilder
        competitionId="c1"
        orgSlug="org"
        compSlug="comp"
        sports={SPORTS}
        viewerPlan="community"
      />
    </DictProvider>,
  );
}

/** Isolates the picker's own card grid from the rest of the wizard markup.
 *  Necessary, not cosmetic: the Review step's stage list reuses stage `name:`
 *  fields that share English words with STAGE_TEMPLATES' labels (e.g.
 *  "Knockout"), so a page-wide `.not.toContain(enLabel)` check would
 *  false-fail against THAT text, not against a regression in the picker.
 *  Bounded by the card grid's own testid and the end of its fieldset
 *  (division-builder.tsx, Match Day C9: every offered card is rendered, the
 *  ones past the suggested five folded with `hidden`; C9 R2 put Show more inside the grid). */
function pickerSection(html: string): string {
  const start = html.indexOf('data-testid="division-builder-templates"');
  const end = html.indexOf("</fieldset>", start);
  if (start === -1 || end === -1) {
    throw new Error("could not locate the format picker's card grid in the rendered markup");
  }
  return html.slice(start, end);
}

/** React escapes text-node/attribute punctuation — a raw dictionary string
 *  containing `'`, `"`, `&` etc. never matches the markup unescaped. Mirrors
 *  constraints-panel-i18n.test.tsx. */
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

describe("division builder's format picker renders dictionary copy, not the old hardcoded field (F3 Task 6)", () => {
  for (const [locale, dict] of NON_ENGLISH) {
    it(`renders every STAGE_TEMPLATES label + help in ${locale}, and drops the English literal wherever the translation actually differs`, () => {
      const grid = pickerSection(renderBuilder(dict, locale));
      const record = dict as unknown as Record<string, string>;

      for (const t of PICKER_TEMPLATES) {
        const labelKey = `format.template.${t.key}.label`;
        const helpKey = `format.template.${t.key}.help`;
        const translatedLabel = record[labelKey];
        const translatedHelp = record[helpKey];
        expect(translatedLabel, `${locale} is missing ${labelKey}`).toBeTruthy();
        expect(translatedHelp, `${locale} is missing ${helpKey}`).toBeTruthy();

        expect(grid, `${locale}/${labelKey} did not render`).toContain(escapeHtml(translatedLabel));
        expect(grid, `${locale}/${helpKey} did not render`).toContain(escapeHtml(translatedHelp));

        // Only assert English is ABSENT where the translation actually
        // differs — a couple of short proper nouns/cognates (e.g. fr/nl
        // "Americano", nl "Ladder") are legitimately identical to
        // en, and asserting absence there would always fail: a vacuous
        // check, not a strict one (same reasoning as
        // constraints-panel-i18n.test.tsx).
        const enLabel = en[labelKey]!;
        const enHelp = en[helpKey]!;
        if (translatedLabel !== enLabel) {
          expect(grid, `${locale}/${labelKey} still shows the English literal`).not.toContain(
            escapeHtml(enLabel),
          );
        }
        if (translatedHelp !== enHelp) {
          expect(grid, `${locale}/${helpKey} still shows the English literal`).not.toContain(
            escapeHtml(enHelp),
          );
        }
      }
    });
  }

  it("en renders its own copy (harness sanity check)", () => {
    const grid = pickerSection(renderBuilder(enUi as Dict, "en"));
    for (const t of PICKER_TEMPLATES) {
      expect(grid).toContain(escapeHtml(en[`format.template.${t.key}.label`]!));
      expect(grid).toContain(escapeHtml(en[`format.template.${t.key}.help`]!));
    }
  });
});
