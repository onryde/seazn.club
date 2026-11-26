// The help template (Help audit Task 6, owner 2026-11-18; the two side menus removed 2026-11-26, when an article took
// the blog post's one-column frame): heading anchors, the search index and its matching, Related, the section order
// behind previous/next, the article page and the help home. The frame over every article, and how a reader gets from one
// page to the next, are help-reading.test.tsx.
//
// vitest here is `environment: "node"`: these tests read MARKUP and DATA. They cannot see layout or the search keyboard
// flow — e2e/help.spec.ts and e2e/mobile/help.spec.ts own those.
//
// Expected values come from the Markdown fixtures written here, the files on disk (counted with
// readdirSync) or values typed by hand — never from the function under test.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixData } from "@/lib/pricing-matrix";
import { markParts, searchHelp, type HelpSearchRow } from "@/lib/help-search";
import {
  HELP_ROOT, allHelpArticles, helpHeadings, helpNav, parseHelpFrontmatter, parseHelpRelated, type HelpArticle,
} from "@/server/help-content";
import { helpRelatedProblems, resolveHelpRelated } from "@/server/help-related";
import { helpSearchIndex } from "@/server/help-search-index";

const loadSpy = vi.hoisted(() => vi.fn());
const fixtures = vi.hoisted(() => ({ list: [] as HelpArticle[] }));
vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: loadSpy }));
// The article page's serif (components/reading/reading-serif.ts) is next/font, which only exists inside a Next build.
vi.mock("next/font/google", () => ({ Source_Serif_4: () => ({ variable: "--reading-serif", className: "" }) }));
vi.mock("@/server/help-content", async (orig) => {
  const real = await orig<typeof import("@/server/help-content")>();
  return {
    ...real,
    helpArticle: (slug: string) => fixtures.list.find((a) => a.slug === slug) ?? real.helpArticle(slug),
  };
});

const article = (slug: string, markdown: string, extra: Partial<HelpArticle> = {}): HelpArticle => ({
  slug, section: slug.split("/")[0]!, title: `Title of ${slug}`, description: "A description long enough.", order: 1, markdown, related: [], ...extra,
});

const cell = (int: number | null) => ({ int_value: int, bool_value: null });
const MATRIX: MatrixData = { "registration.fee_percent": { community: cell(9), pro: cell(4) } };

// A fixture with h2 and h3 mixed, with an apostrophe and an ampersand for the slugger.
const MIXED_MD = [
  "Intro paragraph.", "## Alpha", "text", "### Beta detail", "more", "## Gamma’s turn", "text",
  "### Another detail", "## Delta & co", "end",
].join("\n\n");
// Typed from MIXED_MD by hand: the h2 texts and the ids an author would link to.
const MIXED_H2 = [
  { id: "alpha", text: "Alpha" },
  { id: "gammas-turn", text: "Gamma’s turn" },
  { id: "delta-co", text: "Delta & co" },
];

