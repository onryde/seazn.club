import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionSettings } from "@/components/v2/division-settings";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

// Match Day C4: this file began as the Entrants block's suite. The block moved to the top of the Entrants tab
// (`entrant-kinds-settings.test.tsx` holds its tests) and the proof that Settings no longer draws it, for every sport, is
// `division-settings-cleanup.test.tsx`. What stays is the Public page block below, which shared this harness: mock the router +
// confirm hooks and assert on the STATIC markup (the Public page group's SUMMARY is in the folded markup).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

function renderSettings(overrides: { canEdit?: boolean; showSeeds?: boolean } = {}): string {
  return renderToStaticMarkup(
    <DivisionSettings
      division={{
        id: "d1",
        name: "Open",
        sport_key: "football",
        variant_key: "standard",
        config: {},
        logo_url: null,
        logo_storage_path: null,
      }}
      orgId="org1"
      structureLocked={false}
      lockedFields={[]}
      stages={[]}
      canEdit={overrides.canEdit ?? true}
      divisionPathPrefix="/o/org/c/comp/d/"
      fixturesHref="/o/org/c/comp/d/div/fixtures"
      embed={<div />}
      danger={<div />}
      autoPosts={false}
      canAutoPost={false}
      showSeeds={overrides.showSeeds ?? true}
      viewerPlan="community"
      onlineChessOffered
    />,
  );
}

// V416 — the Public page block opens at the division's STORED show_seeds, not
// at a constant: its collapsed summary names the state, and the checkbox is
// seeded from the same prop. The words come from the dictionary, so a copy
// change moves this test with it.
describe("DivisionSettings — Public page block (show_seeds)", () => {
  const shown = enUi["divset.publicPage.seedsShown"];
  const hidden = enUi["divset.publicPage.seedsHidden"];

  it("summarises a division that hides its seeds as hidden", () => {
    const html = renderSettings({ showSeeds: false });
    expect(html).toContain(enUi["divset.publicPage.title"]);
    expect(html).toContain(hidden);
    expect(html).not.toContain(shown);
  });

  it("summarises a division that shows its seeds as shown", () => {
    const html = renderSettings({ showSeeds: true });
    expect(html).toContain(shown);
    expect(html).not.toContain(hidden);
  });
});

// Owner ruling (review I-1, 2026-09-23): hiding seeds hides the NUMBERS, not
// the seeding. Standings still break ties on seed (the table says "split on
// seeding"), and a seeded draw — a knockout, or Swiss round 1 — still shows who
// was seeded through who plays whom. The help text under the toggle must say
// so, in every locale, rather than promise a secrecy the product does not keep.
describe("DivisionSettings — show_seeds help discloses what hiding does NOT hide", () => {
  it("English names both: the standings tie-break and the seeded draw", () => {
    const help = enUi["divset.publicPage.seedsHelp"];
    expect(help).toMatch(/breaks ties in the standings/);
    expect(help).toMatch(/seeded draw \(a knockout, or Swiss round 1\)/);
  });

  it("every locale discloses both, in its own words: its own tie-break word for seeding, and round 1", () => {
    for (const [locale, ui] of [
      ["en", enUi],
      ["es", esUi],
      ["fr", frUi],
      ["nl", nlUi],
    ] as const) {
      const help = ui["divset.publicPage.seedsHelp"];
      // The word the standings' own tie-break line uses for seeding, read from
      // the same locale — so the disclosure and the table name one thing.
      expect(help.toLowerCase(), `${locale}: the tie-break`).toContain(
        ui["div.detail.tiebreak.rule.seed"].toLowerCase(),
      );
      expect(help, `${locale}: the round-1 draw`).toMatch(/\b1\b|1er|1\.ª/);
      if (locale !== "en") expect(help, `${locale} is untranslated`).not.toBe(enUi["divset.publicPage.seedsHelp"]);
    }
  });
});
