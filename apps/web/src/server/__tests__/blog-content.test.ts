// The blog content layer over its fixture tree (blog/__tests__/fixtures/content): every front-matter rule in
// the design's table has a passing case (the four valid posts) and a failing case (one invalid post per rule,
// each carrying exactly ONE defect, so the problem list of the file must be exactly that rule's key).
// Anti-vacuity: each block reports how many fixtures it read, and zero fails.
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModules } from "@seazn/engine/sports";
import { describe, expect, it } from "vitest";
import { BLOG_TOPICS, blogUrl } from "@/lib/blog";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { allHelpArticles, parseHelpFrontmatter } from "@/server/help-content";
import {
  BlogFrontmatterError, PLAN_WORD, TYPED_FIGURE, allBlogPosts, blogPostsForHelp, blogRelatedProblems,
  blogSearchIndex, parseBlogFrontmatter,
} from "@/server/blog-content";

const FIXTURES = join(__dirname, "..", "..", "blog", "__tests__", "fixtures", "content");
const INVALID = join(FIXTURES, "invalid");
const mdFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const parse = (file: string, today?: string) => parseBlogFrontmatter(read(INVALID, file), `invalid/${file}`, { today });

/** file -> the one key it must fail on (the rule it exists for). */
const INVALID_CASES: Record<string, string> = {
  "title-no-question.md": "title",
  "title-missing.md": "title",
  "title-token.md": "title",
  "description-short.md": "description",
  "description-long.md": "description",
  "date-bad-format.md": "date",
  "date-impossible.md": "date",
  "date-future.md": "date",
  "updated-before-date.md": "updated",
  "updated-bad-format.md": "updated",
  "author-team.md": "author",
  "author-ana.md": "author",
  "author-empty.md": "author",
  "author-missing.md": "author",
  "topic-unknown.md": "topic",
  "sports-unknown.md": "sports",
  "sports-all-mixed.md": "sports",
  "help-unknown-article.md": "help",
  "help-unknown-family.md": "help",
  "related-one.md": "related",
  "related-five.md": "related",
  "related-self.md": "related",
  "related-duplicate.md": "related",
  "examples-empty.md": "examples",
  "examples-unused.md": "examples",
  "examples-undeclared.md": "examples",
  "examples-twice.md": "examples",
  "body-plan-token.md": "body",
  "body-typed-figure.md": "body",
  "body-stray-braces.md": "body",
  "body-fact-in-heading.md": "body",
  "body-inline-example.md": "body",
  "bad_slug.md": "slug",
};
// Invalid files that fail somewhere other than parseBlogFrontmatter's own problem list:
//   related-missing.md  needs the whole set (blogRelatedProblems), related-yaml-list.md is P1's parser's error.
const SET_OR_PARSER_CASES = ["related-missing.md", "related-yaml-list.md"];

function problemKeys(file: string, today?: string): string[] {
  try {
    parse(file, today);
  } catch (e) {
    // One defect can surface as two lines under the same key (an unlisted example is also an unplaced one).
    if (e instanceof BlogFrontmatterError) return [...new Set(e.problems.map((p) => p.key))];
    throw e;
  }
  return [];
}

describe("the fixture tree", () => {
  it("every invalid fixture on disk is accounted for, and none is missing", () => {
    const onDisk = mdFiles(INVALID);
    const claimed = [...Object.keys(INVALID_CASES), ...SET_OR_PARSER_CASES].sort();
    console.log(`blog-content: invalid fixtures on disk=${onDisk.length}, claimed=${claimed.length}`);
    expect(onDisk.length, "anti-vacuity: invalid fixtures read").toBeGreaterThan(0);
    expect(onDisk).toEqual(claimed);
  });
  it("reads the four valid posts", () => {
    const files = mdFiles(FIXTURES);
    console.log(`blog-content: valid fixtures=${files.length}`);
    expect(files.length, "anti-vacuity: valid fixtures read").toBeGreaterThanOrEqual(4);
  });
});

