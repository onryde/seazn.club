import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS = resolve(REPO, ".github/workflows");
const ci = readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };

const STEP_NAME = "Matrix harness unit tests (DB-free)";
const STEP_HEAD = `      - name: ${STEP_NAME}`;

const indentOf = (line: string) => line.length - line.trimStart().length;

// A named step as GitHub sees it: its own keys, and its `run: |` block
// dedented. Hand-parsed (no YAML dependency at the repo root); the parse is
// strict about the one shape it accepts, so a reshaped step reds here rather
// than parsing into something vacuous.
function stepOf(text: string, name: string): { keys: string[]; body: string; script: string | null } {
  const head = `      - name: ${name}`;
  const lines = text.split("\n");
  const heads = lines.flatMap((l, i) => (l === head ? [i] : []));
  if (heads.length !== 1) throw new Error(`expected exactly one "${head.trim()}" line, found ${heads.length}`);
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
const matrixStep = (t: string) => stepOf(t, STEP_NAME);

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

// Runs a named step's REAL run block, from ci.yml, in a scratch checkout whose
// `./packages/engine/node_modules/.bin/vitest` is a stand-in: it writes the
// given report to whatever `--outputFile=` the step passed it, then exits
// with the given code. Plain `bash`, not `bash -e`: the block's own `set -e`
// must carry the fail-fast, not the runner's default flag. `reportFile` is
// only where a STALE report is planted; the stand-in writes wherever the step
// told it to.
function runNamedStep(name: string, reportFile: string, o: { json: ReturnType<typeof report> | ((root: string) => ReturnType<typeof report>) | null; exit: number; stale?: (root: string) => ReturnType<typeof report> }) {
  const { script } = stepOf(ci, name);
  if (script === null) throw new Error(`the "${name}" step has no \`run: |\` block`);
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
    if (o.stale !== undefined) writeFileSync(join(root, reportFile), JSON.stringify(o.stale(root)));
    writeFileSync(join(root, "step.sh"), script);
    const r = spawnSync("bash", ["step.sh"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_JSON: fakeJson, FAKE_EXIT: String(o.exit) },
      encoding: "utf8",
      timeout: SPAWN_MS,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    // Task 10 review Minor 2: one scratch checkout per call, never left behind.
    rmSync(root, { recursive: true, force: true });
  }
}
const runStep = (o: Parameters<typeof runNamedStep>[2]) => runNamedStep(STEP_NAME, "vitest-results-matrix.json", o);

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
    }, spawnBudget(2));
    it("a real pass is green, and says what it counted", () => {
      const r = runStep({ json: (root) => report(root, { total: 3, passed: 3 }), exit: 0 });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("3/3");
    }, spawnBudget(1));
    it("ZERO tests is red, even when vitest exits 0 (a suite that fails to collect reads 0/0)", () => {
      const r = runStep({ json: (root) => report(root, { total: 0, passed: 0 }), exit: 0 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/ZERO tests/);
    }, spawnBudget(1));
    it("a failed suite is red even when every counted test passed", () => {
      const r = runStep({ json: (root) => report(root, { total: 2, passed: 2, failedSuites: 1 }), exit: 0 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/1 matrix suite\(s\) failed/);
    }, spawnBudget(1));
    it("fewer passed than total (a failed, skipped or todo test) is red", () => {
      const r = runStep({ json: (root) => report(root, { total: 3, passed: 2 }), exit: 0 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/only 2 of 3/);
    }, spawnBudget(1));
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
    }, spawnBudget(1));
    it("a non-zero vitest exit is red before the judge runs, even beside a green-looking report", () => {
      const r = runStep({ json: (root) => report(root, { total: 3, passed: 3 }), exit: 1 });
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("3/3");
    }, spawnBudget(1));
    it("no report at all is red", () => {
      const r = runStep({ json: null, exit: 0 });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/vitest-results-matrix\.json/);
    }, spawnBudget(1));
    it("a STALE green report is never judged: vitest writes nothing and exits 0 ⇒ red (Task 10 review Minor 3)", () => {
      // The step removes any old report before vitest runs, so a run that
      // writes none cannot be read as the earlier run's pass.
      const r = runStep({ json: null, exit: 0, stale: (root) => report(root, { total: 9, passed: 9 }) });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("9/9");
      expect(r.stderr).toMatch(/vitest-results-matrix\.json/);
    }, spawnBudget(1));
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
    expect(pkg.scripts["matrix:l3"]).toBe("node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/matrix/run.ts");
    expect(pkg.scripts["matrix:render"]).toBe("node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/matrix/render.ts");
    expect(existsSync(resolve(REPO, "scripts/matrix/run.ts"))).toBe(true);
    expect(existsSync(resolve(REPO, "scripts/matrix/render.ts"))).toBe(true);
  });

  describe("R26: the single-sport ratchet", () => {
    const SS_STEP = "      - run: pnpm matrix:single-sport --check --against HEAD^1";
    const lines = ci.split("\n");
    const isComment = (l: string) => /^\s*#/.test(l);
    // the job a line sits in: the last two-space job key at or above it
    const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();
    const gatesAt = lines.indexOf("  gates:");
    const gatesEnd = gatesAt + 1 + lines.slice(gatesAt + 1).findIndex((l) => /^ {2}[a-z][\w-]*:$/.test(l));

    it("the gates job runs it as the next step after engine:boundary, exactly once, through pnpm, against HEAD^1", () => {
      const boundary = lines.indexOf("      - run: npm run engine:boundary");
      expect(boundary).toBeGreaterThan(0);
      let next = boundary + 1;
      while (next < lines.length && isComment(lines[next]!)) next++;
      expect(lines[next]).toBe(SS_STEP);
      expect(lines.filter((l) => l.includes("matrix:single-sport") && !isComment(l))).toEqual([SS_STEP]);
      expect(jobAt(next)).toBe("  gates:");
      expect(pkg.scripts["matrix:single-sport"]).toBe("node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/matrix/single-sport.ts");
      expect(existsSync(resolve(REPO, "scripts/matrix/single-sport.ts"))).toBe(true);
    });

    it("nothing can turn the step off or make it advisory: no key under it, and no `if:` or continue-on-error on the gates job (review M-2)", () => {
      const at = lines.indexOf(SS_STEP);
      expect(at).toBeGreaterThan(0);
      // the very next line starts another step or is a comment — a key under the
      // step (`if:`, `continue-on-error:`, `env:`, …) would sit at indent 8
      expect(lines[at + 1]).toMatch(/^ {6}(- |#)/);
      expect(gatesAt).toBeGreaterThan(0);
      expect(gatesEnd).toBeGreaterThan(gatesAt);
      const header = lines.slice(gatesAt + 1, lines.indexOf("    steps:", gatesAt));
      expect(header.length).toBeGreaterThan(0);
      for (const l of header.filter((x) => !isComment(x))) expect(l).not.toMatch(/^ {4}(if|continue-on-error):/);
    });

    it("the gates checkout fetches deep enough for HEAD^1 to exist (fetch-depth 0 or at least 2)", () => {
      const job = lines.slice(gatesAt, gatesEnd);
      const checkouts = job.flatMap((l, i) => (l === "      - uses: actions/checkout@v5" ? [i] : []));
      expect(checkouts).toHaveLength(1);
      const c = checkouts[0]!;
      let end = c + 1;
      while (end < job.length && (isComment(job[end]!) || indentOf(job[end]!) >= 8)) end++;
      const depths = job.slice(c + 1, end).flatMap((l) => /^ {10}fetch-depth: (\d+)$/.exec(l)?.slice(1) ?? []).map(Number);
      expect(depths).toHaveLength(1);
      const depth = depths[0]!;
      expect(depth === 0 || depth >= 2, `fetch-depth ${depth}`).toBe(true);
      // and it sits before the ratchet step, in the same job
      expect(gatesAt + c).toBeLessThan(lines.indexOf(SS_STEP));
    });

    it("the step's command as ci.yml spells it, run the way CI runs it (the ref as HEAD, so no history is needed), reaches --check --against and passes on this tree", () => {
      const step = lines.find((l) => l.includes("matrix:single-sport") && !isComment(l));
      expect(step).toBeDefined();
      const cmd = (step ?? "").trim().replace(/^- run: /, "");
      expect(cmd).toContain(" --against HEAD^1");
      const r = spawnSync("bash", ["-c", cmd.replace(" --against HEAD^1", " --against HEAD")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
      expect(r.status, r.stderr).toBe(0);
      // only --check --against prints this line: both flags reached the CLI through pnpm
      expect(r.stdout).toMatch(/single-sport: check passed against scripts\/matrix\/catalogue\/single-sport-baseline\.json and HEAD$/m);
    }, spawnBudget(1));
  });

  it("matrix-report/ is ignored", () => {
    expect(readFileSync(resolve(REPO, ".gitignore"), "utf8")).toMatch(/^matrix-report\/$/m);
  });
});

describe("reference CI wiring (Task 12)", () => {
  const REF = "Reference package tests (DB-free)";
  const REF_REPORT = "vitest-results-reference.json";
  const BOUNDARY_STEP = "      - run: npm run reference:boundary";
  const lines = ci.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();
  const refReport = (root: string, o: { total: number; passed: number; failedSuites?: number; files?: string[] }) => ({
    numTotalTests: o.total, numPassedTests: o.passed, numFailedTests: o.total - o.passed, numFailedTestSuites: o.failedSuites ?? 0,
    testResults: (o.files ?? [join(root, "packages/reference/src/index.test.ts")]).map((name) => ({ name })),
  });
  const run = (o: Parameters<typeof runNamedStep>[2]) => runNamedStep(REF, REF_REPORT, o);

  it("the step exists right after the matrix step, and the boundary gate runs after the single-sport ratchet", () => {
    const m = lines.indexOf(`      - name: ${STEP_NAME}`);
    const r = lines.indexOf(`      - name: ${REF}`);
    expect(m).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(m);
    expect(lines.slice(m + 1, r).some((l) => l.startsWith("      - "))).toBe(false);
    const ss = lines.findIndex((l) => l.trim() === "- run: pnpm matrix:single-sport --check --against HEAD^1");
    expect(ss).toBeGreaterThan(0);
    expect(lines[ss + 1]!.trim()).toBe("- run: npm run reference:boundary");
    expect(stepOf(ci, REF).keys).toEqual(["name", "run"]);
  });

  it("both run in the gates job, exactly once each, and nothing can make the boundary gate conditional or advisory", () => {
    const at = lines.indexOf(BOUNDARY_STEP);
    expect(at).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("reference:boundary") && !isComment(l))).toEqual([BOUNDARY_STEP]);
    // a key under the step (`if:`, `continue-on-error:`, `env:`, …) would sit at indent 8
    expect(lines[at + 1]).toMatch(/^ {6}(- |#)/);
    expect(jobAt(at)).toBe("  gates:");
    expect(jobAt(lines.indexOf(`      - name: ${REF}`))).toBe("  gates:");
    expect(lines.filter((l) => l === `      - name: ${REF}`)).toHaveLength(1);
    expect(pkg.scripts["reference:boundary"]).toBe("node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/reference-boundary.ts");
    expect(existsSync(resolve(REPO, "scripts/reference-boundary.ts"))).toBe(true);
  });

  it("the reference step is only a name and a run block, runs packages/reference with the JSON reporter, and reaches no database", () => {
    const step = stepOf(ci, REF);
    expect(step.body).not.toContain("${{");
    expect(step.body).not.toMatch(/DATABASE_URL|secrets\./);
    const cmd = (step.script ?? "").split("\n").filter((l) => l.includes("node_modules/.bin/vitest run"));
    expect(cmd).toEqual([
      "./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=vitest-results-reference.json --testTimeout=30000 packages/reference",
    ]);
    const at = ci.indexOf(`      - name: ${REF}`);
    const jobKeys = [...ci.matchAll(/^ {2}[a-z][\w-]*:$/gm)].map((mm) => mm.index!);
    const job = ci.slice(Math.max(...jobKeys.filter((i) => i < at)), Math.min(...jobKeys.filter((i) => i > at), ci.length));
    expect(job).toContain(`      - name: ${REF}`);
    expect(dbLeaks(job)).toEqual([]);
  });

  it("green on a full pass inside packages/reference, and says what it counted", () => {
    const r = run({ json: (root) => refReport(root, { total: 4, passed: 4 }), exit: 0 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reference package: 4/4 tests passed in 1 files");
  }, spawnBudget(1));

  it("red on zero tests, a failed-to-collect suite, a skip, and a stray file", () => {
    expect(run({ json: (root) => refReport(root, { total: 0, passed: 0, files: [] }), exit: 0 }).status).not.toBe(0);
    expect(run({ json: (root) => refReport(root, { total: 4, passed: 4, failedSuites: 1 }), exit: 0 }).status).not.toBe(0);
    expect(run({ json: (root) => refReport(root, { total: 4, passed: 3 }), exit: 0 }).status).not.toBe(0);
    expect(run({ json: (root) => refReport(root, { total: 4, passed: 4, files: [join(root, "scripts/x.test.ts")] }), exit: 0 }).status).not.toBe(0);
  }, spawnBudget(4));

  // The positional is a substring filter; each of these is a file it could
  // really select, and each alone must red the step.
  it.each([
    ["a sibling whose name only starts with reference", (root: string) => join(root, "packages/reference-legacy/src/a.test.ts")],
    ["a nested worktree's copy", (root: string) => join(root, ".claude/worktrees/x/packages/reference/src/a.test.ts")],
  ])("a file outside <cwd>/packages/reference/ is red: %s", (_label, stray) => {
    const r = run({ json: (root) => refReport(root, { total: 2, passed: 2, files: [join(root, "packages/reference/src/index.test.ts"), stray(root)] }), exit: 0 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/outside packages\/reference/);
  }, spawnBudget(1));

  it("a non-zero vitest exit, no report, and a STALE green report are each red", () => {
    const failed = run({ json: (root) => refReport(root, { total: 4, passed: 4 }), exit: 1 });
    expect(failed.status).toBe(1);
    expect(failed.stdout).not.toContain("4/4");
    expect(run({ json: null, exit: 0 }).status).not.toBe(0);
    const stale = run({ json: null, exit: 0, stale: (root) => refReport(root, { total: 9, passed: 9 }) });
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).not.toContain("9/9");
    expect(stale.stderr).toMatch(/vitest-results-reference\.json/);
  }, spawnBudget(3));
});
