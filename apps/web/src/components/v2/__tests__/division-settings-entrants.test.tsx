import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionSettings } from "@/components/v2/division-settings";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

// Same harness as stages-panel-delete.test.tsx: mock the router + confirm hooks
// and assert on the STATIC markup. The Entrants block is a defaultOpen Group so
// its controls are in the server-rendered DOM (no click needed to reveal them).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

function renderSettings(
  overrides: {
    entrantModel?: EffectiveEntrantModel;
    entrantModelSource?: "sport" | "override";
    canEdit?: boolean;
    showSeeds?: boolean;
  } = {},
): string {
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
      variants={[{ key: "standard", name: "Standard" }]}
      locked={false}
      stages={[]}
      canEdit={overrides.canEdit ?? true}
      divisionPathPrefix="/o/org/c/comp/d/"
      fixturesHref="/o/org/c/comp/d/div/fixtures"
      embed={<div />}
      danger={<div />}
      entrantModel={overrides.entrantModel ?? INDIVIDUAL_ONLY}
      entrantModelSource={overrides.entrantModelSource ?? "sport"}
      autoPosts={false}
      canAutoPost={false}
      showSeeds={overrides.showSeeds ?? true}
      viewerPlan="community"
    />,
  );
}

describe("DivisionSettings — Entrants block", () => {
  it("shows the block with sport defaults and all three kinds selectable", () => {
    const html = renderSettings();
    expect(html).toContain("Entrants");
    // Ticked kind plus the two the organiser can widen into.
    expect(html).toContain("individual");
    expect(html).toContain("pair");
    expect(html).toContain("team");
    // Sport-default caption shows only when there is no override.
    expect(html).toContain("entrants-sport-default");
  });

  it("ticks only the effective model's kinds", () => {
    const html = renderSettings();
    expect(html).toMatch(/data-kind="individual"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-kind="team"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/data-kind="pair"[^>]*aria-pressed="false"/);
  });

  it("reveals squad-number + captain toggles only while team is ticked", () => {
    expect(renderSettings()).not.toContain("Squad numbers");

    const withTeam = renderSettings({
      entrantModel: {
        kinds: ["team", "individual"],
        defaultKind: "team",
        squadNumbers: true,
        captain: true,
        maxTeamMembers: null,
      },
    });
    expect(withTeam).toContain("Squad numbers");
    expect(withTeam).toContain("Captain");
  });

  it("offers Reset only when the model comes from a saved override", () => {
    const sport = renderSettings({ entrantModelSource: "sport" });
    expect(sport).not.toContain("Reset to sport default");

    const override = renderSettings({ entrantModelSource: "override" });
    expect(override).toContain("Reset to sport default");
    expect(override).not.toContain("entrants-sport-default");
  });

  it("hides the editing affordances from viewers (canEdit=false)", () => {
    const html = renderSettings({ canEdit: false });
    expect(html).not.toContain("Save entrant settings");
  });
});

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
