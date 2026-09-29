// The public division page, read as a visitor sees it (Task 5). Product
// facts, read at Step 0 (app/(public)/shared/[orgSlug]/[competitionSlug]/
// [divisionSlug]/page.tsx):
//  - :44 `export const revalidate = 30` — the page is ISR, so what it shows can
//    trail the API by up to 30 s (a concern routed to Task 6's comparison).
//  - :239-252 the champion banner, above the tabs: a <p> saying
//    t(dict, "table.champion") and, next to it, a <p> with the champion's
//    name (`entrantNames[championId] ?? "—"`). No champion, no banner.
//  - :529 `ids={["schedule", "standings", "entrants"]}`; public-site/tabs.tsx
//    renders each tab `id={\`tab-${ids[i]}\`}` with `aria-selected={i === active}`
//    and each panel `id={\`panel-${ids[i]}\`}`, `hidden` unless active; the
//    active tab is `?tab=` read on the client (use-tab-param.ts).
//  - the standings panel is the same StandingsTable as the organiser's
//    (standings.ts); a division whose only stages are brackets shows no table
//    and no note, so the SELECTED TAB is this read's proof the screen rendered.
// The page needs no auth; it is read in the case's own context.
import { NAME } from "../selectors.ts";
import { awaitScreen, navBudget, selectorValue, shoot, visit, type DivisionWhere, type PageCtx } from "./ctx.ts";
import { paths, type PublicTab } from "./paths.ts";
import { CELL_SELECTORS, TABLE_SELECTOR, standingsCellsOf, tablesFromCells, type UiTable } from "./standings.ts";

export const PUBLIC_STANDINGS_TAB: PublicTab = "standings";

export function publicTabSelector(tab: PublicTab): string {
  return `[id="tab-${selectorValue("tab", tab)}"][aria-selected="true"]`;
}
export function publicPanelSelector(tab: PublicTab): string {
  return `[id="panel-${selectorValue("tab", tab)}"]`;
}

/** The element surface championFrom reads — a DOM Element meets it. */
export interface BannerElement { readonly textContent: string | null; readonly nextElementSibling: BannerElement | null }

/** The champion's name: the text of the element after the FIRST paragraph
 *  whose whole text is the banner's label, or null. Runs IN THE PAGE
 *  (evaluateAll serialises it), so it reads nothing outside its arguments. */
export function championFrom(paragraphs: ArrayLike<BannerElement>, label: string): string | null {
  for (const p of Array.from(paragraphs)) {
    if ((p.textContent ?? "").trim() !== label) continue;
    const name = (p.nextElementSibling?.textContent ?? "").trim();
    return name === "" ? null : name;
  }
  return null;
}

/** The public standings tab's tables and the champion banner's name. */
export async function readPublicUi(c: PageCtx, where: DivisionWhere): Promise<{ tables: UiTable[]; champion: string | null }> {
  const { page } = c;
  await visit(c, paths.publicDivision(c.orgSlug, where.compSlug, where.divSlug, PUBLIC_STANDINGS_TAB));
  const t = navBudget(c);
  await awaitScreen(() => page.locator(publicTabSelector(PUBLIC_STANDINGS_TAB)).waitFor({ state: "attached", timeout: t }), "the public page's standings tab, selected", t);
  const cells = await page.locator(publicPanelSelector(PUBLIC_STANDINGS_TAB)).locator(TABLE_SELECTOR).evaluateAll(standingsCellsOf, CELL_SELECTORS);
  const champion = await page.locator("p").evaluateAll(championFrom, NAME.championLabel.text);
  await shoot(c, "11-public");
  return { tables: cells.map(tablesFromCells), champion };
}
