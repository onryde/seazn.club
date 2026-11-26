// The help ARTICLE page reads like a blog post (owner pick "H1", 2026-11-26): the post's serif body and large title,
// help's own frame. This holds what a PR can check without a DOM: which pages load the serif and which prose asks for
// it, over EVERY article on disk, and that blog and help share ONE definition instead of two copies. What the type looks
// like (faces, sizes, colours, the parts that stay sans, overflow) is measured in a browser: e2e/help.spec.ts "the
// reading style" and e2e/mobile/help.spec.ts.
//
// Single-sport reason: no sport is involved; this is the help page's type.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
// The body is stubbed: a plan-token article needs the plan table, and only the page's frame is read here.
vi.mock("@/server/help-content", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/help-content")>();
  return { ...real, renderHelpArticle: async () => ({ html: "<p>body</p>", headings: [] }) };
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

describe("every help article page", () => {
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
    expect(wrong, `${checked} articles`).toEqual([]);
    expect(checked).toBe(all.length);
  }, 120_000);

  it("keeps help's frame: search, the section list, the breadcrumb, the 34rem column", async () => {
    const markup = await articleHtml("registration/card-payments");
    expect(markup).toContain('aria-label="Help sections"');
    expect(markup).toContain('aria-label="Breadcrumb"');
    expect(markup).toContain('aria-label="Previous and next"');
    expect(markup.match(/max-w-\[34rem\]/g)!.length).toBe(3);
  });
});

describe("the help pages that are not articles", () => {
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

  it("the face is declared in one source file, and so is the title's type", () => {
    const SRC = join(process.cwd(), "src");
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !/__tests__|\.test\./.test(f));
    expect(files.length, "anti-vacuity: source files read").toBeGreaterThan(500);
    const having = (needle: string) => files.filter((f) => readFileSync(join(SRC, f), "utf8").includes(needle)).map((f) => relative(SRC, join(SRC, f)));
    expect(having("Source_Serif_4(")).toEqual(["components/reading/reading-serif.ts"]);
    expect(having("min-[600px]:text-[42px]")).toEqual(["components/reading/reading-title.ts"]);
  });
});
