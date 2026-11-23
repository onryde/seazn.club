// scripts/lighthouse-check.ts decides ci.yml's Lighthouse step (smoke-e2e): Accessibility, Best Practices and SEO must be
// 100 on every page, Performance is reported and never gates, and a run that scored fewer than five pages, or lost a
// category, is a failure rather than a pass on nothing.
//
// Driven over two REAL Lighthouse 13.4.0 reports (Blog P2 Task 13, trimmed to the fields the checker reads: the blog index,
// whose three gated categories are 100, and /help/formats/swiss, whose Accessibility was 99) and through the real CLI
// (node --experimental-strip-types), so the exit code and the job summary are what the workflow sees. Expected values are
// the rulebook's (the brief: 100, five pages, four categories), never read back from the module.
//
// Single-sport reason: no sport is involved; this is CI tooling.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluate, summaryMarkdown, type Report } from "../lighthouse-check.ts";

const FIX = join(import.meta.dirname, "fixtures", "lighthouse");
const SCRIPT = join(import.meta.dirname, "..", "lighthouse-check.ts");
/** The slice of a Lighthouse report the tests reach into. */
interface Lhr {
  requestedUrl: string;
  finalUrl: string;
  finalDisplayedUrl: string;
  configSettings: { formFactor: string };
  categories: Record<string, { score: number | null }>;
  runtimeError?: unknown;
}
const real = (name: string): Lhr => JSON.parse(readFileSync(join(FIX, name), "utf8")) as Lhr;

const PAGES = ["/blog", "/blog/level-on-points-who-finishes-higher", "/blog/swiss-chess-bye", "/help/divisions/settings", "/help/formats/swiss"];
const GATED = ["accessibility", "best-practices", "seo"];
const ALL = ["performance", ...GATED];

/** The real passing report, re-pointed at `path`, with category scores overridden (0..1; undefined deletes the category). */
function report(path: string, scores: Record<string, number | null | undefined> = {}): Report {
  const j = real("blog-index.json");
  for (const u of ["requestedUrl", "finalUrl", "finalDisplayedUrl"] as const) j[u] = `http://localhost:3000${path}`;
  for (const [cat, s] of Object.entries(scores)) {
    if (s === undefined) delete j.categories[cat];
    else j.categories[cat].score = s;
  }
  return { file: `${path.replace(/\//g, "_")}.json`, json: j };
}
const fivePasses = (): Report[] => PAGES.map((p) => report(p));

describe("the two real fixtures say what the brief says they say (premise)", () => {
  it("blog-index.json: gated categories 100, performance not; the swiss report has accessibility 99", () => {
    const pct = (l: Lhr, cat: string): number => Math.round((l.categories[cat]?.score ?? Number.NaN) * 100);
    const blog = real("blog-index.json"), swiss = real("help-formats-swiss-a11y-99.json");
    expect(GATED.map((c) => pct(blog, c))).toEqual([100, 100, 100]);
    expect(pct(blog, "performance")).toBeLessThan(90);
    expect(pct(swiss, "accessibility")).toBe(99);
  });
});

describe("evaluate: Accessibility, Best Practices and SEO must be 100 on every page", () => {
  it("five pages at 100/100/100 pass, with Performance as low as it likes", () => {
    const v = evaluate(PAGES.map((p) => report(p, { performance: 0.12 })));
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.pagesScored).toBe(5);
    expect(v.rows.map((r) => r.scores.performance)).toEqual([12, 12, 12, 12, 12]);
  });

  it("the real /help/formats/swiss report (accessibility 99) fails, and names the page and the category", () => {
    const v = evaluate([...fivePasses().slice(0, 4), { file: "formats.json", json: real("help-formats-swiss-a11y-99.json") }]);
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain("/help/formats/swiss");
    expect(v.problems[0]).toContain("accessibility");
    expect(v.problems[0]).toContain("99");
  });

  it("each gated category at 99 fails, on whichever page carries it (every category x every page)", () => {
    let cases = 0;
    for (const cat of GATED) {
      for (const bad of PAGES) {
        const v = evaluate(PAGES.map((p) => report(p, p === bad ? { [cat]: 0.99 } : {})));
        expect(v.ok, `${cat} 99 on ${bad}`).toBe(false);
        expect(v.problems, `${cat} 99 on ${bad}`).toHaveLength(1);
        expect(v.problems[0]).toContain(cat);
        expect(v.problems[0]).toContain(bad);
        cases++;
      }
    }
    expect(cases, "anti-vacuity: cases run").toBe(GATED.length * PAGES.length);
  });

  it("a gated category at exactly 100 passes; one at 0 fails", () => {
    expect(evaluate(PAGES.map((p) => report(p, { seo: 1 }))).ok).toBe(true);
    expect(evaluate(PAGES.map((p) => report(p, { seo: 0 }))).ok).toBe(false);
  });

  it("Performance never gates: 0 on every page passes, and is still reported", () => {
    const v = evaluate(PAGES.map((p) => report(p, { performance: 0 })));
    expect(v.ok).toBe(true);
    expect(v.rows.every((r) => r.scores.performance === 0)).toBe(true);
    expect(v.rows).toHaveLength(5);
  });
});

