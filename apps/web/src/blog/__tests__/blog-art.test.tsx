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
import { BLOG_TOPICS } from "@/lib/blog";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import { blogLeakText, findBlogLeaks } from "@/blog/leaks";
import { BlogArtFigure } from "@/components/blog/blog-art";
import { BlogFrontmatterError, PLAN_WORD, TYPED_FIGURE, allBlogPosts, parseBlogFrontmatter } from "@/server/blog-content";
import { renderBlogPost } from "@/server/blog-render";

const PUBLIC = join(process.cwd(), "public");
/** help-figures.ts holds a help picture to this; the artwork keeps the same budget. */
const MAX_BYTES = 150 * 1024;
const ids = Object.keys(BLOG_ART);

const raw = (body: string, examples = "", topic = "streaming") =>
  [
    "---",
    "title: What does a test post need?",
    "description: A description that is comfortably longer than the fifty characters a post needs.",
    "date: 2026-01-01",
    "author: Seazn",
    `topic: ${topic}`,
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

  it("art with an empty `examples:` is refused on every topic but streaming, by the parser and the renderer", async () => {
    const others = BLOG_TOPICS.filter((t) => t !== "streaming");
    expect(others.length, "anti-vacuity: other topics").toBeGreaterThan(0);
    const body = `Intro.\n\n${ART}\n\n## One\n\nText.`;
    let checked = 0;
    for (const topic of others) {
      expect(problems(raw(body, "", topic)).join("\n"), topic).toMatch(/examples: is empty/);
      await expect(renderBlogPost({ slug: "test-post", topic, markdown: body, examples: [] }), topic).rejects.toThrow(/no example/);
      checked++;
    }
    console.log(`topics refused art-only: ${checked}`);
    expect(checked, "anti-vacuity: topics checked").toBe(others.length);
  });

  it("another topic may place art beside a worked example", async () => {
    const id = Object.keys(BLOG_GOLDENS)[0]!;
    const body = `Intro.\n\n${ART}\n\n{{example:${id}}}\n\n## One\n\nText.`;
    const other = BLOG_TOPICS.find((t) => t !== "streaming")!;
    expect(problems(raw(body, id, other))).toEqual([]);
    const out = await renderBlogPost({ slug: "test-post", topic: other, markdown: body, examples: [id] });
    expect(out.parts.map((p) => p.kind)).toEqual(["html", "art", "example", "html"]);
  });

  it("an unknown art id, a token inside a line and a second placing are each refused", () => {
    expect(problems(raw(`${ART}\n\n{{art:nothing-here}}`)).join("\n")).toMatch(/no art 'nothing-here'/);
    expect(problems(raw(`${ART}\n\nSee {{art:stream-flow}} here.`)).join("\n")).toMatch(/alone on its own line/);
    expect(problems(raw(`${ART}\n\n${ART}`)).join("\n")).toMatch(/placed more than once/);
    // A bad token does not stand in for a picture.
    expect(problems(raw("{{art:nothing-here}}")).join("\n")).toMatch(/examples: is empty/);
  });

  it("the renderer cuts the body at the art line into its own part, and prints no token", async () => {
    const out = await renderBlogPost({ slug: "test-post", topic: "streaming", markdown: `Before.\n\n${ART}\n\n## After\n\nText.`, examples: [] });
    expect(out.parts.map((p) => p.kind)).toEqual(["html", "art", "html"]);
    expect(out.parts[1]).toMatchObject({ kind: "art", id: "stream-flow" });
    expect(JSON.stringify(out.parts)).not.toContain("{{");
    expect(out.headings.map((h) => h.text)).toEqual(["After"]);
  });

  it("the renderer refuses a post with neither, an unknown art id, a second placing and a token inside a line", async () => {
    const render = (markdown: string) => renderBlogPost({ slug: "test-post", topic: "streaming", markdown, examples: [] }, BLOG_GOLDENS);
    await expect(render("## Only text")).rejects.toThrow(/no example/);
    await expect(render("{{art:nothing-here}}")).rejects.toThrow(/no art 'nothing-here'/);
    await expect(render(`${ART}\n${ART}`)).rejects.toThrow(/more than once/);
    await expect(render(`${ART}\n\nin {{art:stream-flow}} line`)).rejects.toThrow(/alone on its own line/);
  });

  it("the leak scan reads past the art token (its id is not prose)", () => {
    expect(blogLeakText(`a\n${ART}\nb`)).not.toContain("art:");
  });
});

