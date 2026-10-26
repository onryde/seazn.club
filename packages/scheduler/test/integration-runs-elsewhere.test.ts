// A live test that no workflow runs is a test that does not exist (engine-split 1a-4 Step 7, review R10).
//
// The scheduler owns two files that talk to a REAL placement service and SKIP without one (`RUN_INTEGRATION`, gated on
// `PLACEMENT_SERVICE_HOST`): placement-integration.test.ts and repair-decompose-cpsat-integration.test.ts. The two jobs that
// could run them pull in opposite directions, and the join between them is workflow TEXT:
//
//   * ci.yml's scheduler step (in `gates`) is the strict DB-free judge. It counts a skip as a failure, so it must EXCLUDE both
//     files, or it goes red for a reason that has nothing to do with the code.
//   * ci.yml's `scheduler-live` job stands up the real placement container (the PINNED image, as a service: engine-split phase
//     2a, Task W2) and is the only place those files can run. It must run BOTH, with a judge that fails on zero tests, on any
//     skip, and on any live file that did not report. They ran in the placement workflow's `integration` job until the
//     placement service moved to its own repo.
//
// Before this test, the live job ran one of the two (the other was run by no workflow at all) and pointed at a path that
// had stopped existing when the file moved, so the job would have "ran 0 files" and still read as an intentional skip. Both
// directions are asserted from the workflow text, over a live-file list DERIVED from the tree, never typed here.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "../..");
const workflow = (name: string) => readFileSync(join(REPO, ".github/workflows", name), "utf8");

/** Every `*.test.ts` under src/ and test/ (recursive). */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") testFiles(path, out);
    } else if (entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** The files that gate on a live service: the tree's own declaration, a top-level `RUN_INTEGRATION` read of the host variable.
 *  Anchored to the start of a line, so this file's own prose about that declaration is not itself a "live file". */
const live = [...testFiles(join(PACKAGE, "src")), ...testFiles(join(PACKAGE, "test"))]
  .filter((file) => /^const\s+RUN_INTEGRATION\s*=\s*process\.env\.PLACEMENT_SERVICE_HOST\b/m.test(readFileSync(file, "utf8")))
  .map((file) => relative(PACKAGE, file).split("\\").join("/"));

/** The text of one workflow step: from its `- name:` line to the next step, the comment block that heads it, or the first line
 *  indented less than a step (the end of the job: the last step of a job is followed by the next job's comment at 2 spaces, which
 *  the first two alternatives never see, so the slice would otherwise run on to the end of the file and into a `run:` body). */
function step(yml: string, name: string): string {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  expect(at, `no step named "${name}"`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^ {6}(- |#)|^ {0,5}\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end).join("\n");
}

/** The job a step lives in: the nearest job key (a 2-space-indented `name:` line) above its `- name:` line. */
function jobOf(yml: string, stepName: string): string {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(at, `no step named "${stepName}"`).toBeGreaterThan(-1);
  for (let i = at; i >= 0; i--) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]!);
    if (m) return m[1]!;
  }
  throw new Error(`no job above step "${stepName}"`);
}
/** The 0-based line a step starts on. */
const lineOf = (yml: string, stepName: string): number => yml.split("\n").findIndex((l) => l.trim() === `- name: ${stepName}`);

/** A step that carries its own `if:` or `continue-on-error:` at the step's key column can be skipped or can fail without failing
 *  the job. Same idea as apps/web's ci-server-instrumentation-wiring.test.ts (STEP_SILENCE). The `- if:` HEADER form (a step that
 *  starts with the key before its `name:`) is deliberately not matched here: such a step has no `- name:` line, so gateProblems()
 *  reports it as "not in job" before this pattern could see it (pinned by the header-line case in the self-test below).
 *  Anchored to the key column, so a `# if: false` comment line never matches either. */
const STEP_SILENCE = /^ {8}(?:if|continue-on-error):/;
/** A step key at the step's key column (the `- name:` header line carries `name`). */
const STEP_KEY = /^ {8}([A-Za-z][A-Za-z0-9_-]*):/;
/** The same two keys at a JOB's key column: `if:` skips the whole job, `continue-on-error:` makes its red non-blocking. */
const JOB_SILENCE = /^ {4}(?:if|continue-on-error):/;

