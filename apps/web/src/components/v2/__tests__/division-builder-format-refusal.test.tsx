// Match Day E1 item 8 (D1): the builder's format refusal ("Qualify to finals: choose a whole number from 2 to 32.") goes away the moment
// the knob it names changes. It used to stay on screen after the organiser had mended the box - a red sentence about a value that was
// no longer there - until the next Next / Create press, and a refused "Show example" stayed until Generate was pressed again.
//
// The refusal is tagged with the knobs it was raised for and dropped DURING RENDER when they differ (the example draw's own pattern in
// this file's sibling, `division-builder-example-knobs.test.tsx`), so nothing resurrects it when the knob is put back, and an error that
// is NOT about the format (a missing name) is never touched by a knob change.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
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

const UI = uiEn as Record<string, string>;
const SPORTS: SportOption[] = [{ key: "generic", name: "Generic", variants: [{ key: "score", name: "Score", system: true }] }];
const SWISS_KO = "Swiss Knockout";

const mount = () =>
  renderIsland(DivisionBuilder, { competitionId: "c1", orgSlug: "org", compSlug: "comp", sports: SPORTS, constraintsAllowed: true, archivedSlotsExplainRefusal: false, viewerPlan: "community" });
type H = ReturnType<typeof mount>;

const press = (h: H, label: string) => {
  const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  (propsOf(el).onClick as () => void)();
};
const pickFormat = (h: H, label: string) => {
  const labelEl = h.tree().find((e) => e.type === "label" && textOf(e).includes(label));
  if (!labelEl) throw new Error(`no template option labelled ${JSON.stringify(label)}`);
  (propsOf(walk(labelEl).find((e) => e.type === "input" && propsOf(e).type === "radio")!).onChange as () => void)();
};
const setName = (h: H, value: string) => {
  const el = h.tree().find((e) => e.type === "input" && propsOf(e)["data-testid"] === "division-builder-name");
  (propsOf(el!).onChange as (e: unknown) => void)({ target: { value } });
};
const setKnob = (h: H, bound: "qualify" | "swissRounds" | "pools", value: string) => {
  const el = h.tree().find((e) => e.type === "input" && propsOf(e)["data-format-bound"] === bound);
  if (!el) throw new Error(`no ${bound} knob on screen`);
  (propsOf(el).onChange as (e: unknown) => void)({ target: { value } });
};

/** The refusal's sentence, from the shipped copy and the bounds the organiser is told (never typed here). */
const refusal = (): string =>
  UI["wizard.err.formatBound"]!
    .replace("{field}", UI["wizard.qualify"]!)
    .replace("{min}", String(FORMAT_BOUNDS.qualify.min))
    .replace("{max}", String(FORMAT_BOUNDS.qualify.max));
const OUT_OF_RANGE = String(FORMAT_BOUNDS.qualify.max + 1);
const IN_RANGE = String(FORMAT_BOUNDS.qualify.min + 1);

/** A builder on the Format step, Swiss Knockout picked (it shows the Top N knob and the Rounds knob), a name entered. */
function onFormatTab(): H {
  const h = mount();
  setName(h, "Cup");
  pickFormat(h, SWISS_KO);
  press(h, UI["wizard.tab.format"]!);
  return h;
}

beforeEach(() => apiV1Mock.mockReset());

