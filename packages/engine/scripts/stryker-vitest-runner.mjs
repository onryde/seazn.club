// The test runner the engine's Stryker runs use (stryker.config.mjs `testRunner`): @stryker-mutator/vitest-runner 10.0.0, unchanged,
// behind a decorator that changes one verdict. A test FILE that fails AS A WHOLE in a mutant run is a DETECTION, so the mutant is
// Killed. "As a whole" means vitest recorded an error on the file itself or on a suite nested in it, never on a test: the file
// threw while it loaded, a beforeAll/afterAll hook threw (at the top level or in a nested describe), or a describe ended up with
// no test in it ("No test found in suite", the shape a mutant that empties a sweep's list has).
//
// Why the runner alone gets it wrong (read from its source, dist/src/vitest-test-runner.js `run()`, and @vitest/runner 4.1.11's
// `collectTests`): the runner builds a mutant's verdict from the TESTS in vitest's state (`collectTestsFromSuite` over
// `ctx.state.getFiles()`, keeping only tests that have a result). A file that throws while it loads has none: vitest's catch puts
// the error on the FILE (`file.result = { state: "fail", errors }`) and the file's tasks are never pushed. No test failed, the
// file's error is not in `ctx.state.errorsSet` either, so the runner returns the other files' passing tests and Stryker reports
// the mutant SURVIVED. A static mutant that breaks something a test file calls at load is the case: testkit/conformance-pad.ts
// calls `padSpec(cfg)` at module level for cricket.test.ts, so a mutant that makes `padSpec({dls})` throw fails that whole file
// to load and was reported Survived (run 37957068135, cricket.ts:3417), while cricket.test.ts's own DLS-panel test kills it.
//
// Why Killed, and not what Stryker itself would make of it. Had the vitest runner reported such a failure as an error outside a
// test, Stryker would map the mutant to RuntimeError, which stryker-floor.ts leaves out of the denominator: the mutant would count
// neither for nor against the score. But a test file that fails to load, or a suite whose hook throws, is a RED vitest run: `vitest
// run` exits non-zero and CI fails on it. The suite caught the mutant, so it is a detection and counts as one. The same holds for a
// hit-limit throw while a file loads (Stryker's instrumentation throws once a mutant's code runs past the hit limit, an endless
// loop at module level): the file fails to load, the runner never reads that file's hit count, and the mutant reads Killed here
// rather than Timeout. Both are detections, so the score is the same either way.
//
// The dry run is the other half, and it is a GUARD: a file that fails as a whole in the DRY run fails the run (status error).
// The plain runner silently drops such a file from the baseline, and with the change above every mutant run would then see the
// same failure and report it as a kill.
//
// A kill is attributed to a test the dry run really ran: the first test of the failed file, from a map the dry run writes into
// the sandbox (every runner child shares the sandbox as its cwd, as the vitest runner's own stryker-setup-<n>.js does). Stryker's
// incremental mode reuses a Killed result only while its killing test still exists, so a made-up id would re-run the mutant
// every week. Without the map (no dry run in this sandbox) the id names the file: `<file>#(the test file failed as a whole)`.
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import { strykerPlugins as vitestPlugins } from "@stryker-mutator/vitest-runner";

/** The `testRunner` name stryker.config.mjs selects. */
export const RUNNER_NAME = "vitest-file-failure-kills";
/** The dry run's map, in the sandbox: absolute test-file path → the id of the first test the dry run ran in it. */
export const DRY_RUN_TESTS_FILE = "stryker-dry-run-tests.json";
/** The first line of the reason a kill this decorator made carries (a report reader can tell it from a test's own failure). */
export const FILE_FAILED_REASON = "a test file, or a suite or hook in it, failed as a whole (the file threw while it loaded, a beforeAll/afterAll hook threw, or a suite was left with no test):";
/** The test name a kill carries when no dry-run map is there to name a real test. */
export const FILE_FAILED_TEST_NAME = "(the test file failed as a whole)";

/** The first error of its OWN that `task` or a suite nested in it carries (depth first, in the file's order), with the names of
 *  the suites down to it; undefined when none does. A TEST's own error is never one: that failure is already the runner's own
 *  kill. Nor is a suite whose state is "fail" only because a test in it failed: @vitest/runner's runSuite sets that state, never
 *  `errors`. @param {VitestTaskLike} task @param {string[]} [names] @returns {{ names: string[]; error: { message?: string } } | undefined} */
