// Moved help pages. When a content task renames, merges or splits a help article, the OLD slug goes in
// HELP_REDIRECTS as `"old-section/old-page": "new-section/new-page"` and the old address keeps working: the slug
// page (app/help/[...slug]/page.tsx) answers it with a PERMANENT redirect (308) to /help/<new slug>, carrying nothing
// else over (no query string, no fragment). Links that live inside the product (lib/help.ts, tips) may keep the old slug.
//
// Rules, all enforced by help-redirects.test.ts (helpRedirectProblems below is the one definition):
//  - the target is an article that exists;
//  - one hop at most: a target is never itself a redirect source (no chains, no loops);
//  - no slug is both an article and a source (an article that exists is served, never redirected);
//  - no self-redirect;
//  - a source is written exactly as a request arrives: `section/page`, lower case, no leading or trailing slash
//    (anything else never matches a request, so the redirect would silently do nothing).
//
// SERVED ON DEMAND, not prebuilt. A redirect source is deliberately NOT in generateStaticParams: the route does not
// set `dynamicParams = false`, so a slug that was not prerendered is rendered on demand when it is requested, and the
// page calls `permanentRedirect` then. The docs promise a 308 for that call; they say nothing about the redirect being
// cached, so nothing here relies on it being cached. The page redirects before any streaming starts (the help layout has
// no loading boundary), so the response is a real 308, not a meta-refresh. Prerendering the sources would add nothing
// the on-demand render does not, and would mean a second list to keep in step with this one.
// (Next docs: app/api-reference/functions/permanentRedirect and .../generate-static-params, "dynamicParams".)
// The test help-redirect-page.test.ts pins the choice.

/** Old slug -> new slug. Empty until a page moves. */
export const HELP_REDIRECTS: Record<string, string> = {};

const SLUG_SHAPE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;

/**
 * The new slug for an old one, or null if `slug` is not a redirect source. Own keys only: `constructor`,
 * `toString` and `__proto__` are names on every object, and none of them is a redirect.
 */
export function helpRedirectTarget(slug: string, map: Readonly<Record<string, string>> = HELP_REDIRECTS): string | null {
  return Object.hasOwn(map, slug) ? map[slug]! : null;
}

/** Every way `map` breaks the rules above, as readable lines; empty means sound. `articles` is the set of real article slugs. */
export function helpRedirectProblems(map: Readonly<Record<string, string>>, articles: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const [from, to] of Object.entries(map)) {
    if (!SLUG_SHAPE.test(from)) {
      problems.push(`redirect source '${from}' is not written as section/page (lower case, no leading or trailing slash), so no request would match it`);
    }
    if (from === to) problems.push(`redirect '${from}' redirects to itself`);
    if (articles.has(from)) problems.push(`'${from}' is an article and also a redirect source (the article is served, the redirect would never run)`);
    if (!articles.has(to)) problems.push(`redirect '${from}': target '${to}' is not an article`);
    if (from !== to && Object.hasOwn(map, to)) {
      problems.push(`redirect '${from}' -> '${to}' is a chain: '${to}' is itself redirected to '${map[to]}' (one hop at most)`);
    }
  }
  return problems;
}