describe("division builder - a format refusal goes when the knob it names changes", () => {
  it("Next / a step jump: refused at 33, gone the moment the box changes, not resurrected by putting 33 back, raised again on the next press", () => {
    const h = onFormatTab();
    setKnob(h, "qualify", OUT_OF_RANGE);
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "premise: the refusal is on screen").toContain(refusal());

    setKnob(h, "qualify", IN_RANGE);
    expect(h.text(), "mended: the sentence about the old value is gone").not.toContain(refusal());

    setKnob(h, "qualify", OUT_OF_RANGE);
    expect(h.text(), "putting 33 back does not resurrect it - nothing has been pressed").not.toContain(refusal());

    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "the second call refuses again (the clear is not a latch)").toContain(refusal());
  });

  it("the Show example refusal clears the same way", () => {
    const h = onFormatTab();
    setKnob(h, "qualify", OUT_OF_RANGE);
    press(h, UI["wizard.showExample"]!);
    expect(h.text(), "premise: the refused example says why").toContain(refusal());
    expect(apiV1Mock, "and nothing was drawn").not.toHaveBeenCalled();

    setKnob(h, "qualify", IN_RANGE);
    expect(h.text()).not.toContain(refusal());
  });

  it("changing the format picks a different knob set: the refusal about the old one goes too", () => {
    const h = onFormatTab();
    setKnob(h, "qualify", OUT_OF_RANGE);
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text()).toContain(refusal());
    pickFormat(h, "Double elimination");
    expect(h.text(), "the template that showed the Top N is gone with its refusal").not.toContain(refusal());
  });

  it("Create, with a bad knob behind it (Format stays mounted, folded, under Review): the refusal Create raises clears the same way", () => {
    const h = onFormatTab();
    press(h, UI["wizard.next"]!);
    press(h, UI["wizard.next"]!);
    const create = () => h.tree().find((e) => e.type === "button" && propsOf(e)["data-testid"] === "division-builder-create");
    expect(create(), "premise: a clean walk reaches Create").toBeDefined();
    setKnob(h, "qualify", OUT_OF_RANGE);
    expect(propsOf(create()!).disabled, "Create is disabled while a step is blocked").toBe(true);
    (propsOf(create()!).onClick as () => void)(); // pressed anyway: submit() asks again
    expect(h.text(), "premise: Create refuses the knob before any POST").toContain(refusal());
    expect(apiV1Mock, "and nothing was sent").not.toHaveBeenCalled();
    setKnob(h, "qualify", IN_RANGE);
    expect(h.text()).not.toContain(refusal());
  });

  it("an error that is NOT about the format is left alone by a knob change", () => {
    const h = onFormatTab();
    setKnob(h, "qualify", OUT_OF_RANGE);
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "premise: a format refusal was raised").toContain(refusal());
    // Back to Who plays (free), blank the name, try to move on: the name is refused - a different error in the same slot.
    press(h, UI["divBuilder.step.who"]!);
    setName(h, "");
    press(h, UI["wizard.tab.format"]!);
    expect(h.text(), "premise: the name error is on screen").toContain(UI["wizard.err.name"]!);
    // The knob the OLD refusal named moves: the name error must stay.
    setKnob(h, "qualify", IN_RANGE);
    expect(h.text(), "an unrelated error survives a knob change").toContain(UI["wizard.err.name"]!);
  });
});

// W5 Task 12 (X-BD-1, PO-1): a pool count the plan's field cannot fill is refused at Next, naming the count that works - the same numbers
// the server's first Generate refuses with (C38). The sentence is typed from the copy decision (RB5-E4: floor(7/3)=2, so 3 pools).
describe("division builder - a pool count the plan cannot fill (X-BD-1)", () => {
  const GROUPS_KO = "Groups + Knockout";
  const setPlanEntrants = (h: H, value: string) => {
    const el = h.tree().find((e) => e.type === "input" && propsOf(e)["data-testid"] === "division-builder-plan-entrants");
    if (!el) throw new Error("no plan entrants box on screen");
    (propsOf(el).onChange as (e: unknown) => void)({ target: { value } });
  };
  const poolRefusal = "Pools: 4 pools need at least 8 entrants in total, 2 per pool (have 7). Choose 3 pools, or add entrants.";
  function onPools(plan: string, pools: string): H {
    const h = mount();
    setName(h, "Cup");
    setPlanEntrants(h, plan);
    pickFormat(h, GROUPS_KO);
    press(h, UI["wizard.tab.format"]!);
    setKnob(h, "pools", pools);
    return h;
  }

  it("X-BD-1 Next refuses 7 into 4 naming 3, goes when the pool box or the plan changes, and 7 into 3 passes", () => {
    // differential: the builder judged only the pool count's bounds (2..8) before, so 4 pools passed for a plan of 7.
    const h = onPools("7", "4");
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "premise: the refusal is on screen").toContain(poolRefusal);
    expect(h.text(), "the same sentence the dictionary holds for the pool-size refusal").toContain(UI["wizard.err.poolSize"]!.replace("{field}", "Pools").replace("{pools}", "4").replace("{required}", "8").replace("{entrants}", "7").replace("{suggested}", "3"));
    expect(apiV1Mock).not.toHaveBeenCalled();

    setKnob(h, "pools", "3");
    expect(h.text(), "mended by the count it offered").not.toContain(poolRefusal);
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "and 7 into 3 passes Next").not.toContain("Pools:");

    setKnob(h, "pools", "4");
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "4 refused again").toContain(poolRefusal);
    setPlanEntrants(h, "8");
    expect(h.text(), "a plan of 8 fills 4 pools: the refusal goes with the number it named").not.toContain(poolRefusal);
  });

  it("X-BD-1 Show example refuses the same field before drawing anything", () => {
    const h = onPools("7", "4");
    press(h, UI["wizard.showExample"]!);
    expect(h.text()).toContain(poolRefusal);
    expect(apiV1Mock, "nothing was drawn").not.toHaveBeenCalled();
  });

  it("X-BD-1 a plan too small for any pool count says to add entrants and names no count", () => {
    const h = onPools("3", "2");
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text()).toContain("Pools: 2 pools need at least 4 entrants in total, 2 per pool (have 3). Add entrants.");
  });
});

