import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";
import { indentOf, jobBlock, jobsOf, stepOf } from "./workflow-text.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOWS = resolve(REPO, ".github/workflows");
const ci = readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };

// Task 12 minor 2 (routed to Task 16): a prefix shared by every session on the machine made "leaves no scratch
// checkout behind" flake whenever another session's run of this file created or removed a checkout between the two
// snapshots. Each process names its own scratch checkouts, and the leak check reads only that name.
const SCRATCH_PREFIX = `fm-ci-${process.pid}-`;
const scratchDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith(SCRATCH_PREFIX)).sort();

const STEP_NAME = "Matrix harness unit tests (DB-free)";
const STEP_HEAD = `      - name: ${STEP_NAME}`;

const matrixStep = (t: string) => stepOf(t, STEP_NAME);

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

// The engine boundary gate moved into the engine package (engine-split 1d-2). ci.yml runs the ROOT script, and nothing else resolved its target,
// so a stale path would have shown only as a red CI step. Both entry points are held to the one file, which has to exist.
describe("the engine boundary gate's entry points", () => {
  const engineScripts = (JSON.parse(readFileSync(resolve(REPO, "packages/engine/package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const GATE = "packages/engine/scripts/engine-boundary.ts";
  const targetOf = (script: string | undefined) => (script ?? "").split(" ").at(-1) ?? "";

  it("the root `engine:boundary` and the engine's `boundary` scripts run the same existing gate, and ci.yml runs the root one", () => {
    expect(pkg.scripts["engine:boundary"]).toBe(`node --experimental-strip-types ${GATE}`);
    expect(engineScripts.boundary).toBe("node --experimental-strip-types scripts/engine-boundary.ts");
    // derived: both targets resolve to one file, from the directory each script runs in
    const fromRoot = resolve(REPO, targetOf(pkg.scripts["engine:boundary"]));
    const fromEngine = resolve(REPO, "packages/engine", targetOf(engineScripts.boundary));
    expect(fromEngine).toBe(fromRoot);
    expect(fromRoot).toBe(resolve(REPO, GATE));
    expect(existsSync(fromRoot), `${GATE} exists`).toBe(true);
    expect(ci.split("\n")).toContain("      - run: npm run engine:boundary");
  });
});

// A synthetic vitest JSON report, shaped like vitest 4's (only the fields the
// step's judge reads).
function report(root: string, o: { total: number; passed: number; failedSuites?: number; files?: string[] }) {
  return {
    numTotalTests: o.total,
    numPassedTests: o.passed,
    numFailedTests: o.total - o.passed,
    numFailedTestSuites: o.failedSuites ?? 0,
    testResults: (o.files ?? [join(root, "tools/matrix/__tests__/a.test.ts")]).map((name) => ({ name })),
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)));
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
  it("a DB-free step runs tools/matrix with the JSON reporter, right after the bench step", () => {
    const bench = ci.indexOf("tools/bench\n");
    const matrix = ci.indexOf("--outputFile=vitest-results-matrix.json --testTimeout=30000 tools/matrix");
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
      const before = scratchDirs();
      runStep({ json: (root) => report(root, { total: 1, passed: 1 }), exit: 0 });
      runStep({ json: null, exit: 1 });
      expect(scratchDirs()).toEqual(before);
    }, spawnBudget(2));
    // Task 12 minor 2: the checkout is named for THIS process, and the leak check reads only that name.
    it("the scratch checkout is named for this process (fm-ci-<pid>-…), so another session's cannot be mistaken for ours", () => {
      let seen = "";
      const r = runStep({ json: (root) => { seen = root; return report(root, { total: 1, passed: 1 }); }, exit: 0 });
      expect(r.status).toBe(0); // the step really ran in that checkout (a callback never called would leave seen empty)
      expect(basename(seen)).toMatch(new RegExp(`^fm-ci-${process.pid}-[A-Za-z0-9]+$`));
    }, spawnBudget(1));
    it("another process's scratch checkout, appearing while this one's leak check runs, is not read as a leak; ours would be", () => {
      const foreign = mkdtempSync(join(tmpdir(), `fm-ci-${process.pid + 1}-`));
      const ours = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
      try {
        // positive pair first: the check does see a checkout of this process's, and does not see the other's
        expect(scratchDirs()).toContain(basename(ours));
        expect(scratchDirs()).not.toContain(basename(foreign));
        // and the sequence the flake took: snapshot, a foreign checkout comes and goes, snapshot
        const before = scratchDirs();
        const late = mkdtempSync(join(tmpdir(), `fm-ci-${process.pid + 2}-`));
        rmSync(late, { recursive: true, force: true });
        expect(scratchDirs()).toEqual(before);
      } finally {
        rmSync(foreign, { recursive: true, force: true });
        rmSync(ours, { recursive: true, force: true });
      }
    });
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
      ["a nested worktree's copy", (root: string) => join(root, ".claude/worktrees/x/tools/matrix/__tests__/a.test.ts")],
      ["a sibling whose name only starts with matrix", (root: string) => join(root, "tools/matrix-legacy/__tests__/a.test.ts")],
      ["a path outside the checkout", (_root: string) => "/elsewhere/tools/matrix/__tests__/a.test.ts"],
    ])("a file outside <cwd>/tools/matrix/ is red: %s", (_label, stray) => {
      const r = runStep({
        json: (root) => report(root, { total: 2, passed: 2, files: [join(root, "tools/matrix/__tests__/a.test.ts"), stray(root)] }),
        exit: 0,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/outside tools\/matrix/);
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

  it("the matrix runs only in matrix-truth.yml, and ci.yml reaches it only by calling that workflow (W1d; was W1a's 'no workflow')", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
    const runners = files.filter((f) => /matrix:l3|matrix:browser|tools\/matrix\/run\b/.test(readFileSync(join(WORKFLOWS, f), "utf8")));
    expect(runners).toEqual(["matrix-truth.yml"]);
    expect(ci).toMatch(/uses:\s*\.\/\.github\/workflows\/matrix-truth\.yml/);
    expect(files.length).toBeGreaterThan(5);   // anti-vacuity: the directory was read
  });

  it("package scripts run the CLIs under strip-types", () => {
    expect(pkg.scripts["matrix:l3"]).toBe("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/run.ts");
    expect(pkg.scripts["matrix:render"]).toBe("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/render.ts");
    expect(existsSync(resolve(REPO, "tools/matrix/run.ts"))).toBe(true);
    expect(existsSync(resolve(REPO, "tools/matrix/render.ts"))).toBe(true);
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
      expect(pkg.scripts["matrix:single-sport"]).toBe("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/single-sport.ts");
      expect(existsSync(resolve(REPO, "tools/matrix/single-sport.ts"))).toBe(true);
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

    // W1-driving final review I-1: rebase-map.test.ts proves every mapped SHA
    // is an ancestor of HEAD, which needs the whole history — and the matrix
    // step runs in this job. Depth 0 also keeps HEAD^1 for the ratchet.
    it("the gates checkout fetches the full history (fetch-depth 0): HEAD^1 for the single-sport ratchet, and every ancestor for rebase-map.test.ts", () => {
      const job = lines.slice(gatesAt, gatesEnd);
      const checkouts = job.flatMap((l, i) => (l === "      - uses: actions/checkout@v5" ? [i] : []));
      expect(checkouts).toHaveLength(1);
      const c = checkouts[0]!;
      let end = c + 1;
      while (end < job.length && (isComment(job[end]!) || indentOf(job[end]!) >= 8)) end++;
      const depths = job.slice(c + 1, end).flatMap((l) => /^ {10}fetch-depth: (\d+)$/.exec(l)?.slice(1) ?? []).map(Number);
      expect(depths).toHaveLength(1);
      const depth = depths[0]!;
      expect(depth, `fetch-depth ${depth}: rebase-map.test.ts's ancestry check refuses a shallow clone`).toBe(0);
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
      expect(r.stdout).toMatch(/single-sport: check passed against tools\/matrix\/catalogue\/single-sport-baseline\.json and HEAD$/m);
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
    expect(pkg.scripts["reference:boundary"]).toBe("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts scripts/reference-boundary.ts");
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

// W1d Task 1 (item 1, D10): plans.lock.json is append-only. The gate's step is
// pinned the way R26's is: a line-based read of ci.yml, so a reshaped step reds
// here rather than parsing into something vacuous.
describe("lock-append-only CI wiring (W1d Task 1, item 1 D10)", () => {
  const LOCK_STEP = "- run: pnpm matrix:lock-check --against HEAD^1";
  const lines = ci.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();

  it("the lock gate runs in gates, unconditionally, right after reference:boundary", () => {
    const rb = lines.findIndex((l) => l.trim() === "- run: npm run reference:boundary");
    expect(rb).toBeGreaterThan(0);
    // the next non-comment line is the lock gate
    let next = rb + 1;
    while (next < lines.length && isComment(lines[next]!)) next++;
    expect(lines[next]!.trim()).toBe(LOCK_STEP);
    expect(lines[next]).toBe(`      ${LOCK_STEP}`);
    // exactly one non-comment line names it, and it sits in the gates job
    expect(lines.filter((l) => l.includes("matrix:lock-check") && !isComment(l))).toEqual([`      ${LOCK_STEP}`]);
    expect(jobAt(next)).toBe("  gates:");
    // nothing turns it off or makes it advisory: between it and the next step, only
    // comments (a key under the step — `if:`, `continue-on-error:`, `env:` — sits at indent 8)
    let end = next + 1;
    while (end < lines.length && !lines[end]!.startsWith("      - ")) end++;
    expect(end).toBeGreaterThan(next);
    const between = lines.slice(next + 1, end);
    expect(between.filter((l) => !isComment(l) && l.trim() !== "")).toEqual([]);
    // the same job carries no job-level `if:` / `continue-on-error:` that could skip the step
    const gatesAt = lines.indexOf("  gates:");
    const header = lines.slice(gatesAt + 1, lines.indexOf("    steps:", gatesAt));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header.filter((x) => !isComment(x))) expect(l).not.toMatch(/^ {4}(if|continue-on-error):/);
    // and R26's own assertion still holds: reference:boundary is the line right after the ratchet
    const ss = lines.findIndex((l) => l.trim() === "- run: pnpm matrix:single-sport --check --against HEAD^1");
    expect(lines[ss + 1]!.trim()).toBe("- run: npm run reference:boundary");
  });

  it("its package script preloads crash-exit.ts, runs the CLI, and the CLI exists", () => {
    expect(pkg.scripts["matrix:lock-check"]).toBe("node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/lock-append-only.ts");
    expect(existsSync(resolve(REPO, "tools/matrix/lock-append-only.ts"))).toBe(true);
  });

  it("the step's command as ci.yml spells it, run the way CI runs it, reaches the CLI and passes on this tree", () => {
    const step = lines.find((l) => l.includes("matrix:lock-check") && !isComment(l));
    expect(step).toBeDefined();
    const cmd = (step ?? "").trim().replace(/^- run: /, "");
    expect(cmd).toContain(" --against HEAD^1");
    // HEAD^1 needs history and a merge commit; HEAD is always there and the lock is committed unchanged
    const r = spawnSync("bash", ["-c", cmd.replace(" --against HEAD^1", " --against HEAD")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    // only a CLI that read both flags prints this: --against reached it through pnpm
    expect(r.stdout).toMatch(/^lock-append-only: \d+ entries compared, \d+ added$/m);
  }, spawnBudget(1));
});

// W1d Task 10 (item 7, D9): tsconfig.scripts.json excludes every *.test.ts, so
// type errors in test code reached main. tsconfig.tools-tests.json checks them,
// and the check lives only in ci.yml's gates job (a full `tsc -p` inside the
// unit step would duplicate the gates step's minutes against the unit step's
// timeout). Nothing else goes red when the step is deleted, so this pins it:
// a line-based read of ci.yml, as R26's and Task 1's are.
describe("tools-tests type-check CI wiring (W1d Task 10, item 7 D9)", () => {
  const STEP = "      - run: node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json";
  const lines = ci.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  // the job a line sits in: the last two-space job key at or above it
  const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();

  it("the tools-tests type-check runs in the gates job, exactly once, and nothing can make it conditional or advisory (W1d item 7)", () => {
    const at = lines.indexOf(STEP);
    expect(at).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("tsconfig.tools-tests.json") && !isComment(l))).toEqual([STEP]);
    // a key under the step (`if:`, `continue-on-error:`, `env:`, …) would sit at indent 8
    expect(lines[at + 1]).toMatch(/^ {6}(- |#)/);
    expect(jobAt(at)).toBe("  gates:");
    // nor a job-level `if:` / `continue-on-error:` on the job that hosts it
    const gatesAt = lines.indexOf("  gates:");
    const header = lines.slice(gatesAt + 1, lines.indexOf("    steps:", gatesAt));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header.filter((x) => !isComment(x))) expect(l).not.toMatch(/^ {4}(if|continue-on-error):/);
  });
});

// W1d Task 15 (D14): the Stryker floor never falls. Nothing else goes red when the step is deleted or made advisory, so this
// pins it, line-based as Task 10's is, and then RUNS the command as ci.yml spells it, so a flag pnpm swallowed or a script
// that does not exist reds here and not on the first PR that lowers a floor.
describe("Stryker floor CI wiring (W1d Task 15, D14)", () => {
  const STEP = "      - run: pnpm --filter ./packages/engine --fail-if-no-match mutation:floor --check-file-against HEAD^1";
  const TSC_STEP = "      - run: node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json";
  const lines = ci.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  // the job a line sits in: the last two-space job key at or above it
  const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();

  it("the Stryker floor gate runs in the gates job, exactly once, and nothing can make it conditional or advisory (W1d D14)", () => {
    const at = lines.indexOf(STEP);
    expect(at).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("mutation:floor") && !isComment(l))).toEqual([STEP]);
    expect(lines[at + 1]).toMatch(/^ {6}(- |#)/);   // no key beneath it (`if:`, `continue-on-error:`, `env:`)
    expect(jobAt(at)).toBe("  gates:");
    // appended AFTER the steps Tasks 1 and 10 added, never directly after reference:boundary (Task 1 pins the lock step as the line after it)
    expect(at).toBeGreaterThan(lines.indexOf(TSC_STEP));
    expect(lines.indexOf(TSC_STEP)).toBeGreaterThan(0);
    // nor a job-level `if:` / `continue-on-error:` on the job that hosts it
    const gatesAt = lines.indexOf("  gates:");
    const header = lines.slice(gatesAt + 1, lines.indexOf("    steps:", gatesAt));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header.filter((x) => !isComment(x))) expect(l).not.toMatch(/^ {4}(if|continue-on-error):/);
    // The step's `--filter ./packages/engine` is a PATH, resolved against the shell's cwd: a `defaults.run.working-directory` on the job
    // (or on the workflow) or a `working-directory:` on the step moves the cwd, the path matches nothing and pnpm exits 0 in silence.
    // `--fail-if-no-match` is the second line of defence; this is the first. (Phase 1 batch 1b review, minor 1.)
    for (const l of header.filter((x) => !isComment(x))) expect(l, "a job-level cwd shift would make the path filter a silent no-op").not.toMatch(/^ {4}(defaults|working-directory):/);
    expect(lines.filter((l) => /^(defaults|working-directory):/.test(l)), "a workflow-level default would shift every job's cwd").toEqual([]);
    expect(lines[at], "the step carries its no-match flag (a key beneath the step is already refused above, so nothing moves its cwd)").toContain(" --fail-if-no-match mutation:floor ");
  });

  it("the engine's package script runs the CLI under strip-types, and the CLI exists", () => {
    const engine = JSON.parse(readFileSync(resolve(REPO, "packages/engine/package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(engine.scripts["mutation:floor"]).toBe("node --experimental-strip-types scripts/stryker-floor.ts");
    expect(existsSync(resolve(REPO, "packages/engine/scripts/stryker-floor.ts"))).toBe(true);
    expect(engine.scripts.mutation).toBe("stryker run stryker.config.mjs");
  });

  it("the step's command as ci.yml spells it, run the way CI runs it, reaches the CLI with its flag and passes on this tree", () => {
    const step = lines.find((l) => l.includes("mutation:floor") && !isComment(l));
    expect(step).toBeDefined();
    const cmd = (step ?? "").trim().replace(/^- run: /, "");
    expect(cmd).toContain(" --check-file-against HEAD^1");
    // HEAD^1 needs history and a merge commit; HEAD is always there. Either HEAD has no floor file yet (the PR before its commit) or has the committed one, unchanged.
    const r = spawnSync("bash", ["-c", cmd.replace(" --check-file-against HEAD^1", " --check-file-against HEAD")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    // only a CLI that read the flag through `pnpm --filter` prints this: the flag reached it, in the engine's directory
    expect(r.stdout).toMatch(/^stryker-floor: (no floors at HEAD: nothing to compare|compared \d+ floor\(s\) against HEAD: 0 lowered or removed)$/m);
  }, spawnBudget(1));
});

// Engine-split Task 1e-2 (D15, D26): the fold-epoch guard. Nothing else goes red when the step is deleted, made advisory, or loses the history
// HEAD^1 needs, so this pins it line-based as the floor gate's is, and then RUNS the command as ci.yml spells it, so a flag pnpm swallowed or a
// script that does not exist reds here and not on the first PR that moves a golden.
describe("fold-epoch guard CI wiring (engine-split Task 1e-2, D15, D26)", () => {
  const engine = JSON.parse(readFileSync(resolve(REPO, "packages/engine/package.json"), "utf8")) as { name: string; scripts: Record<string, string> };
  const FLOOR_STEP = "      - run: pnpm --filter ./packages/engine --fail-if-no-match mutation:floor --check-file-against HEAD^1";
  const STEP = `      - run: pnpm --filter ${engine.name} --fail-if-no-match fold-epoch:check --against HEAD^1`;
  const lines = ci.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  const jobAt = (i: number) => lines.slice(0, i + 1).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();

  it("the guard runs in the gates job, exactly once, after the floor gate, and nothing can make it conditional or advisory", () => {
    const at = lines.indexOf(STEP);
    expect(at).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("fold-epoch") && !isComment(l))).toEqual([STEP]);
    expect(lines[at + 1]).toMatch(/^ {6}(- |#)/); // no key beneath it (`if:`, `continue-on-error:`, `env:`, `working-directory:`)
    expect(jobAt(at)).toBe("  gates:");
    expect(lines.indexOf(FLOOR_STEP)).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(lines.indexOf(FLOOR_STEP));
    const gatesAt = lines.indexOf("  gates:");
    const header = lines.slice(gatesAt + 1, lines.indexOf("    steps:", gatesAt));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header.filter((x) => !isComment(x))) expect(l, "a job-level softener or cwd shift").not.toMatch(/^ {4}(if|continue-on-error|defaults|working-directory):/);
    expect(lines.filter((l) => /^(defaults|working-directory):/.test(l)), "a workflow-level default would shift every job's cwd").toEqual([]);
    // a name filter that matches no package exits 0 in silence unless told not to
    expect(lines[at]).toContain(" --fail-if-no-match fold-epoch:check ");
  });

  it("compares against HEAD^1 and the job's checkout is the full-history one that makes HEAD^1 exist", () => {
    const at = lines.indexOf(STEP);
    expect(lines[at]).toMatch(/ --against HEAD\^1$/);
    const gatesAt = lines.indexOf("  gates:");
    const checkoutAt = lines.findIndex((l, i) => i > gatesAt && l.includes("uses: actions/checkout@"));
    expect(checkoutAt).toBeGreaterThan(gatesAt);
    expect(jobAt(checkoutAt)).toBe("  gates:");
    const nextStepAt = lines.findIndex((l, i) => i > checkoutAt && /^ {6}- /.test(l));
    expect(nextStepAt).toBeGreaterThan(checkoutAt);
    expect(lines.slice(checkoutAt, nextStepAt), "a shallow checkout has no HEAD^1: the guard would refuse every PR").toContain("          fetch-depth: 0");
    expect(checkoutAt).toBeLessThan(at);
  });

  it("the engine's package script runs the guard under strip-types, and the guard exists", () => {
    expect(engine.scripts["fold-epoch:check"]).toBe("node --experimental-strip-types scripts/fold-epoch-guard.ts");
    expect(existsSync(resolve(REPO, "packages/engine/scripts/fold-epoch-guard.ts"))).toBe(true);
  });

  it("the step's command as ci.yml spells it, run the way CI runs it, reaches the guard and passes on this tree", () => {
    const step = lines.find((l) => l.includes("fold-epoch:check") && !isComment(l));
    expect(step).toBeDefined();
    const cmd = (step ?? "").trim().replace(/^- run: /, "");
    expect(cmd).toContain(" --against HEAD^1");
    // HEAD^1 needs history and a merge commit; HEAD is always there, and this tree is HEAD unless a golden is edited and not committed.
    const r = spawnSync("bash", ["-c", cmd.replace(" --against HEAD^1", " --against HEAD")], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    // only a guard that read the flag, through `pnpm --filter`, in the engine's directory, prints this; the sport count is the corpora on disk
    const corpora = (readdirSync(resolve(REPO, "packages/engine/src/sports"), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).length;
    expect(corpora).toBeGreaterThan(0);
    const m = /^fold-epoch: (\d+) sports checked, (\d+) streams compared against HEAD: 0 violation\(s\)$/m.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(Number(m?.[1])).toBe(corpora);
    expect(Number(m?.[2])).toBeGreaterThanOrEqual(corpora);
  }, spawnBudget(1));
});

// Engine-split Task 1b-3 (D14): the packed-tarball proof. The job is only worth having if it runs, and the ways it quietly stops
// running are all in this file's text: a step gated on a filter id that does not exist is skipped for ever (a skipped step is a
// green job), a pnpm other than the pin packs a different tarball, a shifted cwd breaks the script path.
describe("engine-pack CI wiring (engine-split Task 1b-3, D14)", () => {
  const jobs = jobsOf(ci);
  const job = jobs["engine-pack"] ?? "";
  const jobLines = job.split("\n");
  const isComment = (l: string) => /^\s*#/.test(l);
  const code = jobLines.filter((l) => !isComment(l));
  const RUN = "        run: node packages/engine/pack-proof/run.mjs";
  const root = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { packageManager: string };
  const pin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(root.packageManager)?.[1];

  it("reads the jobs it asserts about (never an empty set), and the engine-pack job is one of them", () => {
    expect(Object.keys(jobs).length).toBeGreaterThan(3);
    expect(Object.keys(jobs)).toContain("engine");
    expect(job.length).toBeGreaterThan(0);
    expect(pin).toBeDefined();
  });

  it("runs the proof exactly once, as the command the engine's package script also runs, with nothing that could make it advisory", () => {
    expect(code.filter((l) => l.includes("pack-proof/run.mjs"))).toEqual([RUN]);
    const at = jobLines.indexOf(RUN);
    expect(at).toBeGreaterThan(0);
    // the step's own keys: a name and an `if`, nothing else (no continue-on-error, no env/working-directory that would move or soften it)
    const stepStart = jobLines.lastIndexOf("      - name: Pack the engine and consume the tarball (node, next, rn, types)", at);
    expect(stepStart).toBeGreaterThan(0);
    expect(jobLines.slice(stepStart + 1, at).filter((l) => !isComment(l))).toEqual(["        if: steps.engine-changes.outputs.engine == 'true'"]);
    expect(jobLines[at + 1] ?? "").not.toMatch(/^ {8}\S/);
    for (const l of code) expect(l, "a job-level softener or cwd shift").not.toMatch(/^ {4}(if|continue-on-error|defaults|working-directory):|^ {8}(continue-on-error|working-directory):/);
    const engine = JSON.parse(readFileSync(resolve(REPO, "packages/engine/package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(engine.scripts["pack:proof"]).toBe("node pack-proof/run.mjs");
    expect(existsSync(resolve(REPO, "packages/engine/pack-proof/run.mjs"))).toBe(true);
  });

  it("gates the step on a paths-filter step that exists, with the engine's two globs (a typo'd id skips the step for ever, and a skipped step is a green job)", () => {
    const filterId = /- uses: dorny\/paths-filter@v3\n\s+id: (\S+)/.exec(job)?.[1];
    expect(filterId).toBe("engine-changes");
    expect(job).toContain(`steps.${filterId}.outputs.engine == 'true'`);
    expect(job).toMatch(/engine:\n\s+- 'packages\/engine\/\*\*'\n\s+- 'pnpm-lock\.yaml'\n/);
    // paths-filter reads the PR's files through the API: it needs the pull-requests grant the `engine` job carries
    expect(job).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: read\n/);
  });

  it("installs with the pinned pnpm and Node 26 before it runs, frozen", () => {
    expect(job).toMatch(new RegExp(`pnpm/action-setup@v4\\n\\s+with:\\n\\s+version: ${(pin ?? "").replace(/\./g, "\\.")}\\n`));
    expect(job).toMatch(/actions\/setup-node@v5\n\s+with:\n\s+node-version: 26\n\s+cache: pnpm\n/);
    const install = jobLines.indexOf("      - run: pnpm install --frozen-lockfile");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(jobLines.indexOf(RUN));
    expect(job).toContain("runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}");
  });
});

