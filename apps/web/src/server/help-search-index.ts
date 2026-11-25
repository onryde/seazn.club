// The help search index: ONE source for the help search box (components/help/help-search.tsx, through
// /api/help-index) and for anything else that finds help pages. A row per article: slug, title, section
// label, description and its h2/h3 heading texts — what the owner-approved layout searches (titles,
// descriptions, headings); article bodies are not in it, which keeps the file the browser loads small.
//
// The browser loads it on the search box's first focus or keystroke, never inside a page's HTML.
//
// No raw plan token reaches it: with the plan table (`matrix`) a token in a title or description is
// resolved to its figure; without one it is stripped (help-tokens.ts). Headings cannot carry a token
// (help-tree-shape pins that). Headings come from helpHeadings, the same walk that writes the ids.
import type { MatrixData } from "@/lib/pricing-matrix";
import type { HelpSearchRow } from "@/lib/help-search";
import { allHelpArticles, helpHeadings, helpSectionLabel, type HelpArticle } from "@/server/help-content";
import { resolveHelpTokens, resolveOnlineTokens, stripHelpTokens } from "@/server/help-tokens";

let cached: Promise<HelpSearchRow[]> | null = null;

async function build(articles: Iterable<HelpArticle>, matrix?: MatrixData): Promise<HelpSearchRow[]> {
  const text = (s: string) => resolveOnlineTokens(matrix ? resolveHelpTokens(s, matrix) : stripHelpTokens(s));
  return Promise.all(
    [...articles].map(async (a) => {
      const row: HelpSearchRow = {
        slug: a.slug,
        title: text(a.title),
        section: helpSectionLabel(a.section),
        description: text(a.description),
        headings: (await helpHeadings(a.markdown)).map((h) => h.text),
      };
      // A guard, not a hope: nothing that looks like a token leaves this function.
      if (/\{\{(?:plan|online)/.test(JSON.stringify(row))) throw new Error(`help search index: a plan token survived in ${a.slug}`);
      return row;
    }),
  );
}

/**
 * The index rows, in the order the articles are given. With no arguments: every article on disk, no plan
 * table, built once per server process in production (the content is part of the build).
 */
export function helpSearchIndex(articles?: Iterable<HelpArticle>, matrix?: MatrixData): Promise<HelpSearchRow[]> {
  if (articles !== undefined || matrix !== undefined) return build(articles ?? allHelpArticles().values(), matrix);
  if (cached && process.env.NODE_ENV === "production") return cached;
  cached = build(allHelpArticles().values());
  // A failed build must not be remembered: the next request tries again.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
