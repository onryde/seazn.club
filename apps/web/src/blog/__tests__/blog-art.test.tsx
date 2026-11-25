// A post's own artwork: `{{art:<id>}}` alone on a line places a hand-made picture with a wide and a phone drawing
// (blog/art.ts). It exists so a how-to post, which has nothing to generate, needs no made-up worked example. Held
// here: the parser and renderer rules (and that a post still needs an example OR art), the markup, and every file the
// registry names. vitest is `environment: "node"`: which drawing a width shows is e2e/blog.spec.ts's.
//
// Single-sport reason: no sport is involved; this is the blog's content pipeline.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BLOG_ART } from "@/blog/art";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import { blogLeakText, findBlogLeaks } from "@/blog/leaks";
import { BlogArtFigure } from "@/components/blog/blog-art";
import { BlogFrontmatterError, PLAN_WORD, TYPED_FIGURE, allBlogPosts, parseBlogFrontmatter } from "@/server/blog-content";
import { renderBlogPost } from "@/server/blog-render";

const PUBLIC = join(process.cwd(), "public");
/** help-figures.ts holds a help picture to this; the artwork keeps the same budget. */
const MAX_BYTES = 150 * 1024;
const ids = Object.keys(BLOG_ART);

const raw = (body: string, examples = "") =>
  [
    "---",
    "title: What does a test post need?",
    "description: A description that is comfortably longer than the fifty characters a post needs.",
    "date: 2026-01-01",
    "author: Seazn",
    "topic: streaming",
    "sports: all",
    "help: scheduling/match-day-stream",
    "related: how-a-ladder-works, round-robin-schedule",
    `examples: ${examples}`,
    "---",
    "",
    body,
  ].join("\n");

const problems = (text: string): string[] => {
  try {
    parseBlogFrontmatter(text, "content/blog/test-post.md");
    return [];
  } catch (e) {
    if (!(e instanceof BlogFrontmatterError)) throw e;
    return e.problems.map((p) => `${p.key}: ${p.message}`);
  }
};

const ART = "{{art:stream-flow}}";

describe("a post may carry art in place of an example", () => {
  it("premise: the registry holds the stream picture", () => {
    expect(ids).toContain("stream-flow");
  });

  it("art and an empty `examples:` is a valid post", () => {
    expect(problems(raw(`Intro.\n\n${ART}\n\n## One\n\nText.`))).toEqual([]);
  });

  it("neither an example nor art is still refused", () => {
    expect(problems(raw("Intro.\n\n## One\n\nText.")).join("\n")).toMatch(/examples: is empty/);
  });

  it("an unknown art id, a token inside a line and a second placing are each refused", () => {
    expect(problems(raw(`${ART}\n\n{{art:nothing-here}}`)).join("\n")).toMatch(/no art 'nothing-here'/);
    expect(problems(raw(`${ART}\n\nSee {{art:stream-flow}} here.`)).join("\n")).toMatch(/alone on its own line/);
    expect(problems(raw(`${ART}\n\n${ART}`)).join("\n")).toMatch(/placed more than once/);
    // A bad token does not stand in for a picture.
    expect(problems(raw("{{art:nothing-here}}")).join("\n")).toMatch(/examples: is empty/);
  });

  it("the renderer cuts the body at the art line into its own part, and prints no token", async () => {
    const out = await renderBlogPost({ slug: "test-post", markdown: `Before.\n\n${ART}\n\n## After\n\nText.`, examples: [] });
    expect(out.parts.map((p) => p.kind)).toEqual(["html", "art", "html"]);
    expect(out.parts[1]).toMatchObject({ kind: "art", id: "stream-flow" });
    expect(JSON.stringify(out.parts)).not.toContain("{{");
    expect(out.headings.map((h) => h.text)).toEqual(["After"]);
  });

  it("the renderer refuses a post with neither, an unknown art id, a second placing and a token inside a line", async () => {
    const render = (markdown: string) => renderBlogPost({ slug: "test-post", markdown, examples: [] }, BLOG_GOLDENS);
    await expect(render("## Only text")).rejects.toThrow(/no example/);
    await expect(render("{{art:nothing-here}}")).rejects.toThrow(/no art 'nothing-here'/);
    await expect(render(`${ART}\n${ART}`)).rejects.toThrow(/more than once/);
    await expect(render(`${ART}\n\nin {{art:stream-flow}} line`)).rejects.toThrow(/alone on its own line/);
  });

  it("the leak scan reads past the art token (its id is not prose)", () => {
    expect(blogLeakText(`a\n${ART}\nb`)).not.toContain("art:");
  });
});

