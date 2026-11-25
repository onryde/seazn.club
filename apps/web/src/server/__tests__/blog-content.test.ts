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
  BLOG_PLANNED_SLUGS, BlogFrontmatterError, PLAN_WORD, blogHelpHref, blogNewestFirst, TYPED_FIGURE, allBlogPosts, blogPostsForHelp, blogRelatedProblems,
  blogSearchIndex, parseBlogFrontmatter,
} from "@/server/blog-content";

const FIXTURES = join(__dirname, "..", "..", "blog", "__tests__", "fixtures", "content");
const INVALID = join(FIXTURES, "invalid");
const mdFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const parse = (file: string, today?: string) => parseBlogFrontmatter(read(INVALID, file), `invalid/${file}`, { today });

/** file -> the one key it must fail on, and the message that says WHICH guard fired (so a neighbour sharing the key cannot cover for it). */
const INVALID_CASES: Record<string, [key: string, message: RegExp]> = {
  "title-no-question.md": ["title", /must be a question/],
  "title-missing.md": ["title", /is required/],
  "title-token.md": ["title", /must not carry a token/],
  "title-typed-figure.md": ["title", /types a plan figure/],
  "description-short.md": ["description", /must be 50 to 160 characters, is 31/],
  "description-long.md": ["description", /must be 50 to 160 characters, is 197/],
  "description-token.md": ["description", /must not carry a token/],
  "description-typed-figure.md": ["description", /types a plan figure/],
  "date-bad-format.md": ["date", /is not an ISO date/],
  "date-impossible.md": ["date", /is not an ISO date/],
  "date-future.md": ["date", /is in the future \(today is \d{4}-\d{2}-\d{2}, UTC\)/],
  "updated-before-date.md": ["updated", /is before 'date' \(2026-10-02\)/],
  "updated-bad-format.md": ["updated", /is not an ISO date/],
  "updated-future.md": ["updated", /is in the future/],
  "author-team.md": ["author", /must be exactly 'Seazn', is 'Seazn Team'/],
  "author-ana.md": ["author", /must be exactly 'Seazn', is 'Ana'/],
  "author-empty.md": ["author", /must be exactly 'Seazn', is ''/],
  "author-missing.md": ["author", /is required/],
  "topic-unknown.md": ["topic", /'cooking' is not one of/],
  "sports-unknown.md": ["sports", /'curling' is not a sport in the registry/],
  "sports-all-mixed.md": ["sports", /'all' must stand alone/],
  "sports-empty.md": ["sports", /is empty; write 'all' or sport keys/],
  "help-unknown-article.md": ["help", /'sports\/curling' is not a help article/],
  "help-unknown-family.md": ["help", /'formats\/nope' is not a help article/],
  "related-one.md": ["related", /lists 1 posts; it needs 2 to 4/],
  "related-five.md": ["related", /lists 5 posts; it needs 2 to 4/],
  "related-self.md": ["related", /lists the post itself/],
  "related-duplicate.md": ["related", /lists a post twice/],
  "related-bad-shape.md": ["related", /'Not A Slug' is not a post slug/],
  "examples-empty.md": ["examples", /is empty; every post carries at least one/],
  "examples-unused.md": ["examples", /example 'never-placed' is listed but the body never places it/],
  "examples-undeclared.md": ["examples", /the body uses example 'other-example', which 'examples' does not list/],
  "examples-twice.md": ["examples", /example 'swiss-round-two' is placed more than once/],
  "body-plan-token.md": ["body", /a \{\{plan:\.\.\.\}\} token/],
  "body-typed-figure.md": ["body", /types a plan figure/],
  "body-stray-braces.md": ["body", /'\{\{score\}\} in the end\.\n?' is not a fact token or an example token/],
  "body-fact-in-heading.md": ["body", /a heading carries a token/],
  "body-inline-example.md": ["body", /an example token must stand alone on its own line/],
  "body-fenced-code.md": ["body", /a fenced code block; posts carry no code/],
  "bad_slug.md": ["slug", /must be lowercase words joined by hyphens/],
};
// Invalid files that fail somewhere other than parseBlogFrontmatter's own problem list:
//   related-missing.md  needs the whole set (blogRelatedProblems), related-yaml-list.md is P1's parser's error.
const SET_OR_PARSER_CASES = ["related-missing.md", "related-yaml-list.md"];

