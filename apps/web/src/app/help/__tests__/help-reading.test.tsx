// The help ARTICLE page reads like a blog post: the post's serif body and large title (owner pick "H1", 2026-11-26)
// and, since the same day's follow-up, the post's frame too: no side menus, one centred column. This holds what a PR can
// check without a DOM: which pages load the serif and which prose asks for it, which pages draw the column and no side
// menu, how a reader gets from one page to the next, all over EVERY article on disk, and that blog and help share ONE
// definition instead of two copies. What it looks like (faces, sizes, colours, widths, the parts that stay sans,
// overflow) is measured in a browser: e2e/help.spec.ts and e2e/mobile/help.spec.ts.
//
// Single-sport reason: no sport is involved; this is the help page's type.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: vi.fn(async () => ({})) }));
// next/font only exists inside a Next build. The mock's class name is what shows where a page puts the face.
vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--mk-font-display", className: "" }),
  Source_Serif_4: (o: { variable: string }) => ({ variable: `serif-face-on(${o.variable})`, className: "" }),
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
// The body is stubbed: a plan-token article needs the plan table, and only the page's frame is read here. TWO level-2
// headings, so a page that still drew an "On this page" list would have the entries to draw one with.
vi.mock("@/server/help-content", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/help-content")>();
  const body = { html: '<h2 id="one">One</h2><p>body</p><h2 id="two">Two</h2>', headings: [{ depth: 2, text: "One", id: "one" }, { depth: 2, text: "Two", id: "two" }] };
  // A blog post renders each of its segments through the same function (it asks for stacked tables): no headings there,
  // or two segments would carry the same stubbed ids.
  const plain = { html: "<p>body</p>", headings: [] };
  return { ...real, renderHelpArticle: async (_a: unknown, _m: unknown, options?: { stackTables?: boolean }) => (options?.stackTables ? plain : body) };
});

import HelpArticlePage from "../[...slug]/page";
import HelpHome from "../page";
import Gallery from "../formats/page";
import Family from "../formats/[family]/page";
import BlogPostPage from "@/app/blog/[slug]/page";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { HELP_ROOT } from "@/server/help-content";

const FACE = "serif-face-on(--reading-serif)";
/** The large title, typed from the approved style: 31px on a phone, 42px from 600, #242424. Margins are each page's. */
const TITLE_TYPE = ["text-balance", "text-[31px]", "font-bold", "leading-[1.19]", "tracking-[-0.018em]", "text-[#242424]", "min-[600px]:text-[42px]"];

/** Every article, from the disk. */
const slugs = () =>
  readdirSync(HELP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(HELP_ROOT, d.name)).filter((f) => f.endsWith(".md")).map((f) => `${d.name}/${f.replace(/\.md$/, "")}`));

const articleHtml = async (slug: string) => renderToStaticMarkup(await HelpArticlePage({ params: Promise.resolve({ slug: slug.split("/") }) }));
const h1Classes = (markup: string) => /<h1 class="([^"]*)"/.exec(markup)?.[1]?.split(" ") ?? [];
const typeOnly = (classes: string[]) => classes.filter((c) => !/^m[tblrxy]?-/.test(c)).sort();

/**
 * The help and blog loaders keep what they read only when NODE_ENV is "production"; anywhere else each render reads every
 * article and post again, several times over. A sweep over every page runs as production does. Nothing stale outlives it:
 * out of production the loaders never answer from what they kept, and each test file has its own modules.
 */
function loadContentOnce(): void {
  beforeEach(() => void vi.stubEnv("NODE_ENV", "production"));
  afterEach(() => void vi.unstubAllEnvs());
}

describe("every help article page", () => {
  loadContentOnce();

  it("loads the serif on its article, draws its body as reading prose, and gives the title the large treatment", async () => {
    const all = slugs();
    expect(all.length, "anti-vacuity: articles on disk").toBeGreaterThan(50);
    const wrong: string[] = [];
    let checked = 0;
    for (const slug of all) {
      const markup = await articleHtml(slug);
      const article = /<article class="([^"]*)"/.exec(markup)?.[1]?.split(" ") ?? [];
      if (!article.includes(FACE)) wrong.push(`${slug}: the article does not carry the serif`);
      const prose = [...markup.matchAll(/class="competition-prose ([^"]*)"/g)].map((m) => m[1]!.split(" "));
      if (prose.length !== 1 || !prose[0]!.includes("help-prose") || !prose[0]!.includes("reading-prose")) wrong.push(`${slug}: prose classes ${JSON.stringify(prose)}`);
      if (prose.some((c) => c.includes("blog-prose"))) wrong.push(`${slug}: wears the blog's hook`);
      if (typeOnly(h1Classes(markup)).join(" ") !== [...TITLE_TYPE].sort().join(" ")) wrong.push(`${slug}: title ${h1Classes(markup).join(" ")}`);
      checked++;
    }
    console.log(`help article pages read: ${checked}`);
    expect(wrong, `${checked} articles`).toEqual([]);
    expect(checked).toBe(all.length);
  }, 120_000);

});

