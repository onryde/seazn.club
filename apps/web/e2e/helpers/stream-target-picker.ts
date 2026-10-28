// The fixture stream panel's destination picker (YouTube Connect T12, owner's Option B) — a custom list, no longer a native
// <select>. These are the ways a spec reads and drives it, in ONE place, so the markup lives here and not in a dozen walkthroughs.
//
//   trigger   [data-testid=stream-target]          a role=combobox button; data-value = the picked destination's id ("" = none)
//   rows      [data-testid=stream-target-option]   role=option, data-target-id, aria-selected; in the DOM only while open
//   per row   stream-target-name / -kind / -health the destination's name, "what it is" line, and a health badge (channels only)
import { expect, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STREAM_KIND_BRAND } from "../../src/components/v2/stream-platform-mark";

const EN_UI = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8")) as Record<string, string>;

/** The kind line a PASTED-KEY destination reads as ("YouTube stream key"): the dictionary's own template over the product's own brand
 *  table, so a copy or brand change moves the assertion with it and nothing is typed here. (A connected channel's line is a different
 *  key, `stream.dest.kind.channel`, and is asserted where a spec connects one.) */
export function pastedKeyKindLine(kind: keyof typeof STREAM_KIND_BRAND): string {
  const template = EN_UI["stream.dest.kind.key"];
  if (template === undefined) throw new Error("ui.json has no stream.dest.kind.key");
  return template.replace("{platform}", STREAM_KIND_BRAND[kind]);
}

/** The picker's trigger button — the element the panel's `<label htmlFor>` names. */
export const targetPicker = (scope: Locator): Locator => scope.getByTestId("stream-target");

/** Open the list if it is not open. A press on the trigger toggles, so this checks first. */
export async function openTargetPicker(scope: Locator): Promise<void> {
  const trigger = targetPicker(scope);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

/** Pick a destination by id: open the list, press its row, and wait for the list to close on that pick. */
export async function selectTarget(scope: Locator, id: string): Promise<void> {
  await openTargetPicker(scope);
  await scope.locator(`[data-testid="stream-target-option"][data-target-id="${id}"]`).click();
  await expect(targetPicker(scope)).toHaveAttribute("aria-expanded", "false");
  await expect(targetPicker(scope)).toHaveAttribute("data-value", id);
}

/** The picked destination as the trigger shows it: its NAME and the line saying WHAT it is. The old native `<select>`'s selected option
 *  read both at once ("name (platform)"); the name alone would let a trigger showing the right name for the wrong kind of destination
 *  pass, so both lines are asserted. `kind` is the stored kind of a pasted-key destination; a connected channel passes its own line
 *  through `expectSelectedTargetLine`. */
export async function expectSelectedTarget(scope: Locator, name: string, kind: keyof typeof STREAM_KIND_BRAND, options?: { timeout?: number }): Promise<void> {
  await expectSelectedTargetLine(scope, name, pastedKeyKindLine(kind), options);
}

/** `expectSelectedTarget` for a destination whose kind line is not a pasted key's (a connected YouTube channel, say). */
export async function expectSelectedTargetLine(scope: Locator, name: string, kindLine: string, options?: { timeout?: number }): Promise<void> {
  const trigger = targetPicker(scope);
  await expect(trigger.getByTestId("stream-target-name")).toHaveText(name, options);
  await expect(trigger.getByTestId("stream-target-kind")).toHaveText(kindLine, options);
}

/** The ids the list offers, in order (opens it). */
export async function offeredTargetIds(scope: Locator): Promise<string[]> {
  await openTargetPicker(scope);
  return scope.getByTestId("stream-target-option").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-target-id") ?? ""));
}

/** The offered rows' names, in order (opens it). */
export async function offeredTargetNames(scope: Locator): Promise<string[]> {
  await openTargetPicker(scope);
  return scope.getByTestId("stream-target-option").evaluateAll((rows) => rows.map((r) => r.querySelector('[data-testid="stream-target-name"]')?.textContent ?? ""));
}
