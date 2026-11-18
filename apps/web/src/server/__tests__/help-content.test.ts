// The stale-doc gate (v3/06 §3, v3/11 gap 14): the Markdown on disk, the
// client-safe slug registry in lib/help.ts, the Tips deep-links and the
// feature-area sections must all agree — a feature area or tip cannot ship
// without its /help article, and a deleted article cannot leave dead links.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import rehypeSanitize from "rehype-sanitize";
import type { Root } from "hast";
import FlexSearch from "flexsearch";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import {
  HELP_SCHEMA, HELP_SECTIONS, allHelpArticles, helpNav, helpPlainText, renderHelpMarkdown,
} from "@/server/help-content";
import { slugifyHeading } from "@/server/help-heading-ids";
import { HELP_ARTICLE_SLUGS, helpUrl } from "@/lib/help";
import { TIPS } from "@/config/tips";

describe("help content ⇄ registry ⇄ tips", () => {
  const onDisk = allHelpArticles();

  it("every registry slug has a Markdown file", () => {
    for (const slug of HELP_ARTICLE_SLUGS) {
      expect(onDisk.has(slug), `lib/help.ts lists '${slug}' but content/help has no such file`).toBe(true);
    }
  });

  it("every Markdown file is in the registry (no unreachable articles)", () => {
    const registered = new Set<string>(HELP_ARTICLE_SLUGS);
    for (const slug of onDisk.keys()) {
      expect(registered.has(slug), `content/help/${slug}.md is not registered in lib/help.ts`).toBe(true);
    }
  });

  it("every tip's helpSlug resolves — Learn-more links can never be dead", () => {
    for (const [id, tip] of Object.entries(TIPS)) {
      if (!tip.helpSlug) continue;
      expect(helpUrl(tip.helpSlug), `tip '${id}' points at unresolvable '${tip.helpSlug}'`).toBeTruthy();
    }
  });

  it("every live feature area has at least one article", () => {
    const sections = new Set(helpNav().map((s) => s.section));
    for (const s of HELP_SECTIONS) {
      if (s.key === "formats") continue; // generated pages (v3/06 §4), not Markdown
      expect(sections.has(s.key), `feature area '${s.key}' has no help article`).toBe(true);
    }
  });

  it("articles carry frontmatter and render to sanitized HTML", async () => {
    for (const a of onDisk.values()) {
      expect(a.title.length, `${a.slug} missing title`).toBeGreaterThan(3);
      expect(a.description.length, `${a.slug} missing description`).toBeGreaterThan(10);
      const html = await renderHelpMarkdown(a.markdown);
      expect(html).not.toMatch(/<script|onerror|javascript:/i);
      expect(html.length).toBeGreaterThan(100);
    }
  });

  it("search finds the waitlist article (acceptance golden)", () => {
    const index = new FlexSearch.Document({
      document: { id: "slug", index: ["title", "text"], store: false },
      tokenize: "forward",
    });
    for (const a of onDisk.values()) {
      index.add({ slug: a.slug, title: a.title, text: helpPlainText(a.markdown) });
    }
    const results = index.search("waitlist");
    const slugs = results.flatMap((f) => f.result as string[]);
    expect(slugs).toContain("registration/waitlist");
  });

  // Registration redesign B3 review m4: the waitlist article quoted words no screen shows ("You're #2 in line", "full — waitlist: 3").
  // The quotes are now the screens' own, read from the English dictionary the status page and the division card render (not typed
  // here), so a copy change to either screen reds this until the article follows.
  it("the waitlist article quotes the status page's and the division card's own words", () => {
    const ui = JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Dict;
    const article = onDisk.get("registration/waitlist");
    expect(article, "premise: the article exists").toBeDefined();
    const quotes = [t(ui, "register.status.waitlistPosition", { n: 2 }), t(ui, "register.capacity.fullWaitlistCount", { count: 3 })];
    for (const q of quotes) expect(article!.markdown, q).toContain(q);
    expect(quotes.length, "anti-vacuity: two quotes checked").toBe(2);
  });
});

