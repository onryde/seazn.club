// renderBlogPost: fact tokens resolve first, then the body splits at `{{example:<id>}}` lines, and each Markdown
// segment goes through P1's help renderer. The example part carries the GOLDEN's result, never build()'s.
import { describe, expect, it } from "vitest";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";
import { renderBlogPost } from "@/server/blog-render";

const RESULT: ExampleResult = {
  facts: { ana: 3, bye: "½", label: "Chess" },
  table: { caption: "A table", columns: ["Sport", "Points"], rows: [["Chess", "½"]] },
  text: ["Ana won."],
};
const GOLDENS = { one: RESULT, two: { facts: { n: 2 }, text: [] } } as Record<string, ExampleResult>;

const post = (markdown: string, examples = ["one"], slug = "a-post") => ({ slug, markdown, examples });

describe("fact tokens", () => {
  it("a fact token resolves to the golden's value, a number or a string, before Markdown is rendered", async () => {
    const out = await renderBlogPost(post("Ana finishes on {{fact:one.ana}} points and **{{fact:one.bye}}** for a draw.\n\n{{example:one}}\n"), GOLDENS);
    const html = out.parts.filter((p) => p.kind === "html").map((p) => (p as { html: string }).html).join("");
    expect(html).toContain("Ana finishes on 3 points");
    expect(html).toContain("<strong>½</strong>");
    expect(html).not.toContain("{{");
  });

  it("an unknown token throws, naming it (unknown example, unknown key, an example the post does not list)", async () => {
    await expect(renderBlogPost(post("x {{fact:nope.ana}}\n\n{{example:one}}"), GOLDENS)).rejects.toThrow(/fact:nope\.ana/);
    await expect(renderBlogPost(post("x {{fact:one.missing}}\n\n{{example:one}}"), GOLDENS)).rejects.toThrow(/fact:one\.missing/);
    await expect(renderBlogPost(post("x {{fact:two.n}}\n\n{{example:one}}"), GOLDENS)).rejects.toThrow(/fact:two\.n.*does not list/);
  });

  it("a fact that resolves to an empty string is refused rather than printed as a hole", async () => {
    const g = { one: { ...RESULT, facts: { blank: "" } } } as Record<string, ExampleResult>;
    await expect(renderBlogPost(post("x {{fact:one.blank}}\n\n{{example:one}}"), g)).rejects.toThrow(/fact:one\.blank/);
  });

  it("two tokens in one line, and the same token twice, both resolve", async () => {
    const out = await renderBlogPost(post("{{fact:one.ana}} and {{fact:one.ana}} and {{fact:one.label}}\n\n{{example:one}}"), GOLDENS);
    const html = (out.parts[0] as { html: string }).html;
    expect(html).toContain("3 and 3 and Chess");
  });
});

describe("example tokens", () => {
  it("a token alone on a line becomes an example part, in order, carrying the golden's result", async () => {
    const out = await renderBlogPost(post("Before.\n\n{{example:one}}\n\nBetween.\n\n{{example:two}}\n\nAfter.\n", ["one", "two"]), GOLDENS);
    expect(out.parts.map((p) => (p.kind === "example" ? `example:${p.id}` : "html"))).toEqual(["html", "example:one", "html", "example:two", "html"]);
    const first = out.parts[1];
    expect(first?.kind === "example" && first.result).toEqual(RESULT);
    expect(first?.kind === "example" && first.result).toBe(RESULT);
  });

  it("the result comes from the golden: the real registry's pilot is the committed file", async () => {
    const out = await renderBlogPost(post("Intro.\n\n{{example:standings-points}}\n", ["standings-points"]));
    const part = out.parts.find((p) => p.kind === "example");
    expect(part?.kind === "example" && part.result).toBe(BLOG_GOLDENS["standings-points"]);
  });

  it("an example token inside a paragraph is refused", async () => {
    await expect(renderBlogPost(post("Look at {{example:one}} here.\n\n{{example:one}}"), GOLDENS)).rejects.toThrow(/must stand alone/);
  });

  it("an example with no golden, or one the post does not list, throws naming it", async () => {
    await expect(renderBlogPost(post("{{example:ghost}}", ["ghost"]), GOLDENS)).rejects.toThrow(/ghost/);
    await expect(renderBlogPost(post("{{example:two}}\n\n{{example:one}}", ["one"]), GOLDENS)).rejects.toThrow(/two.*does not list/);
    await expect(renderBlogPost(post("{{example:one}}", ["one", "two"]), GOLDENS)).rejects.toThrow(/two.*never places/);
  });

  it("a post with no example token fails", async () => {
    await expect(renderBlogPost(post("Just words.\n", []), GOLDENS)).rejects.toThrow(/no example/);
  });

  it("the same example placed twice is refused", async () => {
    await expect(renderBlogPost(post("{{example:one}}\n\nx\n\n{{example:one}}"), GOLDENS)).rejects.toThrow(/more than once/);
  });
});

