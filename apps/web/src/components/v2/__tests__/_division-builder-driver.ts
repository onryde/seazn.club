// Driving the 4-step division builder (Match Day C9) without a DOM, on the shared hook harness. One place for the
// builder's controls, so the suites that click it share a single reading of its markup.
//
// The Division rules step is the DivisionRulesStrip in its draft mode, a nested component the harness does not expand:
// a suite reaches its fields through the strip element's own `draft` prop (the variant pick, the rule values, online
// play, points, the tie-break order) - the same callbacks the strip's controls call.
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionRulesStrip, type DivisionRulesDraft, type DivisionRulesStripProps } from "@/components/v2/rules/division-rules-strip";
import type { BuilderStep } from "@/lib/division-builder/model";

export type BuilderIsland = { tree: () => ReactElement[] };

export function byTestId(h: BuilderIsland, id: string): ReactElement | undefined {
  return h.tree().find((e) => propsOf(e)["data-testid"] === id);
}

export function click(h: BuilderIsland, id: string): void {
  const el = byTestId(h, id);
  if (!el) throw new Error(`no ${id} on screen`);
  (propsOf(el).onClick as () => void)();
}

/** A step-nav jump (back is free; forward stops on the first unfinished step, as a tap does). */
export function goToStep(h: BuilderIsland, step: BuilderStep): void {
  click(h, `division-builder-step-${step}`);
}

export const next = (h: BuilderIsland) => click(h, "division-builder-next");
export const back = (h: BuilderIsland) => click(h, "division-builder-back");
export const pressCreate = (h: BuilderIsland) => click(h, "division-builder-create");

/** The step on screen (the form's `data-step`). */
export function currentStep(h: BuilderIsland): BuilderStep {
  const form = h.tree().find((e) => e.type === "form" && propsOf(e)["data-testid"] === "division-builder");
  if (!form) throw new Error("no builder form");
  return propsOf(form)["data-step"] as BuilderStep;
}

export function stepError(h: BuilderIsland): string | null {
  const el = byTestId(h, "division-builder-error");
  return el ? textOf(el) : null;
}

export function setName(h: BuilderIsland, value: string): void {
  const el = byTestId(h, "division-builder-name");
  if (!el) throw new Error("no name field");
  (propsOf(el).onChange as (e: unknown) => void)({ target: { value } });
}

/** Pick a sport, as a tap on its tile does (C9 R2: the Sport step is a radio tile per sport; a tile folded under Show
 *  more is in the tree too, hidden, as the format cards are). */
export function selectSport(h: BuilderIsland, key: string): void {
  const radio = h.tree().find((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "division-sport" && propsOf(e).value === key);
  if (!radio) throw new Error(`no sport tile for ${key}`);
  (propsOf(radio).onChange as () => void)();
}

/** Every format card rendered (folded or not), in the order the builder ranks them. */
export function templateCards(h: BuilderIsland): ReactElement[] {
  return h.tree().filter((e) => e.type === "label" && typeof propsOf(e)["data-template"] === "string");
}

/** The cards an organiser can see without Show more: not folded away. */
export function visibleTemplateKeys(h: BuilderIsland): string[] {
  return templateCards(h)
    .filter((e) => !/(^|\s)hidden(\s|$)/.test(String(propsOf(e).className)))
    .map((e) => propsOf(e)["data-template"] as string);
}

export function templateKeys(h: BuilderIsland): string[] {
  return templateCards(h).map((e) => propsOf(e)["data-template"] as string);
}

/** Pick a format by its key, as a tap on its card does. */
export function pickTemplate(h: BuilderIsland, key: string): void {
  const card = templateCards(h).find((e) => propsOf(e)["data-template"] === key);
  if (!card) throw new Error(`no format card for ${key}`);
  const radio = walk(card).find((e) => e.type === "input" && propsOf(e).type === "radio");
  (propsOf(radio!).onChange as () => void)();
}

/** The picked format's key. */
export function pickedTemplate(h: BuilderIsland): string | undefined {
  const card = templateCards(h).find((e) => walk(e).some((c) => c.type === "input" && propsOf(c).type === "radio" && propsOf(c).checked));
  return card === undefined ? undefined : (propsOf(card)["data-template"] as string);
}

/** The Division rules strip's draft: the builder's own state and callbacks, as the strip's controls see them. */
export function rulesDraft(h: BuilderIsland): DivisionRulesDraft {
  const strip = h.tree().find((e) => e.type === DivisionRulesStrip);
  if (!strip) throw new Error("no Division rules strip");
  const draft = propsOf(strip).draft as DivisionRulesDraft | undefined;
  if (!draft) throw new Error("the builder's strip is not in draft mode");
  return draft;
}

export function rulesStripProps(h: BuilderIsland): Record<string, unknown> {
  const strip = h.tree().find((e) => e.type === DivisionRulesStrip);
  if (!strip) throw new Error("no Division rules strip");
  return propsOf(strip);
}

/** The Division rules strip rendered on its own with exactly the props the builder hands it (draft mode): its variant
 *  select, rule grid and online-play controls, whose handlers are the builder's own setters. A snapshot of the props at
 *  the time of the call: render it again after a change to see the builder's new state. */
export function builderStrip(h: BuilderIsland, expand?: (node: ReactNode) => ReactElement[]): BuilderIsland & { text: () => string } {
  return renderIsland(DivisionRulesStrip, rulesStripProps(h) as unknown as DivisionRulesStripProps, expand);
}

/** Every field Who plays needs, filled, then on to Review through each step's Next (each one judged on the way). */
export function walkToReview(h: BuilderIsland, name = "Open"): void {
  setName(h, name);
  for (let i = 0; i < 3 && currentStep(h) !== "review"; i++) {
    const before = currentStep(h);
    next(h);
    if (currentStep(h) === before) throw new Error(`Next did not leave ${before}: ${stepError(h) ?? "(no reason shown)"}`);
  }
}
