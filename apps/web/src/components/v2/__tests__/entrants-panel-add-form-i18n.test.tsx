// W3 T10 (coordinator, no-new-issues rule): "Add late player" sends organisers through the Entrants tab's add form, so
// the form speaks the reader's language — its heading, fields, placeholders, the players picker's hint and the CSV
// controls were English literals. Rendered whole (static markup, the server's first paint) inside each locale's
// provider; every expected string is read from that locale's own catalogue.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DictProvider } from "@/components/i18n/dict-provider";
import { EntrantsPanel, ExistingTeamFields, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

const DICTS: Record<Locale, Record<string, string>> = { en, es, fr, nl } as never;
const LOCALES = Object.keys(DICTS) as Locale[];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const NO_ELIGIBILITY: EntrantsPanelEligibility = { category: null, age_min: null, age_max: null, eligibility_note: null };
const model = (kinds: EffectiveEntrantModel["kinds"]): EffectiveEntrantModel => ({
  kinds,
  defaultKind: kinds[0]!,
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
});

const panel = (locale: Locale, kinds: EffectiveEntrantModel["kinds"]) =>
  renderToStaticMarkup(
    <DictProvider locale={locale} dict={DICTS[locale] as unknown as Dict}>
      <EntrantsPanel
        divisionId="div-1"
        entrants={[]}
        canEdit
        positionGroups={[]}
        roles={[]}
        eligibility={NO_ELIGIBILITY}
        entrantModel={model(kinds)}
        viewerPlan="community"
        divisionStatus="setup"
      />
    </DictProvider>,
  );

/** The literals the form used to hard-code — none may survive into another locale's render. */
const ENGLISH_LITERALS = [
  "Members (persons directory)",
  "Search players…",
  "No players yet — add them under Players, or import a CSV.",
  "Sample CSV",
  "Import CSV",
];

describe("the add-entrant form speaks the reader's language (W3 T10)", () => {
  it("an individual division's form: heading, fields, placeholder, picker hint, submit and CSV controls", () => {
    const KEYS = [
      "entrants.add.title",
      "entrants.add.name",
      "entrants.add.seed",
      "entrants.add.namePlaceholder.individual",
      "entrants.add.searchPlayers",
      "entrants.add.noPlayers",
      "entrants.add.submit",
      "entrants.import.button",
      "entrants.import.sample",
    ];
    let checked = 0;
    for (const locale of LOCALES) {
      const html = panel(locale, ["individual"]);
      for (const key of KEYS) {
        expect(html, `${locale} ${key}`).toContain(esc(DICTS[locale][key]!));
        checked++;
      }
      if (locale !== "en") for (const literal of ENGLISH_LITERALS) expect(html, `${locale}: "${literal}" left in English`).not.toContain(esc(literal));
    }
    expect(checked, "anti-vacuity: every key in every locale").toBe(KEYS.length * LOCALES.length);
  });

  it("a team division's form names its members picker and its team placeholder", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const html = panel(locale, ["team"]);
      for (const key of ["entrants.add.members", "entrants.add.namePlaceholder.team"]) {
        expect(html, `${locale} ${key}`).toContain(esc(DICTS[locale][key]!));
        checked++;
      }
    }
    expect(checked).toBe(2 * LOCALES.length);
  });

  it("the existing-team picker's empty line and its controls", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const html = renderToStaticMarkup(
        <DictProvider locale={locale} dict={DICTS[locale] as unknown as Dict}>
          <ExistingTeamFields teams={[]} enteredTeamIds={new Set()} busy={false} onSubmit={async () => undefined} />
        </DictProvider>,
      );
      for (const key of ["entrants.add.noTeams", "entrants.add.searchTeams", "entrants.add.searchTeams.label", "entrants.add.copyRoster", "entrants.add.enroll"]) {
        expect(html, `${locale} ${key}`).toContain(esc(DICTS[locale][key]!));
        checked++;
      }
    }
    expect(checked).toBe(5 * LOCALES.length);
  });

  it("every prose key is translated: no locale ships the English sentence", () => {
    const PROSE = [
      "entrants.add.members",
      "entrants.add.searchPlayers",
      "entrants.add.noPlayers",
      "entrants.add.noTeams",
      "entrants.add.copyRoster",
      "entrants.add.enrolledDropped.other",
      "entrants.import.noRows",
    ];
    let checked = 0;
    for (const key of PROSE) {
      const values = LOCALES.map((l) => DICTS[l][key]);
      for (const v of values) expect(v, key).toBeTruthy();
      expect(new Set(values).size, `${key}: two locales share a string`).toBe(LOCALES.length);
      checked++;
    }
    expect(checked).toBe(PROSE.length);
  });
});