/** The post's column, typed from the approved layout: centred, 680px (42.5rem). */
const COLUMN = "mx-auto max-w-[42.5rem]";

/** Every trace of the two side menus the article frame used to draw (their landmarks, test ids, words and grids). */
const SIDE_MENUS = ['aria-label="Help sections"', 'aria-label="On this page"', "On this page", 'data-testid="help-sections"', 'data-testid="help-toc"', "grid-cols-[13rem", "min-[1100px]", "max-w-[34rem]", "aria-current"];

/** What the shell's frame must be on any page drawn in it: the column, with the search and then the page inside it. */
function frameFaults(markup: string): string[] {
  const faults = SIDE_MENUS.filter((n) => markup.includes(n)).map((n) => `still draws ${n}`);
  if (markup.split(`<div class="${COLUMN}"`).length !== 2) faults.push("not exactly one reading column");
  const column = markup.slice(markup.indexOf(`<div class="${COLUMN}"`));
  const at = (needle: string) => column.indexOf(needle);
  if (markup.split('type="search"').length !== 2) faults.push("not exactly one search box");
  if (!(at('type="search"') > -1 && at('type="search"') < at("<main") && at("<main") < at('aria-label="Breadcrumb"'))) faults.push("not search, then the page with its breadcrumb, inside the column");
  return faults;
}

describe("the article frame: one column, no side menus", () => {
  loadContentOnce();

  it("EVERY article: search, breadcrumb and body in the post's column, with no section list and no On this page", async () => {
    const all = slugs();
    expect(all.length, "anti-vacuity: articles on disk").toBeGreaterThan(50);
    const wrong: string[] = [];
    let checked = 0;
    for (const slug of all) {
      const markup = await articleHtml(slug);
      wrong.push(...frameFaults(markup).map((f) => `${slug}: ${f}`));
      if (!markup.includes('<h2 id="one">')) wrong.push(`${slug}: premise, the stubbed headings reached the page`);
      checked++;
    }
    console.log(`help article frames read: ${checked}`);
    expect(wrong, `${checked} articles`).toEqual([]);
    expect(checked).toBe(all.length);
  }, 120_000);

  it("the format gallery and every format page, which share the frame, are drawn in the same column", async () => {
    const pages: [string, string][] = [["/help/formats", renderToStaticMarkup(await Gallery())]];
    for (const f of FORMAT_FAMILIES) pages.push([`/help/formats/${f.slug}`, renderToStaticMarkup(await Family({ params: Promise.resolve({ family: f.slug }) }))]);
    const wrong: string[] = [];
    let checked = 0;
    for (const [path, markup] of pages) {
      wrong.push(...frameFaults(markup).map((f) => `${path}: ${f}`));
      checked++;
    }
    expect(wrong).toEqual([]);
    expect(checked, "anti-vacuity").toBe(FORMAT_FAMILIES.length + 1);
    expect(checked).toBeGreaterThan(4);
  });

  it("a post's column is the same one", async () => {
    const post = renderToStaticMarkup(await BlogPostPage({ params: Promise.resolve({ slug: "how-standings-points-work" }) }));
    const classes = /<article class="([^"]*)" data-testid="blog-post"/.exec(post)?.[1];
    expect(classes).toBe(COLUMN);
  });
});

