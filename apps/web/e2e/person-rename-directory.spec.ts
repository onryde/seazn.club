// The player directory's ✎ (owner design A, 2026-09-22) at the three widths
// the UI bar names: 320 (a phone card), 768 and 1280 (the table). The rename
// itself, and the pair names that follow it, are in e2e/entrant-rename.spec.ts
// and the entrant-rename walkthrough. This file is about the control itself:
//
//   - the ✎ is a real 44px target, and a tap at its centre lands on it rather
//     than on a neighbour painted over it;
//   - opening the field MOVES NOTHING. The field closes on blur, which fires
//     on the mousedown of the organiser's next click; a row that changed
//     height or a column that changed width when the field closed would slide
//     that click's target out from under the pointer before its mouseup. The
//     first build did exactly that: at 1280 opening the field grew the row by
//     24px and pulled the public-name toggle 71px left;
//   - no width scrolls the page sideways, idle or editing;
//   - Escape hands focus back to the ✎.
//
// Each width captures the row idle and editing as test attachments. With
// RENAME_SHOTS_DIR set, it also writes them there as person-row-{idle,
// editing}-{width}.png, for a visual sign-off.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { TAG, expectNoHorizontalScroll } from "./helpers";
import { waitForHydration } from "./directory-kit";
import { mintSpectatorOrg } from "./spectator-w2-kit";
import { personPencil, seedPerson, uiEn } from "./entrant-rename-kit";

/** A tap at `target`'s centre: which button does the page actually hit? */
async function hitAtCentre(page: Page, target: Locator): Promise<string> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x!, y!);
      return el?.closest("button")?.getAttribute("aria-label") ?? `not a button: ${el?.tagName ?? "nothing"}`;
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );
}

async function capture(holder: Locator, name: string, testInfo: import("@playwright/test").TestInfo) {
  const png = await holder.screenshot();
  await testInfo.attach(name, { body: png, contentType: "image/png" });
  const dir = process.env.RENAME_SHOTS_DIR;
  if (dir) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/${name}.png`, png);
  }
}

for (const width of [320, 768, 1280]) {
  test(`the directory's ✎ at ${width}px: a real target, and opening it moves nothing`, async ({ page }, testInfo) => {
    // A dedicated org: the Players tab lists only an org's OLDEST 200 people
    // (directory-kit's `freshOrg`), and the shared PRO org has more than that.
    await mintSpectatorOrg(page.request, { name: `Directory ✎ ${width} ${TAG}`, plan: "community" });
    // A long name first (oldest first, so it is the first row), a short one
    // under it: the long one is what truncates, the short one is the next
    // row whose ✎ must not move.
    const name = `Venkatesh Subramanian Iyer ${TAG}`;
    const next = `Asha ${TAG}`;
    await seedPerson(page.request, name);
    await seedPerson(page.request, next);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/directory?tab=players");
    const pencil = personPencil(page, name);
    await waitForHydration(pencil);

    // The copy on screen: the table from `sm` (640) up, a card below it.
    const holder = width >= 640 ? page.getByRole("row").nth(1) : page.locator("ul.sm\\:hidden > li").first();
    const publicName = holder.getByRole("button", { name: uiEn["persons.consent.name"]!, exact: true });
    const nextPencil = personPencil(page, next);

    const pencilBox = (await pencil.boundingBox())!;
    expect(pencilBox.width).toBeGreaterThanOrEqual(44);
    expect(pencilBox.height).toBeGreaterThanOrEqual(44);
    expect(await hitAtCentre(page, pencil)).toBe(uiEn["persons.rename"]!.replace("{name}", name));
    await expectNoHorizontalScroll(page);
    const idle = {
      name: (await holder.getByText(name, { exact: true }).boundingBox())!,
      row: (await holder.boundingBox())!,
      toggle: (await publicName.boundingBox())!,
      nextPencil: (await nextPencil.boundingBox())!,
    };
    await capture(holder, `person-row-idle-${width}`, testInfo);

    await pencil.click();
    const field = page.getByTestId("person-name-field");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(name);
    await expectNoHorizontalScroll(page);
    const editing = {
      row: (await holder.boundingBox())!,
      toggle: (await publicName.boundingBox())!,
      nextPencil: (await nextPencil.boundingBox())!,
    };
    await capture(holder, `person-row-editing-${width}`, testInfo);

    // Nothing the organiser might click next has moved: not the row's own
    // height, not the toggle beside the name, not the next row's ✎.
    // Within a pixel, for sub-pixel rounding; the first build moved 24px/71px.
    const same = (what: string, before: number, after: number) =>
      expect(Math.abs(after - before), `${what} moved from ${before} to ${after}`).toBeLessThanOrEqual(1);
    same("the row's height", idle.row.height, editing.row.height);
    for (const [what, before, after] of [
      ["the public-name toggle", idle.toggle, editing.toggle],
      ["the next row's ✎", idle.nextPencil, editing.nextPencil],
    ] as const) {
      same(`${what}, across`, before.x - idle.row.x, after.x - editing.row.x);
      same(`${what}, down`, before.y - idle.row.y, after.y - editing.row.y);
    }
    // The field covers the name it replaces and is itself a 44px target.
    const fieldBox = (await field.boundingBox())!;
    expect(fieldBox.height).toBeGreaterThanOrEqual(44);
    expect(fieldBox.width, "the field is at least as wide as the name was").toBeGreaterThanOrEqual(idle.name.width);

    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(pencil).toBeFocused();
  });
}
