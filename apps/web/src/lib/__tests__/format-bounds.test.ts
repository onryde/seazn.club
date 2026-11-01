// Match Day D1 — one source for a division's format field bounds (design 2026-10-31 Phase D).
//
// The division builder's Format tab and the Settings Format group set the same four fields — legs, pools, Swiss rounds
// and the Top N that qualifies — and each carried its own literals. They disagreed (legs 1-2 vs 1-4, rounds from 1 vs
// from 3, Top N a fixed list vs any number 2-32), so a division one form built could be one the other could not show.
//
// What is pinned here:
//   1. BOTH forms, rendered, offer exactly FORMAT_BOUNDS on every bounded field of every template they offer — read off
//      the rendered controls (a number input's min/max; a choice list's values, which must also leave no gap), never off
//      a constant the forms export. Each form must reach every field at least once, so a field that loses its marker
//      cannot leave the sweep passing on fewer fields.
//   2. The validator accepts both ends of every field, and refuses one below the floor of the two it reads from here.
//   3. The seams: the legs the organiser picks is the legs the builder posts; Settings shows a stored legs value the
//      bounds no longer admit as it is, explains it, and keeps it on a format save until the organiser picks another.
//
// Expected values come from FORMAT_BOUNDS and the owner's ruling (legs 1 or 2, "Once" / "Home & away"), never from the
// forms. One sport (generic) on purpose: the bounds do not vary by sport, and templatesForSport only REMOVES templates
// for a sport (chess), it never adds a field.
import { createElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expandWithHooks, propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { DivisionSettings } from "@/components/v2/division-settings";
import { LegsChoice, legsChoices } from "@/components/v2/legs-choice";
import { FORMAT_BOUNDS, type FormatBoundKey, withinFormatBounds } from "@/lib/format-bounds";
import { STAGE_TEMPLATES, buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { CreateStage, StageConfig } from "@/server/api-v1/schemas";
import uiEn from "@/dictionaries/en/ui.json";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockResolvedValue({ phases: [] });
});

const SPORT = "generic";
const SPORTS: SportOption[] = [{ key: SPORT, name: "Generic", variants: [{ key: "score", name: "Score", system: true }] }];
const BOUND_KEYS = Object.keys(FORMAT_BOUNDS).sort() as FormatBoundKey[];

/** The rendered tree, with the shared legs control opened into its radios (it reads copy through `useMsg`, a read-only
 *  hook, so `expandWithHooks` can render it outside the island's own render). */
function expand(node: ReactNode): ReactElement[] {
  return walk(node).flatMap((el) =>
    el.type === LegsChoice
      ? [el, ...expand(expandWithHooks(LegsChoice, propsOf(el) as Parameters<typeof LegsChoice>[0]))]
      : [el],
  );
}

type Island = { tree: () => ReactElement[] };

function mountBuilder(): Island {
  return renderIsland(
    DivisionBuilder,
    {
      competitionId: "c1",
      orgSlug: "org",
      compSlug: "comp",
      sports: SPORTS,
      constraintsAllowed: true,
      archivedSlotsExplainRefusal: false,
      viewerPlan: "community",
    },
    expand,
  );
}

type StageProp = Parameters<typeof DivisionSettings>[0]["stages"][number];

function mountSettings(stages: StageProp[] = []): Island {
  return renderIsland(
    DivisionSettings,
    {
      division: {
        id: "d1",
        name: "Open",
        sport_key: SPORT,
        variant_key: "score",
        config: {},
        logo_url: null,
        logo_storage_path: null,
      },
      orgId: "org1",
      structureLocked: false,
      lockedFields: [],
      stages,
      canEdit: true,
      divisionPathPrefix: "/o/org/c/comp/d/",
      fixturesHref: "/o/org/c/comp/d/div/fixtures",
      embed: createElement("div"),
      danger: createElement("div"),
      autoPosts: false,
      canAutoPost: false,
      showSeeds: true,
      viewerPlan: "community",
      onlineChessOffered: true,
    },
    expand,
  );
}

/** The builder's template cards are radios in `templatesForSport` order. */
function pickBuilderTemplate(h: Island, key: string): void {
  const index = templatesForSport(SPORT).findIndex((t) => t.key === key);
  const radios = h.tree().filter((e) => e.type === "input" && propsOf(e).name === "template");
  const radio = radios[index];
  if (index === -1 || !radio) throw new Error(`no builder template card for ${key}`);
  (propsOf(radio).onChange as () => void)();
}

function pickSettingsTemplate(h: Island, key: string): void {
  const select = h.tree().find((e) => propsOf(e)["data-testid"] === "format-template");
  if (!select) throw new Error("no Settings format select");
  (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: key } });
}

