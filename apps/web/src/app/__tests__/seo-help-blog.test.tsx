// The <head> of EVERY help page and every blog page (SEO audit of staging, 2026-11-25: help pages had no canonical and
// no JSON-LD, twenty blog <title>s ran past 65 characters, the blog index had no share picture, and eight help
// descriptions were too long or too short). Each page's REAL route module is asked for its metadata and rendered for its
// structured data. The pages are found from the disk (the help tree, the format families, the posts, the help route
// files), every sweep reports how many it judged, and zero is a failure.
//
// The article body is stubbed (renderHelpArticle): its HTML is not part of a page's head, and a token article needs the
// plan table. Everything the head is built from stays real.
//
// Single-sport reason: no sport is involved; this is page metadata.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { Metadata } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: vi.fn(async () => ({})) }));
vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }),
  Source_Serif_4: () => ({ variable: "--reading-serif", className: "" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/help",
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  permanentRedirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/server/help-content", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/help-content")>();
  return { ...real, renderHelpArticle: async () => ({ html: "<p>body</p>", headings: [] }) };
});

import * as helpLayout from "../help/layout";
import HelpHome, * as homeRoute from "../help/page";
import HelpArticlePage, * as articleRoute from "../help/[...slug]/page";
import Gallery, * as galleryRoute from "../help/formats/page";
import Family, * as familyRoute from "../help/formats/[family]/page";
import * as blogLayout from "../blog/layout";
import * as blogIndexRoute from "../blog/page";
import * as postRoute from "../blog/[slug]/page";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { OG_ALT } from "@/lib/seo-meta";
import { allBlogPosts } from "@/server/blog-content";
import { HELP_ROOT, allHelpArticles, helpSectionLabel } from "@/server/help-content";

/** The audit's bounds, typed here: they are the rule, not the product's constants. */
const TITLE_MAX = 65;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 165;

const HELP_APP_DIR = join(import.meta.dirname, "..", "help");
const routeFiles = (dir = HELP_APP_DIR, rel = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === "__tests__" ? [] : routeFiles(join(dir, e.name), join(rel, e.name));
    return e.name === "page.tsx" ? [join(rel, e.name)] : [];
  });

/** The help articles, counted from the Markdown files on disk, not from the loader under test. */
const articlesOnDisk = () =>
  readdirSync(HELP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(HELP_ROOT, d.name)).filter((f) => f.endsWith(".md")).map((f) => `${d.name}/${f.slice(0, -3)}`))
    .sort();

/** The document title a page's metadata resolves to under its layout's template (Next: a string takes the template, `absolute` ignores it). */
function documentTitle(title: Metadata["title"], template: string): string {
  if (typeof title === "string") return template.replace("%s", title);
  if (title && typeof title === "object" && "absolute" in title && title.absolute) return title.absolute;
  throw new Error(`a title this sweep cannot resolve: ${JSON.stringify(title)}`);
}
const templateOf = (m: Metadata) => (m.title as { template: string }).template;

const ldBlocks = (markup: string) =>
  [...markup.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);

type Crumb = { "@type": string; position: number; name: string; item: string };

interface HelpPage {
  path: string;
  /** "Article" for a page that is one text; "CollectionPage" for a page that lists others. */
  type: "Article" | "CollectionPage";
  /** The breadcrumb, root first, ending on the page itself; null for the help home, which has no trail. */
  crumbs: [string, string][] | null;
  headline: string;
  metadata: () => Promise<Metadata> | Metadata;
  render: () => Promise<string> | string;
}