// Heading ids (help-heading-ids.ts): h2/h3 get an id from their own text; nothing else ever does.
describe("heading ids", () => {
  const onDisk = allHelpArticles();
  const ids = (html: string) => [...html.matchAll(/<h([23]) id="([^"]*)"/g)].map((m) => m[2]!);

  it("h2 and h3 carry ids; h1 does not exist in output", async () => {
    const html = await renderHelpMarkdown("# Title\n\n## The platform fee\n\ntext\n\n### Sub heading\n");
    expect(html).toContain('<h2 id="the-platform-fee">The platform fee</h2>');
    expect(html).toContain('<h3 id="sub-heading">Sub heading</h3>');
    expect(html).not.toMatch(/<h1/);
  });

  it("numbering, punctuation, markup and emoji give a sane id (what authors link to)", async () => {
    const cases: [string, string][] = [
      ["5. Disputes (chargebacks)", "5-disputes-chargebacks"],
      ["Refunds & **credits**: what `changes`?", "refunds-credits-what-changes"],
      ["Take [a look](/help/billing/plans) now", "take-a-look-now"],
      ["\u{1F3C6} Winners' table!", "winners-table"],
      ["  Spaced   out  ", "spaced-out"],
      ["Caf\u00e9 au lait", "caf\u00e9-au-lait"],
    ];
    for (const [heading, id] of cases) {
      expect(ids(await renderHelpMarkdown(`## ${heading}\n`)), heading).toEqual([id]);
    }
    expect(cases.length, "anti-vacuity").toBeGreaterThan(0);
    // A heading with nothing sluggable still gets an id, not an empty or missing one.
    expect(ids(await renderHelpMarkdown("## \u{1F3C6}\u{1F3C6}\n"))).toEqual(["section"]);
    expect(slugifyHeading("")).toBe("section");
  });

  it("repeated headings in one article get distinct, stable ids; a new article starts again", async () => {
    const md = "## Details\n\na\n\n## Details\n\nb\n\n### Details\n\nc\n\n## Details 2\n";
    const first = ids(await renderHelpMarkdown(md));
    expect(first).toEqual(["details", "details-2", "details-3", "details-2-2"]);
    expect(new Set(first).size, "all distinct").toBe(first.length);
    expect(ids(await renderHelpMarkdown(md)), "stable across renders").toEqual(first);
    expect(ids(await renderHelpMarkdown("## Details\n")), "per article, not process-wide").toEqual(["details"]);
  });

  it("a heading nested in a blockquote still gets an id", async () => {
    expect(ids(await renderHelpMarkdown("> ## Quoted\n"))).toEqual(["quoted"]);
  });

  it("an id on any other element is stripped by the sanitiser, and ids never come from the author", async () => {
    // The pipeline drops raw HTML, so the schema is exercised directly on a hast tree that carries ids everywhere.
    const tree: Root = {
      type: "root",
      children: ["h2", "h3", "p", "a", "table", "pre", "blockquote", "code"].map((tagName) => ({
        type: "element" as const,
        tagName,
        properties: { id: `evil-${tagName}`, ...(tagName === "a" ? { href: "https://example.com/" } : {}) },
        children: [{ type: "text" as const, value: "x" }],
      })),
    };
    const clean = await unified().use(rehypeSanitize, HELP_SCHEMA).run(tree);
    const kept = (clean as Root).children.flatMap((c) => (c.type === "element" ? [c] : []));
    expect(kept.length, "anti-vacuity: elements survived the sanitiser").toBeGreaterThan(0);
    for (const el of kept) expect(el.properties, el.tagName).not.toHaveProperty("id");

    // And through the real pipeline: raw HTML naming ids yields only the derived ones, on h2/h3.
    const html = await renderHelpMarkdown('<p id="evil">x</p>\n\n<h2 id="evil2">Real</h2>\n\n## Real heading\n\n[a](#x)\n');
    expect(html).not.toContain("evil");
    const tagsWithId = [...html.matchAll(/<(\w+)[^>]*\sid="/g)].map((m) => m[1]);
    expect(tagsWithId.length, "anti-vacuity: a derived id exists").toBeGreaterThan(0);
    expect(tagsWithId.every((t) => t === "h2" || t === "h3")).toBe(true);
  });

  it("ids are real on every shipped article: each h2/h3 in the Markdown has one", async () => {
    let headings = 0;
    for (const a of onDisk.values()) {
      const html = await renderHelpMarkdown(a.markdown);
      const withId = (html.match(/<h[23] id="[^"]+"/g) ?? []).length;
      const all = (html.match(/<h[23][ >]/g) ?? []).length;
      expect(withId, `${a.slug}: every heading has an id`).toBe(all);
      headings += all;
    }
    expect(headings, "anti-vacuity: headings were checked").toBeGreaterThan(0);
  });
});