/**
 * Ways a PR could go green with these gate steps skipped, ignored or aimed at the wrong place, for the classes this check
 * knows (it is a list of known holes, not a proof that none is left):
 *   * the job or a named step carries an `if:` or `continue-on-error:` (skipped, or a red that blocks nothing);
 *   * a named step has any key besides `name` and `run`: a `working-directory:` there doubles the pathspec the drift gate
 *     reads (git exits 0 on a path that does not exist, so the gate passes), and `env:`/`shell:` change what the script does;
 *   * the job, or the whole workflow, sets `defaults:` (the same `working-directory`, one level up).
 * A step that cannot be found in the job is a problem too (moved to another job, renamed, or given an `if:` header line before
 * its `name:`), and so is a missing job: a scan of nothing proves nothing. Empty means none of the above.
 */
function gateProblems(yml: string, jobId: string, stepNames: string[]): string[] {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^ {2}${jobId}:\\s*$`).test(l));
  if (at < 0) return [`there is no job "${jobId}"`];
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$|^\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const job = lines.slice(at + 1, end);
  const problems: string[] = [];
  if (lines.some((l) => /^defaults:/.test(l))) {
    problems.push("the workflow sets top-level `defaults:`: a working-directory or shell there moves every gate step");
  }
  if (job.some((l) => /^ {4}defaults:/.test(l))) {
    problems.push(`job "${jobId}" sets \`defaults:\`: a working-directory or shell there moves the gate steps`);
  }
  if (job.some((l) => JOB_SILENCE.test(l))) {
    problems.push(`job "${jobId}" carries an \`if:\` or \`continue-on-error:\`: it can be skipped, or its red blocks nothing`);
  }
  for (const name of stepNames) {
    const from = job.findIndex((l) => l.trim() === `- name: ${name}`);
    if (from < 0) {
      problems.push(`step "${name}" is not in job "${jobId}"`);
      continue;
    }
    let to = job.length;
    for (let i = from + 1; i < job.length; i++) {
      if (/^ {6}(- |#)/.test(job[i]!)) {
        to = i;
        break;
      }
    }
    const block = job.slice(from, to);
    if (block.some((l) => STEP_SILENCE.test(l))) {
      problems.push(`step "${name}" carries an \`if:\` or \`continue-on-error:\`: it can be skipped or ignored`);
    }
    const keys = ["name", ...block.map((l) => STEP_KEY.exec(l)?.[1]).filter((k): k is string => k !== undefined)];
    if (keys.join(",") !== "name,run") {
      problems.push(`step "${name}" has keys [${keys.join(", ")}], not exactly [name, run]: any other key can move or change what the gate checks`);
    }
  }
  return problems;
}

// ---- The judge, EXECUTED. A text match proves a clause is written down, not that it judges: this runs the workflow's own
// "Assert the suite RAN, and passed" script against synthetic vitest reports and reads its exit code. The script's report path
// is swapped for a temp file and `docker` is a shim on PATH that records its argv (the script only calls it to print logs on
// the way out). `PLACEMENT_CONTAINER` is what the workflow's step-level `env:` supplies from `job.services.placement.id`.
const SHIM_DIR = mkdtempSync(join(tmpdir(), "placement-judge-"));
const DOCKER_LOG = join(SHIM_DIR, "docker.log");
const CONTAINER = "0123456789abcdef-service-container-id";
writeFileSync(join(SHIM_DIR, "docker"), '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\nexit 0\n');
chmodSync(join(SHIM_DIR, "docker"), 0o755);
afterAll(() => rmSync(SHIM_DIR, { recursive: true, force: true }));

const REPORT_PATH = "/tmp/placement-integration.json";
/** The script body of a step, de-indented (the `run: |` block of the 10-space-indented workflow step). */
function runBody(stepText: string): string {
  const lines = stepText.split("\n");
  const at = lines.findIndex((l) => l.trim() === "run: |");
  expect(at, "the step has a `run: |` block").toBeGreaterThan(-1);
  return lines
    .slice(at + 1)
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
}

