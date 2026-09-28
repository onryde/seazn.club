import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS = resolve(REPO, ".github/workflows");
const ci = readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };

const STEP_NAME = "Matrix harness unit tests (DB-free)";
const STEP_HEAD = `      - name: ${STEP_NAME}`;

const indentOf = (line: string) => line.length - line.trimStart().length;

// The step as GitHub sees it: its own keys, and its `run: |` block dedented.
// Hand-parsed (no YAML dependency at the repo root); the parse is strict about
// the one shape it accepts, so a reshaped step reds here rather than parsing
// into something vacuous.
function matrixStep(text: string): { keys: string[]; body: string; script: string | null } {
  const lines = text.split("\n");
  const heads = lines.flatMap((l, i) => (l === STEP_HEAD ? [i] : []));
  if (heads.length !== 1) throw new Error(`expected exactly one "${STEP_HEAD.trim()}" line, found ${heads.length}`);
  const start = heads[0]!;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || indentOf(lines[end]!) >= 8)) end++;
  const body = lines.slice(start + 1, end);
  const keys = ["name", ...body.flatMap((l) => /^ {8}([a-z][\w-]*):/.exec(l)?.slice(1) ?? [])];
  const runAt = body.indexOf("        run: |");
  if (runAt === -1) return { keys, body: body.join("\n"), script: null };
  const script: string[] = [];
  for (const l of body.slice(runAt + 1)) {
    if (l.trim() !== "" && indentOf(l) < 10) break;
    script.push(l.slice(10));
  }
  return { keys, body: body.join("\n"), script: script.join("\n").trimEnd() + "\n" };
}

/** A job-level (4-space) block of a job's YAML: its key line and every deeper
 *  line after it, or "" when the job has no such key. */
function jobBlock(lines: string[], key: string): string {
  const at = lines.indexOf(`    ${key}:`);
  if (at === -1) return "";
  let end = at + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || indentOf(lines[end]!) > 4)) end++;
  return lines.slice(at, end).join("\n");
}

/** What in a job's YAML (comments dropped) could hand the matrix step a
 *  database (Task 10 review Minor 1): any `services:` block, a job-level `env:`
 *  that names postgres, or DATABASE_URL anywhere. Another step merely NAMED
 *  for postgres cannot reach this one. */
function dbLeaks(job: string): string[] {
  const lines = job.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  const yaml = lines.join("\n");
  const out: string[] = [];
  if (/^\s+services:/m.test(yaml)) out.push("services");
  if (/postgres/i.test(jobBlock(lines, "env"))) out.push("env: postgres");
  if (/DATABASE_URL/.test(yaml)) out.push("DATABASE_URL");
  return out;
}

// A synthetic vitest JSON report, shaped like vitest 4's (only the fields the
// step's judge reads).
function report(root: string, o: { total: number; passed: number; failedSuites?: number; files?: string[] }) {
  return {
    numTotalTests: o.total,
    numPassedTests: o.passed,
    numFailedTests: o.total - o.passed,
    numFailedTestSuites: o.failedSuites ?? 0,
    testResults: (o.files ?? [join(root, "scripts/matrix/__tests__/a.test.ts")]).map((name) => ({ name })),
  };
}