// W5 Task 12b (X-BD-8, RB5-E6): a Top N the plan's field cannot supply is refused at Next, naming the largest cut that works - the same
// numbers the server's Start and resolve doors refuse with (RR_CUT_EXCEEDS_FIELD). The sentences are typed from the copy decision.
describe("division builder - a Top N the plan cannot supply (X-BD-8)", () => {
  const setPlanEntrants = (h: H, value: string) => {
    const el = h.tree().find((e) => e.type === "input" && propsOf(e)["data-testid"] === "division-builder-plan-entrants");
    if (!el) throw new Error("no plan entrants box on screen");
    (propsOf(el).onChange as (e: unknown) => void)({ target: { value } });
  };
  const exceeds = "Qualify to finals: 8 can't qualify from 6 entrants. Choose 6 or fewer, or add entrants.";
  const bestNth = "Qualify to finals: 2 pools of this size can supply at most 6 qualifiers, not 7. Choose 6 or fewer, or add entrants.";

  it("X-BD-8 Swiss Knockout: a top 8 of a plan of 6 is refused naming 6, goes when the box or the plan changes, and 6 of 6 passes", () => {
    // differential: the builder judged only the Top N's bounds (2..32), so a top 8 of 6 passed and the server met it at Complete.
    const h = mount();
    setName(h, "Cup");
    setPlanEntrants(h, "6");
    pickFormat(h, SWISS_KO);
    press(h, UI["wizard.tab.format"]!);
    setKnob(h, "qualify", "8");
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "premise: the refusal is on screen").toContain(exceeds);
    expect(apiV1Mock).not.toHaveBeenCalled();

    setKnob(h, "qualify", "6");
    expect(h.text(), "mended by the number it named").not.toContain(exceeds);
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "and a cut equal to the field passes Next (the off-by-one pin)").not.toContain("can't qualify");

    setKnob(h, "qualify", "8");
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "8 refused again").toContain(exceeds);
    setPlanEntrants(h, "8");
    expect(h.text(), "a plan of 8 can supply 8: the refusal goes with the number it named").not.toContain(exceeds);
  });

  it("X-BD-8 Groups + Knockout: K16 RB5-U7 (ruling 286) - a Top 7 of 7 in pools of 4 and 3 is supplied; a Top 8 is over the field", () => {
    // Re-pinned in W5 app PR B T5 part 3: Task 4 (ruling 286) re-pinned the gate's own test (lib/__tests__/field-cut-gate.test.ts K16)
    // and left this one asserting the 9.x refusal. 7 into pools of 4 and 3: the best 4th is the 4-pool's own; the 3-pool has no 4th and
    // is left out of the comparison (RB5-U7). differential: under 9.x every pool had to hold the nth, so this was refused, max 6.
    const h = mount();
    setName(h, "Cup");
    setPlanEntrants(h, "7");
    pickFormat(h, "Groups + Knockout");
    press(h, UI["wizard.tab.format"]!);
    setKnob(h, "pools", "2");
    setKnob(h, "qualify", "7");
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "Top 7 of 7 is supplied").not.toContain("can't qualify");
    expect(h.text(), "no shape refusal under RB5-U7").not.toContain(bestNth);
    setKnob(h, "qualify", "8");
    press(h, UI["divBuilder.step.review"]!);
    expect(h.text(), "Top 8 of 7 is over the field").toContain("Qualify to finals: 8 can't qualify from 7 entrants. Choose 7 or fewer, or add entrants.");
    expect(h.text()).not.toContain(bestNth);
  });

  it("X-BD-8 Show example refuses the same cut before drawing anything", () => {
    const h = mount();
    setName(h, "Cup");
    setPlanEntrants(h, "6");
    pickFormat(h, SWISS_KO);
    press(h, UI["wizard.tab.format"]!);
    setKnob(h, "qualify", "8");
    press(h, UI["wizard.showExample"]!);
    expect(h.text()).toContain(exceeds);
    expect(apiV1Mock, "nothing was drawn").not.toHaveBeenCalled();
  });
});

