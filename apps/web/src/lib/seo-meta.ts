// One builder for the marketing pages' <head> (title, canonical, hreflang, Open
// Graph), so the pieces cannot drift apart page by page.
//
// Three defects it closes:
//  - the root title template appends " — Seazn Club", and several dictionary
//    titles already carry the brand, so the tab read "… — Seazn Club — Seazn Club";
//  - a page-level `openGraph` replaces the inherited one wholesale (no og:image,
//    no og:title), and the home page's og:title was the bare brand name;
//  - the canonical is the /{lang} form, so the sitemap must list that same form.
import type { Metadata } from "next";
import { LOCALES } from "@/lib/i18n-constants";

const BRAND = "Seazn Club";

/** Mirrors `alt` in app/opengraph-image.tsx (a test pins the two equal); the explicit image below would otherwise drop it. */
export const OG_ALT = "Seazn Club — any sport, live in minutes";

/** A title that already names the brand is used as-is; anything else gets the root template's suffix. */
export function pageTitle(title: string): Metadata["title"] {
  return title.includes(BRAND) ? { absolute: title } : title;
}

/** The share-card title: the same words without the brand, which og:site_name already carries. */
export function ogTitle(title: string): string {
  const stripped = title
    .replace(new RegExp(`^${BRAND}\\s*[—|-]\\s*`), "")
    .replace(new RegExp(`\\s*[—|-]\\s*${BRAND}$`), "")
    .replace(new RegExp(`\\s*\\|\\s*${BRAND}$`), "")
    .trim();
  return stripped || title;
}

/** Path under /{lang}: "" for the home page, "/pricing", "/sports/cricket". */
export function localizedPath(lang: string, path: string): string {
  return `/${lang}${path}`;
}

export function marketingMeta(opts: {
  lang: string;
  path: string;
  title: string;
  description: string;
  /** Share-card description, when it differs from the meta description. */
  ogDescription?: string;
}): Metadata {
  const { lang, path, title, description } = opts;
  const canonical = localizedPath(lang, path);
  return {
    title: pageTitle(title),
    description,
    alternates: {
      canonical,
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, localizedPath(l, path)])),
        "x-default": localizedPath("en", path),
      },
    },
    openGraph: {
      type: "website",
      siteName: BRAND,
      title: ogTitle(title),
      description: opts.ogDescription ?? description,
      url: canonical,
      // Explicit: a page-level openGraph replaces the inherited one, which
      // would drop the root file-convention opengraph-image.
      images: [{ url: "/opengraph-image", width: 1200, height: 630, type: "image/png", alt: OG_ALT }],
    },
  };
}
