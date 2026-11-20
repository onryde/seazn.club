// "On this page" for a help article: its level-2 headings, in document order, with the ids the
// renderer wrote (server/help-heading-ids.ts, read through helpHeadings or the article render — never a
// second slugger). Client-safe and pure, so the server page and the tests read the same rule.
//
// FEWER THAN TWO level-2 headings: no list at all. One entry would only repeat the page's own first
// section, and none is the empty case.
export interface HelpTocEntry {
  id: string;
  text: string;
}

/** The smallest number of h2s that earns an "On this page" list. */
export const HELP_TOC_MIN_ENTRIES = 2;

export function helpTocEntries(headings: readonly { depth: 2 | 3; text: string; id: string }[]): HelpTocEntry[] {
  const entries = headings.filter((h) => h.depth === 2).map((h) => ({ id: h.id, text: h.text }));
  return entries.length >= HELP_TOC_MIN_ENTRIES ? entries : [];
}