describe("the streaming guide's credit sentence", () => {
  it("says how long one credit covers, as the Seazn credits help page says it, and links that page", () => {
    const help = readFileSync(join(process.cwd(), "content", "help", "billing", "match-credits.md"), "utf8");
    const hours = /1 credit = 1 match stream, up to (\d+) hours/.exec(help)?.[1];
    expect(hours, "premise: the help page states the length").toBeDefined();
    const post = allBlogPosts().find((p) => p.slug === "what-you-need-to-stream-a-match")!;
    const line = post.markdown.split("\n").find((l) => l.includes("](/help/billing/match-credits)"));
    expect(line, "the post links the credits page").toBeDefined();
    expect(line).toMatch(new RegExp(`one match stream, up to ${hours} hours`));
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
  ...svgTextWords(svg),
  ...[...svg.matchAll(/data-text="([^"]*)"/g)].map((m) => m[1]!),
];

/**
 * The words of every <text>, its child elements included. One with children is given twice, its pieces run together and
 * spaced, because the markup does not say whether two spans touch. Every opening tag must be read: one that is not
 * closed throws rather than being skipped.
 */
function svgTextWords(svg: string): string[] {
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const found = [...svg.matchAll(/<text\b[^>]*?(?:\/>|>([\s\S]*?)<\/text>)/g)];
  const opened = svg.match(/<text\b/g)?.length ?? 0;
  if (found.length !== opened) throw new Error(`unread <text>: ${opened} opened, ${found.length} read`);
  return found.flatMap((m) => {
    const inner = m[1] ?? "";
    const readings = new Set([squash(inner.replace(/<[^>]*>/g, "")), squash(inner.replace(/<[^>]*>/g, " "))]);
    return [...readings].filter((t) => t !== "");
  });
}

describe("the SVG word reader the scans run on", () => {
  const words = (inner: string) => svgWords(`<svg aria-label="Name">${inner}</svg>`);

  it("reads a <text> that has child elements, however its words are split", () => {
    // Spans that continue a line carry their own space; spans placed apart (x/dy) carry none, so both readings are given.
    expect(words('<text x="1">Seazn <tspan fill="#fff">Hosted</tspan></text>')).toContain("Seazn Hosted");
    expect(words('<text><tspan x="0">Seazn</tspan><tspan x="0" dy="9">Hosted</tspan></text>')).toContain("Seazn Hosted");
    expect(words('<text><tspan>Sea</tspan><tspan>zn</tspan></text>')).toContain("Seazn");
  });

  it("an empty or self-closed <text> adds nothing and does not swallow the next one", () => {
    expect(words('<text x="1"/><rect/><text></text><text>After</text>')).toEqual(["Name", "After"]);
  });

  it("refuses a <text> it cannot close rather than skipping it", () => {
    expect(() => words("<text>no end")).toThrow(/unread <text>/);
  });
});

/**
 * Every word in a drawing with the size it is drawn at, in the picture's own units: a <text> carries font-size, an outlined
 * heading carries data-size (art/outline.cjs), each times the scale() of every <g> around it. A word with no size, or a
 * size this cannot read (a style rule, another kind of scaling), throws rather than passing unmeasured.
 */
function svgWordSizes(svg: string): { word: string; units: number }[] {
  const out: { word: string; units: number }[] = [];
  const scales: number[] = [1];
  for (const m of svg.matchAll(/<(\/?)(g|text|tspan|path)\b([^>]*?)(\/?)>/g)) {
    const [whole, close, tag, attrs, selfClosed] = m as unknown as [string, string, string, string, string];
    if (/matrix\(|font-size\s*:/.test(attrs)) throw new Error(`a size this cannot read: ${whole}`);
    if (tag === "g") {
      if (close) scales.pop();
      else if (!selfClosed) {
        const scale = /scale\(\s*([\d.]+)\s*\)/.exec(attrs);
        if (attrs.includes("scale(") && !scale) throw new Error(`a size this cannot read: ${whole}`);
        scales.push(scales.at(-1)! * (scale ? Number(scale[1]) : 1));
      }
      continue;
    }
    if (close) continue;
    if (tag === "tspan") throw new Error(`a size this cannot read: ${whole}`);
    const outlined = /data-text="([^"]*)"/.exec(attrs)?.[1];
    if (tag === "path" && outlined === undefined) continue;
    const word = outlined ?? svg.slice(m.index! + whole.length, svg.indexOf("</text>", m.index));
    const size = (tag === "path" ? /\sdata-size="([\d.]+)"/ : /\sfont-size="([\d.]+)"/).exec(attrs)?.[1];
    if (size === undefined) throw new Error(`no size on '${word}'`);
    out.push({ word, units: Number(size) * scales.at(-1)! });
  }
  return out;
}

describe("the SVG size reader the legibility check runs on", () => {
  it("multiplies a word's size by every scale around it, and reads outlined headings", () => {
    const svg = '<g transform="translate(1 2) scale(.5)"><g><text font-size="20">A</text></g></g><path data-text="B" data-size="30" d="M0 0"/><path d="M1 1"/>';
    expect(svgWordSizes(svg)).toEqual([{ word: "A", units: 10 }, { word: "B", units: 30 }]);
  });

  it("refuses a word it cannot size", () => {
    expect(() => svgWordSizes("<text>A</text>")).toThrow(/no size/);
    expect(() => svgWordSizes('<path data-text="B" d="M0 0"/>')).toThrow(/no size/);
    expect(() => svgWordSizes('<g transform="scale(1 2)"><text font-size="20">A</text></g>')).toThrow(/cannot read/);
    expect(() => svgWordSizes('<text font-size="20" style="font-size:4px">A</text>')).toThrow(/cannot read/);
  });
});

// Where each drawing's words are smallest on the screens it is checked at, typed from the layout (e2e "the reading
// column" measures it): the wide drawing in the 680px column, from a 768px screen up, and the phone drawing on a 320px
// screen less the 16px gutters.
const SHOWN_AT = { wide: 680, phone: 320 - 2 * 16 } as const;
const MIN_WORD_PX = 11;

describe("every word in the art can be read", () => {
  it(`is drawn at ${MIN_WORD_PX}px or more: the wide drawing at ${SHOWN_AT.wide}px wide, the phone one at ${SHOWN_AT.phone}px`, () => {
    let checked = 0;
    const small: string[] = [];
    for (const id of ids) {
      for (const kind of ["wide", "phone"] as const) {
        const drawing = BLOG_ART[id]![kind];
        const svg = readFileSync(join(PUBLIC, drawing.src), "utf8");
        const words = svgWordSizes(svg);
        // Every <text> and every outlined heading was measured, none skipped.
        const onPage = (svg.match(/<text\b/g)?.length ?? 0) + (svg.match(/data-text="/g)?.length ?? 0);
        expect(words.length, `${drawing.src}: every word measured`).toBe(onPage);
        expect(words.length, `${drawing.src}: anti-vacuity, words`).toBeGreaterThan(5);
        for (const { word, units } of words) {
          const px = (units * SHOWN_AT[kind]) / drawing.width;
          if (px < MIN_WORD_PX) small.push(`${kind} '${word}' ${px.toFixed(1)}px`);
          checked++;
        }
        console.log(`${kind} words measured: ${words.length}, smallest ${Math.min(...words.map((w) => (w.units * SHOWN_AT[kind]) / drawing.width)).toFixed(2)}px`);
      }
    }
    expect(checked, "anti-vacuity: words measured").toBeGreaterThan(10);
    expect(small).toEqual([]);
  });
});

describe("every file the art registry names", () => {
  it("is a self-contained SVG of the declared size, within budget, that needs no web font", () => {
    let checked = 0;
    for (const id of ids) {
      for (const drawing of [BLOG_ART[id]!.wide, BLOG_ART[id]!.phone]) {
        expect(drawing.src, id).toMatch(/^\/blog-art\/[a-z0-9-]+\.svg$/);
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

  // 3 Mbps is the app's ceiling for the VIDEO; sound and overhead come on top, so no picture may offer it as the upload.
  it("the stream picture names its bitrate as the video's, in both drawings, and never as the upload", () => {
    const art = BLOG_ART["stream-flow"]!;
    let checked = 0;
    for (const d of [art.wide, art.phone]) {
      const rates = svgWords(readFileSync(join(PUBLIC, d.src), "utf8")).filter((s) => /mbps/i.test(s));
      expect(rates, d.src).toEqual(["VIDEO UP TO 3 MBPS"]);
      checked += rates.length;
    }
    expect(checked, "anti-vacuity: rates read").toBe(2);
  });

  it("each registered picture is placed by exactly one post", () => {
    const posts = allBlogPosts();
    expect(ids.length, "anti-vacuity: art").toBeGreaterThan(0);
    for (const id of ids) expect(posts.filter((p) => p.markdown.includes(`{{art:${id}}}`)).map((p) => p.slug), id).toHaveLength(1);
  });
});
