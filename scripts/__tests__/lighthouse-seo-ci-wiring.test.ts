// The Lighthouse and blog SEO steps in ci.yml's smoke-e2e job (Blog P2 Task 13b) are only worth what their wiring is worth. Every
// part below, if lost, leaves a step that exits 0 having checked nothing:
//
//   * the Lighthouse run and the checker must share ONE output directory, or the checker reads an empty one (it then fails, but
//     for the wrong reason);
//   * the checker must keep its own floor of five pages (no `--min-pages` override), and Lighthouse must keep the mobile profile
//     and the pinned version the thresholds were measured with;
//   * the SEO step runs a file that SKIPS without BLOG_SEO_BASE, and a skip exits 0: only the report's pending count says it ran;
//   * neither step may carry an `if:` or `continue-on-error`, either of which turns a red into a green;
//   * both aim at the server the job's own "Start server" step boots (:3000), after it and after the smoke that proves it serves.
//
// The jobs' gating on `changes` is pinned by ci-gate-wiring.test.ts (smoke-e2e is in its GATED list), and the checker and the SEO
// rules have their own tests. Read from ci.yml's text, like the repo's other workflow guards: no YAML library is a root dependency.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

const LIGHTHOUSE = "Lighthouse (Accessibility, Best Practices and SEO must be 100; Performance is reported)";
const SEO = "Blog SEO (every post's JSON-LD, canonical and og tags; sitemap, feed and robots.txt)";
const PAGES = ["/blog", "/blog/level-on-points-who-finishes-higher", "/blog/swiss-chess-bye", "/help/divisions/settings", "/help/formats/swiss"];

/** The smoke job's text: from its `name:` to the next job's. */
function smokeJob(): string {
  const start = CI.indexOf("    name: Smoke — build + server + e2e");
  expect(start, "premise: the smoke job exists").toBeGreaterThan(-1);
  const next = CI.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? CI.slice(start) : CI.slice(start, start + 1 + next);
}

/** One step (`      - name: …` up to the next step or job-level key), comments dropped; null when absent. */
function step(job: string, name: string): string | null {
  const lines = job.split("\n");
  const i = lines.findIndex((l) => l === `      - name: ${name}`);
  if (i === -1) return null;
  let j = i + 1;
  while (j < lines.length && !/^ {6}- /.test(lines[j]!) && !/^ {4}\S/.test(lines[j]!)) j++;
  return lines.slice(i, j).filter((l) => !/^\s*#/.test(l)).join("\n");
}

const job = smokeJob();
const lh = step(job, LIGHTHOUSE);
const seo = step(job, SEO);
const at = (name: string): number => job.indexOf(`      - name: ${name}\n`);

describe("ci.yml smoke-e2e: the Lighthouse step", () => {
  it("exists, with no `if:` and no `continue-on-error` on either step", () => {
    expect(lh, LIGHTHOUSE).not.toBeNull();
    expect(seo, SEO).not.toBeNull();
    for (const s of [lh!, seo!]) {
      expect(s).not.toMatch(/^ {8}if:/m);
      expect(s).not.toMatch(/continue-on-error/);
    }
  });

  it("runs after the first server starts and after the smoke that proves it serves", () => {
    const order = ["Start server", "Run smoke test", LIGHTHOUSE, SEO].map(at);
    expect(order.every((x) => x > -1), `every step found: ${order.join(", ")}`).toBe(true);
    expect([...order].sort((a, b) => a - b), "in that order").toEqual(order);
  });

  it("pins Lighthouse 13.4.0, the mobile profile and the four categories, through npx (no new dependency)", () => {
    expect(lh).toMatch(/^ {10}LIGHTHOUSE_VERSION: "13\.4\.0"$/m);
    expect(lh).toContain('npx --yes "lighthouse@${LIGHTHOUSE_VERSION}"');
    expect(lh).toContain("--form-factor=mobile");
    expect(lh).toContain("--only-categories=performance,accessibility,best-practices,seo");
    expect(lh).toContain("--headless=new");
  });

  it("scores all five pages of the brief, on the job's own :3000 server, each fetched first", () => {
    const m = /pages="([^"]+)"/.exec(lh!);
    expect(m, "a pages list").not.toBeNull();
    expect(m![1]!.split(" ")).toEqual(PAGES);
    expect(lh).toContain('"http://localhost:3000$p"');
    expect(lh).not.toMatch(/localhost:300[12]/);
    expect(lh).toContain("-w '%{http_code}'");
  });

  it("the posts and help pages it names are real, so a rename fails HERE with the page's name, not as a 404 score in CI", () => {
    const slugs = PAGES.filter((p) => p.startsWith("/blog/")).map((p) => p.slice("/blog/".length));
    expect(slugs.length).toBe(2);
    for (const s of slugs) expect(existsSync(join(ROOT, "apps/web/content/blog", `${s}.md`)), `post ${s}`).toBe(true);
    expect(existsSync(join(ROOT, "apps/web/content/help/divisions/settings.md")), "help article divisions/settings").toBe(true);
    expect(readFileSync(join(ROOT, "apps/web/src/config/format-gallery.tsx"), "utf8")).toContain('slug: "swiss"');
  });

  it("writes every report to one directory and hands that directory to the checker, which keeps its own floor of five pages", () => {
    expect(lh).toContain('out="$RUNNER_TEMP/lighthouse"');
    expect(lh).toContain('--output-path="$out/page-$n.json"');
    expect(lh).toContain('node --experimental-strip-types scripts/lighthouse-check.ts --dir "$out"');
    expect(lh, "no --min-pages: the checker's own floor governs, so trimming the list fails").not.toContain("--min-pages");
    expect(existsSync(join(ROOT, "scripts/lighthouse-check.ts"))).toBe(true);
    expect(lh).toMatch(/exit "\$rc"/);
  });

  it("keeps the reports as an artifact even when the step is red", () => {
    const up = step(job, "Upload Lighthouse reports");
    expect(up).not.toBeNull();
    expect(up).toMatch(/if: always\(\)/);
    expect(up).toContain("path: ${{ runner.temp }}/lighthouse/*.json");
  });
});

describe("ci.yml smoke-e2e: the blog SEO step", () => {
  it("runs the live test file from apps/web, aimed at the :3000 server", () => {
    expect(seo).toMatch(/^ {8}working-directory: apps\/web$/m);
    expect(seo).toMatch(/^ {10}BLOG_SEO_BASE: http:\/\/localhost:3000$/m);
    expect(seo).toContain("npx vitest run src/blog/__tests__/blog-seo.live.test.ts");
    expect(existsSync(join(ROOT, "apps/web/src/blog/__tests__/blog-seo.live.test.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "apps/web/src/lib/blog-seo-check.ts"))).toBe(true);
  });

  it("judges the JSON report, not the exit code: exactly one test passed, none failed, none skipped", () => {
    expect(seo).toContain("--reporter=json");
    expect(seo).toContain(".numTotalTests == 1 and .numPassedTests == 1 and .numFailedTests == 0 and .numPendingTests == 0");
    expect(seo).toContain('endswith("/src/blog/__tests__/blog-seo.live.test.ts")');
  });

  it("the live file skips without BLOG_SEO_BASE (so the guard above is what makes a skip red)", () => {
    const src = readFileSync(join(ROOT, "apps/web/src/blog/__tests__/blog-seo.live.test.ts"), "utf8");
    expect(src).toContain("describe.skipIf(!BASE)");
    expect(src).toContain("process.env.BLOG_SEO_BASE");
    expect(src, "the loader is the source of the post list").toContain("allBlogPosts()");
  });
});
