// The help renderer's prose scrollers: a code block and a table that does not fit both scroll sideways, and a
// scrolling region owes a tab stop, a role and a name (AGENTS.md class 23; axe's `scrollable-region-focusable`).
// The sanitiser drops every author-written `tabindex`, `role` and `aria-label`, so the renderer adds them AFTER
// it (help-scroll-boxes.ts): nothing an author types can name them, and every scroller carries ours.
//
// What is pinned here: the attributes on every `<pre>`, the wrapper (never the `<table>` itself: a role on the
// table would turn its rows into orphans) on every table, the empty case, the second call, a scroller inside a
// callout and a list, the author's attributes staying out, every shipped article, and the focus ring.
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import rehypeSanitize from "rehype-sanitize";
import type { Element, Root } from "hast";
import { HELP_SCHEMA, allHelpArticles, renderHelpMarkdown } from "@/server/help-content";
import { cascadeWinner, declaredValue, parseCss, readGlobalsCss } from "@/components/v2/scorepad/v3/__tests__/_globals-css";

const CODE = "```json\n{ \"kind\": \"knockout\", \"seeding\": \"by-rank\" }\n```\n";
const TABLE = "| Plan | Fee |\n| --- | --- |\n| Community | 5% |\n| Pro | 3% |\n";

/** Every attribute of one opening tag, name to value. */
function attrsOf(openTag: string): Record<string, string> {
  return Object.fromEntries([...openTag.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

/** The opening tags of one element, in document order. */
const openTags = (html: string, tag: string): string[] => [...html.matchAll(new RegExp(`<${tag}(?=[\\s>])[^>]*>`, "g"))].map((m) => m[0]);

/** The wrapper's opening tag when `<table` is its first child, else null. */
const wrapperOf = (html: string): string[] =>
  [...html.matchAll(/(<div[^>]*>)<table(?=[\s>])/g)].map((m) => m[1]!);

const REGION = { tabindex: "0", role: "region" };

describe("a code block", () => {
  it("carries a tab stop, the region role and a name", async () => {
    const html = await renderHelpMarkdown(CODE);
    const pres = openTags(html, "pre");
    expect(pres.length, "anti-vacuity: the block rendered a pre").toBe(1);
    expect(attrsOf(pres[0]!)).toEqual({ ...REGION, "aria-label": "Code example" });
    expect(html, "the code stays inside the pre").toContain('"kind": "knockout"');
  });

  it("two blocks both carry them (the second is not skipped)", async () => {
    const html = await renderHelpMarkdown(`${CODE}\nBetween.\n\n${CODE}`);
    const pres = openTags(html, "pre");
    expect(pres.length).toBe(2);
    for (const pre of pres) expect(attrsOf(pre)).toEqual({ ...REGION, "aria-label": "Code example" });
  });

  it("an INLINE code span is not a scroller and carries none of it", async () => {
    const html = await renderHelpMarkdown("Set `kind` to `knockout`.\n");
    expect(openTags(html, "code").length, "anti-vacuity: the spans rendered").toBe(2);
    expect(html).not.toMatch(/tabindex|role=|aria-label|<pre/);
  });
});

describe("a table", () => {
  it("sits in a labelled, focusable region; the table keeps its own semantics", async () => {
    const html = await renderHelpMarkdown(TABLE);
    const tables = openTags(html, "table");
    expect(tables.length, "anti-vacuity: the table rendered").toBe(1);
    const wrappers = wrapperOf(html);
    expect(wrappers.length, "the table's parent is the wrapper").toBe(1);
    expect(attrsOf(wrappers[0]!)).toEqual({ class: "help-scroll", ...REGION, "aria-label": "Table" });
    // A role on the table itself would replace `table`, and its rows would have no table to be rows of.
    expect(tables[0], "the <table> is untouched").toBe("<table>");
    expect(html).toMatch(/^<div[^>]*><table>[\s\S]*<\/table><\/div>\s*$/);
  });

  it("two tables each get a wrapper, and the text around them is outside it", async () => {
    const html = await renderHelpMarkdown(`Before.\n\n${TABLE}\nMiddle.\n\n${TABLE}\nAfter.\n`);
    expect(openTags(html, "table").length).toBe(2);
    expect(wrapperOf(html).length).toBe(2);
    expect(html.match(/<\/table><\/div>/g)?.length).toBe(2);
    expect(html).toMatch(/<p>Before\.<\/p>\s*<div/);
    expect(html).toMatch(/<\/div>\s*<p>Middle\.<\/p>/);
  });
});

describe("the empty case and the sequence", () => {
  it("a page with neither adds nothing: no tab stop, no region, no wrapper", async () => {
    const html = await renderHelpMarkdown("## Title\n\nJust a paragraph with `inline` code and a [link](https://example.com).\n");
    expect(html.length, "anti-vacuity: it rendered").toBeGreaterThan(0);
    expect(html).not.toMatch(/tabindex|role=|aria-label|help-scroll|<div/);
  });

  it("the same page rendered twice gives the same HTML (no state kept between calls)", async () => {
    const md = `${CODE}\n${TABLE}`;
    const first = await renderHelpMarkdown(md);
    const second = await renderHelpMarkdown(md);
    expect(first).toBe(second);
    expect(openTags(first, "pre").length + wrapperOf(first).length, "anti-vacuity").toBe(2);
  });

  it("a scroller inside a callout and inside a list item is reached too", async () => {
    const callout = await renderHelpMarkdown(`> **Note**\n>\n> \`\`\`json\n> { "a": 1 }\n> \`\`\`\n>\n> | A | B |\n> | - | - |\n> | 1 | 2 |\n`);
    expect(callout).toContain('<div role="note"');
    expect(openTags(callout, "pre").length).toBe(1);
    expect(attrsOf(openTags(callout, "pre")[0]!)).toMatchObject({ ...REGION, "aria-label": "Code example" });
    expect(wrapperOf(callout).length).toBe(1);

    const list = await renderHelpMarkdown(`1. Step one\n\n   ${TABLE.split("\n").join("\n   ")}\n2. Step two\n\n   \`\`\`\n   code\n   \`\`\`\n`);
    expect(openTags(list, "pre").length, "anti-vacuity: the list's block rendered").toBe(1);
    expect(attrsOf(openTags(list, "pre")[0]!)).toMatchObject({ ...REGION, "aria-label": "Code example" });
    expect(wrapperOf(list).length, "the list's table is wrapped").toBe(1);
  });
});

describe("an author cannot name a tab stop, a role or a name", () => {
  const TAGS = ["pre", "table", "code", "p", "div"] as const;

  it("the sanitiser keeps none of tabindex, role and aria-label on any element it allows", async () => {
    const tree: Root = {
      type: "root",
      children: TAGS.map((tagName) => ({
        type: "element" as const,
        tagName,
        properties: { tabIndex: 5, role: "button", ariaLabel: "evil", ariaHidden: "true" },
        children: [{ type: "text" as const, value: "x" }],
      })),
    };
    const clean = (await unified().use(rehypeSanitize, HELP_SCHEMA).run(tree)) as Root;
    const kept = clean.children.filter((c): c is Element => c.type === "element");
    expect(kept.map((k) => k.tagName), "anti-vacuity: the allowed elements survived (a div is not allowed)").toEqual(["pre", "table", "code", "p"]);
    for (const el of kept) {
      for (const k of ["tabIndex", "role", "ariaLabel", "ariaHidden"]) expect(el.properties, `${el.tagName} ${k}`).not.toHaveProperty(k);
    }
  });

  it("raw HTML naming them yields none of the author's values, and no author-written scroller", async () => {
    const html = await renderHelpMarkdown(
      '<pre tabindex="5" role="button" aria-label="evil">x</pre>\n\n<table tabindex="7" role="grid" aria-label="evil2"><tr><td>x</td></tr></table>\n\n<div tabindex="9" role="region">y</div>\n\nplain\n',
    );
    expect(html).toContain("plain");
    expect(html).not.toMatch(/evil|tabindex="[579]"|role="(button|grid)"|<div/);
  });

  it("our attributes win over any that reached the tree", async () => {
    const { rehypeHelpScrollBoxes } = await import("@/server/help-scroll-boxes");
    const tree: Root = {
      type: "root",
      children: [
        { type: "element", tagName: "pre", properties: { tabIndex: 5, role: "button", ariaLabel: "evil" }, children: [] },
        { type: "element", tagName: "table", properties: { tabIndex: 7, role: "grid" }, children: [] },
      ],
    };
    rehypeHelpScrollBoxes()(tree);
    const [pre, wrap] = tree.children as Element[];
    expect(pre!.properties).toMatchObject({ tabIndex: 0, role: "region", ariaLabel: "Code example" });
    expect(wrap!.tagName).toBe("div");
    expect(wrap!.properties).toMatchObject({ tabIndex: 0, role: "region", ariaLabel: "Table", className: ["help-scroll"] });
    const table = wrap!.children[0] as Element;
    expect(table.tagName).toBe("table");
    expect(table.properties, "the table keeps what it had; the wrapper carries ours").toMatchObject({ tabIndex: 7, role: "grid" });
  });
});

describe("every shipped help article", () => {
  it("every <pre> is a labelled tab stop and every <table> sits in one", async () => {
    let articles = 0;
    let pres = 0;
    let tables = 0;
    const bad: string[] = [];
    // A Map: `.values()`, because iterating it bare yields [slug, article] pairs and renders nothing.
    for (const a of allHelpArticles().values()) {
      const html = await renderHelpMarkdown(a.markdown);
      articles += 1;
      for (const pre of openTags(html, "pre")) {
        pres += 1;
        const at = attrsOf(pre);
        if (at.tabindex !== "0" || at.role !== "region" || at["aria-label"] !== "Code example") bad.push(`${a.slug}: ${pre}`);
      }
      const wrapped = wrapperOf(html);
      tables += openTags(html, "table").length;
      for (const w of wrapped) {
        const at = attrsOf(w);
        if (at.tabindex !== "0" || at.role !== "region" || at["aria-label"] !== "Table" || at.class !== "help-scroll") bad.push(`${a.slug}: ${w}`);
      }
      if (wrapped.length !== openTags(html, "table").length) bad.push(`${a.slug}: ${openTags(html, "table").length} tables, ${wrapped.length} wrapped`);
    }
    // Anti-vacuity: the sweep saw real scrollers. groups-to-knockout carries a JSON block; many articles carry a table.
    expect(articles, "articles rendered").toBeGreaterThan(50);
    expect(pres, "code blocks seen").toBeGreaterThan(0);
    expect(tables, "tables seen").toBeGreaterThan(10);
    expect(bad).toEqual([]);
  }, 120_000);
});

describe("the focus ring", () => {
  const rules = parseCss(readGlobalsCss());
  const prose = { tag: "div", classes: ["competition-prose", "help-prose"] } as const;

  it("a focused code block and a focused wrapper both draw the platform accent ring", () => {
    const focused = [
      { tag: "pre", classes: [], attrs: { tabindex: "0", role: "region" }, pseudo: ["focus-visible"] },
      { tag: "div", classes: ["help-scroll"], attrs: { tabindex: "0", role: "region" }, pseudo: ["focus-visible"] },
    ];
    for (const el of focused) {
      const winner = cascadeWinner(rules, "outline-color", el, [prose], { conditions: () => false });
      expect(winner, `${el.tag}: a focus ring rule applies`).toBeDefined();
      expect(declaredValue(winner!, "outline-color"), el.tag).toBe("var(--ps-accent)");
    }
    expect(focused.length, "anti-vacuity").toBe(2);
  });
});