describe("parseBlogFrontmatter: passing cases", () => {
  it("accepts every valid fixture and returns the post as written", () => {
    const files = mdFiles(FIXTURES);
    expect(files.length, "anti-vacuity: valid fixtures read").toBeGreaterThan(0);
    for (const f of files) {
      const post = parseBlogFrontmatter(read(FIXTURES, f), f);
      expect(post.slug).toBe(f.replace(/\.md$/, ""));
      expect(post.author).toBe("Seazn");
      expect(post.markdown.length).toBeGreaterThan(0);
    }
  });
  it("parses the keys into their types: sports list vs 'all', updated, related and examples lists", () => {
    const swiss = parseBlogFrontmatter(read(FIXTURES, "how-swiss-pairs-round-two.md"), "how-swiss-pairs-round-two.md");
    expect(swiss.sports).toEqual(["boardgame", "badminton"]);
    expect(swiss.related).toEqual(["what-a-draw-is-worth", "who-wins-a-two-way-tie"]);
    expect(swiss.examples).toEqual(["swiss-round-two"]);
    expect(swiss.updated).toBeUndefined();
    const draw = parseBlogFrontmatter(read(FIXTURES, "what-a-draw-is-worth.md"), "what-a-draw-is-worth.md");
    expect(draw.sports).toBe("all");
    expect(draw.updated).toBe("2026-11-01");
  });
  it("accepts every sport the engine registry declares (the list comes from the registry, not this file)", () => {
    const keys = builtinModules.map((m) => m.key);
    expect(keys.length, "anti-vacuity: registry sports").toBeGreaterThan(0);
    const raw = read(FIXTURES, "how-swiss-pairs-round-two.md").replace(/^sports: .*$/m, `sports: ${keys.join(", ")}`);
    expect(parseBlogFrontmatter(raw, "how-swiss-pairs-round-two.md").sports).toEqual(keys);
  });
  it("accepts every topic in the closed set", () => {
    expect(BLOG_TOPICS.length).toBeGreaterThan(0);
    for (const t of BLOG_TOPICS) {
      const raw = read(FIXTURES, "how-swiss-pairs-round-two.md").replace(/^topic: .*$/m, `topic: ${t}`);
      expect(parseBlogFrontmatter(raw, "how-swiss-pairs-round-two.md").topic).toBe(t);
    }
  });
  it("accepts a help article, a registry-listed format family, and the format gallery", () => {
    expect(FORMAT_FAMILIES.length, "anti-vacuity: format families").toBeGreaterThan(0);
    let accepted = 0;
    for (const help of [
      "sports/football", "entrants/withdrawals", "formats/overview",
      ...FORMAT_FAMILIES.map((f) => `formats/${f.slug}`),
    ]) {
      const raw = read(FIXTURES, "how-swiss-pairs-round-two.md").replace(/^help: .*$/m, `help: ${help}`);
      expect(parseBlogFrontmatter(raw, "how-swiss-pairs-round-two.md").help).toBe(help);
      accepted += 1;
    }
    expect(accepted).toBeGreaterThan(FORMAT_FAMILIES.length);
  });
  it("a date of today is not in the future; the day before today is", () => {
    const raw = read(FIXTURES, "how-swiss-pairs-round-two.md");
    expect(parseBlogFrontmatter(raw, "how-swiss-pairs-round-two.md", { today: "2026-10-02" }).date).toBe("2026-10-02");
    expect(() => parseBlogFrontmatter(raw, "how-swiss-pairs-round-two.md", { today: "2026-10-01" })).toThrow(/'date'.*future/);
  });
  it("updated equal to date is fine", () => {
    const raw = read(FIXTURES, "how-swiss-pairs-round-two.md").replace(/^date: .*$/m, "date: 2026-10-02\nupdated: 2026-10-02");
    expect(parseBlogFrontmatter(raw, "x.md").updated).toBe("2026-10-02");
  });
  it("description length: both edges (50 and 160) pass, one off either side fails", () => {
    const withDescription = (n: number) =>
      read(FIXTURES, "how-swiss-pairs-round-two.md").replace(/^description: .*$/m, `description: ${"a".repeat(n)}`);
    for (const n of [50, 160]) expect(parseBlogFrontmatter(withDescription(n), "x.md").description).toHaveLength(n);
    for (const n of [49, 161]) expect(() => parseBlogFrontmatter(withDescription(n), "x.md")).toThrow(/'description'/);
  });
  it("related: 2 and 4 pass", () => {
    const withRelated = (list: string) => read(FIXTURES, "how-swiss-pairs-round-two.md").replace(/^related: .*$/m, `related: ${list}`);
    expect(parseBlogFrontmatter(withRelated("a-one, a-two"), "x.md").related).toHaveLength(2);
    expect(parseBlogFrontmatter(withRelated("a-one, a-two, a-three, a-four"), "x.md").related).toHaveLength(4);
  });
  it("a typed figure on a line that names no plan is fine", () => {
    const raw = read(FIXTURES, "how-swiss-pairs-round-two.md") + "\nA 5% swing in the vote.\n";
    expect(parseBlogFrontmatter(raw, "x.md").markdown).toContain("5%");
  });
  it("fact tokens and a standalone example token in the body pass", () => {
    const post = parseBlogFrontmatter(read(FIXTURES, "how-swiss-pairs-round-two.md"), "how-swiss-pairs-round-two.md");
    expect(post.markdown).toContain("{{fact:swiss-round-two.anaPoints}}");
    expect(post.markdown).toContain("{{example:swiss-round-two}}");
  });
});

