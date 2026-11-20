// "Related" on a help article: the front-matter `related:` list (help-content.ts, parseHelpRelated), shown
// as cards under the article. Each slug must be an article, or a redirect source (help-redirects.ts) that is
// followed to its target, so a page that moves keeps its Related links. Anything else is an author's typo and
// FAILS: the template test sweeps every article with helpRelatedProblems, and the page itself refuses to render
// one (resolveHelpRelated throws), so a bad slug never ships as a dead card or as a card that quietly vanished.
import type { HelpArticle } from "@/server/help-content";
import { HELP_REDIRECTS, helpRedirectTarget } from "@/server/help-redirects";

type Related = Pick<HelpArticle, "slug" | "related">;

function problemsOf(
  article: Related,
  articles: ReadonlyMap<string, Related>,
  redirects: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const slug of article.related) {
    const target = articles.has(slug) ? slug : helpRedirectTarget(slug, redirects);
    if (target === null || !articles.has(target)) {
      problems.push(`${article.slug}: related '${slug}' is not a help article or a redirect source`);
      continue;
    }
    if (target === article.slug) problems.push(`${article.slug}: related '${slug}' is the article itself`);
    else if (seen.has(target)) problems.push(`${article.slug}: related '${slug}' is listed twice`);
    seen.add(target);
  }
  return problems;
}

/** Every bad `related` slug across `articles`, one readable line each; empty means sound. */
export function helpRelatedProblems(
  articles: ReadonlyMap<string, Related>,
  redirects: Readonly<Record<string, string>> = HELP_REDIRECTS,
): string[] {
  return [...articles.values()].flatMap((a) => problemsOf(a, articles, redirects));
}

/** The articles `article` lists as related, in its order, redirects followed. Throws on any bad slug. */
export function resolveHelpRelated<A extends HelpArticle>(
  article: Related,
  articles: ReadonlyMap<string, A>,
  redirects: Readonly<Record<string, string>> = HELP_REDIRECTS,
): A[] {
  const problems = problemsOf(article, articles, redirects);
  if (problems.length > 0) throw new Error(`help related: ${problems.join("; ")}`);
  return article.related.map((slug) => articles.get(articles.has(slug) ? slug : helpRedirectTarget(slug, redirects)!)!);
}
