// Pins the SHAPE of the help Markdown tree so content rewrites cannot silently
// break links: the files on disk match what allHelpArticles() serves, and every
// in-article link lands on an article, a format family, or a heading id the REAL
// renderer emits for the target article (renderHelpMarkdown, not a slug function
// retyped here). Deliberately NOT here (help-content.test.ts owns them):
// registry <-> disk in both directions, tip slugs, frontmatter + sanitized render.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ROOT, allHelpArticles, renderHelpMarkdown } from "@/server/help-content";
import { FORMAT_FAMILIES } from "@/config/format-gallery";

/**
 * Every .md under content/help, at ANY depth, straight from disk (independent of
 * the loader's two-level walk, so a mis-filed root-level or nested file shows).
 * Slug = path from the help root without ".md".
 */
function mdFilesOnDisk(dir: string = HELP_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdFilesOnDisk(full));
    else if (entry.name.endsWith(".md")) out.push(relative(HELP_ROOT, full).replace(/\.md$/, ""));
  }
  return out;
}

// Inline Markdown links: [text](target) or [text](target "title"). Images
// ("![alt](src)") are not navigation links, so a leading "!" is excluded from LINK
// and matched by IMAGE, so the two together can be reconciled with the raw count.
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

type Verdict =
  | "checked"
  | "skipped-non-help"
  | "skipped-generated"
  | "skipped-external"
  | "broken-form";

interface Classified {
  verdict: Verdict;
  /** Article slug the link points at ("" for /help itself), or "" for in-page. */
  slug?: string;
  /** Format family slug when the link is /help/formats/<x>. */
  family?: string;
  fragment?: string;
  reason?: string;
}

const FORMAT_SLUGS = new Set(FORMAT_FAMILIES.map((f) => f.slug));

function classify(target: string, self: string): Classified {
  const fragment = target.includes("#") ? target.slice(target.indexOf("#") + 1) : undefined;
  if (/^(https?:|mailto:)/i.test(target)) return { verdict: "skipped-external" };
  // Any other scheme renders with its href stripped (sanitiser protocols), so it is a dead link.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { verdict: "broken-form", reason: "unsupported scheme" };
  if (target.startsWith("#")) return { verdict: "checked", slug: self, fragment };
  // Relative ("plans.md", "../billing/plans", "billing/plans") is not a form the
  // site resolves: a help page is /help/<section>/<article>, links are absolute.
  if (!target.startsWith("/")) return { verdict: "broken-form", reason: "relative link (use /help/<section>/<article>)" };
  const path = target.split("#")[0]!.split("?")[0]!.replace(/\/+$/, "");
  if (path !== "/help" && !path.startsWith("/help/")) return { verdict: "skipped-non-help" };
  const slug = path.slice("/help/".length);
  if (path === "/help" || slug === "formats") return { verdict: "skipped-generated" };
  if (slug.startsWith("formats/")) return { verdict: "checked", family: slug.slice("formats/".length), fragment };
  return { verdict: "checked", slug, fragment };
}

/** Why a classified /help/formats/<family> link is broken, or null. Shared by the sweep and its own unit case. */
function familyProblem(c: Classified): string | null {
  if (c.family === undefined) return null;
  if (!FORMAT_SLUGS.has(c.family)) return `no format family '${c.family}'`;
  if (c.fragment !== undefined) return "a fragment on a generated format page cannot be verified";
  return null;
}