describe("evaluate: a run that scored nothing, or lost a category, is a failure", () => {
  it("zero reports fails", () => {
    const v = evaluate([]);
    expect(v.ok).toBe(false);
    expect(v.pagesScored).toBe(0);
    expect(v.problems.join("\n")).toMatch(/no Lighthouse reports/i);
  });

  it("four pages is fewer than five: fails, saying how many were scored", () => {
    const v = evaluate(fivePasses().slice(0, 4));
    expect(v.ok).toBe(false);
    expect(v.pagesScored).toBe(4);
    expect(v.problems.join("\n")).toMatch(/4 .*scored.*at least 5|at least 5.*4/i);
  });

  it("five reports of ONE page are one page, not five", () => {
    const v = evaluate([1, 2, 3, 4, 5].map((n) => ({ ...report("/blog"), file: `blog.${n}.json` })));
    expect(v.ok).toBe(false);
    expect(v.pagesScored).toBe(1);
  });

  it("a missing category fails, for each of the four (the page then does not count as scored)", () => {
    for (const cat of ALL) {
      const v = evaluate(PAGES.map((p) => report(p, p === "/blog" ? { [cat]: undefined } : {})));
      expect(v.ok, `${cat} missing`).toBe(false);
      expect(v.problems.join("\n"), `${cat} missing`).toContain(cat);
      expect(v.pagesScored, `${cat} missing`).toBe(4);
    }
  });

  it("a category with no score (null, which Lighthouse writes when its audits errored) fails like a missing one", () => {
    for (const cat of ALL) {
      const v = evaluate(PAGES.map((p) => report(p, p === "/blog" ? { [cat]: null } : {})));
      expect(v.ok, `${cat} null`).toBe(false);
      expect(v.problems.join("\n"), `${cat} null`).toContain(cat);
    }
  });

  it("a Lighthouse runtime error (the page never loaded) fails and is not counted as scored", () => {
    const r = report("/blog");
    (r.json as Lhr).runtimeError = { code: "NO_FCP", message: "The page did not paint any content." };
    const v = evaluate([r, ...fivePasses().slice(1)]);
    expect(v.ok).toBe(false);
    expect(v.pagesScored).toBe(4);
    expect(v.problems.join("\n")).toContain("NO_FCP");
  });

  it("a desktop report fails: the profile is mobile", () => {
    const r = report("/blog");
    (r.json as Lhr).configSettings.formFactor = "desktop";
    const v = evaluate([r, ...fivePasses().slice(1)]);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(/mobile/);
  });

  it("a file that is not JSON fails, and is named", () => {
    const v = evaluate([...fivePasses(), { file: "broken.json", json: undefined, parseError: "Unexpected token" }]);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toContain("broken.json");
  });

  it("refuses a minimum of zero pages (it would pass on nothing)", () => {
    expect(() => evaluate([], { minPages: 0 })).toThrow(/minPages/);
  });
});

describe("summaryMarkdown", () => {
  it("one row per page, Performance included, and the failures listed", () => {
    const v = evaluate([...fivePasses().slice(0, 4), { file: "formats.json", json: real("help-formats-swiss-a11y-99.json") }]);
    const md = summaryMarkdown(v);
    for (const p of PAGES) expect(md, p).toContain(p);
    expect(md).toContain("Performance");
    expect(md).toContain("61"); // the real report's performance, shown though it is not gated
    expect(md).toContain("accessibility");
  });
});

describe("the CLI, as the workflow runs it", () => {
  const root = mkdtempSync(join(tmpdir(), "lh-check-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function dirOf(name: string, reports: Report[]): string {
    const d = join(root, name);
    mkdirSync(d);
    for (const r of reports) writeFileSync(join(d, r.file), typeof r.json === "string" ? r.json : JSON.stringify(r.json));
    return d;
  }
  function run(dir: string, extra: string[] = []): { code: number; out: string; summary: string } {
    const summaryFile = join(root, `${dir.split("/").pop()}.summary.md`);
    try {
      const out = execFileSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--dir", dir, ...extra], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile, GITHUB_ACTIONS: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out, summary: readFileSync(summaryFile, "utf8") };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      let summary = "";
      try { summary = readFileSync(summaryFile, "utf8"); } catch { /* none written */ }
      return { code: err.status, out: `${err.stdout}${err.stderr}`, summary };
    }
  }

  it("five passing pages: exit 0, and the job summary carries every page with its Performance", () => {
    const r = run(dirOf("pass", fivePasses()));
    expect(r.code).toBe(0);
    for (const p of PAGES) expect(r.summary, p).toContain(p);
    expect(r.summary).toContain("Performance");
  });

  it("a page below 100: exit 1, with a GitHub error annotation naming it", () => {
    const r = run(dirOf("a11y99", [...fivePasses().slice(0, 4), { file: "formats.json", json: real("help-formats-swiss-a11y-99.json") }]));
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error");
    expect(r.out).toContain("/help/formats/swiss");
    expect(r.summary).toContain("accessibility");
  });

  it("an empty directory: exit 1 (zero pages scored is a failure)", () => {
    const r = run(dirOf("empty", []));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no Lighthouse reports/i);
  });

  it("a directory that does not exist: exit 1, not a pass", () => {
    expect(run(join(root, "nope")).code).toBe(1);
  });

  it("an unparsable report: exit 1", () => {
    const r = run(dirOf("garbage", [...fivePasses(), { file: "zz.json", json: "{ not json" as unknown }]));
    expect(r.code).toBe(1);
    expect(r.out).toContain("zz.json");
  });

  it("--min-pages 0 is refused (exit 2), so the floor cannot be argued away", () => {
    expect(run(dirOf("floor", fivePasses()), ["--min-pages", "0"]).code).toBe(2);
  });

  it("no --dir is a usage error (exit 2)", () => {
    try {
      execFileSync(process.execPath, ["--experimental-strip-types", SCRIPT], { stdio: "pipe" });
      throw new Error("expected a non-zero exit");
    } catch (e) {
      expect((e as { status: number }).status).toBe(2);
    }
  });
});