/** What a rendered bounded control lets the organiser enter: a number input's min/max, or a choice list's values. */
function offered(el: ReactElement): { min: number; max: number; values: number[] | null } {
  const p = propsOf(el);
  if (el.type === "input" && p.type === "number") return { min: Number(p.min), max: Number(p.max), values: null };
  const values = walk(p.children as ReactNode)
    .filter((e) => e.type === "option" || (e.type === "input" && propsOf(e).type === "radio"))
    .map((e) => Number(propsOf(e).value));
  return { min: Math.min(...values), max: Math.max(...values), values };
}

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);

/** Every bounded control of every template a form offers, checked against FORMAT_BOUNDS. */
function sweep(h: Island, pick: (h: Island, key: string) => void) {
  let checked = 0;
  const seen = new Set<string>();
  const mismatches: string[] = [];
  for (const { key: template } of templatesForSport(SPORT)) {
    pick(h, template);
    for (const el of h.tree().filter((e) => typeof propsOf(e)["data-format-bound"] === "string")) {
      const field = propsOf(el)["data-format-bound"] as string;
      checked++;
      seen.add(field);
      if (!(field in FORMAT_BOUNDS)) {
        mismatches.push(`${template}: "${field}" is not a FORMAT_BOUNDS field`);
        continue;
      }
      const want = FORMAT_BOUNDS[field as FormatBoundKey];
      const got = offered(el);
      if (got.min !== want.min || got.max !== want.max) {
        mismatches.push(`${template} ${field}: offers ${got.min}-${got.max}, FORMAT_BOUNDS says ${want.min}-${want.max}`);
      } else if (got.values && JSON.stringify(got.values) !== JSON.stringify(range(want.min, want.max))) {
        mismatches.push(`${template} ${field}: offers [${got.values.join(",")}], a gap inside ${want.min}-${want.max}`);
      }
    }
  }
  return { checked, seen: [...seen].sort(), mismatches };
}

