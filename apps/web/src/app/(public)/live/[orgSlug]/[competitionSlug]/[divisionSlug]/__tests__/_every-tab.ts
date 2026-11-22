// W5 follow-ups B3: the public division page is three ISR documents now - the bare route carries the Schedule panel, and
// `?tab=standings` / `?tab=entrants` (rewritten by the proxy to `tab/[tab]`) carry theirs - where it used to be one document
// with every panel in it. A test that reads "the page" across its tabs renders all three, in tab order, and walks them as
// one tree: the same elements the single document held, in the same order.
import DivisionHomePage from "../page";
import { DIVISION_TABS } from "@/lib/division-tabs";

type PageParams = { orgSlug: string; competitionSlug: string; divisionSlug: string };

/** Every tab's document of one division page, in tab order (Schedule, Standings, Entrants). */
export async function renderEveryTab(params: PageParams): Promise<unknown[]> {
  const roots: unknown[] = [];
  for (const tab of DIVISION_TABS) {
    roots.push(await DivisionHomePage({ params: Promise.resolve(tab === "schedule" ? params : { ...params, tab }) }));
  }
  return roots;
}
