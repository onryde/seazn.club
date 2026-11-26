// The streaming guide's checklist, a post's own Markdown table, as it is drawn at one width: a card per row below 480px,
// an ordinary table from there up. Used by e2e/blog.spec.ts (320, 768, 1280) and e2e/mobile/blog.spec.ts (the width
// projects). The renderer's half (roles and labels) is src/server/__tests__/blog-render.test.ts.
import { expect, type Page } from "@playwright/test";

export const CHECKLIST_POST = "/blog/what-you-need-to-stream-a-match";
/** Narrow phones: typed from the rule, not read from the stylesheet. */
const STACKED_BELOW = 480;
const COLUMNS = ["What", "Minimum", "Better"];

export async function expectChecklist(page: Page, width: number): Promise<void> {
  const region = page.locator(".blog-prose .help-scroll");
  await expect(region).toHaveCount(1);
  const table = region.locator("table");
  await expect(table).toBeVisible();

  // Whatever it looks like, it is a table to a screen reader: three named columns, and each row named by its first cell.
  const semantic = region.getByRole("table");
  await expect(semantic).toHaveCount(1);
  expect(await semantic.getByRole("columnheader").allTextContents()).toEqual(COLUMNS);
  const rows = await table.locator("tbody tr").count();
  expect(rows, "anti-vacuity: checklist rows").toBeGreaterThanOrEqual(4);
  await expect(semantic.getByRole("rowheader")).toHaveCount(rows);
  await expect(semantic.getByRole("rowheader", { name: "Phone", exact: true })).toHaveCount(1);
  await expect(semantic.getByRole("cell")).toHaveCount(rows * (COLUMNS.length - 1));
  // The label drawn in a card is not read twice: it is no part of a cell's name.
  await expect(semantic.getByRole("cell", { name: /Android 12 or later/ })).toHaveCount(1);
  await expect(semantic.getByRole("cell", { name: /^(?:Minimum|Better)\b/ })).toHaveCount(0);

  // Nothing is off to the side: the box has nothing to scroll, as cards or as a table that fits.
  if (width < STACKED_BELOW) {
    expect(await region.evaluate((el) => el.scrollWidth - el.clientWidth), "cards never scroll sideways").toBeLessThanOrEqual(1);
  }

  const head = (await table.locator("thead").boundingBox())!;
  let checked = 0;
  for (let i = 0; i < rows; i++) {
    const cells = table.locator("tbody tr").nth(i).locator("td");
    const boxes = [];
    for (let c = 0; c < COLUMNS.length; c++) boxes.push((await cells.nth(c).boundingBox())!);
    const labels = cells.locator(".blog-cell-label");
    await expect(labels).toHaveCount(COLUMNS.length - 1);
    if (width < STACKED_BELOW) {
      expect(await labels.allTextContents(), `row ${i}: each value is labelled`).toEqual(COLUMNS.slice(1));
      for (let c = 0; c < COLUMNS.length - 1; c++) await expect(labels.nth(c)).toBeVisible();
      for (let c = 1; c < COLUMNS.length; c++) {
        expect(Math.abs(boxes[c]!.x - boxes[0]!.x), `row ${i} cell ${c}: one column`).toBeLessThanOrEqual(1);
        expect(boxes[c]!.y, `row ${i} cell ${c}: under the one before`).toBeGreaterThanOrEqual(boxes[c - 1]!.y + boxes[c - 1]!.height - 1);
      }
      // A card's value gets the card's width, not a third of it.
      expect(boxes[1]!.width, `row ${i}: the value has the card's width`).toBeGreaterThan(width * 0.7);
    } else {
      for (let c = 0; c < COLUMNS.length - 1; c++) await expect(labels.nth(c)).toBeHidden();
      for (let c = 1; c < COLUMNS.length; c++) {
        expect(Math.abs(boxes[c]!.y - boxes[0]!.y), `row ${i} cell ${c}: same line`).toBeLessThanOrEqual(1);
        expect(boxes[c]!.x, `row ${i} cell ${c}: to the right`).toBeGreaterThanOrEqual(boxes[c - 1]!.x + boxes[c - 1]!.width - 1);
      }
    }
    checked++;
  }
  expect(checked, "anti-vacuity: rows measured").toBe(rows);
  // The column header row: out of sight in the card layout, drawn in the table.
  if (width < STACKED_BELOW) expect(head.height, "the header row is out of sight").toBeLessThanOrEqual(1);
  else expect(head.height, "the header row is drawn").toBeGreaterThan(20);
  console.log(`checklist @${width}: ${checked} rows, ${width < STACKED_BELOW ? "cards" : "table"}`);
}