describe("parseBlogFrontmatter: failing cases, one defect per fixture", () => {
  const entries = Object.entries(INVALID_CASES);
  it("reads the failing fixtures", () => {
    console.log(`blog-content: failing cases=${entries.length}`);
    expect(entries.length, "anti-vacuity: failing cases").toBeGreaterThan(0);
  });
  for (const [file, key] of entries) {
    it(`${file} fails on '${key}' alone, and the error names the file`, () => {
      expect(problemKeys(file)).toEqual([key]);
      expect(() => parse(file)).toThrow(new RegExp(`invalid/${file.replace(/\./g, "\\.")}: '${key}'`));
    });
  }
  it("a YAML list is refused by P1's parser, naming the file", () => {
    expect(() => parse("related-yaml-list.md")).toThrow(/invalid\/related-yaml-list\.md.*YAML list/);
  });
  it("author: 'Seazn Team', 'Ana' and an empty value each fail; 'Seazn' passes", () => {
    const base = read(FIXTURES, "how-swiss-pairs-round-two.md");
    for (const bad of ["Seazn Team", "Ana", "", "seazn", "Seazn "]) {
      const raw = base.replace(/^author: .*$/m, `author: ${bad}`);
      // "Seazn " is trimmed by the parser, so it is the one that PASSES here; asserted below.
      if (bad === "Seazn ") expect(parseBlogFrontmatter(raw, "x.md").author).toBe("Seazn");
      else expect(() => parseBlogFrontmatter(raw, "x.md"), `author '${bad}'`).toThrow(/'author'/);
    }
  });
  it("names the key AND the file for a missing required key (every key in the table)", () => {
    const base = read(FIXTURES, "how-swiss-pairs-round-two.md");
    const required = ["title", "description", "date", "author", "topic", "sports", "help", "related", "examples"];
    for (const key of required) {
      const raw = base.replace(new RegExp(`^${key}: .*\\n`, "m"), "");
      expect(() => parseBlogFrontmatter(raw, "where.md"), key).toThrow(new RegExp(`where\\.md: .*'${key}': is required`));
    }
  });
  it("collects every problem in a file, not only the first", () => {
    const raw = read(FIXTURES, "how-swiss-pairs-round-two.md")
      .replace(/^author: .*$/m, "author: Ana")
      .replace(/^topic: .*$/m, "topic: cooking");
    try {
      parseBlogFrontmatter(raw, "x.md");
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as BlogFrontmatterError).problems.map((p) => p.key).sort()).toEqual(["author", "topic"]);
    }
  });
  it("the plan-token fixture is refused for the token, not for something else", () => {
    expect(() => parse("body-plan-token.md")).toThrow(/\{\{plan:/);
  });
  it("the typed-figure fixture is refused for the figure and quotes the line", () => {
    expect(() => parse("body-typed-figure.md")).toThrow(/types a plan figure.*Community pays 5%/);
  });
});