describe("FORMAT_BOUNDS — the owner's legs ruling", () => {
  it("is the brief's literal, every field (task D1 brief: legs 1-2, pools 2-8, Swiss rounds 1-15, Top N 2-32)", () => {
    // Typed from the brief, never read off the module: Swiss rounds 1-15 is pinned nowhere else.
    expect(FORMAT_BOUNDS).toEqual({
      legs: { min: 1, max: 2 },
      pools: { min: 2, max: 8 },
      swissRounds: { min: 1, max: 15 },
      qualify: { min: 2, max: 32 },
    });
  });

  it("the legs control refuses, loudly, bounds that admit a value with no label — either end — and labels both of today's", () => {
    let refused = 0;
    for (const [bounds, unnamed] of [
      [{ min: 1, max: 3 }, 3],
      [{ min: 0, max: 2 }, 0],
    ] as const) {
      expect(() => legsChoices(bounds), JSON.stringify(bounds)).toThrow(`FORMAT_BOUNDS.legs admits ${unnamed}, which has no label`);
      refused++;
    }
    expect(refused).toBe(2);
    // The positive pair: the default reads FORMAT_BOUNDS.legs, whose every value is named.
    expect(legsChoices().map((c) => c.value)).toEqual([1, 2]);
    expect(legsChoices(FORMAT_BOUNDS.legs)).toEqual(legsChoices());
  });

  it("legs is 1 or 2 (owner, 2026-10-31), and the shared control offers exactly those, as Once / Home & away", () => {
    expect(FORMAT_BOUNDS.legs).toEqual({ min: 1, max: 2 });
    expect(legsChoices().map((c) => [c.value, uiEn[c.labelKey as keyof typeof uiEn]])).toEqual([
      [1, "Once"],
      [2, "Home & away"],
    ]);
  });

  it("withinFormatBounds: both ends in, one past each end out, a fraction out", () => {
    let checked = 0;
    for (const key of BOUND_KEYS) {
      const { min, max } = FORMAT_BOUNDS[key];
      expect([withinFormatBounds(key, min), withinFormatBounds(key, max)], key).toEqual([true, true]);
      expect([withinFormatBounds(key, min - 1), withinFormatBounds(key, max + 1)], key).toEqual([false, false]);
      expect(withinFormatBounds(key, min + 0.5), key).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("both forms offer exactly FORMAT_BOUNDS", () => {
  it("the division builder's Format tab: every bounded field of every template", () => {
    const { checked, seen, mismatches } = sweep(mountBuilder(), pickBuilderTemplate);
    console.info(`[format-bounds] builder: ${checked} bounded fields checked over ${templatesForSport(SPORT).length} templates`);
    expect(mismatches).toEqual([]);
    expect(seen, "the builder reaches every bounded field").toEqual(BOUND_KEYS);
    expect(checked).toBeGreaterThan(0);
  });

  it("the Settings Format group: every bounded field of every template", () => {
    const { checked, seen, mismatches } = sweep(mountSettings(), pickSettingsTemplate);
    console.info(`[format-bounds] settings: ${checked} bounded fields checked over ${templatesForSport(SPORT).length} templates`);
    expect(mismatches).toEqual([]);
    expect(seen, "Settings reaches every bounded field").toEqual(BOUND_KEYS);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the validator accepts the bounds' ends", () => {
  it("legs and Swiss rounds: both ends parse, one below the floor is refused", () => {
    const cases: [FormatBoundKey, (n: number) => Record<string, unknown>][] = [
      ["legs", (n) => ({ legs: n })],
      ["swissRounds", (n) => ({ rounds: n })],
    ];
    for (const [key, config] of cases) {
      const { min, max } = FORMAT_BOUNDS[key];
      expect(StageConfig.safeParse(config(min)).success, `${key} ${min}`).toBe(true);
      expect(StageConfig.safeParse(config(max)).success, `${key} ${max}`).toBe(true);
      expect(StageConfig.safeParse(config(min - 1)).success, `${key} ${min - 1}`).toBe(false);
    }
  });

  it("pools: both ends parse", () => {
    for (const count of [FORMAT_BOUNDS.pools.min, FORMAT_BOUNDS.pools.max]) {
      expect(StageConfig.safeParse({ pools: { count } }).success, `pools ${count}`).toBe(true);
    }
  });

  it("every template, built as the forms build it with every field at its floor and then its ceiling, passes the create door", () => {
    let parsed = 0;
    for (const { key } of STAGE_TEMPLATES) {
      for (const end of ["min", "max"] as const) {
        const knobs = {
          legs: FORMAT_BOUNDS.legs[end],
          poolCount: FORMAT_BOUNDS.pools[end],
          swissRounds: FORMAT_BOUNDS.swissRounds[end],
          qualified: FORMAT_BOUNDS.qualify[end],
        };
        buildTemplateStages(key, knobs).forEach((draft, i) => {
          const r = CreateStage.safeParse({ ...draft, seq: i + 1 });
          expect(r.success, `${key} at ${end}, stage ${i + 1}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
          parsed++;
        });
      }
    }
    console.info(`[format-bounds] create door: ${parsed} stage drafts parsed over ${STAGE_TEMPLATES.length} templates x 2 ends`);
    expect(parsed).toBeGreaterThan(STAGE_TEMPLATES.length * 2 - 1);
  });
});

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function legsRadio(h: Island, legs: number): ReactElement {
  const radio = h
    .tree()
    .find((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "legs" && Number(propsOf(e).value) === legs);
  if (!radio) throw new Error(`no legs radio for ${legs}`);
  return radio;
}

function pickLegs(h: Island, legs: number): void {
  (propsOf(legsRadio(h, legs)).onChange as () => void)();
}

function checkedLegs(h: Island): number[] {
  return h
    .tree()
    .filter((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "legs" && propsOf(e).checked)
    .map((e) => Number(propsOf(e).value));
}

function press(h: Island, label: string): void {
  const button = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  (propsOf(button).onClick as () => void)();
}

/** The stages body of the LAST call to `path`. */
function postedStages(path: RegExp): { kind: string; config: Record<string, unknown>; progression: unknown }[] {
  const calls = apiV1Mock.mock.calls.filter(([url]) => path.test(String(url)));
  const last = calls.at(-1);
  if (!last) throw new Error(`nothing was sent to ${path}`);
  const json = (last[1] as { json: unknown }).json;
  return (Array.isArray(json) ? json : (json as { stages: unknown[] }).stages) as ReturnType<typeof postedStages>;
}

describe("the builder posts the legs the organiser picked", () => {
  it("Home & away reaches the stages the builder sends; picking Once again sends 1", async () => {
    const h = mountBuilder();
    pickBuilderTemplate(h, "league");
    expect(checkedLegs(h), "a new division starts at Once").toEqual([1]);

    pickLegs(h, 2);
    expect(checkedLegs(h)).toEqual([2]);
    press(h, uiEn["wizard.showExample"]);
    await flush();
    expect(postedStages(/format-preview/).map((s) => s.config.legs)).toEqual([2]);

    pickLegs(h, 1);
    press(h, uiEn["wizard.generate"]);
    await flush();
    expect(postedStages(/format-preview/).map((s) => s.config.legs)).toEqual([1]);
  });

  it("a Top N at the ceiling reaches the knockout the builder sends", async () => {
    const h = mountBuilder();
    pickBuilderTemplate(h, "swiss_knockout");
    const qualify = h.tree().find((e) => propsOf(e)["data-format-bound"] === "qualify");
    (propsOf(qualify!).onChange as (e: { target: { value: string } }) => void)({
      target: { value: String(FORMAT_BOUNDS.qualify.max) },
    });
    press(h, uiEn["wizard.showExample"]);
    await flush();
    const ko = postedStages(/format-preview/).find((s) => s.kind === "knockout");
    expect(ko?.progression).toMatchObject({
      sources: [{ take: [{ kind: "rankRange", from: 1, to: FORMAT_BOUNDS.qualify.max }] }],
    });
  });
});

describe("a Top N the builder does not show never sizes a stage (fix round 1, I1)", () => {
  // ko_plate and qualifying_main read the `qualified` knob (the Plate's round-1-losers count; the Main draw's intake),
  // but the builder shows them no Top N control. A value typed for another template must not ride into them unseen:
  // they post the templates' default, 4 (the fix brief). 6 differs from it, so the wrong answer is visible.
  const SHOWN = 6;
  const DEFAULT = 4;
  function setTopN(h: Island, value: string): void {
    const qualify = h.tree().find((e) => propsOf(e)["data-format-bound"] === "qualify");
    if (!qualify) throw new Error("no Top N control on screen");
    (propsOf(qualify).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  }
  const takeOf = () =>
    (postedStages(/format-preview/)[1]?.progression as { sources: { take: Record<string, unknown>[] }[] }).sources[0]!.take;

  it("Top 6 on league_ko, then Knockout + Plate: the Plate takes 4 round-1 losers; then Qualifying + Main draw: the Main draw takes 4", async () => {
    let checked = 0;
    for (const [template, want] of [
      ["ko_plate", { kind: "roundLosers", round: 1, count: DEFAULT }],
      ["qualifying_main", { kind: "rankRange", from: 1, to: DEFAULT }],
    ] as const) {
      const h = mountBuilder();
      pickBuilderTemplate(h, "league_ko");
      setTopN(h, String(SHOWN));
      pickBuilderTemplate(h, template);
      expect(h.tree().some((e) => propsOf(e)["data-format-bound"] === "qualify"), `${template} shows no Top N`).toBe(false);
      press(h, uiEn["wizard.showExample"]);
      await flush();
      expect(takeOf(), template).toEqual([want]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the sequence back: league_ko again still shows and sends the Top 6 typed for it", async () => {
    const h = mountBuilder();
    pickBuilderTemplate(h, "league_ko");
    setTopN(h, String(SHOWN));
    pickBuilderTemplate(h, "ko_plate");
    pickBuilderTemplate(h, "league_ko");
    const qualify = h.tree().find((e) => propsOf(e)["data-format-bound"] === "qualify");
    expect(Number(propsOf(qualify!).value)).toBe(SHOWN);
    press(h, uiEn["wizard.showExample"]);
    await flush();
    expect(takeOf()).toEqual([{ kind: "rankRange", from: 1, to: SHOWN }]);
  });
});

describe("Settings never clamps a stored legs value silently", () => {
  const leagueKo = (legs: number): StageProp[] =>
    buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs }).map((d) => ({
      name: d.name,
      kind: d.kind,
      config: d.config,
      progression: d.progression,
    }));
  const STORED = FORMAT_BOUNDS.legs.max + 1;
  const note = (n: number) => uiEn["format.legs.storedOutOfRange"].replace("{n}", String(n));
  const stored = (h: Island) => h.tree().find((e) => propsOf(e)["data-testid"] === "legs-choice-stored");

  it("no stages yet (the empty case): Once is picked and nothing is explained", () => {
    const h = mountSettings([]);
    expect(checkedLegs(h)).toEqual([1]);
    expect(stored(h)).toBeUndefined();
  });

  it("a stored Home & away is shown picked, with no note", () => {
    const h = mountSettings(leagueKo(2));
    pickSettingsTemplate(h, "league_ko");
    expect(checkedLegs(h)).toEqual([2]);
    expect(stored(h)).toBeUndefined();
  });

  it("a stored value past the bounds: neither option picked, the note names it, a format save keeps it, and picking Once then saves 1", async () => {
    expect(withinFormatBounds("legs", STORED), "the case must lie outside the bounds").toBe(false);
    const h = mountSettings(leagueKo(STORED));
    expect(checkedLegs(h)).toEqual([]);
    expect(textOf(stored(h)!)).toBe(note(STORED));

    const apply = () => {
      const button = h.tree().find((e) => propsOf(e)["data-testid"] === "apply-structure");
      (propsOf(button!).onClick as () => void)();
    };
    apply();
    await flush();
    expect(postedStages(/\/divisions\/d1\/stages$/).find((s) => s.kind === "league")?.config.legs).toBe(STORED);

    pickLegs(h, 1);
    expect(stored(h)).toBeUndefined();
    apply();
    await flush();
    expect(postedStages(/\/divisions\/d1\/stages$/).find((s) => s.kind === "league")?.config.legs).toBe(1);
  });
});
