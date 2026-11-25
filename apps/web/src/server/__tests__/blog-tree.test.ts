// The real tree: every file in content/blog, held to the design's rules. Each block reports how many posts (or
// strings) it checked, and zero checked is a failure. The fixture tree in blog/__tests__/fixtures is the
// content layer's own test; this one runs over what ships.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { BLOG_ART } from "@/blog/art";
import { BLOG_EXAMPLES } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import { blogLeakText, findBlogLeaks, withoutDiagramKind } from "@/blog/leaks";
import { BLOG_ROOT, BLOG_PLANNED_SLUGS, allBlogPosts, blogHelpHref, type BlogPost } from "@/server/blog-content";
import { renderBlogPost } from "@/server/blog-render";
import { allHelpArticles } from "@/server/help-content";

const posts: BlogPost[] = allBlogPosts();
const EXAMPLE_LINE = /^\{\{example:([a-z0-9-]+)\}\}$/;
const ART_TOKEN = /\{\{art:([a-z0-9-]+)\}\}/g;
/** The names of the pictures a post places from the art registry (blog-art.test.tsx holds their files). */
const artAlts = (p: BlogPost): string[] => [...p.markdown.matchAll(ART_TOKEN)].map((m) => BLOG_ART[m[1]!]!.alt);
const FACT = /\{\{fact:([a-z0-9-]+)\.([A-Za-z0-9_]+)\}\}/g;

/** Every string anywhere in an example's generated result (table, diagram, text, facts): a leaf-walk, so no field is skipped. */
function leaves(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (v === null || typeof v !== "object") return v === undefined ? [] : [String(v)];
  return Object.values(v as Record<string, unknown>).flatMap(leaves);
}
// The diagram's `kind` names the drawing component (`swissRound`), never a word a reader sees: left out of the scan, every other string stays in.
const exampleStrings = (id: string): string[] => leaves(withoutDiagramKind(BLOG_GOLDENS[id]!));

