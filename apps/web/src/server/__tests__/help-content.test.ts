// The stale-doc gate (v3/06 §3, v3/11 gap 14): the Markdown on disk, the
// client-safe slug registry in lib/help.ts, the Tips deep-links and the
// feature-area sections must all agree — a feature area or tip cannot ship
// without its /help article, and a deleted article cannot leave dead links.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import FlexSearch from "flexsearch";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import {
  HELP_SECTIONS, allHelpArticles, helpNav, helpPlainText, renderHelpMarkdown,
} from "@/server/help-content";
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