// Runs the step's REAL run block, from ci.yml, in a scratch checkout whose
// `./packages/engine/node_modules/.bin/vitest` is a stand-in: it writes the
// given report to whatever `--outputFile=` the step passed it, then exits
// with the given code. Plain `bash`, not `bash -e`: the block's own `set -e`
// must carry the fail-fast, not the runner's default flag.
function runStep(o: { json: ReturnType<typeof report> | ((root: string) => ReturnType<typeof report>) | null; exit: number; stale?: (root: string) => ReturnType<typeof report> }) {
  const { script } = matrixStep(ci);
  if (script === null) throw new Error("the matrix step has no `run: |` block");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fm-ci-")));
  try {
    const bin = join(root, "packages/engine/node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "vitest"),
      [
        "#!/bin/sh",
        'out=""',
        'for a in "$@"; do case "$a" in --outputFile=*) out="${a#--outputFile=}";; esac; done',
        'if [ -n "$FAKE_JSON" ]; then cp "$FAKE_JSON" "$out"; fi',
        'exit "$FAKE_EXIT"',
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "vitest"), 0o755);
    let fakeJson = "";
    if (o.json !== null) {
      fakeJson = join(root, "fake-report.json");
      writeFileSync(fakeJson, JSON.stringify(typeof o.json === "function" ? o.json(root) : o.json));
    }
    // A report left over from an earlier run, sitting where the step writes its own.
    if (o.stale !== undefined) writeFileSync(join(root, "vitest-results-matrix.json"), JSON.stringify(o.stale(root)));
    writeFileSync(join(root, "step.sh"), script);
    const r = spawnSync("bash", ["step.sh"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_JSON: fakeJson, FAKE_EXIT: String(o.exit) },
      encoding: "utf8",
      timeout: 20_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    // Task 10 review Minor 2: one scratch checkout per call, never left behind.
    rmSync(root, { recursive: true, force: true });
  }
}

describe("matrix CI wiring", () => {
  it("a DB-free step runs scripts/matrix with the JSON reporter, right after the bench step", () => {
    const bench = ci.indexOf("scripts/bench\n");
    const matrix = ci.indexOf("--outputFile=vitest-results-matrix.json --testTimeout=30000 scripts/matrix");
    expect(bench).toBeGreaterThan(0);
    expect(matrix).toBeGreaterThan(bench);
    const between = ci.slice(bench, matrix);
    expect(between).not.toMatch(/\n {2}[a-z][\w-]*:\n/); // same job: no new job key in between
    // "right after": the only step that starts between the two is the matrix one
    expect([...between.matchAll(/^ {6}- .*$/gm)].map((m) => m[0])).toEqual([STEP_HEAD]);
  });

  it("the step is only a name and a run block: no env, secrets, expressions, shell override, condition or continue-on-error", () => {
    const step = matrixStep(ci);
    expect(step.keys).toEqual(["name", "run"]);
    expect(step.script).not.toBeNull();
    expect(step.body).not.toContain("${{");
    expect(step.body).not.toMatch(/DATABASE_URL|secrets\./);
  });

  it("the job hosting the step declares no database service", () => {
    const at = ci.indexOf(STEP_HEAD);
    expect(at).toBeGreaterThan(0);
    const jobKeys = [...ci.matchAll(/^ {2}[a-z][\w-]*:$/gm)].map((m) => m.index!);
    const jobStart = Math.max(...jobKeys.filter((i) => i < at));
    const jobEnd = Math.min(...jobKeys.filter((i) => i > at), ci.length);
    expect(jobStart).toBeGreaterThan(0);
    const job = ci.slice(jobStart, jobEnd);
    expect(job).toContain(STEP_HEAD);
    expect(dbLeaks(job)).toEqual([]);
  });

  // Task 10 review Minor 1: judge only what can reach the step — a job-level
  // `services:` or `env:` block, and DATABASE_URL anywhere — so an unrelated
  // gates step that merely says "postgres" does not red the matrix wiring.
  it.each<[string, string, string[]]>([
    ["a clean job", "  gates:\n    steps:\n      - name: a\n        run: echo ok\n", []],
    ["another step NAMED for postgres (a drift gate over an enum snapshot)", "  gates:\n    steps:\n      - name: postgres enum drift\n        run: node check-postgres-enums.mjs\n", []],
    ["a comment that says postgres", "  gates:\n    # no live Postgres here\n    steps:\n      - run: echo ok\n", []],
    ["a job-level services block", "  gates:\n    services:\n      db:\n        image: redis\n    steps:\n      - run: echo ok\n", ["services"]],
    ["a job-level env pointing at postgres", "  gates:\n    env:\n      PGHOST: postgres\n    steps:\n      - run: echo ok\n", ["env: postgres"]],
    ["DATABASE_URL in any step", "  gates:\n    steps:\n      - name: other\n        env:\n          DATABASE_URL: x\n", ["DATABASE_URL"]],
  ])("dbLeaks: %s", (_name, job, leaks) => {
    expect(dbLeaks(job)).toEqual(leaks);
  });

  describe("the step judges vitest by its JSON report, not by its exit code alone", () => {
    it("runStep leaves no scratch checkout behind (Task 10 review Minor 2)", () => {
      const scratch = () => readdirSync(tmpdir()).filter((d) => d.startsWith("fm-ci-")).sort();
      const before = scratch();
      runStep({ json: (root) => report(root, { total: 1, passed: 1 }), exit: 0 });
      runStep({ json: null, exit: 1 });
      expect(scratch()).toEqual(before);
    });
    it("a real pass is green, and says what it counted", () => {
      const r = runStep({ json: (root) => report(root, { total: 3, passed: 3 }), exit: 0 });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("3/3");
    });
    it("ZERO tests is red, even when vitest exits 0 (a suite that fails to collect reads 0/0)", () => {
      const r = runStep({ json: (root) => report(root, { total: 0, passed: 0 }), exit: 0 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/ZERO tests/);
    });
    it("a failed suite is red even when every counted test passed", () => {
      const r = runStep({ json: (root) => report(root, { total: 2, passed: 2, failedSuites: 1 }), exit: 0 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/1 matrix suite\(s\) failed/);
    });
    it("fewer passed than total (a failed, skipped or todo test) is red", () => {
      const r = runStep({ json: (root) => report(root, { total: 3, passed: 2 }), exit: 0 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/only 2 of 3/);
    });
    // The positional is a substring filter, so each of these is a file it
    // could really select; each one alone must red the step.
    it.each([
      ["a nested worktree's copy", (root: string) => join(root, ".claude/worktrees/x/scripts/matrix/__tests__/a.test.ts")],
      ["a sibling whose name only starts with matrix", (root: string) => join(root, "scripts/matrix-legacy/__tests__/a.test.ts")],
      ["a path outside the checkout", (_root: string) => "/elsewhere/scripts/matrix/__tests__/a.test.ts"],
    ])("a file outside <cwd>/scripts/matrix/ is red: %s", (_label, stray) => {
      const r = runStep({
        json: (root) => report(root, { total: 2, passed: 2, files: [join(root, "scripts/matrix/__tests__/a.test.ts"), stray(root)] }),
        exit: 0,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/outside scripts\/matrix/);
    });
    it("a non-zero vitest exit is red before the judge runs, even beside a green-looking report", () => {
      const r = runStep({ json: (root) => report(root, { total: 3, passed: 3 }), exit: 1 });
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("3/3");
    });
    it("no report at all is red", () => {
      const r = runStep({ json: null, exit: 0 });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/vitest-results-matrix\.json/);
    });
    it("a STALE green report is never judged: vitest writes nothing and exits 0 ⇒ red (Task 10 review Minor 3)", () => {
      // The step removes any old report before vitest runs, so a run that
      // writes none cannot be read as the earlier run's pass.
      const r = runStep({ json: null, exit: 0, stale: (root) => report(root, { total: 9, passed: 9 }) });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("9/9");
      expect(r.stderr).toMatch(/vitest-results-matrix\.json/);
    });
    it("the stale-report guard is the step's own `rm -f`, before vitest", () => {
      const lines = (matrixStep(ci).script ?? "").split("\n");
      const rm = lines.findIndex((l) => /^rm -f vitest-results-matrix\.json$/.test(l.trim()));
      const vitest = lines.findIndex((l) => l.includes("node_modules/.bin/vitest run"));
      expect(rm).toBeGreaterThan(-1);
      expect(vitest).toBeGreaterThan(rm);
    });
  });

  it("no scheduled matrix workflow exists in W1a", () => {
    expect(ci).not.toMatch(/matrix:l3/);
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
    expect(files).toContain("ci.yml");
    expect(files).toContain("e2e.yml");
    for (const f of files) {
      expect({ f, hit: /matrix:l3|scripts\/matrix\/run\b/.test(readFileSync(join(WORKFLOWS, f), "utf8")) }).toEqual({ f, hit: false });
    }
  });

  it("package scripts run the CLIs under strip-types", () => {
    expect(pkg.scripts["matrix:l3"]).toBe("node --experimental-strip-types scripts/matrix/run.ts");
    expect(pkg.scripts["matrix:render"]).toBe("node --experimental-strip-types scripts/matrix/render.ts");
    expect(existsSync(resolve(REPO, "scripts/matrix/run.ts"))).toBe(true);
    expect(existsSync(resolve(REPO, "scripts/matrix/render.ts"))).toBe(true);
  });

  it("matrix-report/ is ignored", () => {
    expect(readFileSync(resolve(REPO, ".gitignore"), "utf8")).toMatch(/^matrix-report\/$/m);
  });
});
