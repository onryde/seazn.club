// Help's <head> beyond the title: the structured data of each help page, built with the blog's helpers (blog-seo.ts,
// json-ld.tsx) so both trees describe the publisher the same way. Every URL takes the deployment's own origin
// (site-origin.ts). A help page has no author date, so none is stated. Client-safe (no fs, no engine).
import { breadcrumbLd } from "@/components/seo/json-ld";
import { publisher } from "@/lib/blog-seo";
import { siteOrigin } from "@/lib/site-origin";

/** The help tree's own description (the layout's, and so the help home's). */
export const HELP_DESCRIPTION =
  "How to run tournaments and leagues on seazn.club — setup, registration, scheduling, scoring, sharing and billing, in plain words.";

/** The format gallery's name and description (/help/formats): its page and /llms.txt both read them. */
export const FORMAT_GALLERY_TITLE = "Format gallery";
export const FORMAT_GALLERY_DESCRIPTION =
  "League, knockout, groups, swiss, double elimination, americano, ladder — every tournament format explained with a diagram and a live example.";

interface HelpLdPage {
  path: string;
  name: string;
  description: string;
}

/** A page that is one text: a help article or a format guide. */
export function helpArticleLd(page: HelpLdPage) {
  const url = `${siteOrigin()}${page.path}`;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: page.name,
    description: page.description,
    author: publisher(),
    publisher: publisher(),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    image: `${siteOrigin()}/opengraph-image`,
  };
}

/** A page that lists other pages: the help home and the format gallery. */
export function helpCollectionLd(page: HelpLdPage) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: page.name,
    description: page.description,
    publisher: publisher(),
    url: `${siteOrigin()}${page.path}`,
  };
}

/** `trail` is the one <HelpBreadcrumb> draws (it adds "Help" itself, as this does); the page ends its own list. */
export function helpBreadcrumbLd(trail: readonly { href: string; label: string }[], page: { path: string; name: string }) {
  const above = trail.filter((t) => t.href !== page.path).map((t) => ({ name: t.label, path: t.href }));
  return breadcrumbLd([{ name: "Help", path: "/help" }, ...above, { name: page.name, path: page.path }]);
}

// A format guide's description is its gallery tagline (translated, shared with the console). Where the English tagline is
// too short to say what the page holds, the search description says more; the tagline itself is unchanged.
const FAMILY_DESCRIPTIONS: Record<string, string> = {
  league: "Everyone plays everyone; the table decides. How a round robin league works, who it suits and what it costs in matches.",
  knockout: "Lose once and you're out. How a single elimination knockout works: seeds, byes, who it suits and the trade-off.",
  swiss: "Equals play equals for a fixed number of rounds. How Swiss pairing works, who it suits and what the trade-off is.",
};

export function familyDescription(family: { slug: string; tagline: string }): string {
  return FAMILY_DESCRIPTIONS[family.slug] ?? family.tagline;
}
