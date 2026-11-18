// The stale-doc gate (v3/06 §3, v3/11 gap 14): the Markdown on disk, the
// client-safe slug registry in lib/help.ts, the Tips deep-links and the
// feature-area sections must all agree — a feature area or tip cannot ship
// without its /help article, and a deleted article cannot leave dead links.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import rehypeSanitize from "rehype-sanitize";
import type { Element, Root } from "hast";
import FlexSearch from "flexsearch";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import {
  HELP_SCHEMA, HELP_SECTIONS, allHelpArticles, helpHeadings, helpNav, helpPlainText, renderHelpMarkdown,
} from "@/server/help-content";
import { slugifyHeading } from "@/server/help-heading-ids";
import { HELP_PICTURE_MAX_BYTES } from "@/server/help-figures";
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
      ["Don't forget", "dont-forget"],
      ["Don\u2019t forget the organiser\u2019s fee", "dont-forget-the-organisers-fee"],
      ["Players\u2018 view", "players-view"],
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

// Pictures: `![alt](/help/<section>/<file>.webp "caption")` -> a <figure> with real dimensions, built from a file in
// public/help. There is no real picture in the product yet, so these run against ONE tiny real webp kept under the test
// directory and a temp public root (the renderer's `publicRoot` option), never against a page of the real help tree.
describe("pictures", () => {
  const FIXTURE_ROOT = join(__dirname, "fixtures", "help-public");
  // screen-1.webp was generated as an 8 x 5 image; the numbers below come from that, not from the renderer.
  const FIXTURE_W = 8;
  const FIXTURE_H = 5;
  const SRC = "/help/sample/screen-1.webp";
  const render = (md: string, publicRoot: string = FIXTURE_ROOT) => renderHelpMarkdown(md, undefined, { publicRoot });

  it("renders a figure that carries the file's real width and height, lazy loading and the caption", async () => {
    const html = await render(`Before.\n\n![The scheduling board](${SRC} "Drag a match onto a court")\n\nAfter.\n`);
    expect(html).toMatch(/<figure>\s*<img /);
    expect(html).toContain(`src="${SRC}"`);
    expect(html).toContain('alt="The scheduling board"');
    expect(html).toContain(`width="${FIXTURE_W}"`);
    expect(html).toContain(`height="${FIXTURE_H}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("<figcaption>Drag a match onto a court</figcaption>");
    // the caption lives in the figcaption only, so it is not read out twice
    expect(html).not.toContain("title=");
    // a picture is never left inside a paragraph (a figure cannot be)
    expect(html).not.toMatch(/<p>\s*<figure/);
    expect(html).toContain("<p>Before.</p>");
    expect(html).toContain("<p>After.</p>");
  });

  it("a picture with no caption is a figure without a figcaption", async () => {
    const html = await render(`![The scheduling board](${SRC})\n`);
    expect(html).toContain("<figure>");
    expect(html).not.toContain("figcaption");
  });

  it("two pictures render two figures (the second call is not skipped)", async () => {
    const html = await render(`![One](${SRC} "First")\n\n![Two](${SRC} "Second")\n`);
    expect(html.match(/<figure>/g)?.length).toBe(2);
    expect(html).toContain("<figcaption>First</figcaption>");
    expect(html).toContain("<figcaption>Second</figcaption>");
  });

  it("a picture inside a callout-free blockquote still becomes a figure", async () => {
    const html = await render(`> ![Quoted](${SRC} "In a quote")\n`);
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<figure>");
  });

  describe("refusals (each throws, naming the picture)", () => {
    const rejects = async (md: string, message: RegExp, publicRoot?: string) => {
      await expect(render(md, publicRoot)).rejects.toThrow(message);
    };

    it("alt text is required and non-empty", async () => {
      await rejects(`![](${SRC} "caption")\n`, /alt text/i);
      await rejects(`![   ](${SRC})\n`, /alt text/i);
    });

    it("a file that is not there fails", async () => {
      await rejects("![Missing](/help/sample/not-there.webp)\n", /not found/i);
    });

    it("only .webp is accepted", async () => {
      await rejects("![A png](/help/sample/screen-1.png)\n", /only \.webp/i);
      await rejects("![A jpg](/help/sample/screen-1.jpg)\n", /only \.webp/i);
    });

    it("the src must be a same-site /help/<section>/<file>.webp path: external, scheme and protocol-relative srcs fail", async () => {
      const srcs = [
        "https://example.com/help/sample/screen-1.webp",
        "http://example.com/a.webp",
        "//example.com/help/sample/screen-1.webp",
        "javascript:alert(1)",
        "data:image/webp;base64,AAAA",
        "/other/sample/screen-1.webp",
        "/help/screen-1.webp",
        "/help/sample/../sample/screen-1.webp",
        "help/sample/screen-1.webp",
      ];
      for (const src of srcs) await rejects(`![Bad](${src})\n`, /same-site|only \.webp/i);
      expect(srcs.length, "anti-vacuity: srcs probed").toBeGreaterThan(5);
    });

    it("a picture over the 150 KB budget fails, and the budget is what the project says", async () => {
      expect(HELP_PICTURE_MAX_BYTES).toBe(150 * 1024);
      const dir = mkdtempSync(join(tmpdir(), "help-pic-"));
      try {
        mkdirSync(join(dir, "help", "sample"), { recursive: true });
        // incompressible noise, lossless, so the file is genuinely large
        const w = 400;
        const raw = randomBytes(w * w * 3);
        const big = await sharp(raw, { raw: { width: w, height: w, channels: 3 } }).webp({ lossless: true }).toBuffer();
        expect(big.length, "premise: the generated file is over budget").toBeGreaterThan(HELP_PICTURE_MAX_BYTES);
        writeFileSync(join(dir, "help", "sample", "big.webp"), big);
        await rejects("![Big](/help/sample/big.webp)\n", /150 KB/, dir);
        // and the same pipeline accepts a small one from the same kind of root (the refusal is the size, not the root)
        mkdirSync(join(dir, "help", "ok"), { recursive: true });
        copyFileSync(join(FIXTURE_ROOT, "help", "sample", "screen-1.webp"), join(dir, "help", "ok", "small.webp"));
        expect(await render("![Small](/help/ok/small.webp)\n", dir)).toContain("<figure>");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a file named .webp that is not a webp image fails", async () => {
      const dir = mkdtempSync(join(tmpdir(), "help-pic-"));
      try {
        mkdirSync(join(dir, "help", "sample"), { recursive: true });
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).png().toBuffer();
        writeFileSync(join(dir, "help", "sample", "fake.webp"), png);
        await rejects("![Fake](/help/sample/fake.webp)\n", /not a webp/i, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a picture must stand alone in its own paragraph (inline, in a link, or beside text it fails)", async () => {
      await rejects(`Text before ![Inline](${SRC}) and after.\n`, /own paragraph/i);
      await rejects(`[![Linked](${SRC})](/help/billing/plans)\n`, /own paragraph/i);
      await rejects(`![One](${SRC})\n![Two](${SRC})\n`, /own paragraph/i);
    });
  });

  it("raw HTML cannot smuggle a picture, a figure or its attributes in", async () => {
    const html = await render(
      `<img src="${SRC}" width="9999" onerror="x()">\n\n<figure><img src="https://example.com/a.webp"></figure>\n\ntext\n`,
    );
    expect(html).not.toMatch(/<img|<figure|9999|onerror|example\.com/);
  });

  describe("the sanitiser, driven directly", () => {
    const run = async (props: NonNullable<Element["properties"]>) => {
      const tree: Root = {
        type: "root",
        children: [{ type: "element", tagName: "img", properties: props, children: [] }],
      };
      const clean = (await unified().use(rehypeSanitize, HELP_SCHEMA).run(tree)) as Root;
      const el = clean.children.find((c) => c.type === "element");
      return el && el.type === "element" ? el.properties : undefined;
    };

    it("drops every src that is not a plain path (external, javascript:, data:, mailto:) and keeps a /help path", async () => {
      const dropped = ["https://example.com/a.webp", "http://example.com/a.webp", "javascript:alert(1)", "data:image/webp;base64,AAAA", "mailto:a@b.co"];
      for (const src of dropped) expect((await run({ src, alt: "x" }))?.src, src).toBeUndefined();
      expect(dropped.length, "anti-vacuity").toBeGreaterThan(0);
      expect((await run({ src: SRC, alt: "x" }))?.src).toBe(SRC);
    });

    it("keeps alt and title, and strips dimensions, loading and anything else an author could name", async () => {
      const props = await run({ src: SRC, alt: "x", title: "t", width: 9999, height: 9999, loading: "eager", onerror: "x()", style: "x", id: "evil", className: ["help-callout"] });
      expect(props).toMatchObject({ src: SRC, alt: "x", title: "t" });
      for (const k of ["width", "height", "loading", "onerror", "style", "id", "className"]) expect(props, k).not.toHaveProperty(k);
    });

    it("figure and figcaption are not in the author-facing schema (the renderer adds them after sanitising)", () => {
      expect(HELP_SCHEMA.tagNames).not.toContain("figure");
      expect(HELP_SCHEMA.tagNames).not.toContain("figcaption");
      expect(HELP_SCHEMA.tagNames).not.toContain("aside");
    });
  });
});

// helpHeadings: ONE list of an article's h2/h3, taken from the same tree walk that assigns the ids.
describe("helpHeadings", () => {
  it("returns depth, text and id in document order, the ids being the rendered ones", async () => {
    const md = "# Title\n\n## The platform fee\n\ntext\n\n### Sub **heading**\n\n## The platform fee\n";
    const headings = await helpHeadings(md);
    expect(headings).toEqual([
      { depth: 2, text: "The platform fee", id: "the-platform-fee" },
      { depth: 3, text: "Sub heading", id: "sub-heading" },
      { depth: 2, text: "The platform fee", id: "the-platform-fee-2" },
    ]);
    const html = await renderHelpMarkdown(md);
    const rendered = [...html.matchAll(/<h[23] id="([^"]*)"/g)].map((m) => m[1]);
    expect(headings.map((h) => h.id), "same ids as the rendered HTML").toEqual(rendered);
  });

  it("an article with no h2/h3 has an empty list (the empty case), and every shipped article's list matches its rendered ids", async () => {
    expect(await helpHeadings("Just a paragraph.\n")).toEqual([]);
    let checked = 0;
    for (const a of allHelpArticles().values()) {
      const html = await renderHelpMarkdown(a.markdown);
      const rendered = [...html.matchAll(/<h[23] id="([^"]*)"/g)].map((m) => m[1]);
      expect((await helpHeadings(a.markdown)).map((h) => h.id), a.slug).toEqual(rendered);
      checked += rendered.length;
    }
    expect(checked, "anti-vacuity: headings compared").toBeGreaterThan(0);
  });
});

// Callouts: a blockquote whose FIRST LINE is exactly **Note**, **Warning** or **Example** becomes
// <aside class="help-callout" data-kind="...">; every other blockquote stays a blockquote.
describe("callouts", () => {
  const KINDS: [label: string, kind: string][] = [["Note", "note"], ["Warning", "warning"], ["Example", "example"]];

  it("each kind renders its aside, data-kind and a visible label", async () => {
    for (const [label, kind] of KINDS) {
      const html = await renderHelpMarkdown(`> **${label}**\n> Check the draw before you publish.\n`);
      expect(html, label).toContain(`<aside class="help-callout" data-kind="${kind}">`);
      expect(html, `${label}: the label is visible text`).toContain(`<strong>${label}</strong>`);
      expect(html, `${label}: the body is inside`).toContain("Check the draw before you publish.");
      expect(html, `${label}: no longer a blockquote`).not.toContain("<blockquote");
      expect(html.match(/<aside\b/g)?.length).toBe(1);
      expect(html.match(/<\/aside>/g)?.length).toBe(1);
    }
    expect(KINDS.length, "anti-vacuity").toBe(3);
  });

  it("the label alone on the first line, with the body in following paragraphs, lists and headings", async () => {
    const html = await renderHelpMarkdown("> **Warning**\n>\n> First paragraph.\n>\n> - one\n> - two\n>\n> ## Inside heading\n");
    expect(html).toContain('<aside class="help-callout" data-kind="warning">');
    expect(html).toContain("<li>one</li>");
    expect(html, "a heading in a callout still gets its id").toContain('<h2 id="inside-heading">');
  });

  it("a callout with only its label (the empty body) is still a callout", async () => {
    const html = await renderHelpMarkdown("> **Note**\n");
    expect(html).toContain('<aside class="help-callout" data-kind="note">');
    expect(html).toContain("<strong>Note</strong>");
  });

  it("anything else stays a blockquote: another label, other casing, text on the label's line, a plain quote", async () => {
    const stays = [
      "> **Tip**\n> Not a kind we have.\n",
      "> **note**\n> lower case is not the label.\n",
      "> **Notes**\n> plural is not the label.\n",
      "> **Note** and then text on the same line.\n",
      "> Note\n> no bold.\n",
      "> *Note*\n> emphasis, not strong.\n",
      "> Text first, then **Note**\n",
      "> A plain quotation.\n",
    ];
    for (const md of stays) {
      const html = await renderHelpMarkdown(md);
      expect(html, md).toContain("<blockquote>");
      expect(html, md).not.toMatch(/<aside|help-callout|data-kind/);
    }
    expect(stays.length, "anti-vacuity").toBeGreaterThan(5);
  });

  it("a second callout, of another kind, and a plain quote between them, are each handled on their own", async () => {
    const html = await renderHelpMarkdown("> **Note**\n> One.\n\nBetween.\n\n> Plain.\n\n> **Example**\n> Two.\n");
    expect(html.match(/<aside\b/g)?.length).toBe(2);
    expect(html).toContain('data-kind="note"');
    expect(html).toContain('data-kind="example"');
    expect(html.match(/<blockquote>/g)?.length).toBe(1);
    // order is the document's
    expect(html.indexOf('data-kind="note"')).toBeLessThan(html.indexOf("<blockquote>"));
    expect(html.indexOf("<blockquote>")).toBeLessThan(html.indexOf('data-kind="example"'));
  });

  it("a callout inside a list item or another quote is still a callout", async () => {
    const html = await renderHelpMarkdown("- item\n\n  > **Note**\n  > In a list.\n\n> outer\n>\n> > **Example**\n> > Nested.\n");
    expect(html).toContain('data-kind="note"');
    expect(html).toContain('data-kind="example"');
  });

  it("the author cannot write one: raw HTML is dropped and the sanitiser strips class and data-kind from any element", async () => {
    const html = await renderHelpMarkdown('<aside class="help-callout" data-kind="warning">x</aside>\n\n<p class="help-callout" data-kind="note">y</p>\n\ntext\n');
    expect(html).not.toMatch(/<aside|help-callout|data-kind/);

    const tree: Root = {
      type: "root",
      children: ["blockquote", "p", "aside", "h2"].map((tagName) => ({
        type: "element" as const,
        tagName,
        properties: { className: ["help-callout"], dataKind: "warning" },
        children: [{ type: "text" as const, value: "x" }],
      })),
    };
    const clean = (await unified().use(rehypeSanitize, HELP_SCHEMA).run(tree)) as Root;
    const els = clean.children.flatMap((c) => (c.type === "element" ? [c] : []));
    expect(els.length, "anti-vacuity: elements survived").toBeGreaterThan(0);
    for (const el of els) {
      expect(el.properties, el.tagName).not.toHaveProperty("className");
      expect(el.properties, el.tagName).not.toHaveProperty("dataKind");
    }
  });
});
