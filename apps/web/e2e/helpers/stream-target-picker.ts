// The fixture stream panel's destination picker (YouTube Connect T12, owner's Option B) — a custom list, no longer a native
// <select>. These are the ways a spec reads and drives it, in ONE place, so the markup lives here and not in a dozen walkthroughs.
//
//   trigger   [data-testid=stream-target]          a role=combobox button; data-value = the picked destination's id ("" = none)
//   rows      [data-testid=stream-target-option]   role=option, data-target-id, aria-selected; in the DOM only while open
//   per row   stream-target-name / -kind / -health the destination's name, "what it is" line, and a health badge (channels only)
import { expect, type Locator } from "@playwright/test";

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

/** The picked destination's NAME as the trigger shows it (what `option:checked` used to read, less the platform suffix the second
 *  line now carries). */
export const expectSelectedTargetName = (scope: Locator, name: string, options?: { timeout?: number }): Promise<void> =>
  expect(targetPicker(scope).getByTestId("stream-target-name")).toHaveText(name, options);

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