function helpPages(): HelpPage[] {
  const articles = articlesOnDisk().map((slug): HelpPage => {
    const a = allHelpArticles().get(slug)!;
    const params = { params: Promise.resolve({ slug: slug.split("/") }) };
    return {
      path: `/help/${slug}`,
      type: "Article",
      crumbs: [["Help", "/help"], [helpSectionLabel(a.section), `/help#${a.section}`], [a.title, `/help/${slug}`]],
      headline: a.title,
      metadata: () => articleRoute.generateMetadata(params),
      render: async () => renderToStaticMarkup(await HelpArticlePage(params)),
    };
  });
  const families = FORMAT_FAMILIES.map((f): HelpPage => {
    const params = { params: Promise.resolve({ family: f.slug }) };
    return {
      path: `/help/formats/${f.slug}`,
      type: "Article",
      crumbs: [["Help", "/help"], ["Format gallery", "/help/formats"], [f.title, `/help/formats/${f.slug}`]],
      headline: f.title,
      metadata: () => familyRoute.generateMetadata(params),
      render: async () => renderToStaticMarkup(await Family(params)),
    };
  });
  return [
    {
      path: "/help",
      type: "CollectionPage",
      crumbs: null,
      headline: "Help centre",
      metadata: () => homeRoute.metadata,
      render: () => renderToStaticMarkup(<HelpHome />),
    },
    {
      path: "/help/formats",
      type: "CollectionPage",
      crumbs: [["Help", "/help"], ["Formats", "/help#formats"], ["Format gallery", "/help/formats"]],
      headline: "Format gallery",
      metadata: () => galleryRoute.metadata,
      render: async () => renderToStaticMarkup(await Gallery()),
    },
    ...articles,
    ...families,
  ];
}

describe("help pages: the head of every one", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("premise: the sweep holds every help route and every help article on disk", () => {
    expect(routeFiles().sort()).toEqual(["[...slug]/page.tsx", "formats/[family]/page.tsx", "formats/page.tsx", "page.tsx"]);
    const onDisk = articlesOnDisk();
    expect(onDisk.length, "anti-vacuity: help articles on disk").toBeGreaterThan(100);
    expect([...allHelpArticles().keys()].sort()).toEqual(onDisk);
    expect(FORMAT_FAMILIES.length, "anti-vacuity: format families").toBeGreaterThan(5);
    expect(helpPages()).toHaveLength(onDisk.length + FORMAT_FAMILIES.length + 2);
  });

  it("each declares its own canonical, relative like the blog's, so metadataBase gives it each environment's origin", async () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const page of helpPages()) {
      const m = await page.metadata();
      if (m.alternates?.canonical !== page.path) wrong.push(`${page.path}: ${String(m.alternates?.canonical)}`);
      checked++;
    }
    console.log(`help canonicals checked: ${checked}`);
    expect(checked, "anti-vacuity: help pages checked").toBeGreaterThan(100);
    expect(wrong).toEqual([]);
  });

  it(`each description is ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX} characters and each document title at most ${TITLE_MAX}`, async () => {
    let checked = 0;
    const wrong: string[] = [];
    const template = templateOf(helpLayout.metadata);
    for (const page of helpPages()) {
      const m = await page.metadata();
      // A page with no description of its own takes the layout's, as Next merges it.
      const description = m.description ?? helpLayout.metadata.description!;
      if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) wrong.push(`${page.path}: description ${description.length}`);
      const title = documentTitle(m.title, template);
      if (title.length > TITLE_MAX) wrong.push(`${page.path}: title ${title.length} '${title}'`);
      if ((title.match(/Seazn Club/g) ?? []).length > 1) wrong.push(`${page.path}: the brand twice '${title}'`);
      checked++;
    }
    console.log(`help titles and descriptions checked: ${checked}`);
    expect(checked, "anti-vacuity: help pages checked").toBeGreaterThan(100);
    expect(wrong).toEqual([]);
  });

  it("each carries JSON-LD naming itself at the deployment's own origin, with a breadcrumb that matches its trail", async () => {
    const origin = "https://help-seo.example.test";
    vi.stubEnv("OAUTH_BASE_URL", origin);
    let checked = 0;
    let breadcrumbs = 0;
    for (const page of helpPages()) {
      const blocks = ldBlocks(await page.render());
      const main = blocks.filter((b) => b["@type"] === page.type);
      expect(main, `${page.path}: one ${page.type}`).toHaveLength(1);
      expect(main[0]!.url, page.path).toBe(`${origin}${page.path}`);
      expect((main[0]!.mainEntityOfPage as { "@id": string } | undefined)?.["@id"] ?? main[0]!.url, page.path).toBe(`${origin}${page.path}`);
      expect(String(main[0]!.headline ?? main[0]!.name), page.path).toContain(page.headline);
      expect((main[0]!.publisher as { name: string }).name, page.path).toBe("Seazn Club");
      expect(JSON.stringify(main[0]), `${page.path}: no invented dates`).not.toMatch(/date(?:Published|Modified)/);
      const trails = blocks.filter((b) => b["@type"] === "BreadcrumbList");
      expect(trails, `${page.path}: breadcrumb`).toHaveLength(page.crumbs === null ? 0 : 1);
      if (page.crumbs !== null) {
        const items = trails[0]!.itemListElement as Crumb[];
        expect(items.map((i) => [i.name, i.item]), page.path).toEqual(page.crumbs.map(([name, path]) => [name, `${origin}${path}`]));
        expect(items.map((i) => i.position)).toEqual(items.map((_, n) => n + 1));
        breadcrumbs++;
      }
      checked++;
    }
    console.log(`help JSON-LD checked: ${checked} pages, ${breadcrumbs} breadcrumbs`);
    expect(checked, "anti-vacuity: help pages checked").toBeGreaterThan(100);
    expect(breadcrumbs, "anti-vacuity: breadcrumbs checked").toBe(checked - 1);
  }, 60_000);
});