describe("the art markup", () => {
  it("one img with the wide drawing and its name, and the phone drawing below 600px", () => {
    const art = BLOG_ART["stream-flow"]!;
    const html = renderToStaticMarkup(<BlogArtFigure art={art} />);
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`<source media="\\(max-width: 599\\.98px\\)" srcSet="${art.phone.src}"`, "i"));
    expect(html).toMatch(new RegExp(`<img[^>]* src="${art.wide.src}"`));
    expect(html).toContain(`alt="${art.alt}"`);
    expect(art.alt.length, "the picture has a real name").toBeGreaterThan(40);
  });
});

/** Every string a reader can see or hear in the SVG: its name, its <text>, and the words that were drawn as outlines. */
const svgWords = (svg: string): string[] => [
  ...[...svg.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!),
  ...[...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!).filter((t) => t !== ""),
  ...[...svg.matchAll(/data-text="([^"]*)"/g)].map((m) => m[1]!),
];

describe("every file the art registry names", () => {
  it("is a self-contained SVG of the declared size, within budget, that needs no web font", () => {
    let checked = 0;
    for (const id of ids) {
      for (const drawing of [BLOG_ART[id]!.wide, BLOG_ART[id]!.phone]) {
        expect(drawing.src, id).toMatch(/^\/help\/blog\/[a-z0-9-]+\.svg$/);
        const file = join(PUBLIC, drawing.src);
        expect(statSync(file).size, `${drawing.src}: bytes`).toBeLessThanOrEqual(MAX_BYTES);
        const svg = readFileSync(file, "utf8");
        expect(svg, drawing.src).toContain(`viewBox="0 0 ${drawing.width} ${drawing.height}"`);
        expect(svg, `${drawing.src}: its name is the alt text`).toContain(`aria-label="${BLOG_ART[id]!.alt}"`);
        // An <img> cannot load the page's fonts: no text may ask for one that is not on the reader's own machine.
        expect(svg, `${drawing.src}: names Barlow`).not.toMatch(/Barlow/);
        expect(svg.match(/<path data-text="/g)?.length ?? 0, `${drawing.src}: outlined headings`).toBeGreaterThan(5);
        const refs = [...svg.matchAll(/(?:href|src)="([^"]*)"|url\(([^)]*)\)/g)].map((m) => m[1] ?? m[2]!);
        expect(refs.length, `${drawing.src}: anti-vacuity, references`).toBeGreaterThan(0);
        for (const ref of refs) expect(ref.startsWith("data:") || ref.startsWith("#"), `${drawing.src}: outside reference ${ref.slice(0, 60)}`).toBe(true);
        expect(svg, drawing.src).not.toMatch(/@import|<script|<foreignObject/i);
        checked++;
      }
    }
    console.log(`art drawings checked: ${checked}`);
    expect(checked, "anti-vacuity: drawings checked").toBe(ids.length * 2);
    expect(checked).toBeGreaterThan(0);
  });

  // Seazn Hosted Video is behind SEAZN_HOSTED_LIVE, off unless set (server/relay/config.ts), so no public picture or post offers it.
  it("says nothing a post may not say: no leak, no typed plan figure, and no unreleased destination", () => {
    let scanned = 0;
    for (const id of ids) {
      const art = BLOG_ART[id]!;
      const words = [art.alt, ...[art.wide, art.phone].flatMap((d) => svgWords(readFileSync(join(PUBLIC, d.src), "utf8")))];
      for (const s of words) {
        expect(findBlogLeaks(s), `${id}: ${s}`).toEqual([]);
        expect(TYPED_FIGURE.test(s) && PLAN_WORD.test(s), `${id}: plan figure in '${s}'`).toBe(false);
        expect(s, id).not.toMatch(/Seazn Hosted/i);
        scanned++;
      }
    }
    console.log(`art strings scanned: ${scanned}`);
    expect(scanned, "anti-vacuity: strings scanned").toBeGreaterThan(20);
    const posts = allBlogPosts().filter((p) => p.markdown.includes("{{art:"));
    expect(posts.length, "anti-vacuity: posts with art").toBeGreaterThan(0);
    for (const p of posts) expect(`${p.title}\n${p.description}\n${p.markdown}`, p.slug).not.toMatch(/Seazn Hosted/i);
  });

  it("each registered picture is placed by exactly one post", () => {
    const posts = allBlogPosts();
    expect(ids.length, "anti-vacuity: art").toBeGreaterThan(0);
    for (const id of ids) expect(posts.filter((p) => p.markdown.includes(`{{art:${id}}}`)).map((p) => p.slug), id).toHaveLength(1);
  });
});
