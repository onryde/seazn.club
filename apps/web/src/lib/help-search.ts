// Help search, in the browser, over the index rows (server/help-search-index.ts via /api/help-index).
// No service and no dependency: the index is a few dozen rows of short text, so a plain scan is
// instant and predictable, and the same word that matched is the one marked in the result.
//
// MATCHING. The query is split into words; a row matches when EVERY word occurs somewhere in its
// title, headings, description or section label (case-insensitive substring, so "withdraw" finds
// "withdrawals"). Rows are ranked by where the words hit — title, then a heading, then the
// description, then the section — and then by title.

/** One article in the help search index. */
export interface HelpSearchRow {
  slug: string;
  title: string;
  /** The section's display label ("Registration"). */
  section: string;
  description: string;
  /** The article's h2 and h3 texts, in order. */
  headings: string[];
}

export const HELP_SEARCH_LIMIT = 8;

const words = (query: string): string[] =>
  query.toLowerCase().split(/\s+/).filter((w) => w !== "");

const WEIGHT = { title: 8, heading: 4, description: 2, section: 1 } as const;

function score(row: HelpSearchRow, terms: string[]): number {
  const title = row.title.toLowerCase();
  const headings = row.headings.map((h) => h.toLowerCase());
  const description = row.description.toLowerCase();
  const section = row.section.toLowerCase();
  let total = 0;
  for (const w of terms) {
    let best = 0;
    if (title.includes(w)) best = Math.max(best, WEIGHT.title);
    if (headings.some((h) => h.includes(w))) best = Math.max(best, WEIGHT.heading);
    if (description.includes(w)) best = Math.max(best, WEIGHT.description);
    if (section.includes(w)) best = Math.max(best, WEIGHT.section);
    if (best === 0) return 0; // every word must match
    total += best;
  }
  return total;
}

/** The rows that match `query`, best first, at most `limit`. A blank query matches nothing. */
export function searchHelp(rows: readonly HelpSearchRow[], query: string, limit = HELP_SEARCH_LIMIT): HelpSearchRow[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  return rows
    .map((row) => ({ row, s: score(row, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.row.title.localeCompare(b.row.title))
    .slice(0, limit)
    .map((x) => x.row);
}

/** `text` cut into pieces, `mark: true` on every piece that is one of the query's words (case-insensitive). */
export function markParts(text: string, query: string): { text: string; mark: boolean }[] {
  const terms = words(query);
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const w of terms) {
    for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + w.length)) {
      for (let i = at; i < at + w.length; i += 1) marked[i] = true;
    }
  }
  const parts: { text: string; mark: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.mark === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, mark: marked[i]! });
  }
  return parts.length > 0 ? parts : [{ text, mark: false }];
}