function problemsOf(file: string): { key: string; message: string }[] {
  try {
    parse(file);
  } catch (e) {
    if (e instanceof BlogFrontmatterError) return e.problems;
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

// `seoTitle` is the optional short title for the page's <title> alone (a question can run past what a search result
// shows). It is typed here as the rule: at most 65 characters, plain words, no plan figure.
describe("parseBlogFrontmatter: the optional search title", () => {
  const withSeo = (value: string) => read(FIXTURES, "how-swiss-pairs-round-two.md").replace(/^title: .*$/m, (line) => `${line}\nseoTitle: ${value}`);
  const seoProblems = (value: string): string[] => {
    try {
      parseBlogFrontmatter(withSeo(value), "content/blog/how-swiss-pairs-round-two.md");
      return [];
    } catch (e) {
      if (!(e instanceof BlogFrontmatterError)) throw e;
      return e.problems.map((p) => `${p.key}: ${p.message}`);
    }
  };

  it("is read as written, up to 65 characters; a post without one carries no key", () => {
    const longest = "S".repeat(65);
    expect(parseBlogFrontmatter(withSeo("Swiss round two pairing"), "content/blog/how-swiss-pairs-round-two.md").seoTitle).toBe("Swiss round two pairing");
    expect(parseBlogFrontmatter(withSeo(longest), "content/blog/how-swiss-pairs-round-two.md").seoTitle).toBe(longest);
    const plain = parseBlogFrontmatter(read(FIXTURES, "how-swiss-pairs-round-two.md"), "content/blog/how-swiss-pairs-round-two.md");
    expect("seoTitle" in plain).toBe(false);
  });

  it("is refused when it is too long, empty, carries a token or types a plan figure", () => {
    expect(seoProblems("S".repeat(66))).toEqual(["seoTitle: must be 1 to 65 characters, is 66"]);
    expect(seoProblems("")).toEqual(["seoTitle: must be 1 to 65 characters, is 0"]);
    expect(seoProblems("Pairing {{fact:a.b}}")).toEqual(["seoTitle: must not carry a token (front-matter is never resolved)"]);
    expect(seoProblems("Pro takes 5% of a fee").join()).toMatch(/^seoTitle: line 1 types a plan figure/);
  });
});

describe("parseBlogFrontmatter: failing cases, one defect per fixture", () => {
  const entries = Object.entries(INVALID_CASES);
  it("reads the failing fixtures", () => {
    console.log(`blog-content: failing cases=${entries.length}`);
    expect(entries.length, "anti-vacuity: failing cases").toBeGreaterThan(0);
  });
  for (const [file, [key, message]] of entries) {
    it(`${file} fails on exactly one problem: '${key}', and the error names the file`, () => {
      const problems = problemsOf(file);
      expect(problems.map((p) => p.key), "a single-defect fixture raises one problem").toEqual([key]);
      expect(problems[0]!.message).toMatch(message);
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

describe("related: slugs planned but not yet written", () => {
  it("a planned slug is accepted by the set-level rule, an unplanned unknown one still is not", () => {
    const missing = parse("related-missing.md");
    const valid = new Map(allBlogPosts(FIXTURES).map((p) => [p.slug, p]));
    const withBad = new Map(valid).set("related-missing", { ...missing, slug: "related-missing" });
    expect(blogRelatedProblems(withBad, new Set(["a-post-nobody-wrote"]))).toEqual([]);
    expect(blogRelatedProblems(withBad, new Set(["something-else"]))).toEqual(["related-missing: related 'a-post-nobody-wrote' is not a post"]);
    // A post cannot be related to itself even when its own slug is planned.
    const self = new Map(valid).set("related-self", { ...parse("related-missing.md"), slug: "related-self", related: ["related-self", "how-swiss-pairs-round-two"] });
    expect(blogRelatedProblems(self, new Set(["related-self"]))).toEqual(["related-self: related 'related-self' is the post itself"]);
  });
  it("the planned list is the approved topic list: kebab slugs, none already written, and posts written plus planned always make the programme's 33", () => {
    // The 33 is the programme's approved topic count (an input, not read from the code under test). The planned list
    // shrinks as each batch lands, so no remainder is typed here: written + planned is the invariant.
    const written = allBlogPosts();
    expect(BLOG_PLANNED_SLUGS.size, "anti-vacuity: planned slugs").toBeGreaterThan(0);
    expect(written.length, "anti-vacuity: written posts").toBeGreaterThan(0);
    expect(written.filter((p) => BLOG_PLANNED_SLUGS.has(p.slug)).map((p) => p.slug), "a written post is no longer planned").toEqual([]);
    // Streaming guides are outside the programme's list (2026-11-25), so they are not counted into its 33.
    const programme = written.filter((p) => p.topic !== "streaming");
    expect(programme.length + BLOG_PLANNED_SLUGS.size, "posts written plus planned").toBe(33);
    for (const s of BLOG_PLANNED_SLUGS) expect(s, s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(BLOG_PLANNED_SLUGS.has("how-standings-points-work"), "the pilot is a post, not planned").toBe(false);
  });
  it("an explicit root is strict: only the default root accepts planned slugs", () => {
    const dir = mkdtempSync(join(tmpdir(), "blog-planned-"));
    try {
      for (const f of mdFiles(FIXTURES)) copyFileSync(join(FIXTURES, f), join(dir, f));
      // Two slugs from the planned list as it stands (the list shrinks as posts land, so none is named here).
      const [first, second] = [...BLOG_PLANNED_SLUGS];
      expect(BLOG_PLANNED_SLUGS.size, "anti-vacuity: planned slugs").toBeGreaterThanOrEqual(2);
      const raw = read(FIXTURES, mdFiles(FIXTURES)[0]!).replace(/^related: .*$/m, `related: ${first}, ${second}`);
      writeFileSync(join(dir, mdFiles(FIXTURES)[0]!), raw);
      expect(BLOG_PLANNED_SLUGS.has(first!)).toBe(true);
      expect(() => allBlogPosts(dir)).toThrow(new RegExp(`related '${first}' is not a post`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("blogHelpHref: the help link is null-safe", () => {
  it("a registered article and a format family link; an unregistered one is null, never a dead link", () => {
    expect(blogHelpHref("divisions/settings")).toBe("/help/divisions/settings");
    expect(blogHelpHref("formats/swiss")).toBe("/help/formats/swiss");
    expect(blogHelpHref("formats/overview")).toBe("/help/formats");
    expect(blogHelpHref("sports/curling")).toBeNull();
    expect(blogHelpHref("")).toBeNull();
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
  it("two posts on the same day sort by slug whichever way round they arrive", () => {
    const a = { date: "2026-10-15", slug: "what-a-bye-is-worth" };
    const b = { date: "2026-10-15", slug: "what-a-draw-is-worth" };
    const c = { date: "2026-10-16", slug: "zzz" };
    expect([b, a].sort(blogNewestFirst)).toEqual([a, b]);
    expect([a, b].sort(blogNewestFirst)).toEqual([a, b]);
    expect([a, c, b].sort(blogNewestFirst)).toEqual([c, a, b]);
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
