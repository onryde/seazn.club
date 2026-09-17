// The derived swiss round budget on the division Settings tab.
//
// swiss_playoff and swiss_knockout declare no `config.rounds`; swissGen
// derives the field's budget and writes it into the stage config at the FIRST
// generation. Settings shows that number read-only, and the whole point is
// that an organiser can see what is driving their stage.
//
// This file exists because the first build of that control rendered NOWHERE,
// and every unit and e2e suite in the repo stayed green while it did. The
// control was placed in the editable half of division-settings' `{locked ? …
// : …}` split — but `locked` means "a fixture exists", and generating the
// swiss is exactly what creates the first fixture and writes the number. The
// two states are mutually exclusive: before generation the value is absent,
// after generation the editable branch is gone. It was caught by opening the
// page in a browser, not by a test, so the locked case below is the one that
// earns this file (AGENTS.md failure class 1 — the inert seam).
//
// The Group accordion this block sits in defaults CLOSED, and `walk()` reads
// `props.children` off the element tree without ever calling Group as a
// function — see division-settings-format-i18n.test.tsx's header for why
// that is sound.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderIsland, propsOf, walk, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { buildTemplateStages } from "@/components/v2/format-templates";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

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

const en = enUi as Record<string, string>;

const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

const KNOBS = { swissRounds: 5, poolCount: 2, legs: 1, qualified: 4 };

type StageProp = Parameters<typeof DivisionSettings>[0]["stages"][number];

/** The REAL template drafts for a key, so detectTemplate round-trips them
 *  back to that same key — a hand-typed stage list could name a shape the
 *  picker no longer builds and this file would prove nothing. `rounds` is
 *  layered on exactly as swissGen's write leaves it. */
function stagesFor(templateKey: string, rounds: number | null): StageProp[] {
  return buildTemplateStages(templateKey, KNOBS).map((d) => ({
    name: d.name,
    kind: d.kind,
    config:
      rounds !== null && d.kind === "swiss"
        ? { ...d.config, rounds }
        : (d.config as Record<string, unknown>),
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

/** The rendered round number, or null when the line is absent. `textOf`, not
 *  `walk`: walk() returns only ReactElements and drops the number itself. */
function roundsShown(stages: StageProp[], locked: boolean): string | null {
  const node = mount(stages, locked)
    .tree()
    .find((e) => propsOf(e)["data-testid"] === "division-settings-derived-rounds");
  if (!node) return null;
  return textOf(propsOf(node).children as ReactNode);
}

/** The whole sentence the number sits in, as a customer reads it. */
function lineText(stages: StageProp[], locked: boolean): string {
  const para = mount(stages, locked)
    .tree()
    .find(
      (e) =>
        e.type === "p" &&
        walk((propsOf(e).children as ReactNode) ?? null).some(
          (c) => propsOf(c)["data-testid"] === "division-settings-derived-rounds",
        ),
    );
  return para ? textOf(propsOf(para).children as ReactNode) : "";
}

describe("division settings shows the swiss budget its stage actually runs on", () => {
  for (const template of ["swiss_playoff", "swiss_knockout"]) {
    // THE case. `locked` is true for every division that has the number,
    // because writing it and locking the format are the same event.
    it(`${template}: renders the derived rounds once the format is LOCKED — the only state that has the number`, () => {
      activeDict.current = en;
      expect(roundsShown(stagesFor(template, 3), true)).toBe("3");
    });

    it(`${template}: renders it in the editable state too, for a stage whose rounds arrived over the API`, () => {
      activeDict.current = en;
      expect(roundsShown(stagesFor(template, 4), false)).toBe("4");
    });

    // A reachability check is satisfied by ANY value (AGENTS.md 19): pin that
    // the number tracks the STAGE, so a control wired to the `swissRounds`
    // state — which falls back to 5 when the key is absent — fails here.
    it(`${template}: shows the stage's own number, not the knob's default of 5`, () => {
      activeDict.current = en;
      expect(roundsShown(stagesFor(template, 7), true)).toBe("7");
      expect(roundsShown(stagesFor(template, 3), true)).not.toBe("5");
    });

    it(`${template}: shows NOTHING before the first generation has decided a budget`, () => {
      activeDict.current = en;
      // The shipped draft, exactly as the picker lays it down.
      expect(stagesFor(template, null)[0]!.config).not.toHaveProperty("rounds");
      expect(roundsShown(stagesFor(template, null), false)).toBeNull();
      expect(roundsShown(stagesFor(template, null), true)).toBeNull();
    });
  }

  // A plain swiss stage's rounds were CHOSEN by the organiser through the
  // editable input right beside this, so captioning them "decided by the size
  // of the field" would be a lie. Without this case the gate could be widened
  // to every swiss stage and nothing would complain.
  it("plain swiss: never captions the organiser's OWN declared rounds as field-derived", () => {
    activeDict.current = en;
    const plain = stagesFor("swiss", null);
    expect(plain[0]!.config).toHaveProperty("rounds"); // the template declares its own
    expect(roundsShown(plain, true)).toBeNull();
    expect(roundsShown(plain, false)).toBeNull();
  });

  for (const [locale, dict] of [
    ["en", enUi],
    ["es", esUi],
    ["fr", frUi],
    ["nl", nlUi],
  ] as const) {
    it(`renders the label and caption in ${locale}, never a raw dictionary key`, () => {
      activeDict.current = dict as Record<string, string>;
      const text = lineText(stagesFor("swiss_knockout", 3), true);
      const d = dict as Record<string, string>;
      expect(text).toContain(d["divset.rounds"]!);
      expect(text).toContain(d["divset.roundsFromField"]!);
      expect(text).toContain("3");
      // The useMsg stub returns the KEY itself when a dictionary is missing
      // it, so this is what catches a locale that never got the new string.
      // "divset.rounds" is a prefix of "divset.roundsFromField", so one
      // assertion covers both leaks.
      expect(text).not.toContain("divset.rounds");
    });
  }
});
