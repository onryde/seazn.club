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
