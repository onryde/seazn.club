// scripts/ci-docs-only.sh decides which lane a pull request is in — docs-only, content-only
// (help and blog articles and their pictures) or code — and so whether ci.yml's heavy jobs
// may skip. A wrong "code" costs one CI run; a wrong "docs-only" or "content-only" merges a
// red that the NEXT pull request inherits. So the cases that matter most here are the pairs
// that differ in one fact: the same docs path answered `docs` when no code names it and `code`
// when one does, and the same content path answered `content` alone and `code` beside one
// source file.
//
// Every fixture name carries a `zq` prefix: tracked code in the REAL repo is the
// search space when this runs in CI, so a realistic doc name in this file would
// turn that doc's real pull requests into "code".
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "ci-docs-only.sh");

let repo = "";
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ci-docs-only-"));
  git("init", "-q");
  // Code that reads one doc by file name and one by folder name — the two
  // shapes the repo's own tests use (contrast.test.ts, the lichess fixtures).
  write(
    "apps/web/src/__tests__/reader.test.ts",
    [
      `readFileSync(join(ROOT, "docs/specs/zq-read-by-name.md"));`,
      `const EVIDENCE = join(ROOT, "docs", "zq-evidence-folder");`,
      `// mentions the structural folders, which must not count: docs superpowers specs plans mockups .claude agents`,
    ].join("\n"),
  );
  // Code that reads one help article by file name, and mentions a section folder (not a file) of another.
  write(
    "apps/web/src/__tests__/content-reader.test.ts",
    [
      `readFileSync(join(HELP_ROOT, "zq-read-content.md"));`,
      `const SECTION = "zq-folder-named";`,
      `const PIC = "zq-read-picture.webp";`,
    ].join("\n"),
  );
  // Prose that names a doc does not read it, and neither does a help article that links another.
  write("docs/index.md", "See zq-prose-only.md and zq-new-plan.md.\n");
  write("apps/web/content/help/zq-sibling.md", "Links to zq-linked-article.md and zq-new-article.md.\n");
  write("apps/web/README.md", "readme\n");
  write("docs/specs/zq-read-by-name.md", "spec\n");
  git("add", "-A");
});
afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

const classify = (event: string, filesJson: string) => {
  const out = join(repo, "..", `${repo.split("/").pop()}-output`);
  writeFileSync(out, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, EVENT_NAME: event, CHANGED_FILES_JSON: filesJson, GITHUB_OUTPUT: out },
  });
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  rmSync(out, { force: true });
  return { status: r.status, lines, stdout: r.stdout + r.stderr };
};
type Lane = "docs" | "content" | "code";
const answer = (event: string, files: unknown): Lane => {
  const r = classify(event, typeof files === "string" ? files : JSON.stringify(files));
  // Exactly the two answers, in order, and exit 0: the answer drives CI, never the exit code.
  expect(r.status, r.stdout).toBe(0);
  expect(r.lines, r.stdout).toHaveLength(2);
  expect(r.lines[0], r.stdout).toMatch(/^code=(true|false)$/);
  expect(r.lines[1], r.stdout).toMatch(/^content=(true|false)$/);
  const code = r.lines[0] === "code=true";
  const content = r.lines[1] === "content=true";
  // content-only is a kind of "not docs-only": it must never read as docs-only AND content.
  expect(!content || code, `content=true needs code=true: ${r.lines.join(" ")}`).toBe(true);
  return !code ? "docs" : content ? "content" : "code";
};