/** ids the real renderer puts on an article's headings. */
async function renderedIds(markdown: string): Promise<Set<string>> {
  const html = await renderHelpMarkdown(markdown);
  return new Set([...html.matchAll(/<h[23] id="([^"]*)"/g)].map((m) => m[1]!));
}

describe("help tree shape", () => {
  const articles = allHelpArticles();

  it("every Markdown file on disk, at any depth, is served, and nothing else is", () => {
    const onDisk = mdFilesOnDisk();
    expect(onDisk.length, "anti-vacuity: content/help has Markdown files").toBeGreaterThan(0);
    expect(articles.size, "allHelpArticles() size equals the .md files on disk").toBe(onDisk.length);
    expect([...articles.keys()].sort()).toEqual([...onDisk].sort());
  });

  it("every help link resolves: article, format family, and any #fragment is a real heading id", async () => {
    const broken: string[] = [];
    const tally: Record<Verdict, number> = {
      checked: 0, "skipped-non-help": 0, "skipped-generated": 0, "skipped-external": 0, "broken-form": 0,
    };
    let anchorsChecked = 0;
    let familiesChecked = 0;
    let images = 0;
    let rawLinkOccurrences = 0;
    const idsOf = new Map<string, Set<string>>(); // each target rendered once

    for (const a of articles.values()) {
      rawLinkOccurrences += (a.markdown.match(/\]\(/g) ?? []).length;
      images += [...a.markdown.matchAll(IMAGE)].length;
      for (const m of a.markdown.matchAll(LINK)) {
        const target = m[1]!;
        const c = classify(target, a.slug);
        tally[c.verdict] += 1;
        const where = `content/help/${a.slug}.md -> ${target}`;
        if (c.verdict === "broken-form") broken.push(`${where} (${c.reason})`);
        if (c.verdict !== "checked") continue;
        if (c.family !== undefined) {
          familiesChecked += 1;
          const problem = familyProblem(c);
          if (problem) broken.push(`${where} (${problem})`);
          continue;
        }
        const target_ = articles.get(c.slug!);
        if (!target_) {
          broken.push(`${where} (no article '${c.slug}')`);
          continue;
        }
        if (c.fragment === undefined) continue;
        if (!idsOf.has(target_.slug)) idsOf.set(target_.slug, await renderedIds(target_.markdown));
        anchorsChecked += 1;
        if (!idsOf.get(target_.slug)!.has(c.fragment)) {
          broken.push(`${where} (article '${target_.slug}' has no heading id '${c.fragment}')`);
        }
      }
    }
    // Reported so a run shows what was (and was not) examined.
    console.log(
      `help-tree-shape: ${articles.size} articles; links ${JSON.stringify(tally)}; images ${images}; ` +
        `anchors checked ${anchorsChecked}; format families checked ${familiesChecked}; rendered targets ${idsOf.size}`,
    );
    expect(tally.checked, "anti-vacuity: at least one article link was checked").toBeGreaterThan(0);
    expect(anchorsChecked, "anti-vacuity: at least one #fragment was checked").toBeGreaterThan(0);
    // Reconcile with a count that does not use LINK: a regex that stops matching a link form shows as a gap.
    const classified = Object.values(tally).reduce((s, n) => s + n, 0);
    expect(classified + images, "every '](' in the tree is classified as a link or an image").toBe(rawLinkOccurrences);
    expect(broken, `broken help links:\n${broken.join("\n")}`).toEqual([]);
  });

  it("a heading's id cannot depend on a plan figure (tokens resolve after ids are fixed by the text)", () => {
    const tokened = [...articles.values()].flatMap((a) =>
      a.markdown.split("\n").filter((l) => /^#{2,3}\s/.test(l) && l.includes("{{plan:")).map((l) => `${a.slug}: ${l}`),
    );
    expect(tokened, "an h2/h3 with a {{plan:...}} token would get a different id once resolved").toEqual([]);
  });

  // No article links to a /help/formats/<family> page today (only to /help/formats), so the sweep above checks
  // zero of them. The resolution is proven here instead, against the real registry, so a typo fails when one appears.
  it("a /help/formats/<family> link resolves against the format registry", () => {
    expect(FORMAT_FAMILIES.length, "anti-vacuity: the registry has families").toBeGreaterThan(0);
    for (const f of FORMAT_FAMILIES) {
      expect(familyProblem(classify(`/help/formats/${f.slug}`, "x/y")), f.slug).toBeNull();
    }
    expect(familyProblem(classify("/help/formats/not-a-family", "x/y"))).toMatch(/no format family/);
    expect(familyProblem(classify(`/help/formats/${FORMAT_FAMILIES[0]!.slug}#a`, "x/y"))).toMatch(/fragment/);
  });

  it("a relative link, or one with a scheme the site strips, is a broken form, not skipped", () => {
    for (const t of ["plans.md", "../billing/plans", "billing/plans#x", "javascript:alert(1)", "tel:+441"]) {
      expect(classify(t, "x/y").verdict, t).toBe("broken-form");
    }
    for (const t of ["https://example.com/a", "mailto:a@b.co"]) expect(classify(t, "x/y").verdict, t).toBe("skipped-external");
    expect(classify("/legal/terms", "x/y").verdict).toBe("skipped-non-help");
    expect(classify("#a", "x/y")).toMatchObject({ verdict: "checked", slug: "x/y", fragment: "a" });
  });
});
