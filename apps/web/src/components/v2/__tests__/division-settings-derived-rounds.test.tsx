// Swiss round budget on the division Settings tab — every template whose first
// stage is swiss (plain, Playoff, Knockout) exposes an editable rounds input.
// buildTemplateStages stamps knobs.swissRounds onto the swiss draft on save.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { buildTemplateStages } from "@/components/v2/format-templates";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const { activeDict } = vi.hoisted(() => ({
  activeDict: { current: {} as Record<string, string> },
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const raw = activeDict.current[key];
      if (typeof raw !== "string") return key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
    },
  };
});

const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

const KNOBS = { swissRounds: 5, poolCount: 2, legs: 1, qualified: 4 };

type StageProp = Parameters<typeof DivisionSettings>[0]["stages"][number];

function stagesFor(templateKey: string, rounds: number): StageProp[] {
  return buildTemplateStages(templateKey, { ...KNOBS, swissRounds: rounds }).map((d) => ({
    name: d.name,
    kind: d.kind,
    config: d.config as Record<string, unknown>,
    progression: d.progression,
  }));
}

function mount(stages: StageProp[], locked: boolean) {
  return renderIsland(DivisionSettings, {
    division: {
      id: "d1",
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
      logo_url: null,
      logo_storage_path: null,
    },
    orgId: "org1",
    variants: [{ key: "bwf", name: "BWF" }],
    locked,
    stages,
    canEdit: !locked,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: <div />,
    danger: <div />,
    entrantModel: INDIVIDUAL_ONLY,
    entrantModelSource: "sport",
    autoPosts: false,
    canAutoPost: false,
    viewerPlan: "community",
  });
}

function roundsInputValue(stages: StageProp[], locked: boolean): string | null {
  const node = mount(stages, locked)
    .tree()
    .find((e) => propsOf(e)["data-testid"] === "division-settings-swiss-rounds");
  if (!node) return null;
  return String(propsOf(node).value);
}

describe("division settings — editable swiss rounds on every swiss template", () => {
  for (const template of ["swiss", "swiss_playoff", "swiss_knockout"]) {
    it(`${template}: shows an editable rounds input seeded from the stage config`, () => {
      activeDict.current = enUi as Record<string, string>;
      expect(roundsInputValue(stagesFor(template, 7), false)).toBe("7");
    });

    it(`${template}: hides the rounds input when the format is locked`, () => {
      activeDict.current = enUi as Record<string, string>;
      expect(roundsInputValue(stagesFor(template, 7), true)).toBeNull();
    });
  }

  it("league_ko: never shows a swiss rounds input", () => {
    activeDict.current = enUi as Record<string, string>;
    const stages = buildTemplateStages("league_ko", KNOBS).map((d) => ({
      name: d.name,
      kind: d.kind,
      config: d.config as Record<string, unknown>,
      progression: d.progression,
    }));
    const tree = mount(stages, false).tree();
    expect(
      walk(tree).some((e) => propsOf(e)["data-testid"] === "division-settings-swiss-rounds"),
    ).toBe(false);
  });
});