// With no section list beside the page, these are the ways on from an article: the breadcrumb (to the help home, which
// lists every page, and to the section's card on it), previous and next within the section, Related and search.
describe("getting from one page to another without the side menus", () => {
  loadContentOnce();

  /** Every link on the help home. */
  const homeHtml = () => renderToStaticMarkup(HelpHome());

  it("the help home links every article on disk, and the format gallery links every format page", async () => {
    const home = homeHtml();
    const all = slugs();
    expect(all.length, "anti-vacuity").toBeGreaterThan(50);
    expect(all.filter((s) => !home.includes(`href="/help/${s}"`)), `${all.length} articles`).toEqual([]);
    expect(home).toContain('href="/help/formats"');
    const gallery = renderToStaticMarkup(await Gallery());
    expect(FORMAT_FAMILIES.length).toBeGreaterThan(3);
    expect(FORMAT_FAMILIES.filter((f) => !gallery.includes(`href="/help/formats/${f.slug}"`))).toEqual([]);
  });

  it("every article's breadcrumb reaches the help home and a card on it that exists", async () => {
    const home = homeHtml();
    const all = slugs();
    let checked = 0;
    const wrong: string[] = [];
    for (const slug of all) {
      const crumbs = /<nav aria-label="Breadcrumb">([\s\S]*?)<\/nav>/.exec(await articleHtml(slug))?.[1] ?? "";
      const hrefs = [...crumbs.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      const section = slug.split("/")[0]!;
      if (hrefs.join(" ") !== `/help /help#${section}`) wrong.push(`${slug}: breadcrumb links ${hrefs.join(" ")}`);
      if (!new RegExp(`<section[^>]* id="${section}"`).test(home)) wrong.push(`${slug}: the home has no card with id ${section}`);
      checked++;
    }
    expect(wrong).toEqual([]);
    expect(checked, "anti-vacuity").toBe(all.length);
  }, 120_000);

  it("previous and next walk each section from end to end: every page of a section is reached from its first", async () => {
    const bySection = new Map<string, string[]>();
    for (const slug of slugs()) bySection.set(slug.split("/")[0]!, [...(bySection.get(slug.split("/")[0]!) ?? []), slug]);
    expect(bySection.size, "anti-vacuity: sections").toBeGreaterThan(5);
    let walked = 0;
    for (const [section, pages] of bySection) {
      const pagers = new Map<string, { prev: string | null; next: string | null }>();
      for (const slug of pages) {
        const pager = /<nav aria-label="Previous and next"[^>]*>([\s\S]*?)<\/nav>/.exec(await articleHtml(slug))?.[1] ?? "";
        const links = [...pager.matchAll(/<a [^>]*href="\/help\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
        pagers.set(slug, { prev: links.find((l) => l[2]!.includes("Previous"))?.[1] ?? null, next: links.find((l) => l[2]!.includes("Next"))?.[1] ?? null });
      }
      const firsts = pages.filter((p) => pagers.get(p)!.prev === null);
      expect(firsts, `${section}: one first page`).toHaveLength(1);
      const seen: string[] = [];
      for (let at: string | null = firsts[0]!; at !== null && !seen.includes(at); at = pagers.get(at)!.next) {
        if (seen.length > 0) expect(pagers.get(at)!.prev, `${at}: previous goes back`).toBe(seen.at(-1));
        seen.push(at);
      }
      expect([...seen].sort(), section).toEqual([...pages].sort());
      walked += seen.length;
    }
    expect(walked, "anti-vacuity: every article walked").toBe(slugs().length);
  }, 120_000);
});

describe("the help pages that are not articles", () => {
  loadContentOnce();

  it("do not load the serif and have no reading prose: the home, the format gallery and every format page", async () => {
    const pages: [string, string][] = [
      ["/help", renderToStaticMarkup(HelpHome())],
      ["/help/formats", renderToStaticMarkup(await Gallery())],
    ];
    for (const f of FORMAT_FAMILIES) pages.push([`/help/formats/${f.slug}`, renderToStaticMarkup(await Family({ params: Promise.resolve({ family: f.slug }) }))]);
    expect(FORMAT_FAMILIES.length, "anti-vacuity: format pages").toBeGreaterThan(3);
    let checked = 0;
    for (const [path, markup] of pages) {
      expect(markup.length, `${path}: premise, it rendered`).toBeGreaterThan(500);
      expect(markup, path).not.toContain("serif-face-on");
      expect(markup, path).not.toContain("reading-prose");
      checked++;
    }
    expect(checked).toBe(FORMAT_FAMILIES.length + 2);
  });
});

describe("one reading style, shared by blog posts and help articles", () => {
  it("a post and an article carry the same face and the same title type", async () => {
    const post = renderToStaticMarkup(await BlogPostPage({ params: Promise.resolve({ slug: "how-standings-points-work" }) }));
    const help = await articleHtml("registration/card-payments");
    expect(post).toContain(FACE);
    expect(help).toContain(FACE);
    expect(h1Classes(post).length, "premise: the post's h1 was found").toBeGreaterThan(0);
    expect(typeOnly(h1Classes(help))).toEqual(typeOnly(h1Classes(post)));
    expect(post).toMatch(/class="competition-prose [^"]*reading-prose/);
  });

  it("the face is declared in one source file, and so are the title's type and the column", () => {
    const SRC = join(process.cwd(), "src");
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/__tests__|\.test\./.test(f));
    expect(files.length, "anti-vacuity: source files read").toBeGreaterThan(500);
    const having = (needle: string) => files.filter((f) => readFileSync(join(SRC, f), "utf8").includes(needle)).map((f) => relative(SRC, join(SRC, f)));
    expect(having("Source_Serif_4(")).toEqual(["components/reading/reading-serif.ts"]);
    expect(having("min-[600px]:text-[42px]")).toEqual(["components/reading/reading-title.ts"]);
    expect(having("max-w-[42.5rem]")).toEqual(["components/reading/reading-column.ts"]);
  });
});