describe("ci-docs-only.sh", () => {
  it("answers docs-only for new docs, mockups, agent files and root notes that no code names", () => {
    expect(
      answer("pull_request", [
        "docs/superpowers/plans/zq-new-plan.md",
        "mockups/zq-mock/zq.html",
        ".claude/agents/zq-agent.md",
        "ZQNOTES.md",
        "zq-scratch.txt",
      ]),
    ).toBe("docs");
    // A doc only PROSE names (docs/index.md) is still docs-only.
    expect(answer("pull_request", ["docs/superpowers/specs/zq-prose-only.md"])).toBe("docs");
  });

  it("answers code for a doc that tracked code reads, by file name or by folder name", () => {
    // Same shape as the docs-only case above; the one difference is the reader.
    expect(answer("pull_request", ["docs/specs/zq-read-by-name.md"])).toBe("code");
    expect(answer("pull_request", ["docs/zq-evidence-folder/deep/zq-new.json"])).toBe("code");
    // A rename arrives as both names (dorny splits it); the OLD one is still read.
    expect(answer("pull_request", ["docs/specs/zq-renamed.md", "docs/specs/zq-read-by-name.md"])).toBe("code");
  });

  it("answers code for any path outside the docs set, an .md inside a code tree included", () => {
    expect(answer("pull_request", ["apps/web/src/zq.ts"])).toBe("code");
    expect(answer("pull_request", ["apps/web/README.md"])).toBe("code");
    expect(answer("pull_request", ["docs/superpowers/plans/zq-new-plan.md", "package.json"])).toBe("code");
  });

  it("answers code whenever nothing proves docs-only: another event, an empty, unparsable or capped list", () => {
    expect(answer("push", ["docs/superpowers/plans/zq-new-plan.md"])).toBe("code");
    expect(answer("workflow_dispatch", ["docs/superpowers/plans/zq-new-plan.md"])).toBe("code");
    expect(answer("pull_request", [])).toBe("code");
    expect(answer("pull_request", "")).toBe("code");
    expect(answer("pull_request", "not json")).toBe("code");
    expect(answer("pull_request", { files: ["docs/a.md"] })).toBe("code");
    expect(answer("pull_request", [1, 2])).toBe("code");
    const capped = Array.from({ length: 3000 }, (_, i) => `docs/superpowers/plans/zq-${i}.md`);
    expect(answer("pull_request", capped)).toBe("code");
  });

  // ---- the content lane: help and blog articles, and the pictures they show ----------------

  it("answers content for help and blog articles and their pictures that no code names", () => {
    expect(answer("pull_request", ["apps/web/content/blog/zq-new-post.md"])).toBe("content");
    expect(answer("pull_request", ["apps/web/content/help/zq-section/zq-new-article.md"])).toBe("content");
    // A picture on its own, and a post with its pictures, are content too.
    expect(answer("pull_request", ["apps/web/public/help/zq-section/zq-pic.webp"])).toBe("content");
    expect(
      answer("pull_request", [
        "apps/web/content/blog/zq-new-post.md",
        "apps/web/public/help/blog/zq-new-post-1.webp",
        "apps/web/public/help/blog/zq-new-post-2.webp",
        "apps/web/content/help/zq-section/zq-new-article.md",
      ]),
    ).toBe("content");
    // A rename arrives as the old and the new name; neither is named by code.
    expect(answer("pull_request", ["apps/web/content/help/zq-a/zq-old.md", "apps/web/content/help/zq-b/zq-old.md"])).toBe("content");
  });

  it("answers code the moment one changed path is outside the content roots, however small the code change", () => {
    // The same content path, alone and beside one source file: the one difference is the file.
    expect(answer("pull_request", ["apps/web/content/blog/zq-new-post.md"])).toBe("content");
    expect(answer("pull_request", ["apps/web/content/blog/zq-new-post.md", "apps/web/src/zq.ts"])).toBe("code");
    expect(answer("pull_request", ["apps/web/content/help/zq-x.md", "apps/web/src/lib/zq.ts"])).toBe("code");
    // Beside a config file, a test, a workflow, a root manifest.
    for (const other of ["package.json", ".github/workflows/ci.yml", "scripts/zq.ts", "apps/web/e2e/zq.spec.ts", "db/migration/deltas/V1__zq.sql"]) {
      expect(answer("pull_request", ["apps/web/content/help/zq-x.md", other]), other).toBe("code");
    }
  });

  it("answers code for a path that only LOOKS like a content root", () => {
    // Each is one segment off a root: a sibling folder, a longer name, a different app, a different public folder.
    for (const near of [
      "apps/web/content/zq-x.md",
      "apps/web/content/helpful/zq-x.md",
      "apps/web/content/blogs/zq-x.md",
      "apps/web/content-extra/help/zq-x.md",
      "apps/web/public/helper/zq-x.webp",
      "apps/web/public/zq-x.webp",
      "apps/other/content/help/zq-x.md",
      "content/help/zq-x.md",
    ]) {
      expect(answer("pull_request", [near]), near).toBe("code");
    }
  });

  it("answers code for a content file that tracked code names by its file name, and content once nothing does", () => {
    // reader.test.ts reads zq-read-content.md and a picture by name: the same article path, with and without a reader.
    expect(answer("pull_request", ["apps/web/content/help/zq-section/zq-read-content.md"])).toBe("code");
    expect(answer("pull_request", ["apps/web/content/help/zq-section/zq-unread-content.md"])).toBe("content");
    expect(answer("pull_request", ["apps/web/public/help/zq-section/zq-read-picture.webp"])).toBe("code");
    expect(answer("pull_request", ["apps/web/public/help/zq-section/zq-unread-picture.webp"])).toBe("content");
    // One named file among unnamed ones is enough.
    expect(answer("pull_request", ["apps/web/content/blog/zq-new-post.md", "apps/web/content/help/zq-x/zq-read-content.md"])).toBe("code");
    // A rename away from a name code reads is still named: the OLD path arrives too.
    expect(answer("pull_request", ["apps/web/content/help/zq-x/zq-renamed.md", "apps/web/content/help/zq-x/zq-read-content.md"])).toBe("code");
  });

  it("does not search for a content file's FOLDER, nor count help prose that links it", () => {
    // `zq-folder-named` appears in tracked code, but only as a section folder: a section name (`billing`, `sports`)
    // names half the repo, so for content only the basename is looked up.
    expect(answer("pull_request", ["apps/web/content/help/zq-folder-named/zq-fresh.md"])).toBe("content");
    // zq-sibling.md (a help article) links zq-linked-article.md: an article naming an article reads nothing.
    expect(answer("pull_request", ["apps/web/content/help/zq-linked-article.md"])).toBe("content");
    // …whereas a DOCS folder that code names is still a reader (the docs rule is unchanged beside a content path).
    expect(answer("pull_request", ["docs/zq-evidence-folder/zq-new.json", "apps/web/content/help/zq-x.md"])).toBe("code");
  });

  it("a docs path beside a content path must pass the docs rule on its own", () => {
    expect(answer("pull_request", ["docs/superpowers/plans/zq-new-plan.md", "apps/web/content/blog/zq-new-post.md"])).toBe("content");
    expect(answer("pull_request", ["docs/specs/zq-read-by-name.md", "apps/web/content/blog/zq-new-post.md"])).toBe("code");
    expect(answer("pull_request", ["ZQNOTES.md", "apps/web/content/help/zq-x.md"])).toBe("content");
    // The docs-only answer is untouched beside all of this.
    expect(answer("pull_request", ["docs/superpowers/plans/zq-new-plan.md"])).toBe("docs");
  });

  it("answers code for a content change whenever nothing proves content-only: another event, an empty, unparsable or capped list", () => {
    const post = ["apps/web/content/blog/zq-new-post.md"];
    expect(answer("push", post)).toBe("code");
    expect(answer("workflow_dispatch", post)).toBe("code");
    expect(answer("pull_request", [])).toBe("code");
    expect(answer("pull_request", "not json")).toBe("code");
    expect(answer("pull_request", { files: post })).toBe("code");
    expect(answer("pull_request", [1])).toBe("code");
    const capped = Array.from({ length: 3000 }, (_, i) => `apps/web/content/blog/zq-${i}.md`);
    expect(answer("pull_request", capped)).toBe("code");
    // One short of the cap is judged on its paths: all content, none named.
    expect(answer("pull_request", capped.slice(0, 2999))).toBe("content");
  });

  it("answers code for a non-article, non-picture file dropped inside a content root, and content for its article and picture twins", () => {
    // The same folder, the same stem: the one difference is the extension. Each code answer has its content twin below it.
    const roots = ["apps/web/content/help/zq-section", "apps/web/content/blog", "apps/web/public/help/zq-section"];
    const notContent = ["zq-new.ts", "zq-new.tsx", "zq-new.json", "zq-new.mjs", "zq-new.svg", "zq-new.md.ts", "zq-new.webp.json", "zq-new", "zq-new.MD"];
    const content = ["zq-new.md", "zq-new.webp", "zq-new.png", "zq-new.jpg", "zq-new.jpeg", "zq-new.gif", "zq-new.avif"];
    let judged = 0;
    for (const root of roots) {
      for (const f of notContent) {
        expect(answer("pull_request", [`${root}/${f}`]), `${root}/${f}`).toBe("code");
        // …and beside a genuine article it still drags the whole change to code.
        expect(answer("pull_request", [`${root}/${f}`, "apps/web/content/blog/zq-new-post.md"]), `${root}/${f} beside an article`).toBe("code");
        judged += 2;
      }
      for (const f of content) {
        expect(answer("pull_request", [`${root}/${f}`]), `${root}/${f}`).toBe("content");
        judged++;
      }
    }
    expect(judged, "paths judged").toBe(roots.length * (notContent.length * 2 + content.length));
    // The named cases from the review: a .ts and a .json in the help root.
    expect(answer("pull_request", ["apps/web/content/help/zz.ts"])).toBe("code");
    expect(answer("pull_request", ["apps/web/content/help/zz.json"])).toBe("code");
  });

  it("recognises EVERY tracked help and blog file in the real repo as content (a sweep, with its count)", () => {
    // The fixture repo has no code that names them, so each real path must answer `content`; a path the
    // script misses as content (a renamed root, a new section kind) answers `code` and fails here.
    const root = join(import.meta.dirname, "../..");
    const tracked = spawnSync("git", ["ls-files", "-z", "--", "apps/web/content/help", "apps/web/content/blog", "apps/web/public/help"], { cwd: root, encoding: "utf8" })
      .stdout.split("\0")
      .filter(Boolean);
    expect(tracked.length, "tracked help/blog files").toBeGreaterThan(100);
    expect(tracked.some((f) => f.startsWith("apps/web/content/help/") && f.endsWith(".md")), "a help article").toBe(true);
    expect(tracked.some((f) => f.startsWith("apps/web/content/blog/") && f.endsWith(".md")), "a blog post").toBe(true);
    expect(tracked.some((f) => f.startsWith("apps/web/public/help/") && !f.endsWith(".md")), "a picture").toBe(true);
    // The fixture's own readers name `zq-*` only; a real file called like one would be a collision worth seeing.
    expect(tracked.filter((f) => /\/zq-/.test(f))).toEqual([]);
    expect(answer("pull_request", tracked)).toBe("content");
    // …and the same list with one source file added is code: the sweep above was not satisfied by a lenient script.
    expect(answer("pull_request", [...tracked, "apps/web/src/zq.ts"])).toBe("code");
  });
});