describe("the tree", () => {
  it("every file in content/blog parses (allBlogPosts throws on one that does not), and the folder is not empty", () => {
    const files = readdirSync(BLOG_ROOT).filter((f) => f.endsWith(".md"));
    expect(files.length, "anti-vacuity: post files").toBeGreaterThan(0);
    expect(posts.map((p) => `${p.slug}.md`).sort()).toEqual(files.sort());
    expect(readdirSync(BLOG_ROOT).filter((f) => !f.endsWith(".md")), "nothing but posts in the folder").toEqual([]);
  });

  it("every post passes the leak scan: title, description, body, resolved fact values, and its examples' text, captions and cells", () => {
    let scanned = 0;
    const leaks: string[] = [];
    for (const p of posts) {
      const strings = [
        p.title,
        p.description,
        blogLeakText(p.markdown),
        ...artAlts(p),
        // fact values as the reader sees them, resolved
        ...[...p.markdown.matchAll(FACT)].map(([, id, key]) => String(BLOG_GOLDENS[id!]!.facts[key!])),
        ...p.examples.flatMap(exampleStrings),
      ];
      for (const s of strings) {
        scanned++;
        for (const l of findBlogLeaks(s)) leaks.push(`${p.slug}: ${l.rule} '${l.match}'`);
      }
    }
    expect(scanned, "anti-vacuity: strings scanned").toBeGreaterThan(50);
    expect(leaks).toEqual([]);
  });

  it("`examples:` equals the example tokens in the body (as a set, each once), and the facts a post cites come from its own examples", () => {
    let checked = 0;
    for (const p of posts) {
      const placed = p.markdown.split("\n").map((l) => EXAMPLE_LINE.exec(l.trim())?.[1]).filter((x): x is string => x !== undefined);
      expect([...placed].sort(), p.slug).toEqual([...p.examples].sort());
      expect(new Set(placed).size, `${p.slug}: placed twice`).toBe(placed.length);
      for (const [, id, key] of p.markdown.matchAll(FACT)) {
        expect(p.examples, `${p.slug}: fact ${id}.${key}`).toContain(id);
        expect(BLOG_GOLDENS[id!]!.facts, `${p.slug}: fact ${id}.${key} exists`).toHaveProperty(key!);
      }
      checked++;
    }
    expect(checked, "posts checked").toBe(posts.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every registered example is used by exactly one post, and every example a post lists is registered", () => {
    const registered = BLOG_EXAMPLES.map((e) => e.id);
    expect(registered.length, "anti-vacuity: examples").toBeGreaterThan(0);
    for (const id of registered) expect(posts.filter((p) => p.examples.includes(id)).map((p) => p.slug), `example ${id}`).toHaveLength(1);
    for (const p of posts) for (const id of p.examples) expect(registered, `${p.slug} lists ${id}`).toContain(id);
  });

  it("every `related` resolves to a post, or to a post still to be written (and no planned slug is already a post)", () => {
    const slugs = new Set(posts.map((p) => p.slug));
    let related = 0;
    let pending = 0;
    for (const p of posts)
      for (const r of p.related) {
        related++;
        if (slugs.has(r)) continue;
        expect(BLOG_PLANNED_SLUGS.has(r), `${p.slug} relates to '${r}', which is neither a post nor planned`).toBe(true);
        pending++;
      }
    expect(related, "related links checked").toBeGreaterThan(0);
    // The programme is 33 posts: those written plus those planned (Task 14 deletes the planned list when the last lands).
    // Streaming guides are outside that list (2026-11-25), so they are not counted into its 33.
    expect(posts.filter((p) => p.topic !== "streaming").length + BLOG_PLANNED_SLUGS.size, "posts + planned slugs").toBe(33);
    expect(pending, "of which still to be written").toBeLessThanOrEqual(related);
    const stale = [...BLOG_PLANNED_SLUGS].filter((s) => slugs.has(s));
    expect(stale, "a planned slug that is now a post must come off the planned list").toEqual([]);
  });

  it("every `help` resolves: an article that exists or a format family, through the null-safe link", () => {
    let checked = 0;
    for (const p of posts) {
      const href = blogHelpHref(p.help);
      expect(href, `${p.slug}: help '${p.help}' has a link`).not.toBeNull();
      const family = p.help.startsWith("formats/") && (p.help === "formats/overview" || FORMAT_FAMILIES.some((f) => `formats/${f.slug}` === p.help));
      expect(allHelpArticles().has(p.help) || family, `${p.slug}: help '${p.help}'`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a post carries no section of its own that the page renders from front matter (\"How Seazn handles it\") and no typed /help link to its own help page", () => {
    let checked = 0;
    for (const p of posts) {
      expect(p.markdown, `${p.slug}: its own How Seazn handles it`).not.toMatch(/^#{1,6}\s+How Seazn handles it\s*$/im);
      const own = blogHelpHref(p.help);
      expect(own, p.slug).not.toBeNull();
      expect(p.markdown.includes(`](${own})`), `${p.slug}: a typed link to ${own}`).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("every post has an example (a generated table or diagram) or a picture", () => {
    let withExample = 0;
    for (const p of posts) {
      const hasExample = p.examples.some((id) => BLOG_GOLDENS[id]?.table !== undefined || BLOG_GOLDENS[id]?.diagram !== undefined);
      const hasPicture = /!\[[^\]]*\]\(\/help\/blog\/[^)]+\)/.test(p.markdown);
      expect(hasExample || hasPicture || artAlts(p).length > 0, `${p.slug}: no generated table, diagram or picture`).toBe(true);
      if (hasExample) withExample++;
    }
    expect(withExample, "posts with a generated example").toBeGreaterThan(0);
  });

  it("only a streaming guide may stand on art alone: every other post lists a worked example", () => {
    const bare = posts.filter((p) => p.examples.length === 0);
    console.log(`blog-tree: posts with no worked example=${bare.length} of ${posts.length}`);
    expect(bare.length, "anti-vacuity: art-only posts seen").toBeGreaterThan(0);
    for (const p of bare) expect(p.topic, p.slug).toBe("streaming");
  });

  // Brief gate 4: every post owes one diagram OR screenshot, and a table does not count as one. A picture is a generated
  // diagram (an example of the post whose result carries a `diagram`, which the page draws), a `/help/blog/` screenshot, or
  // a drawing from the art registry.
  it("every post carries a picture besides its table: a generated diagram, a /help/blog/ screenshot or art", () => {
    const SCREENSHOT = /!\[[^\]]*\]\(\/help\/blog\/[^)]+\)/g;
    let checked = 0;
    let diagrams = 0;
    let screenshots = 0;
    const without: string[] = [];
    for (const p of posts) {
      const drawn = p.examples.filter((id) => BLOG_GOLDENS[id]?.diagram !== undefined).length;
      const shots = (p.markdown.match(SCREENSHOT) ?? []).length;
      diagrams += drawn;
      screenshots += shots;
      if (drawn + shots + artAlts(p).length === 0) without.push(p.slug);
      checked++;
    }
    expect(checked, "anti-vacuity: posts checked").toBe(posts.length);
    expect(checked, "anti-vacuity: posts checked").toBeGreaterThan(0);
    // Both kinds are in the tree today, so a reader that stopped seeing one of them would show here instead of passing.
    expect(diagrams, "anti-vacuity: generated diagrams seen").toBeGreaterThan(0);
    expect(screenshots, "anti-vacuity: screenshots seen").toBeGreaterThan(0);
    expect(without, `posts with neither a generated diagram nor a /help/blog/ picture (a table alone is not one), of ${checked} checked`).toEqual([]);
  });

  it("every post renders end to end: fact tokens resolved, one example part per listed example, one art part per art line, no brace left in the HTML", async () => {
    let parts = 0;
    for (const p of posts) {
      const out = await renderBlogPost(p);
      const examples = out.parts.filter((x) => x.kind === "example");
      expect(examples.map((x) => (x.kind === "example" ? x.id : "")).sort(), p.slug).toEqual([...p.examples].sort());
      expect(out.parts.filter((x) => x.kind === "art"), `${p.slug}: art parts`).toHaveLength(artAlts(p).length);
      for (const part of out.parts) {
        parts++;
        if (part.kind === "html") expect(part.html, p.slug).not.toContain("{{");
      }
      expect(out.headings.length, `${p.slug}: headings`).toBeGreaterThan(0);
    }
    expect(parts, "parts rendered").toBeGreaterThan(0);
  });

  it("a post names the author Seazn and no post file is a draft marker", () => {
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p.author, p.slug).toBe("Seazn");
    expect(join(BLOG_ROOT)).toMatch(/content[\\/]blog$/);
  });
});
