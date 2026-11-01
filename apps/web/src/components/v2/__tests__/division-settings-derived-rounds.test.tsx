// Swiss round budget on the division Settings tab — every template whose first
// stage is swiss (plain, Playoff, Knockout) exposes an editable rounds input.
// buildTemplateStages stamps knobs.swissRounds onto the swiss draft on save.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { buildTemplateStages } from "@/lib/format-templates";
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

// The builder's default round count (division-builder.tsx `useState(3)` — W3 T11: the band for a field of up to 8,
// rulebook-W3-swiss.md §3.2; it was 5 before, which dead-ends a field of 6 in 15.5% of events, §3.1).
const KNOBS = { swissRounds: 3, poolCount: 2, legs: 1, qualified: 4 };

type StageProp = Parameters<typeof DivisionSettings>[0]["stages"][number];

function stagesFor(templateKey: string, rounds: number): StageProp[] {
  return buildTemplateStages(templateKey, { ...KNOBS, swissRounds: rounds }).map((d) => ({
    name: d.name,
    kind: d.kind,
    config: d.config as Record<string, unknown>,
    progression: d.progression,
  }));
}

/** Persisted stage rows — `rounds` is layered on AFTER buildTemplateStages
 *  (which used the default KNOBS.swissRounds of 3) so the input must read the
 *  STAGE config, not the knob default. AGENTS.md #19: a reachability check
 *  satisfied by ANY value; pin persisted ≠ default. */
function persistedStagesFor(templateKey: string, persistedRounds: number): StageProp[] {
  return buildTemplateStages(templateKey, KNOBS).map((d) => ({
    name: d.name,
    kind: d.kind,
    config:
      d.kind === "swiss"
        ? { ...d.config, rounds: persistedRounds }
        : (d.config as Record<string, unknown>),
    progression: d.progression,
  }));
}

function mount(stages: StageProp[], locked: boolean, swissField?: number) {
  return renderIsland(DivisionSettings, {
    ...(swissField !== undefined ? { swissField } : {}),
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
    structureLocked: locked,
    lockedFields: [],
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
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered: true,
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

    it(`${template}: input seeds from persisted stage config, not the knob default of 3`, () => {
      activeDict.current = enUi as Record<string, string>;
      expect(roundsInputValue(persistedStagesFor(template, 4), false)).toBe("4");
      expect(roundsInputValue(persistedStagesFor(template, 4), false)).not.toBe(String(KNOBS.swissRounds));
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

// W3 Task 11 (SW-H2, RB3-3; X-SW-16): the Rounds box takes any count from 1 (rulebook §3.2 "Organiser may choose any value
// from 1 to the hard maximum"; it was min 3), names the field's guidance under it, and a switch to a Swiss format seeds
// the field's recommendation rather than a flat 5. Expected numbers are §3.2's table typed here: a field of 6 → 3
// recommended, at most 5; a field of 4 → 2 recommended, at most 3.
describe("division settings — Swiss round guidance (X-SW-16)", () => {
  const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
  const EN = enUi as Record<string, string>;
  const byTestId = (tree: ReturnType<ReturnType<typeof mount>["tree"]>, id: string) =>
    tree.find((e) => propsOf(e)["data-testid"] === id);
  const guidanceText = (tree: ReturnType<ReturnType<typeof mount>["tree"]>): string | null => {
    const node = byTestId(tree, "division-settings-swiss-rounds-guidance");
    return node ? String(propsOf(node).children) : null;
  };

  it("the Rounds box accepts 1 (it was 3) and still caps at 15", () => {
    activeDict.current = EN;
    const input = byTestId(mount(stagesFor("swiss", 3), false, 6).tree(), "division-settings-swiss-rounds");
    expect(input, "the Rounds box").toBeDefined();
    expect(propsOf(input!).min).toBe(1);
    expect(propsOf(input!).max).toBe(15);
  });

  it("names the field's guidance under the Rounds box, for each field size", () => {
    activeDict.current = EN;
    let checked = 0;
    for (const [n, count, hardMax] of [
      [6, 3, 5],
      [4, 2, 3],
      [8, 3, 7],
      [20, 5, 19],
    ] as const) {
      expect(guidanceText(mount(stagesFor("swiss", 3), false, n).tree()), `field ${n}`).toBe(
        fill(EN["swiss.rounds.guidance.other"]!, { n, count, hardMax }),
      );
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("no guidance without a pairable field (none passed, an empty division, one entrant)", () => {
    activeDict.current = EN;
    for (const field of [undefined, 0, 1]) {
      expect(guidanceText(mount(stagesFor("swiss", 3), false, field).tree()), String(field)).toBeNull();
    }
  });

  it("a switch to a Swiss format seeds the field's recommendation, not a flat 5", () => {
    activeDict.current = EN;
    const league = buildTemplateStages("league", KNOBS).map((d) => ({
      name: d.name,
      kind: d.kind,
      config: d.config as Record<string, unknown>,
      progression: d.progression,
    }));
    let checked = 0;
    for (const [field, seeded] of [
      [6, "3"],
      [4, "2"],
      [40, "6"],
    ] as const) {
      const island = mount(league, false, field);
      expect(roundsInputValue(league, false), "premise: a league shows no rounds box").toBeNull();
      const select = byTestId(island.tree(), "format-template");
      (propsOf(select!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "swiss" } });
      const rounds = byTestId(island.tree(), "division-settings-swiss-rounds");
      expect(rounds, `field ${field}: the Rounds box after the switch`).toBeDefined();
      expect(String(propsOf(rounds!).value), `field ${field}`).toBe(seeded);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
