// W4 T15 (X-PL-1, X-QM-2, X-QM-5; owner pick 5A, R24 mock): a format the field cannot play stays ON SHOW, greyed and unpickable,
// saying what unlocks it, and a pick the plan shrank under cannot go on. Driven through the builder's and the Format dialog's real
// handlers on the hook harness; the browser's half (the tap itself, the widths) is e2e/w4-knockout-app-a.spec.ts.
//
// Expected values: the bound 4 is the rulebook's (X-PL-1) and the driving sweep's (qualifying-main-sizes.test.ts, X-QM-5); every
// sentence comes from the en dictionary, filled here by hand, never from the component's own formatter.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { expandWithHooks, propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { LegsChoice } from "@/components/v2/legs-choice";
import { DivisionFormatDialog, type DivisionFormatProps, type DivisionFormatStage } from "@/components/v2/rules/division-format";
import { formatStagesFor } from "@/lib/division-builder/format-choice";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { sportOptionsFrom } from "@/lib/sport-options";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import { byTestId, currentStep, goToStep, next, pickTemplate, pickedTemplate, setName, stepError, templateCards, templateKeys, visibleTemplateKeys } from "./_division-builder-driver";

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

const UI = uiEn as Record<string, string>;
const needs = (min: number, count: number) => UI["divBuilder.card.needsEntrants"]!.replace("{min}", String(min)).replace("{count}", String(count));
const PLATE_SAYS = UI["knockout.refusal.KO_PLATE_TOO_FEW"]!;
const MAIN_SAYS = UI["knockout.refusal.QUALIFYING_MAIN_TOO_FEW"]!.replace("{min}", "4");
/** The formats the rulebook sizes (X-PL-1, X-QM-5), each from 4. */
const GATED = ["ko_plate", "qualifying_main"] as const;

const modelOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return effectiveEntrantModel(m.entrantModel ?? null, null);
};
const variantRows = builtinModules.flatMap((m) =>
  Object.entries(m.variants as Record<string, Record<string, unknown>>).map(([key, config]) => ({ sport_key: m.key, key, name: key, is_system: true, config })),
);
const OPTIONS: SportOption[] = sportOptionsFrom(
  builtinModules.map((m) => ({ key: m.key, name: m.key })),
  variantRows,
  (key) => {
    const model = modelOf(key);
    return { kinds: model.kinds, defaultKind: model.defaultKind };
  },
);

function mountBuilder(sport = "badminton") {
  const option = OPTIONS.find((o) => o.key === sport);
  if (!option) throw new Error(`no sport option ${sport}`);
  const h = renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: [option],
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
  });
  setName(h, "Open");
  next(h);
  expect(currentStep(h), `${sport}: the rig reaches Format`).toBe("format");
  return h;
}
type H = ReturnType<typeof mountBuilder>;

const setEntrants = (h: H, n: number) => (propsOf(byTestId(h, "division-builder-plan-entrants")!).onChange as (e: unknown) => void)({ target: { value: String(n) } });
const qualifyKnob = (h: H) => h.tree().find((e) => e.type === "input" && propsOf(e)["data-format-bound"] === "qualify");
const press = (h: H, label: string) => {
  const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  (propsOf(el).onClick as () => void)();
};
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

type Tree = { tree: () => ReactElement[] };
const cardOf = (h: Tree, key: string): ReactElement => {
  const card = h.tree().find((e) => e.type === "label" && propsOf(e)["data-template"] === key);
  if (!card) throw new Error(`no format card for ${key}`);
  return card;
};
const inCard = (card: ReactElement, id: string) => walk(card).find((e) => propsOf(e)["data-testid"] === id);
const radioOf = (card: ReactElement) => walk(card).find((e) => e.type === "input" && propsOf(e).type === "radio")!;
/** What a card says about the field: its reason, or null when it shows the estimate instead. A card showing both, or neither, throws. */
function cardSays(h: Tree, key: string): string | null {
  const card = cardOf(h, key);
  const reason = inCard(card, `division-builder-size-reason-${key}`);
  const estimate = inCard(card, `division-builder-estimate-${key}`);
  if ((reason === undefined) === (estimate === undefined)) throw new Error(`${key} must show exactly one of its reason and its estimate`);
  return reason === undefined ? null : textOf(reason);
}
const gatedCards = (h: Tree) => h.tree().filter((e) => e.type === "label" && propsOf(e)["data-size-gated"] !== undefined);

beforeEach(() => {
  apiV1Mock.mockReset();
});

