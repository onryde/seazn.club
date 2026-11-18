// Pins the SHAPE of the help Markdown tree so content rewrites cannot silently
// break links: the files on disk match what allHelpArticles() serves, and every
// in-article link that targets a Markdown help article lands on one.
// Deliberately NOT here (help-content.test.ts owns them): registry <-> disk in
// both directions, tip slugs, frontmatter + sanitized render.
// Anchors (#fragment) are out of scope: the renderer emits no heading ids yet.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ROOT, allHelpArticles } from "@/server/help-content";

/** Count .md files straight from disk (independent of the code under test). */
function mdFilesOnDisk(): string[] {
  const out: string[] = [];
  for (const section of readdirSync(HELP_ROOT, { withFileTypes: true })) {
    if (!section.isDirectory()) continue;
    for (const f of readdirSync(join(HELP_ROOT, section.name))) {
      if (f.endsWith(".md")) out.push(`${section.name}/${f.replace(/\.md$/, "")}`);
    }
  }
  return out;
}

// Inline Markdown links: [text](target) or [text](target "title"). Images
// ("![alt](src)") are not navigation links, so a leading "!" is excluded.
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

type Verdict = "checked" | "skipped-non-help" | "skipped-generated" | "skipped-fragment-only" | "skipped-external";

function classify(target: string, articles: Map<string, unknown>): { verdict: Verdict; slug?: string } {
  if (/^(https?:|mailto:)/i.test(target)) return { verdict: "skipped-external" };
  if (target.startsWith("#")) return { verdict: "skipped-fragment-only" };
  const path = target.split("#")[0]!.split("?")[0]!.replace(/\/+$/, "");
  if (path !== "/help" && !path.startsWith("/help/")) return { verdict: "skipped-non-help" };
  const slug = path.slice("/help/".length);
  // /help itself and /help/formats/* are generated from the engine registry
  // (lib/help.ts VIRTUAL + helpUrl), not Markdown articles.
  if (path === "/help" || slug === "formats" || slug.startsWith("formats/")) {
    return articles.has(slug) ? { verdict: "checked", slug } : { verdict: "skipped-generated" };
  }
  return { verdict: "checked", slug };
}

describe("help tree shape", () => {
  const articles = allHelpArticles();

  it("every Markdown file on disk is served, and nothing else is", () => {
    const onDisk = mdFilesOnDisk();
    expect(onDisk.length, "anti-vacuity: content/help has Markdown files").toBeGreaterThan(0);
    expect(articles.size, "allHelpArticles() size equals the .md files on disk").toBe(onDisk.length);
    expect([...articles.keys()].sort()).toEqual([...onDisk].sort());
  });

  it("every article-level help link resolves to an existing article", () => {
    const broken: string[] = [];
    const tally: Record<Verdict, number> = {
      checked: 0, "skipped-non-help": 0, "skipped-generated": 0, "skipped-fragment-only": 0, "skipped-external": 0,
    };
    for (const a of articles.values()) {
      for (const m of a.markdown.matchAll(LINK)) {
        const target = m[1]!;
        const { verdict, slug } = classify(target, articles);
        tally[verdict] += 1;
        if (verdict === "checked" && !articles.has(slug!)) {
          broken.push(`content/help/${a.slug}.md -> ${target} (no article '${slug}')`);
        }
      }
    }
    // Reported so a run shows what was (and was not) examined.
    console.log(`help-tree-shape: ${articles.size} articles; links ${JSON.stringify(tally)}`);
    expect(tally.checked, "anti-vacuity: at least one article link was checked").toBeGreaterThan(0);
    expect(broken, `broken help links:\n${broken.join("\n")}`).toEqual([]);
  });
});
