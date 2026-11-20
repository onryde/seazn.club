// Pins the SHAPE of the help Markdown tree so content rewrites cannot silently
// break links: the files on disk match what allHelpArticles() serves, and every
// in-article link lands on an article, a format family, or a heading id the REAL
// renderer emits for the target article (renderHelpMarkdown, not a slug function
// retyped here). Deliberately NOT here (help-content.test.ts owns them):
// registry <-> disk in both directions, tip slugs, frontmatter + sanitized render.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_ROOT, allHelpArticles, helpHeadings, renderHelpMarkdown } from "@/server/help-content";
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

/** ids the real renderer puts on an article's headings (the renderer's own heading list, not a regex over its HTML). */
async function renderedIds(markdown: string): Promise<Set<string>> {
  return new Set((await helpHeadings(markdown)).map((h) => h.id));
}

interface SweepArticle {
  slug: string;
  markdown: string;
}

interface LinkSweep {
  broken: string[];
  tally: Record<Verdict, number>;
  anchorsChecked: number;
  familiesChecked: number;
  images: number;
  rawLinkOccurrences: number;
  renderedTargets: number;
}

/**
 * The link sweep as a function of the articles it is given, so the real tree AND a fixture run the same body:
 * a branch that no real link exercises yet (a /help/formats/<family> link) is proven on the fixture, not skipped.
 */
async function sweepLinks(articles: ReadonlyMap<string, SweepArticle>): Promise<LinkSweep> {
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
  return { broken, tally, anchorsChecked, familiesChecked, images, rawLinkOccurrences, renderedTargets: idsOf.size };
}

interface PictureSweep {
  /** Pictures found in the Markdown source (`![alt](src)`). */
  checked: number;
  problems: string[];
}

/**
 * Renders every article through the real renderer and reconciles the pictures written with the figures produced. A refusal
 * (missing file, empty alt, over budget, not webp, external src) throws inside the renderer and is reported against its article.
 * Zero pictures is a legitimate answer while no page carries one; that case is proven on fixtures, below.
 */
async function sweepPictures(articles: ReadonlyMap<string, SweepArticle>, publicRoot?: string): Promise<PictureSweep> {
  let checked = 0;
  const problems: string[] = [];
  for (const a of articles.values()) {
    const written = [...a.markdown.matchAll(IMAGE)].length;
    checked += written;
    try {
      const html = await renderHelpMarkdown(a.markdown, undefined, { publicRoot });
      const figures = (html.match(/<figure>/g) ?? []).length;
      if (figures !== written) problems.push(`content/help/${a.slug}.md: ${written} picture(s) written, ${figures} figure(s) rendered`);
    } catch (e) {
      problems.push(`content/help/${a.slug}.md: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked, problems };
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
    const r = await sweepLinks(articles);
    // Reported so a run shows what was (and was not) examined.
    console.log(
      `help-tree-shape: ${articles.size} articles; links ${JSON.stringify(r.tally)}; images ${r.images}; ` +
        `anchors checked ${r.anchorsChecked}; format families checked ${r.familiesChecked}; rendered targets ${r.renderedTargets}`,
    );
    expect(r.tally.checked, "anti-vacuity: at least one article link was checked").toBeGreaterThan(0);
    expect(r.anchorsChecked, "anti-vacuity: at least one #fragment was checked").toBeGreaterThan(0);
    // Reconcile with a count that does not use LINK: a regex that stops matching a link form shows as a gap.
    const classified = Object.values(r.tally).reduce((n, c) => n + c, 0);
    expect(classified + r.images, "every '](' in the tree is classified as a link or an image").toBe(r.rawLinkOccurrences);
    expect(r.broken, `broken help links:\n${r.broken.join("\n")}`).toEqual([]);
  });

  // No article links to a /help/formats/<family> page today (only to /help/formats), so the real sweep checks zero of them.
  // The same sweep body is run on a fixture holding a good link and a typo'd one, so that branch has a witness.
  it("the link sweep catches a typo'd /help/formats/<family> link and passes a good one (fixture, same body)", async () => {
    const good = FORMAT_FAMILIES[0]!.slug;
    const fixture = new Map<string, SweepArticle>([
      ["fx/good", { slug: "fx/good", markdown: `See [the format](/help/formats/${good}).\n` }],
      ["fx/typo", { slug: "fx/typo", markdown: `See [the format](/help/formats/${good}x) and [again](/help/formats/${good}).\n` }],
      ["fx/anchor", { slug: "fx/anchor", markdown: "Go to [below](#real-heading) or [missing](#not-there).\n\n## Real heading\n" }],
    ]);
    const r = await sweepLinks(fixture);
    expect(r.familiesChecked, "anti-vacuity: the family branch ran on every family link").toBe(3);
    expect(r.anchorsChecked).toBe(2);
    expect(r.broken).toHaveLength(2);
    expect(r.broken.some((b) => b.includes("fx/typo.md") && b.includes(`/help/formats/${good}x`) && /no format family/.test(b))).toBe(true);
    expect(r.broken.some((b) => b.includes("fx/anchor.md") && b.includes("#not-there") && /no heading id 'not-there'/.test(b))).toBe(true);
    expect(r.broken.some((b) => b.includes("fx/good.md")), "the good link is not reported").toBe(false);
  });

  // Pictures: no help page carries one yet, so the real tree checks zero. That is a legitimate answer, stated here, and the
  // sweep body is proven on fixtures: a good picture, a missing file, an empty alt, and the empty tree.
  describe("pictures", () => {
    const FIXTURE_ROOT = join(__dirname, "fixtures", "help-public");
    const GOOD = "/help/sample/screen-1.webp";
    const fixture = (...pages: [string, string][]) =>
      new Map<string, SweepArticle>(pages.map(([slug, markdown]) => [slug, { slug, markdown }]));

    it("every picture written in the real tree renders as a figure (zero is reported, not hidden)", async () => {
      const r = await sweepPictures(articles);
      console.log(`help-tree-shape: pictures checked ${r.checked}${r.checked === 0 ? " (no help page carries a picture yet; the sweep body is proven on fixtures)" : ""}`);
      expect(r.problems, `picture problems:\n${r.problems.join("\n")}`).toEqual([]);
    });

    it("counts and passes a good picture; reports a missing file and an empty alt against their article", async () => {
      const ok = await sweepPictures(fixture(["fx/ok", `![The board](${GOOD} "Caption")\n`]), FIXTURE_ROOT);
      expect(ok).toEqual({ checked: 1, problems: [] });

      const bad = await sweepPictures(
        fixture(
          ["fx/missing", "![Gone](/help/sample/gone.webp)\n"],
          ["fx/noalt", `![](${GOOD})\n`],
          ["fx/ok", `![The board](${GOOD})\n`],
        ),
        FIXTURE_ROOT,
      );
      expect(bad.checked).toBe(3);
      expect(bad.problems).toHaveLength(2);
      expect(bad.problems.find((p) => p.includes("fx/missing.md"))).toMatch(/not found/);
      expect(bad.problems.find((p) => p.includes("fx/noalt.md"))).toMatch(/alt text/);
    });

    it("an article with no picture, and an empty tree, check zero and report nothing", async () => {
      expect(await sweepPictures(fixture(["fx/text", "Just words.\n"]), FIXTURE_ROOT)).toEqual({ checked: 0, problems: [] });
      expect(await sweepPictures(new Map(), FIXTURE_ROOT)).toEqual({ checked: 0, problems: [] });
    });
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