// D1's other half: the builder's number inputs measured 42px and Next / Back 38px, under the house 44px tap floor (`min-h-11`). The painted
// height is `mobile.spec.ts`'s; this pins the class on EVERY number input the builder draws (every tab's, shown or hidden) and on every
// button of the Cancel / Back / Next / Create row, so a new knob or a restyled button cannot slip back under it.
describe("division builder - the 44px tap floor (D1)", () => {
  const classesOfEl = (el: { props?: unknown }): string[] => String((propsOf(el as never).className as string | undefined) ?? "").split(/\s+/);

  it("every number input the builder draws carries min-h-11", () => {
    const h = mount();
    pickFormat(h, SWISS_KO); // the Top N and Rounds knobs only draw under a template that shows them
    const numbers = h.tree().filter((e) => e.type === "input" && propsOf(e).type === "number");
    // The eligibility age and cut-off day, the Top N, the Rounds, the example count and the match length: more than one tab's worth.
    expect(numbers.length, "number inputs swept").toBeGreaterThanOrEqual(5);
    for (const el of numbers) expect(classesOfEl(el), `a number input (${String(propsOf(el)["data-format-bound"] ?? propsOf(el).min)})`).toContain("min-h-11");
  });

  it("Cancel, Back, Next (and Create on the last step) carry min-h-11", () => {
    const h = mount();
    setName(h, "Cup");
    const row = (labels: string[]) => {
      let swept = 0;
      for (const label of labels) {
        const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
        expect(el, `the ${label} button is drawn`).toBeDefined();
        expect(classesOfEl(el!), label).toContain("min-h-11");
        swept++;
      }
      return swept;
    };
    expect(row([UI["wizard.cancel"]!, UI["wizard.next"]!]), "first tab: no Back").toBe(2);
    press(h, UI["wizard.next"]!);
    expect(row([UI["wizard.cancel"]!, UI["wizard.back"]!, UI["wizard.next"]!]), "a middle tab: Back appears").toBe(3);
    press(h, UI["wizard.next"]!);
    press(h, UI["wizard.next"]!);
    const create = h.tree().find((e) => e.type === "button" && propsOf(e)["data-testid"] === "division-builder-create");
    expect(create, "the last step draws Create").toBeDefined();
    expect(classesOfEl(create!)).toContain("min-h-11");
  });
});

// W5 app PR B T5 part 3 (RB5-D10, X-PD-4; controller ruling, owner standing "apply rec"): before Start, the builder says when the
// knockout draw can be refused - two pools' winners and the best runner-up into a 4-draw (X-PD-4's named case), and three pools' winners
// with one best runner-up. Whole pool places (Top 2 / Top 4 of two pools, Top 3 / Top 6 of three) always separate (X-PD-2): no line. The
// sentence is the en dictionary's; which shapes refuse is the rulebook's, never this component's.
describe("division builder - the draw can be refused (RB5-D10)", () => {
  const SAYS = UI["divBuilder.format.drawCanRefuse"]!;
  const line = (h: H) => h.tree().filter((e) => propsOf(e)["data-testid"] === "division-builder-draw-can-refuse");
  function onFormat(label: string): H {
    const h = mount();
    setName(h, "Cup");
    pickFormat(h, label);
    press(h, UI["wizard.tab.format"]!);
    return h;
  }

  it("groups_ko: 2 pools Top 3 warns, Top 4 mends it, Top 3 again warns again; 3 pools Top 4 warns, Top 6 does not", () => {
    const h = onFormat(UI["format.template.groups_ko.label"]!);
    setKnob(h, "pools", "2");
    setKnob(h, "qualify", "3");
    expect(h.text(), "X-PD-4's named case").toContain(SAYS);
    expect(line(h), "one line, not one per knob").toHaveLength(1);
    setKnob(h, "qualify", "4");
    expect(h.text(), "Top 4 of two pools is whole pool places (X-PD-2)").not.toContain(SAYS);
    setKnob(h, "qualify", "3");
    expect(h.text(), "the second time, again (no latch)").toContain(SAYS);
    setKnob(h, "pools", "3");
    setKnob(h, "qualify", "4");
    expect(h.text(), "three winners and one best runner-up").toContain(SAYS);
    setKnob(h, "qualify", "6");
    expect(h.text(), "Top 6 of three pools is whole pool places").not.toContain(SAYS);
    expect(apiV1Mock, "said on screen, nothing sent").not.toHaveBeenCalled();
  });

  it("another format: a league-fed stepladder is never drawn across pools, so Top 3 says nothing", () => {
    const h = onFormat(UI["format.template.group_stepladder.label"]!);
    expect(h.text(), "premise: the format tab is open").toContain(UI["wizard.qualify"]!);
    expect(line(h)).toHaveLength(0);
    expect(h.text()).not.toContain(SAYS);
  });
});
