// ci.yml's content lane: a pull request that touches only help or blog articles (and the
// pictures they show) skips four jobs and runs everything else. That is safe only while
// NOTHING the skipped jobs run reads that content, and "nothing reads it" is a property of
// ~60 test files that no one job shows. This file derives it.
//
//   * Every test file that reads help or blog content is found BY BEHAVIOUR, not by filename:
//     a file that names a content root or a loader's root constant in code (comments dropped)
//     and touches the file system, plus every test that imports one of those modules,
//     transitively. The loaders themselves (help-content.ts, blog-content.ts) and the shared
//     helper (_help-copy.ts) are found the same way, never listed here.
//   * For each, the job(s) that run it are read from ci.yml's own commands. A test with no DB
//     gate runs in `test`, which holds every apps/web unit test and stays in the lane. A test
//     with a DB gate (`describe.skipIf(!HAS_DB)`) compares the content with the database, and
//     that half runs only in a DB job: so a lane job OTHER than `test` must select it, or the
//     file must be exempted by name with a reason that is itself checked.
//   * The skip list is read from the jobs' `if:` lines, and ci-gate's own script is RUN against
//     every job in turn, so the list ci-gate allows to skip is proven equal to the list that
//     does skip.
//
// Anti-vacuity: each sweep reports how many files it judged, and zero is a failure. The
// expected sets (which jobs skip, which test is exempt and why) are stated here, never read
// back from the workflow they judge.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const CI_YML = join(REPO, ".github/workflows/ci.yml");

// ---- ci.yml, read as text (no YAML library is a declared root dependency) -------------------