const mdFilesIn = (section: string) => readdirSync(join(HELP_ROOT, section)).filter((f) => f.endsWith(".md")).length;
const sectionDirs = () => readdirSync(HELP_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe("heading anchors", () => {
  it("each heading has the id an author links to (`/help/a/b#section`), apostrophes and ampersands included", async () => {
    const h2 = (await helpHeadings(MIXED_MD)).filter((h) => h.depth === 2).map((h) => ({ id: h.id, text: h.text }));
    expect(h2).toEqual(MIXED_H2);
  });
});

describe("the search index", () => {
  it("has one row per article, every row carries title, section and headings, and no raw token", async () => {
    const all = allHelpArticles();
    const rows = await helpSearchIndex();
    expect(rows.length, "anti-vacuity: rows exist").toBeGreaterThan(50);
    expect(rows.length).toBe(all.size);
    expect(new Set(rows.map((r) => r.slug))).toEqual(new Set(all.keys()));
    for (const r of rows) {
      expect(r.title, r.slug).toBe(all.get(r.slug)!.title);
      expect(r.section.length, r.slug).toBeGreaterThan(2);
    }
    expect(JSON.stringify(rows)).not.toContain("{{");
  });

  it("a row's headings are the article's h2 and h3 texts in order (fixture)", async () => {
    const [row] = await helpSearchIndex([article("registration/fixture-mixed", MIXED_MD)]);
    expect(row!.headings).toEqual(["Alpha", "Beta detail", "Gamma’s turn", "Another detail", "Delta & co"]);
    expect(row!.section).toBe("Registration");
  });

  it("a token in the title or description: stripped without the plan table, resolved with it, never raw", async () => {
    const tokenised = article("billing/fixture-token", "## A\n\nbody\n", {
      title: "Fees on Pro are {{plan:registration.fee_percent:pro}}%",
      description: "Community pays {{plan:registration.fee_percent:community}}% per entry.",
    });
    const [stripped] = await helpSearchIndex([tokenised]);
    expect(JSON.stringify(stripped)).not.toContain("{{");
    expect(stripped!.description).toBe("Community pays % per entry.");
    const [resolved] = await helpSearchIndex([tokenised], MATRIX);
    expect(resolved!.title).toBe("Fees on Pro are 4%");
    expect(resolved!.description).toBe("Community pays 9% per entry.");
  });

  it("an empty tree gives an empty index", async () => {
    expect(await helpSearchIndex([])).toEqual([]);
  });

  it("the /api/help-index route serves exactly the index", async () => {
    const { GET } = await import("@/app/api/help-index/route");
    const body = (await (await GET()).json()) as HelpSearchRow[];
    expect(body).toEqual(await helpSearchIndex());
  });
});

describe("search matching (client-side, over the index)", () => {
  const ROWS: HelpSearchRow[] = [
    { slug: "registration/refunds", title: "Refunds", section: "Registration", description: "Withdraw an entry, refund in full", headings: [] },
    { slug: "entrants/withdrawals", title: "Withdrawals", section: "Entrants & clubs", description: "What happens to their matches", headings: ["After the draw"] },
    { slug: "scoring/basics", title: "Scoring basics", section: "Scoring", description: "Start a match", headings: ["If a match is abandoned"] },
  ];

  it("every word must match; a title hit ranks above a description-only hit; an empty query finds nothing", () => {
    expect(searchHelp(ROWS, "withdraw").map((r) => r.slug)).toEqual(["entrants/withdrawals", "registration/refunds"]);
    expect(searchHelp(ROWS, "abandoned").map((r) => r.slug)).toEqual(["scoring/basics"]);
    expect(searchHelp(ROWS, "withdraw draw").map((r) => r.slug)).toEqual(["entrants/withdrawals", "registration/refunds"]);
    expect(searchHelp(ROWS, "withdraw abandoned")).toEqual([]);
    expect(searchHelp(ROWS, "   ")).toEqual([]);
    expect(searchHelp([], "withdraw")).toEqual([]);
  });

  it("finds the waitlist page in the real index", async () => {
    const hits = searchHelp(await helpSearchIndex(), "waitlist");
    expect(hits[0]?.slug).toBe("registration/waitlist");
  });

  it("marks every matched piece of text, case-insensitively", () => {
    expect(markParts("Refunds and withdrawals", "withdraw")).toEqual([
      { text: "Refunds and ", mark: false }, { text: "withdraw", mark: true }, { text: "als", mark: false },
    ]);
    expect(markParts("Draw, then withdraw", "draw")).toEqual([
      { text: "Draw", mark: true }, { text: ", then with", mark: false }, { text: "draw", mark: true },
    ]);
    expect(markParts("Nothing here", "")).toEqual([{ text: "Nothing here", mark: false }]);
  });
});

describe("Related", () => {
  const articles = new Map(
    [
      article("registration/a", "a"),
      article("registration/b", "b"),
      article("registration/c", "c", { related: ["registration/a", "registration/old-b"] }),
    ].map((a) => [a.slug, a] as const),
  );
  const redirects = { "registration/old-b": "registration/b" };

  it("front-matter `related:` is a comma-separated list of slugs", () => {
    expect(parseHelpRelated("registration/waitlist, registration/youth")).toEqual(["registration/waitlist", "registration/youth"]);
    expect(parseHelpRelated("")).toEqual([]);
    expect(parseHelpRelated("[a/b,c/d]")).toEqual(["a/b", "c/d"]);
  });

  it("front-matter: `related:` on one line is read; written as a YAML list it is REFUSED, naming the file", () => {
    const where = "content/help/registration/fixture.md";
    const oneLine = "---\ntitle: T\nrelated: registration/waitlist, registration/youth\n---\nBody.\n";
    const { meta, body } = parseHelpFrontmatter(oneLine, where);
    expect(parseHelpRelated(meta.related ?? "")).toEqual(["registration/waitlist", "registration/youth"]);
    expect(meta.title).toBe("T");
    expect(body).toBe("Body.\n");

    const asList = "---\ntitle: T\nrelated:\n  - registration/waitlist\n  - registration/youth\n---\nBody.\n";
    expect(() => parseHelpFrontmatter(asList, where)).toThrow(where);
    expect(() => parseHelpFrontmatter(asList, where)).toThrow(/YAML list item/);
    // an unindented list item is refused the same way
    expect(() => parseHelpFrontmatter("---\nrelated:\n- registration/waitlist\n---\n", where)).toThrow(where);
    // a hyphen inside a value is not a list item
    expect(parseHelpFrontmatter("---\ntitle: Add-ons - buying more\n---\n", where).meta.title).toBe("Add-ons - buying more");
  });

  it("resolves articles and redirect sources (to the redirect's target)", () => {
    expect(resolveHelpRelated(articles.get("registration/c")!, articles, redirects).map((a) => a.slug)).toEqual([
      "registration/a", "registration/b",
    ]);
    expect(resolveHelpRelated(articles.get("registration/a")!, articles, redirects), "none written: none shown").toEqual([]);
  });

  it("a related slug that is neither an article nor a redirect source FAILS, naming it; so does a self-link", () => {
    const bad = new Map(articles);
    bad.set("registration/d", article("registration/d", "d", { related: ["registration/nope", "registration/d"] }));
    const problems = helpRelatedProblems(bad, redirects);
    expect(problems.join("\n")).toContain("registration/nope");
    expect(problems.join("\n")).toContain("registration/d");
    expect(problems).toHaveLength(2);
    expect(() => resolveHelpRelated(bad.get("registration/d")!, bad, redirects)).toThrow(/registration\/nope/);
    expect(helpRelatedProblems(articles, redirects), "the good map is sound").toEqual([]);
  });

  it("every real article's related list is sound", () => {
    const all = allHelpArticles();
    expect(all.size, "anti-vacuity: articles scanned").toBeGreaterThan(50);
    expect(helpRelatedProblems(all)).toEqual([]);
  });
});

// The order the help home lists and previous/next walk.
describe("the sections", () => {
  it("hold every article exactly once, under its own folder's section", () => {
    const sections = helpNav();
    const slugs = sections.flatMap((s) => s.articles.map((a) => a.slug));
    expect(new Set(slugs).size, "no page twice").toBe(slugs.length);
    expect(slugs.length, "anti-vacuity").toBeGreaterThan(50);
    expect(new Set(slugs)).toEqual(new Set(allHelpArticles().keys()));
    // every section folder on disk has a heading, and its page count is the folder's
    const dirs = sectionDirs();
    expect(dirs.length, "anti-vacuity").toBeGreaterThan(5);
    for (const dir of dirs) {
      const s = sections.find((x) => x.section === dir);
      expect(s, `content/help/${dir} has a section`).toBeDefined();
      expect(s!.articles.length, dir).toBe(mdFilesIn(dir));
    }
  });
});

describe("the article page", () => {
  beforeEach(() => {
    loadSpy.mockReset();
    fixtures.list = [
      article("registration/fixture-toc", MIXED_MD, { title: "Fixture with sections" }),
      article("registration/fixture-related", "Body.\n", { title: "Fixture with related", related: ["registration/waitlist"] }),
    ];
  });
  const render = async (slug: string) => {
    const page = await import("@/app/help/[...slug]/page");
    return renderToStaticMarkup((await page.default({ params: Promise.resolve({ slug: slug.split("/") }) })) as ReactElement);
  };

  it("breadcrumb (Help / section), h1, lede, and a body whose headings carry their anchor ids", async () => {
    const html = await render("registration/fixture-toc");
    expect(html).toMatch(/<nav[^>]*aria-label="Breadcrumb"/);
    expect(html).toContain('href="/help"');
    expect(html).toMatch(/<h1[^>]*>Fixture with sections<\/h1>/);
    expect(html).toContain("A description long enough.");
    for (const e of MIXED_H2) expect(html).toContain(`<h2 id="${e.id}">`);
    expect(html, "no complementary landmark inside the page").not.toContain("<aside");
    expect(html.match(/<main\b/g)?.length, "one main").toBe(1);
    expect(html).not.toContain("On this page");
    expect(html).not.toContain("Help sections");
  });

  it("no related written: no Related block; related written: one card per slug, to the article", async () => {
    expect(await render("registration/fixture-toc")).not.toContain(">Related<");
    const html = await render("registration/fixture-related");
    expect(html).toContain(">Related<");
    expect(html).toContain('href="/help/registration/waitlist"');
  });

  it("previous and next stay within the section, in its order", async () => {
    const regs = helpNav().find((s) => s.section === "registration")!.articles.map((a) => `/help/${a.slug}`);
    expect(regs.length, "premise").toBeGreaterThan(2);
    const middle = regs[1]!.replace("/help/", "");
    const html = await render(middle);
    const pager = /<nav[^>]*aria-label="Previous and next"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    expect(pager).toContain(`href="${regs[0]!}"`);
    expect(pager).toContain(`href="${regs[2]!}"`);
  });
});

describe("the help home", () => {
  it("one search box, then a card per section with its page count from the folder", async () => {
    const { default: HelpHome } = await import("@/app/help/page");
    const html = renderToStaticMarkup(HelpHome() as ReactElement);
    expect(html).toMatch(/<h1[^>]*>How can we help\?<\/h1>/);
    expect(html.match(/type="search"/g)?.length, "one search box").toBe(1);
    let checked = 0;
    for (const dir of sectionDirs()) {
      const n = mdFilesIn(dir);
      // the card is its own <section id=…>; the count is read inside that card only
      const card = new RegExp(`<section[^>]*id="${dir}"[^>]*>((?:(?!</section>)[\\s\\S])*)</section>`).exec(html)?.[1];
      expect(card, `${dir}: a card`).toBeDefined();
      expect(card, `${dir}: ${n} pages`).toContain(`>${n} page${n === 1 ? "" : "s"}<`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: cards checked").toBeGreaterThan(5);
    expect(html).toContain('href="/help/formats"');
  });
});