describe("headings", () => {
  it("are collected across segments, in order, with unique ids", async () => {
    const out = await renderBlogPost(post("## First\n\nText.\n\n{{example:one}}\n\n## Second\n\nMore.\n"), GOLDENS);
    expect(out.headings.map((h) => h.text)).toEqual(["First", "Second"]);
    const ids = out.headings.map((h) => h.id);
    expect(ids.length, "anti-vacuity: headings").toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the same heading text in two segments would repeat an id, so it throws naming the id", async () => {
    await expect(renderBlogPost(post("## How it works\n\nA.\n\n{{example:one}}\n\n## How it works\n\nB.\n"), GOLDENS)).rejects.toThrow(/duplicate heading id 'how-it-works'/);
  });

  it("any brace pair left after resolution throws, whatever its shape (a typo'd token never reaches a reader as text)", async () => {
    for (const bad of ["{{fact one.ana}}", "{{facts:one.ana}}", "{{ fact:one.ana }}", "{{example}}", "{{}}"]) {
      await expect(renderBlogPost(post(`A ${bad} figure.\n\n{{example:one}}`), GOLDENS), bad).rejects.toThrow(/left unresolved/);
    }
    // ...and the same text without braces renders.
    await expect(renderBlogPost(post("A fact one.ana figure.\n\n{{example:one}}"), GOLDENS)).resolves.toBeDefined();
  });

  it("a plan token never renders (a post states no plan figure): the renderer refuses rather than loading a matrix", async () => {
    await expect(renderBlogPost(post("A {{plan:billing:pro}} figure.\n\n{{example:one}}"), GOLDENS)).rejects.toThrow(/plan/);
  });
});

describe("callouts and pictures go through P1's pipeline", () => {
  it("a callout in a segment renders as a callout", async () => {
    const out = await renderBlogPost(post("> **Note**\n> Draws stand in football.\n\n{{example:one}}\n"), GOLDENS);
    const html = (out.parts[0] as { html: string }).html;
    expect(html).toContain('role="note"');
    expect(html).toContain('data-kind="note"');
    expect(html).toContain("Draws stand in football.");
  });
});

// A post's scrolling boxes come from the SAME pipeline as help's (help-scroll-boxes.ts): a table in a body is wrapped in
// a focusable, named region (the blog's own example table draws its own, in blog-example-table.tsx). A post carries no
// code block (the content layer refuses a fence), so the table is the one prose scroller a post can have.
describe("a prose table in a post is a focusable, named scroll region", () => {
  const TABLE = "| Team | Points |\n| --- | --- |\n| Ana | 3 |\n| Ben | 1 |\n";

  it("each table in each segment is wrapped, and the text round it is not", async () => {
    const out = await renderBlogPost(post(`Before.\n\n${TABLE}\n{{example:one}}\n\nAfter.\n\n${TABLE}`), GOLDENS);
    const html = out.parts.flatMap((p) => (p.kind === "html" ? [p.html] : []));
    expect(html.length, "anti-vacuity: two html segments").toBe(2);
    for (const part of html) {
      expect(part.match(/<table>/g)?.length, "anti-vacuity: the segment has a table").toBe(1);
      expect(part).toMatch(/<div class="help-scroll" tabindex="0" role="region" aria-label="Table"><table>/);
      expect(part).toMatch(/<\/table><\/div>/);
    }
    expect(html[0]).toMatch(/<p>Before\.<\/p>\s*<div class="help-scroll"/);
  });

  it("a post with no table carries none of it (the empty case)", async () => {
    const out = await renderBlogPost(post("Just words.\n\n{{example:one}}\n"), GOLDENS);
    const html = (out.parts[0] as { html: string }).html;
    expect(html).toContain("Just words.");
    expect(html).not.toMatch(/tabindex|role=|aria-label|help-scroll/);
  });
});