interface Job {
  id: string;
  /** Job-level lines only (4-space keys), comments dropped. */
  header: string[];
  needs: string[];
  /** The whole job, comment lines dropped. */
  text: string;
}
const jobs = (): Job[] => {
  const text = readFileSync(CI_YML, "utf8");
  const body = text.slice(text.indexOf("\njobs:"));
  return body
    .split(/\n(?= {2}[A-Za-z][\w-]*:\s*\n)/)
    .slice(1)
    .map((block) => {
      const lines = block.split("\n").filter((l) => !/^\s*#/.test(l));
      const id = /^ {2}([A-Za-z][\w-]*):/.exec(lines[0]!)![1]!;
      const header = lines.filter((l) => /^ {4}[A-Za-z][\w-]*:/.test(l));
      let needs: string[] = [];
      const at = lines.findIndex((l) => /^ {4}needs:/.test(l));
      if (at >= 0) {
        const inline = lines[at]!.replace(/^ {4}needs:\s*/, "").trim();
        if (inline) needs = inline.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
        else for (const l of lines.slice(at + 1)) {
          const m = /^ {6}- ([\w-]+)\s*$/.exec(l);
          if (!m) break;
          needs.push(m[1]!);
        }
      }
      return { id, header, needs, text: lines.join("\n") };
    });
};

const CODE_IF = "if: needs.changes.outputs.code == 'true'";
const NOT_CONTENT_IF = `${CODE_IF} && needs.changes.outputs.content != 'true'`;

/** The jobs that skip on a content-only change, read from the jobs' own `if:` lines. */
const skippedOnContent = (all: Job[]): string[] => {
  const direct = all.filter((j) => j.header.includes(`    ${NOT_CONTENT_IF}`)).map((j) => j.id);
  // A job whose own condition reads a skipped job's output is skipped with it (matrix-sample reads
  // matrix-rows' `run`, which is empty when matrix-rows did not run).
  const through = all.filter((j) => !direct.includes(j.id) && direct.some((d) => j.header.some((h) => h.includes(`needs.${d}.outputs`)))).map((j) => j.id);
  return [...direct, ...through].sort();
};

/** What the design says, stated here: the jobs a content-only pull request does not run. */
const EXPECTED_SKIPPED = ["matrix-rows", "matrix-sample", "smoke-db-app", "smoke-db-outliers", "smoke-db-usecases"];
/** Everything that reads content, and so runs on a content-only change. */
const EXPECTED_RUNNING = ["changes", "container", "gates", "placement-pin", "scheduler-live", "security", "smoke-db", "smoke-e2e", "test"];

// ---- the tree, and every test that reads help or blog content -------------------------------

const SOURCE_ROOTS = /^(apps\/web\/(src|e2e)|scripts|tools|packages|apps\/cron-worker)\//;
const tracked = (): string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f !== "" && /\.[cm]?[jt]sx?$/.test(f) && SOURCE_ROOTS.test(f));
/** Full-line comments dropped: a doc comment that names `content/help/x.md` reads nothing. */
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** A content root or a loader's root constant, named in code. */
const NAMES_CONTENT =
  /content\/(?:help|blog)|["']content["']\s*,\s*["'](?:help|blog)["']|\bHELP_ROOT\b|\bBLOG_ROOT\b|\bHELP_PUBLIC_ROOT\b|\ballBlogPosts\b|\ballHelpArticles\b|\bloadHelp\b|\bHELP_ARTICLE|\bhelpPlainText\b|public\/help|["']public["']\s*,\s*["']help["']/;
/** The file system, read or listed. */
const READS_FILES = /\breadFileSync\b|\breaddirSync\b|\breadFile\(|\breaddir\(|\bstatSync\b|\bexistsSync\b|\bglobSync\b/;
const IS_TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IMPORT =
  /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|vi\.(?:mock|importActual)\(\s*["']([^"']+)["']/g;
const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

interface Reader {
  /** Repo-relative path. */
  file: string;
  /** A `.skipIf(`/`.runIf(` in the file: part of it runs only where the gate opens (a database, a live URL). */
  gated: boolean;
  /** Why it counts: it names a content root itself, or imports a module that does. */
  via: string;
}
const readers = (): { found: Reader[]; modules: string[]; scanned: number } => {
  const files = tracked();
  const text = new Map(files.map((f) => [f, code(readFileSync(join(REPO, f), "utf8"))]));
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = `apps/web/src/${spec.slice(2)}`;
    else if (spec.startsWith(".")) base = join(dirname(from), spec);
    else return null;
    for (const b of [base, base.replace(/\.m?js$/, "")]) for (const e of EXTS) if (text.has(b + e)) return b + e;
    return null;
  };
  const importers = new Map<string, Set<string>>();
  for (const f of files) {
    for (const m of text.get(f)!.matchAll(IMPORT)) {
      const r = resolve(f, (m[1] ?? m[2] ?? m[3] ?? m[4])!);
      if (r) (importers.get(r) ?? importers.set(r, new Set()).get(r)!).add(f);
    }
  }
  // Roots: a file that names a content root AND touches the file system.
  const roots = files.filter((f) => NAMES_CONTENT.test(text.get(f)!) && READS_FILES.test(text.get(f)!));
  const via = new Map<string, string>(roots.map((r) => [r, "reads content itself"]));
  const queue = [...roots];
  while (queue.length) {
    const x = queue.shift()!;
    for (const y of importers.get(x) ?? []) {
      if (!via.has(y)) {
        via.set(y, `imports ${x}`);
        queue.push(y);
      }
    }
  }
  // A test that only NAMES a content root (a path handed to a helper) counts too: it is a reader whatever does the reading.
  const named = files.filter((f) => IS_TEST.test(f) && NAMES_CONTENT.test(text.get(f)!));
  for (const f of named) if (!via.has(f)) via.set(f, "names a content root");
  const found = [...via.keys()]
    .filter((f) => IS_TEST.test(f))
    .sort()
    .map((file) => ({ file, gated: /\.(?:skipIf|runIf)\(/.test(text.get(file)!), via: via.get(file)! }));
  return { found, modules: roots.filter((r) => !IS_TEST.test(r)).sort(), scanned: files.length };
};

// ---- which job runs a test file -------------------------------------------------------------

/** Repo paths a job hands to a test runner, e.g. `src/server`, `scripts/__tests__`, `src/blog/__tests__/x.test.ts`. */
const pathsOf = (job: Job): string[] =>
  [...new Set(job.text.split(/[\s"'`=]+/).filter((w) => /^(?:src|scripts|tools|packages)\/[\w./-]+$/.test(w)).map((w) => w.replace(/\/$/, "")))];
/** Workspace-relative path of a test file: `src/...` under apps/web, the repo path otherwise. */
const relOf = (file: string) => (file.startsWith("apps/web/") ? file.slice("apps/web/".length) : file);
/** The jobs, other than `test`, whose commands select this file. */
const selectedBy = (file: string, all: Job[]): string[] => {
  const rel = relOf(file);
  return all
    .filter((j) => j.id !== "test" && pathsOf(j).some((p) => rel === p || rel.startsWith(`${p}/`)))
    .map((j) => j.id)
    .sort();
};

/**
 * DB-gated readers whose gated half does NOT read content, and so may run only in a job that skips.
 * Each is verified: it must still be a gated reader, no lane job may select it, and a skipped job must.
 */
const GATED_HALF_READS_NO_CONTENT: Record<string, string> = {
  "apps/web/src/app/__tests__/sitemap.test.ts":
    "Its describe.skipIf(!HAS_DB) block seeds a competition and asserts the competition and division URLs and that no non-blog entry carries a lastmod. " +
    "The help and blog entries are asserted by the file's DB-free tests (`/help/formats` pages, the blog dates), which run in `test`, and by sitemap-help-blog.test.ts.",
};

describe("ci.yml: the content lane", () => {
  it("skips exactly the jobs that run nothing which reads content, derived from the jobs' own `if:` lines", () => {
    const all = jobs();
    expect(all.length, "jobs found").toBeGreaterThan(10);
    const skipped = skippedOnContent(all);
    expect(skipped).toEqual(EXPECTED_SKIPPED);
    const running = all.map((j) => j.id).filter((id) => !skipped.includes(id) && id !== "ci-gate").sort();
    expect(running).toEqual(EXPECTED_RUNNING);
    // ci-gate itself is neither: it reports for both lists.
    expect(all.some((j) => j.id === "ci-gate")).toBe(true);
  });

  it("finds the readers by behaviour, and every one of them runs in a job that stays in the lane", () => {
    const all = jobs();
    const skipped = skippedOnContent(all);
    const { found, modules, scanned } = readers();

    // Anti-vacuity: the scan reached the tree and found the loaders, the helper and tests of every kind.
    expect(scanned, "source files scanned").toBeGreaterThan(5000);
    expect(modules, "modules that read content").toEqual(
      expect.arrayContaining(["apps/web/src/server/help-content.ts", "apps/web/src/server/blog-content.ts", "apps/web/src/lib/__tests__/_help-copy.ts"]),
    );
    expect(found.length, "content-reading test files found").toBeGreaterThan(40);
    const web = found.filter((r) => r.file.startsWith("apps/web/src/"));
    const gated = found.filter((r) => r.gated);
    expect(web.length, "unit tests that read content").toBeGreaterThan(30);
    expect(gated.length, "content readers with a gated half").toBeGreaterThan(5);
    expect(found.some((r) => r.file.startsWith("scripts/")), "a repo-root script test").toBe(true);

    // Nothing under usecases/ is modelled here (its jobs are cut by file-name letter ranges, which this file does not
    // reproduce): a reader there would need that, so it is refused rather than guessed.
    expect(found.filter((r) => r.file.includes("/src/server/usecases/")).map((r) => r.file)).toEqual([]);

    const unit = found.filter((r) => r.file.startsWith("apps/web/src/"));
    const uncovered: string[] = [];
    const exempted: string[] = [];
    for (const r of found) {
      if (r.file.startsWith("apps/web/e2e/")) continue; // judged below
      const by = selectedBy(r.file, all);
      if (r.file.startsWith("apps/web/src/")) {
        // Every apps/web unit test runs in `test`, which stays in the lane (the unit shards hold all of them).
        if (!r.gated) continue;
        // A gated half runs only where its gate opens: a DB job or the named live step. One of them must stay.
        if (by.some((id) => !skipped.includes(id))) continue;
        if (GATED_HALF_READS_NO_CONTENT[r.file]) {
          exempted.push(r.file);
          continue;
        }
        uncovered.push(`${r.file} (gated; selected by ${by.join(", ") || "no DB job"}; skipped: ${skipped.join(", ")})`);
      } else if (!by.some((id) => !skipped.includes(id))) {
        uncovered.push(`${r.file} (selected by ${by.join(", ") || "no job"})`);
      }
    }
    expect(unit.length, "unit tests judged").toBeGreaterThan(30);
    expect(uncovered, `${found.length} content-reading test files judged, ${gated.length} with a gated half`).toEqual([]);

    // The exemptions are exactly the ones this run needed: a stale one (the file is no longer a gated reader, or a lane job
    // now selects it) is a lie waiting to hide the next one.
    expect(exempted.sort()).toEqual(Object.keys(GATED_HALF_READS_NO_CONTENT).sort());
    for (const file of Object.keys(GATED_HALF_READS_NO_CONTENT)) {
      const r = found.find((x) => x.file === file);
      expect(r?.gated, `${file} is still a gated content reader`).toBe(true);
      const by = selectedBy(file, all);
      expect(by.filter((id) => !skipped.includes(id)), `${file} is selected by no job that stays`).toEqual([]);
      expect(by.filter((id) => skipped.includes(id)).length, `${file} is selected by a job that skips`).toBeGreaterThan(0);
    }
  });

  it("`test` runs every apps/web unit test, so every ungated reader runs in the lane", () => {
    const all = jobs();
    const skipped = skippedOnContent(all);
    const { found } = readers();
    const test = all.find((j) => j.id === "test")!;
    // `test` runs the whole apps/web suite: no positional path narrows it, and it is sharded by FILE, not by directory.
    expect(test.text).toMatch(/npm test --workspace apps\/web -- --shard=/);
    expect(pathsOf(test).filter((p) => p.startsWith("src/") && p !== "src/lib/__tests__/billing-tiers.live.test.ts")).toEqual([]);
    expect(test.header, "test is not gated on content").toContain(`    ${CODE_IF}`);
    // Some readers are also selected by a skipped job (src/app is run by smoke-db-app AND `test`): that is a second run,
    // not the only one. The sweep above is what judges them.
    expect(found.filter((r) => selectedBy(r.file, all).some((id) => skipped.includes(id))).length, "readers also selected by a skipped job").toBeGreaterThan(0);
  });

  it("help and blog readers that no ci.yml job runs are run by e2e.yml, not by a lane job", () => {
    const { found } = readers();
    const e2e = found.filter((r) => r.file.startsWith("apps/web/e2e/"));
    expect(e2e.length, "e2e specs that read content").toBeGreaterThan(0);
    const ci = readFileSync(CI_YML, "utf8");
    const e2eYml = readFileSync(join(REPO, ".github/workflows/e2e.yml"), "utf8");
    for (const r of e2e) {
      const name = r.file.split("/").pop()!;
      expect(ci.includes(name), `${name} is named in ci.yml: put its job in the lane`).toBe(false);
    }
    // They run in e2e.yml (push to main), which a content-only PR never triggers: that is true today for every PR.
    expect(e2eYml).toMatch(/\bpush:/);
  });

  it("the classifier's content roots are the loaders' roots and the pictures the articles show", () => {
    const helpRoot = /HELP_ROOT\s*=\s*join\(process\.cwd\(\),\s*"content",\s*"help"\)/.exec(readFileSync(join(REPO, "apps/web/src/server/help-content.ts"), "utf8"));
    const blogRoot = /BLOG_ROOT\s*=\s*join\(process\.cwd\(\),\s*"content",\s*"blog"\)/.exec(readFileSync(join(REPO, "apps/web/src/server/blog-content.ts"), "utf8"));
    expect(helpRoot, "HELP_ROOT is apps/web/content/help").not.toBeNull();
    expect(blogRoot, "BLOG_ROOT is apps/web/content/blog").not.toBeNull();
    const script = readFileSync(join(REPO, "scripts/ci-docs-only.sh"), "utf8");
    for (const root of ["apps/web/content/help/*", "apps/web/content/blog/*", "apps/web/public/help/*"]) {
      expect(script, `kind_of names ${root}`).toContain(root);
    }
    // The pictures: every image an article shows is served from /help/…, which is apps/web/public/help/….
    const md = execFileSync("git", ["ls-files", "-z", "--", "apps/web/content/help", "apps/web/content/blog"], { cwd: REPO, encoding: "utf8" })
      .split("\0")
      .filter((f) => f.endsWith(".md"));
    expect(md.length, "articles scanned").toBeGreaterThan(100);
    let images = 0;
    const stray: string[] = [];
    for (const f of md) {
      for (const m of readFileSync(join(REPO, f), "utf8").matchAll(/!\[[^\]]*\]\((\/[^)\s]+)/g)) {
        images++;
        const url = m[1]!;
        if (!url.startsWith("/help/") || !existsSync(join(REPO, "apps/web/public", url))) stray.push(`${f} -> ${url}`);
      }
    }
    expect(images, "article images checked").toBeGreaterThan(50);
    expect(stray).toEqual([]);
  });
});

// ---- ci-gate, run for real -------------------------------------------------------------------

/** The `run:` body of ci-gate's one step, as the runner would execute it. */
const gateScript = (): string => {
  const gate = jobs().find((j) => j.id === "ci-gate")!;
  const at = gate.text.indexOf("        run: |\n");
  expect(at, "ci-gate has a run block").toBeGreaterThan(-1);
  return gate.text
    .slice(at + "        run: |\n".length)
    .split("\n")
    .filter((l) => l === "" || l.startsWith("          "))
    .map((l) => l.slice(10))
    .join("\n");
};
type Result = "success" | "skipped" | "failure" | "cancelled";
const runGate = (outputs: { code?: string; content?: string }, results: Record<string, Result>, changes: Result = "success") => {
  const needs: Record<string, unknown> = {};
  for (const [id, result] of Object.entries(results)) needs[id] = { result, outputs: {} };
  needs.changes = { result: changes, outputs: Object.fromEntries(Object.entries(outputs).filter(([, v]) => v !== undefined)) };
  const r = spawnSync("bash", ["-c", gateScript()], { encoding: "utf8", env: { ...process.env, NEEDS: JSON.stringify(needs) } });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
};

describe("ci-gate on the three lanes (the script ci.yml runs, executed)", () => {
  const ids = () => jobs().find((j) => j.id === "ci-gate")!.needs.filter((id) => id !== "changes");
  const allSuccess = (): Record<string, Result> => Object.fromEntries(ids().map((id) => [id, "success" as Result]));
  const skipped = () => skippedOnContent(jobs());

  it("a code change passes only when nothing but matrix-sample skipped", () => {
    expect(runGate({ code: "true", content: "false" }, allSuccess()).ok).toBe(true);
    expect(runGate({ code: "true", content: "false" }, { ...allSuccess(), "matrix-sample": "skipped" }).ok).toBe(true);
    let judged = 0;
    for (const id of ids().filter((i) => i !== "matrix-sample")) {
      judged++;
      const r = runGate({ code: "true", content: "false" }, { ...allSuccess(), [id]: "skipped" });
      expect(r.ok, `a code change that skipped ${id}`).toBe(false);
      expect(r.out).toContain("SKIPPED");
    }
    expect(judged, "jobs tried").toBeGreaterThan(10);
  });

  it("a content-only change may skip exactly the jobs whose `if:` skips, and no other", () => {
    const skip = skipped();
    expect(skip.length, "skipped on content").toBeGreaterThan(0);
    const base = allSuccess();
    const asSkipped: Record<string, Result> = { ...base, ...Object.fromEntries(skip.map((id) => [id, "skipped" as Result])) };
    expect(runGate({ code: "true", content: "true" }, asSkipped).ok, "the whole skip list at once").toBe(true);
    // Each skippable job alone, and running instead of skipping, both pass.
    for (const id of skip) {
      expect(runGate({ code: "true", content: "true" }, { ...base, [id]: "skipped" }).ok, `${id} skipped`).toBe(true);
      expect(runGate({ code: "true", content: "true" }, { ...asSkipped, [id]: "success" }).ok, `${id} ran`).toBe(true);
    }
    // Every other job, skipped, is refused: `test`, `smoke-db`, `smoke-e2e`, `container` read content, and the rest must run.
    const stays = ids().filter((id) => !skip.includes(id));
    expect(stays.length, "jobs that must run on a content-only change").toBeGreaterThan(5);
    for (const id of stays) {
      const r = runGate({ code: "true", content: "true" }, { ...asSkipped, [id]: "skipped" });
      expect(r.ok, `a content-only change that skipped ${id}`).toBe(false);
      expect(r.out, id).toContain("SKIPPED");
    }
  });

  it("a docs-only change passes with every heavy job skipped, and refuses a failed or cancelled one", () => {
    const heavy = [...jobs().filter((j) => j.header.includes(`    ${CODE_IF}`) || j.header.includes(`    ${NOT_CONTENT_IF}`)).map((j) => j.id), "matrix-sample"];
    expect(heavy.length, "heavy jobs").toBeGreaterThan(5);
    const docs: Record<string, Result> = { ...allSuccess(), ...Object.fromEntries(heavy.map((id) => [id, "skipped" as Result])) };
    expect(runGate({ code: "false", content: "false" }, docs).ok).toBe(true);
    for (const bad of ["failure", "cancelled"] as const) {
      expect(runGate({ code: "false", content: "false" }, { ...docs, gates: bad }).ok, `docs-only with gates ${bad}`).toBe(false);
      expect(runGate({ code: "true", content: "true" }, { ...allSuccess(), "smoke-db": bad }).ok, `content-only with smoke-db ${bad}`).toBe(false);
    }
  });

  it("refuses a classification that is missing, malformed or contradicts itself", () => {
    const ok = allSuccess();
    expect(runGate({ code: "true", content: "false" }, ok).ok).toBe(true);
    expect(runGate({ code: "true" }, ok).ok, "content missing").toBe(false);
    expect(runGate({ content: "false" }, ok).ok, "code missing").toBe(false);
    expect(runGate({ code: "true", content: "yes" }, ok).ok, "content malformed").toBe(false);
    expect(runGate({ code: "false", content: "true" }, ok).ok, "content-only without code").toBe(false);
    expect(runGate({ code: "true", content: "false" }, ok, "failure").ok, "changes failed").toBe(false);
    expect(runGate({ code: "true", content: "false" }, ok, "skipped").ok, "changes skipped").toBe(false);
  });
});