function ownFailure(task, names = []) {
  if (task.result?.state === "fail" && (task.result.errors?.length ?? 0) > 0) return { names, error: task.result.errors[0] };
  for (const child of task.tasks ?? []) {
    if (child.type !== "suite") continue;
    const found = ownFailure(child, [...names, child.name ?? "(unnamed suite)"]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The files in vitest's state that failed as a whole: the file itself, or a suite nested in it, carries an error of its own.
 *  @param {readonly VitestFileLike[]} files @returns {VitestFileLike[]} */
export function filesFailedAsAWhole(files) {
  return files.filter((f) => ownFailure(f) !== undefined);
}

/** One line per failed file: its path relative to `cwd`, the suites down to the failure (`a.test.js > outer > inner`), and that
 *  error's message. @param {readonly VitestFileLike[]} failed @param {string} cwd */
export function describeFailures(failed, cwd) {
  return failed.map((f) => {
    const found = ownFailure(f);
    return `${[relative(cwd, f.filepath), ...(found?.names ?? [])].join(" > ")}: ${found?.error.message ?? "(no message)"}`;
  }).join("\n");
}

/** The vitest runner's state, refused by name if its shape moved (the decorator reads the runner's `ctx`, which is not API).
 *  @param {{ ctx?: { state?: { getFiles?: () => VitestFileLike[] } } }} inner @returns {VitestFileLike[]} */
function stateFiles(inner) {
  const files = inner.ctx?.state?.getFiles?.();
  if (!Array.isArray(files)) {
    throw new Error(`${RUNNER_NAME}: the vitest runner no longer exposes ctx.state.getFiles(); re-read @stryker-mutator/vitest-runner before upgrading it`);
  }
  return files;
}

export class FileFailureKills {
  /** @param {any} inner the vitest runner's own instance @param {string} [cwd] the sandbox (the runner child's cwd) */
  constructor(inner, cwd = process.cwd()) {
    this.inner = inner;
    this.cwd = cwd;
  }

  capabilities() { return this.inner.capabilities(); }
  init() { return this.inner.init(); }
  dispose() { return this.inner.dispose(); }

  /** @param {any} options */
  async dryRun(options) {
    const result = await this.inner.dryRun(options);
    if (result.status !== "complete") return result;
    const failed = filesFailedAsAWhole(stateFiles(this.inner));
    if (failed.length > 0) {
      return { status: "error", errorMessage: `${RUNNER_NAME}: test file(s) failed as a whole in the dry run, so every mutant would read as killed by them:\n${describeFailures(failed, this.cwd)}` };
    }
    /** @type {Record<string, string>} */ const first = {};
    for (const t of result.tests) {
      if (t.fileName === undefined) continue;
      const file = resolve(t.fileName);
      if (!(file in first)) first[file] = t.id;
    }
    writeFileSync(resolve(this.cwd, DRY_RUN_TESTS_FILE), JSON.stringify(first));
    return result;
  }

  /** @param {any} options */
  async mutantRun(options) {
    const result = await this.inner.mutantRun(options);
    if (result.status !== "survived") return result;
    const failed = filesFailedAsAWhole(stateFiles(this.inner));
    if (failed.length === 0) return result;
    const first = this.dryRunTests();
    return {
      status: "killed",
      failureMessage: `${FILE_FAILED_REASON}\n${describeFailures(failed, this.cwd)}`,
      // keyed by the RESOLVED path, as the map is: the vitest runner's own test results carry `path.resolve(file.filepath)`
      killedBy: failed.map((f) => first[resolve(f.filepath)] ?? `${relative(this.cwd, f.filepath)}#${FILE_FAILED_TEST_NAME}`),
      nrOfTests: result.nrOfTests,
    };
  }

  /** The dry run's map; none (no dry run in this sandbox) is an empty map. Any other read failure throws.
   *  @returns {Record<string, string>} */
  dryRunTests() {
    let text;
    try {
      text = readFileSync(resolve(this.cwd, DRY_RUN_TESTS_FILE), "utf8");
    } catch (e) {
      if (/** @type {{ code?: string }} */ (e).code === "ENOENT") return {};
      throw e;
    }
    return JSON.parse(text);
  }
}

/** The vitest runner's own plugin among `plugins`, refused by name when it is not there (a renamed or re-shaped
 *  @stryker-mutator/vitest-runner). @param {readonly { kind: string; name: string }[]} plugins */
export function vitestRunnerOf(plugins) {
  const found = plugins.find((p) => p.kind === "TestRunner" && p.name === "vitest");
  if (found === undefined) throw new Error(`${RUNNER_NAME}: @stryker-mutator/vitest-runner declares no "vitest" test runner`);
  return found;
}

const vitest = vitestRunnerOf(vitestPlugins);

/** The factory Stryker calls with its injector, exactly as it calls the vitest runner's own. @param {unknown} injector */
function createRunner(injector) {
  return new FileFailureKills(vitest.factory(injector));
}
createRunner.inject = vitest.factory.inject;

/** Stryker's plugin export. The vitest runner stays in stryker.config.mjs's `plugins` too, for its options schema. */
export const strykerPlugins = [{ kind: "TestRunner", name: RUNNER_NAME, factory: createRunner }];

/** @typedef {{ type?: string; name?: string; result?: { state?: string; errors?: { message?: string }[] }; tasks?: VitestTaskLike[] }} VitestTaskLike */
/** @typedef {VitestTaskLike & { filepath: string }} VitestFileLike */