describe("blog pages: the head of every one", () => {
  const posts = allBlogPosts();
  const template = templateOf(blogLayout.metadata);

  it(`each post's document title is at most ${TITLE_MAX}: its question, or its short search title; the question is shared everywhere else`, async () => {
    let checked = 0;
    const over: string[] = [];
    let suffixed = 0;
    const short: string[] = [];
    for (const p of posts) {
      const params = { params: Promise.resolve({ slug: p.slug }) };
      const m = await postRoute.generateMetadata(params);
      const title = documentTitle(m.title, template);
      const search = p.seoTitle ?? p.title;
      const withSuffix = `${search} — Seazn Club Blog`;
      expect(title, p.slug).toBe(withSuffix.length <= TITLE_MAX ? withSuffix : search);
      if (title !== search) suffixed++;
      if (p.seoTitle !== undefined) short.push(p.slug);
      // The question is never rewritten: the share cards carry it whole, whatever the <title> is.
      expect((m.openGraph as { title: string }).title, p.slug).toBe(p.title);
      expect((m.twitter as { title: string }).title, p.slug).toBe(p.title);
      expect(m.alternates?.canonical, p.slug).toBe(`/blog/${p.slug}`);
      const description = m.description!;
      expect(description.length, `${p.slug}: description`).toBeGreaterThanOrEqual(DESCRIPTION_MIN);
      expect(description.length, `${p.slug}: description`).toBeLessThanOrEqual(DESCRIPTION_MAX);
      if (title.length > TITLE_MAX) over.push(`${p.slug} (${title.length})`);
      checked++;
    }
    console.log(`blog titles checked: ${checked}; with the suffix ${suffixed}; with a short search title ${short.length}; over ${TITLE_MAX}: ${over.length}`);
    expect(checked, "anti-vacuity: posts checked").toBe(posts.length);
    expect(checked).toBeGreaterThan(0);
    expect(suffixed, "anti-vacuity: some title keeps the suffix").toBeGreaterThan(0);
    expect(over).toEqual([]);
    // A short title is only for a question that is too long: nowhere else may the <title> drift from the H1.
    expect(short.length, "anti-vacuity: some post needs a short title").toBeGreaterThan(0);
    expect(short).toEqual(posts.filter((p) => p.title.length > TITLE_MAX).map((p) => p.slug));
  });

  it("the index has a share picture, declared on the page (its openGraph replaces the inherited one)", () => {
    const m = blogIndexRoute.metadata;
    expect((m.openGraph as { images?: unknown }).images).toEqual([
      { url: "/opengraph-image", width: 1200, height: 630, type: "image/png", alt: OG_ALT },
    ]);
    expect(documentTitle(m.title, template).length).toBeLessThanOrEqual(TITLE_MAX);
    expect(m.description!.length).toBeGreaterThanOrEqual(DESCRIPTION_MIN);
    expect(m.description!.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(m.alternates?.canonical).toBe("/blog");
  });
});