describe("related: the set-level rule", () => {
  it("a related slug that is not a post is a problem; the fixture parses alone", () => {
    const missing = parse("related-missing.md");
    const valid = new Map(allBlogPosts(FIXTURES).map((p) => [p.slug, p]));
    expect(valid.size, "anti-vacuity: valid posts").toBeGreaterThan(0);
    expect(blogRelatedProblems(valid)).toEqual([]);
    const withBad = new Map(valid).set("related-missing", { ...missing, slug: "related-missing" });
    expect(blogRelatedProblems(withBad)).toEqual(["related-missing: related 'a-post-nobody-wrote' is not a post"]);
  });
  it("allBlogPosts throws when a post lists a post that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "blog-related-"));
    try {
      const files = mdFiles(FIXTURES);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) copyFileSync(join(FIXTURES, f), join(dir, f));
      writeFileSync(join(dir, "related-missing.md"), read(INVALID, "related-missing.md"));
      expect(() => allBlogPosts(dir)).toThrow(/related 'a-post-nobody-wrote' is not a post/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("allBlogPosts, blogPostsForHelp, blogSearchIndex over the fixtures", () => {
  const posts = allBlogPosts(FIXTURES);

  it("reads every valid fixture, newest first", () => {
    console.log(`blog-content: posts read=${posts.length}`);
    expect(posts.length, "anti-vacuity: posts read").toBe(mdFiles(FIXTURES).length);
    expect(posts.map((p) => p.slug)).toEqual([
      "what-happens-when-a-player-withdraws", // 2026-11-10
      "what-a-draw-is-worth", // 2026-10-15
      "how-swiss-pairs-round-two", // 2026-10-02
      "who-wins-a-two-way-tie", // 2026-09-20
    ]);
  });
  it("ignores the invalid/ folder and non-markdown files", () => {
    expect(posts.some((p) => p.slug.startsWith("title-") || p.slug === "bad_slug")).toBe(false);
  });
  it("blogPostsForHelp returns the posts whose help: names the slug, newest first", () => {
    expect(blogPostsForHelp("sports/football", posts).map((p) => p.slug)).toEqual(["what-a-draw-is-worth", "who-wins-a-two-way-tie"]);
    expect(blogPostsForHelp("formats/swiss", posts).map((p) => p.slug)).toEqual(["how-swiss-pairs-round-two"]);
    expect(blogPostsForHelp("entrants/withdrawals", posts).map((p) => p.slug)).toEqual(["what-happens-when-a-player-withdraws"]);
  });
  it("blogPostsForHelp returns [] for a slug no post names, including a real help article", () => {
    expect(allHelpArticles().has("billing/plans")).toBe(true);
    expect(blogPostsForHelp("billing/plans", posts)).toEqual([]);
    expect(blogPostsForHelp("not/a-slug", posts)).toEqual([]);
    expect(blogPostsForHelp("sports/football", [])).toEqual([]);
  });
  it("every post's help: resolves (the count is reported)", () => {
    const resolved = posts.filter((p) => blogPostsForHelp(p.help, posts).some((q) => q.slug === p.slug));
    console.log(`blog-content: help links resolved=${resolved.length}`);
    expect(resolved.length).toBe(posts.length);
  });
  it("blogSearchIndex: one row per post, section Blog, headings from the body, no token", async () => {
    const rows = await blogSearchIndex(posts);
    expect(rows.length, "anti-vacuity: rows").toBe(posts.length);
    for (const r of rows) {
      expect(r.section).toBe("Blog");
      expect(Object.keys(r).sort()).toEqual(["description", "headings", "section", "slug", "title"]);
      expect(JSON.stringify(r)).not.toContain("{{");
    }
    const swiss = rows.find((r) => r.slug === "how-swiss-pairs-round-two")!;
    expect(swiss.headings).toEqual(["How Seazn handles it"]);
    expect(swiss.title).toBe("How does a Swiss tournament pair the second round?");
  });
  it("blogSearchIndex of no posts is empty, not an error", async () => {
    expect(await blogSearchIndex([])).toEqual([]);
  });
  it("blogUrl", () => {
    expect(blogUrl("what-a-draw-is-worth")).toBe("/blog/what-a-draw-is-worth");
  });
});

describe("the typed-figure detector is P1's", () => {
  it("both patterns match the literals in P1's sweep test (no drift)", () => {
    const p1 = readFileSync(join(__dirname, "..", "..", "lib", "__tests__", "help-no-typed-plan-figures.test.ts"), "utf8");
    expect(p1).toContain(`const FIGURE = ${TYPED_FIGURE.toString()};`);
    expect(p1).toContain(`const PLAN_WORD = ${PLAN_WORD.toString()};`);
  });
  it("P1's parser is the one in use (a blog post's front-matter parses identically)", () => {
    const raw = read(FIXTURES, "what-a-draw-is-worth.md");
    expect(parseHelpFrontmatter(raw, "x").meta.author).toBe("Seazn");
  });
});