interface FileReport {
  file: string;
  status?: "passed" | "failed";
  assertions?: number;
}
interface Overrides {
  numFailedTestSuites?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTotalTests?: number;
  numPassedTests?: number;
}
/** A vitest JSON report of one passing test per assertion, with the totals summed from the files unless overridden. */
function report(files: FileReport[], over: Overrides = {}): string {
  const testResults = files.map(({ file, status = "passed", assertions = 2 }) => ({
    name: `/runner/work/packages/scheduler/${file}`,
    status,
    assertionResults: Array.from({ length: assertions }, (_, i) => ({ title: `t${i}`, status: "passed" })),
  }));
  const total = testResults.reduce((n, r) => n + r.assertionResults.length, 0);
  return JSON.stringify({
    numTotalTests: total,
    numPassedTests: total,
    numFailedTests: 0,
    numPendingTests: 0,
    numFailedTestSuites: 0,
    ...over,
    testResults,
  });
}
const BOTH = (): FileReport[] => live.map((file) => ({ file }));

/** Run the workflow's judge over a synthetic report: its exit code, the error annotations it printed, and the docker calls it made. */
function judge(json: string): { code: number | null; errors: string; docker: string[] } {
  const body = runBody(step(workflow("ci.yml"), "Assert the suite RAN, and passed"));
  expect(body, "the script reads the report from the path this test swaps").toContain(REPORT_PATH);
  const reportFile = join(SHIM_DIR, "report.json");
  writeFileSync(reportFile, json);
  writeFileSync(DOCKER_LOG, "");
  const r = spawnSync("bash", ["-c", body.split(REPORT_PATH).join(reportFile)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`, PLACEMENT_CONTAINER: CONTAINER, DOCKER_LOG },
  });
  expect(r.error, "bash/jq must be runnable: a judge that cannot run proves nothing").toBeUndefined();
  return {
    code: r.status,
    errors: (r.stdout + r.stderr).split("\n").filter((l) => l.startsWith("::error::")).join("\n"),
    docker: readFileSync(DOCKER_LOG, "utf8").split("\n").filter(Boolean),
  };
}

describe("the scheduler's live tests run in ci.yml's scheduler-live job, against the pinned image, and are excluded from ci.yml's strict step", () => {
  it("finds the two live files (anti-vacuity: a scan that finds nothing proves nothing)", () => {
    expect(live.length, "live files found").toBeGreaterThanOrEqual(2);
    expect(live).toContain("src/__tests__/placement-integration.test.ts");
    expect(live).toContain("src/__tests__/repair-decompose-cpsat-integration.test.ts");
  });

  it("each live-job step name occurs once in ci.yml, inside the scheduler-live job (the slicer finds the FIRST one)", () => {
    const yml = workflow("ci.yml");
    for (const name of ["Run the integration suite against the live service", "Assert the suite RAN, and passed"]) {
      const occurrences = yml.split("\n").filter((l) => l.trim() === `- name: ${name}`).length;
      expect(occurrences, `"${name}" occurrences in ci.yml`).toBe(1);
      expect(jobOf(yml, name), `"${name}" must live in the scheduler-live job`).toBe("scheduler-live");
    }
  });

  it("ci.yml's scheduler-live job runs every live file with the scheduler's own vitest", () => {
    const yml = workflow("ci.yml");
    const run = step(yml, "Run the integration suite against the live service");
    expect(run, "the suite runs from the scheduler package").toMatch(/working-directory:\s*packages\/scheduler\b/);
    expect(run, "and not from the engine").not.toContain("packages/engine");
    expect(run).toContain("PLACEMENT_SERVICE_HOST: localhost:50051");
    for (const file of live) expect(run, `${file} is not run by the integration step`).toContain(file);
  });

  it("ci.yml's judge fails on zero tests, on any skip, and on any live file that did not report", () => {
    const judge = step(workflow("ci.yml"), "Assert the suite RAN, and passed");
    expect(judge, "a zero-total refusal").toMatch(/"\$total" -eq 0/);
    expect(judge, "a skipped test is a failure").toMatch(/"\$skipped" -ne 0/);
    for (const file of live) {
      expect(judge, `the judge never checks that ${file} reported`).toContain(file.split("/").pop()!);
    }
  });

  it("the executed judge: anti-vacuity — jq is present and the good report is accepted", () => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    expect(jq.status, "jq must be installed: every judge case below would otherwise fail for the wrong reason").toBe(0);
    expect(live.length, "live files the good report covers").toBeGreaterThanOrEqual(2);
    const good = judge(report(BOTH()));
    expect(good, good.errors).toEqual({ code: 0, errors: "", docker: [] });
  });

  // One spawn per case: nothing here needs a timeout above the default. The zero-tests branch prints no logs (it refuses before
  // reading any), so it is not in this table.
  const LOG_READING_REFUSALS: [label: string, json: () => string][] = [
    ["a skip", () => report(BOTH(), { numPendingTests: 1 })],
    ["a failed test", () => report(BOTH(), { numFailedTests: 1, numPassedTests: 3 })],
    ["a failed suite", () => report(BOTH(), { numFailedTestSuites: 1 })],
    ["a live file that did not report", () => report([{ file: live[0]! }])],
    ["a live file that passed with no assertions", () => report([{ file: live[0]! }, { file: live[1]!, assertions: 0 }])],
  ];
  it.each(LOG_READING_REFUSALS)("the executed judge reads the SERVICE container's logs, by the id the workflow supplies, when it refuses %s", (label, json) => {
    const out = judge(json());
    expect(out.code, `${label}: ${out.errors}`).toBe(1);
    expect(out.docker).toEqual([`logs ${CONTAINER}`]);
  });

  it("the executed judge reads no logs on a passing run (and the table above is not empty)", () => {
    expect(LOG_READING_REFUSALS.length, "refusal paths exercised").toBe(5);
    expect(judge(report(BOTH())).docker).toEqual([]);
  });

  // Each case below is red through exactly ONE clause of the judge, so deleting any one clause turns exactly its case
  // green-when-it-should-be-red. Two clauses covering for each other would each be untested.
  const REFUSED: [label: string, json: () => string, why: RegExp][] = [
    [
      "a live file that failed to COLLECT (the review's MAJOR-1: vitest exits 1, totals come only from the other file)",
      () => report([{ file: live[0]! }, { file: live[1]!, status: "failed", assertions: 0 }], { numFailedTestSuites: 1 }),
      /./,
    ],
    [
      "a failed suite alone: both live files passed with assertions, but the run counts one failed suite elsewhere",
      () => report(BOTH(), { numFailedTestSuites: 1 }),
      /suite/i,
    ],
    [
      "a live file whose status is not passed, though it reports tests and the run counts no failed suite",
      () => report([{ file: live[0]! }, { file: live[1]!, status: "failed" }]),
      /passed/i,
    ],
    [
      "a live file that is `passed` with no assertions at all, with the run's totals all green",
      () => report([{ file: live[0]! }, { file: live[1]!, assertions: 0 }]),
      /passed/i,
    ],
    ["a live file missing from the run (the filename filter matched nothing)", () => report([{ file: live[0]! }]), /did not report|passed/i],
    ["a skipped test (the service was not reached)", () => report(BOTH(), { numPendingTests: 1 }), /SKIPPED/],
    ["zero tests collected", () => report([], {}), /0 tests/],
    ["a failed test", () => report(BOTH(), { numFailedTests: 1, numPassedTests: 3 }), /failed/],
  ];
  it.each(REFUSED)("the executed judge refuses %s", (_label, json, why) => {
    const out = judge(json());
    expect(out.code, `the judge accepted it; errors: ${out.errors}`).toBe(1);
    expect(out.errors).toMatch(why);
  });

  it("ci.yml's scheduler step excludes every live file, and still runs the rest of the package", () => {
    const run = step(workflow("ci.yml"), "Scheduler package tests (DB-free)");
    expect(run).toContain("packages/scheduler");
    for (const file of live) {
      expect(run, `${file} is not excluded from the strict step`).toContain(`--exclude packages/scheduler/${file}`);
    }
    // The strict judge, copied from the reference step: zero tests, a failed suite and any skip or todo are all red.
    expect(run).toContain("numTotalTests > 0");
    expect(run).toContain("numFailedTestSuites");
    expect(run).toContain("numPassedTests !== r.numTotalTests");
  });
});

// ---- The proto's home moved (engine-split phase 2a, Task W1): `packages/scheduler/proto/scheduler.proto` is a vendored copy of
// the placement repo's file, and ci.yml's `gates` job is the PR-time proof that the committed TypeScript stubs still come from
// it. Both steps are pinned from the workflow text; the drift step's own script is also EXECUTED, because a text match proves a
// clause is written down, not that it fails a PR.
describe("ci.yml regenerates the TypeScript stubs from the vendored proto and diffs them", () => {
  const REGENERATE = "Regenerate TypeScript proto stubs";
  const DRIFT = "TypeScript stub drift gate";
  const SCHEDULER_STEP = "Scheduler package tests (DB-free)";

  it("each step exists exactly once, in the gates job, after the scheduler package tests and in that order", () => {
    const yml = workflow("ci.yml");
    for (const name of [REGENERATE, DRIFT]) {
      const occurrences = yml.split("\n").filter((l) => l.trim() === `- name: ${name}`).length;
      expect(occurrences, `"${name}" occurrences in ci.yml`).toBe(1);
      expect(jobOf(yml, name), `"${name}" must live in the gates job`).toBe("gates");
    }
    expect(jobOf(yml, SCHEDULER_STEP)).toBe("gates");
    expect(lineOf(yml, REGENERATE), "regenerate follows the scheduler step").toBeGreaterThan(lineOf(yml, SCHEDULER_STEP));
    expect(lineOf(yml, DRIFT), "the drift gate follows the regeneration it judges").toBeGreaterThan(lineOf(yml, REGENERATE));
  });

  it("regenerates from the scheduler workspace, and the drift step diffs the scheduler's generated tree", () => {
    const yml = workflow("ci.yml");
    // Each step on its own: the drift gate's error message also names the command, so a joined text would let a stale
    // regenerate step ride on the message of the next one.
    const regenerate = step(yml, REGENERATE);
    expect(regenerate).toMatch(/run:\s*pnpm --filter @seazn\/scheduler gen:proto\s*$/);
    const drift = step(yml, DRIFT);
    expect(drift).toContain("git status --porcelain -- packages/scheduler/src/generated/");
    expect(drift, "the message sends a developer to the vendored file and the vendoring command").toContain("packages/scheduler/proto/scheduler.proto");
    expect(drift).toContain("vendor:proto");
    expect(drift).toContain("pnpm --filter @seazn/scheduler gen:proto");
    expect(regenerate + drift, "no stale pointer to the retired monorepo proto or engine codegen").not.toMatch(
      /(?<![\w/.-])proto\/scheduler\.proto|packages\/engine\/(src\/scheduling\/generated|scripts)/,
    );
  });

  it("ci.yml's `on:` has no path or branch filter, so the gate runs on every pull request", () => {
    const lines = workflow("ci.yml").split("\n");
    const onAt = lines.findIndex((l) => /^on:\s*$/.test(l));
    expect(onAt, "ci.yml has a top-level `on:`").toBeGreaterThan(-1);
    const rest = lines.slice(onAt + 1);
    const nextTop = rest.findIndex((l) => /^[A-Za-z]/.test(l));
    const onBlock = rest.slice(0, nextTop).join("\n");
    expect(onBlock, "the trigger is non-empty (a scan of nothing proves nothing)").toContain("pull_request:");
    expect(onBlock).not.toMatch(/\bpaths(-ignore)?:/);
    expect(onBlock).not.toMatch(/\bbranches(-ignore)?:/);
  });

  it("the two new steps are exactly `name` + `run`, and neither they nor the gates job can be skipped, made non-blocking or moved (`if:`, `continue-on-error:`, `working-directory:`, `defaults:`)", () => {
    // `if: false` on the regenerate step is the fail-open one: with nothing regenerated the tree is always clean.
    expect(gateProblems(workflow("ci.yml"), "gates", [REGENERATE, DRIFT])).toEqual([]);
  });

  describe("gateProblems(): the check itself refuses each known way to mute or move the gate (negative self-test)", () => {
    const REAL = workflow("ci.yml");
    const after = (anchor: string, insert: string): string => {
      expect(REAL.split(anchor).length - 1, `anchor occurs once: ${anchor.trim()}`).toBe(1);
      return REAL.replace(anchor, `${anchor}${insert}`);
    };
    const REGEN_HEAD = `      - name: ${REGENERATE}\n`;
    const DRIFT_HEAD = `      - name: ${DRIFT}\n`;
    const GATES_HEAD = "    name: Typecheck + lint + drift gates\n";
    const MUTED: [label: string, yml: () => string, why: RegExp][] = [
      ["continue-on-error on the drift step", () => after(DRIFT_HEAD, "        continue-on-error: true\n"), /step "TypeScript stub drift gate" carries/],
      ["if: false on the drift step", () => after(DRIFT_HEAD, "        if: false\n"), /step "TypeScript stub drift gate" carries/],
      ["if: false on the regenerate step (fail-open)", () => after(REGEN_HEAD, "        if: false\n"), /step "Regenerate TypeScript proto stubs" carries/],
      ["continue-on-error on the regenerate step", () => after(REGEN_HEAD, "        continue-on-error: true\n"), /step "Regenerate TypeScript proto stubs" carries/],
      ["an `if:` on the step's header line, before its name", () => REAL.replace(REGEN_HEAD, `      - if: false\n        name: ${REGENERATE}\n`), /step "Regenerate TypeScript proto stubs" is not in job/],
      [
        "working-directory on the drift step (the pathspec doubles, git exits 0 on nothing)",
        () => after(DRIFT_HEAD, "        working-directory: packages/scheduler\n"),
        /step "TypeScript stub drift gate" has keys \[name, working-directory, run\]/,
      ],
      [
        "working-directory on the regenerate step",
        () => after(REGEN_HEAD, "        working-directory: apps/web\n"),
        /step "Regenerate TypeScript proto stubs" has keys \[name, working-directory, run\]/,
      ],
      [
        "working-directory written AFTER the drift step's run (key order must not hide it)",
        () => {
          const end = "      # The engine rules reference (W2a ruling 75";
          expect(REAL.split(end).length - 1, "anchor occurs once").toBe(1);
          return REAL.replace(end, `        working-directory: packages/scheduler\n\n${end}`);
        },
        /step "TypeScript stub drift gate" has keys \[name, run, working-directory\]/,
      ],
      [
        "working-directory written AFTER the regenerate step's run",
        () => REAL.replace("        run: pnpm --filter @seazn/scheduler gen:proto\n", "        run: pnpm --filter @seazn/scheduler gen:proto\n        working-directory: apps/web\n"),
        /step "Regenerate TypeScript proto stubs" has keys \[name, run, working-directory\]/,
      ],
      ["env on the drift step", () => after(DRIFT_HEAD, "        env:\n          GIT_DIR: /nowhere\n"), /step "TypeScript stub drift gate" has keys \[name, env, run\]/],
      ["shell on the drift step", () => after(DRIFT_HEAD, "        shell: bash {0} || true\n"), /step "TypeScript stub drift gate" has keys \[name, shell, run\]/],
      ["defaults.run.working-directory on the gates job", () => after(GATES_HEAD, "    defaults:\n      run:\n        working-directory: packages/scheduler\n"), /job "gates" sets `defaults:`/],
      [
        "defaults.run.working-directory on the whole workflow",
        () => {
          const moved = REAL.replace(/\njobs:\n/, "\ndefaults:\n  run:\n    working-directory: packages/scheduler\n\njobs:\n");
          expect(moved, "the fixture really added the key").not.toBe(REAL);
          return moved;
        },
        /top-level `defaults:`/,
      ],
      ["continue-on-error on the gates job", () => after(GATES_HEAD, "    continue-on-error: true\n"), /job "gates" carries/],
      ["if: on the gates job", () => after(GATES_HEAD, "    if: github.event_name == 'push'\n"), /job "gates" carries/],
      [
        "continue-on-error on the gates job, written AFTER its steps",
        () => {
          const muted = REAL.replace(/\n( {2}test:\n)/, "\n    continue-on-error: true\n$1");
          expect(muted, "the fixture really added the key").not.toBe(REAL);
          return muted;
        },
        /job "gates" carries/,
      ],
      [
        "a step moved out of the gates job",
        () => {
          const a = REAL.indexOf(REGEN_HEAD);
          const e = REAL.indexOf("      # The engine rules reference (W2a ruling 75");
          return `${REAL.slice(0, a)}${REAL.slice(e)}`.trimEnd() + `\n\n${REAL.slice(a, e)}`;
        },
        /step "Regenerate TypeScript proto stubs" is not in job "gates"/,
      ],
    ];
    it.each(MUTED)("refuses %s", (_label, yml, why) => {
      const problems = gateProblems(yml(), "gates", [REGENERATE, DRIFT]);
      expect(problems.join("\n")).toMatch(why);
    });

    it("anti-vacuity: it checked both steps and the job, and the unmutated file is clean", () => {
      expect(MUTED.length, "mutations exercised").toBeGreaterThanOrEqual(16);
      expect(gateProblems(REAL, "gates", [REGENERATE, DRIFT])).toEqual([]);
      expect(gateProblems(REAL, "no-such-job", [REGENERATE]).join(), "a missing job is a problem, not a pass").toMatch(/no job/);
      expect(gateProblems(REAL, "gates", ["No Such Step"]).join(), "a missing step is a problem, not a pass").toMatch(/not in job/);
    });

    it("does not flag what silences nothing: a comment, another job's key, a run-body line", () => {
      expect(gateProblems(after(DRIFT_HEAD, "        # if: false\n        # continue-on-error: true\n"), "gates", [REGENERATE, DRIFT])).toEqual([]);
      expect(gateProblems(after(GATES_HEAD, "    # continue-on-error: true\n"), "gates", [REGENERATE, DRIFT])).toEqual([]);
      const other = REAL.replace(/(\n {2}test:\n {4}name: [^\n]*\n)/, "$1    continue-on-error: true\n");
      expect(other, "the fixture really muted the test job").not.toBe(REAL);
      expect(gateProblems(other, "gates", [REGENERATE, DRIFT]), "a different job's continue-on-error is not the gates job's").toEqual([]);
      expect(gateProblems(other, "test", []).join(), "and it IS flagged on its own job").toMatch(/job "test" carries/);
      // A NEIGHBOURING step in the same job is not one of ours: its own `if:` stays its own.
      for (const neighbour of ["Scheduler package tests (DB-free)", "Engine rules reference checker (DB-free)"]) {
        const head = `      - name: ${neighbour}\n`;
        const sibling = after(head, "        if: false\n        continue-on-error: true\n        working-directory: elsewhere\n");
        expect(sibling, "the fixture really muted the neighbour").not.toBe(REAL);
        expect(gateProblems(sibling, "gates", [REGENERATE, DRIFT]), `${neighbour} is not one of the gate's steps`).toEqual([]);
      }
    });
  });

  // ---- The drift step's script, EXECUTED in a temp repo that has the generated tree committed. `bash -e`, as GitHub runs it.
  const DRIFT_DIR = mkdtempSync(join(tmpdir(), "stub-drift-"));
  afterAll(() => rmSync(DRIFT_DIR, { recursive: true, force: true }));
  const GENERATED = "packages/scheduler/src/generated";
  let n = 0;
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  /** A committed tree with the generated stub and an unrelated file, then `mutate` applied to the working tree. */
  function runDrift(mutate: (repo: string) => void): { code: number | null; errors: string; out: string } {
    const repo = join(DRIFT_DIR, `repo-${String(++n)}`);
    mkdirSync(join(repo, GENERATED), { recursive: true });
    gitIn(repo, "init", "-q");
    writeFileSync(join(repo, GENERATED, "scheduler.ts"), "export const generated = 1;\n");
    writeFileSync(join(repo, "other.txt"), "x\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", "init");
    mutate(repo);
    const body = runBody(step(workflow("ci.yml"), DRIFT));
    const r = spawnSync("bash", ["-e", "-c", body], { cwd: repo, encoding: "utf8" });
    expect(r.error, "bash must be runnable: a gate that cannot run proves nothing").toBeUndefined();
    const out = r.stdout + r.stderr;
    return { code: r.status, out, errors: out.split("\n").filter((l) => l.startsWith("::error::")).join("\n") };
  }

  it("the executed drift gate: a regenerated tree identical to the committed one passes", () => {
    const ok = runDrift(() => undefined);
    expect(ok, ok.out).toEqual(expect.objectContaining({ code: 0, errors: "" }));
  });

  it("the executed drift gate: an edited stub is red, with an ::error:: naming the proto and the vendoring command", () => {
    const red = runDrift((repo) => writeFileSync(join(repo, GENERATED, "scheduler.ts"), "export const generated = 2;\n"));
    expect(red.code, red.out).toBe(1);
    expect(red.errors).toContain("packages/scheduler/proto/scheduler.proto");
    expect(red.errors).toContain("vendor:proto");
    expect(red.out, "the diff is printed so the PR log shows what drifted").toContain("-export const generated = 1;");
  });

  it("the executed drift gate: a stub that was never committed (untracked) is red too", () => {
    const red = runDrift((repo) => writeFileSync(join(repo, GENERATED, "extra.ts"), "export {};\n"));
    expect(red.code, red.out).toBe(1);
    expect(red.errors).not.toBe("");
  });

  it("the executed drift gate: a change OUTSIDE the generated tree is not its business", () => {
    const ok = runDrift((repo) => writeFileSync(join(repo, "other.txt"), "changed\n"));
    expect(ok, ok.out).toEqual(expect.objectContaining({ code: 0, errors: "" }));
  });
});