describe("X-PL-1 the builder shows Knockout + Plate disabled below 4 with the reason", () => {
  it("the empty case: the opening plan of 16 gates no card at all, on every sport, and both formats are pickable", () => {
    let checked = 0;
    for (const option of OPTIONS) {
      const h = mountBuilder(option.key);
      expect(gatedCards(h), option.key).toEqual([]);
      for (const key of GATED) {
        if (!templateKeys(h).includes(key)) continue;
        expect(cardSays(h, key), `${option.key} ${key}`).toBeNull();
        expect(propsOf(radioOf(cardOf(h, key))).disabled, `${option.key} ${key}`).toBe(false);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: sized formats read").toBeGreaterThan(0);
  });

  it("at 3 and at 2, on every sport that offers them: on show in the first five, unpickable, saying the bound and the field", () => {
    let checked = 0;
    for (const option of OPTIONS) {
      const offer = templatesForSport(option.key, engineEntrantKinds(option.key)).map((t) => t.key);
      const expected = GATED.filter((k) => offer.includes(k));
      const h = mountBuilder(option.key);
      for (const n of [3, 2]) {
        setEntrants(h, n);
        // Only the rulebook's two formats are sized at these fields: every other card reads as before.
        expect(gatedCards(h).map((c) => propsOf(c)["data-template"]).sort(), `${option.key} n=${n}`).toEqual([...expected].sort());
        for (const key of expected) {
          const card = cardOf(h, key);
          expect(cardSays(h, key), `${option.key} ${key} n=${n}`).toBe(needs(4, n));
          expect(propsOf(radioOf(card)).disabled, `${option.key} ${key} n=${n}: the radio`).toBe(true);
          expect(propsOf(card)["aria-disabled"], `${option.key} ${key} n=${n}`).toBe("true");
          expect(String(propsOf(card).className), `${option.key} ${key} n=${n}`).toContain("cursor-not-allowed");
          expect(visibleTemplateKeys(h), `${option.key} ${key} n=${n}: 5A shows it, ranking would fold it`).toContain(key);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: gated cards read").toBeGreaterThan(0);
  });

  it("the codes on the cards are the server's, so the card and the refusal cannot drift", () => {
    const h = mountBuilder();
    setEntrants(h, 3);
    expect(propsOf(cardOf(h, "ko_plate"))["data-size-gated"]).toBe("KO_PLATE_TOO_FEW");
    expect(propsOf(cardOf(h, "qualifying_main"))["data-size-gated"]).toBe("QUALIFYING_MAIN_TOO_FEW");
  });

  it("at 4: no reason, the estimate, a live radio, and the tap picks it; back at 3 it closes again", () => {
    const h = mountBuilder();
    setEntrants(h, 4);
    for (const key of GATED) {
      expect(cardSays(h, key), key).toBeNull();
      expect(propsOf(radioOf(cardOf(h, key))).disabled, key).toBe(false);
      expect(propsOf(cardOf(h, key))["aria-disabled"], key).toBeUndefined();
    }
    expect(gatedCards(h)).toEqual([]);
    pickTemplate(h, "ko_plate");
    expect(pickedTemplate(h)).toBe("ko_plate");
    next(h);
    expect(currentStep(h), "4 goes on").toBe("rules");
    goToStep(h, "format");
    setEntrants(h, 3);
    expect(cardSays(h, "qualifying_main")).toBe(needs(4, 3));
  });

  it("the reason is in all four languages with both of its holes", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries({ en: uiEn, es: uiEs, fr: uiFr, nl: uiNl })) {
      const copy = (dict as Record<string, string>)["divBuilder.card.needsEntrants"]!;
      expect(copy, locale).toContain("{min}");
      expect(copy, locale).toContain("{count}");
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("a pick the plan shrank under", () => {
  it.each([
    ["ko_plate", PLATE_SAYS],
    ["qualifying_main", MAIN_SAYS],
  ])("%s keeps its picked look, Next and the step nav refuse with the server's sentence, and 4 lets it go on", (key, says) => {
    const h = mountBuilder();
    pickTemplate(h, key);
    setEntrants(h, 3);
    expect(pickedTemplate(h), "the pick stays: taking it away would lose the organiser's choice").toBe(key);
    expect(cardSays(h, key)).toBe(needs(4, 3));
    next(h);
    expect(currentStep(h)).toBe("format");
    expect(stepError(h)).toBe(says);
    goToStep(h, "review");
    expect(currentStep(h), "the step nav stops here too").toBe("format");
    setEntrants(h, 4);
    next(h);
    expect(stepError(h)).toBeNull();
    expect(currentStep(h)).toBe("rules");
  });

  it("moving to a format the field can play goes on with no refusal left behind", () => {
    const h = mountBuilder();
    pickTemplate(h, "ko_plate");
    setEntrants(h, 3);
    next(h);
    expect(stepError(h)).toBe(PLATE_SAYS);
    pickTemplate(h, "knockout");
    expect(stepError(h), "the sentence goes with the pick it was about").toBeNull();
    next(h);
    expect(currentStep(h)).toBe("rules");
  });

  it("Show example draws nothing, says why, and draws once the field fits", async () => {
    apiV1Mock.mockResolvedValue({ phases: [] });
    const h = mountBuilder();
    pickTemplate(h, "ko_plate");
    setEntrants(h, 3);
    press(h, UI["wizard.showExample"]!);
    await flush();
    expect(apiV1Mock).not.toHaveBeenCalled();
    expect(h.text()).toContain(PLATE_SAYS);
    setEntrants(h, 4);
    expect(h.text(), "the sentence goes when the field changes").not.toContain(PLATE_SAYS);
    press(h, UI["wizard.generate"]!);
    await flush();
    expect(apiV1Mock).toHaveBeenCalledTimes(1);
  });
});

describe("X-QM-2 the builder cannot send a cut through a round", () => {
  it("qualifying_main shows no Qualify knob, so what it sends is the whole round of 4 (format-choice.ts); league_ko's knob stays", () => {
    const h = mountBuilder();
    pickTemplate(h, "qualifying_main");
    expect(qualifyKnob(h), "qualifying_main").toBeUndefined();
    const take = (formatStagesFor("qualifying_main", { qualified: 3, swissRounds: 3, poolCount: 2, legs: 1, standingsCarry: "none" })[1]!.progression as { sources: { take: unknown[] }[] }).sources[0]!.take;
    expect(take, "a stale 3 from another format's knob does not ride along").toEqual([{ kind: "rankRange", from: 1, to: 4 }]);
    pickTemplate(h, "league_ko");
    expect(qualifyKnob(h), "league_ko").toBeDefined();
  });
});

describe("the Format dialog shares the picker, over the division's real field", () => {
  const SPORT = "badminton";
  const KINDS = engineEntrantKinds(SPORT);
  const OFFER = templatesForSport(SPORT, KINDS).map((t) => t.key);
  const props = (over: Partial<DivisionFormatProps>): DivisionFormatProps => ({
    divisionId: "d1",
    sportKey: SPORT,
    stages: [],
    offer: OFFER,
    entrantKinds: KINDS,
    templateLocks: {},
    carryAllowed: true,
    viewerPlan: "community",
    entrants: 6,
    places: 2,
    matchMinutes: 30,
    locked: false,
    canEdit: true,
    ...over,
  });
  const expand = (node: ReactNode): ReactElement[] =>
    walk(node).flatMap((el) => {
      if (el.type === Modal) return [el, ...expand(propsOf(el).footer as ReactNode)];
      if (el.type === LegsChoice) return [el, ...expand(expandWithHooks(LegsChoice, propsOf(el) as Parameters<typeof LegsChoice>[0]))];
      return [el];
    });
  const dialog = (over: Partial<DivisionFormatProps>) => renderIsland(DivisionFormatDialog, { ...props(over), onClose: vi.fn() }, expand);
  const stored = (template: string): DivisionFormatStage[] =>
    buildTemplateStages(template, { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 }).map((d) => ({ name: d.name, kind: d.kind, config: d.config ?? null, progression: d.progression ?? null }));

  it("3 real entrants: disabled, with the real count", () => {
    const h = dialog({ entrants: 3 });
    for (const key of GATED) {
      expect(cardSays(h, key), key).toBe(needs(4, 3));
      expect(propsOf(radioOf(cardOf(h, key))).disabled, key).toBe(true);
    }
  });

  it("the empty case: before anyone has entered the opening field stands in, so nothing says \"You have 0\"", () => {
    for (const entrants of [0, 1]) {
      const h = dialog({ entrants });
      expect(gatedCards(h), `${entrants} entrants`).toEqual([]);
      expect(h.text(), `${entrants} entrants`).not.toContain(needs(4, entrants));
    }
  });

  it("4 real entrants: pickable; a stored plate that the field fell under stays picked and says why", () => {
    const open = dialog({ entrants: 4 });
    expect(gatedCards(open)).toEqual([]);
    const fell = dialog({ entrants: 3, stages: stored("ko_plate") });
    expect(pickedTemplate(fell)).toBe("ko_plate");
    expect(cardSays(fell, "ko_plate")).toBe(needs(4, 3));
    expect(templateCards(fell).length, "anti-vacuity: the dialog drew cards").toBeGreaterThan(0);
  });
});
